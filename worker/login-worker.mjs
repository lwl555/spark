// 抖音扫码登录 Worker：在 GitHub Actions 上跑真浏览器完成登录
// 1) 认领 login_requests 里最早的一条 pending（或直接处理 TARGET_USER_ID）
// 2) 有头 Chromium 打开 douyin.com，取二维码 dataURI 写入 login_states
// 3) 轮询浏览器 cookie，出现 sessionid 即登录成功 → 完整 cookies 写回
// 4) 抖音要求短信二次验证时 → 状态改为 verify_sms，前端让用户输验证码 → 自动填入完成登录
// 5) 超时未扫码 → 标记 expired/failed
import { chromium } from "playwright";
import fs from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const TARGET_USER_ID = (process.env.TARGET_USER_ID || "").trim();

const QR_WAIT_MS = Number(process.env.QR_WAIT_MS) || 35000; // 等二维码弹出
const SCAN_WAIT_MS = Number(process.env.SCAN_WAIT_MS) || 480000; // 等用户扫码确认（二维码会自动刷新续期）
const POLL_MS = 2500;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("缺少 SUPABASE_URL / SUPABASE_SERVICE_KEY 环境变量");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function rest(method, path, body) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) throw new Error(`DB ${method} ${path.slice(0, 70)} -> ${res.status}: ${String(data).slice(0, 200)}`);
  return data;
}

const nowIso = () => new Date().toISOString();

// ---------- 1. 认领任务 ----------
async function claimRequest() {
  let userId = TARGET_USER_ID;
  let reqId = null;
  if (!userId) {
    const reqs = await rest("GET", "login_requests?status=eq.pending&order=created_at.asc&limit=1&select=id,user_id");
    if (!reqs?.length) { log("没有排队中的登录请求，直接退出"); process.exit(0); }
    userId = reqs[0].user_id;
    reqId = reqs[0].id;
  } else {
    const mine = await rest("GET", `login_requests?user_id=eq.${userId}&status=eq.pending&order=created_at.asc&limit=1&select=id`);
    if (mine?.length) reqId = mine[0].id;
    else {
      const created = await rest("POST", "login_requests", { user_id: userId, status: "processing", claimed_at: nowIso() });
      reqId = created?.[0]?.id;
    }
  }
  if (reqId) {
    await rest("PATCH", `login_requests?id=eq.${reqId}`, { status: "processing", claimed_at: nowIso(), updated_at: nowIso() });
  }
  log("认领任务 user_id=", userId, "reqId=", reqId);
  return { userId, reqId };
}

async function failRequest(reqId, error) {
  try {
    if (reqId) await rest("PATCH", `login_requests?id=eq.${reqId}`, { status: "failed", error, updated_at: nowIso() });
  } catch (e) { log("标记请求失败出错:", e.message); }
}

// ---------- 2. 启动浏览器拿二维码 ----------
// 在页面里查找当前登录二维码 dataURI（抖音会自动换新二维码，需反复查）
async function findQrUri(page) {
  return page.evaluate(() => {
    // 二维码判定：尺寸 + 黑白对比 + "三个角定位块"特征（1:1:3:1:1 黑白序列）
    // 装饰图/空白图即使尺寸像素相近，也不会有定位块特征
    const qrLike = (im) => {
      const w = im.naturalWidth, h = im.naturalHeight;
      if (!(w >= 180 && w <= 700 && h >= 180 && h <= 700)) return false;   // 边长范围
      if (Math.abs(w - h) / Math.max(w, h) > 0.08) return false;           // 近似正方形
      if (typeof im.src !== "string" || !im.src.startsWith("data:image/")) return false;
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(im, 0, 0);
      const px = ctx.getImageData(0, 0, w, h).data;
      const gray = (x, y) => (px[(y * w + x) * 4] * 299 + px[(y * w + x) * 4 + 1] * 587 + px[(y * w + x) * 4 + 2] * 114) / 1000;
      // 整体黑白对比（排除纯色/渐变装饰图）
      let min = 255, max = 0, dark = 0, total = 0;
      for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
        const v = gray(x, y); total++;
        if (v < 128) dark++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max - min <= 60 || dark / total <= 0.05 || dark / total >= 0.95) return false;
      // 定位块扫描：沿行/列找 1:1:3:1:1 黑白序列（二维码三处定位块的独有特征）
      const countPattern = (vertical) => {
        const lines = vertical ? h : w;   // 扫描线数量
        const span = vertical ? w : h;    // 每条线的长度
        let hits = 0;
        for (let li = 0; li < lines; li += 2) {
          const runs = [];
          let cur = (vertical ? gray(li, 0) : gray(0, li)) < 128, len = 0;
          for (let oi = 0; oi < span; oi++) {
            const d = (vertical ? gray(li, oi) : gray(oi, li)) < 128;
            if (d === cur) len++;
            else { runs.push({ d: cur, len }); cur = d; len = 1; }
          }
          runs.push({ d: cur, len });
          for (let i = 0; i + 4 < runs.length; i++) {
            const a = runs[i], b = runs[i + 1], c = runs[i + 2], d = runs[i + 3], e = runs[i + 4];
            if (!a.d || !c.d || !e.d || b.d || d.d) continue;
            const unit = (a.len + b.len + c.len + d.len + e.len) / 7;
            if (unit < 2) continue;
            if (Math.abs(a.len - unit) <= 0.7 * unit && Math.abs(b.len - unit) <= 0.7 * unit &&
                Math.abs(c.len - 3 * unit) <= 0.7 * unit && Math.abs(d.len - unit) <= 0.7 * unit &&
                Math.abs(e.len - unit) <= 0.7 * unit) hits++;
          }
        }
        return hits;
      };
      return countPattern(false) >= 20 && countPattern(true) >= 20;
    };

    // 优先在「扫码登录」弹窗容器里找，找不到再全页找
    let container = null;
    try {
      const xp = document.evaluate("//*[contains(text(),'扫码登录')]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < xp.snapshotLength; i++) {
        let el = xp.snapshotItem(i);
        if (el && el.nodeType !== 1) el = el.parentElement;
        for (let up = 0; up < 8 && el; up++) {
          if (el.querySelectorAll && el.querySelectorAll("img").length) { container = el; break; }
          el = el.parentElement;
        }
        if (container) break;
      }
    } catch { /* XPath 不可用时退回全页扫描 */ }
    const root = container || document;
    const imgs = [];
    root.querySelectorAll("img").forEach((im) => imgs.push(im));
    for (const im of imgs) {
      try { if (qrLike(im)) return im.src; } catch { /* 跳过无法读取的图片 */ }
    }
    return "";
  }).catch(() => "");
}
async function openBrowserAndGetQr() {
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--window-size=1280,800",
    ],
  });
  const context = await browser.newContext({
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("页面错误(可忽略):", String(e).slice(0, 120)));
  // 诊断：监听抖音扫码状态接口的返回；account_flow=verify 表示要短信二次验证
  const loginFlow = { verifyTriggered: false, lastVerifyBody: "" };
  page.on("response", async (r) => {
    try {
      if (r.url().includes("check_qrconnect")) {
        const body = await r.text().catch(() => "");
        log("CHECK_QR 返回:", r.status(), body.slice(0, 160));
        if (body.includes('"account_flow":"verify"')) {
          loginFlow.verifyTriggered = true;
          loginFlow.lastVerifyBody = body.slice(0, 600);
          log("抖音要求二次安全验证（短信验证码）");
        }
      }
    } catch { /* 忽略 */ }
  });

  log("打开 douyin.com …");
  await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  log("页面已加载，等待登录二维码弹出…");

  const deadline = Date.now() + QR_WAIT_MS;
  let qrUri = "";
  while (Date.now() < deadline) {
    qrUri = await findQrUri(page);
    if (qrUri) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!qrUri) {
    await page.screenshot({ path: "qr-fail.png" }).catch(() => {});
    log("未找到二维码（可能已自动登录或弹窗失败）");
    return { browser, page, context, qrUri: "", flow: loginFlow };
  }
  await page.screenshot({ path: "qr.png" }).catch(() => {});
  log("二维码已生成");
  return { browser, page, context, qrUri, flow: loginFlow };
}

// 登录成功后尽量从页面数据里提取自己的 sec_uid / 昵称（尽力而为）
async function extractSelfInfo(page) {
  try {
    const info = await page.evaluate(() => {
      const grab = (obj) => {
        if (!obj) return "";
        const s = typeof obj === "string" ? obj : JSON.stringify(obj);
        const m = s.match(/"sec_uid":"(MS4wLjAB[A-Za-z0-9_-]{10,})"/);
        return m ? m[1] : "";
      };
      const direct = (window.__INIT_PROPS__ && window.__INIT_PROPS__.user && window.__INIT_PROPS__.user.sec_uid) || "";
      const nick = (window.__INIT_PROPS__ && (window.__INIT_PROPS__.user?.nickname || window.__INIT_PROPS__.user_info?.nickname)) || "";
      return {
        secUid: direct || grab(window.__INIT_PROPS__) || grab(window._ROUTER_DATA) || grab(window.RENDER_DATA) || "",
        nickname: nick || "",
      };
    });
    return info;
  } catch {
    return { secUid: "", nickname: "" };
  }
}

// ---------- 短信二次验证（抖音扫码后要求短信验证码） ----------
const VERIFY_WAIT_MS = Number(process.env.VERIFY_WAIT_MS) || 300000; // 等用户输入验证码
const evalWithTimeout = (fn) => Promise.race([fn, new Promise((r) => setTimeout(() => r(null), 12000))]);

// 找页面上的短信验证码输入框（必须同时出现"验证码"文案，避免误判手机号登录页）
async function findVerifyInfo(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    let input = null;
    document.querySelectorAll("input").forEach((el) => {
      if (input || !vis(el)) return;
      const ph = (el.placeholder || "") + " " + (el.getAttribute("aria-label") || "");
      if (/验证码/.test(ph)) input = el;
    });
    const text = (document.body.innerText || "").replace(/\s+/g, " ");
    const m = text.match(/\d{3}\*{3,4}\d{3,4}/);
    const mobile = m ? m[0] : "";
    const hasVerify = /短信验证|验证码|安全验证|账号验证/.test(text);
    return { found: !!input && hasVerify, mobile, hasVerify, hint: text.slice(0, 220) };
  }).catch(() => ({ found: false, mobile: "", hasVerify: false, hint: "" }));
}

// 点击「获取验证码/重新发送」，确保短信已发出（仅在验证码输入框出现后调用）
async function clickResendCode(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    let clicked = "";
    document.querySelectorAll("button, a, span, div").forEach((el) => {
      if (clicked || !vis(el)) return;
      const t = (el.innerText || "").trim();
      if (!t || t.length > 10) return;
      if (/获取验证码|重新发送|重新获取|发送验证码/.test(t)) { el.click(); clicked = t; }
    });
    return clicked;
  }).catch(() => "");
}

// 把用户输入的验证码填入页面并点提交
async function fillVerifyCode(page, code) {
  return page.evaluate((c) => {
    const vis = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const digits = String(c).replace(/\D/g, "").slice(0, 6);
    const all = Array.from(document.querySelectorAll("input")).filter(vis);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    let target = null;
    const single = all.find((el) => /验证码/.test((el.placeholder || "") + " " + (el.getAttribute("aria-label") || "")));
    if (single) {
      target = single;
      setter.call(target, digits);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // 也可能是 4-8 个单独格子
      const boxes = all.filter((el) => Number(el.maxLength) === 1 && (el.inputMode || "").toLowerCase() !== "text");
      if (boxes.length >= 4 && boxes.length <= 8) {
        target = boxes[0];
        for (let i = 0; i < boxes.length; i++) {
          setter.call(boxes[i], digits[i] || "");
          boxes[i].dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }
    if (!target) return "no_input";
    let btn = null;
    document.querySelectorAll("button").forEach((b) => {
      if (btn || !vis(b)) return;
      const t = (b.innerText || "").trim();
      if (!t || t.length > 8 || /获取|发送|重新|取消/.test(t)) return;
      if (/提交|确定|确认|验证|完成|下一步/.test(t)) btn = b;
    });
    if (btn) { btn.click(); return "clicked:" + btn.innerText.trim(); }
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return "filled_enter";
  }, code).catch(() => "error");
}

// ---------- 3. 主流程 ----------
async function main() {
  const { userId, reqId } = await claimRequest();
  const started = Date.now();
  let browser = null;
  try {
    const got = await openBrowserAndGetQr();
    browser = got.browser;
    if (!got.qrUri) {
      await failRequest(reqId, "未获取到二维码（抖音页面未弹出登录框）");
      log("退出：未获取到二维码");
      await browser.close().catch(() => {});
      process.exit(1);
    }

    const token = "ghqr-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const qrcode = got.qrUri.replace(/^data:image\/png;base64,/, "");
    // 老二维码（更早的 pending）作废，保证最新一条生效
    await rest("PATCH", `login_states?user_id=eq.${userId}&status=eq.pending`, { status: "expired", updated_at: nowIso() }).catch(() => {});
    const row = await rest("POST", "login_states", {
      user_id: userId,
      token,
      cookies_json: {},
      qrcode,
      status: "pending",
    });
    const stateId = row?.[0]?.id;
    log("已写入二维码 login_states id=", stateId, "等待手机扫码…");

    // 等待 sessionid 出现；期间若页面自动刷新了二维码，同步给网站；
    // 抖音要求短信二次验证时，通知网站让用户输入验证码，再自动填入
    const scanDeadline = Date.now() + SCAN_WAIT_MS;
    let cookiesMap = null;
    let lastQrCheck = 0;
    let shownQr = qrcode;
    let verifyAnnounced = false;   // 是否已通知网站"需要短信验证码"
    let verifyDeadline = 0;
    let verifySearchStart = 0;
    let lastInputSeen = 0;
    let codeReceived = false;      // 用户验证码是否已填入页面
    let codeFilledAt = 0;
    const qrWithTimeout = () => Promise.race([
      findQrUri(got.page),
      new Promise((r) => setTimeout(() => r(""), 12000)),
    ]);
    while (Date.now() < (verifyAnnounced ? Math.max(scanDeadline, verifyDeadline) : scanDeadline)) {
      // 1) 先查登录 cookie（抖音确认登录后立即写入）
      const cookies = await got.context.cookies().catch(() => []);
      const map = {};
      for (const c of cookies) map[c.name] = c.value;
      if (map.sessionid || map.sid_tt) { cookiesMap = map; break; }

      // 2) 顺带同步抖音自动换新的二维码（带超时，失败不阻塞主循环）
      if (Date.now() - lastQrCheck > 5000) {
        lastQrCheck = Date.now();
        try {
          const cur = await qrWithTimeout();
          if (cur && cur !== got.qrUri) {
            got.qrUri = cur;
            shownQr = cur.replace(/^data:image\/png;base64,/, "");
            await rest("PATCH", `login_states?id=eq.${stateId}`, { qrcode: shownQr, updated_at: nowIso() }).catch(() => {});
            log("二维码已自动换新并同步到网站");
          }
        } catch (e) { log("二维码同步异常(忽略):", String(e).slice(0, 80)); }
      }

      // 3) 短信二次验证：抖音要求验证 → 通知网站；等用户输验证码 → 自动填入提交
      if (got.flow.verifyTriggered && !verifyAnnounced) {
        if (!verifySearchStart) verifySearchStart = Date.now();
        const info = await evalWithTimeout(findVerifyInfo(got.page));
        if (info && info.found) {
          verifyAnnounced = true;
          verifyDeadline = Date.now() + VERIFY_WAIT_MS;
          lastInputSeen = Date.now();
          const sent = await clickResendCode(got.page).catch(() => "");
          if (sent) log("已点击「" + sent + "」确保验证码已发送");
          // 从页面文字里截取"验证码"附近的提示，避免把整页导航文字带进网站
          const kIdx = (info.hint || "").indexOf("验证码");
          const snippet = kIdx >= 0 ? info.hint.slice(Math.max(0, kIdx - 40), kIdx + 80) : (info.hint || "").slice(0, 120);
          await rest("PATCH", `login_states?id=eq.${stateId}`, {
            status: "verify_sms",
            mobile: info.mobile || null,
            verify_hint: snippet,
            updated_at: nowIso(),
          }).catch(() => {});
          log("检测到短信验证 → 已通知网站，等待用户输入验证码");
        } else if (Date.now() - verifySearchStart > 60000) {
          const txt = await evalWithTimeout(got.page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300))).catch(() => "");
          await got.page.screenshot({ path: "verify-fail.png" }).catch(() => {});
          log("验证码输入框未找到，页面文字:", txt, "| verify返回:", got.flow.lastVerifyBody.slice(0, 200));
          verifySearchStart = Date.now();
        }
      }

      if (verifyAnnounced && !codeReceived) {
        // 输入框是否还在（防验证流程被页面刷新打断）
        const info = await evalWithTimeout(findVerifyInfo(got.page));
        if (info && info.found) lastInputSeen = Date.now();
        else if (lastInputSeen && Date.now() - lastInputSeen > 45000) {
          log("验证码输入框消失超过45秒，验证流程可能已重置，等待重新触发");
          verifyAnnounced = false;
          verifyDeadline = 0;
          verifySearchStart = 0;
          lastInputSeen = 0;
          await rest("PATCH", `login_states?id=eq.${stateId}`, { status: "pending", sms_code: null, updated_at: nowIso() }).catch(() => {});
          continue;
        }
        const rows = await rest("GET", `login_states?id=eq.${stateId}&select=sms_code`).catch(() => []);
        const code = (rows?.[0]?.sms_code || "").trim();
        if (code) {
          const filled = await evalWithTimeout(fillVerifyCode(got.page, code));
          log("已把验证码填入页面:", filled);
          codeReceived = true;
          codeFilledAt = Date.now();
          await rest("PATCH", `login_states?id=eq.${stateId}`, { sms_code: null, updated_at: nowIso() }).catch(() => {});
        }
      }
      // 验证码提交后 30 秒仍没登录成功 → 可能填错/超时，允许重新输入
      if (codeReceived && Date.now() - codeFilledAt > 30000 && !cookiesMap) {
        log("验证码提交后未成功，允许重新输入");
        codeReceived = false;
        await rest("PATCH", `login_states?id=eq.${stateId}`, {
          verify_hint: "验证码不正确或已过期，请重新输入验证码",
          updated_at: nowIso(),
        }).catch(() => {});
      }

      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    if (!cookiesMap) {
      // 诊断信息：页面地址、当前二维码是否存在、cookie 名列表
      let diag = verifyAnnounced ? "等待短信验证码超时" : "等待扫码超时";
      try {
        const url = got.page.url();
        const qrStill = await Promise.race([findQrUri(got.page), new Promise((r) => setTimeout(() => r(""), 12000))]).catch(() => "");
        const cookies = await got.context.cookies().catch(() => []);
        const names = cookies.map((x) => x.name).slice(0, 12).join(",");
        const modalText = (await got.page.evaluate(() => (document.body.innerText || "").replace(/\n+/g, "|").slice(0, 150)).catch(() => ""));
        diag = `url=${url} qr=${qrStill ? "有" : "无"} cookies=[${names}] 页面文字=${modalText}`;
      } catch { /* 诊断失败忽略 */ }
      if (verifyAnnounced) diag += " 验证码=" + (codeReceived ? "已提交" : "等待输入");
      log("诊断:", diag);
      await rest("PATCH", `login_states?id=eq.${stateId}`, { status: "expired", error: diag.slice(0, 300), updated_at: nowIso() }).catch(() => {});
      await failRequest(reqId, diag.slice(0, 200));
      log("退出：等待扫码超时");
      await browser.close().catch(() => {});
      process.exit(1);
    }

    const self = await extractSelfInfo(got.page);
    log("登录成功！sessionid 已获取", "sec_uid:", self.secUid ? "有" : "无", "昵称:", self.nickname || "无");
    await rest("PATCH", `login_states?id=eq.${stateId}`, {
      status: "scanned_ok",
      cookies_json: cookiesMap,
      sec_uid: self.secUid || null,
      nickname: self.nickname || null,
      updated_at: nowIso(),
    });
    if (reqId) await rest("PATCH", `login_requests?id=eq.${reqId}`, { status: "done", token, updated_at: nowIso() });
    log("已保存登录 cookie，任务完成，耗时", Math.round((Date.now() - started) / 1000) + "s");
    await browser.close().catch(() => {});
    process.exit(0);
  } catch (e) {
    log("worker 异常:", e.message);
    await failRequest(reqId, String(e.message || e).slice(0, 200));
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
}

main();




