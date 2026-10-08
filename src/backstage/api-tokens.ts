// Bearer tokens for /api/v1 (OD3): minted by the operator with scripts/api-token-mint.ts, never self-serve. The state file
// holds only the sha256 of each token, so a copy of the file cannot call the API. A token is 32 random bytes, so a fast
// hash is enough (there is nothing to brute-force); the compare is constant-time and visits every stored hash.
//
// State file: JNJ_API_TOKENS_PATH, else $STATE_DIRECTORY/api-tokens.json (systemd), else $HOME/.jevnotjev/api-tokens.json.
// All three are outside the served site/ directory; the server refuses a path inside its static root.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const API_TOKENS_ENV = "JNJ_API_TOKENS_PATH";
export const API_TOKENS_FORMAT = "jnj-api-tokens/1";
export const TOKEN_PREFIX = "jnj_";
const TOKEN = /^jnj_[A-Za-z0-9_-]{43}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const LABEL = /^[A-Za-z0-9 _.@-]{1,64}$/;

export interface StoredToken {
  readonly id: string;
  readonly label: string;
  readonly sha256: string;
  readonly created: string;
}

export interface TokenFile {
  readonly format: typeof API_TOKENS_FORMAT;
  readonly tokens: readonly StoredToken[];
}

/** The state file path: the env override, then systemd's STATE_DIRECTORY, then a per-user dot directory. */
export function apiTokensPath(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env[API_TOKENS_ENV];
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  const state = env.STATE_DIRECTORY;
  if (state !== undefined && state !== "") return join(state, "api-tokens.json");
  return join(homedir(), ".jevnotjev", "api-tokens.json");
}

/** True when `path` is `root` or inside it (the served static directory must never hold the token file). */
export function isInside(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(`${r}${sep}`);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStored(value: unknown): StoredToken | null {
  if (!isRecord(value)) return null;
  const { id, label, sha256, created } = value;
  if (typeof id !== "string" || typeof label !== "string" || typeof sha256 !== "string" || typeof created !== "string") return null;
  return HEX64.test(sha256) ? { id, label, sha256, created } : null;
}

/** Parse a state file. A malformed file is an error (the caller treats it as no tokens), never a partial list. */
export function parseTokenFile(text: string): TokenFile {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || raw.format !== API_TOKENS_FORMAT || !Array.isArray(raw.tokens)) throw new Error(`not a ${API_TOKENS_FORMAT} file`);
  const list: readonly unknown[] = raw.tokens;
  const tokens = list.map(toStored);
  const valid = tokens.filter((t): t is StoredToken => t !== null);
  if (valid.length !== tokens.length) throw new Error(`${API_TOKENS_FORMAT}: a token entry is malformed`);
  return { format: API_TOKENS_FORMAT, tokens: valid };
}

function readTokenFile(path: string): TokenFile {
  if (!existsSync(path)) return { format: API_TOKENS_FORMAT, tokens: [] };
  return parseTokenFile(readFileSync(path, "utf8"));
}

export interface Minted {
  /** The bearer token. Shown once; only its hash is stored. */
  readonly token: string;
  readonly id: string;
  readonly path: string;
}

export interface LockTiming {
  /** How long a mint waits for another mint's lock before it gives up (ms). */
  readonly waitMs: number;
  /** A lock file older than this is from a mint that died, and is taken over (ms). */
  readonly staleMs: number;
}

export const MINT_LOCK: LockTiming = { waitMs: 5_000, staleMs: 30_000 };

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Take `<path>.lock` with an O_EXCL create, retrying until `waitMs`; a lock older than `staleMs` is moved aside and retaken. */
function acquireLock(lock: string, timing: LockTiming): void {
  const deadline = Date.now() + timing.waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > timing.staleMs) {
        // Rename is atomic: of two mints that both see the stale lock, one moves it and the other gets ENOENT.
        const aside = `${lock}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
        renameSync(lock, aside);
        rmSync(aside, { force: true });
        continue;
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`token file is locked by another mint (${lock}); try again`);
    sleepSync(5 + Math.floor(Math.random() * 10));
  }
}

/**
 * Mint a token into the state file. The read-modify-write runs under an exclusive lock file, the new file is written to a
 * temp file and renamed into place, and the directory and file are set to 0700 and 0600 even when they already existed.
 * Returns the token once.
 */
export function mintToken(path: string, label: string, now: Date = new Date(), timing: LockTiming = MINT_LOCK): Minted {
  if (!LABEL.test(label)) throw new Error("label must match [A-Za-z0-9 _.@-]{1,64}");
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lock = `${path}.lock`;
  acquireLock(lock, timing);
  try {
    const current = readTokenFile(path);
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const id = `tok_${randomBytes(6).toString("hex")}`;
    const next: TokenFile = { format: API_TOKENS_FORMAT, tokens: [...current.tokens, { id, label, sha256: hashToken(token), created: now.toISOString() }] };
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
    chmodSync(path, 0o600);
    return { token, id, path };
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Verifies bearer tokens against the state file, re-read when its mtime, size or inode changes (a newly minted token works without a restart). */
export class ApiTokenStore {
  private cachedStamp = "";
  private hashes: readonly Buffer[] = [];
  private ids: readonly string[] = [];

  /** `path` null: no token file is configured, so no token is valid. */
  constructor(private readonly path: string | null) {}

  private load(): void {
    if (this.path === null) return;
    let stamp: string;
    try {
      const s = statSync(this.path);
      stamp = `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      this.hashes = [];
      this.ids = [];
      this.cachedStamp = "";
      return;
    }
    if (stamp === this.cachedStamp) return;
    try {
      const file = readTokenFile(this.path);
      this.hashes = file.tokens.map((t) => Buffer.from(t.sha256, "hex"));
      this.ids = file.tokens.map((t) => t.id);
    } catch {
      this.hashes = [];
      this.ids = [];
    }
    this.cachedStamp = stamp;
  }

  /** The token id for a valid `Authorization: Bearer <token>` header, else null. */
  verify(authorization: string | null): string | null {
    if (authorization === null || !authorization.startsWith("Bearer ")) return null;
    const token = authorization.slice("Bearer ".length).trim();
    if (!TOKEN.test(token)) return null;
    this.load();
    const presented = Buffer.from(hashToken(token), "hex");
    let found: string | null = null;
    // Every stored hash is compared, so the time taken does not say which entry (if any) matched.
    for (let i = 0; i < this.hashes.length; i++) {
      const stored = this.hashes[i];
      if (stored !== undefined && timingSafeEqual(stored, presented) && found === null) found = this.ids[i] ?? null;
    }
    return found;
  }
}
