import { adminMe, json, login, logout, me, signup } from "./auth";

export interface Env {
  DB: D1Database;
}

async function health(env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return json({ ok: row?.ok === 1, service: "blog-poom" });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return health(env);
    }

    if (request.method === "POST" && url.pathname === "/api/auth/signup") return signup(request, env);
    if (request.method === "POST" && url.pathname === "/api/auth/login") return login(request, env);
    if (request.method === "POST" && url.pathname === "/api/auth/logout") return logout(request, env);
    if (request.method === "GET" && url.pathname === "/api/auth/me") return me(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/me") return adminMe(request, env);

    return json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    // 방 마감과 패널티 처리 구현 전에는 작업을 수행하지 않는다.
    // controller.cron으로 1분 마감 작업과 KST 자정 패널티 만료 작업을 구분할 예정이다.
    ctx.waitUntil(env.DB.prepare("SELECT 1").run());
  },
} satisfies ExportedHandler<Env>;
