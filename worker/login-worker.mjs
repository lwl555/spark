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
const IDENTITY_WAIT_MS = Number(process.env.IDENTITY_WAIT_MS) || 480000; // 等用户在手机上完成身份验证（刷脸）
const evalWithTimeout = (fn) => Promise.race([fn, new Promise((r) => setTimeout(() => r(null), 12000))]);

// 找页面上的验证弹窗（含短信验证码、滑块等），读取完整文案与按钮状态
async function findVerifyInfo(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const findInput = () => {
      let input = null;
      document.querySelectorAll("input").forEach((el) => {
        if (input || !vis(el)) return;
        const ph = (el.placeholder || "") + " " + (el.getAttribute("aria-label") || "");
        if (/验证码/.test(ph)) input = el;
      });
      return input;
    };
    const ownText = (el) =>
      Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    const findSendBtn = (rootEl) => {
      let btn = null;
      rootEl.querySelectorAll("*").forEach((b) => {
        if (btn || !vis(b)) return;
        const t = (ownText(b) || (b.innerText || "")).trim();
        if (t && t.length <= 12 && /获取短信验证码|获取验证码|发送验证码|重新发送|重新获取/.test(t)) btn = b;
      });
      return btn;
    };
    const input = findInput();
    if (input) {
      let container = input;
      let best = null;
      for (let up = 0; up < 8 && container; up++) {
        const t = (container.innerText || "").replace(/\s+/g, " ").trim();
        if (/验证码|安全验证|短信|手机/.test(t)) best = container;
        container = container.parentElement;
        if (best && container && container.querySelectorAll("input").length >= 3) break;
      }
      if (!best) return { found: false, stage: "none", mobile: "", hint: "", buttons: [] };
      const root = best;
      const containerText = (root.innerText || "").replace(/\s+/g, " ").slice(0, 400);
      const buttons = [];
      root.querySelectorAll("*").forEach((b) => {
        if (!vis(b)) return;
        const t = (ownText(b) || "").replace(/\s+/g, " ").trim();
        if (t && t.length <= 12) buttons.push({ text: t, disabled: b.disabled === true || b.getAttribute("aria-disabled") === "true" });
      });
      const m = containerText.match(/\d{3}\*{3,4}\d{3,4}/);
      return { found: true, stage: "sms_input", mobile: m ? m[0] : "", hint: containerText, buttons };
    }
    const phoneMatch = (document.body.innerText || "").match(/(\d{3}\*{3,4}\d{3,4})/);
    const hasRiskPopup = /安全验证|身份验证|风险验证|验证手机号|为保护/.test(document.body.innerText || "");
    const sendBtn = findSendBtn(document.body);
    if (phoneMatch || (hasRiskPopup && sendBtn)) {
      const m = phoneMatch ? phoneMatch[1] : "";
      const hint = (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400);
      const buttons = [];
      if (sendBtn) {
        const t = (sendBtn.innerText || "").trim();
        buttons.push({ text: t, disabled: !!(sendBtn.disabled || sendBtn.getAttribute("aria-disabled") === "true") });
      }
      return { found: true, stage: "risk_popup", mobile: m, hint, buttons };
    }
    return { found: false, stage: "none", mobile: "", hint: "", buttons: [] };
  }).catch(() => ({ found: false, stage: "none", mobile: "", hint: "", buttons: [] }));
}


// 检测「身份验证」弹窗（抖音扫码后可能出现：接收短信验证码 / 发送短信验证 / 手机刷脸验证）
// 返回各选项的点击坐标，worker 自动点「手机刷脸验证」，用户在手机上完成验证后登录自动继续
async function findIdentityOptions(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const ownText = (el) =>
      Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    const bodyTxt = (document.body.innerText || "").replace(/\s+/g, " ");
    if (!/身份验证|接收短信验证码|发送短信验证|手机刷脸验证/.test(bodyTxt)) return { found: false, options: [] };
    const pats = [/接收短信验证码/, /发送短信验证/, /手机刷脸验证/, /更多验证方式/];
    const all = Array.from(document.querySelectorAll("body *"));
    const options = [];
    for (const el of all) {
      if (!vis(el)) continue;
      const own = ownText(el).replace(/\s+/g, "").trim();
      if (!own || own.length > 10) continue;
      if (!pats.some((p) => p.test(own))) continue;
      let hasDeeper = false;
      for (const d of el.querySelectorAll("*")) {
        const dt = ownText(d).replace(/\s+/g, "").trim();
        if (vis(d) && dt && dt.length <= 10 && pats.some((p) => p.test(dt))) { hasDeeper = true; break; }
      }
      if (hasDeeper) continue;
      const r = el.getBoundingClientRect();
      options.push({ text: own, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    }
    return { found: options.length >= 2, options };
  }).catch(() => ({ found: false, options: [] }));
}

// 点击「获取验证码/重新发送」（支持风险弹窗 + 短信输入框两种场景）
// 在页面里找“文字匹配的可见元素”的中心点（不限于 <button>，兼容 div/span 等自定义按钮）
async function findClickableByText(page, patterns, maxLen = 12) {
  return page.evaluate(({ pats, maxLen }) => {
    const vis = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const ownText = (el) =>
      Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    const all = Array.from(document.querySelectorAll("body *"));
    for (const el of all) {
      if (!vis(el)) continue;
      const t = (el.innerText || "").trim();
      if (!t || t.length > maxLen) continue;
      const own = ownText(el);
      if (!pats.some((p) => p.test(own || t))) continue;
      // 优先最深的小元素：若子元素里还有匹配者，跳过当前容器
      let hasDeeper = false;
      for (const d of el.querySelectorAll("*")) {
        const dt = (d.innerText || "").trim();
        if (vis(d) && dt && dt.length <= maxLen && pats.some((p) => p.test(dt))) { hasDeeper = true; break; }
      }
      if (hasDeeper) continue;
      const r = el.getBoundingClientRect();
      return {
        text: t,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 80),
        disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      };
    }
    return null;
  }, { pats: patterns, maxLen }).catch(() => null);
}

// 点击「获取验证码/重新发送」（任意元素形态，用真实鼠标点击，兼容 div/span）
async function clickResendCode(page) {
  const btn = await findClickableByText(page, [/获取短信验证码|获取验证码|发送验证码|重新发送|重新获取/]);
  if (!btn) {
    // 诊断：列出页面上所有可见的小文本元素，确认按钮真实结构
    const dump = await page.evaluate(() => {
      const vis = (el) => {
        if (!el || el.nodeType !== 1) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      };
      const ownText = (el) =>
        Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
      const out = [];
      document.querySelectorAll("body *").forEach((el) => {
        if (!vis(el)) return;
        const own = ownText(el).replace(/\s+/g, " ");
        if (!own || own.length > 14) return;
        out.push(el.tagName.toLowerCase() + "|" + String(el.className || "").slice(0, 40) + "|" + own);
      });
      return out.slice(0, 80);
    }).catch(() => []);
    log("未找到「获取验证码」按钮，可见元素诊断:", JSON.stringify(dump));
    return "no_button";
  }
  const top = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return "";
    return el.tagName.toLowerCase() + "|" + String(el.className || "").slice(0, 40) + "|" + ((el.innerText || "").trim().slice(0, 12));
  }, { x: btn.x, y: btn.y }).catch(() => "");
  log("获取验证码按钮定位:", btn.tag + "|" + btn.cls + "|" + btn.text, "顶部元素:", top);
  if (btn.disabled) return "disabled:" + btn.text;
  await page.mouse.click(btn.x, btn.y);
  return "clicked:" + btn.text;
}

// 检测滑块验证 iframe 是否出现
async function detectSlider(page) {
  try {
    const frames = page.frames();
    for (const f of frames) {
      const url = f.url() || "";
      if (/verifycenter|nocaptcha|rc-verify/.test(url)) {
        return { found: true, url };
      }
    }
    const mainFrame = page.mainFrame();
    const hasIframe = await mainFrame.evaluate(() => {
      const iframes = document.querySelectorAll("iframe");
      for (const ifr of iframes) {
        const src = ifr.src || "";
        if (/verifycenter|nocaptcha|rc-verify/.test(src)) return true;
      }
      return false;
    }).catch(() => false);
    if (hasIframe) return { found: true, url: "iframe_in_dom" };
    return { found: false };
  } catch {
    return { found: false };
  }
}

// 尝试解决滑块验证（自动拖拽）
async function solveSlider(page) {
  try {
    const frames = page.frames();
    let sliderFrame = null;
    for (const f of frames) {
      const url = f.url() || "";
      if (/verifycenter|nocaptcha|rc-verify/.test(url)) { sliderFrame = f; break; }
    }
    if (!sliderFrame) return { solved: false, reason: "no_frame" };
    await sliderFrame.waitForLoadState("domcontentloaded").catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    const sliderInfo = await sliderFrame.evaluate(() => {
      let track = null, handle = null;
      const all = Array.from(document.querySelectorAll("div, span, button, a"));
      for (const el of all) {
        const r = el.getBoundingClientRect();
        const cls = (el.className || "") + " " + (el.id || "");
        if (!track && r.width > 200 && r.height > 20 && r.height < 60) {
          if (/track|slide|bar|drag/.test(cls)) track = el;
        }
        if (!handle && r.width > 30 && r.width < 80 && r.height > 30 && r.height < 80) {
          if (/btn|button|handle|drag|block|slider/.test(cls)) handle = el;
        }
      }
      if (!track) {
        const candidates = all.filter(d => {
          const r = d.getBoundingClientRect();
          return r.width > 200 && r.height > 20 && r.height < 60;
        });
        if (candidates.length) track = candidates[0];
      }
      if (!handle) {
        const candidates = all.filter(d => {
          const r = d.getBoundingClientRect();
          return r.width > 30 && r.width < 70 && r.height > 30 && r.height < 70
            && /btn|handle|drag|block|slider/.test((d.className || "") + " " + (d.id || ""));
        });
        if (candidates.length) handle = candidates[0];
      }
      if (!track || !handle) return { found: false };
      const tr = track.getBoundingClientRect();
      const hr = handle.getBoundingClientRect();
      return {
        found: true,
        trackX: tr.left, trackY: tr.top + tr.height / 2, trackWidth: tr.width,
        handleX: hr.left + hr.width / 2, handleY: hr.top + hr.height / 2, handleWidth: hr.width
      };
    }).catch(() => ({ found: false }));
    if (!sliderInfo.found) return { solved: false, reason: "no_slider_elements" };
    const distance = sliderInfo.trackWidth - sliderInfo.handleWidth - 5;
    if (distance <= 0) return { solved: false, reason: "invalid_distance" };
    await page.mouse.move(sliderInfo.handleX, sliderInfo.handleY);
    await page.mouse.down();
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const x = sliderInfo.handleX + (distance * i / steps);
      const y = sliderInfo.handleY + (Math.sin(i * 0.5) * 3);
      await page.mouse.move(x, y);
      await new Promise(r => setTimeout(r, 30));
    }
    await page.mouse.move(sliderInfo.handleX + distance + 2, sliderInfo.handleY);
    await new Promise(r => setTimeout(r, 100));
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 2000));
    const after = await detectSlider(page);
    if (!after.found) return { solved: true, reason: "slider_gone" };
    return { solved: false, reason: "still_present" };
  } catch (e) {
    return { solved: false, reason: String(e).slice(0, 100) };
  }
}


// 确保短信验证码真正发出：点「获取验证码」→ 处理滑块 → 确认进入发送状态（倒计时/已发送文案）
async function ensureSmsSent(page) {
  try {
    const sentState = () => page.evaluate(() => {
      const vis = (el) => {
        if (!el || el.nodeType !== 1) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      };
      const ownText = (el) =>
        Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
      let countdown = "";
      document.querySelectorAll("body *").forEach((b) => {
        if (countdown || !vis(b)) return;
        const t = (ownText(b) || (b.innerText || "")).trim();
        if (!t || t.length > 14) return;
        if (/\d+\s*[s秒]/.test(t) || /重新发送|重新获取|已发送/.test(t)) countdown = t;
      });
      const bodyTxt = (document.body.innerText || "").replace(/\s+/g, " ");
      const sentText = /验证码已发送|已发送验证码|发送成功|验证码已下发|短信已发送/.test(bodyTxt);
      return { countdown, sentText };
    }).catch(() => ({ countdown: "", sentText: false }));

    // 1) 可能已经自动发送
    let st = await sentState();
    if (st.countdown || st.sentText) return { sent: true, reason: "already_sent" };

    // 2) 点「获取验证码」（可点多次；抖音会弹滑块或进入倒计时）
    for (let attempt = 0; attempt < 3; attempt++) {
      const clicked = await clickResendCode(page).catch(() => "");
      log("尝试点击获取验证码:", clicked || "无");
      if (clicked && clicked.startsWith("disabled")) {
        st = await sentState();
        if (st.countdown || st.sentText) return { sent: true, reason: "countdown_disabled" };
      }
      if (clicked && clicked.startsWith("clicked")) {
        // 3) 处理可能出现的滑块（最多约 10 秒；失败自动重试）
        for (let wi = 0; wi < 20; wi++) {
          await new Promise((r) => setTimeout(r, 500));
          const slider = await detectSlider(page);
          if (slider.found) {
            log("检测到滑块验证，尝试自动解决…");
            await page.screenshot({ path: "slider-found.png" }).catch(() => {});
            let result = await solveSlider(page);
            log("滑块处理结果:", JSON.stringify(result));
            if (!result.solved) {
              for (let retry = 0; retry < 2 && !result.solved; retry++) {
                await new Promise((r) => setTimeout(r, 1200));
                result = await solveSlider(page);
                log("滑块重试", retry + 1, ":", JSON.stringify(result));
              }
            }
          }
          st = await sentState();
          if (st.countdown || st.sentText) return { sent: true, reason: "sent_after_click" };
        }
      } else {
        // 没有可点的按钮：等 3 秒再看是否已自动发送
        await new Promise((r) => setTimeout(r, 3000));
        st = await sentState();
        if (st.countdown || st.sentText) return { sent: true, reason: "auto_sent" };
      }
    }
    const diag = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300)).catch(() => "");
    log("短信发送未确认，页面文字:", diag);
    return { sent: false, reason: "send_not_confirmed" };
  } catch (e) {
    return { sent: false, reason: String(e).slice(0, 80) };
  }
}
// 把用户输入的验证码填入页面并点提交
async function fillVerifyCode(page, code) {
  const r = await page.evaluate((c) => {
    const vis = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const ownText = (el) =>
      Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
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
    if (!target) return { filled: false, submit: null };
    let btn = null;
    document.querySelectorAll("body *").forEach((b) => {
      if (btn || !vis(b)) return;
      const t = (ownText(b) || (b.innerText || "")).trim();
      if (!t || t.length > 8 || /获取|发送|重新|取消|验证码/.test(t)) return;
    if (/提交|确定|确认|验证|完成|下一步/.test(t)) {
        const br = b.getBoundingClientRect();
        btn = { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2), t };
      }
    });
    if (!btn) target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { filled: true, submit: btn };
  }, code).catch(() => "error");
  if (r === "error") return "error";
  if (r.submit) {
    await page.mouse.click(r.submit.x, r.submit.y);
    return "clicked:" + r.submit.t;
  }
  if (r.filled) return "filled_enter";
  return "no_input";
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
    // 老二维码（更早的 pending/verify_sms）作废，保证最新一条生效
    await rest("PATCH", `login_states?user_id=eq.${userId}&status=in.(pending,verify_sms,verify_identity)`, { status: "expired", updated_at: nowIso() }).catch(() => {});
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
    let lastResendAt = 0;          // 上次尝试点「获取验证码」的时间
    let lastSupersedeCheck = 0;    // 上次检查用户是否重新绑定
    let verifyMode = "sms";        // 验证模式：sms=短信验证码，identity=身份验证（刷脸/短信）
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

      // 2.5) 用户重新点了绑定（出现新的 pending 请求）→ 本任务让位，取消自己让新任务立即开始
      if (Date.now() - lastSupersedeCheck > 15000) {
        lastSupersedeCheck = Date.now();
        const newer = await rest("GET", `login_requests?user_id=eq.${userId}&status=eq.pending&limit=1&select=id`).catch(() => []);
        if (newer?.length) {
          log("用户重新点击了绑定，取消本任务（让新任务立即运行）");
          await rest("PATCH", `login_requests?id=eq.${reqId}`, { status: "canceled", updated_at: nowIso() }).catch(() => {});
          try {
            const runId = process.env.GITHUB_RUN_ID;
            const ghTok = process.env.GITHUB_TOKEN;
            if (runId && ghTok) {
              await fetch("https://api.github.com/repos/lwl555/spark/actions/runs/" + runId + "/cancel", {
                method: "POST",
                headers: { Authorization: "Bearer " + ghTok, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "spark-worker" },
                signal: AbortSignal.timeout(15000),
              });
              log("已请求取消本运行");
            }
          } catch (e) { log("取消自身运行失败(忽略):", String(e).slice(0, 80)); }
          process.exit(0);
        }
      }

      // 3) 二次验证：抖音要求验证 → 先识别「身份验证」弹窗（接收短信/发送短信/手机刷脸 三选一）
      //    优先自动点「手机刷脸验证」，用户只需在手机上完成刷脸，网页自动继续；短信输入作为兜底
      if (got.flow.verifyTriggered && !verifyAnnounced) {
        if (!verifySearchStart) verifySearchStart = Date.now();
        const idOpts = await evalWithTimeout(findIdentityOptions(got.page));
        if (idOpts && idOpts.found) {
          log("身份验证弹窗选项:", JSON.stringify(idOpts.options));
          verifyMode = "identity";
          const face = idOpts.options.find((o) => /刷脸/.test(o.text));
          const smsOpt = idOpts.options.find((o) => /接收短信验证码|发送短信验证/.test(o.text));
          const target = face || smsOpt || idOpts.options[0];
          if (target) {
            await got.page.mouse.click(target.x, target.y).catch(() => {});
            log("已自动点击验证选项:", target.text);
          }
          await got.page.screenshot({ path: "identity-verify.png" }).catch(() => {});
          verifyAnnounced = true;
          verifyDeadline = Date.now() + IDENTITY_WAIT_MS;
          lastInputSeen = Date.now();
          lastResendAt = 0;
          const hint = face
            ? "抖音要求身份验证：已为你选择「手机刷脸验证」。请打开手机抖音 App 按提示完成刷脸，完成后网页会自动继续。若你收到了短信验证码，也可在下方输入。"
            : "抖音要求身份验证：请在手机上按提示完成验证（刷脸或短信），完成后网页会自动继续。";
          await rest("PATCH", `login_states?id=eq.${stateId}`, {
            status: "verify_identity",
            mobile: null,
            verify_hint: hint,
            updated_at: nowIso(),
          }).catch(() => {});
          log("已通知网站：等待用户在手机上完成身份验证");
        } else {
          verifyMode = "sms";
          const info = await evalWithTimeout(findVerifyInfo(got.page));
          if (info && info.found) {
          log("验证弹窗阶段:", info.stage, "手机号:", info.mobile || "无");
          // 无论哪个阶段，先点「获取验证码」并确认短信已发出，再通知网站（避免“提示已发送但实际没发”）
          const sent = await ensureSmsSent(got.page);
          log("短信发送确认:", JSON.stringify(sent));
          if (sent.sent) {
            verifyAnnounced = true;
            verifyDeadline = Date.now() + VERIFY_WAIT_MS;
            lastInputSeen = Date.now();
            lastResendAt = Date.now();
            const finalInfo = await evalWithTimeout(findVerifyInfo(got.page));
            await got.page.screenshot({ path: "verify-modal.png" }).catch(() => {});
            log("验证弹窗按钮:", JSON.stringify(finalInfo?.buttons || []));
            const hint = finalInfo?.hint || info.hint || "";
            const kIdx = hint.indexOf("验证码");
            const snippet = kIdx >= 0 ? hint.slice(Math.max(0, kIdx - 60), kIdx + 120) : hint.slice(0, 200);
            await rest("PATCH", `login_states?id=eq.${stateId}`, {
              status: "verify_sms",
              mobile: finalInfo?.mobile || info.mobile || null,
              verify_hint: snippet,
              updated_at: nowIso(),
            }).catch(() => {});
            log("短信已发出，已通知网站等待用户输入验证码");
          } else {
            // 短信发送未确认：继续重试；超过 90 秒仍失败则明确报错，不误导用户
            if (Date.now() - verifySearchStart > 90000) {
              log("短信发送确认失败，结束任务:", sent.reason);
              await rest("PATCH", `login_states?id=eq.${stateId}`, {
                status: "failed",
                error: "短信验证码发送失败（" + sent.reason + "），请重新绑定",
                updated_at: nowIso(),
              }).catch(() => {});
              await failRequest(reqId, "短信发送失败: " + sent.reason);
              log("退出：短信发送失败");
              await browser.close().catch(() => {});
              process.exit(1);
            }
            log("短信发送尚未确认（", sent.reason, "），继续重试…");
          }
        } else if (Date.now() - verifySearchStart > 60000) {
          // 验证 UI 一直没找到：检查是否其实已登录（验证可能在手机上完成），或弹窗已关闭
          const url = got.page.url();
          const cookies = await got.context.cookies().catch(() => []);
          const hasSession = cookies.some((x) => x.name === "sessionid" || x.name === "sid_tt");
          if (hasSession) {
            const map = {};
            for (const x of cookies) map[x.name] = x.value;
            cookiesMap = map;
            log("检测到已登录（sessionid 已出现），跳过短信验证");
            break;
          }
          const txt = await evalWithTimeout(got.page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200))).catch(() => "");
          log("验证 UI 未找到 url=", url, "text=", txt);
          await got.page.screenshot({ path: "verify-fail.png" }).catch(() => {});
          if (Date.now() - verifySearchStart > 120000) {
            await rest("PATCH", `login_states?id=eq.${stateId}`, {
              status: "failed",
              error: "验证弹窗已关闭或页面跳转，请重新点击绑定",
              updated_at: nowIso(),
            }).catch(() => {});
            await failRequest(reqId, "验证弹窗已关闭或页面跳转");
            log("退出：验证弹窗已关闭或页面跳转");
            await browser.close().catch(() => {});
            process.exit(1);
          }
          verifySearchStart = Date.now();
          }
        }
      }
      if (verifyAnnounced && !codeReceived) {
        if (verifyMode === "sms") {
          // 输入框是否还在（防验证流程被页面刷新打断）——仅短信模式
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
          // 弹窗按钮若仍显示「获取验证码」且可点（短信还没发出），每 10 秒重试
          if (Date.now() - lastResendAt > 10000) {
            lastResendAt = Date.now();
            const res = await clickResendCode(got.page).catch(() => "");
            if (res && res.startsWith("clicked")) log("再次点击发送验证码:", res);
            else if (res && res.startsWith("disabled")) log("验证码按钮倒计时中（短信可能已发送）:", res);
          }
        } else {
          // 身份验证模式：不自动重发短信，等用户在手机上完成刷脸/短信；页面刷新也不重置
          lastInputSeen = Date.now();
        }
        // 两种模式都兜底：用户在前端输入了验证码 → 填入页面
        const rows = await rest("GET", `login_states?id=eq.${stateId}&select=sms_code`).catch(() => []);
        const code = (rows?.[0]?.sms_code || "").trim();
        if (code) {
          const filled = await evalWithTimeout(fillVerifyCode(got.page, code));
          log("已把验证码填入页面:", filled);
          if (String(filled).startsWith("clicked:") || filled === "filled_enter") {
            codeReceived = true;
            codeFilledAt = Date.now();
            await rest("PATCH", `login_states?id=eq.${stateId}`, { sms_code: null, updated_at: nowIso() }).catch(() => {});
          } else if (filled === "no_input" && verifyMode === "identity") {
            // 刷脸模式下页面上没有验证码输入框：提示用户走刷脸，或重选短信后重新绑定
            log("身份验证模式：页面无验证码输入框，跳过短信提交");
            await rest("PATCH", `login_states?id=eq.${stateId}`, {
              sms_code: null,
              verify_hint: "当前为刷脸验证，请先打开手机抖音 App 完成刷脸；若想改用短信，请重新点击绑定并选择「接收短信验证码」。",
              updated_at: nowIso(),
            }).catch(() => {});
          }
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
      let diag = verifyAnnounced ? (verifyMode === "identity" ? "等待身份验证超时（未在手机上完成刷脸/短信验证）" : "等待短信验证码超时") : "等待扫码超时";
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







