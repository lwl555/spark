// 短信验证码登录：验证验证码并获取 session
import { CookieJar } from "../_shared/protocol.ts";
import { handleOptions, json, rest, uidFromAuth } from "../_shared/db.ts";

// 抖音短信验证码 API 端点
const VERIFY_CODE_URL = "https://login.douyin.com/passport/web/mobile/verify_code/";

// 抖音 User-Agent
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

Deno.serve(async (req: Request) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const uid = uidFromAuth(req);
    const body = await req.json().catch(() => ({}));
    const code = String(body.code || "").trim();
    const phone = String(body.phone || "").trim();
    
    if (!code || !/^\d{4,6}$/.test(code)) {
      return json({ ok: false, error: "请输入正确的验证码" }, 400);
    }

    // 1) 获取该用户的验证状态
    const states = await rest(
      "GET",
      `sms_login_states?user_id=eq.${uid}&phone=eq.${phone}&status=eq.pending&order=created_at.desc&limit=1&select=*`,
    ) as any[];
    const state = states?.[0];
    
    if (!state) {
      return json({ ok: false, error: "验证码已过期，请重新获取" }, 400);
    }

    // 2) 检查验证码是否过期（60秒）
    const age = Date.now() - new Date(state.created_at).getTime();
    if (age > 60000) {
      await rest("PATCH", `sms_login_states?id=eq.${state.id}`, { 
        status: "expired", 
        updated_at: new Date().toISOString() 
      });
      return json({ ok: false, error: "验证码已过期，请重新获取" }, 400);
    }

    // 3) 调用抖音验证验证码 API
    const jar = new CookieJar(state.cookies_json || {});
    const params = new URLSearchParams();
    params.append("mobile", phone);
    params.append("code", code);
    params.append("type", "37"); // 37 = 登录验证码
    params.append("region", "86");
    params.append("verify_token", state.verify_token || "");
    params.append("device_platform", "webapp");
    params.append("aid", "6383");
    params.append("version_code", "170400");
    params.append("version_name", "17.4.0");
    
    const res = await fetch(VERIFY_CODE_URL + "?" + params.toString(), {
      method: "GET",
      headers: {
        "User-Agent": UA,
        "Referer": "https://www.douyin.com/",
        "Accept": "application/json, text/plain, */*",
        "Cookie": jar.str(),
      },
      redirect: "manual",
    });
    
    jar.absorbSetCookie(res);
    const data = await res.json();
    
    if (data.error_code !== 0) {
      throw new Error("验证失败: " + (data.error_msg || data.description || JSON.stringify(data).slice(0, 200)));
    }

    // 4) 获取 session cookies
    const cookies = jar.toJSON();
    const hasSession = Boolean(cookies.sessionid || cookies.sid_tt);
    
    if (!hasSession) {
      throw new Error("登录成功但未获取到 session，请重试");
    }

    // 5) 更新验证状态为成功
    const now = new Date().toISOString();
    await rest("PATCH", `sms_login_states?id=eq.${state.id}`, {
      status: "completed",
      cookies_json: cookies,
      updated_at: now,
    });

    // 6) 创建或更新 douyin_sessions
    const existingSessions = await rest(
      "GET",
      `douyin_sessions?user_id=eq.${uid}&status=eq.active&select=id`,
    ) as any[];
    
    let sessionId = existingSessions?.[0]?.id || "";
    
    if (sessionId) {
      await rest("PATCH", `douyin_sessions?id=eq.${sessionId}`, {
        cookies_json: cookies,
        updated_at: now,
        last_synced_at: now,
      });
    } else {
      const newSession = await rest("POST", "douyin_sessions", {
        user_id: uid,
        douyin_uid: "",
        douyin_sec_uid: "",
        nickname: "",
        avatar_url: "",
        cookies_json: cookies,
        status: "active",
        last_synced_at: now,
      }) as any[];
      sessionId = newSession?.[0]?.id;
    }

    return json({ 
      ok: true, 
      message: "登录成功！",
      sessionId: sessionId,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
