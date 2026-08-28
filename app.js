"use strict";
/* 抖音火花助手 · 网页控制台 */
const CFG = window.APP_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
let qrTimer = null;
let currentUser = null;

/* ---------------- 工具 ---------------- */
function toast(text, kind) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast " + (kind || "");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3200);
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function ddlInfo(f) {
  // expire_time 为服务器秒级时间戳；recover_ddl 为剩余天数
  const now = Date.now();
  const expireMs = Number(f.expire_time) * 1000 || 0;
  if (expireMs > now) {
    const days = Math.ceil((expireMs - now) / 86400000);
    return { text: days <= 0 ? "今天到期" : `剩 ${days} 天`, cls: days <= 1 ? "urgent" : days <= 3 ? "warn" : "safe" };
  }
  const ddl = Number(f.recover_ddl) || 0;
  if (ddl > 0) return { text: `剩 ${ddl} 天可续`, cls: ddl <= 1 ? "urgent" : ddl <= 3 ? "warn" : "safe" };
  return { text: "已熄灭", cls: "dark" };
}
function isDbMissing(e) {
  const m = String((e && (e.message || e.error || e)) || "");
  return m.includes("Could not find the table") || m.includes("PGRST205") || m.includes("42P01");
}

/* ---------------- 登录 ---------------- */
$("auth-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("auth-email").value.trim();
  const pass = $("auth-pass").value;
  showAuthMsg("");
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error && /invalid login credentials/i.test(error.message)) {
      const r = await sb.auth.signUp({ email, password: pass });
      if (r.error) throw r.error;
      showAuthMsg("注册成功，已自动登录", true);
    } else if (error) {
      throw error;
    }
    if (data?.user) onLogin(data.user);
  } catch (e) {
    showAuthMsg(e.message || String(e));
  }
});
$("magic-link").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();
  if (!email || !/.+@.+/.test(email)) { showAuthMsg("请先输入邮箱"); return; }
  try {
    const { error } = await sb.auth.signInWithOtp({ email });
    if (error) throw error;
    showAuthMsg("验证码邮件已发送，请查收并登录", true);
  } catch (e) {
    showAuthMsg(e.message || String(e));
  }
});
$("logout").addEventListener("click", () => sb.auth.signOut());
function showAuthMsg(text, ok) {
  const el = $("auth-msg");
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "") + (text ? "" : " hidden");
}

/* ---------------- 数据加载 ---------------- */
async function api(table, opts = {}) {
  let q = sb.from(table).select(opts.select || "*");
  for (const [k, v] of Object.entries(opts.eq || {})) q = q.eq(k, v);
  if (opts.order) q = q.order(opts.order[0], { ascending: opts.order[1] === "asc" });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
async function fn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body: body || {} });
  if (error) {
    const ctx = error.context || {};
    const msg = (ctx.data && ctx.data.error) || ctx.error || error.message || String(error);
    throw new Error(msg);
  }
  if (data && data.ok === false) throw new Error(data.error || name + " 调用失败");
  return data;
}

async function loadAll() {
  const [sessions, settings] = await Promise.all([
    api("douyin_sessions", { eq: { user_id: currentUser.id }, order: ["created_at", "desc"] }),
    api("user_settings", { eq: { user_id: currentUser.id } }),
  ]);
  const friendRows = sessions.length
    ? await api("friends", { eq: { user_id: currentUser.id }, order: ["days", "desc"] })
    : [];
  const history = await api("send_history", { eq: { user_id: currentUser.id }, order: ["created_at", "desc"], limit: 20 });
  renderSessions(sessions);
  renderFriends(sessions, friendRows);
  renderHistory(history);
  renderSettings(settings[0]);
  $("friends-summary").textContent = friendRows.length ? `${friendRows.length} 位好友` : "";
}
function renderSessions(sessions) {
  const box = $("sessions");
  if (!sessions.length) {
    box.innerHTML = `<div class="empty" style="grid-column:1/-1"><p>尚未绑定抖音号</p><p class="muted">点「绑定抖音号」扫码后即可自动管理火花</p></div>`;
    return;
  }
  box.innerHTML = sessions.map((s) => `
    <div class="session-card">
      ${s.avatar_url
        ? `<img class="avatar" src="${esc(s.avatar_url)}" alt="">`
        : `<div class="avatar">🎭</div>`}
      <div class="info">
        <div class="name">${esc(s.nickname || "抖音号")}</div>
        <div class="sub">${s.last_synced_at ? "更新于 " + fmtTime(s.last_synced_at) : "尚未同步"}</div>
      </div>
      <div class="op">
        <span class="tag ${s.status === "active" ? "active" : ""}">${s.status === "active" ? "正常" : "失效"}</span>
        <button class="btn small" data-refresh="${s.id}">刷新</button>
      </div>
    </div>`).join("");
  box.querySelectorAll("[data-refresh]").forEach((b) =>
    b.addEventListener("click", () => refreshSession(b.dataset.refresh)));
}
function renderFriends(sessions, rows) {
  const box = $("friends");
  const sMap = Object.fromEntries(sessions.map((s) => [s.id, s]));
  $("friends-empty").classList.toggle("hidden", rows.length > 0);
  box.innerHTML = rows.map((f) => {
    const d = ddlInfo(f);
    const s = sMap[f.session_id] || {};
    return `
    <div class="friend-card">
      <div class="friend-top">
        ${f.avatar_url
          ? `<img class="avatar" src="${esc(f.avatar_url)}" alt="">`
          : `<div class="avatar">🔥</div>`}
        <div class="info">
          <div class="name">${esc(f.nickname || "神秘好友")}</div>
          <div class="session">${esc(s.nickname || "已解绑")}</div>
        </div>
        <span class="flame">🔥</span>
      </div>
      <div class="days-line">
        <span class="days">${Number(f.days) || 0}</span>
        <span class="days-unit">天连续</span>
      </div>
      <div class="ddl-line">
        <span class="muted">${esc(f.level || "火花")}</span>
        <span class="ddl ${d.cls}">${d.text}</span>
      </div>
      <div class="friend-actions">
        <button class="btn primary" data-send="${f.id}" data-nick="${esc(f.nickname || "")}">🔥 续火花</button>
        ${f.last_sent_at ? `<span class="sent-time">上次 ${fmtTime(f.last_sent_at)}</span>` : ""}
      </div>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-send]").forEach((b) =>
    b.addEventListener("click", () => sendSpark(b.dataset.send, b.dataset.nick)));
}
function renderHistory(rows) {
  const box = $("history");
  $("history-empty").classList.toggle("hidden", rows.length > 0);
  box.innerHTML = rows.map((h) => `
    <div class="history-item">
      <span class="icon">${h.status === "success" ? "✅" : "❌"}</span>
      <span class="msg">${esc(h.message || "")}</span>
      <span class="meta">${h.trigger_type === "auto" ? "自动" : "手动"}<br>${fmtTime(h.created_at)}</span>
    </div>`).join("");
}
function renderSettings(s) {
  $("set-auto").checked = s ? s.auto_send !== false : true;
  $("set-ddl").value = s && s.warn_ddl ? s.warn_ddl : 3;
  $("set-msg").value = s && s.message ? s.message : "火花要灭了，续一下🔥";
}

/* ---------------- 操作 ---------------- */
async function refreshSession(sessionId, quiet) {
  try {
    await fn("refresh-spark", { session_id: sessionId });
    if (!quiet) toast("火花状态已刷新", "ok");
    await loadAll();
  } catch (e) {
    handleErr(e);
  }
}
async function sendSpark(friendId, nick) {
  const btn = document.querySelector(`[data-send="${friendId}"]`);
  if (!btn) return;
  btn.disabled = true; btn.textContent = "发送中…";
  try {
    // 找到好友所属会话
    const f = (await api("friends", { eq: { id: friendId }, select: "session_id" }))[0];
    const r = await fn("send-spark", { session_id: f.session_id, friend_id: friendId });
    toast(`已给 ${r.nickname || nick || "好友"} 发送续火花消息`, "ok");
    await loadAll();
  } catch (e) {
    toast(e.message || "发送失败", "err");
    btn.disabled = false; btn.textContent = "🔥 续火花";
  }
}
async function checkAll() {
  const btn = $("check-all");
  btn.disabled = true; btn.textContent = "检查中…";
  try {
    const r = await fn("daily-run");
    toast(`检查完成：刷新 ${r.refreshed || 0} 个账号，自动续 ${r.sent || 0} 人${r.failed ? "，失败 " + r.failed : ""}`, r.failed ? "err" : "ok");
    await loadAll();
  } catch (e) {
    handleErr(e);
  } finally {
    btn.disabled = false; btn.textContent = "立即检查";
  }
}
function handleErr(e) {
  if (isDbMissing(e)) {
    showBanner("数据库表尚未创建：请在 Supabase 控制台 SQL Editor 中执行项目里的 schema.sql（建表脚本）。");
    toast("数据库未初始化，请管理员执行 schema.sql", "err");
  } else {
    toast(e.message || String(e), "err");
  }
}
function showBanner(text) {
  const b = $("banner");
  b.textContent = text;
  b.classList.remove("hidden");
}

/* ---------------- 扫码绑定 ---------------- */
$("bind-btn").addEventListener("click", startQr);
$("qr-close").addEventListener("click", closeQr);
$("qr-cancel").addEventListener("click", closeQr);
async function startQr() {
  try {
    const r = await fn("login-qr");
    $("qr-img").src = "data:image/png;base64," + r.qrcodeBase64;
    $("qr-status").textContent = "等待扫码…";
    $("qr-modal").classList.remove("hidden");
    clearInterval(qrTimer);
    qrTimer = setInterval(() => pollQr(r.token), 3000);
  } catch (e) {
    handleErr(e);
  }
}
async function pollQr(token) {
  try {
    const r = await fn("login-poll", { token });
    if (r.status === "bound") {
      clearInterval(qrTimer);
      $("qr-status").textContent = "✅ 绑定成功：" + (r.nickname || "抖音号");
      toast("绑定成功，正在同步火花…", "ok");
      setTimeout(() => {
        closeQr();
        const sessions = document.querySelectorAll("[data-refresh]");
        if (sessions.length) sessions[sessions.length - 1].click();
        loadAll();
      }, 1200);
    } else if (r.status === "scanned") {
      $("qr-status").textContent = "已扫码，请在手机上确认…";
    } else if (r.status === "confirmed") {
      $("qr-status").textContent = "已确认，正在完成绑定…";
    } else if (r.status === "expired") {
      clearInterval(qrTimer);
      $("qr-status").textContent = "二维码已过期，请重新生成";
      toast("二维码已过期，请重新生成", "err");
    } else if (r.status === "canceled") {
      clearInterval(qrTimer);
      $("qr-status").textContent = "已取消";
    } else if (r.errorCode === 7) {
      clearInterval(qrTimer);
      $("qr-status").textContent = "登录被抖音风控拦截，请稍后重新生成二维码";
      toast("登录被风控拦截，请稍后重试", "err");
    }
    // 其他未知状态：继续轮询，不中断
  } catch (e) {
    clearInterval(qrTimer);
    $("qr-status").textContent = "轮询失败：" + (e.message || "请重试");
  }
}
function closeQr() {
  clearInterval(qrTimer);
  $("qr-modal").classList.add("hidden");
}

/* ---------------- 设置保存 ---------------- */
$("save-settings").addEventListener("click", async () => {
  const body = {
    auto_send: $("set-auto").checked,
    warn_ddl: Math.max(1, Math.min(30, Number($("set-ddl").value) || 3)),
    message: $("set-msg").value.trim() || "火花要灭了，续一下🔥",
  };
  try {
    const { error } = await sb.from("user_settings").upsert({ user_id: currentUser.id, ...body });
    if (error) throw error;
    toast("设置已保存", "ok");
  } catch (e) {
    handleErr(e);
  }
});

/* ---------------- 启动 ---------------- */
sb.auth.getSession().then(({ data }) => {
  if (data.session?.user) onLogin(data.session.user);
  else showAuth();
});
sb.auth.onAuthStateChange((_ev, session) => {
  if (session?.user) onLogin(session.user);
  else showAuth();
});
function showAuth() {
  currentUser = null;
  $("auth-view").classList.remove("hidden");
  $("main-view").classList.add("hidden");
}
function onLogin(user) {
  currentUser = user;
  $("auth-view").classList.add("hidden");
  $("main-view").classList.remove("hidden");
  $("banner").classList.add("hidden");
  loadAll().catch(handleErr);
  // 打开页面自动跑一次检查（自动续火花）
  checkAll();
}

