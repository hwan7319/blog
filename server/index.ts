import Database from "better-sqlite3";
import express from "express";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import cron from "node-cron";
import worker, { type Env } from "../src/index";
import { closeExpiredRooms, lockOverduePenalties } from "../src/activity";

class SqliteStatement {
  #values: unknown[] = [];
  constructor(private readonly database: Database.Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.#values = values; return this; }
  async first<T = Record<string, unknown>>(): Promise<T | null> { return (this.database.prepare(this.sql).get(...this.#values) as T | undefined) ?? null; }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> { return { results: this.database.prepare(this.sql).all(...this.#values) as T[] }; }
  async run(): Promise<{ meta: { changes: number } }> { return { meta: { changes: this.database.prepare(this.sql).run(...this.#values).changes } }; }
}

class SqliteD1 {
  constructor(private readonly database: Database.Database) {}
  prepare(sql: string) { return new SqliteStatement(this.database, sql); }
  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    return this.database.transaction(() => statements.map((statement) => statement.run()))();
  }
}

function applyMigrations(database: Database.Database): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const directory = path.resolve("migrations");
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    if (database.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)) continue;
    database.transaction(() => {
      database.exec(readFileSync(path.join(directory, name), "utf8"));
      database.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    })();
  }
}

function requestFromExpress(request: express.Request): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || ["host", "connection", "content-length"].includes(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = request.method.toUpperCase();
  return new Request(`http://${request.headers.host ?? "localhost"}${request.originalUrl}`, {
    method, headers, body: ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(request.body ?? {}),
  });
}

async function sendWorkerResponse(workerResponse: Response, response: express.Response): Promise<void> {
  workerResponse.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") response.setHeader(name, value);
  });
  const headersWithCookies = workerResponse.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headersWithCookies.getSetCookie
    ? headersWithCookies.getSetCookie()
    : (workerResponse.headers.get("set-cookie") ? [workerResponse.headers.get("set-cookie")!] : []);
  if (cookies.length) response.setHeader("set-cookie", cookies);
  response.status(workerResponse.status).send(Buffer.from(await workerResponse.arrayBuffer()));
}

const dataDirectory = process.env.DATA_DIR ?? path.resolve("data");
if (!existsSync(dataDirectory)) mkdirSync(dataDirectory, { recursive: true });
const database = new Database(path.join(dataDirectory, "blog-poom.sqlite"));
database.pragma("foreign_keys = ON");
database.pragma("journal_mode = WAL");
applyMigrations(database);
const backupDirectory = path.join(dataDirectory, "backups");
if (!existsSync(backupDirectory)) mkdirSync(backupDirectory, { recursive: true });

async function backupDatabase(): Promise<void> {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  await database.backup(path.join(backupDirectory, `blog-poom-${day}.sqlite`));
}
const env = { DB: new SqliteD1(database), BOOTSTRAP_ADMIN_SECRET: process.env.BOOTSTRAP_ADMIN_SECRET } as unknown as Env;

const app = express();
app.disable("x-powered-by");
app.use("/api", express.json({ limit: "64kb" }));
app.use("/api", async (request, response, next) => {
  try { await sendWorkerResponse(await worker.fetch(requestFromExpress(request), env, {} as ExecutionContext), response); }
  catch (error) { next(error); }
});
app.use(express.static(path.resolve("public"), { index: "index.html" }));
app.use((_request, response) => response.sendFile(path.resolve("public/index.html")));
app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "internal_server_error" });
});

cron.schedule("* * * * *", () => void closeExpiredRooms(env).catch(console.error));
cron.schedule("0 0 * * *", () => void lockOverduePenalties(env).catch(console.error), { timezone: "Asia/Seoul" });
cron.schedule("10 0 * * *", () => void backupDatabase().catch(console.error), { timezone: "Asia/Seoul" });
const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => console.log(`blog-poom listening on ${port}`));
