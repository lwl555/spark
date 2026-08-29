// 每日自动任务：刷新所有会话火花，并给即将熄灭的好友自动续火花
// 触发方式：GitHub Actions 定时 / 用户打开网页时调用（幂等，有 24h 冷却）
import { CookieJar, fetchSparkData, sendTextMessage } from "../_shared/protocol.ts";
import { handleOptions, json, rest } from "../_shared/db.ts";
import { syncSparkToDb, getSettings } from "../_shared/sync.ts";

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 同一好友 24h 内最多自动发一次

Deno.serve(async (req: Request) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const sessions = await rest(
      "GET",
      "douyin_sessions?status=eq.active&select=*",
    ) as any[];
    if (!sessions?.length) return json({ ok: true, refreshed: 0, sent: 0, failed: 0, skipped: 0 });

    let refreshed = 0, sent = 0, failed = 0, skipped = 0;
    const errors: string[] = [];

    for (const s of sessions) {
      try {
        const jar = new CookieJar(s.cookies_json || {});
        // 1) 刷新火花并同步到库
        const result = await syncSparkToDb(s.id, s.user_id, jar);
        refreshed++;

        // 2) 自动续火花
        const settings = await getSettings(s.user_id);
        const autoSend = settings ? settings.auto_send !== false : true;
        const warnDdl = settings ? Number(settings.warn_ddl) || 3 : 3;
        const msg = settings?.message || "火花要灭了，续一下🔥";
        const now = Date.now();

        if (autoSend) {
          for (const f of result.friends) {
            const ddl = Number(f.recoverDdl) || 0;
            if (!ddl || ddl > warnDdl) continue; // 还不需要续
            // 24h 冷却检查：查该会话最近自动发送记录
            const hist = await rest(
              "GET",
              `send_history?session_id=eq.${s.id}&conversation_id=eq.${encodeURIComponent(f.conversationId)}&trigger_type=eq.auto&status=eq.success&order=created_at.desc&limit=1&select=created_at`,
            ).catch(() => []) as any[];
            if (hist?.length) {
              const last = new Date(hist[0].created_at).getTime();
              if (now - last < COOLDOWN_MS) { skipped++; continue; }
            }
            const r = await sendTextMessage(jar, msg, { conversationId: f.conversationId });
            if (r.ok) {
              sent++;
              const friendRows = await rest(
                "GET",
                `friends?session_id=eq.${s.id}&conversation_id=eq.${encodeURIComponent(f.conversationId)}&select=id,send_count`,
              ).catch(() => []) as any[];
              const fid = friendRows?.[0]?.id;
              await rest("POST", "send_history", {
                user_id: s.user_id,
                session_id: s.id,
                friend_id: fid || null,
                conversation_id: f.conversationId,
                message: msg,
                trigger_type: "auto",
                status: "success",
              });
              if (fid) {
                await rest("PATCH", `friends?id=eq.${fid}`, {
                  last_sent_at: new Date(now).toISOString(),
                  send_count: (Number(friendRows[0].send_count) || 0) + 1,
                  updated_at: new Date(now).toISOString(),
                });
              }
              await sleep(5000); // 防限流
            } else {
              failed++;
              await rest("POST", "send_history", {
                user_id: s.user_id,
                session_id: s.id,
                conversation_id: f.conversationId,
                message: msg,
                trigger_type: "auto",
                status: "failed",
                detail: r.raw.slice(0, 200),
              }).catch(() => {});
            }
          }
        }
        await rest("PATCH", `douyin_sessions?id=eq.${s.id}`, {
          last_synced_at: new Date().toISOString(),
          cookies_json: jar.toJSON(),
          updated_at: new Date().toISOString(),
        }).catch(() => {});
      } catch (e) {
        failed++;
        errors.push(s.id + ": " + String((e as Error).message || e).slice(0, 120));
      }
    }

    return json({ ok: true, refreshed, sent, failed, skipped, errors: errors.slice(0, 5) });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}


