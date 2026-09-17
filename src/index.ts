import { adminMe, json, login, logout, me, signup } from "./auth";
import { bootstrapAdmin, createDatabaseRecord, databaseOverview, deleteDatabaseRecord, forceDeleteRoom, listAdminPenalties, listAdminReports, listAdminRooms, listAdminVisits, listAuditLogs, listDatabaseTable, listUsers, resolveAdminPenalty, updateAccountStatus, updateDatabaseRecord, updateReportStatus } from "./admin";
import { createRoom, deleteRoom, getRoom, joinRoom, listRooms, updateMyParticipation } from "./rooms";
import { closeExpiredRooms, getParticipants, lockOverduePenalties, releasePenalty, reportParticipant, visitParticipant } from "./activity";
import { createReport, myParticipations, myPenalties, weeklyActivity } from "./dashboard";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
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
    if (request.method === "GET" && url.pathname === "/api/me/participations") return myParticipations(request, env);
    if (request.method === "GET" && url.pathname === "/api/me/activity") return weeklyActivity(request, env);
    if (request.method === "GET" && url.pathname === "/api/me/penalties") return myPenalties(request, env);
    if (request.method === "POST" && url.pathname === "/api/reports") return createReport(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/users") return listUsers(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/rooms") return listAdminRooms(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/visits") return listAdminVisits(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/penalties") return listAdminPenalties(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/reports") return listAdminReports(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/audit-logs") return listAuditLogs(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/database/overview") return databaseOverview(request, env);
    if (request.method === "GET" && url.pathname === "/api/rooms") return listRooms(request, env);
    if (request.method === "POST" && url.pathname === "/api/rooms") return createRoom(request, env);

    const accountStatusMatch = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/account-status$/i);
    if (request.method === "PATCH" && accountStatusMatch) return updateAccountStatus(request, env, accountStatusMatch[1]);

    const reportStatusMatch = url.pathname.match(/^\/api\/admin\/reports\/([0-9a-f-]{36})\/status$/i);
    if (request.method === "PATCH" && reportStatusMatch) return updateReportStatus(request, env, reportStatusMatch[1]);

    const adminRoomMatch = url.pathname.match(/^\/api\/admin\/rooms\/([0-9a-f-]{36})$/i);
    if (request.method === "DELETE" && adminRoomMatch) return forceDeleteRoom(request, env, adminRoomMatch[1]);

    const adminPenaltyMatch = url.pathname.match(/^\/api\/admin\/penalties\/([0-9a-f-]{36})\/resolve$/i);
    if (request.method === "POST" && adminPenaltyMatch) return resolveAdminPenalty(request, env, adminPenaltyMatch[1]);

    const databaseTableMatch = url.pathname.match(/^\/api\/admin\/database\/([a-z_]+)$/i);
    if (request.method === "GET" && databaseTableMatch) return listDatabaseTable(request, env, databaseTableMatch[1]);
    if (request.method === "POST" && databaseTableMatch) return createDatabaseRecord(request, env, databaseTableMatch[1]);

    const databaseRecordMatch = url.pathname.match(/^\/api\/admin\/database\/([a-z_]+)\/([0-9a-f-]{36})$/i);
    if (request.method === "PATCH" && databaseRecordMatch) return updateDatabaseRecord(request, env, databaseRecordMatch[1], databaseRecordMatch[2]);
    if (request.method === "DELETE" && databaseRecordMatch) return deleteDatabaseRecord(request, env, databaseRecordMatch[1], databaseRecordMatch[2]);

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})$/i);
    if (roomMatch && request.method === "GET") return getRoom(request, env, roomMatch[1]);
    if (roomMatch && request.method === "DELETE") return deleteRoom(request, env, roomMatch[1]);

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/participants$/i);
    if (joinMatch && request.method === "POST") return joinRoom(request, env, joinMatch[1]);
    if (joinMatch && request.method === "GET") return getParticipants(request, env, joinMatch[1]);
    if (joinMatch && request.method === "PATCH") return updateMyParticipation(request, env, joinMatch[1]);

    const visitMatch = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/visits\/([0-9a-f-]{36})$/i);
    if (visitMatch && request.method === "POST") return visitParticipant(request, env, visitMatch[1], visitMatch[2]);

    const reportMatch = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/participant-reports\/([0-9a-f-]{36})$/i);
    if (reportMatch && request.method === "POST") return reportParticipant(request, env, reportMatch[1], reportMatch[2]);

    const penaltyMatch = url.pathname.match(/^\/api\/penalties\/([0-9a-f-]{36})\/resolve$/i);
    if (penaltyMatch && request.method === "POST") return releasePenalty(request, env, penaltyMatch[1]);

    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, { status: 404 });
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    if (controller.cron === "* * * * *") ctx.waitUntil(closeExpiredRooms(env));
    if (controller.cron === "0 15 * * *") ctx.waitUntil(lockOverduePenalties(env));
  },
} satisfies ExportedHandler<Env>;
