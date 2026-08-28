// 共享：火花数据同步到数据库（refresh-spark 与 daily-run 共用）
import { CookieJar, fetchSparkData, fetchUserProfiles } from "./protocol.ts";
import type { SparkFriend } from "./protocol.ts";
import { rest } from "./db.ts";

export interface SyncResult {
  sessionId: string;
  ownUid: string;
  friends: SparkFriend[];
  upserted: number;
}

export async function syncSparkToDb(
  sessionId: string,
  userId: string,
  jar: CookieJar,
): Promise<SyncResult> {
  const { friends, ownUid } = await fetchSparkData(jar);
  // 标记该会话下所有好友为 inactive，随后对仍在列表中的恢复 active
  await rest(
    "PATCH",
    `friends?session_id=eq.${sessionId}`,
    { is_active: false, updated_at: new Date().toISOString() },
  );
  // 批量取昵称/头像（init 解析已有昵称，若缺失则补一次资料接口）
  const needProf = friends.filter((f) => !f.nickname && f.secUid).map((f) => f.secUid);
  let profiles: Record<string, { nickname: string; avatarUrl: string }> = {};
  if (needProf.length) {
    try {
      const p = await fetchUserProfiles(jar, needProf);
      profiles = Object.fromEntries(
        Object.entries(p).map(([k, v]) => [k, { nickname: v.nickname, avatarUrl: v.avatarUrl }]),
      );
    } catch { /* 资料失败不影响主流程 */ }
  }
  let upserted = 0;
  for (const f of friends) {
    const nickname = f.nickname || profiles[f.secUid]?.nickname || "";
    const avatarUrl = profiles[f.secUid]?.avatarUrl || "";
    const row = {
      user_id: userId,
      session_id: sessionId,
      conversation_id: f.conversationId,
      sec_uid: f.secUid,
      uid: f.uid,
      nickname,
      avatar_url: avatarUrl,
      days: f.days,
      real_days: f.realDays,
      level: f.level,
      state: f.state,
      recover_ddl: f.recoverDdl,
      expire_time: f.expireTime,
      spark_json: f.sparkJson ? safeJson(f.sparkJson) : null,
      is_active: true,
      updated_at: new Date().toISOString(),
    };
    const existing = await rest(
      "GET",
      `friends?session_id=eq.${sessionId}&conversation_id=eq.${encodeURIComponent(f.conversationId)}&select=id`,
    ) as { id: string }[];
    if (existing && existing.length) {
      await rest("PATCH", `friends?id=eq.${existing[0].id}`, row);
    } else {
      await rest("POST", "friends", row);
    }
    upserted++;
  }
  return { sessionId, ownUid, friends, upserted };
}

function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return null; }
}

export async function getSettings(userId: string) {
  try {
    const rows = await rest(
      "GET",
      `user_settings?user_id=eq.${userId}&select=*`,
    ) as any[];
    return rows?.[0] || null;
  } catch {
    return null; // 表未建时静默降级
  }
}


