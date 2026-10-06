import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const SESSION_TTL_MS = 43_200_000;
export const OAUTH_TTL_MS = 600_000;
const DUMMY_HASH = `scrypt$0123456789abcdef0123456789abcdef$${"00".repeat(64)}`;

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
export function verifyPasswordHash(password: string, stored: string | undefined): boolean {
  const parts = (stored?.startsWith("scrypt$") ? stored : DUMMY_HASH).split("$");
  const salt = parts[1] ?? "";
  const hash = parts[2] ?? "";
  const valid = parts.length === 3 && /^[a-f0-9]{32}$/i.test(salt) && /^[a-f0-9]{128}$/i.test(hash);
  const expected = Buffer.from(valid ? hash : DUMMY_HASH.split("$")[2] ?? "", "hex");
  const actual = scryptSync(password, valid ? salt : "0123456789abcdef0123456789abcdef", 64);
  return Boolean(stored && valid && password) && timingSafeEqual(actual, expected);
}

export interface Operator { readonly email: string; readonly displayName?: string; readonly password_hash?: string }

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

export interface Session { readonly email: string; readonly auth: "password" | "google"; readonly iat: number; readonly exp: number; readonly sid: string }

// Ported from groit apps/booth/server.js:1336-1355 at bb29d8cc; sid adds revocation.
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
      !("auth" in data) || (data.auth !== "google" && data.auth !== "password") ||
      !("iat" in data) || typeof data.iat !== "number" ||
      !("exp" in data) || typeof data.exp !== "number" || !Number.isFinite(data.exp) || data.exp <= now) return null;
    return { email: data.email, sid: data.sid, auth: data.auth, iat: data.iat, exp: data.exp };
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
  private readonly entries = new Map<string, number>();
  constructor(private readonly clock: () => number) {}
  revoke(sid: string, exp: number): void { this.entries.set(sid, exp); }
  has(sid: string): boolean {
    for (const [key, exp] of this.entries) if (exp <= this.clock()) this.entries.delete(key);
    return this.entries.has(sid);
  }
}

interface FailureRecord { count: number; windowStart: number; lockedUntil: number; lockLevel: number }
export class LoginLimiter {
  private readonly emails = new Map<string, FailureRecord>();
  private readonly addresses = new Map<string, FailureRecord>();
  constructor(private readonly clock: () => number) {}
  private record(map: Map<string, FailureRecord>, key: string, threshold: number): FailureRecord {
    const now = this.clock();
    let row = map.get(key);
    if (!row) { row = { count: 0, windowStart: now, lockedUntil: 0, lockLevel: 0 }; map.set(key, row); }
    if (now - row.windowStart >= 900_000) { row.count = 0; row.windowStart = now; }
    if (row.count >= threshold && row.lockedUntil <= now) {
      row.lockLevel++;
      row.lockedUntil = now + Math.min(60_000 * 2 ** (row.lockLevel - 1), 3_600_000);
      row.count = 0;
      row.windowStart = now;
    }
    return row;
  }
  locked(email: string, address: string): boolean {
    return this.record(this.emails, normalizeEmail(email), 5).lockedUntil > this.clock() ||
      this.record(this.addresses, address, 20).lockedUntil > this.clock();
  }
  fail(email: string, address: string): void {
    this.record(this.emails, normalizeEmail(email), 5).count++;
    this.record(this.addresses, address, 20).count++;
  }
  success(email: string): void { this.emails.delete(normalizeEmail(email)); }
}

interface OAuthState { readonly exp: number; readonly next: string }
export class GoogleStates {
  // Pruning and cap ported from groit apps/booth/server.js:1685-1696 at bb29d8cc.
  private readonly entries = new Map<string, OAuthState>();
  constructor(private readonly clock: () => number, private readonly cap = 1000) {}
  start(next: string): string | null {
    for (const [key, value] of this.entries) if (value.exp <= this.clock()) this.entries.delete(key);
    if (this.entries.size >= this.cap) return null;
    const state = randomBytes(24).toString("base64url");
    this.entries.set(state, { exp: this.clock() + OAUTH_TTL_MS, next });
    return state;
  }
  take(state: string, cookieValue: string | undefined): string | null {
    const value = this.entries.get(state);
    this.entries.delete(state);
    return value && value.exp > this.clock() && cookieValue && safeEqual(state, cookieValue) ? value.next : null;
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
