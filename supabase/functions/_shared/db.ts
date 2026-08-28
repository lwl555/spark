// 共享：Supabase 客户端 + 用户身份解析（Deno Edge Functions）
export function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key =
    Deno.env.get("DOUYIN_SERVICE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "";
  if (!url || !key) throw new Error("缺少 SUPABASE_URL / DOUYIN_SERVICE_KEY 环境变量");
  return { url, key };
}

// 从 Authorization Bearer JWT 中取用户 id
export function uidFromAuth(req: Request): string {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("未登录");
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (!payload.sub) throw new Error("JWT 缺少 sub");
    return payload.sub;
  } catch {
    throw new Error("登录态无效");
  }
}

// JSON 响应
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  }
  return null;
}

// 简易 REST 请求（service role 直连 PostgREST）
export async function rest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) {
  const { url, key } = serviceClient();
  const res = await fetch(url + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error("DB " + method + " " + path + " -> " + res.status + ": " + String(data).slice(0, 300));
  return data;
}
