import { adminMe, json, login, logout, me, signup } from "./auth";
import { bootstrapAdmin, listUsers, updateAccountStatus } from "./admin";
import { createRoom, deleteRoom, getRoom, joinRoom, listRooms } from "./rooms";
import { closeExpiredRooms, getParticipants, lockOverduePenalties, releasePenalty, reportParticipant, visitParticipant } from "./activity";

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
    if (joinMatch && request.method === "GET") return getParticipants(request, env, joinMatch[1]);

    const visitMatch = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/visits\/([0-9a-f-]{36})$/i);
    if (visitMatch && request.method === "POST") return visitParticipant(request, env, visitMatch[1], visitMatch[2]);

    const reportMatch = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/participant-reports\/([0-9a-f-]{36})$/i);
    if (reportMatch && request.method === "POST") return reportParticipant(request, env, reportMatch[1], reportMatch[2]);

    const penaltyMatch = url.pathname.match(/^\/api\/penalties\/([0-9a-f-]{36})\/resolve$/i);
    if (penaltyMatch && request.method === "POST") return releasePenalty(request, env, penaltyMatch[1]);

    return json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    if (controller.cron === "* * * * *") ctx.waitUntil(closeExpiredRooms(env));
    if (controller.cron === "0 15 * * *") ctx.waitUntil(lockOverduePenalties(env));
  },
} satisfies ExportedHandler<Env>;
