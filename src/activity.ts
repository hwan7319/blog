import type { Env } from "./index";
import { error, json, PublicUser, requireUser } from "./auth";

type RoomTiming = {
  id: string;
  creator_id: string;
  join_ends_at: number;
  closes_at: number;
  room_status: "waiting" | "in_progress" | "closed" | "deleted";
};

type ParticipantRow = {
  user_id: string;
  nickname: string;
  blog_name: string;
  blog_url: string;
  keyword: string | null;
  link_url: string | null;
  joined_at: number;
  completed_at: number | null;
};

function isResponse(value: PublicUser | Response): value is Response {
  return value instanceof Response;
}

async function audit(env: Env, actorId: string | null, eventType: string, targetType: string, targetId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), actorId, eventType, targetType, targetId, JSON.stringify(metadata), Date.now()).run();
}

async function roomTiming(env: Env, roomId: string): Promise<RoomTiming | null> {
  return env.DB.prepare("SELECT id, creator_id, join_ends_at, closes_at, room_status FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<RoomTiming>();
}

async function isParticipant(env: Env, roomId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS found FROM room_participants WHERE room_id = ? AND user_id = ?")
    .bind(roomId, userId)
    .first<{ found: number }>();
  return row?.found === 1;
}

async function unresolvedPenaltyForRoom(env: Env, roomId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS found FROM penalties WHERE room_id = ? AND user_id = ? AND status = 'unresolved' LIMIT 1",
  ).bind(roomId, userId).first<{ found: number }>();
  return row?.found === 1;
}

export async function closeExpiredRoom(env: Env, roomId: string, now = Date.now()): Promise<void> {
  const room = await roomTiming(env, roomId);
  if (!room || room.room_status === "deleted" || room.room_status === "closed" || room.closes_at > now) return;

  const transition = await env.DB.prepare(
    "UPDATE rooms SET room_status = 'closed', closed_at = ? WHERE id = ? AND room_status NOT IN ('closed', 'deleted') AND closes_at <= ?",
  ).bind(now, roomId, now).run();
  if ((transition.meta.changes ?? 0) !== 1) return;

  const participants = await env.DB.prepare(
    `SELECT p.user_id, p.completed_at,
       (SELECT COUNT(*) FROM room_participants target WHERE target.room_id = p.room_id AND target.user_id != p.user_id) AS target_count,
       (SELECT COUNT(*) FROM visits v JOIN room_participants target ON target.room_id = v.room_id AND target.user_id = v.target_id
        WHERE v.room_id = p.room_id AND v.visitor_id = p.user_id) AS visited_count
     FROM room_participants p WHERE p.room_id = ?`,
  ).bind(roomId).all<{ user_id: string; completed_at: number | null; target_count: number; visited_count: number }>();

  const operations: D1PreparedStatement[] = [];
  for (const participant of participants.results ?? []) {
    if (participant.target_count === 0 || participant.visited_count === participant.target_count) {
      if (!participant.completed_at) {
        operations.push(env.DB.prepare("UPDATE room_participants SET completed_at = ? WHERE room_id = ? AND user_id = ? AND completed_at IS NULL")
          .bind(now, roomId, participant.user_id));
      }
      continue;
    }
    operations.push(env.DB.prepare(
      `INSERT OR IGNORE INTO penalties (id, user_id, room_id, reason, status, issued_at)
       VALUES (?, ?, ?, 'auto_incomplete', 'unresolved', ?)`,
    ).bind(crypto.randomUUID(), participant.user_id, roomId, now));
  }
  operations.push(env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), "room_closed", "room", roomId, "{}", now));
  await env.DB.batch(operations);
}

export async function closeExpiredRooms(env: Env): Promise<void> {
  const now = Date.now();
  const rooms = await env.DB.prepare("SELECT id FROM rooms WHERE room_status NOT IN ('closed', 'deleted') AND closes_at <= ?")
    .bind(now)
    .all<{ id: string }>();
  for (const room of rooms.results ?? []) await closeExpiredRoom(env, room.id, now);
}

export async function lockOverduePenalties(env: Env): Promise<void> {
  const deadline = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const penalties = await env.DB.prepare(
    "SELECT id, user_id FROM penalties WHERE status = 'unresolved' AND locked_at IS NULL AND issued_at <= ?",
  ).bind(deadline).all<{ id: string; user_id: string }>();
  for (const penalty of penalties.results ?? []) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE penalties SET locked_at = ? WHERE id = ? AND locked_at IS NULL").bind(now, penalty.id),
      env.DB.prepare("UPDATE users SET account_status = 'locked', updated_at = ? WHERE id = ?").bind(now, penalty.user_id),
      env.DB.prepare(
        "INSERT INTO audit_logs (id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), "account_locked_for_penalty", "user", penalty.user_id, JSON.stringify({ penaltyId: penalty.id }), now),
    ]);
  }
}

export async function getParticipants(request: Request, env: Env, roomId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  await closeExpiredRoom(env, roomId);
  const room = await roomTiming(env, roomId);
  if (!room || room.room_status === "deleted") return error("room_not_found", 404);
  if (room.creator_id !== user.id && !(await isParticipant(env, roomId, user.id))) return error("room_participant_required", 403);

  const participants = await env.DB.prepare(
    `SELECT p.user_id, u.nickname, u.blog_name, u.blog_url, p.keyword, p.link_url, p.joined_at, p.completed_at
     FROM room_participants p JOIN users u ON u.id = p.user_id WHERE p.room_id = ? ORDER BY p.joined_at ASC`,
  ).bind(roomId).all<ParticipantRow>();
  const myVisits = await env.DB.prepare("SELECT target_id FROM visits WHERE room_id = ? AND visitor_id = ?")
    .bind(roomId, user.id)
    .all<{ target_id: string }>();
  return json({
    participants: participants.results ?? [],
    myVisitedTargetIds: (myVisits.results ?? []).map((visit) => visit.target_id),
  });
}

export async function visitParticipant(request: Request, env: Env, roomId: string, targetId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  if (user.id === targetId) return error("cannot_visit_self", 400);
  await closeExpiredRoom(env, roomId);
  const room = await roomTiming(env, roomId);
  if (!room || room.room_status === "deleted") return error("room_not_found", 404);
  const now = Date.now();
  const closed = room.room_status === "closed" || room.closes_at <= now;
  if (now < room.join_ends_at) return error("room_not_in_progress", 409);
  if (closed && !(await unresolvedPenaltyForRoom(env, roomId, user.id))) return error("room_closed", 409);
  if (!(await isParticipant(env, roomId, user.id)) || !(await isParticipant(env, roomId, targetId))) return error("room_participant_required", 403);

  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO visits (id, room_id, visitor_id, target_id, visited_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), roomId, user.id, targetId, now).run();
  if ((inserted.meta.changes ?? 0) === 1) await audit(env, user.id, "participant_visited", "room", roomId, { targetId });

  const completed = await env.DB.prepare(
    `UPDATE room_participants SET completed_at = ?
     WHERE room_id = ? AND user_id = ? AND completed_at IS NULL
       AND (SELECT COUNT(*) FROM room_participants target WHERE target.room_id = ? AND target.user_id != ?) > 0
       AND (SELECT COUNT(*) FROM visits v JOIN room_participants target ON target.room_id = v.room_id AND target.user_id = v.target_id
            WHERE v.room_id = ? AND v.visitor_id = ?) =
           (SELECT COUNT(*) FROM room_participants target WHERE target.room_id = ? AND target.user_id != ?)`,
  ).bind(now, roomId, user.id, roomId, user.id, roomId, user.id, roomId, user.id).run();
  if ((completed.meta.changes ?? 0) === 1) await audit(env, user.id, "room_participation_completed", "room", roomId);
  return json({ ok: true, alreadyVisited: (inserted.meta.changes ?? 0) === 0, completed: (completed.meta.changes ?? 0) === 1 });
}

export async function reportParticipant(request: Request, env: Env, roomId: string, targetId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  if (user.id === targetId) return error("cannot_report_self", 400);
  await closeExpiredRoom(env, roomId);
  const room = await roomTiming(env, roomId);
  if (!room || room.room_status !== "closed") return error("room_not_closed", 409);
  if (!(await isParticipant(env, roomId, user.id)) || !(await isParticipant(env, roomId, targetId))) return error("room_participant_required", 403);

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO penalties (id, user_id, room_id, reason, status, issued_at)
     VALUES (?, ?, ?, 'participant_report', 'unresolved', ?)`,
  ).bind(crypto.randomUUID(), targetId, roomId, Date.now()).run();
  if ((result.meta.changes ?? 0) !== 1) return error("penalty_already_exists", 409);
  await audit(env, user.id, "participant_reported", "room", roomId, { targetId });
  return json({ ok: true }, { status: 201 });
}

export async function releasePenalty(request: Request, env: Env, penaltyId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  const penalty = await env.DB.prepare("SELECT id, user_id, room_id, status FROM penalties WHERE id = ?")
    .bind(penaltyId)
    .first<{ id: string; user_id: string; room_id: string; status: string }>();
  if (!penalty || penalty.user_id !== user.id) return error("penalty_not_found", 404);
  if (penalty.status !== "unresolved") return error("penalty_already_resolved", 409);
  const participant = await env.DB.prepare("SELECT completed_at FROM room_participants WHERE room_id = ? AND user_id = ?")
    .bind(penalty.room_id, user.id)
    .first<{ completed_at: number | null }>();
  if (!participant?.completed_at) return error("room_not_completed", 409);

  const now = Date.now();
  await env.DB.prepare("UPDATE penalties SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'unresolved'")
    .bind(now, penalty.id).run();
  const remaining = await env.DB.prepare("SELECT COUNT(*) AS count FROM penalties WHERE user_id = ? AND status = 'unresolved'")
    .bind(user.id).first<{ count: number }>();
  if ((remaining?.count ?? 0) === 0) {
    await env.DB.prepare("UPDATE users SET account_status = 'approved', updated_at = ? WHERE id = ? AND account_status = 'locked'")
      .bind(now, user.id).run();
  }
  await audit(env, user.id, "penalty_resolved", "penalty", penalty.id);
  return json({ ok: true, accountUnlocked: (remaining?.count ?? 0) === 0 });
}
