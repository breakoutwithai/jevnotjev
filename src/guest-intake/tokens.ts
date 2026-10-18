// Guest bearer tokens (#253 PR 2, #255). A separate store from the decide tokens in api-tokens.json: a `guest_tokens`
// table in the private tickets.sqlite. The `jng_` prefix fails the decide pattern `^jnj_...$` (api-tokens.ts), so a guest
// token cannot call `ask` or `run`, and the guest pattern refuses a `jnj_` token. Only the sha256 of a token is stored:
// a token is 32 random bytes, so a fast hash is enough, and lookup is by that hash.
//
// Every call re-checks the file and re-reads its row, so a revoke from another instance or process applies to the next
// request. The state directory must be 0700 and the file 0600, owned by this user and not symlinks; anything else, a
// foreign table schema, or a malformed row fails closed. Operator surface only: nothing here is reachable over HTTP.
// Contract: docs/design/guest-tokens.md.
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export type GuestScope = "questions:submit" | "questions:read-own";
/** The fixed scopes of every guest token. There is no edit, withdraw or delete scope. */
export const GUEST_SCOPES: readonly GuestScope[] = Object.freeze(["questions:submit", "questions:read-own"]);
export const GUEST_TOKEN_PREFIX = "jng_";
/** Proposed, pending operator approval (spec "Open operator decisions"). */
export const DEFAULT_GUEST_TTL_MS = 14 * 24 * 60 * 60_000;
export const MIN_GUEST_TTL_MS = 60 * 60_000;
export const MAX_GUEST_TTL_MS = 90 * 24 * 60 * 60_000;

export interface GuestTokenRecord {
  readonly id: string;
  readonly label: string;
  readonly created: string;
  readonly expires: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly scopes: readonly GuestScope[];
}

export interface GuestMinted {
  /** The bearer token. Returned once; only its hash is stored. */
  readonly token: string;
  readonly record: GuestTokenRecord;
}

/** The verified caller. `tokenId` never changes for the life of the token, rotation included. */
export interface GuestPrincipal {
  readonly tokenId: string;
  readonly scope: `guest:${string}`;
  readonly scopes: readonly GuestScope[];
}

export interface GuestMintOptions {
  readonly ttlMs?: number;
}

const HEADER = /^Bearer (jng_[A-Za-z0-9_-]{43})$/;
const HEADER_LENGTH = "Bearer ".length + GUEST_TOKEN_PREFIX.length + 43;
const ID = /^gtk_[a-f0-9]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9 _.@-]{0,62}[A-Za-z0-9_.@-])?$/;
const SCOPES_TEXT = GUEST_SCOPES.join(" ");
const MAX_TIME = 8_640_000_000_000_000 - MAX_GUEST_TTL_MS;

const TABLE = `CREATE TABLE guest_tokens (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 16 AND substr(id, 1, 4) = 'gtk_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 64),
  sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR typeof(revoked_at) = 'integer'),
  last_used_at INTEGER CHECK(last_used_at IS NULL OR typeof(last_used_at) = 'integer'),
  scopes TEXT NOT NULL CHECK(scopes = '${SCOPES_TEXT}')
)`;

interface Row {
  readonly id: unknown;
  readonly label: unknown;
  readonly sha256: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly revoked_at: unknown;
  readonly last_used_at: unknown;
  readonly scopes: unknown;
}

interface Parsed {
  readonly id: string;
  readonly label: string;
  readonly sha256: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function time(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function optionalTime(value: unknown): number | null | false {
  if (value === null) return null;
  return time(value) ?? false;
}

function parseRow(row: Row): Parsed | null {
  const { id, label, sha256: hash, scopes } = row;
  if (typeof id !== "string" || !ID.test(id) || typeof label !== "string" || !LABEL.test(label)) return null;
  if (typeof hash !== "string" || !HEX64.test(hash) || scopes !== SCOPES_TEXT) return null;
  const createdAt = time(row.created_at);
  const expiresAt = time(row.expires_at);
  const revokedAt = optionalTime(row.revoked_at);
  const lastUsedAt = optionalTime(row.last_used_at);
  if (createdAt === null || expiresAt === null || expiresAt <= createdAt || revokedAt === false || lastUsedAt === false) return null;
  return { id, label, sha256: hash, createdAt, expiresAt, revokedAt, lastUsedAt };
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function toRecord(p: Parsed): GuestTokenRecord {
  return Object.freeze({
    id: p.id,
    label: p.label,
    created: new Date(p.createdAt).toISOString(),
    expires: new Date(p.expiresAt).toISOString(),
    revokedAt: iso(p.revokedAt),
    lastUsedAt: iso(p.lastUsedAt),
    scopes: GUEST_SCOPES,
  });
}

function principal(id: string): GuestPrincipal {
  const p: GuestPrincipal = { tokenId: id, scope: `guest:${id}`, scopes: GUEST_SCOPES };
  return Object.freeze(p);
}

function checkLabel(label: string): void {
  if (!LABEL.test(label)) throw new Error("label must be 1 to 64 ASCII characters from [A-Za-z0-9 _.@-], starting with a letter or digit and not ending in a space");
}

function checkId(id: string): void {
  if (!ID.test(id)) throw new Error("id must be gtk_ followed by 12 lowercase hex characters");
}

function ttlOf(options: GuestMintOptions): number {
  for (const key of Object.keys(options)) if (key !== "ttlMs") throw new Error(`unknown mint option: ${key}`);
  const ttl = options.ttlMs ?? DEFAULT_GUEST_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < MIN_GUEST_TTL_MS || ttl > MAX_GUEST_TTL_MS) throw new Error(`ttlMs must be an integer from ${MIN_GUEST_TTL_MS} to ${MAX_GUEST_TTL_MS}`);
  return ttl;
}

function newToken(): string {
  return GUEST_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function checkDir(dir: string): void {
  const s = lstatSync(dir);
  if (s.isSymbolicLink()) throw new Error(`guest token state directory is a symlink: ${dir}`);
  if (!s.isDirectory()) throw new Error(`guest token state directory is not a directory: ${dir}`);
  if ((s.mode & 0o077) !== 0) throw new Error(`guest token state directory mode ${octal(s.mode)} is wider than 0700: ${dir}`);
  const uid = currentUid();
  if (uid !== undefined && s.uid !== uid) throw new Error(`guest token state directory is not owned by this user: ${dir}`);
}

/** The inode of a private regular file at `path`, or null when it does not exist and `required` is false. */
function checkFile(path: string, required: boolean): number | null {
  let s;
  try {
    s = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" && !required) return null;
    throw error;
  }
  if (s.isSymbolicLink()) throw new Error(`guest token state file is a symlink: ${path}`);
  if (!s.isFile()) throw new Error(`guest token state file is not a regular file: ${path}`);
  if ((s.mode & 0o077) !== 0) throw new Error(`guest token state file mode ${octal(s.mode)} is wider than 0600: ${path}`);
  const uid = currentUid();
  if (uid !== undefined && s.uid !== uid) throw new Error(`guest token state file is not owned by this user: ${path}`);
  return s.ino;
}

/** Guest token lifecycle over `guest_tokens` in tickets.sqlite. Other tables in the file are never read or altered. */
export class GuestTokenStore {
  readonly #path: string;
  readonly #clock: () => number;
  readonly #db: Database;
  readonly #ino: number;
  #closed = false;

  /** `path`: absolute path to tickets.sqlite in a 0700 directory. `clock`: epoch milliseconds, read on each call. */
  constructor(path: string, clock: () => number = Date.now) {
    if (!isAbsolute(path)) throw new Error("guest token store path must be absolute");
    this.#path = path;
    this.#clock = clock;
    checkDir(dirname(path));
    if (checkFile(path, false) === null) {
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    const ino = checkFile(path, true);
    if (ino === null) throw new Error(`guest token state file is missing: ${path}`);
    this.#ino = ino;
    this.#db = new Database(path, { readwrite: true, create: false, strict: true });
    try {
      this.#db.exec("PRAGMA busy_timeout=5000;");
      this.#db.exec("PRAGMA journal_mode=WAL;");
      this.#db.exec(TABLE.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
      const stored = this.#db.query<{ sql: unknown }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'guest_tokens'").get();
      if (stored?.sql !== TABLE) throw new Error("guest_tokens has a schema this release does not recognise");
      this.#guard();
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
    }
  }

  /** Fails closed unless the directory, file and SQLite sidecars are still private and the file is the one opened. */
  #guard(): void {
    if (this.#closed) throw new Error("guest token store is closed");
    checkDir(dirname(this.#path));
    if (checkFile(this.#path, true) !== this.#ino) throw new Error(`guest token state file was replaced: ${this.#path}`);
    checkFile(`${this.#path}-wal`, false);
    checkFile(`${this.#path}-shm`, false);
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME) throw new Error("clock returned an invalid time");
    return now;
  }

  #row(where: "id" | "sha256", value: string): Row | null {
    return this.#db.query<Row, [string]>(`SELECT id, label, sha256, created_at, expires_at, revoked_at, last_used_at, scopes FROM guest_tokens WHERE ${where} = ?`).get(value);
  }

  /** Operator only. Mints a token for one named guest; the token is returned once. 48-bit ids; an id clash retries. */
  mint(label: string, options: GuestMintOptions = {}): GuestMinted {
    this.#guard();
    checkLabel(label);
    const ttl = ttlOf(options);
    const now = this.#now();
    for (let attempt = 0; ; attempt++) {
      const token = newToken();
      const parsed: Parsed = { id: `gtk_${randomBytes(6).toString("hex")}`, label, sha256: sha256(token), createdAt: now, expiresAt: now + ttl, revokedAt: null, lastUsedAt: null };
      try {
        this.#db
          .query("INSERT INTO guest_tokens (id, label, sha256, created_at, expires_at, revoked_at, last_used_at, scopes) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)")
          .run(parsed.id, parsed.label, parsed.sha256, parsed.createdAt, parsed.expiresAt, SCOPES_TEXT);
        return Object.freeze({ token, record: toRecord(parsed) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!/UNIQUE constraint failed: guest_tokens\.id/.test(message) || attempt >= 3) throw error;
      }
    }
  }

  /**
   * Operator only. Replaces the secret of an existing, unrevoked token (expired is allowed: this is also renewal). The id,
   * label, created time and principal stay; the old secret stops working at once; expiry restarts from now.
   */
  rotate(id: string, options: GuestMintOptions = {}): GuestMinted {
    this.#guard();
    checkId(id);
    const ttl = ttlOf(options);
    const now = this.#now();
    const token = newToken();
    const run = this.#db.transaction((): Parsed => {
      const row = this.#row("id", id);
      if (row === null) throw new Error(`guest token not found: ${id}`);
      const parsed = parseRow(row);
      if (parsed === null) throw new Error(`guest token ${id} is malformed`);
      if (parsed.revokedAt !== null) throw new Error(`guest token ${id} is revoked and cannot be rotated`);
      const next: Parsed = { ...parsed, sha256: sha256(token), expiresAt: now + ttl };
      this.#db.query("UPDATE guest_tokens SET sha256 = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL").run(next.sha256, next.expiresAt, id);
      return next;
    });
    return Object.freeze({ token, record: toRecord(run.immediate()) });
  }

  /**
   * The principal for a valid, unexpired, unrevoked `Authorization: Bearer jng_...` header, else null. Valid from created
   * up to, not including, expires. Records last use. Throws only when the state itself is unsafe or the clock is invalid.
   */
  verify(authorization: string | null): GuestPrincipal | null {
    this.#guard();
    if (authorization === null || authorization.length !== HEADER_LENGTH) return null;
    const token = HEADER.exec(authorization)?.[1];
    if (token === undefined) return null;
    const now = this.#now();
    const hash = sha256(token);
    const row = this.#row("sha256", hash);
    const parsed = row === null ? null : parseRow(row);
    if (parsed === null || parsed.sha256 !== hash) return null;
    if (parsed.revokedAt !== null || now < parsed.createdAt || now >= parsed.expiresAt) return null;
    // Conditional on the same state, so a revoke or rotate that lands between the read and this write wins.
    const touched = this.#db
      .query("UPDATE guest_tokens SET last_used_at = ? WHERE id = ? AND sha256 = ? AND revoked_at IS NULL AND created_at <= ? AND expires_at > ?")
      .run(now, parsed.id, hash, now, now);
    return touched.changes === 1 ? principal(parsed.id) : null;
  }

  /** Metadata for every token, oldest first. Never a hash or a token. A malformed row throws rather than being skipped. */
  list(): readonly GuestTokenRecord[] {
    this.#guard();
    const rows = this.#db.query<Row, []>("SELECT id, label, sha256, created_at, expires_at, revoked_at, last_used_at, scopes FROM guest_tokens ORDER BY created_at, id").all();
    const records = rows.map((row) => {
      const parsed = parseRow(row);
      if (parsed === null) throw new Error("guest_tokens holds a malformed row");
      return toRecord(parsed);
    });
    return Object.freeze(records);
  }

  /** Operator only. Revokes by id; idempotent (the first revoke time is kept). Null for an unknown id. Rows it owns stay. */
  revoke(id: string): GuestTokenRecord | null {
    this.#guard();
    checkId(id);
    const now = this.#now();
    const run = this.#db.transaction((): Parsed | null => {
      this.#db.query("UPDATE guest_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
      const row = this.#row("id", id);
      if (row === null) return null;
      const parsed = parseRow(row);
      if (parsed === null) throw new Error(`guest token ${id} is malformed`);
      return parsed;
    });
    const parsed = run.immediate();
    return parsed === null ? null : toRecord(parsed);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
