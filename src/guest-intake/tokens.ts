// Bearer tokens kept in the private tickets.sqlite, one table per kind, separate from the decide tokens in
// api-tokens.json:
//
//   guest  jng_  guest_tokens  gtk_ ids  questions:submit questions:read-own   (#253 PR 2, #255)
//   admin  jna_  admin_tokens  atk_ ids  questions:admin                       (#282, operator only)
//
// Each kind accepts only its own prefix, so `jng_`, `jna_` and the decide `^jnj_...$` pattern (api-tokens.ts) refuse
// one another even when a foreign token's hash is planted in the wrong table. Only the sha256 of a token is stored: a
// token is 32 random bytes, so a fast hash is enough, and lookup is by that hash.
//
// Every call re-checks the file and re-reads its row, so a revoke from another instance or process applies to the next
// request. The state directory must be 0700 and the file 0600, owned by this user and not symlinks; anything else, a
// foreign table schema, or a malformed row fails closed. Minting is an operator surface only: nothing here is reachable
// over HTTP. Contract: docs/design/guest-tokens.md.
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

export type AdminScope = "questions:admin";
/** The one scope of an operator token: list, read and reply to every submitted question. No delete or purge. */
export const ADMIN_SCOPES: readonly AdminScope[] = Object.freeze(["questions:admin"]);
export const ADMIN_TOKEN_PREFIX = "jna_";
export const DEFAULT_ADMIN_TTL_MS = 7 * 24 * 60 * 60_000;
export const MIN_ADMIN_TTL_MS = 60 * 60_000;
export const MAX_ADMIN_TTL_MS = 30 * 24 * 60 * 60_000;

export interface TokenRecord<S extends string> {
  readonly id: string;
  readonly label: string;
  readonly created: string;
  readonly expires: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly scopes: readonly S[];
}

export interface Minted<S extends string> {
  /** The bearer token. Returned once; only its hash is stored. */
  readonly token: string;
  readonly record: TokenRecord<S>;
}

export type GuestTokenRecord = TokenRecord<GuestScope>;
export type GuestMinted = Minted<GuestScope>;
export type AdminTokenRecord = TokenRecord<AdminScope>;
export type AdminMinted = Minted<AdminScope>;

/** The verified caller. `tokenId` never changes for the life of the token, rotation included. */
export interface GuestPrincipal {
  readonly tokenId: string;
  readonly scope: `guest:${string}`;
  readonly scopes: readonly GuestScope[];
}

/** The verified operator. Route handlers check `scopes`, not the token's prefix. */
export interface AdminPrincipal {
  readonly tokenId: string;
  readonly scopes: readonly AdminScope[];
}

export interface TokenMintOptions {
  readonly ttlMs?: number;
}
export type GuestMintOptions = TokenMintOptions;

/** Everything that differs between token kinds. The table text for `guest_tokens` is byte-identical to its first release. */
interface TokenKind<S extends string, P> {
  /** For errors: "guest token" or "admin token". */
  readonly noun: string;
  readonly table: "guest_tokens" | "admin_tokens";
  readonly prefix: string;
  readonly idPrefix: "gtk_" | "atk_";
  readonly scopes: readonly S[];
  readonly defaultTtlMs: number;
  readonly minTtlMs: number;
  readonly maxTtlMs: number;
  readonly principal: (id: string) => P;
}

const GUEST_KIND: TokenKind<GuestScope, GuestPrincipal> = {
  noun: "guest token",
  table: "guest_tokens",
  prefix: GUEST_TOKEN_PREFIX,
  idPrefix: "gtk_",
  scopes: GUEST_SCOPES,
  defaultTtlMs: DEFAULT_GUEST_TTL_MS,
  minTtlMs: MIN_GUEST_TTL_MS,
  maxTtlMs: MAX_GUEST_TTL_MS,
  principal: (id) => Object.freeze<GuestPrincipal>({ tokenId: id, scope: `guest:${id}`, scopes: GUEST_SCOPES }),
};

const ADMIN_KIND: TokenKind<AdminScope, AdminPrincipal> = {
  noun: "admin token",
  table: "admin_tokens",
  prefix: ADMIN_TOKEN_PREFIX,
  idPrefix: "atk_",
  scopes: ADMIN_SCOPES,
  defaultTtlMs: DEFAULT_ADMIN_TTL_MS,
  minTtlMs: MIN_ADMIN_TTL_MS,
  maxTtlMs: MAX_ADMIN_TTL_MS,
  principal: (id) => Object.freeze<AdminPrincipal>({ tokenId: id, scopes: ADMIN_SCOPES }),
};

const HEX64 = /^[a-f0-9]{64}$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9 _.@-]{0,62}[A-Za-z0-9_.@-])?$/;
const DATE_MAX = 8_640_000_000_000_000;

function tableSql(table: string, idPrefix: string, scopes: string): string {
  return `CREATE TABLE ${table} (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 16 AND substr(id, 1, 4) = '${idPrefix}' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 64),
  sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR typeof(revoked_at) = 'integer'),
  last_used_at INTEGER CHECK(last_used_at IS NULL OR typeof(last_used_at) = 'integer'),
  scopes TEXT NOT NULL CHECK(scopes = '${scopes}')
)`;
}

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

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function checkLabel(label: string): void {
  if (!LABEL.test(label)) throw new Error("label must be 1 to 64 ASCII characters from [A-Za-z0-9 _.@-], starting with a letter or digit and not ending in a space");
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function checkDir(dir: string, noun: string): void {
  const s = lstatSync(dir);
  if (s.isSymbolicLink()) throw new Error(`${noun} state directory is a symlink: ${dir}`);
  if (!s.isDirectory()) throw new Error(`${noun} state directory is not a directory: ${dir}`);
  if ((s.mode & 0o077) !== 0) throw new Error(`${noun} state directory mode ${octal(s.mode)} is wider than 0700: ${dir}`);
  const uid = currentUid();
  if (uid !== undefined && s.uid !== uid) throw new Error(`${noun} state directory is not owned by this user: ${dir}`);
}

/** The inode of a private regular file at `path`, or null when it does not exist and `required` is false. */
function checkFile(path: string, required: boolean, noun: string): number | null {
  let s;
  try {
    s = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" && !required) return null;
    throw error;
  }
  if (s.isSymbolicLink()) throw new Error(`${noun} state file is a symlink: ${path}`);
  if (!s.isFile()) throw new Error(`${noun} state file is not a regular file: ${path}`);
  if ((s.mode & 0o077) !== 0) throw new Error(`${noun} state file mode ${octal(s.mode)} is wider than 0600: ${path}`);
  const uid = currentUid();
  if (uid !== undefined && s.uid !== uid) throw new Error(`${noun} state file is not owned by this user: ${path}`);
  return s.ino;
}

/** Token lifecycle over one kind's table in tickets.sqlite. Other tables in the file are never read or altered. */
class BearerTokenStore<S extends string, P> {
  readonly #kind: TokenKind<S, P>;
  readonly #path: string;
  readonly #clock: () => number;
  readonly #db: Database;
  readonly #ino: number;
  readonly #header: RegExp;
  readonly #headerLength: number;
  readonly #id: RegExp;
  readonly #scopesText: string;
  readonly #select: string;
  #closed = false;

  constructor(kind: TokenKind<S, P>, path: string, clock: () => number) {
    this.#kind = kind;
    if (!isAbsolute(path)) throw new Error(`${kind.noun} store path must be absolute`);
    this.#path = path;
    this.#clock = clock;
    this.#header = new RegExp(`^Bearer (${kind.prefix}[A-Za-z0-9_-]{43})$`);
    this.#headerLength = "Bearer ".length + kind.prefix.length + 43;
    this.#id = new RegExp(`^${kind.idPrefix}[a-f0-9]{12}$`);
    this.#scopesText = kind.scopes.join(" ");
    this.#select = `SELECT id, label, sha256, created_at, expires_at, revoked_at, last_used_at, scopes FROM ${kind.table}`;
    const table = tableSql(kind.table, kind.idPrefix, this.#scopesText);
    checkDir(dirname(path), kind.noun);
    if (checkFile(path, false, kind.noun) === null) {
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    const ino = checkFile(path, true, kind.noun);
    if (ino === null) throw new Error(`${kind.noun} state file is missing: ${path}`);
    this.#ino = ino;
    this.#db = new Database(path, { readwrite: true, create: false, strict: true });
    try {
      this.#db.exec("PRAGMA busy_timeout=5000;");
      this.#db.exec("PRAGMA journal_mode=WAL;");
      this.#db.exec(table.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
      const stored = this.#db.query<{ sql: unknown }, [string]>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(kind.table);
      if (stored?.sql !== table) throw new Error(`${kind.table} has a schema this release does not recognise`);
      this.#guard();
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
    }
  }

  /** Fails closed unless the directory, file and SQLite sidecars are still private and the file is the one opened. */
  #guard(): void {
    const noun = this.#kind.noun;
    if (this.#closed) throw new Error(`${noun} store is closed`);
    checkDir(dirname(this.#path), noun);
    if (checkFile(this.#path, true, noun) !== this.#ino) throw new Error(`${noun} state file was replaced: ${this.#path}`);
    checkFile(`${this.#path}-wal`, false, noun);
    checkFile(`${this.#path}-shm`, false, noun);
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > DATE_MAX - this.#kind.maxTtlMs) throw new Error("clock returned an invalid time");
    return now;
  }

  #parse(row: Row): Parsed | null {
    const { id, label, sha256: hash, scopes } = row;
    if (typeof id !== "string" || !this.#id.test(id) || typeof label !== "string" || !LABEL.test(label)) return null;
    if (typeof hash !== "string" || !HEX64.test(hash) || scopes !== this.#scopesText) return null;
    const createdAt = time(row.created_at);
    const expiresAt = time(row.expires_at);
    const revokedAt = optionalTime(row.revoked_at);
    const lastUsedAt = optionalTime(row.last_used_at);
    if (createdAt === null || expiresAt === null || expiresAt <= createdAt || revokedAt === false || lastUsedAt === false) return null;
    return { id, label, sha256: hash, createdAt, expiresAt, revokedAt, lastUsedAt };
  }

  #record(p: Parsed): TokenRecord<S> {
    return Object.freeze({
      id: p.id,
      label: p.label,
      created: new Date(p.createdAt).toISOString(),
      expires: new Date(p.expiresAt).toISOString(),
      revokedAt: iso(p.revokedAt),
      lastUsedAt: iso(p.lastUsedAt),
      scopes: this.#kind.scopes,
    });
  }

  #checkId(id: string): void {
    if (!this.#id.test(id)) throw new Error(`id must be ${this.#kind.idPrefix} followed by 12 lowercase hex characters`);
  }

  #ttl(options: TokenMintOptions): number {
    for (const key of Object.keys(options)) if (key !== "ttlMs") throw new Error(`unknown mint option: ${key}`);
    const { defaultTtlMs, minTtlMs, maxTtlMs } = this.#kind;
    const ttl = options.ttlMs ?? defaultTtlMs;
    if (!Number.isSafeInteger(ttl) || ttl < minTtlMs || ttl > maxTtlMs) throw new Error(`ttlMs must be an integer from ${minTtlMs} to ${maxTtlMs}`);
    return ttl;
  }

  #newToken(): string {
    return this.#kind.prefix + randomBytes(32).toString("base64url");
  }

  #row(where: "id" | "sha256", value: string): Row | null {
    return this.#db.query<Row, [string]>(`${this.#select} WHERE ${where} = ?`).get(value);
  }

  /** Operator only. Mints a token for one label; the token is returned once. 48-bit ids; an id clash retries. */
  mint(label: string, options: TokenMintOptions = {}): Minted<S> {
    this.#guard();
    checkLabel(label);
    const ttl = this.#ttl(options);
    const now = this.#now();
    const { table, idPrefix } = this.#kind;
    for (let attempt = 0; ; attempt++) {
      const token = this.#newToken();
      const parsed: Parsed = { id: `${idPrefix}${randomBytes(6).toString("hex")}`, label, sha256: sha256(token), createdAt: now, expiresAt: now + ttl, revokedAt: null, lastUsedAt: null };
      try {
        this.#db
          .query(`INSERT INTO ${table} (id, label, sha256, created_at, expires_at, revoked_at, last_used_at, scopes) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`)
          .run(parsed.id, parsed.label, parsed.sha256, parsed.createdAt, parsed.expiresAt, this.#scopesText);
        return Object.freeze({ token, record: this.#record(parsed) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!message.includes(`UNIQUE constraint failed: ${table}.id`) || attempt >= 3) throw error;
      }
    }
  }

  /**
   * Operator only. Replaces the secret of an existing, unrevoked token (expired is allowed: this is also renewal). The id,
   * label, created time and principal stay; the old secret stops working at once; expiry restarts from now.
   */
  rotate(id: string, options: TokenMintOptions = {}): Minted<S> {
    this.#guard();
    this.#checkId(id);
    const ttl = this.#ttl(options);
    const now = this.#now();
    const token = this.#newToken();
    const { noun, table } = this.#kind;
    const run = this.#db.transaction((): Parsed => {
      const row = this.#row("id", id);
      if (row === null) throw new Error(`${noun} not found: ${id}`);
      const parsed = this.#parse(row);
      if (parsed === null) throw new Error(`${noun} ${id} is malformed`);
      if (parsed.revokedAt !== null) throw new Error(`${noun} ${id} is revoked and cannot be rotated`);
      const next: Parsed = { ...parsed, sha256: sha256(token), expiresAt: now + ttl };
      this.#db.query(`UPDATE ${table} SET sha256 = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL`).run(next.sha256, next.expiresAt, id);
      return next;
    });
    return Object.freeze({ token, record: this.#record(run.immediate()) });
  }

  /**
   * The principal for a valid, unexpired, unrevoked `Authorization: Bearer <prefix>...` header, else null. Valid from
   * created up to, not including, expires. Records last use. Throws only when the state is unsafe or the clock invalid.
   */
  verify(authorization: string | null): P | null {
    const live = this.#live(authorization);
    if (live === null) return null;
    const { parsed, hash, now } = live;
    // Conditional on the same state, so a revoke or rotate that lands between the read and this write wins.
    const touched = this.#db
      .query(`UPDATE ${this.#kind.table} SET last_used_at = ? WHERE id = ? AND sha256 = ? AND revoked_at IS NULL AND created_at <= ? AND expires_at > ?`)
      .run(now, parsed.id, hash, now, now);
    return touched.changes === 1 ? this.#kind.principal(parsed.id) : null;
  }

  /**
   * verify without recording last use: a read only, so it can run inside another connection's write transaction on the
   * same file (where a write would wait on that transaction's lock).
   */
  check(authorization: string | null): P | null {
    const live = this.#live(authorization);
    return live === null ? null : this.#kind.principal(live.parsed.id);
  }

  #live(authorization: string | null): { readonly parsed: Parsed; readonly hash: string; readonly now: number } | null {
    this.#guard();
    if (authorization === null || authorization.length !== this.#headerLength) return null;
    const token = this.#header.exec(authorization)?.[1];
    if (token === undefined) return null;
    const now = this.#now();
    const hash = sha256(token);
    const row = this.#row("sha256", hash);
    const parsed = row === null ? null : this.#parse(row);
    if (parsed === null || parsed.sha256 !== hash) return null;
    if (parsed.revokedAt !== null || now < parsed.createdAt || now >= parsed.expiresAt) return null;
    return { parsed, hash, now };
  }

  /** Metadata for every token, oldest first. Never a hash or a token. A malformed row throws rather than being skipped. */
  list(): readonly TokenRecord<S>[] {
    this.#guard();
    const rows = this.#db.query<Row, []>(`${this.#select} ORDER BY created_at, id`).all();
    const records = rows.map((row) => {
      const parsed = this.#parse(row);
      if (parsed === null) throw new Error(`${this.#kind.table} holds a malformed row`);
      return this.#record(parsed);
    });
    return Object.freeze(records);
  }

  /** Operator only. Revokes by id; idempotent (the first revoke time is kept). Null for an unknown id. Rows it owns stay. */
  revoke(id: string): TokenRecord<S> | null {
    this.#guard();
    this.#checkId(id);
    const now = this.#now();
    const { noun, table } = this.#kind;
    const run = this.#db.transaction((): Parsed | null => {
      this.#db.query(`UPDATE ${table} SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now, id);
      const row = this.#row("id", id);
      if (row === null) return null;
      const parsed = this.#parse(row);
      if (parsed === null) throw new Error(`${noun} ${id} is malformed`);
      return parsed;
    });
    const parsed = run.immediate();
    return parsed === null ? null : this.#record(parsed);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

/** Guest tokens over `guest_tokens`. `path`: absolute path to tickets.sqlite in a 0700 directory; `clock`: epoch ms. */
export class GuestTokenStore extends BearerTokenStore<GuestScope, GuestPrincipal> {
  constructor(path: string, clock: () => number = Date.now) {
    super(GUEST_KIND, path, clock);
  }
}

/** Operator tokens over `admin_tokens` (#282). Same file rules and lifecycle as guest tokens; never accepts jng_ or jnj_. */
export class AdminTokenStore extends BearerTokenStore<AdminScope, AdminPrincipal> {
  constructor(path: string, clock: () => number = Date.now) {
    super(ADMIN_KIND, path, clock);
  }
}
