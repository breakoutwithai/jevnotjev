import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, writeFileSync, renameSync, accessSync, constants, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const SESSION_TTL_MS = 43_200_000;
export const OAUTH_TTL_MS = 600_000;
const DUMMY_HASH = `scrypt$0123456789abcdef0123456789abcdef$${"00".repeat(64)}`;
const deriveScrypt = (password: string, salt: string, length: number): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, length, (error, derived) => error ? reject(error) : resolve(derived));
});

// Ported from breakout-research-v3 src/lib/auth/dashboard-access.ts:94-111 at d40a5cc4.
export function sanitizeNextPath(path: string | null | undefined): string {
  if (!path || !/^\/backstage\/(?:[A-Za-z0-9/._-]*)$/.test(path)) return "/backstage/";
  if (path.includes("//") || path.includes("..")) return "/backstage/";
  return path;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// Ported from clearance-dealmarket-v1 storefront/src/lib/admin-auth/csrf.ts:1-45 at 8a640f4.
export function isSameOrigin(request: Request, origin: string): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const sentOrigin = request.headers.get("origin");
  return sentOrigin === null || sentOrigin === origin;
}

// Ported from groit apps/booth/server.js:942-950 at bb29d8cc.
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Ported from groit apps/booth/server.js:1098-1121 at bb29d8cc.
export async function verifyPasswordHash(password: string, stored: string | undefined, derive: (password: string, salt: string, length: number) => Promise<Buffer> = deriveScrypt): Promise<boolean> {
  const parts = (stored?.startsWith("scrypt$") ? stored : DUMMY_HASH).split("$");
  const salt = parts[1] ?? "";
  const hash = parts[2] ?? "";
  const valid = parts.length === 3 && /^[a-f0-9]{32}$/i.test(salt) && /^[a-f0-9]{128}$/i.test(hash);
  const expected = Buffer.from(valid ? hash : DUMMY_HASH.split("$")[2] ?? "", "hex");
  const actual = await derive(password, valid ? salt : "0123456789abcdef0123456789abcdef", 64);
  return Boolean(stored && valid && password) && timingSafeEqual(actual, expected);
}

export interface Operator { readonly email: string; readonly displayName?: string; readonly password_hash?: string }
export function credentialFingerprint(credential: string): string { return createHash("sha256").update(credential).digest("hex").slice(0, 16); }

// Ported from groit apps/booth/server.js:1060-1094 at bb29d8cc. No env or bootstrap fallback.
export class OperatorStore {
  private stamp = "";
  private rows = new Map<string, Operator>();
  constructor(private readonly path: string | undefined) {}
  get(email: string): Operator | undefined {
    if (!this.path) return undefined;
    let stamp = "missing";
    try {
      const stat = statSync(this.path);
      stamp = stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : "invalid";
    } catch { /* Missing file means no operators. */ }
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      this.rows = new Map();
      if (stamp !== "missing" && stamp !== "invalid") {
        try {
          const data: unknown = JSON.parse(readFileSync(this.path, "utf8"));
          if (Array.isArray(data)) for (const value of data) {
            if (typeof value !== "object" || value === null || Array.isArray(value) || !("email" in value) || typeof value.email !== "string") continue;
            const key = normalizeEmail(value.email);
            if (!key || !key.includes("@")) continue;
            const row: Operator = { email: key,
              ...( "displayName" in value && typeof value.displayName === "string" ? { displayName: value.displayName.trim() } : {}),
              ...( "password_hash" in value && typeof value.password_hash === "string" ? { password_hash: value.password_hash.trim() } : {}) };
            this.rows.set(key, row);
          }
        } catch { this.rows.clear(); }
      }
    }
    return this.rows.get(normalizeEmail(email));
  }
}

export interface Session { readonly email: string; readonly auth: "password" | "google"; readonly iat: number; readonly exp: number; readonly sid: string; readonly cred: string }

// Ported from groit apps/booth/server.js:1336-1355 at bb29d8cc; sid and cred add revocation.
export function signSession(session: Session, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifySession(value: string | undefined, secret: string, now: number): Session | null {
  if (!value || !secret) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = createHmac("sha256", secret).update(parts[0]).digest("base64url");
  if (!safeEqual(parts[1], expected)) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data) ||
      !("email" in data) || typeof data.email !== "string" || !data.email ||
      !("sid" in data) || typeof data.sid !== "string" || !data.sid ||
      !("cred" in data) || typeof data.cred !== "string" || !/^[a-f0-9]{16}$/.test(data.cred) ||
      !("auth" in data) || (data.auth !== "google" && data.auth !== "password") ||
      !("iat" in data) || typeof data.iat !== "number" ||
      !("exp" in data) || typeof data.exp !== "number" || !Number.isFinite(data.exp) || data.exp <= now) return null;
    return { email: data.email, sid: data.sid, auth: data.auth, iat: data.iat, exp: data.exp, cred: data.cred };
  } catch { return null; }
}

export function parseCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

// Cookie option shape ported from groit apps/booth/server.js:974-981 at bb29d8cc.
export function cookieName(origin: string, kind: "session" | "oauth"): string {
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return `${local ? "" : "__Host-"}backstage_${kind}`;
}

export function cookie(origin: string, kind: "session" | "oauth", value: string, maxAge: number): string {
  const name = cookieName(origin, kind);
  return `${name}=${value}; Path=/; HttpOnly${name.startsWith("__Host-") ? "; Secure" : ""}; SameSite=Lax; Max-Age=${maxAge}`;
}

export class RevokedSessions {
  private entries = new Map<string, number>();
  private readonly file: string | undefined;
  private readonly rejectBefore: number = 0;
  constructor(private readonly clock: () => number, operatorsPath?: string) {
    if (!operatorsPath) return;
    const directory = dirname(operatorsPath);
    const path = join(directory, "revoked-sessions.json");
    try { accessSync(directory, constants.W_OK); this.file = path; }
    catch { /* An unwritable directory uses memory but existing revocations still load. */ }
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid revocation store");
      let revoked: unknown = raw;
      if ("rejectBefore" in raw || "revoked" in raw) {
        if (!("rejectBefore" in raw) || typeof raw.rejectBefore !== "number" || !Number.isFinite(raw.rejectBefore) || raw.rejectBefore < 0 ||
          !("revoked" in raw) || typeof raw.revoked !== "object" || raw.revoked === null || Array.isArray(raw.revoked))
          throw new Error("Invalid revocation store");
        this.rejectBefore = raw.rejectBefore;
        revoked = raw.revoked;
      }
      if (typeof revoked !== "object" || revoked === null || Array.isArray(revoked)) throw new Error("Invalid revocation store");
      const rows = Object.entries(revoked);
      if (rows.some(([sid, exp]) => !sid || typeof exp !== "number" || !Number.isFinite(exp))) throw new Error("Invalid revocation store");
      for (const [sid, exp] of rows) if (typeof exp === "number" && exp > clock()) this.entries.set(sid, exp);
      if (this.entries.size > 10_000) throw new Error("Revocation store full");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      this.entries.clear();
      this.rejectBefore = clock();
      console.warn("backstage auth: revocation store unavailable; older sessions refused");
    }
  }
  revoke(sid: string, exp: number): void {
    const next = new Map(this.entries);
    next.set(sid, exp);
    for (const [key, expiry] of next) if (expiry <= this.clock()) next.delete(key);
    if (next.size > 10_000) throw new Error("Revocation store full");
    if (!this.file) { this.entries = next; return; }
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try { writeFileSync(temp, JSON.stringify({ rejectBefore: this.rejectBefore, revoked: Object.fromEntries(next) }), { mode: 0o600 }); renameSync(temp, this.file); }
    catch (error) { try { rmSync(temp, { force: true }); } catch { /* The write failure is still reported. */ } throw error; }
    this.entries = next;
  }
  has(sid: string, iat: number): boolean {
    if (iat < this.rejectBefore) return true;
    const exp = this.entries.get(sid);
    if (exp !== undefined && exp <= this.clock()) { this.entries.delete(sid); return false; }
    return exp !== undefined;
  }
}

interface FailureRecord { count: number; windowStart: number; lockedUntil: number; lockLevel: number; lastFailure: number }
export class LoginLimiter {
  private readonly emails = new Map<string, FailureRecord>();
  private readonly addresses = new Map<string, FailureRecord>();
  private readonly pairs = new Map<string, FailureRecord>();
  private failures = 0;
  constructor(private readonly clock: () => number) {}
  sizes(): { emails: number; addresses: number; pairs: number } { return { emails: this.emails.size, addresses: this.addresses.size, pairs: this.pairs.size }; }
  private expired(row: FailureRecord, now: number): boolean {
    return row.lockedUntil <= now && now - row.lastFailure > (row.lockLevel > 0 ? 86_400_000 : 900_000);
  }
  private prune(map: Map<string, FailureRecord>): void {
    const now = this.clock();
    for (const [key, row] of map) if (this.expired(row, now)) map.delete(key);
  }
  canAttempt(email: string, address: string | null): boolean {
    const normalized = normalizeEmail(email);
    const targets: [Map<string, FailureRecord>, string][] = [[this.emails, normalized]];
    if (address !== null) {
      targets.push([this.addresses, address], [this.pairs, `${normalized}\0${address}`]);
    }
    for (const [map, key] of targets) {
      if (map.has(key)) continue;
      if (map.size >= 10_000) this.prune(map);
      if (map.size >= 10_000) return false;
    }
    const now = this.clock();
    for (const [map, key] of targets)
      if (!map.has(key)) map.set(key, { count: 0, windowStart: now, lockedUntil: 0, lockLevel: 0, lastFailure: now });
    return true;
  }
  private record(map: Map<string, FailureRecord>, key: string): FailureRecord {
    const now = this.clock();
    let row = map.get(key);
    if (!row) { row = { count: 0, windowStart: now, lockedUntil: 0, lockLevel: 0, lastFailure: now }; map.set(key, row); }
    if (now - row.lastFailure >= 86_400_000) row.lockLevel = 0;
    if (now - row.windowStart >= 900_000) { row.count = 0; row.windowStart = now; }
    return row;
  }
  private check(map: Map<string, FailureRecord>, key: string): boolean { return (map.get(key)?.lockedUntil ?? 0) > this.clock(); }
  locked(email: string, address: string | null): boolean {
    const normalized = normalizeEmail(email);
    return this.check(this.emails, normalized) || (address !== null && (this.check(this.addresses, address) || this.check(this.pairs, `${normalized}\0${address}`)));
  }
  private failure(map: Map<string, FailureRecord>, key: string, threshold: number, scope: string, email: string, address: string | null, doubling: boolean): void {
    const row = this.record(map, key);
    row.lastFailure = this.clock();
    if (row.lockedUntil > this.clock()) return;
    row.count++;
    if (row.count < threshold) return;
    row.lockLevel = doubling ? row.lockLevel + 1 : 1;
    row.lockedUntil = this.clock() + (doubling ? Math.min(60_000 * 2 ** (row.lockLevel - 1), 3_600_000) : 60_000);
    row.count = 0;
    row.windowStart = this.clock();
    console.warn(`backstage auth: lock ${scope} address=${address ?? "none"} email=${createHash("sha256").update(email).digest("hex").slice(0, 8)}`);
  }
  fail(email: string, address: string | null): boolean {
    if (!this.canAttempt(email, address)) return false;
    const normalized = normalizeEmail(email);
    if (++this.failures % 256 === 0) {
      for (const map of [this.emails, this.addresses, this.pairs])
        this.prune(map);
    }
    this.failure(this.emails, normalized, 100, "email", normalized, address, false);
    if (address !== null) {
      this.failure(this.addresses, address, 20, "address", normalized, address, true);
      this.failure(this.pairs, `${normalized}\0${address}`, 5, "pair", normalized, address, true);
    }
    return true;
  }
  success(email: string, address: string | null): void { if (address !== null) this.pairs.delete(`${normalizeEmail(email)}\0${address}`); }
}

export class GoogleStates {
  constructor(private readonly clock: () => number, private readonly secret: string) {}
  start(next: string): { state: string; nonce: string } {
    const nonce = randomBytes(24).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ n: nonce, exp: this.clock() + OAUTH_TTL_MS, next })).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(`oauth:${payload}`).digest("base64url");
    return { state: `${payload}.${signature}`, nonce };
  }
  take(state: string, cookieValue: string | undefined): string | null {
    const parts = state.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1] || !cookieValue) return null;
    const expected = createHmac("sha256", this.secret).update(`oauth:${parts[0]}`).digest("base64url");
    if (!safeEqual(parts[1], expected)) return null;
    try {
      const value: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value) || !("n" in value) || typeof value.n !== "string" || !("exp" in value) || typeof value.exp !== "number" || value.exp <= this.clock() || !("next" in value) || typeof value.next !== "string" || !safeEqual(value.n, cookieValue)) return null;
      return sanitizeNextPath(value.next);
    } catch { return null; }
  }
}

// Ported from groit apps/booth/server.js:1767-1774 at bb29d8cc.
export function validateGoogleProfile(value: unknown, clientId: string, operators: OperatorStore): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    !("email" in value) || typeof value.email !== "string" || !value.email ||
    !("email_verified" in value) || (value.email_verified !== true && value.email_verified !== "true") ||
    !("aud" in value) || value.aud !== clientId ||
    !("iss" in value) || (value.iss !== "accounts.google.com" && value.iss !== "https://accounts.google.com")) return null;
  const email = normalizeEmail(value.email);
  return operators.get(email) ? email : null;
}
