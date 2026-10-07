import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { isIP } from "node:net";
import { createHash, randomBytes } from "node:crypto";

// The ticket office's lead store: one SQLite file in the Backstage state directory, never in the repo or logs.
// Rows are written only with consent. Retention and deletion are stated on the page (docs/design/ticket-office.md).

export type TicketKind = "show" | "backstage";

export interface TicketInput {
  readonly kind: TicketKind;
  readonly show: string | null;
  readonly email: string;
  readonly website: string | null;
  readonly idea: string | null;
  /** The separate, optional follow-up box; the ticket never depends on it. */
  readonly followUp: boolean;
  /** The page's per-attempt key: a retried submission returns the ticket already issued for it. */
  readonly requestKey: string | null;
}

export type TicketCheck =
  | { readonly ok: true; readonly ticket: TicketInput }
  | { readonly ok: true; readonly trap: true }
  | { readonly ok: false; readonly reason: TicketRejectReason };

export type TicketRejectReason = "no-consent" | "bad-email" | "bad-website" | "bad-show" | "bad-kind" | "bad-idea" | "bad-body" | "bad-request-key";

export type IssueResult =
  | { readonly status: "issued" | "replay"; readonly id: string; readonly kind: TicketKind; readonly show: string | null }
  | { readonly status: "conflict" };

export const MAX_TICKET_BODY = 4096;
export const MAX_IDEA = 280;
export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 10 * 60_000;

// Local part: an RFC 5322 dot-atom (apostrophes allowed, no leading, trailing or doubled dot, no control
// characters). Domain: dot-separated labels of letters, digits and inner hyphens, ending in a 2+ letter TLD.
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
export const HOSTNAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const EMAIL = new RegExp(`^(?=.{1,64}@)${ATOM}(?:\\.${ATOM})*@(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$`);
const REQUEST_KEY = /^[A-Za-z0-9_-]{16,64}$/;
export const MAX_LIMITED_ADDRESSES = 10_000;

function field(body: object, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(body, name) ? Reflect.get(body, name) : undefined;
}

function optionalText(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function website(value: string): boolean {
  if (value.length > 200) return false;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (url.protocol === "https:" || url.protocol === "http:") && (HOSTNAME.test(host) || isIP(host) !== 0);
  } catch {
    return false;
  }
}

/** Validate a decoded request body. A filled honeypot (`nickname`) is accepted and never stored. */
export function checkTicket(body: unknown, shows: ReadonlySet<string>): TicketCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, reason: "bad-body" };
  const trap = optionalText(field(body, "nickname"));
  if (trap !== null) return { ok: true, trap: true };
  if (field(body, "consent") !== true) return { ok: false, reason: "no-consent" };
  const kind = field(body, "kind");
  if (kind !== "show" && kind !== "backstage") return { ok: false, reason: "bad-kind" };
  const email = optionalText(field(body, "email"));
  if (!email || email.length > 254 || !EMAIL.test(email)) return { ok: false, reason: "bad-email" };
  const site = optionalText(field(body, "website"));
  if (site === false || (site !== null && !website(site))) return { ok: false, reason: "bad-website" };
  const idea = optionalText(field(body, "idea"));
  if (idea === false || (idea !== null && idea.length > MAX_IDEA)) return { ok: false, reason: "bad-idea" };
  const key = optionalText(field(body, "request_key"));
  if (key === false || (key !== null && !REQUEST_KEY.test(key))) return { ok: false, reason: "bad-request-key" };
  const show = optionalText(field(body, "show"));
  if (show === false || (kind === "show" && (show === null || !shows.has(show)))) return { ok: false, reason: "bad-show" };
  return { ok: true, ticket: { kind, show: kind === "show" ? show : null, email: email.toLowerCase(), website: kind === "backstage" ? site : null, idea: kind === "backstage" ? idea : null, followUp: field(body, "follow_up") === true, requestKey: key } };
}

export class TicketStore {
  #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('show','backstage')),
      show TEXT, email TEXT NOT NULL, website TEXT, idea TEXT, consent INTEGER NOT NULL CHECK(consent = 1),
      follow_up INTEGER NOT NULL DEFAULT 0 CHECK(follow_up IN (0, 1)), request_key TEXT UNIQUE, request_hash TEXT)`);
  }

  /**
   * Issues a ticket. A request key already stored with the same details returns that ticket as stored (a retry);
   * the same key with different details is a conflict and stores nothing. 48-bit ids; an id clash retries.
   */
  issue(input: TicketInput, now: number): IssueResult {
    const hash = createHash("sha256")
      .update(JSON.stringify([input.kind, input.show, input.email, input.website, input.idea, input.followUp]))
      .digest("hex");
    const prior = (): IssueResult | null => {
      if (!input.requestKey) return null;
      const row = this.#db
        .query<{ id: string; kind: TicketKind; show: string | null; request_hash: string | null }, [string]>("SELECT id, kind, show, request_hash FROM tickets WHERE request_key = ?")
        .get(input.requestKey);
      if (!row) return null;
      return row.request_hash === hash ? { status: "replay", id: row.id, kind: row.kind, show: row.show } : { status: "conflict" };
    };
    const before = prior();
    if (before) return before;
    for (let attempt = 0; ; attempt++) {
      const id = `JNJ-${randomBytes(6).toString("hex").toUpperCase()}`;
      try {
        this.#db
          .query("INSERT INTO tickets (id, created_at, kind, show, email, website, idea, consent, follow_up, request_key, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)")
          .run(id, new Date(now).toISOString(), input.kind, input.show, input.email, input.website, input.idea, input.followUp ? 1 : 0, input.requestKey, input.requestKey ? hash : null);
        return { status: "issued", id, kind: input.kind, show: input.show };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/UNIQUE constraint failed: tickets\.request_key/.test(message)) {
          const raced = prior();
          if (raced) return raced;
        }
        if (!/UNIQUE constraint failed: tickets\.id/.test(message) || attempt >= 3) throw error;
      }
    }
  }

  /** The show stored under a request key: undefined when the key is new, null for a backstage row. */
  showForKey(key: string): string | null | undefined {
    const row = this.#db.query<{ show: string | null }, [string]>("SELECT show FROM tickets WHERE request_key = ?").get(key);
    return row ? row.show : undefined;
  }

  count(): number {
    return this.#db.query<{ n: number }, []>("SELECT count(*) n FROM tickets").get()?.n ?? 0;
  }

  /** Show tickets per show id: the "tickets issued" half of the poster ranking. */
  countsByShow(): Record<string, number> {
    const rows = this.#db.query<{ show: string; n: number }, []>("SELECT show, count(*) n FROM tickets WHERE kind = 'show' AND show IS NOT NULL GROUP BY show").all();
    return Object.fromEntries(rows.map((r) => [r.show, r.n]));
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Fixed-window count per network address. When MAX_LIMITED_ADDRESSES addresses are tracked, expired windows are
 * dropped first; if every tracked window is still active, a new address is refused rather than evicting a limit.
 */
export class TicketLimiter {
  #hits = new Map<string, number[]>();
  constructor(private readonly clock: () => number, private readonly capacity: number = MAX_LIMITED_ADDRESSES) {}

  allow(address: string): boolean {
    const now = this.clock();
    const recent = (this.#hits.get(address) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      this.#hits.set(address, recent);
      return false;
    }
    if (!this.#hits.has(address) && this.#hits.size >= this.capacity) {
      for (const [key, times] of this.#hits) if (times.every((t) => now - t >= RATE_WINDOW_MS)) this.#hits.delete(key);
      if (this.#hits.size >= this.capacity) return false;
    }
    recent.push(now);
    this.#hits.set(address, recent);
    return true;
  }
}
