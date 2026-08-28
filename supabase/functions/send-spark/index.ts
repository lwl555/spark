// 一键续火花：给指定好友发送消息
import { CookieJar, sendTextMessage } from "../_shared/protocol.ts";
import { handleOptions, json, rest, uidFromAuth } from "../_shared/db.ts";
import { getSettings } from "../_shared/sync.ts";

Deno.serve(async (req: Request) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const uid = uidFromAuth(req);
    const body = await req.json().catch(() => ({}));
    const sessionId = String(body.session_id || "");
    const friendId = String(body.friend_id || "");
    if (!sessionId || !friendId) return json({ ok: false, error: "缺少参数" }, 400);

    const sessions = await rest(
      "GET",
      `douyin_sessions?id=eq.${sessionId}&user_id=eq.${uid}&select=*`,
    ) as any[];
    const s = sessions?.[0];
    if (!s) return json({ ok: false, error: "会话不存在或无权访问" }, 404);

    const friends = await rest(
      "GET",
      `friends?id=eq.${friendId}&session_id=eq.${sessionId}&user_id=eq.${uid}&select=*`,
    ) as any[];
    const f = friends?.[0];
    if (!f) return json({ ok: false, error: "好友不存在" }, 404);
    if (!f.conversation_id) return json({ ok: false, error: "好友缺少会话 ID，请先刷新" }, 400);

    const jar = new CookieJar(s.cookies_json || {});
    let text = String(body.message || "").trim();
    if (!text) {
      const settings = await getSettings(uid);
      text = settings?.message || "火花要灭了，续一下🔥";
    }

    const r = await sendTextMessage(jar, text, { conversationId: f.conversation_id });
    const now = new Date().toISOString();

    await rest("POST", "send_history", {
      user_id: uid,
      session_id: sessionId,
      friend_id: friendId,
      conversation_id: f.conversation_id,
      message: text,
      trigger_type: "manual",
      status: r.ok ? "success" : "failed",
      detail: r.ok ? "" : r.raw.slice(0, 200),
    });

    if (r.ok) {
      await rest("PATCH", `friends?id=eq.${friendId}`, {
        last_sent_at: now,
        send_count: (Number(f.send_count) || 0) + 1,
        updated_at: now,
      });
    }
    await rest("PATCH", `douyin_sessions?id=eq.${sessionId}`, {
      cookies_json: jar.toJSON(),
      updated_at: now,
    });

    if (!r.ok) {
      return json({ ok: false, error: "发送失败：" + r.raw.slice(0, 120) }, 502);
    }
    return json({ ok: true, friendId, nickname: f.nickname, message: text });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
