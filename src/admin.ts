import type { Env } from "./index";
import { error, json, PublicUser, requestBody, requireAdmin, stringValue } from "./auth";

type UserListRow = {
  id: string;
  nickname: string;
  blog_url: string;
  blog_name: string;
  account_status: string;
  approved_at: number | null;
  created_at: number;
};

const ALLOWED_ACCOUNT_STATUSES = new Set(["approved", "rejected", "locked"]);
const ALLOWED_REPORT_STATUSES = new Set(["resolved", "dismissed"]);

function isResponse(value: PublicUser | Response): value is Response {
  return value instanceof Response;
}

function toPublicUser(row: UserListRow, roles: string[] = []): PublicUser {
  return {
    id: row.id,
    nickname: row.nickname,
    blogUrl: row.blog_url,
    blogName: row.blog_name,
    accountStatus: row.account_status,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    roles,
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

async function audit(env: Env, actorId: string, eventType: string, targetId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), actorId, eventType, "user", targetId, JSON.stringify(metadata), Date.now()).run();
}

function listLimit(request: Request): number {
  const requested = Number(new URL(request.url).searchParams.get("limit") ?? 100);
  return Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 300) : 100;
}

export async function bootstrapAdmin(request: Request, env: Env): Promise<Response> {
  const configuredSecret = env.BOOTSTRAP_ADMIN_SECRET;
  const suppliedSecret = request.headers.get("X-Bootstrap-Admin-Secret") ?? "";
  if (!configuredSecret || !constantTimeEqual(suppliedSecret, configuredSecret)) return error("not_found", 404);

  const body = await requestBody(request);
  if (!body) return error("invalid_json", 400);
  const nickname = stringValue(body, "nickname");
  if (!nickname) return error("nickname_required", 400);

  const roleCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM user_roles WHERE role = 'admin'").first<{ count: number }>();
  if ((roleCount?.count ?? 0) > 0) return error("bootstrap_already_completed", 409);

  const user = await env.DB.prepare(
    "SELECT id, nickname, blog_url, blog_name, account_status, approved_at, created_at FROM users WHERE nickname = ? COLLATE NOCASE",
  ).bind(nickname).first<UserListRow>();
  if (!user) return error("user_not_found", 404);

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET account_status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?").bind(now, now, user.id),
    env.DB.prepare("INSERT INTO user_roles (user_id, role, granted_at) VALUES (?, 'admin', ?)").bind(user.id, now),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), user.id, "admin_bootstrapped", "user", user.id, "{}", now),
  ]);
  return json({ user: toPublicUser({ ...user, account_status: "approved", approved_at: now }, ["admin"]) });
}

export async function listUsers(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const status = new URL(request.url).searchParams.get("status");
  if (status && !["pending", "approved", "rejected", "locked"].includes(status)) return error("invalid_account_status", 400);

  const statement = status
    ? env.DB.prepare("SELECT id, nickname, blog_url, blog_name, account_status, approved_at, created_at FROM users WHERE account_status = ? ORDER BY created_at DESC LIMIT 100").bind(status)
    : env.DB.prepare("SELECT id, nickname, blog_url, blog_name, account_status, approved_at, created_at FROM users ORDER BY created_at DESC LIMIT 100");
  const result = await statement.all<UserListRow>();
  return json({ users: (result.results ?? []).map((row) => toPublicUser(row)) });
}

export async function updateAccountStatus(request: Request, env: Env, userId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const body = await requestBody(request);
  if (!body) return error("invalid_json", 400);
  const accountStatus = stringValue(body, "accountStatus");
  if (!ALLOWED_ACCOUNT_STATUSES.has(accountStatus)) return error("invalid_account_status", 400);
  if (userId === admin.id && accountStatus !== "approved") return error("cannot_change_own_admin_status", 409);

  const user = await env.DB.prepare(
    "SELECT id, nickname, blog_url, blog_name, account_status, approved_at, created_at FROM users WHERE id = ?",
  ).bind(userId).first<UserListRow>();
  if (!user) return error("user_not_found", 404);

  const now = Date.now();
  const approvedAt = accountStatus === "approved" ? (user.approved_at ?? now) : user.approved_at;
  await env.DB.prepare("UPDATE users SET account_status = ?, approved_at = ?, updated_at = ? WHERE id = ?")
    .bind(accountStatus, approvedAt, now, userId).run();
  await audit(env, admin.id, "account_status_changed", userId, { from: user.account_status, to: accountStatus });
  return json({ user: toPublicUser({ ...user, account_status: accountStatus, approved_at: approvedAt }) });
}

export async function listAdminRooms(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const result = await env.DB.prepare(
    `SELECT r.id, r.name, r.room_type, r.capacity, r.join_starts_at, r.join_ends_at, r.closes_at, r.room_status,
            u.nickname AS creator_nickname, COUNT(p.id) AS participant_count
     FROM rooms r JOIN users u ON u.id = r.creator_id
     LEFT JOIN room_participants p ON p.room_id = r.id
     GROUP BY r.id ORDER BY r.created_at DESC LIMIT ?`,
  ).bind(listLimit(request)).all();
  return json({ rooms: result.results ?? [] });
}

export async function listAdminVisits(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const result = await env.DB.prepare(
    `SELECT v.id, v.room_id, r.name AS room_name, visitor.nickname AS visitor_nickname,
            target.nickname AS target_nickname, v.visited_at
     FROM visits v JOIN rooms r ON r.id = v.room_id
     JOIN users visitor ON visitor.id = v.visitor_id JOIN users target ON target.id = v.target_id
     ORDER BY v.visited_at DESC LIMIT ?`,
  ).bind(listLimit(request)).all();
  return json({ visits: result.results ?? [] });
}

export async function listAdminPenalties(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const result = await env.DB.prepare(
    `SELECT p.id, p.room_id, r.name AS room_name, u.id AS user_id, u.nickname, p.reason, p.status,
            p.issued_at, p.resolved_at, p.locked_at
     FROM penalties p JOIN rooms r ON r.id = p.room_id JOIN users u ON u.id = p.user_id
     ORDER BY p.issued_at DESC LIMIT ?`,
  ).bind(listLimit(request)).all();
  return json({ penalties: result.results ?? [] });
}

export async function listAdminReports(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const result = await env.DB.prepare(
    `SELECT report.id, report.room_id, room.name AS room_name, reporter.nickname AS reporter_nickname,
            target.nickname AS target_nickname, report.reason, report.report_status, report.created_at,
            report.resolved_at, resolver.nickname AS resolved_by_nickname
     FROM reports report JOIN users reporter ON reporter.id = report.reporter_id
     JOIN users target ON target.id = report.target_id LEFT JOIN rooms room ON room.id = report.room_id
     LEFT JOIN users resolver ON resolver.id = report.resolved_by
     ORDER BY report.created_at DESC LIMIT ?`,
  ).bind(listLimit(request)).all();
  return json({ reports: result.results ?? [] });
}

export async function listAuditLogs(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const result = await env.DB.prepare(
    `SELECT log.id, actor.nickname AS actor_nickname, log.event_type, log.target_type, log.target_id,
            log.metadata_json, log.created_at
     FROM audit_logs log LEFT JOIN users actor ON actor.id = log.actor_id
     ORDER BY log.created_at DESC LIMIT ?`,
  ).bind(listLimit(request)).all();
  return json({ logs: result.results ?? [] });
}

export async function updateReportStatus(request: Request, env: Env, reportId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const body = await requestBody(request);
  if (!body) return error("invalid_json", 400);
  const reportStatus = stringValue(body, "reportStatus");
  if (!ALLOWED_REPORT_STATUSES.has(reportStatus)) return error("invalid_report_status", 400);
  const report = await env.DB.prepare("SELECT id, report_status FROM reports WHERE id = ?").bind(reportId)
    .first<{ id: string; report_status: string }>();
  if (!report) return error("report_not_found", 404);
  if (report.report_status !== "pending") return error("report_already_handled", 409);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE reports SET report_status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?")
      .bind(reportStatus, now, admin.id, reportId),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), admin.id, "report_status_changed", "report", reportId, JSON.stringify({ from: report.report_status, to: reportStatus }), now),
  ]);
  return json({ id: reportId, reportStatus, resolvedAt: now, resolvedBy: admin.id });
}
