// 抖音火花协议核心库（Deno Edge Function 用）
// 纯 HTTP 实现：扫码登录 / 火花状态查询 / 文本消息发送
import { generate_a_bogus } from "./a_bogus.js";
import {
  UA, BASE_COOKIES, QR_TEMPLATE_URL, CHECK_TEMPLATE_URL, CHECK_POST,
  SEND_BASE, SEND_STATIC_PARAMS, SEND_POST_DATA_B64, SEND_TEXT_POST_DATA_B64, SEND_STATIC_PARAM_ORDER,
  INIT_BASE, INIT_POST_DATA_B64,
  USER_INFO_BASE, USER_INFO_PARAMS, USER_INFO_PARAM_ORDER,
} from "./templates.ts";

// ---------- Cookie jar ----------
export class CookieJar {
  map: Record<string, string> = {};
  constructor(init?: string | Record<string, string>) {
    if (typeof init === "string") {
      for (const pair of init.split(";")) {
        const i = pair.indexOf("=");
        if (i > 0) this.map[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
    } else if (init) this.map = { ...init };
  }
  str() {
    return Object.entries(this.map).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  toJSON() { return this.map; }
  absorbSetCookie(res: Response) {
    const list = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : [];
    for (const sc of list) {
      const pair = sc.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) this.map[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
}

// ---------- 签名 URL ----------
// 参数串规则：a_bogus 只接受「解码后的参数值」拼串；拼 URL 时再 encode
function signUrl(base: string, params: Record<string, string>, order: string[], skipAB = false) {
  const raw = order.map((k) => `${k}=${decodeURIComponent(params[k] ?? "")}`).join("&");
  const ab = generate_a_bogus(raw, UA);
  const parts = order.map((k) => `${k}=${encodeURIComponent(params[k] ?? "")}`);
  if (!skipAB) parts.push(`a_bogus=${encodeURIComponent(ab)}`);
  return base + "?" + parts.join("&");
}

function queryOf(url: string) {
  const q = new URL(url).searchParams;
  const out: Record<string, string> = {};
  for (const [k, v] of q) out[k] = v;
  return out;
}

// ---------- 1. 生成登录二维码 ----------
export async function genQrCode(jar: CookieJar) {
  const params = queryOf(QR_TEMPLATE_URL);
  delete params.a_bogus;
  params.p_ts = String(Date.now());
  const order = Object.keys(params);
  const url = signUrl("https://login.douyin.com/passport/web/get_qrcode/", params, order);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://www.douyin.com/", Accept: "application/json, text/plain, */*", Cookie: jar.str() },
  });
  jar.absorbSetCookie(res);
  const data = await res.json();
  if (!data?.data || data.data.error_code !== 0) {
    throw new Error("get_qrcode 失败: " + JSON.stringify(data).slice(0, 200));
  }
  return {
    token: data.data.token as string,
    qrcodeBase64: data.data.qrcode as string,
    copywriting: data.data.copywriting as string,
    expireSeconds: 60,
  };
}

// ---------- 2. 轮询扫码状态 ----------
export async function pollQr(jar: CookieJar, token: string) {
  // check 模板 URL 参数保持原样，只替换 post 中的 token
  const params = queryOf(CHECK_TEMPLATE_URL);
  const checkUrl = "https://login.douyin.com/passport/web/check_qrconnect/?" + new URLSearchParams(params).toString();
  const post = CHECK_POST.replace(/token=[^&]+/, `token=${encodeURIComponent(token)}`);
  const res = await fetch(checkUrl, {
    method: "POST",
    headers: {
      "User-Agent": UA, Referer: "https://www.douyin.com/",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: "https://www.douyin.com", Cookie: jar.str(),
    },
    body: post,
  });
  jar.absorbSetCookie(res);
  const j = await res.json().catch(() => null);
  const data = j?.data || {};
  const status: string = data.status || "";
  return {
    status, // new / scanned / confirmed / expired / canceled
    description: data.description || "",
    secUid: data.sec_uid || "",
    errorCode: data.error_code ?? null,
    hasSession: Boolean(jar.map.sessionid || jar.map.sid_tt),
  };
}

// ---------- 3. 文本消息构造（等长原位替换 + 会话重建，2026-08-28 实测通过） ----------
// 原理：f100/f8 长度前缀在模板中固定，修改内容若改变长度会让服务器解析失步。
// 故：内容字段用 pad 字段填充到与模板等长；cid/stime/f6 原位替换（长度不变）；
// 仅会话 key 可能变长（不同好友 uid 位数不同），此时重建 f100/f8 头并保留模板尾部字段。
export function buildTextMessagePacket(text: string, conversationId?: string, clientMessageId?: string, stime?: string): Uint8Array {
  const uuid = clientMessageId || crypto.randomUUID();
  const st = stime || `${Date.now()}.${Math.floor(Math.random() * 1000)}`; // 13+1+3=17 字符，与模板等长
  const tpl = Uint8Array.from(atob(SEND_POST_DATA_B64), (c) => c.charCodeAt(0));
  const vi = (n: number) => {
    const o: number[] = [];
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n);
    return Uint8Array.from(o);
  };
  const enc = (s2: string) => new TextEncoder().encode(s2);
  const parse = (b: Uint8Array, start: number, end: number) => {
    const items: any[] = []; let pos = start;
    while (pos < end) {
      const off = pos; let tag = 0, shift = 0, bb;
      do { bb = b[pos++]; tag |= (bb & 0x7f) << shift; shift += 7; } while (bb & 0x80);
      const it = { field: tag >> 3, wire: tag & 7, off, tagEnd: pos };
      if (it.wire === 0) { let v = 0, s3 = 0, c; do { c = b[pos++]; v |= (c & 0x7f) << s3; s3 += 7; } while (c & 0x80); it.value = v; }
      else if (it.wire === 1) pos += 8;
      else if (it.wire === 2) { let len = 0, s3 = 0, c; do { c = b[pos++]; len |= (c & 0x7f) << s3; s3 += 7; } while (c & 0x80); it.len = len; it.payloadStart = pos; pos += len; }
      else if (it.wire === 5) pos += 4;
      items.push(it);
    }
    return items;
  };
  // 定位 f8 / f100 / body 字段（按模板偏移）
  const root = parse(tpl, 0, tpl.length);
  const f8 = root.find((x: any) => x.field === 8 && x.wire === 2)!;
  const inner = parse(tpl, f8.payloadStart, f8.payloadStart + f8.len);
  const f100 = inner.find((x: any) => x.field === 100 && x.wire === 2)!;
  const bodyItems = parse(tpl, f100.payloadStart, f100.payloadStart + f100.len);
  const f8End = f8.off + (f8.tagEnd - f8.off) + f8.len;

  // 1) 内容：与模板等长（874B），pad 字段填充
  let buf = tpl.slice(0);
  {
    const c = bodyItems.find((x: any) => x.field === 4 && x.wire === 2)!;
    const target = c.len;
    const baseJson = JSON.stringify({ aweType: 700, type: 0, richTextInfos: [], text });
    const baseBytes = enc(baseJson).length; // 字节长度（中文 3 字节/字）
    const padLen = Math.max(0, target - baseBytes - 9); // 固定开销(去掉 baseJson 的 } 后接 ,"pad":" + 收尾 ") 共 9 字节
    const payload = enc(JSON.stringify({ aweType: 700, type: 0, richTextInfos: [], text, pad: " ".repeat(padLen) }));
    const field = concat2([Uint8Array.of(0x22), vi(payload.length), payload]);
    const old = c.off; // 字段整体替换（等长）
    buf.set(field, old);
    if (payload.length !== target) throw new Error("内容填充长度不匹配: " + payload.length + " vs " + target);
  }
  // 2) client_message_id / stime（f5 map 原位等长替换）
  for (const [key, val] of [["s:client_message_id", uuid], ["s:stime", st]] as const) {
    for (const it of bodyItems) {
      if (it.field !== 5 || it.wire !== 2) continue;
      const sub = parse(tpl, it.payloadStart, it.payloadStart + it.len);
      const k = sub.find((x: any) => x.field === 1 && x.wire === 2);
      if (!k) continue;
      const keyStr = new TextDecoder().decode(tpl.subarray(k.payloadStart, k.payloadStart + k.len));
      if (keyStr !== key) continue;
      const v = sub.find((x: any) => x.field === 2 && x.wire === 2)!;
      const nb = enc(val);
      if (nb.length !== v.len) throw new Error(key + " 长度不符: " + nb.length + " vs " + v.len);
      buf.set(nb, v.payloadStart);
      break;
    }
  }
  // 3) f6 消息类型：模板 5 → 7（原位）
  {
    const f6 = bodyItems.find((x: any) => x.field === 6 && x.wire === 0)!;
    buf[f6.tagEnd] = 7; // 值字节（tagEnd 指向 varint 值起点）
  }
  // 4) 会话 key（可能变长）：替换 body 中的 key 后重建 f100/f8 头，尾部沿用模板
  const keyItem = bodyItems.find((x: any) => x.field === 1 && x.wire === 2)!;
  const oldKey = new TextDecoder().decode(tpl.subarray(keyItem.payloadStart, keyItem.payloadStart + keyItem.len));
  const newKey = conversationId && conversationId !== oldKey ? conversationId : oldKey;
  if (newKey !== oldKey) {
    const bodyNew = new Uint8Array(f100.len - keyItem.len + newKey.length);
    bodyNew.set(buf.subarray(f100.payloadStart, keyItem.payloadStart), 0);
    bodyNew.set(enc(newKey), keyItem.payloadStart - f100.payloadStart);
    bodyNew.set(buf.subarray(keyItem.payloadStart + keyItem.len, f100.payloadStart + f100.len), keyItem.payloadStart - f100.payloadStart + newKey.length);
    const newF100 = concat2([Uint8Array.of(0xa2, 0x06), vi(bodyNew.length), bodyNew]);
    const newF8 = concat2([Uint8Array.of(0x42), vi(newF100.length), newF100]);
    const head = buf.subarray(0, f8.off);
    const tail = tpl.subarray(f8End);
    const out = new Uint8Array(head.length + newF8.length + tail.length);
    out.set(head, 0);
    out.set(newF8, head.length);
    out.set(tail, head.length + newF8.length);
    buf = out;
  }
  return buf;
}

function concat2(parts: Uint8Array[]) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---------- 4. 发送消息 ----------
export async function sendTextMessage(
  jar: CookieJar,
  text: string,
  opts: { deviceBlock?: string; identityTokenJson?: string; identityDeviceId?: string; conversationId?: string } = {},
): Promise<{ ok: boolean; raw: string }> {
  const body = buildTextMessagePacket(text, opts.conversationId);
  const params = { ...SEND_STATIC_PARAMS };
  const url = signUrl(SEND_BASE, params, SEND_STATIC_PARAM_ORDER);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Referer: "https://www.douyin.com/chat",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: "https://www.douyin.com",
      Accept: "*/*",
      Cookie: jar.str(),
    },
    body: body as unknown as BodyInit,
  });
  jar.absorbSetCookie(res);
  const raw = new TextDecoder().decode(await res.arrayBuffer());
  const ok = res.status === 200 && !raw.includes("error") && (raw.includes("OK") || /2026\d{10,}/.test(raw));
  return { ok, raw };
}

// ---------- 5. 拉取会话列表与火花状态 ----------
export interface SparkFriend {
  conversationId: string;
  secUid: string;
  uid: string;
  nickname: string;
  days: number;
  realDays: number;
  level: string;
  state: number;
  recoverDdl: number;
  expireTime: number;
  sparkJson?: string;
}
export async function fetchSparkData(jar: CookieJar, ownSecUid = ""): Promise<{ friends: SparkFriend[]; ownUid: string }> {
  const body = Uint8Array.from(atob(INIT_POST_DATA_B64), (c) => c.charCodeAt(0));
  const res = await fetch(INIT_BASE, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Referer: "https://www.douyin.com/",
      // init 必须用 protobuf content-type（表单类型会报 empty token）
      "Content-Type": "application/x-protobuf",
      Origin: "https://www.douyin.com",
      Accept: "application/x-protobuf, */*",
      Cookie: jar.str(),
    },
    body: body as unknown as BodyInit,
  });
  jar.absorbSetCookie(res);
  const bin = new Uint8Array(await res.arrayBuffer());
  const r = parseSparkFriends(bin, ownSecUid);
  return { friends: r.friends, ownUid: r.ownUid };
}

// 从 get_message_by_init 响应二进制中提取火花 JSON 与好友信息
// 结构：响应含多个会话块，每个块 = 会话 key(0:1:uidA:uidB) + 消息 + 扩展(a:consecutive_chat_data=火花 JSON)
// 规则（2026-08-28 逆向确认）：单聊会话 key = 0:1:<较小uid>:<较大uid>；火花 JSON 归属于其前面最近的 key
export function parseSparkFriends(
  bin: Uint8Array,
  ownSecUid = "",
): { friends: SparkFriend[]; ownUid: string } {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bin);
  // 1) 所有会话 key（含偏移）
  const keys: { off: number; a: string; b: string }[] = [];
  const keyRe = /0:1:(\d+):(\d+)/g;
  let km: RegExpExecArray | null;
  while ((km = keyRe.exec(text))) keys.push({ off: km.index, a: km[1], b: km[2] });
  // 2) 所有火花 JSON 块（含偏移）
  const flames: { off: number; json: string; expire: number; info: any }[] = [];
  const sparkRe = /\{\"expire_time\":(\d+),\"can_recover_days\":\d+,\"flame_infos\":(\[.*?\]),\"consecutive_relation_info\":(\{.*?\})[^}]*\}/g;
  let sm: RegExpExecArray | null;
  while ((sm = sparkRe.exec(text)) && flames.length < 50) {
    let infos: any[] = [];
    try { infos = JSON.parse(sm[2]); } catch { /* 跳过损坏块 */ }
    const info = infos.find((i) => i && typeof i.days === "number") || {};
    flames.push({ off: sm.index, json: sm[0], expire: Number(sm[1]), info, infosArr: infos });
  }
  // 3) 用户资料三元组 uid/sec_uid/nickname（消息 JSON 里出现）
  const profiles: Record<string, { uid: string; secUid: string; nickname: string }> = {};
  const uidRe = /"uid":(\d+)/g;
  let um: RegExpExecArray | null;
  while ((um = uidRe.exec(text))) {
    const seg = text.slice(um.index, um.index + 260);
    const sec = seg.match(/"sec_uid":"([^"]+)"/);
    const nick = seg.match(/"nickname":"([^"]+)"/);
    if (sec && nick) profiles[um[1]] = { uid: um[1], secUid: sec[1], nickname: nick[1] };
  }
  // 4) 自己的 uid：参数给 ownSecUid 时从资料表反查；否则取所有 key 的公共组件
  let ownUid = "";
  if (ownSecUid) {
    for (const p of Object.values(profiles)) if (p.secUid === ownSecUid) { ownUid = p.uid; break; }
  }
  if (!ownUid && keys.length >= 2) {
    const c1 = keys.map((k) => k.a).filter((v, i, a) => a.indexOf(v) === i);
    const c2 = keys.map((k) => k.b).filter((v, i, a) => a.indexOf(v) === i);
    const common = c1.filter((v) => c2.includes(v));
    if (common.length === 1) ownUid = common[0];
    else if (c1.length === 1 && keys.every((k) => k.a === c1[0])) ownUid = c1[0];
    else if (c2.length === 1 && keys.every((k) => k.b === c2[0])) ownUid = c2[0];
  }
  // 5) 所有 sec_uid（含偏移）：每个会话条目含 对方/自己 两个 sec_uid
  const secs: { off: number; s: string }[] = [];
  const secRe = /MS4wLjAB[A-Za-z0-9_-]{20,90}/g;
  let secM: RegExpExecArray | null;
  while ((secM = secRe.exec(text))) secs.push({ off: secM.index, s: secM[0] });
  // 6) 配对：每个火花块归属其前最近的 key；peer sec_uid = 该块之前最近且非自己的 sec_uid
  const friends: SparkFriend[] = [];
  const nowTs = Math.floor(Date.now() / 1000);
  for (const f of flames) {
    let owner: { a: string; b: string } | null = null;
    for (const k of keys) if (k.off < f.off) owner = k; else break;
    if (!owner) continue;
    const peerUid = ownUid ? (owner.a === ownUid ? owner.b : owner.a) : "";
    let peerSec = "";
    for (let i = secs.length - 1; i >= 0; i--) {
      if (secs[i].off < f.off && secs[i].s !== ownSecUid) { peerSec = secs[i].s; break; }
    }
    const prof = peerUid ? profiles[peerUid] : undefined;
    // 当前阶段条目：start<=now<end；否则取第一条
    let info = f.info;
    const infos = Array.isArray(f.infosArr) ? f.infosArr : null;
    if (infos?.length) {
      const cur = infos.find((i: any) => i && typeof i.start === "number" && i.start <= nowTs && nowTs < (i.end || 0));
      info = cur || infos.find((i: any) => i && typeof i.recover_ddl === "number") || infos[0] || info;
    }
    friends.push({
      conversationId: "0:1:" + owner.a + ":" + owner.b,
      uid: peerUid,
      secUid: peerSec || prof?.secUid || "",
      nickname: prof?.nickname || "",
      days: info.days ?? 0,
      realDays: info.real_days ?? info.days ?? 0,
      level: info.level ?? "",
      state: info.state ?? 0,
      recoverDdl: info.recover_ddl ?? 0,
      expireTime: f.expire,
      sparkJson: JSON.stringify(info).slice(0, 500),
    });
  }
  return { friends, ownUid };
}

// 好友资料（昵称/头像）：POST /aweme/v1/web/im/user/info/，批量 sec_uid
export async function fetchUserProfiles(
  jar: CookieJar,
  secUids: string[],
): Promise<Record<string, { uid: string; secUid: string; nickname: string; avatarUrl: string }>> {
  const out: Record<string, { uid: string; secUid: string; nickname: string; avatarUrl: string }> = {};
  const uniq = [...new Set(secUids.filter(Boolean))];
  if (!uniq.length) return out;
  const params = { ...USER_INFO_PARAMS };
  const url = signUrl(USER_INFO_BASE, params, USER_INFO_PARAM_ORDER);
  const body = "sec_user_ids=" + encodeURIComponent(JSON.stringify(uniq));
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Referer: "https://www.douyin.com/",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: "https://www.douyin.com",
        Accept: "application/json, text/plain, */*",
        Cookie: jar.str(),
      },
      body,
    });
  } catch {
    return out; // 资料获取失败不影响主流程
  }
  jar.absorbSetCookie(res);
  const j = await res.json().catch(() => null);
  const arr = Array.isArray(j?.data) ? j.data : [];
  for (const it of arr) {
    if (!it?.sec_uid) continue;
    const av = it.avatar_thumb?.url_list?.[0] || it.avatar_small?.url_list?.[0] || "";
    out[it.sec_uid] = { uid: String(it.uid ?? ""), secUid: it.sec_uid, nickname: it.nickname || "", avatarUrl: av };
  }
  return out;
}

// 默认匿名 cookie（未登录时用）
export function freshAnonymousJar(): CookieJar {
  return new CookieJar(BASE_COOKIES);
}








