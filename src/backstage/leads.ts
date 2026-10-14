import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { normalizeEmail } from "./auth.ts";

export const LINK_TTL_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const PUBLIC_WEBMAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "aol.com", "proton.me", "protonmail.com"]);

export function abuseKey(email: string): { mailbox: string; domain: string; domainLimited: boolean } {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  const domain = normalized.slice(at + 1) === "googlemail.com" ? "gmail.com" : normalized.slice(at + 1);
  const local = normalized.slice(0, at).split("+", 1)[0] ?? "";
  return { mailbox: `${domain === "gmail.com" ? local.replaceAll(".", "") : local}@${domain}`, domain, domainLimited: !PUBLIC_WEBMAIL.has(domain) };
}

function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

/** Lead sign-in tables live in the ticket office database, with only token digests persisted. */
export class LeadStore {
  #db: Database;
  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS sign_in_links (
      id TEXT PRIMARY KEY, token_sha256 TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
      abuse_key TEXT NOT NULL, mail_domain TEXT NOT NULL,
      created INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0, 1)));
      CREATE INDEX IF NOT EXISTS sign_in_links_email_created ON sign_in_links(email, created);
      CREATE INDEX IF NOT EXISTS sign_in_links_created ON sign_in_links(created);
      CREATE INDEX IF NOT EXISTS tickets_email_normalized ON tickets(lower(trim(email)));
      CREATE TABLE IF NOT EXISTS verified_leads (
        email TEXT PRIMARY KEY, verified_at INTEGER NOT NULL, method TEXT NOT NULL CHECK(method IN ('link', 'google')),
        credential_generation TEXT NOT NULL);`);
    const columns = this.#db.query<{ name: string }, []>("PRAGMA table_info(verified_leads)").all();
    if (!columns.some((column) => column.name === "credential_generation")) {
      this.#db.exec("ALTER TABLE verified_leads ADD COLUMN credential_generation TEXT NOT NULL DEFAULT ''");
      this.#db.query("UPDATE verified_leads SET credential_generation = ? WHERE credential_generation = ''").run(randomBytes(32).toString("hex"));
    }
    const linkColumns = this.#db.query<{ name: string }, []>("PRAGMA table_info(sign_in_links)").all();
    if (!linkColumns.some((column) => column.name === "abuse_key")) {
      this.#db.exec("ALTER TABLE sign_in_links ADD COLUMN abuse_key TEXT NOT NULL DEFAULT ''; ALTER TABLE sign_in_links ADD COLUMN mail_domain TEXT NOT NULL DEFAULT ''");
      for (const row of this.#db.query<{ id: string; email: string }, []>("SELECT id, email FROM sign_in_links").all()) {
        const key = abuseKey(row.email);
        this.#db.query("UPDATE sign_in_links SET abuse_key = ?, mail_domain = ? WHERE id = ?").run(key.mailbox, key.domain, row.id);
      }
    }
    this.#db.exec("CREATE INDEX IF NOT EXISTS sign_in_links_abuse_created ON sign_in_links(abuse_key, created); CREATE INDEX IF NOT EXISTS sign_in_links_domain_created ON sign_in_links(mail_domain, created);");
  }
  hasTicket(email: string): boolean {
    return this.#db.query<{ present: number }, [string]>("SELECT 1 present FROM tickets WHERE lower(trim(email)) = ? LIMIT 1").get(normalizeEmail(email)) !== null;
  }
  isVerifiedLead(email: string): boolean {
    const normalized = normalizeEmail(email);
    return this.hasTicket(normalized) && this.#db.query<{ present: number }, [string]>("SELECT 1 present FROM verified_leads WHERE email = ?").get(normalized) !== null;
  }
  verifiedCredential(email: string): string | null {
    const normalized = normalizeEmail(email);
    if (!this.hasTicket(normalized)) return null;
    return this.#db.query<{ credential_generation: string }, [string]>("SELECT credential_generation FROM verified_leads WHERE email = ?").get(normalized)?.credential_generation ?? null;
  }
  /** Sync admission and insert serialize before the network send in the single Bun process. */
  mint(email: string, now: number, dailyLimit: number, domainDailyLimit: number): string | null {
    const normalized = normalizeEmail(email);
    const key = abuseKey(normalized);
    const hourly = this.#db.query<{ n: number }, [string, number]>("SELECT count(*) n FROM sign_in_links WHERE abuse_key = ? AND created > ?").get(key.mailbox, now - HOUR_MS)?.n ?? 0;
    const domainDaily = key.domainLimited ? this.#db.query<{ n: number }, [string, number]>("SELECT count(*) n FROM sign_in_links WHERE mail_domain = ? AND created > ?").get(key.domain, now - DAY_MS)?.n ?? 0 : 0;
    const daily = this.#db.query<{ n: number }, [number]>("SELECT count(*) n FROM sign_in_links WHERE created > ?").get(now - DAY_MS)?.n ?? 0;
    if (hourly >= 3 || domainDaily >= domainDailyLimit || daily >= dailyLimit) return null;
    const token = randomBytes(32).toString("base64url");
    // The row counts against limits immediately. It stays unusable until delivery succeeds.
    this.#db.query("INSERT INTO sign_in_links (id, token_sha256, email, abuse_key, mail_domain, created, expires, used) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
      .run(randomBytes(16).toString("hex"), tokenHash(token), normalized, key.mailbox, key.domain, now, now + LINK_TTL_MS);
    return token;
  }
  activate(token: string): boolean {
    return this.#db.query("UPDATE sign_in_links SET used = 0 WHERE token_sha256 = ? AND used = 1").run(tokenHash(token)).changes === 1;
  }
  pendingEmail(token: string, now: number): string | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.#db.query<{ email: string }, [string, number]>("SELECT email FROM sign_in_links WHERE token_sha256 = ? AND used = 0 AND expires > ?").get(tokenHash(token), now)?.email ?? null;
  }
  /** The write itself is the single-use gate. Only its winner receives an email. */
  consume(token: string, now: number): string | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = tokenHash(token);
    const changed = this.#db.query("UPDATE sign_in_links SET used = 1 WHERE token_sha256 = ? AND used = 0 AND expires > ?").run(hash, now);
    if (changed.changes !== 1) return null;
    const row = this.#db.query<{ email: string }, [string]>("SELECT email FROM sign_in_links WHERE token_sha256 = ?").get(hash);
    return row?.email ?? null;
  }
  verify(email: string, method: "link" | "google", now: number): string {
    const normalized = normalizeEmail(email);
    this.#db.query("INSERT INTO verified_leads (email, verified_at, method, credential_generation) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET verified_at = excluded.verified_at, method = excluded.method")
      .run(normalized, now, method, randomBytes(32).toString("hex"));
    const credential = this.verifiedCredential(normalized);
    if (!credential) throw new Error("Verified lead credential unavailable");
    return credential;
  }
  close(): void { this.#db.close(); }
}
