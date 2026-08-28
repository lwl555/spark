// 手动/进入页面时刷新火花状态
import { CookieJar } from "../_shared/protocol.ts";
import { handleOptions, json, rest, uidFromAuth } from "../_shared/db.ts";
import { syncSparkToDb } from "../_shared/sync.ts";

Deno.serve(async (req: Request) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const uid = uidFromAuth(req);
    const body = await req.json().catch(() => ({}));
    const sessionId = String(body.session_id || "");
    if (!sessionId) return json({ ok: false, error: "缺少 session_id" }, 400);

    const sessions = await rest(
      "GET",
      `douyin_sessions?id=eq.${sessionId}&user_id=eq.${uid}&select=*`,
    ) as any[];
    const s = sessions?.[0];
    if (!s) return json({ ok: false, error: "会话不存在或无权访问" }, 404);
    if (s.status !== "active") return json({ ok: false, error: "会话已失效，请重新绑定" }, 400);

    const jar = new CookieJar(s.cookies_json || {});
    const result = await syncSparkToDb(sessionId, uid, jar);

    await rest("PATCH", `douyin_sessions?id=eq.${sessionId}`, {
      last_synced_at: new Date().toISOString(),
      cookies_json: jar.toJSON(),
      updated_at: new Date().toISOString(),
    });
    return json({ ok: true, sessionId, ownUid: result.ownUid, friends: result.friends });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
