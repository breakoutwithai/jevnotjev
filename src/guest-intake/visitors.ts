// Signed-in visitors (#307): a verified Google account that is not an operator. One row per Google `sub` in the
// existing tickets.sqlite, never in operators.json. The visitor cookie is its own HMAC token over "visitor:" + payload,
// so it never verifies as an operator session (auth.ts inspectSession) and an operator token never verifies here. The
// token carries no email and no sub: every request re-reads the row, and sign-out rotates the row's generation, which
// ends every session of that visitor.
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** New Google accounts admitted before sign-in refuses a new sub; an existing sub still signs in. */
export const MAX_VISITORS = 5000;
export const VISITOR_ID = /^vis_[a-f0-9]{12}$/;

export interface VisitorRow {
  readonly id: string;
  readonly email: string;
  readonly generation: string;
  readonly disabled_at: string | null;
  readonly waitlisted_at: string | null;
}

export type VisitorSignIn =
  | { readonly status: "ok"; readonly id: string; readonly generation: string }
  | { readonly status: "disabled" }
  | { readonly status: "full" };

export interface VisitorToken {
  readonly role: "visitor";
  readonly vid: string;
  readonly iat: number;
  readonly exp: number;
  readonly sid: string;
  readonly gen: string;
}

export class VisitorStore {
  #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL, created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, generation TEXT NOT NULL, disabled_at TEXT, waitlisted_at TEXT)`);
  }

  /** Upsert by sub in one immediate transaction: disabled row refused, a new sub at MAX_VISITORS refused. */
  signIn(sub: string, email: string, now: number): VisitorSignIn {
    const at = new Date(now).toISOString();
    const run = this.#db.transaction((): VisitorSignIn => {
      const row = this.#db.query<{ id: string; generation: string; disabled_at: string | null }, [string]>("SELECT id, generation, disabled_at FROM visitors WHERE google_sub = ?").get(sub);
      if (row) {
        if (row.disabled_at !== null) return { status: "disabled" };
        this.#db.query("UPDATE visitors SET email = ?, last_seen_at = ? WHERE id = ?").run(email, at, row.id);
        return { status: "ok", id: row.id, generation: row.generation };
      }
      if ((this.#db.query<{ n: number }, []>("SELECT count(*) n FROM visitors").get()?.n ?? 0) >= MAX_VISITORS) return { status: "full" };
      const generation = randomBytes(32).toString("hex");
      for (let attempt = 0; ; attempt++) {
        const id = `vis_${randomBytes(6).toString("hex")}`;
        try {
          this.#db
            .query("INSERT INTO visitors (id, google_sub, email, created_at, last_seen_at, generation, disabled_at, waitlisted_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)")
            .run(id, sub, email, at, at, generation);
          return { status: "ok", id, generation };
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (!/UNIQUE constraint failed: visitors\.id/.test(message) || attempt >= 3) throw error;
        }
      }
    });
    return run.immediate();
  }

  get(id: string): VisitorRow | null {
    return this.#db.query<VisitorRow, [string]>("SELECT id, email, generation, disabled_at, waitlisted_at FROM visitors WHERE id = ?").get(id);
  }

  /** Sign-out: a new generation, so every token issued for this visitor stops verifying. */
  rotate(id: string): void {
    this.#db.query("UPDATE visitors SET generation = ? WHERE id = ?").run(randomBytes(32).toString("hex"), id);
  }

  /**
   * Mark a visitor that holds no question as waitlisted (the earliest time is kept) and return its position: 1 plus the
   * other waitlisted, enabled visitors still holding no question, ordered by (waitlisted_at, id), ahead of it. Only the
   * first sighting writes (its own short statement, guarded by `waitlisted_at IS NULL`); every later call is a plain
   * read, so GET /me at the cap takes no write lock.
   */
  waitlist(id: string, now: number): number {
    const row = this.#db.query<{ waitlisted_at: string | null }, [string]>("SELECT waitlisted_at FROM visitors WHERE id = ?").get(id);
    if (row === null) throw new Error("unknown visitor");
    if (row.waitlisted_at === null) this.#db.query("UPDATE visitors SET waitlisted_at = ? WHERE id = ? AND waitlisted_at IS NULL").run(new Date(now).toISOString(), id);
    const ahead = this.#db
      .query<{ n: number }, [string, string]>(`SELECT count(*) n FROM visitors v, visitors me
        WHERE me.id = ? AND v.id <> me.id AND v.waitlisted_at IS NOT NULL AND v.disabled_at IS NULL
          AND (v.waitlisted_at < me.waitlisted_at OR (v.waitlisted_at = me.waitlisted_at AND v.id < ?))
          AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.scope = 'visitor:' || v.id)
          AND NOT EXISTS (SELECT 1 FROM question_tombstones t WHERE t.scope = 'visitor:' || v.id)`)
      .get(id, id)?.n ?? 0;
    return ahead + 1;
  }

  close(): void {
    this.#db.close();
  }
}

/** A 16-hex fingerprint of the row's generation: the token never carries the generation itself. */
export function generationFingerprint(generation: string): string {
  return createHash("sha256").update(generation).digest("hex").slice(0, 16);
}

function mac(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(`visitor:${encoded}`).digest("base64url");
}

export function signVisitorToken(token: VisitorToken, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(token)).toString("base64url");
  return `${encoded}.${mac(encoded, secret)}`;
}

/** The payload of a well-signed, unexpired visitor token, or null. The caller still checks the row and generation. */
export function verifyVisitorToken(value: string, secret: string, now: number): VisitorToken | null {
  if (secret.length < 32) return null;
  const parts = value.split(".");
  const encoded = parts[0];
  const signature = parts[1];
  if (parts.length !== 2 || !encoded || !signature) return null;
  const expected = Buffer.from(mac(encoded, secret));
  const presented = Buffer.from(signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data) ||
      !("role" in data) || data.role !== "visitor" ||
      !("vid" in data) || typeof data.vid !== "string" || !VISITOR_ID.test(data.vid) ||
      !("sid" in data) || typeof data.sid !== "string" || !data.sid ||
      !("gen" in data) || typeof data.gen !== "string" || !/^[a-f0-9]{16}$/.test(data.gen) ||
      !("iat" in data) || typeof data.iat !== "number" ||
      !("exp" in data) || typeof data.exp !== "number" || !Number.isFinite(data.exp)) return null;
    if (data.exp <= now) return null;
    return { role: "visitor", vid: data.vid, iat: data.iat, exp: data.exp, sid: data.sid, gen: data.gen };
  } catch {
    return null;
  }
}

/** `jnj_visitor` on a loopback http origin, else `__Host-jnj_visitor` (same rule as auth.ts cookieName). */
export function visitorCookieName(origin: string): string {
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return `${local ? "" : "__Host-"}jnj_visitor`;
}

export function visitorCookie(origin: string, value: string, maxAge: number): string {
  const name = visitorCookieName(origin);
  return `${name}=${value}; Path=/; HttpOnly${name.startsWith("__Host-") ? "; Secure" : ""}; SameSite=Lax; Max-Age=${maxAge}`;
}
