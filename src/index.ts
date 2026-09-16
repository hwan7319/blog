import { adminMe, json, login, logout, me, signup } from "./auth";
import { bootstrapAdmin, listUsers, updateAccountStatus } from "./admin";
import { createRoom, deleteRoom, getRoom, joinRoom, listRooms } from "./rooms";

export interface Env {
  DB: D1Database;
  BOOTSTRAP_ADMIN_SECRET?: string;
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
    if (request.method === "POST" && url.pathname === "/api/auth/bootstrap-admin") return bootstrapAdmin(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/users") return listUsers(request, env);
    if (request.method === "GET" && url.pathname === "/api/rooms") return listRooms(request, env);
    if (request.method === "POST" && url.pathname === "/api/rooms") return createRoom(request, env);

    const accountStatusMatch = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/account-status$/i);
    if (request.method === "PATCH" && accountStatusMatch) return updateAccountStatus(request, env, accountStatusMatch[1]);

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})$/i);
    if (roomMatch && request.method === "GET") return getRoom(request, env, roomMatch[1]);
    if (roomMatch && request.method === "DELETE") return deleteRoom(request, env, roomMatch[1]);

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/participants$/i);
    if (joinMatch && request.method === "POST") return joinRoom(request, env, joinMatch[1]);

    return json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    // 방 마감과 패널티 처리 구현 전에는 작업을 수행하지 않는다.
    // controller.cron으로 1분 마감 작업과 KST 자정 패널티 만료 작업을 구분할 예정이다.
    ctx.waitUntil(env.DB.prepare("SELECT 1").run());
  },
} satisfies ExportedHandler<Env>;
