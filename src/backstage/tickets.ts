import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";

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
}

export type TicketCheck =
  | { readonly ok: true; readonly ticket: TicketInput }
  | { readonly ok: true; readonly trap: true }
  | { readonly ok: false; readonly reason: TicketRejectReason };

export type TicketRejectReason = "no-consent" | "bad-email" | "bad-website" | "bad-show" | "bad-kind" | "bad-idea" | "bad-body";

export const MAX_TICKET_BODY = 4096;
export const MAX_IDEA = 280;
export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 10 * 60_000;

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']+\.[^\s@<>"']{2,}$/u;

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
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
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
  const show = optionalText(field(body, "show"));
  if (show === false || (kind === "show" && (show === null || !shows.has(show)))) return { ok: false, reason: "bad-show" };
  return { ok: true, ticket: { kind, show: kind === "show" ? show : null, email: email.toLowerCase(), website: kind === "backstage" ? site : null, idea: kind === "backstage" ? idea : null, followUp: field(body, "follow_up") === true } };
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
      follow_up INTEGER NOT NULL DEFAULT 0 CHECK(follow_up IN (0, 1)))`);
  }

  issue(input: TicketInput, now: number): string {
    const id = `JNJ-${randomBytes(5).toString("hex").toUpperCase().slice(0, 8)}`;
    this.#db
      .query("INSERT INTO tickets (id, created_at, kind, show, email, website, idea, consent, follow_up) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)")
      .run(id, new Date(now).toISOString(), input.kind, input.show, input.email, input.website, input.idea, input.followUp ? 1 : 0);
    return id;
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

/** Fixed-window count per network address. */
export class TicketLimiter {
  #hits = new Map<string, number[]>();
  constructor(private readonly clock: () => number) {}

  allow(address: string): boolean {
    const now = this.clock();
    const recent = (this.#hits.get(address) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      this.#hits.set(address, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(address, recent);
    if (this.#hits.size > 10_000) this.#hits.delete(this.#hits.keys().next().value ?? "");
    return true;
  }
}
