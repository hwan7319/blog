import Database from "better-sqlite3";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const dataDirectory = process.env.DATA_DIR ?? path.resolve("data");
if (!existsSync(dataDirectory)) mkdirSync(dataDirectory, { recursive: true });
const database = new Database(path.join(dataDirectory, "blog-poom.sqlite"));
database.pragma("foreign_keys = ON");
const now = Date.now();
const hour = 60 * 60 * 1000;
const password = process.env.DEMO_PASSWORD ?? "demo-pass-2026";

function base64Url(bytes: Buffer): string { return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""); }
function passwordHash(value: string): string {
  const salt = randomBytes(16);
  return `pbkdf2_sha256$210000$${base64Url(salt)}$${base64Url(pbkdf2Sync(value, salt, 32, 210000, "sha256"))}`;
}

const members = [
  ["10000000-0000-4000-8000-000000000001", "봄테스트", "https://blog.example/demo-spring", "봄의 테스트 블로그"],
  ["10000000-0000-4000-8000-000000000002", "여름테스트", "https://blog.example/demo-summer", "여름의 테스트 블로그"],
  ["10000000-0000-4000-8000-000000000003", "가을테스트", "https://blog.example/demo-autumn", "가을의 테스트 블로그"],
  ["10000000-0000-4000-8000-000000000004", "겨울테스트", "https://blog.example/demo-winter", "겨울의 테스트 블로그"],
] as const;
const waitingRoom = "20000000-0000-4000-8000-000000000001";
const activeRoom = "20000000-0000-4000-8000-000000000002";
const closedRoom = "20000000-0000-4000-8000-000000000003";

database.transaction(() => {
  for (const [id, nickname, blogUrl, blogName] of members) {
    database.prepare(
      `INSERT OR IGNORE INTO users (id, nickname, password_hash, blog_url, blog_name, account_status, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
    ).run(id, nickname, passwordHash(password), blogUrl, blogName, now - 7 * 24 * hour, now - 7 * 24 * hour, now);
  }
  database.prepare(
    `INSERT OR IGNORE INTO rooms (id, name, room_type, creator_id, capacity, join_starts_at, join_ends_at, closes_at, missions_json, room_status, created_at)
     VALUES (?, '더미 키워드 모집방', 'keyword', ?, 5, ?, ?, ?, '["공감","댓글"]', 'waiting', ?)`,
  ).run(waitingRoom, members[0][0], now - 5 * 60 * 1000, now + 10 * 60 * 1000, now + 25 * 60 * 1000, now - 5 * 60 * 1000);
  database.prepare(
    `INSERT OR IGNORE INTO rooms (id, name, room_type, creator_id, capacity, join_starts_at, join_ends_at, closes_at, missions_json, room_status, created_at)
     VALUES (?, '더미 링크 진행방', 'link', ?, 4, ?, ?, ?, '["공감","스크랩"]', 'in_progress', ?)`,
  ).run(activeRoom, members[1][0], now - 30 * 60 * 1000, now - 15 * 60 * 1000, now + 15 * 60 * 1000, now - 30 * 60 * 1000);
  database.prepare(
    `INSERT OR IGNORE INTO rooms (id, name, room_type, creator_id, capacity, join_starts_at, join_ends_at, closes_at, missions_json, room_status, closed_at, created_at)
     VALUES (?, '더미 종료방', 'keyword', ?, 3, ?, ?, ?, '["댓글"]', 'closed', ?, ?)`,
  ).run(closedRoom, members[2][0], now - 2 * hour, now - 105 * 60 * 1000, now - 90 * 60 * 1000, now - 90 * 60 * 1000, now - 2 * hour);

  const participant = database.prepare(
    "INSERT OR IGNORE INTO room_participants (id, room_id, user_id, keyword, link_url, joined_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  participant.run("30000000-0000-4000-8000-000000000001", waitingRoom, members[0][0], "가을 여행", null, now - 4 * 60 * 1000, null);
  participant.run("30000000-0000-4000-8000-000000000002", waitingRoom, members[1][0], "가을 여행", null, now - 3 * 60 * 1000, null);
  participant.run("30000000-0000-4000-8000-000000000003", activeRoom, members[1][0], null, "https://blog.example/demo-summer/post-1", now - 25 * 60 * 1000, now - 5 * 60 * 1000);
  participant.run("30000000-0000-4000-8000-000000000004", activeRoom, members[2][0], null, "https://blog.example/demo-autumn/post-1", now - 24 * 60 * 1000, null);
  participant.run("30000000-0000-4000-8000-000000000005", closedRoom, members[2][0], "서울 카페", null, now - 115 * 60 * 1000, now - 95 * 60 * 1000);
  participant.run("30000000-0000-4000-8000-000000000006", closedRoom, members[3][0], "서울 카페", null, now - 114 * 60 * 1000, null);

  database.prepare("INSERT OR IGNORE INTO visits (id, room_id, visitor_id, target_id, visited_at) VALUES (?, ?, ?, ?, ?)")
    .run("40000000-0000-4000-8000-000000000001", closedRoom, members[2][0], members[3][0], now - 100 * 60 * 1000);
  database.prepare(
    "INSERT OR IGNORE INTO penalties (id, user_id, room_id, reason, status, issued_at) VALUES (?, ?, ?, 'auto_incomplete', 'unresolved', ?)",
  ).run("50000000-0000-4000-8000-000000000001", members[3][0], closedRoom, now - 90 * 60 * 1000);
  database.prepare(
    "INSERT OR IGNORE INTO reports (id, reporter_id, target_id, room_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("60000000-0000-4000-8000-000000000001", members[0][0], members[3][0], closedRoom, "더미 신고: 미션 미이행 확인", now - 30 * 60 * 1000);
  database.prepare(
    "INSERT OR IGNORE INTO audit_logs (id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("70000000-0000-4000-8000-000000000001", members[0][0], "demo_seeded", "system", "demo", JSON.stringify({ rooms: 3, users: 4 }), now);
})();

console.log(JSON.stringify({ ok: true, demoUsers: members.map(([, nickname]) => nickname), password, rooms: 3 }));
