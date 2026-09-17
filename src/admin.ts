import type { Env } from "./index";
import { error, json, passwordHash, PublicUser, requestBody, requireAdmin, stringValue } from "./auth";

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
const DATABASE_TABLES = ["users", "rooms", "participants", "visits", "penalties", "reports", "audit_logs"] as const;
type DatabaseTable = typeof DATABASE_TABLES[number];
type DatabaseDefinition = { source: string; columns: readonly string[]; required: readonly string[]; defaults: () => Record<string, unknown> };
const DATABASE_DEFINITIONS: Record<DatabaseTable, DatabaseDefinition> = {
  users: { source: "users", columns: ["nickname", "password_hash", "blog_url", "blog_name", "account_status", "approved_at", "created_at", "updated_at"], required: ["nickname", "password", "blog_url", "blog_name"], defaults: () => ({ created_at: Date.now(), updated_at: Date.now(), account_status: "pending" }) },
  rooms: { source: "rooms", columns: ["name", "room_type", "creator_id", "capacity", "join_starts_at", "join_ends_at", "closes_at", "missions_json", "room_status", "closed_at", "deleted_at", "created_at"], required: ["name", "room_type", "creator_id", "capacity", "join_starts_at", "join_ends_at", "closes_at", "missions_json"], defaults: () => ({ created_at: Date.now(), room_status: "waiting" }) },
  participants: { source: "room_participants", columns: ["room_id", "user_id", "keyword", "link_url", "joined_at", "completed_at"], required: ["room_id", "user_id"], defaults: () => ({ joined_at: Date.now() }) },
  visits: { source: "visits", columns: ["room_id", "visitor_id", "target_id", "visited_at"], required: ["room_id", "visitor_id", "target_id"], defaults: () => ({ visited_at: Date.now() }) },
  penalties: { source: "penalties", columns: ["user_id", "room_id", "reason", "status", "issued_at", "resolved_at", "locked_at"], required: ["user_id", "room_id", "reason"], defaults: () => ({ issued_at: Date.now(), status: "unresolved" }) },
  reports: { source: "reports", columns: ["reporter_id", "target_id", "room_id", "reason", "report_status", "created_at", "resolved_at", "resolved_by"], required: ["reporter_id", "target_id", "reason"], defaults: () => ({ created_at: Date.now(), report_status: "pending" }) },
  audit_logs: { source: "audit_logs", columns: ["actor_id", "event_type", "target_type", "target_id", "metadata_json", "created_at"], required: ["event_type"], defaults: () => ({ metadata_json: "{}", created_at: Date.now() }) },
};

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

  const select = `SELECT u.id, u.nickname, u.blog_url, u.blog_name, u.account_status, u.approved_at, u.created_at,
    (SELECT COUNT(*) FROM room_participants p WHERE p.user_id = u.id) AS participation_count,
    CASE WHEN EXISTS(SELECT 1 FROM penalties p WHERE p.user_id = u.id AND p.status = 'unresolved') THEN '패널티' ELSE '정상' END AS penalty_status
    FROM users u`;
  const statement = status
    ? env.DB.prepare(`${select} WHERE u.account_status = ? ORDER BY u.created_at DESC LIMIT 100`).bind(status)
    : env.DB.prepare(`${select} ORDER BY u.created_at DESC LIMIT 100`);
  const result = await statement.all<UserListRow & { participation_count: number; penalty_status: string }>();
  return json({ users: (result.results ?? []).map((row) => ({ ...toPublicUser(row), participationCount: row.participation_count, penaltyStatus: row.penalty_status })) });
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
            r.missions_json, u.nickname AS creator_nickname, COUNT(p.id) AS participant_count
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

export async function forceDeleteRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const room = await env.DB.prepare("SELECT id, room_status FROM rooms WHERE id = ?").bind(roomId).first<{ id: string; room_status: string }>();
  if (!room) return error("room_not_found", 404);
  if (room.room_status === "deleted") return error("room_already_deleted", 409);
  const now = Date.now();
  await env.DB.prepare("UPDATE rooms SET room_status = 'deleted', deleted_at = ? WHERE id = ?").bind(now, roomId).run();
  await audit(env, admin.id, "room_force_deleted", roomId, { from: room.room_status });
  return json({ id: roomId, deleted: true, deletedAt: now });
}

export async function resolveAdminPenalty(request: Request, env: Env, penaltyId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const penalty = await env.DB.prepare("SELECT id, status FROM penalties WHERE id = ?").bind(penaltyId).first<{ id: string; status: string }>();
  if (!penalty) return error("penalty_not_found", 404);
  if (penalty.status === "resolved") return error("penalty_already_resolved", 409);
  const now = Date.now();
  await env.DB.prepare("UPDATE penalties SET status = 'resolved', resolved_at = ? WHERE id = ?").bind(now, penaltyId).run();
  await audit(env, admin.id, "penalty_resolved_by_admin", penaltyId, { from: penalty.status });
  return json({ id: penaltyId, status: "resolved", resolvedAt: now });
}

export async function databaseOverview(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const sourceTables: Record<DatabaseTable, string> = {
    users: "users", rooms: "rooms", participants: "room_participants", visits: "visits",
    penalties: "penalties", reports: "reports", audit_logs: "audit_logs",
  };
  const counts = await Promise.all(DATABASE_TABLES.map(async (name) => {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${sourceTables[name]}`).first<{ count: number }>();
    return { name, count: row?.count ?? 0 };
  }));
  return json({ tables: counts });
}

export async function listDatabaseTable(request: Request, env: Env, table: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  if (!DATABASE_TABLES.includes(table as DatabaseTable)) return error("database_table_not_found", 404);
  const limit = listLimit(request);
  const statements: Record<DatabaseTable, string> = {
    users: "SELECT id, legacy_user_id, nickname, blog_url, blog_name, account_status, approved_at, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT ?",
    rooms: "SELECT id, legacy_room_id, name, room_type, creator_id, capacity, join_starts_at, join_ends_at, closes_at, room_status, closed_at, created_at FROM rooms ORDER BY created_at DESC LIMIT ?",
    participants: "SELECT id, legacy_participant_id, room_id, user_id, keyword, link_url, joined_at, completed_at FROM room_participants ORDER BY joined_at DESC LIMIT ?",
    visits: "SELECT id, legacy_visit_id, room_id, visitor_id, target_id, visited_at FROM visits ORDER BY visited_at DESC LIMIT ?",
    penalties: "SELECT id, legacy_penalty_id, user_id, room_id, reason, status, issued_at, resolved_at, locked_at FROM penalties ORDER BY issued_at DESC LIMIT ?",
    reports: "SELECT id, legacy_report_id, reporter_id, target_id, room_id, reason, report_status, created_at, resolved_at, resolved_by FROM reports ORDER BY created_at DESC LIMIT ?",
    audit_logs: "SELECT id, legacy_log_id, actor_id, event_type, target_type, target_id, metadata_json, created_at FROM audit_logs ORDER BY created_at DESC LIMIT ?",
  };
  const rows = await env.DB.prepare(statements[table as DatabaseTable]).bind(limit).all<Record<string, unknown>>();
  return json({ table, rows: rows.results ?? [] });
}

function databaseDefinition(table: string): DatabaseDefinition | null {
  return DATABASE_TABLES.includes(table as DatabaseTable) ? DATABASE_DEFINITIONS[table as DatabaseTable] : null;
}

async function databaseValues(table: DatabaseTable, input: Record<string, unknown>, creating: boolean): Promise<Record<string, unknown> | Response> {
  const definition = DATABASE_DEFINITIONS[table];
  if (creating && definition.required.some((name) => input[name] === undefined || input[name] === null || input[name] === "")) {
    return error("database_required_field_missing", 400);
  }
  const values: Record<string, unknown> = {};
  for (const column of definition.columns) if (input[column] !== undefined) values[column] = input[column];
  if (table === "users") {
    const password = input.password;
    if (creating && (typeof password !== "string" || password.length < 4)) return error("invalid_user_password", 400);
    if (typeof password === "string") values.password_hash = await passwordHash(password);
    if (values.account_status === "approved" && values.approved_at === undefined) values.approved_at = Date.now();
    values.updated_at = Date.now();
  }
  if (creating) Object.entries(definition.defaults()).forEach(([key, value]) => { if (values[key] === undefined) values[key] = value; });
  return values;
}

function isResponseValue(value: Record<string, unknown> | Response): value is Response { return value instanceof Response; }

export async function createDatabaseRecord(request: Request, env: Env, table: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const definition = databaseDefinition(table);
  if (!definition) return error("database_table_not_found", 404);
  const body = await requestBody(request);
  const input = body?.values;
  if (!input || typeof input !== "object" || Array.isArray(input)) return error("database_values_required", 400);
  const inputValues = input as Record<string, unknown>;
  const values = await databaseValues(table as DatabaseTable, inputValues, true);
  if (isResponseValue(values)) return values;
  const id = typeof inputValues.id === "string" && inputValues.id ? inputValues.id : crypto.randomUUID();
  const columns = ["id", ...Object.keys(values)];
  try {
    await env.DB.prepare(`INSERT INTO ${definition.source} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .bind(id, ...Object.values(values)).run();
  } catch (cause) {
    if (cause instanceof Error && /constraint failed/i.test(cause.message)) return error("database_constraint_violation", 409);
    throw cause;
  }
  await audit(env, admin.id, "database_record_created", id, { table });
  return json({ id, table, values }, { status: 201 });
}

export async function updateDatabaseRecord(request: Request, env: Env, table: string, id: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const definition = databaseDefinition(table);
  if (!definition) return error("database_table_not_found", 404);
  const body = await requestBody(request);
  const input = body?.values;
  if (!input || typeof input !== "object" || Array.isArray(input)) return error("database_values_required", 400);
  const values = await databaseValues(table as DatabaseTable, input as Record<string, unknown>, false);
  if (isResponseValue(values)) return values;
  if (Object.keys(values).length === 0) return error("database_values_required", 400);
  try {
    const result = await env.DB.prepare(`UPDATE ${definition.source} SET ${Object.keys(values).map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
      .bind(...Object.values(values), id).run();
    if ((result.meta.changes ?? 0) === 0) return error("database_record_not_found", 404);
  } catch (cause) {
    if (cause instanceof Error && /constraint failed/i.test(cause.message)) return error("database_constraint_violation", 409);
    throw cause;
  }
  await audit(env, admin.id, "database_record_updated", id, { table });
  return json({ id, table, values });
}

export async function deleteDatabaseRecord(request: Request, env: Env, table: string, id: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (isResponse(admin)) return admin;
  const definition = databaseDefinition(table);
  if (!definition) return error("database_table_not_found", 404);
  if (table === "users" && id === admin.id) return error("cannot_delete_own_admin", 409);
  try {
    const result = await env.DB.prepare(`DELETE FROM ${definition.source} WHERE id = ?`).bind(id).run();
    if ((result.meta.changes ?? 0) === 0) return error("database_record_not_found", 404);
  } catch (cause) {
    if (cause instanceof Error && /constraint failed/i.test(cause.message)) return error("database_constraint_violation", 409);
    throw cause;
  }
  await audit(env, admin.id, "database_record_deleted", id, { table });
  return json({ id, table, deleted: true });
}
