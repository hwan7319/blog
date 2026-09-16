import type { Env } from "./index";
import { error, json, PublicUser, requestBody, requireUser, stringValue } from "./auth";

type RoomRow = {
  id: string;
  name: string;
  room_type: "keyword" | "link";
  creator_id: string;
  creator_nickname: string;
  capacity: number;
  join_starts_at: number;
  join_ends_at: number;
  closes_at: number;
  missions_json: string;
  room_status: "waiting" | "in_progress" | "closed" | "deleted";
  created_at: number;
  participant_count: number;
};

const KEYWORD_WAIT_MS = 15 * 60 * 1000;
const KEYWORD_PROGRESS_MS = 15 * 60 * 1000;
const VALID_MISSIONS = new Set(["공감", "댓글", "스크랩"]);

function isResponse(value: PublicUser | Response): value is Response {
  return value instanceof Response;
}

function liveStatus(room: RoomRow, now = Date.now()): RoomRow["room_status"] {
  if (room.room_status === "deleted") return "deleted";
  if (now < room.join_ends_at) return "waiting";
  if (now < room.closes_at) return "in_progress";
  return "closed";
}

function parseMissions(missionsJson: string): string[] {
  try {
    const value = JSON.parse(missionsJson);
    return Array.isArray(value) && value.every((mission) => typeof mission === "string") ? value : [];
  } catch {
    return [];
  }
}

function serializeRoom(room: RoomRow) {
  return {
    id: room.id,
    name: room.name,
    type: room.room_type,
    creator: { id: room.creator_id, nickname: room.creator_nickname },
    capacity: room.capacity,
    participantCount: room.participant_count,
    isFull: room.participant_count >= room.capacity,
    joinStartsAt: room.join_starts_at,
    joinEndsAt: room.join_ends_at,
    closesAt: room.closes_at,
    missions: parseMissions(room.missions_json),
    status: liveStatus(room),
    createdAt: room.created_at,
  };
}

function queryRooms(env: Env, where = "", bindings: unknown[] = []): D1PreparedStatement {
  const statement = `
    SELECT r.id, r.name, r.room_type, r.creator_id, u.nickname AS creator_nickname,
           r.capacity, r.join_starts_at, r.join_ends_at, r.closes_at,
           r.missions_json, r.room_status, r.created_at,
           (SELECT COUNT(*) FROM room_participants p WHERE p.room_id = r.id) AS participant_count
    FROM rooms r
    JOIN users u ON u.id = r.creator_id
    ${where}
  `;
  return env.DB.prepare(statement).bind(...bindings);
}

function serviceDayStart(now = Date.now()): number {
  const shifted = new Date(now - 4 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.parse(`${values.year}-${values.month}-${values.day}T04:00:00+09:00`);
}

function numberValue(body: Record<string, unknown>, name: string): number | null {
  const value = body[name];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function missionsValue(body: Record<string, unknown>): string[] | null {
  const missions = body.missions;
  if (!Array.isArray(missions) || missions.length === 0 || !missions.every((mission) => typeof mission === "string" && VALID_MISSIONS.has(mission))) {
    return null;
  }
  return [...new Set(missions)];
}

function automaticRoomName(startAt: number, missions: string[]): string {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(startAt))
    .find((part) => part.type === "hour")?.value ?? "";
  return `${hour}시 ${missions.join(" ")}방`;
}

async function hasUnresolvedPenalty(env: Env, userId: string): Promise<boolean> {
  const penalty = await env.DB.prepare("SELECT 1 AS found FROM penalties WHERE user_id = ? AND status = 'unresolved' LIMIT 1")
    .bind(userId)
    .first<{ found: number }>();
  return penalty?.found === 1;
}

async function audit(env: Env, actorId: string, eventType: string, targetType: string, targetId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), actorId, eventType, targetType, targetId, JSON.stringify(metadata), Date.now()).run();
}

export async function listRooms(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  if (type && type !== "keyword" && type !== "link") return error("invalid_room_type", 400);
  const start = serviceDayStart();
  const end = start + 24 * 60 * 60 * 1000;
  const where = type
    ? "WHERE r.room_status != 'deleted' AND r.join_starts_at >= ? AND r.join_starts_at < ? AND r.room_type = ? ORDER BY r.join_starts_at ASC"
    : "WHERE r.room_status != 'deleted' AND r.join_starts_at >= ? AND r.join_starts_at < ? ORDER BY r.join_starts_at ASC";
  const rooms = await queryRooms(env, where, type ? [start, end, type] : [start, end]).all<RoomRow>();
  return json({ serviceDayStartsAt: start, rooms: (rooms.results ?? []).map(serializeRoom) });
}

export async function getRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  const room = await queryRooms(env, "WHERE r.id = ? AND r.room_status != 'deleted'", [roomId]).first<RoomRow>();
  return room ? json({ room: serializeRoom(room) }) : error("room_not_found", 404);
}

export async function createRoom(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  if (user.accountStatus !== "approved") return error("account_not_approved", 403);
  if (await hasUnresolvedPenalty(env, user.id)) return error("unresolved_penalty", 403);

  const body = await requestBody(request);
  if (!body) return error("invalid_json", 400);
  const type = stringValue(body, "type");
  const startAt = numberValue(body, "startAt");
  const capacity = numberValue(body, "capacity");
  const missions = missionsValue(body);
  if ((type !== "keyword" && type !== "link") || !startAt || !capacity || capacity < 1 || !missions) return error("invalid_room_fields", 400);
  if (startAt < Date.now()) return error("start_time_must_be_future", 400);

  const waitMinutes = type === "keyword" ? 15 : numberValue(body, "waitMinutes");
  const progressMinutes = type === "keyword" ? 15 : numberValue(body, "progressMinutes");
  if (!waitMinutes || !progressMinutes || waitMinutes < 1 || progressMinutes < 1) return error("invalid_room_duration", 400);

  const joinEndsAt = startAt + waitMinutes * 60 * 1000;
  const closesAt = joinEndsAt + progressMinutes * 60 * 1000;
  const suppliedName = stringValue(body, "name");
  const name = suppliedName || automaticRoomName(startAt, missions);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO rooms (id, name, room_type, creator_id, capacity, join_starts_at, join_ends_at, closes_at, missions_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, name, type, user.id, capacity, startAt, joinEndsAt, closesAt, JSON.stringify(missions), now).run();
  await audit(env, user.id, "room_created", "room", id, { type, startAt, capacity });
  return getRoom(request, env, id);
}

export async function joinRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  if (user.accountStatus !== "approved") return error("account_not_approved", 403);
  if (await hasUnresolvedPenalty(env, user.id)) return error("unresolved_penalty", 403);

  const body = await requestBody(request);
  if (!body) return error("invalid_json", 400);
  const room = await queryRooms(env, "WHERE r.id = ? AND r.room_status != 'deleted'", [roomId]).first<RoomRow>();
  if (!room) return error("room_not_found", 404);
  const value = room.room_type === "keyword" ? stringValue(body, "keyword") : stringValue(body, "linkUrl");
  if (!value) return error("participant_value_required", 400);
  if (room.room_type === "link") {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return error("invalid_link_url", 400);
    } catch {
      return error("invalid_link_url", 400);
    }
  }

  const now = Date.now();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO room_participants (id, room_id, user_id, keyword, link_url, joined_at)
     SELECT ?, r.id, ?, ?, ?, ?
     FROM rooms r
     WHERE r.id = ?
       AND r.room_status != 'deleted'
       AND r.join_starts_at <= ?
       AND r.join_ends_at > ?
       AND (SELECT COUNT(*) FROM room_participants p WHERE p.room_id = r.id) < r.capacity`,
  ).bind(
    crypto.randomUUID(), user.id, room.room_type === "keyword" ? value : null, room.room_type === "link" ? value : null, now,
    roomId, now, now,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) {
    if (room.join_starts_at > now) return error("room_not_started", 409);
    if (room.join_ends_at <= now) return error("room_join_closed", 409);
    if (room.participant_count >= room.capacity) return error("room_full", 409);
    return error("already_joined_or_room_unavailable", 409);
  }
  await audit(env, user.id, "room_joined", "room", roomId);
  return json({ ok: true, roomId }, { status: 201 });
}

export async function deleteRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (isResponse(user)) return user;
  const room = await queryRooms(env, "WHERE r.id = ?", [roomId]).first<RoomRow>();
  if (!room || room.room_status === "deleted") return error("room_not_found", 404);
  if (room.creator_id !== user.id) return error("room_creator_required", 403);

  const result = await env.DB.prepare(
    `UPDATE rooms SET room_status = 'deleted', deleted_at = ?
     WHERE id = ? AND room_status != 'deleted'
       AND NOT EXISTS (SELECT 1 FROM room_participants WHERE room_id = ?)`,
  ).bind(Date.now(), roomId, roomId).run();
  if ((result.meta.changes ?? 0) !== 1) return error("room_has_participants", 409);
  await audit(env, user.id, "room_deleted", "room", roomId);
  return json({ ok: true });
}
