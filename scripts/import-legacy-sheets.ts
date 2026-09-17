import Database from "better-sqlite3";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

type Cell = { v?: unknown; f?: string | null } | null;
type GvizResponse = { status: string; table?: { cols: Array<{ label: string }>; rows: Array<{ c: Cell[] }> } };
type Row = Record<string, unknown>;

const SPREADSHEET_ID = "13exVxWL0q1QKhTzQmxF5WZsiyJUad0S0yjcsERdNsq8";
const SHEETS = ["Users", "Rooms", "RoomParticipants", "Visits", "Penalties", "Reports", "Logs", "Admins"] as const;
const REQUIRED_HEADERS: Record<(typeof SHEETS)[number], string[]> = {
  Users: ["UserID", "닉네임", "비밀번호", "블로그주소", "블로그명", "가입일", "승인일", "참여횟수", "패널티상태", "계정상태"],
  Rooms: ["RoomID", "방이름", "유형", "생성자", "생성일시", "시작시간", "모집인원", "대기시간", "진행시간", "미션", "상태"],
  RoomParticipants: ["ParticipantID", "RoomID", "닉네임", "참여시각", "개인키워드", "개인링크", "완료여부", "완료시각"],
  Visits: ["VisitID", "RoomID", "방문자", "방문대상", "시각"],
  Penalties: ["PenaltyID", "닉네임", "발생일", "사유", "RoomID", "해제여부", "해제일", "잠금처리여부"],
  Reports: ["ReportID", "신고자", "대상자", "RoomID", "사유", "접수일시", "처리상태"],
  Logs: ["LogID", "유형", "닉네임", "대상", "시각", "상세"],
  Admins: ["AdminID", "아이디", "비밀번호", "생성일"],
};
const namespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
const passwordIterations = 210_000;

function text(value: unknown): string { return value == null ? "" : String(value).trim(); }
function number(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label}: 숫자 값이 아닙니다.`);
  return parsed;
}
function optionalDate(value: unknown, label: string): number | null { return text(value) ? date(value, label) : null; }
function date(value: unknown, label: string): number {
  const formatted = text(value);
  const match = formatted.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/);
  if (!match) throw new Error(`${label}: 날짜 형식을 읽을 수 없습니다 (${formatted}).`);
  const instant = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${(match[4] ?? "0").padStart(2, "0")}:${match[5] ?? "00"}:${match[6] ?? "00"}+09:00`);
  if (!Number.isFinite(instant)) throw new Error(`${label}: 유효하지 않은 날짜입니다.`);
  return instant;
}
function uuid(key: string): string {
  const digest = createHash("sha1").update(namespace).update(key).digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function passwordHash(password: string): string {
  const salt = randomBytes(16);
  const encoded = (bytes: Buffer) => bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `pbkdf2_sha256$${passwordIterations}$${encoded(salt)}$${encoded(pbkdf2Sync(password, salt, passwordIterations, 32, "sha256"))}`;
}
function sourceKey(value: string, occurrences: Map<string, number>): string {
  const count = (occurrences.get(value) ?? 0) + 1;
  occurrences.set(value, count);
  return count === 1 ? value : `${value}#${count}`;
}
async function fetchSheet(sheet: (typeof SHEETS)[number]): Promise<Row[]> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  url.searchParams.set("sheet", sheet);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${sheet}: Google Sheets 응답 ${response.status}`);
  const payload = await response.text();
  const match = payload.match(/setResponse\((.*)\);\s*$/s);
  if (!match) throw new Error(`${sheet}: Google Sheets 데이터 형식을 읽을 수 없습니다.`);
  const parsed = JSON.parse(match[1]) as GvizResponse;
  if (parsed.status !== "ok" || !parsed.table) throw new Error(`${sheet}: Google Sheets 조회에 실패했습니다.`);
  let headers = parsed.table.cols.map((column) => column.label);
  let sheetRows = parsed.table.rows;
  const required = REQUIRED_HEADERS[sheet];
  // The empty Reports tab is exposed by GViz as seven blank columns, despite
  // retaining its headers as the first data row. Normalize that GViz quirk.
  if (headers.every((header) => !header) && sheetRows.length) {
    headers = sheetRows[0].c.map((cell) => text(cell?.f ?? cell?.v));
    sheetRows = sheetRows.slice(1);
  }
  if (headers.slice(0, required.length).some((header, index) => header !== required[index]) || headers.slice(required.length).some(Boolean)) {
    throw new Error(`${sheet}: 헤더가 원본 구조와 다릅니다.`);
  }
  return sheetRows.map(({ c }) => Object.fromEntries(required.map((header, index) => {
    const cell = c[index];
    return [header, cell?.f ?? cell?.v ?? ""];
  }))).filter((row) => required.some((header) => text(row[header])));
}
function mapAccountStatus(value: unknown): "pending" | "approved" | "rejected" | "locked" {
  const mapped = ({ "대기": "pending", "승인": "approved", "반려": "rejected", "잠금": "locked" } as const)[text(value)];
  if (!mapped) throw new Error(`알 수 없는 계정 상태: ${text(value)}`);
  return mapped;
}
function mapRoomStatus(value: unknown): "waiting" | "in_progress" | "closed" | "deleted" {
  const mapped = ({ "대기": "waiting", "진행중": "in_progress", "마감": "closed", "삭제됨": "deleted" } as const)[text(value)];
  if (!mapped) throw new Error(`알 수 없는 방 상태: ${text(value)}`);
  return mapped;
}
function mapRoomType(value: unknown): "keyword" | "link" {
  const mapped = ({ "키워드": "keyword", "링크": "link" } as const)[text(value)];
  if (!mapped) throw new Error(`알 수 없는 방 유형: ${text(value)}`);
  return mapped;
}
function mapPenaltyReason(value: unknown): "auto_incomplete" | "participant_report" | "admin" {
  const mapped = ({ "미완료(자동)": "auto_incomplete", "참여자신고": "participant_report", "운영자 처리": "admin" } as const)[text(value)];
  if (!mapped) throw new Error(`알 수 없는 패널티 사유: ${text(value)}`);
  return mapped;
}
function mapReportStatus(value: unknown): "pending" | "resolved" | "dismissed" {
  const mapped = ({ "대기": "pending", "확인완료": "resolved", "기각": "dismissed" } as const)[text(value)];
  if (!mapped) throw new Error(`알 수 없는 신고 상태: ${text(value)}`);
  return mapped;
}
function missions(value: unknown): string {
  const parsed = text(value).split(",").map((mission) => mission.trim()).filter(Boolean);
  if (!parsed.length || parsed.some((mission) => !["공감", "댓글", "스크랩"].includes(mission))) throw new Error(`알 수 없는 미션: ${text(value)}`);
  return JSON.stringify([...new Set(parsed)]);
}
function placeholders(rows: Record<(typeof SHEETS)[number], Row[]>): Set<string> {
  const userNames = new Set(rows.Users.map((row) => text(row["닉네임"])));
  const adminNames = new Set(rows.Admins.map((row) => text(row["아이디"])));
  const referenced = new Set<string>();
  for (const row of rows.Rooms) referenced.add(text(row["생성자"]));
  for (const row of rows.RoomParticipants) referenced.add(text(row["닉네임"]));
  for (const row of rows.Visits) { referenced.add(text(row["방문자"])); referenced.add(text(row["방문대상"])); }
  for (const row of rows.Penalties) referenced.add(text(row["닉네임"]));
  for (const row of rows.Reports) { referenced.add(text(row["신고자"])); referenced.add(text(row["대상자"])); }
  for (const row of rows.Logs) if (text(row["닉네임"])) referenced.add(text(row["닉네임"]));
  return new Set([...referenced].filter((name) => name && !userNames.has(name) && !adminNames.has(name)));
}
function verifyRows(rows: Record<(typeof SHEETS)[number], Row[]>, orphanNames: Set<string>): void {
  const ids = (sheet: (typeof SHEETS)[number], column: string) => new Set(rows[sheet].map((row) => text(row[column])));
  const users = new Set([...ids("Users", "닉네임"), ...ids("Admins", "아이디"), ...orphanNames]);
  const rooms = ids("Rooms", "RoomID");
  const ensure = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  ensure(new Set(rows.Users.map((row) => text(row.UserID))).size === rows.Users.length, "Users: 중복 UserID가 있습니다.");
  ensure(new Set(rows.Users.map((row) => text(row["닉네임"]))).size === rows.Users.length, "Users: 중복 닉네임이 있습니다.");
  ensure(new Set(rows.Users.map((row) => text(row["블로그주소"]))).size === rows.Users.length, "Users: 중복 블로그 주소가 있습니다.");
  for (const row of rows.Rooms) { ensure(users.has(text(row["생성자"])), `Rooms: 생성자를 찾을 수 없습니다 (${text(row.RoomID)}).`); mapRoomType(row["유형"]); missions(row["미션"]); }
  for (const row of rows.RoomParticipants) {
    ensure(rooms.has(text(row.RoomID)), `RoomParticipants: 방을 찾을 수 없습니다 (${text(row.ParticipantID)}).`);
    ensure(users.has(text(row["닉네임"])), `RoomParticipants: 회원을 찾을 수 없습니다 (${text(row.ParticipantID)}).`);
    ensure(Boolean(text(row["개인키워드"])) !== Boolean(text(row["개인링크"])), `RoomParticipants: 키워드/링크 값이 잘못되었습니다 (${text(row.ParticipantID)}).`);
  }
  for (const row of rows.Visits) {
    ensure(rooms.has(text(row.RoomID)), `Visits: 방을 찾을 수 없습니다 (${text(row.VisitID)}).`);
    ensure(users.has(text(row["방문자"])) && users.has(text(row["방문대상"])), `Visits: 회원을 찾을 수 없습니다 (${text(row.VisitID)}).`);
    ensure(text(row["방문자"]) !== text(row["방문대상"]), `Visits: 자기 방문 기록입니다 (${text(row.VisitID)}).`);
  }
  for (const row of rows.Penalties) {
    ensure(rooms.has(text(row.RoomID)) && users.has(text(row["닉네임"])), `Penalties: 참조를 찾을 수 없습니다 (${text(row.PenaltyID)}).`);
    mapPenaltyReason(row["사유"]);
  }
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const databaseFlag = args.indexOf("--database");
const databasePath = databaseFlag >= 0 ? args[databaseFlag + 1] : path.resolve(process.env.DATA_DIR ?? "data", "blog-poom.sqlite");
if (databaseFlag >= 0 && !args[databaseFlag + 1]) throw new Error("--database 뒤에 경로가 필요합니다.");

const rows = Object.fromEntries(await Promise.all(SHEETS.map(async (sheet) => [sheet, await fetchSheet(sheet)]))) as Record<(typeof SHEETS)[number], Row[]>;
const orphanNames = placeholders(rows);
verifyRows(rows, orphanNames);
const summary = Object.fromEntries(SHEETS.map((sheet) => [sheet, rows[sheet].length]));
if (!apply) {
  console.log(JSON.stringify({ mode: "dry-run", source: summary, preservedHistoricalUsers: [...orphanNames] }, null, 2));
  process.exit(0);
}
if (!existsSync(databasePath)) throw new Error(`SQLite 데이터베이스를 찾을 수 없습니다: ${databasePath}`);

const database = new Database(databasePath);
database.pragma("foreign_keys = ON");
const now = Date.now();
const retainedAdmins = database.prepare("SELECT u.id, u.nickname FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'admin'").all() as Array<{ id: string; nickname: string }>;
const retainedByName = new Map(retainedAdmins.map((admin) => [admin.nickname.toLocaleLowerCase(), admin]));
const retainedNames = new Set(retainedByName.keys());
const incomingNames = new Set([...rows.Users.map((row) => text(row["닉네임"])), ...rows.Admins.map((row) => text(row["아이디"])), ...orphanNames].map((name) => name.toLocaleLowerCase()));
const sourceAdminNames = new Set(rows.Admins.map((row) => text(row["아이디"]).toLocaleLowerCase()));
for (const name of retainedNames) if (incomingNames.has(name) && !sourceAdminNames.has(name)) throw new Error(`현재 관리자와 이관 대상 닉네임이 충돌합니다: ${name}`);

const userIds = new Map<string, string>();
for (const row of rows.Users) userIds.set(text(row["닉네임"]), uuid(`user:${text(row.UserID)}`));
for (const row of rows.Admins) userIds.set(text(row["아이디"]), uuid(`admin:${text(row.AdminID)}`));
for (const [name, admin] of retainedByName) if (sourceAdminNames.has(name)) userIds.set(admin.nickname, admin.id);
for (const name of orphanNames) userIds.set(name, uuid(`orphan:${name}`));
const roomIds = new Map(rows.Rooms.map((row) => [text(row.RoomID), uuid(`room:${text(row.RoomID)}`)]));
const closedAtByRoom = new Map<string, number>();
const deletedAtByRoom = new Map<string, number>();
const lockTimesByUser = new Map<string, number[]>();
for (const row of rows.Logs) {
  const at = date(row["시각"], "Logs.시각");
  if (text(row["유형"]) === "방마감" && text(row["대상"])) closedAtByRoom.set(text(row["대상"]), at);
  if (text(row["유형"]) === "방삭제" && text(row["대상"])) deletedAtByRoom.set(text(row["대상"]), at);
  if (text(row["유형"]) === "계정잠금" && text(row["닉네임"])) lockTimesByUser.set(text(row["닉네임"]), [...(lockTimesByUser.get(text(row["닉네임"])) ?? []), at]);
}

const run = database.transaction(() => {
  database.exec("DELETE FROM sessions; DELETE FROM visits; DELETE FROM room_participants; DELETE FROM penalties; DELETE FROM reports; DELETE FROM audit_logs; DELETE FROM rooms;");
  database.prepare("DELETE FROM users WHERE id NOT IN (SELECT user_id FROM user_roles WHERE role = 'admin')").run();
  const insertUser = database.prepare(`INSERT INTO users (id, legacy_user_id, nickname, password_hash, blog_url, blog_name, account_status, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows.Users) {
    const status = mapAccountStatus(row["계정상태"]);
    const createdAt = date(row["가입일"], "Users.가입일");
    insertUser.run(userIds.get(text(row["닉네임"])), text(row.UserID), text(row["닉네임"]), passwordHash(text(row["비밀번호"])), text(row["블로그주소"]), text(row["블로그명"]), status, optionalDate(row["승인일"], "Users.승인일"), createdAt, createdAt);
  }
  for (const row of rows.Admins) {
    if (retainedByName.has(text(row["아이디"]).toLocaleLowerCase())) continue;
    const createdAt = date(row["생성일"], "Admins.생성일");
    const id = userIds.get(text(row["아이디"]))!;
    insertUser.run(id, `admin:${text(row.AdminID)}`, text(row["아이디"]), passwordHash(text(row["비밀번호"])), `https://legacy-admin.invalid/${encodeURIComponent(text(row["아이디"]))}`, "기존 관리자 계정", "approved", createdAt, createdAt, createdAt);
    database.prepare("INSERT INTO user_roles (user_id, role, granted_at) VALUES (?, 'admin', ?)").run(id, createdAt);
  }
  for (const name of orphanNames) {
    insertUser.run(userIds.get(name), `orphan:${name}`, name, passwordHash(randomBytes(32).toString("base64")), `https://legacy-deleted.invalid/${encodeURIComponent(name)}`, "삭제된 기존 회원", "locked", null, now, now);
  }
  const insertRoom = database.prepare(`INSERT INTO rooms (id, legacy_room_id, name, room_type, creator_id, capacity, join_starts_at, join_ends_at, closes_at, missions_json, room_status, closed_at, deleted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows.Rooms) {
    const start = date(row["시작시간"], "Rooms.시작시간");
    const status = mapRoomStatus(row["상태"]);
    const roomId = text(row.RoomID);
    const joinsEnd = start + number(row["대기시간"], "Rooms.대기시간") * 60_000;
    const closes = joinsEnd + number(row["진행시간"], "Rooms.진행시간") * 60_000;
    insertRoom.run(roomIds.get(roomId), roomId, text(row["방이름"]), mapRoomType(row["유형"]), userIds.get(text(row["생성자"])), number(row["모집인원"], "Rooms.모집인원"), start, joinsEnd, closes, missions(row["미션"]), status, status === "closed" ? (closedAtByRoom.get(roomId) ?? closes) : null, status === "deleted" ? (deletedAtByRoom.get(roomId) ?? date(row["생성일시"], "Rooms.생성일시")) : null, date(row["생성일시"], "Rooms.생성일시"));
  }
  const insertParticipant = database.prepare(`INSERT INTO room_participants (id, legacy_participant_id, room_id, user_id, keyword, link_url, joined_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows.RoomParticipants) {
    const legacy = text(row.ParticipantID);
    insertParticipant.run(uuid(`participant:${legacy}`), legacy, roomIds.get(text(row.RoomID)), userIds.get(text(row["닉네임"])), text(row["개인키워드"]) || null, text(row["개인링크"]) || null, date(row["참여시각"], "RoomParticipants.참여시각"), text(row["완료여부"]) === "완료" ? date(row["완료시각"], "RoomParticipants.완료시각") : null);
  }
  const insertVisit = database.prepare(`INSERT INTO visits (id, legacy_visit_id, legacy_source_id, room_id, visitor_id, target_id, visited_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const visitOccurrences = new Map<string, number>();
  for (const row of rows.Visits) {
    const source = text(row.VisitID); const legacy = sourceKey(source, visitOccurrences);
    insertVisit.run(uuid(`visit:${legacy}`), legacy, source, roomIds.get(text(row.RoomID)), userIds.get(text(row["방문자"])), userIds.get(text(row["방문대상"])), date(row["시각"], "Visits.시각"));
  }
  const insertPenalty = database.prepare(`INSERT INTO penalties (id, legacy_penalty_id, user_id, room_id, reason, status, issued_at, resolved_at, locked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows.Penalties) {
    const legacy = text(row.PenaltyID); const userName = text(row["닉네임"]); const issuedAt = date(row["발생일"], "Penalties.발생일");
    const lockedAt = text(row["잠금처리여부"]) === "Y" ? (lockTimesByUser.get(userName)?.find((time) => time >= issuedAt) ?? issuedAt) : null;
    insertPenalty.run(uuid(`penalty:${legacy}`), legacy, userIds.get(userName), roomIds.get(text(row.RoomID)), mapPenaltyReason(row["사유"]), text(row["해제여부"]) === "해제" ? "resolved" : "unresolved", issuedAt, optionalDate(row["해제일"], "Penalties.해제일"), lockedAt);
  }
  const insertReport = database.prepare(`INSERT INTO reports (id, legacy_report_id, reporter_id, target_id, room_id, reason, report_status, created_at, resolved_at, resolved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows.Reports) {
    const legacy = text(row.ReportID); const reportStatus = mapReportStatus(row["처리상태"]); const createdAt = date(row["접수일시"], "Reports.접수일시");
    insertReport.run(uuid(`report:${legacy}`), legacy, userIds.get(text(row["신고자"])), userIds.get(text(row["대상자"])), text(row.RoomID) ? roomIds.get(text(row.RoomID)) : null, text(row["사유"]), reportStatus, createdAt, reportStatus === "pending" ? null : createdAt, null);
  }
  const insertLog = database.prepare(`INSERT INTO audit_logs (id, legacy_log_id, legacy_source_id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const logOccurrences = new Map<string, number>();
  for (const row of rows.Logs) {
    const source = text(row.LogID); const legacy = sourceKey(source, logOccurrences); const actor = text(row["닉네임"]);
    insertLog.run(uuid(`log:${legacy}`), legacy, source, actor ? userIds.get(actor) ?? null : null, text(row["유형"]), "legacy", text(row["대상"]) || null, JSON.stringify({ detail: text(row["상세"]) }), date(row["시각"], "Logs.시각"));
  }
});
run();
const counts = Object.fromEntries(["users", "rooms", "room_participants", "visits", "penalties", "reports", "audit_logs"].map((table) => [table, (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
const foreignKeys = database.pragma("foreign_key_check") as unknown[];
if (foreignKeys.length) throw new Error(`외래 키 검증 실패: ${JSON.stringify(foreignKeys)}`);
console.log(JSON.stringify({ mode: "applied", source: summary, target: counts, preservedCurrentAdmins: retainedAdmins.map((admin) => admin.nickname), preservedHistoricalUsers: [...orphanNames] }, null, 2));
