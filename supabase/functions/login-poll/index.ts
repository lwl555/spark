// 轮询登录状态：二维码/扫码结果来自 GitHub Actions worker 写入的 login_states
// scanned_ok → 用完整 cookies 创建/更新 douyin_sessions → bound
import { CookieJar, fetchUserProfiles } from "../_shared/protocol.ts";
import { handleOptions, json, rest, uidFromAuth } from "../_shared/db.ts";

Deno.serve(async (req: Request) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const uid = uidFromAuth(req);

    // 1) 最新一条 login_states（worker 写入）
    const rows = await rest(
      "GET",
      `login_states?user_id=eq.${uid}&order=created_at.desc&limit=1&select=*`,
    ) as any[];
    const st = rows?.[0];

    if (st) {
      if (st.status === "pending") {
        return json({ ok: true, status: "qr_ready", token: st.token, qrcodeBase64: st.qrcode || "" });
      }
      if (st.status === "scanned_ok") {
        const jar = new CookieJar(st.cookies_json || {});
        if (!jar.map.sessionid && !jar.map.sid_tt) {
          return json({ ok: true, status: "failed", error: "登录 cookie 无效，请重新绑定" });
        }
        const now = new Date().toISOString();
        let nickname = st.nickname || "";
        let avatar = "";
        // 有 sec_uid 时尽量补昵称/头像
        if (st.sec_uid) {
          try {
            const prof = await fetchUserProfiles(jar, [st.sec_uid]);
            const p = prof[st.sec_uid];
            if (p) { nickname = p.nickname || nickname; avatar = p.avatarUrl || ""; }
          } catch { /* 资料失败不阻塞 */ }
        }
        // 已有活动会话 → 更新 cookie（支持换号重绑）；否则新建
        const dup = await rest(
          "GET",
          `douyin_sessions?user_id=eq.${uid}&status=eq.active&select=id`,
        ).catch(() => []) as any[];
        let sessionId = dup?.[0]?.id || "";
        if (sessionId) {
          await rest("PATCH", `douyin_sessions?id=eq.${sessionId}`, {
            cookies_json: jar.toJSON(),
            nickname,
            avatar_url: avatar,
            douyin_sec_uid: st.sec_uid || "",
            updated_at: now,
            last_synced_at: now,
          });
        } else {
          const sess = await rest("POST", "douyin_sessions", {
            user_id: uid,
            douyin_uid: "",
            douyin_sec_uid: st.sec_uid || "",
            nickname,
            avatar_url: avatar,
            cookies_json: jar.toJSON(),
            status: "active",
            last_synced_at: now,
          }) as any[];
          sessionId = sess?.[0]?.id;
        }
        await rest("PATCH", `login_states?id=eq.${st.id}`, {
          status: "bound",
          session_id: sessionId,
          nickname,
          updated_at: now,
        });
        return json({ ok: true, status: "bound", sessionId, nickname });
      }
      if (st.status === "bound") {
        return json({ ok: true, status: "bound", sessionId: st.session_id, nickname: st.nickname || "" });
      }
      if (st.status === "expired") return json({ ok: true, status: "expired" });
      if (st.status === "failed") return json({ ok: true, status: "failed", error: st.error || "登录失败，请重新绑定" });
    }

    // 2) 还没有 login_states → 看排队进度
    const reqs = await rest(
      "GET",
      `login_requests?user_id=eq.${uid}&order=created_at.desc&limit=1&select=status,error`,
    ).catch(() => []) as any[];
    const rq = reqs?.[0];
    if (!rq) return json({ ok: true, status: "none" });
    if (rq.status === "pending" || rq.status === "processing") return json({ ok: true, status: "queued" });
    if (rq.status === "failed") return json({ ok: true, status: "failed", error: rq.error || "登录失败，请重新尝试" });
    if (rq.status === "canceled") return json({ ok: true, status: "canceled" });
    return json({ ok: true, status: "none" });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});
