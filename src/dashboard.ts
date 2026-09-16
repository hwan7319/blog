import type { Env } from "./index";
import { error, json, PublicUser, requestBody, requireUser, stringValue } from "./auth";

function isResponse(value: PublicUser | Response): value is Response {
  return value instanceof Response;
}

function status(joinEndsAt: number, closesAt: number, stored: string): string {
  if (stored === "deleted") return "deleted";
  const now = Date.now();
  if (now < joinEndsAt) return "waiting";
  if (now < closesAt) return "in_progress";
  return "closed";
}

function serviceDayKey(timestamp: number): string {
  const date = new Date(timestamp - 4 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function serviceDayStart(now = Date.now()): number {
  const key = serviceDayKey(now);
  return Date.parse(`${key}T04:00:00+09:00`);
}

export async function myParticipations(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  const rows = await env.DB.prepare(
    `SELECT p.id, p.room_id, p.keyword, p.link_url, p.joined_at, p.completed_at,
            r.name, r.room_type, r.join_ends_at, r.closes_at, r.room_status
     FROM room_participants p JOIN rooms r ON r.id = p.room_id
     WHERE p.user_id = ? ORDER BY p.joined_at DESC`,
  ).bind(user.id).all<{
    id: string; room_id: string; keyword: string | null; link_url: string | null; joined_at: number; completed_at: number | null;
    name: string; room_type: string; join_ends_at: number; closes_at: number; room_status: string;
  }>();
  return json({ participations: (rows.results ?? []).map((row) => ({
    id: row.id, roomId: row.room_id, roomName: row.name, roomType: row.room_type,
    value: row.keyword ?? row.link_url, joinedAt: row.joined_at, completedAt: row.completed_at,
    status: status(row.join_ends_at, row.closes_at, row.room_status),
  })) });
}

export async function weeklyActivity(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  const currentStart = serviceDayStart();
  const firstStart = currentStart - 6 * 24 * 60 * 60 * 1000;
  const rows = await env.DB.prepare(
    "SELECT joined_at FROM room_participants WHERE user_id = ? AND joined_at >= ? ORDER BY joined_at DESC",
  ).bind(user.id, firstStart).all<{ joined_at: number }>();
  const days: Record<string, number> = {};
  for (let offset = 0; offset < 7; offset += 1) {
    days[serviceDayKey(firstStart + offset * 24 * 60 * 60 * 1000)] = 0;
  }
  for (const row of rows.results ?? []) {
    const key = serviceDayKey(row.joined_at);
    if (key in days) days[key] += 1;
  }
  return json({ days });
}

export async function myPenalties(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  const rows = await env.DB.prepare(
    `SELECT p.id, p.room_id, p.reason, p.status, p.issued_at, p.resolved_at, p.locked_at, r.name AS room_name
     FROM penalties p JOIN rooms r ON r.id = p.room_id WHERE p.user_id = ? ORDER BY p.issued_at DESC`,
  ).bind(user.id).all<{
    id: string; room_id: string; reason: string; status: string; issued_at: number; resolved_at: number | null; locked_at: number | null; room_name: string;
  }>();
  return json({ penalties: (rows.results ?? []).map((row) => ({
    id: row.id, roomId: row.room_id, roomName: row.room_name, reason: row.reason,
    status: row.status, issuedAt: row.issued_at, resolvedAt: row.resolved_at, lockedAt: row.locked_at,
  })) });
}

export async function createReport(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  const body = await requestBody(request);
  if (!body) return error("invalid_json", 400);
  const targetUserId = stringValue(body, "targetUserId");
  const roomId = stringValue(body, "roomId") || null;
  const reason = stringValue(body, "reason");
  if (!targetUserId || !reason) return error("report_target_and_reason_required", 400);
  if (targetUserId === user.id) return error("cannot_report_self", 400);
  const target = await env.DB.prepare("SELECT 1 AS found FROM users WHERE id = ?").bind(targetUserId).first<{ found: number }>();
  if (target?.found !== 1) return error("target_user_not_found", 404);
  if (roomId) {
    const participant = await env.DB.prepare("SELECT 1 AS found FROM room_participants WHERE room_id = ? AND user_id = ?")
      .bind(roomId, user.id).first<{ found: number }>();
    if (participant?.found !== 1) return error("room_participant_required", 403);
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO reports (id, reporter_id, target_id, room_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, user.id, targetUserId, roomId, reason, now),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), user.id, "report_created", "report", id, JSON.stringify({ targetUserId, roomId }), now),
  ]);
  return json({ id, status: "pending" }, { status: 201 });
}
