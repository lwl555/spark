// 抖音扫码登录 Worker：在 GitHub Actions 上跑真浏览器完成登录
// 1) 认领 login_requests 里最早的一条 pending（或直接处理 TARGET_USER_ID）
// 2) 有头 Chromium 打开 douyin.com，取二维码 dataURI 写入 login_states
// 3) 轮询浏览器 cookie，出现 sessionid 即登录成功 → 完整 cookies 写回
// 4) 超时未扫码 → 标记 expired/failed
import { chromium } from "playwright";
import fs from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const TARGET_USER_ID = (process.env.TARGET_USER_ID || "").trim();

const QR_WAIT_MS = Number(process.env.QR_WAIT_MS) || 35000; // 等二维码弹出
const SCAN_WAIT_MS = Number(process.env.SCAN_WAIT_MS) || 300000; // 等用户扫码确认（二维码会自动刷新续期）
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
    const imgs = [...document.querySelectorAll("img")];
    for (const im of imgs) {
      if (im.naturalWidth >= 400 && typeof im.src === "string" && im.src.startsWith("data:image/png")) return im.src;
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
    return { browser, page, context, qrUri: "" };
  }
  await page.screenshot({ path: "qr.png" }).catch(() => {});
  log("二维码已生成");
  return { browser, page, context, qrUri };
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

    // 等待 sessionid 出现；期间若页面自动刷新了二维码，同步给网站
    const scanDeadline = Date.now() + SCAN_WAIT_MS;
    let cookiesMap = null;
    let lastQrCheck = 0;
    let shownQr = qrcode;
    while (Date.now() < scanDeadline) {
      if (Date.now() - lastQrCheck > 5000) {
        lastQrCheck = Date.now();
        const cur = await findQrUri(got.page).catch(() => "");
        if (cur && cur !== got.qrUri) {
          got.qrUri = cur;
          shownQr = cur.replace(/^data:image\/png;base64,/, "");
          await rest("PATCH", `login_states?id=eq.${stateId}`, { qrcode: shownQr, updated_at: nowIso() }).catch(() => {});
          log("二维码已自动换新并同步到网站");
        }
      }
      const cookies = await got.context.cookies().catch(() => []);
      const map = {};
      for (const c of cookies) map[c.name] = c.value;
      if (map.sessionid || map.sid_tt) { cookiesMap = map; break; }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    if (!cookiesMap) {
      await rest("PATCH", `login_states?id=eq.${stateId}`, { status: "expired", updated_at: nowIso() }).catch(() => {});
      await failRequest(reqId, "等待扫码超时");
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


