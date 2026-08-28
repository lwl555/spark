// 轮询抖音扫码状态；确认后自动创建绑定会话
import { CookieJar, pollQr, fetchUserProfiles } from "../_shared/protocol.ts";
import { handleOptions, json, rest, uidFromAuth } from "../_shared/db.ts";

Deno.serve(async (req: Request) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const uid = uidFromAuth(req);
    const body = await req.json().catch(() => ({}));
    const token = String(body.token || "");
    if (!token) return json({ ok: false, error: "缺少 token" }, 400);

    const rows = await rest(
      "GET",
      `login_states?user_id=eq.${uid}&token=eq.${encodeURIComponent(token)}&select=*`,
    ) as any[];
    const st = rows?.[0];
    if (!st) return json({ ok: false, error: "二维码不存在或已失效，请重新生成" }, 404);
    if (st.status === "bound") {
      return json({ ok: true, status: "bound", sessionId: st.session_id, nickname: st.nickname });
    }
    if (st.status === "expired" || st.status === "canceled") {
      return json({ ok: true, status: st.status });
    }

    const jar = new CookieJar(st.cookies_json || {});
    const r = await pollQr(jar, token);
    const now = new Date().toISOString();

    if (r.status === "confirmed" && jar.map.sessionid) {
      // 扫码确认：拉取本人资料并创建会话
      let nickname = "";
      let avatar = "";
      let douyinUid = "";
      if (r.secUid) {
        try {
          const prof = await fetchUserProfiles(jar, [r.secUid]);
          const p = prof[r.secUid];
          if (p) { nickname = p.nickname; avatar = p.avatarUrl; douyinUid = p.uid; }
        } catch { /* 资料失败不阻塞 */ }
      }
      const sess = await rest("POST", "douyin_sessions", {
        user_id: uid,
        douyin_uid: douyinUid || "",
        douyin_sec_uid: r.secUid,
        nickname,
        avatar_url: avatar,
        cookies_json: jar.toJSON(),
        status: "active",
        last_synced_at: now,
      }) as any[];
      const sessionId = sess?.[0]?.id;
      await rest("PATCH", `login_states?id=eq.${st.id}`, {
        status: "bound",
        sec_uid: r.secUid,
        session_id: sessionId,
        nickname,
        cookies_json: jar.toJSON(),
        updated_at: now,
      });
      return json({ ok: true, status: "bound", sessionId, nickname, secUid: r.secUid });
    }

    await rest("PATCH", `login_states?id=eq.${st.id}`, {
      status: r.status,
      sec_uid: r.secUid || st.sec_uid || null,
      cookies_json: jar.toJSON(),
      updated_at: now,
    });
    return json({ ok: true, status: r.status, description: r.description || "" });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
