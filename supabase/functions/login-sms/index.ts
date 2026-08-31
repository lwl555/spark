// 短信验证码登录：发送验证码
import { CookieJar, freshAnonymousJar } from "../_shared/protocol.ts";
import { handleOptions, json, rest, uidFromAuth } from "../_shared/db.ts";

// 抖音短信验证码 API 端点
const SEND_CODE_URL = "https://login.douyin.com/passport/web/mobile/send_code/";
const VERIFY_CODE_URL = "https://login.douyin.com/passport/web/mobile/verify_code/";

// 抖音 User-Agent
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

Deno.serve(async (req: Request) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const uid = uidFromAuth(req);
    const body = await req.json().catch(() => ({}));
    const phone = String(body.phone || "").trim();
    
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      return json({ ok: false, error: "请输入正确的手机号" }, 400);
    }

    // 1) 创建新的 cookie jar（模拟访问 douyin.com）
    const jar = freshAnonymousJar();
    
    // 2) 调用抖音发送验证码 API
    const params = new URLSearchParams();
    params.append("mobile", phone);
    params.append("type", "37"); // 37 = 登录验证码
    params.append("region", "86"); // 86 = 中国大陆
    params.append("mix_mode", "1");
    params.append("device_platform", "webapp");
    params.append("aid", "6383");
    params.append("version_code", "170400");
    params.append("version_name", "17.4.0");
    
    const res = await fetch(SEND_CODE_URL + "?" + params.toString(), {
      method: "GET",
      headers: {
        "User-Agent": UA,
        "Referer": "https://www.douyin.com/",
        "Accept": "application/json, text/plain, */*",
        "Cookie": jar.str(),
      },
    });
    
    jar.absorbSetCookie(res);
    const data = await res.json();
    
    if (data.error_code !== 0) {
      throw new Error("发送验证码失败: " + (data.error_msg || data.description || JSON.stringify(data).slice(0, 200)));
    }

    // 3) 存储验证状态（等待用户输入验证码）
    const verifyToken = data.data?.verify_token || "";
    const now = new Date().toISOString();
    
    await rest("POST", "sms_login_states", {
      user_id: uid,
      phone: phone,
      verify_token: verifyToken,
      cookies_json: jar.toJSON(),
      status: "pending",
      created_at: now,
      updated_at: now,
    });

    return json({ 
      ok: true, 
      message: "验证码已发送到 " + phone.slice(0, 3) + "****" + phone.slice(7),
      expiresIn: 60, // 验证码有效期60秒
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
