import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://blog-poom.test${path}`, init), env, context);
  await waitOnExecutionContext(context);
  return response;
}

function jsonRequest(body: unknown, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function createApprovedSession(prefix: string): Promise<{ userId: string; cookie: string }> {
  const nickname = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const signup = await api("/api/auth/signup", jsonRequest({
    nickname,
    password: "test-password",
    blogUrl: `https://blog.example/${nickname}`,
    blogName: `${nickname} blog`,
  }));
  expect(signup.status).toBe(201);
  const { user } = await signup.json<{ user: { id: string } }>();
  await env.DB.prepare("UPDATE users SET account_status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?")
    .bind(Date.now(), Date.now(), user.id)
    .run();

  const login = await api("/api/auth/login", jsonRequest({ nickname, password: "test-password" }));
  expect(login.status).toBe(200);
  const cookie = login.headers.get("Set-Cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return { userId: user.id, cookie: cookie! };
}

describe("authentication API", () => {
  it("stores a hash, blocks a pending user, then uses an HttpOnly session", async () => {
    const nickname = `pending-${crypto.randomUUID().slice(0, 8)}`;
    const signup = await api("/api/auth/signup", jsonRequest({
      nickname,
      password: "test-password",
      blogUrl: `https://blog.example/${nickname}`,
      blogName: "Pending blog",
    }));
    expect(signup.status).toBe(201);

    const stored = await env.DB.prepare("SELECT password_hash FROM users WHERE nickname = ?").bind(nickname).first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(/^pbkdf2_sha256\$/);
    expect(stored?.password_hash).not.toContain("test-password");

    const pendingLogin = await api("/api/auth/login", jsonRequest({ nickname, password: "test-password" }));
    expect(pendingLogin.status).toBe(403);

    await env.DB.prepare("UPDATE users SET account_status = 'approved', approved_at = ?, updated_at = ? WHERE nickname = ?")
      .bind(Date.now(), Date.now(), nickname)
      .run();
    const login = await api("/api/auth/login", jsonRequest({ nickname, password: "test-password" }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(login.headers.get("Set-Cookie")).toContain("HttpOnly");

    const me = await api("/api/auth/me", { headers: { Cookie: cookie! } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { nickname, accountStatus: "approved" } });
  });
});

describe("room API", () => {
  it("requires an approved session and preserves the keyword-room time policy", async () => {
    const member = await createApprovedSession("creator");
    const startAt = Date.now() + 60_000;
    const response = await api("/api/rooms", jsonRequest({
      type: "keyword",
      startAt,
      capacity: 2,
      missions: ["공감", "댓글"],
    }, member.cookie));
    expect(response.status).toBe(200);
    const { room } = await response.json<{ room: { joinStartsAt: number; joinEndsAt: number; closesAt: number; type: string } }>();
    expect(room.type).toBe("keyword");
    expect(room.joinEndsAt - room.joinStartsAt).toBe(15 * 60 * 1000);
    expect(room.closesAt - room.joinEndsAt).toBe(15 * 60 * 1000);
  });

  it("allows only one concurrent participant when one seat remains", async () => {
    const first = await createApprovedSession("first");
    const second = await createApprovedSession("second");
    const roomId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO rooms (id, name, room_type, creator_id, capacity, join_starts_at, join_ends_at, closes_at, missions_json, created_at)
       VALUES (?, ?, 'keyword', ?, 1, ?, ?, ?, '["공감"]', ?)`,
    ).bind(roomId, "Concurrency test room", first.userId, now - 1_000, now + 60_000, now + 120_000, now).run();

    const responses = await Promise.all([
      api(`/api/rooms/${roomId}/participants`, jsonRequest({ keyword: "first keyword" }, first.cookie)),
      api(`/api/rooms/${roomId}/participants`, jsonRequest({ keyword: "second keyword" }, second.cookie)),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM room_participants WHERE room_id = ?")
      .bind(roomId)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("marks visits complete and penalizes only the incomplete member at closure", async () => {
    const first = await createApprovedSession("visitor");
    const second = await createApprovedSession("target");
    const roomId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rooms (id, name, room_type, creator_id, capacity, join_starts_at, join_ends_at, closes_at, missions_json, created_at)
         VALUES (?, ?, 'keyword', ?, 2, ?, ?, ?, '["공감"]', ?)`,
      ).bind(roomId, "Completion test room", first.userId, now - 120_000, now - 60_000, now + 60_000, now),
      env.DB.prepare(
        "INSERT INTO room_participants (id, room_id, user_id, keyword, joined_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), roomId, first.userId, "first", now - 110_000),
      env.DB.prepare(
        "INSERT INTO room_participants (id, room_id, user_id, keyword, joined_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), roomId, second.userId, "second", now - 110_000),
    ]);

    const visit = await api(`/api/rooms/${roomId}/visits/${second.userId}`, { method: "POST", headers: { Cookie: first.cookie } });
    expect(visit.status).toBe(200);
    expect(await visit.json()).toMatchObject({ ok: true, completed: true });

    await env.DB.prepare("UPDATE rooms SET closes_at = ? WHERE id = ?").bind(Date.now() - 1, roomId).run();
    const participants = await api(`/api/rooms/${roomId}/participants`, { headers: { Cookie: first.cookie } });
    expect(participants.status).toBe(200);

    const penalties = await env.DB.prepare("SELECT user_id FROM penalties WHERE room_id = ? AND status = 'unresolved'")
      .bind(roomId)
      .all<{ user_id: string }>();
    expect(penalties.results).toEqual([{ user_id: second.userId }]);
  });
});
