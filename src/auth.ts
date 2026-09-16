import type { Env } from "./index";

export type PublicUser = {
  id: string;
  nickname: string;
  blogUrl: string;
  blogName: string;
  accountStatus: string;
  approvedAt: number | null;
  createdAt: number;
  roles: string[];
};

type UserRow = {
  id: string;
  nickname: string;
  password_hash: string;
  blog_url: string;
  blog_name: string;
  account_status: string;
  approved_at: number | null;
  created_at: number;
};

const SESSION_COOKIE = "blog_poom_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_ITERATIONS = 210_000;
const encoder = new TextEncoder();

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function error(message: string, status: number): Response {
  return json({ error: message }, { status });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64Url(new Uint8Array(digest));
}

async function passwordHash(password: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBytes = new Uint8Array(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PASSWORD_ITERATIONS },
    material,
    256,
  );
  return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${base64Url(salt)}$${base64Url(new Uint8Array(bits))}`;
}

async function passwordMatches(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, iterations, salt, expected] = storedHash.split("$");
  if (algorithm !== "pbkdf2_sha256" || iterations !== String(PASSWORD_ITERATIONS) || !salt || !expected) return false;
  const calculated = await passwordHash(password, base64UrlBytes(salt));
  const actual = calculated.split("$")[3];
  const expectedBytes = encoder.encode(expected);
  const actualBytes = encoder.encode(actual);
  if (expectedBytes.length !== actualBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) difference |= expectedBytes[index] ^ actualBytes[index];
  return difference === 0;
}

function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function sessionCookie(token: string, request: Request, expiresAt: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}${secure}`;
}

function expiredSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json<unknown>();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function stringValue(body: Record<string, unknown>, name: string): string {
  return typeof body[name] === "string" ? body[name].trim() : "";
}

async function publicUser(env: Env, row: Omit<UserRow, "password_hash"> | UserRow): Promise<PublicUser> {
  const roles = await env.DB.prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY role")
    .bind(row.id)
    .all<{ role: string }>();
  return {
    id: row.id,
    nickname: row.nickname,
    blogUrl: row.blog_url,
    blogName: row.blog_name,
    accountStatus: row.account_status,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    roles: (roles.results ?? []).map((role) => role.role),
  };
}

export async function currentUser(request: Request, env: Env): Promise<PublicUser | null> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Date.now();
  const session = await env.DB.prepare(
    `SELECT u.id, u.nickname, u.blog_url, u.blog_name, u.account_status, u.approved_at, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
  ).bind(tokenHash, now).first<Omit<UserRow, "password_hash">>();
  if (!session) return null;
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(now, tokenHash).run();
  return publicUser(env, session);
}

export async function signup(request: Request, env: Env): Promise<Response> {
  const body = await requestBody(request);
  if (!body) return error("invalid_json", 400);
  const nickname = stringValue(body, "nickname");
  const password = stringValue(body, "password");
  const blogUrl = stringValue(body, "blogUrl");
  const blogName = stringValue(body, "blogName");
  if (nickname.length < 2 || password.length < 4 || !blogName) return error("invalid_signup_fields", 400);
  try {
    const parsedUrl = new URL(blogUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) return error("invalid_blog_url", 400);
  } catch {
    return error("invalid_blog_url", 400);
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, nickname, password_hash, blog_url, blog_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, nickname, await passwordHash(password), blogUrl, blogName, now, now).run();
  } catch (cause) {
    if (cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message)) return error("nickname_or_blog_url_already_exists", 409);
    throw cause;
  }
  await addAuditLog(env, id, "signup_requested", id, { nickname });
  return json({ user: { id, nickname, accountStatus: "pending" } }, { status: 201 });
}

export async function login(request: Request, env: Env): Promise<Response> {
  const body = await requestBody(request);
  if (!body) return error("invalid_json", 400);
  const nickname = stringValue(body, "nickname");
  const password = stringValue(body, "password");
  if (!nickname || !password) return error("nickname_and_password_required", 400);

  const user = await env.DB.prepare(
    "SELECT id, nickname, password_hash, blog_url, blog_name, account_status, approved_at, created_at FROM users WHERE nickname = ? COLLATE NOCASE",
  ).bind(nickname).first<UserRow>();
  if (!user || !(await passwordMatches(password, user.password_hash))) return error("invalid_credentials", 401);
  if (user.account_status === "pending") return error("approval_pending", 403);
  if (user.account_status === "rejected") return error("account_rejected", 403);

  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), user.id, await sha256(token), expiresAt, now, now).run();
  await addAuditLog(env, user.id, "login", user.id);

  const response = json({ user: await publicUser(env, user) });
  response.headers.append("Set-Cookie", sessionCookie(token, request, expiresAt));
  return response;
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) {
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(Date.now(), await sha256(token)).run();
  }
  const response = json({ ok: true });
  response.headers.append("Set-Cookie", expiredSessionCookie(request));
  return response;
}

export async function me(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  return user ? json({ user }) : error("authentication_required", 401);
}

export async function adminMe(request: Request, env: Env): Promise<Response> {
  const user = await requireAdmin(request, env);
  return user instanceof Response ? user : json({ user });
}

export async function requireAdmin(request: Request, env: Env): Promise<PublicUser | Response> {
  const user = await currentUser(request, env);
  if (!user) return error("authentication_required", 401);
  return user.roles.includes("admin") ? user : error("admin_required", 403);
}

async function addAuditLog(env: Env, actorId: string, eventType: string, targetId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_id, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), actorId, eventType, "user", targetId, JSON.stringify(metadata), Date.now()).run();
}
