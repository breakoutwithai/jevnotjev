import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

// TokenMax map board (issue #238): a tm-share/1 map a visitor chose to share. One SQLite file in the Backstage
// state directory. The request key is the idempotency key and the delete secret; only its sha256 is stored.
// Every number is self-reported by the visitor's own mapper run and is shown as such, never verified here.

export const SHARE_VERSION = "tm-share/1";
export const MAX_MAP_BODY = 4096;
export const MAX_MAP_DELETE_BODY = 1024;
export const BOARD_LIMIT = 100;
export const MAX_SESSIONS = 1_000_000;
export const MAX_CAP_EPISODES = 10_000;
export const MAX_OUTPUT_TOKENS = 1_000_000_000_000;
/** Stored maps at most; a new map past it is refused (maps-full) so one source cannot grow the file or the scan without end. */
export const MAX_MAPS = 10_000;
/** How long board() reuses its last read when nothing was written through this store. */
export const BOARD_CACHE_MS = 5_000;

export type MapLeaf = "days" | "sessions" | "subagent_sessions" | "caps.short" | "caps.weekly" | "caps.unknown" | "output_tokens.claude" | "output_tokens.codex" | "opus_share_pct" | "codex_weekly_pct";
/**
 * tm-share/1 range per leaf, [min, max]. The mapper (skills/tokenmax-map/scripts/map.ts RANGES) and the /maps/ page
 * (site/maps/maps.js BOUNDS) carry the same table; maps.test.ts asserts the three agree.
 */
export const MAP_BOUNDS: Readonly<Record<MapLeaf, readonly [number, number]>> = {
  days: [1, 90],
  sessions: [0, MAX_SESSIONS],
  subagent_sessions: [0, MAX_SESSIONS],
  "caps.short": [0, MAX_CAP_EPISODES],
  "caps.weekly": [0, MAX_CAP_EPISODES],
  "caps.unknown": [0, MAX_CAP_EPISODES],
  "output_tokens.claude": [0, MAX_OUTPUT_TOKENS],
  "output_tokens.codex": [0, MAX_OUTPUT_TOKENS],
  opus_share_pct: [0, 100],
  codex_weekly_pct: [0, 100],
};

const ALIAS = /^[a-z0-9-]{3,24}$/;
const REQUEST_KEY = /^[A-Za-z0-9_-]{22,64}$/;
const SKILL = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const MAP_ID = /^TM-[0-9A-F]{12}$/;

export type MapSources = "claude" | "codex" | "claude+codex";

export interface MapCaps {
  readonly short: number;
  readonly weekly: number;
  readonly unknown: number;
}

export interface MapOutputTokens {
  readonly claude: number;
  readonly codex: number;
}

/** tm-share/1, keys in contract order. */
export interface MapPayload {
  readonly v: typeof SHARE_VERSION;
  readonly skill: string;
  readonly days: number;
  readonly sources: MapSources;
  readonly sessions: number;
  readonly subagent_sessions: number;
  readonly caps: MapCaps;
  readonly output_tokens: MapOutputTokens;
  readonly opus_share_pct: number;
  readonly codex_weekly_pct: number | null;
}

export interface MapInput {
  readonly payload: MapPayload;
  readonly alias: string;
  readonly requestKey: string;
}

export type MapRejectCode = "bad-body" | "bad-alias" | "bad-request-key" | "bad-payload";

export interface MapRejection {
  readonly ok: false;
  readonly code: MapRejectCode;
  readonly field: string;
  readonly reason: string;
}

export type MapCheck = { readonly ok: true; readonly map: MapInput } | { readonly ok: true; readonly trap: true } | MapRejection;

export type MapIssue = { readonly status: "issued" | "replay"; readonly id: string } | { readonly status: "conflict" } | { readonly status: "full" };

export interface MapBoardRow {
  readonly id: string;
  readonly alias: string;
  readonly day: string;
  readonly skill: string;
  readonly days: number;
  readonly sources: MapSources;
  readonly sessions: number;
  readonly subagent_sessions: number;
  readonly caps: MapCaps;
  readonly output_tokens: MapOutputTokens;
  readonly opus_share_pct: number;
  readonly codex_weekly_pct: number | null;
}

export interface MapBoard {
  readonly rows: MapBoardRow[];
  readonly totals: { readonly builders: number; readonly cap_episodes: number; readonly with_weekly_cap: number };
}

class Rejected extends Error {
  constructor(readonly code: MapRejectCode, readonly field: string, readonly reason: string) {
    super(reason);
  }
}

const PAYLOAD_KEYS = ["v", "skill", "days", "sources", "sessions", "subagent_sessions", "caps", "output_tokens", "opus_share_pct", "codex_weekly_pct"];
const CAP_KEYS = ["short", "weekly", "unknown"];
const TOKEN_KEYS = ["claude", "codex"];
const BODY_KEYS = ["payload", "alias", "request_key", "nickname"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own value only: an inherited `constructor` or `__proto__` never counts as present. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? Reflect.get(record, key) : undefined;
}

/** A key name echoed back in a 400 is the sender's own text; keep it short. */
function name(path: string): string {
  return path.length > 64 ? `${path.slice(0, 64)}...` : path;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], prefix: string, code: MapRejectCode): void {
  for (const key of Object.keys(record))
    if (!allowed.includes(key)) throw new Rejected(code, name(`${prefix}${key}`), "unexpected key");
}

function integer(record: Record<string, unknown>, key: string, prefix: string, min: number, max: number): number {
  const value = own(record, key);
  const field = `${prefix}${key}`;
  if (value === undefined) throw new Rejected("bad-payload", field, "missing");
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Rejected("bad-payload", field, "must be a whole number");
  if (value < min || value > max) throw new Rejected("bad-payload", field, `must be ${min} to ${max}`);
  return value === 0 ? 0 : value;
}

function object(record: Record<string, unknown>, key: string, allowed: readonly string[]): Record<string, unknown> {
  const value = own(record, key);
  if (value === undefined) throw new Rejected("bad-payload", key, "missing");
  if (!isRecord(value)) throw new Rejected("bad-payload", key, "must be an object");
  exactKeys(value, allowed, `${key}.`, "bad-payload");
  return value;
}

function sources(value: unknown): MapSources {
  if (value === undefined) throw new Rejected("bad-payload", "sources", "missing");
  if (value === "claude" || value === "codex" || value === "claude+codex") return value;
  throw new Rejected("bad-payload", "sources", "must be claude, codex or claude+codex");
}

/** Validate a tm-share/1 payload; returns a fresh object in contract order or throws Rejected. */
function payloadFrom(value: unknown): MapPayload {
  if (value === undefined) throw new Rejected("bad-payload", "payload", "missing");
  if (!isRecord(value)) throw new Rejected("bad-payload", "payload", "must be a tm-share/1 object");
  exactKeys(value, PAYLOAD_KEYS, "", "bad-payload");
  const v = own(value, "v");
  if (v !== SHARE_VERSION) throw new Rejected("bad-payload", "v", v === undefined ? "missing" : `must be ${SHARE_VERSION}`);
  const skill = own(value, "skill");
  if (typeof skill !== "string" || !SKILL.test(skill)) throw new Rejected("bad-payload", "skill", skill === undefined ? "missing" : "must be a version like 0.3.0");
  const B = MAP_BOUNDS;
  const days = integer(value, "days", "", ...B.days);
  const source = sources(own(value, "sources"));
  const sessions = integer(value, "sessions", "", ...B.sessions);
  const subagents = integer(value, "subagent_sessions", "", ...B.subagent_sessions);
  if (subagents > sessions) throw new Rejected("bad-payload", "subagent_sessions", "must not exceed sessions");
  const caps = object(value, "caps", CAP_KEYS);
  const capShort = integer(caps, "short", "caps.", ...B["caps.short"]);
  const capWeekly = integer(caps, "weekly", "caps.", ...B["caps.weekly"]);
  const capUnknown = integer(caps, "unknown", "caps.", ...B["caps.unknown"]);
  const tokens = object(value, "output_tokens", TOKEN_KEYS);
  const claude = integer(tokens, "claude", "output_tokens.", ...B["output_tokens.claude"]);
  const codex = integer(tokens, "codex", "output_tokens.", ...B["output_tokens.codex"]);
  const opus = integer(value, "opus_share_pct", "", ...B.opus_share_pct);
  if (!Object.prototype.hasOwnProperty.call(value, "codex_weekly_pct")) throw new Rejected("bad-payload", "codex_weekly_pct", "missing");
  const weekly = own(value, "codex_weekly_pct") === null ? null : integer(value, "codex_weekly_pct", "", ...B.codex_weekly_pct);
  return {
    v: SHARE_VERSION,
    skill,
    days,
    sources: source,
    sessions,
    subagent_sessions: subagents,
    caps: { short: capShort, weekly: capWeekly, unknown: capUnknown },
    output_tokens: { claude, codex },
    opus_share_pct: opus,
    codex_weekly_pct: weekly,
  };
}

/**
 * Validate a decoded POST /api/maps body against the contract: exactly payload, alias, request_key and the optional
 * nickname honeypot. A filled honeypot on an otherwise valid body is a trap: answered ok, never stored.
 */
export function checkMap(body: unknown): MapCheck {
  try {
    if (!isRecord(body)) throw new Rejected("bad-body", "body", "must be a JSON object");
    exactKeys(body, BODY_KEYS, "", "bad-body");
    const payload = payloadFrom(own(body, "payload"));
    const alias = own(body, "alias");
    if (typeof alias !== "string" || !ALIAS.test(alias)) throw new Rejected("bad-alias", "alias", alias === undefined ? "missing" : "3 to 24 of a-z, 0-9 and -");
    const key = own(body, "request_key");
    if (typeof key !== "string" || !REQUEST_KEY.test(key)) throw new Rejected("bad-request-key", "request_key", key === undefined ? "missing" : "22 to 64 of A-Z, a-z, 0-9, _ and -");
    const trap = own(body, "nickname");
    if (trap !== undefined && typeof trap !== "string") throw new Rejected("bad-body", "nickname", "must be text");
    if (typeof trap === "string" && trap.trim() !== "") return { ok: true, trap: true };
    return { ok: true, map: { payload, alias, requestKey: key } };
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, code: error.code, field: error.field, reason: error.reason };
    throw error;
  }
}

/** Validate a decoded POST /api/maps/delete body: exactly a map id and a request key, else null. */
export function checkDelete(body: unknown): { readonly id: string; readonly key: string } | null {
  if (!isRecord(body) || Object.keys(body).some((k) => k !== "id" && k !== "key")) return null;
  const id = own(body, "id");
  const key = own(body, "key");
  return typeof id === "string" && MAP_ID.test(id) && typeof key === "string" && REQUEST_KEY.test(key) ? { id, key } : null;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export class MapStore {
  #db: Database;
  #maxRows: number;
  #cached: { readonly at: number; readonly board: MapBoard } | null = null;

  constructor(path: string, options: { readonly maxRows?: number | undefined } = {}) {
    this.#maxRows = options.maxRows ?? MAX_MAPS;
    this.#db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS maps (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      alias TEXT NOT NULL, payload TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL)`);
  }

  /**
   * Stores a map. A key already stored with the same alias and payload returns that map (a retry); the same key with
   * anything different is a conflict and stores nothing. A new map when maxRows are stored is "full". 48-bit ids; an
   * id clash retries.
   */
  issue(input: MapInput, now: number): MapIssue {
    const payload = JSON.stringify(input.payload);
    const keyHash = sha256(input.requestKey);
    const requestHash = sha256(JSON.stringify([input.alias, payload]));
    const prior = (): MapIssue | null => {
      const row = this.#db.query<{ id: string; request_hash: string }, [string]>("SELECT id, request_hash FROM maps WHERE key_hash = ?").get(keyHash);
      if (!row) return null;
      return row.request_hash === requestHash ? { status: "replay", id: row.id } : { status: "conflict" };
    };
    const before = prior();
    if (before) return before;
    if (this.count() >= this.#maxRows) return { status: "full" };
    for (let attempt = 0; ; attempt++) {
      const id = `TM-${randomBytes(6).toString("hex").toUpperCase()}`;
      try {
        this.#db
          .query("INSERT INTO maps (id, created_at, alias, payload, key_hash, request_hash) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, new Date(now).toISOString(), input.alias, payload, keyHash, requestHash);
        this.#cached = null;
        return { status: "issued", id };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/UNIQUE constraint failed: maps\.key_hash/.test(message)) {
          const raced = prior();
          if (raced) return raced;
        }
        if (!/UNIQUE constraint failed: maps\.id/.test(message) || attempt >= 3) throw error;
      }
    }
  }

  /** Deletes a map only when the key hashes to the stored one. False for an unknown id or a wrong key alike. */
  remove(id: string, key: string): boolean {
    const removed = this.#db.query("DELETE FROM maps WHERE id = ? AND key_hash = ?").run(id, sha256(key)).changes === 1;
    if (removed) this.#cached = null;
    return removed;
  }

  /**
   * Newest first, at most BOARD_LIMIT rows; totals over every row. No key hash, no `v`, no request data. With `now`,
   * the last read is reused for BOARD_CACHE_MS unless this store wrote since; without it the table is read every time.
   */
  board(now?: number): MapBoard {
    const hit = this.#cached;
    if (now !== undefined && hit && now >= hit.at && now - hit.at <= BOARD_CACHE_MS) return hit.board;
    const fresh = this.#read();
    if (now !== undefined) this.#cached = { at: now, board: fresh };
    return fresh;
  }

  #read(): MapBoard {
    const stored = this.#db
      .query<{ id: string; created_at: string; alias: string; payload: string }, [number]>("SELECT id, created_at, alias, payload FROM maps ORDER BY created_at DESC, seq DESC LIMIT ?")
      .all(BOARD_LIMIT);
    const rows: MapBoardRow[] = [];
    let parsed: MapPayload;
    for (const row of stored) {
      try { parsed = payloadFrom(JSON.parse(row.payload)); }
      catch { continue; }
      const { v: _v, ...fields } = parsed;
      rows.push({ id: row.id, alias: row.alias, day: row.created_at.slice(0, 10), ...fields });
    }
    const totals = this.#db
      .query<{ builders: number; caps: number | null; weekly: number | null }, []>(
        "SELECT count(*) builders, sum(json_extract(payload, '$.caps.short') + json_extract(payload, '$.caps.weekly') + json_extract(payload, '$.caps.unknown')) caps, sum(json_extract(payload, '$.caps.weekly') > 0) weekly FROM maps",
      )
      .get();
    return { rows, totals: { builders: totals?.builders ?? 0, cap_episodes: totals?.caps ?? 0, with_weekly_cap: totals?.weekly ?? 0 } };
  }

  count(): number {
    return this.#db.query<{ n: number }, []>("SELECT count(*) n FROM maps").get()?.n ?? 0;
  }

  /** The stored payload text, oldest first: what was re-serialised, for audit and tests. */
  rawPayloads(): string[] {
    return this.#db.query<{ payload: string }, []>("SELECT payload FROM maps ORDER BY seq").all().map((r) => r.payload);
  }

  close(): void {
    this.#db.close();
  }
}

/** Map events carry ids and reason codes only, never a request key, alias or payload. */
export type MapLog =
  | { readonly event: "map.stored"; readonly rid: string; readonly id: string; readonly replay: boolean }
  | { readonly event: "map.deleted"; readonly rid: string; readonly id: string }
  | { readonly event: "map.rejected"; readonly rid: string; readonly reason: string };

export function createMapLogger(clock: () => number, sink?: (line: string) => void): (fields: MapLog) => void {
  const output = sink ?? ((line: string) => { process.stdout.write(line + "\n"); });
  return (fields) => {
    try { output(JSON.stringify({ ts: new Date(clock()).toISOString(), ...fields })); }
    catch { /* Logging cannot affect a request. */ }
  };
}
