// 扫码登录：排队任务（二维码由 GitHub Actions 真浏览器 worker 生成）
// 前端调用流程：login-qr 排队 → worker 生成二维码写入 login_states → login-poll 轮询
import { handleOptions, json, rest, uidFromAuth } from "../_shared/db.ts";

Deno.serve(async (req: Request) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const uid = uidFromAuth(req);
    const now = new Date().toISOString();

    // 1) 已有 2 分钟内的新鲜二维码 → 直接复用（避免重复排队）
    const fresh = await rest(
      "GET",
      `login_states?user_id=eq.${uid}&status=eq.pending&order=created_at.desc&limit=1&select=id,token,qrcode,created_at,updated_at`,
    ) as any[];
    const st = fresh?.[0];
    if (st?.qrcode) {
      const age = Date.now() - new Date(st.updated_at || st.created_at).getTime();
      if (age < 150000) {
        return json({ ok: true, queued: false, token: st.token, qrcodeBase64: st.qrcode });
      }
    }

    // 2) 该用户旧的排队请求全部作废，重新排队
    await rest("PATCH", `login_requests?user_id=eq.${uid}&status=eq.pending`, {
      status: "canceled",
      updated_at: now,
    }).catch(() => {});
    await rest("POST", "login_requests", { user_id: uid, status: "pending" });
    return json({ ok: true, queued: true, message: "已排队，正在启动登录环境（约 1-2 分钟）" });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
