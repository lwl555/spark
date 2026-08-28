// 生成抖音登录二维码（需登录本网站后调用）
import { CookieJar, freshAnonymousJar, genQrCode } from "../_shared/protocol.ts";
import { handleOptions, json, rest, uidFromAuth } from "../_shared/db.ts";

Deno.serve(async (req: Request) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const uid = uidFromAuth(req);
    const jar: CookieJar = freshAnonymousJar();
    const qr = await genQrCode(jar);
    // 清除该用户旧的 pending 二维码
    try {
      await rest("DELETE", `login_states?user_id=eq.${uid}&status=eq.pending`);
    } catch { /* 无旧记录忽略 */ }
    const row = await rest("POST", "login_states", {
      user_id: uid,
      token: qr.token,
      cookies_json: jar.toJSON(),
      status: "pending",
    }) as any[];
    return json({
      ok: true,
      token: qr.token,
      qrcodeBase64: qr.qrcodeBase64,
      copywriting: qr.copywriting,
      expireSeconds: qr.expireSeconds,
      stateId: row?.[0]?.id || "",
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
