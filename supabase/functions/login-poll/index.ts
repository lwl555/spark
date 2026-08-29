// 轮询登录状态：二维码/扫码结果来自 GitHub Actions worker 写入的 login_states
// 状态机：queued（排队中）→ qr_ready（二维码已生成）→ verify_sms（短信二次验证）→ scanned_ok → bound
import { CookieJar, fetchUserProfiles } from "../_shared/protocol.ts";
import { handleOptions, json, rest, uidFromAuth } from "../_shared/db.ts";

const QUEUE_TIMEOUT_MS = 15 * 60 * 1000; // 排队超过 15 分钟视为启动失败（含短信验证时间）

Deno.serve(async (req: Request) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  try {
    const uid = uidFromAuth(req);

    // 1) 最新一条登录排队请求
    const reqs = await rest(
      "GET",
      `login_requests?user_id=eq.${uid}&order=created_at.desc&limit=1&select=*`,
    ).catch(() => []) as any[];
    const rq = reqs?.[0];

    // 2) 最新一条 worker 生成的二维码（仅 pending 状态算数）
    const qrs = await rest(
      "GET",
      `login_states?user_id=eq.${uid}&status=eq.pending&order=created_at.desc&limit=1&select=*`,
    ).catch(() => []) as any[];
    const qr = qrs?.[0];

    if (qr) {
      return json({ ok: true, status: "qr_ready", token: qr.token, qrcodeBase64: qr.qrcode || "" });
    }

    // 2.5) 短信二次验证：worker 检测到抖音要求短信验证码
    const vs = await rest(
      "GET",
      `login_states?user_id=eq.${uid}&status=eq.verify_sms&order=updated_at.desc&limit=1&select=id,mobile,verify_hint`,
    ).catch(() => []) as any[];
    if (vs?.[0]) {
      return json({ ok: true, status: "verify_sms", stateId: vs[0].id, mobile: vs[0].mobile || "", hint: vs[0].verify_hint || "" });
    }

    // 3) 没有进行中的二维码 → 按排队状态回答
    if (!rq) {
      // 完全没有排队：查是否有历史绑定成功
      const bound = await rest(
        "GET",
        `login_states?user_id=eq.${uid}&status=eq.bound&order=updated_at.desc&limit=1&select=session_id,nickname`,
      ).catch(() => []) as any[];
      if (bound?.[0]) {
        return json({ ok: true, status: "bound", sessionId: bound[0].session_id, nickname: bound[0].nickname || "" });
      }
      return json({ ok: true, status: "none" });
    }

    if (rq.status === "pending" || rq.status === "processing") {
      // 已认领过但二维码迟迟没出（worker 卡死/失败）→ 超时提示
      const created = new Date(rq.created_at).getTime();
      if (Date.now() - created > QUEUE_TIMEOUT_MS) {
        return json({ ok: true, status: "failed", error: "登录环境启动超时，请重新点击绑定" });
      }
      return json({ ok: true, status: "queued" });
    }

    if (rq.status === "done") {
      // worker 已标记完成 → 读取该次任务的二维码记录（scanned_ok 需转会话）
      const doneRows = await rest(
        "GET",
        `login_states?user_id=eq.${uid}&order=created_at.desc&limit=3&select=*`,
      ).catch(() => []) as any[];
      const st = doneRows?.find((x: any) => x.token === rq.token) || doneRows?.[0];
      if (st?.status === "scanned_ok") return await bindFromCookies(uid, st);
      if (st?.status === "bound") return json({ ok: true, status: "bound", sessionId: st.session_id, nickname: st.nickname || "" });
      if (st?.status === "expired") return json({ ok: true, status: "expired" });
      return json({ ok: true, status: "failed", error: "登录未完成，请重新点击绑定" });
    }

    if (rq.status === "failed") {
      return json({ ok: true, status: "failed", error: rq.error || "登录失败，请重新点击绑定" });
    }

    if (rq.status === "canceled") {
      return json({ ok: true, status: "canceled" });
    }

    return json({ ok: true, status: "none" });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 400);
  }
});

// 用 worker 保存的完整 cookies 创建/更新绑定会话
async function bindFromCookies(uid: string, st: any) {
  const jar = new CookieJar(st.cookies_json || {});
  if (!jar.map.sessionid && !jar.map.sid_tt) {
    return json({ ok: true, status: "failed", error: "登录 cookie 无效，请重新绑定" });
  }
  const now = new Date().toISOString();
  let nickname = st.nickname || "";
  let avatar = "";
  if (st.sec_uid) {
    try {
      const prof = await fetchUserProfiles(jar, [st.sec_uid]);
      const p = prof[st.sec_uid];
      if (p) { nickname = p.nickname || nickname; avatar = p.avatarUrl || ""; }
    } catch { /* 资料失败不阻塞 */ }
  }
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
