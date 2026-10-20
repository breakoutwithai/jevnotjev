// Guest question store (#253): three additive tables in the existing tickets.sqlite. The tickets table is never read
// or altered here, so a release without this module opens the same file unchanged.
//
// Idempotency is per server-set scope (`public`, or `guest:<token id>`): a key replays only within its own scope. The raw
// request key is never stored: the row keeps sha256(key) (the status verifier) and a separate tag (anti-replay), and a
// delete moves the tag into a payload-free tombstone in the same transaction that removes the row and its events.
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { canTransition, keyHash, keyTag, QUESTION_LIMITS, requestHash, type QuestionLimits, type QuestionState, type ResponseSource, type Submission } from "./contract.ts";

export type SubmitResult =
  | { readonly status: "issued" | "replay"; readonly id: string; readonly state: QuestionState }
  | { readonly status: "conflict" }
  | { readonly status: "deleted" }
  | { readonly status: "capacity" };

/** What the public status route returns: never the question, the email or the events. */
export interface StatusView {
  readonly id: string;
  readonly state: QuestionState;
  readonly updated_at: string;
  readonly response: string | null;
  readonly response_source: ResponseSource | null;
}

export interface QuestionRow {
  readonly id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly scope: string;
  readonly email: string | null;
  readonly question: string;
  readonly reply_consent: number;
  readonly marketing_consent: number;
  readonly state: QuestionState;
  readonly version: number;
  readonly response: string | null;
  readonly response_source: ResponseSource | null;
  readonly key_tag: string;
}

/** A guest's own row in a list: never the question, an email or events. */
export interface GuestListEntry {
  readonly id: string;
  readonly state: QuestionState;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The longest list a guest gets, newest first. */
export const GUEST_LIST_MAX = 50;

/** `guest:` plus a GuestTokenStore id (tokens.ts): the only guest scope a row can carry. */
const GUEST_SCOPE = /^guest:gtk_[a-f0-9]{12}$/;
/** `visitor:` plus a VisitorStore id (visitors.ts, #307): accepted only by the visitor methods. */
export const VISITOR_SCOPE = /^visitor:vis_[a-f0-9]{12}$/;

function guestScope(scope: string): string {
  if (!GUEST_SCOPE.test(scope)) throw new Error("unknown scope");
  return scope;
}

function visitorScope(scope: string): string {
  if (!VISITOR_SCOPE.test(scope)) throw new Error("unknown scope");
  return scope;
}

/** A visitor submit adds the free-question refusals to the shared statuses. */
export type VisitorSubmitResult = SubmitResult | { readonly status: "one-question" } | { readonly status: "free-slots-used" };

/** Why a visitor cannot ask now, or null when it can. */
export type VisitorStanding = null | "one-question" | "free-slots-used";

/** A visitor's own row: its question and the reply, never the email or events. */
export interface VisitorQuestionView {
  readonly id: string;
  readonly state: QuestionState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly question: string;
  readonly response: string | null;
  readonly response_source: ResponseSource | null;
}

const VISITOR_VIEW_COLUMNS = "id, state, created_at, updated_at, question, response, response_source";

export interface QueueEntry {
  readonly id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly scope: string;
  readonly state: QuestionState;
  readonly version: number;
}

export type ChangeRejectReason = "not-found" | "bad-transition" | "stale-version" | "message-required" | "bad-message";
export type ChangeResult = { readonly ok: true; readonly version: number } | { readonly ok: false; readonly reason: ChangeRejectReason };

export interface OperatorMessage {
  readonly text: string;
  readonly source: ResponseSource;
}

export type DeleteReason = "operator" | "retention";

const STATES_SQL = "'pending_review','needs_info','approved','declined','answered'";
const ROW_COLUMNS = "id, created_at, updated_at, scope, email, question, reply_consent, marketing_consent, state, version, response, response_source, key_tag";

function utcDayStart(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export class QuestionStore {
  #db: Database;
  readonly #limits: QuestionLimits;

  constructor(path: string, limits: Partial<QuestionLimits> = {}) {
    this.#limits = { ...QUESTION_LIMITS, ...limits };
    this.#db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, scope TEXT NOT NULL, email TEXT,
      question TEXT NOT NULL, reply_consent INTEGER NOT NULL CHECK(reply_consent IN (0, 1)),
      marketing_consent INTEGER NOT NULL CHECK(marketing_consent IN (0, 1)),
      state TEXT NOT NULL CHECK(state IN (${STATES_SQL})), version INTEGER NOT NULL,
      response TEXT, response_source TEXT CHECK(response_source IS NULL OR response_source IN ('human_reviewed','template')),
      key_hash TEXT NOT NULL, key_tag TEXT NOT NULL, request_hash TEXT NOT NULL,
      UNIQUE(scope, key_hash), UNIQUE(scope, key_tag))`);
    this.#db.exec("CREATE INDEX IF NOT EXISTS questions_scope_created ON questions (scope, created_at)");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS question_events (
      question_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
      from_state TEXT NOT NULL CHECK(from_state IN (${STATES_SQL})), to_state TEXT NOT NULL CHECK(to_state IN (${STATES_SQL})),
      version INTEGER NOT NULL)`);
    this.#db.exec("CREATE INDEX IF NOT EXISTS question_events_question ON question_events (question_id)");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS question_tombstones (
      scope TEXT NOT NULL, key_tag TEXT NOT NULL, deleted_at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('operator','retention')), PRIMARY KEY (scope, key_tag))`);
  }

  /** Lookup order, in one immediate transaction: tombstone, same-scope key, write quota, cap, insert. */
  submit(scope: string, submission: Submission, now: number): SubmitResult {
    if (scope !== "public") guestScope(scope);
    const tag = keyTag(scope, submission.requestKey);
    const hash = keyHash(submission.requestKey);
    const request = requestHash(scope, submission.email, submission.question, submission.replyConsent, submission.marketingConsent);
    const run = this.#db.transaction((): SubmitResult => {
      if (this.#db.query<{ n: number }, [string, string]>("SELECT count(*) n FROM question_tombstones WHERE scope = ? AND key_tag = ?").get(scope, tag)?.n) return { status: "deleted" };
      const prior = this.#db.query<{ id: string; state: QuestionState; request_hash: string }, [string, string]>("SELECT id, state, request_hash FROM questions WHERE scope = ? AND key_hash = ?").get(scope, hash);
      if (prior) return prior.request_hash === request ? { status: "replay", id: prior.id, state: prior.state } : { status: "conflict" };
      if (this.#overQuota(scope, now)) return { status: "capacity" };
      return this.#insert(scope, submission, hash, tag, request, now);
    });
    return run.immediate();
  }

  /**
   * One immediate transaction, in order: tombstone for the key, same-key replay or conflict, this visitor already holds
   * a question (a row or a tombstone), distinct holders at the free cap, write quota and retention cap, insert.
   */
  visitorSubmit(scope: string, submission: Submission, now: number): VisitorSubmitResult {
    visitorScope(scope);
    const tag = keyTag(scope, submission.requestKey);
    const hash = keyHash(submission.requestKey);
    const request = requestHash(scope, submission.email, submission.question, submission.replyConsent, submission.marketingConsent);
    const run = this.#db.transaction((): VisitorSubmitResult => {
      if (this.#db.query<{ n: number }, [string, string]>("SELECT count(*) n FROM question_tombstones WHERE scope = ? AND key_tag = ?").get(scope, tag)?.n) return { status: "deleted" };
      const prior = this.#db.query<{ id: string; state: QuestionState; request_hash: string }, [string, string]>("SELECT id, state, request_hash FROM questions WHERE scope = ? AND key_hash = ?").get(scope, hash);
      if (prior) return prior.request_hash === request ? { status: "replay", id: prior.id, state: prior.state } : { status: "conflict" };
      if (this.#holds(scope)) return { status: "one-question" };
      if (this.#heldCount() >= this.#limits.freeVisitorSlots) return { status: "free-slots-used" };
      if (this.#overQuota(scope, now)) return { status: "capacity" };
      return this.#insert(scope, submission, hash, tag, request, now);
    });
    return run.immediate();
  }

  /** null when the visitor may ask; "one-question" once it holds one; "free-slots-used" when the free places are taken. */
  visitorStanding(scope: string): VisitorStanding {
    if (this.#holds(visitorScope(scope))) return "one-question";
    return this.#heldCount() >= this.#limits.freeVisitorSlots ? "free-slots-used" : null;
  }

  /** One visitor's own rows, newest first, at most GUEST_LIST_MAX. */
  visitorList(scope: string): VisitorQuestionView[] {
    return this.#db
      .query<VisitorQuestionView, [string, number]>(`SELECT ${VISITOR_VIEW_COLUMNS} FROM questions WHERE scope = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(visitorScope(scope), GUEST_LIST_MAX);
  }

  /** One of the visitor's own rows; another scope's row, a deleted row and an unknown id all read as null. */
  visitorRead(scope: string, id: string): VisitorQuestionView | null {
    return this.#db.query<VisitorQuestionView, [string, string]>(`SELECT ${VISITOR_VIEW_COLUMNS} FROM questions WHERE id = ? AND scope = ?`).get(id, visitorScope(scope));
  }

  /** A row or a tombstone under this scope: deleting a question never frees it. */
  #holds(scope: string): boolean {
    const n = this.#db.query<{ n: number }, [string, string]>("SELECT (SELECT count(*) FROM questions WHERE scope = ?) + (SELECT count(*) FROM question_tombstones WHERE scope = ?) n").get(scope, scope)?.n ?? 0;
    return n > 0;
  }

  /** Distinct visitor scopes holding a question, rows and tombstones together. */
  #heldCount(): number {
    return this.#db
      .query<{ n: number }, []>("SELECT count(*) n FROM (SELECT scope FROM questions WHERE scope LIKE 'visitor:%' UNION SELECT scope FROM question_tombstones WHERE scope LIKE 'visitor:%')")
      .get()?.n ?? 0;
  }

  #insert(scope: string, submission: Submission, hash: string, tag: string, request: string, now: number): SubmitResult {
    const at = new Date(now).toISOString();
    for (let attempt = 0; ; attempt++) {
      const id = `Q-${randomBytes(6).toString("hex").toUpperCase()}`;
      try {
        this.#db
          .query("INSERT INTO questions (id, created_at, updated_at, scope, email, question, reply_consent, marketing_consent, state, version, response, response_source, key_hash, key_tag, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', 1, NULL, NULL, ?, ?, ?)")
          .run(id, at, at, scope, submission.email, submission.question, submission.replyConsent ? 1 : 0, submission.marketingConsent ? 1 : 0, hash, tag, request);
        return { status: "issued", id, state: "pending_review" };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!/UNIQUE constraint failed: questions\.id/.test(message) || attempt >= 3) throw error;
      }
    }
  }

  #overQuota(scope: string, now: number): boolean {
    const count = (sql: string, ...params: string[]): number => this.#db.query<{ n: number }, string[]>(sql).get(...params)?.n ?? 0;
    const recent =
      scope === "public"
        ? count("SELECT count(*) n FROM questions WHERE scope = 'public' AND created_at > ?", new Date(now - this.#limits.publicWindowMs).toISOString())
        : count("SELECT count(*) n FROM questions WHERE scope = ? AND created_at >= ?", scope, utcDayStart(now));
    if (recent >= (scope === "public" ? this.#limits.publicNewPerWindow : this.#limits.guestNewPerDay)) return true;
    return count("SELECT (SELECT count(*) FROM questions) + (SELECT count(*) FROM question_tombstones) n") >= this.#limits.maxRetained;
  }

  /** A public row whose key matches, else null: a guest row, a deleted row and a wrong key all look alike. */
  publicStatus(id: string, key: string): StatusView | null {
    const row = this.#db
      .query<StatusView & { key_hash: string }, [string]>("SELECT id, state, updated_at, response, response_source, key_hash FROM questions WHERE id = ? AND scope = 'public'")
      .get(id);
    const presented = Buffer.from(keyHash(key), "hex");
    const stored = Buffer.from(row?.key_hash ?? "0".repeat(64), "hex");
    if (!timingSafeEqual(stored, presented) || !row) return null;
    return { id: row.id, state: row.state, updated_at: row.updated_at, response: row.response, response_source: row.response_source };
  }

  /** One guest's own rows, newest first, at most GUEST_LIST_MAX. */
  guestList(scope: string): GuestListEntry[] {
    return this.#db
      .query<GuestListEntry, [string, number]>("SELECT id, state, created_at, updated_at FROM questions WHERE scope = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(guestScope(scope), GUEST_LIST_MAX);
  }

  /** One of the guest's own rows; another scope's row, a deleted row and an unknown id all read as null. */
  guestRead(scope: string, id: string): StatusView | null {
    return this.#db
      .query<StatusView, [string, string]>("SELECT id, state, updated_at, response, response_source FROM questions WHERE id = ? AND scope = ?")
      .get(id, guestScope(scope));
  }

  list(): QueueEntry[] {
    return this.#db.query<QueueEntry, []>("SELECT id, created_at, updated_at, scope, state, version FROM questions ORDER BY created_at, id").all();
  }

  show(id: string): QuestionRow | null {
    return this.#db.query<QuestionRow, [string]>(`SELECT ${ROW_COLUMNS} FROM questions WHERE id = ?`).get(id);
  }

  /**
   * Move a row along the state model. needs_info and answered carry an operator message; the others clear it. `guard`
   * runs first inside the write transaction, so nothing another connection writes can land between it and the change;
   * it must only read, and a throw aborts the change.
   */
  transition(id: string, to: QuestionState, version: number, actor: string, now: number, message?: OperatorMessage, guard?: () => void): ChangeResult {
    const run = this.#db.transaction((): ChangeResult => {
      guard?.();
      const row = this.#db.query<{ state: QuestionState; version: number }, [string]>("SELECT state, version FROM questions WHERE id = ?").get(id);
      if (!row) return { ok: false, reason: "not-found" };
      if (!canTransition(row.state, to)) return { ok: false, reason: "bad-transition" };
      if (row.version !== version) return { ok: false, reason: "stale-version" };
      const carries = to === "needs_info" || to === "answered";
      if (carries && message === undefined) return { ok: false, reason: "message-required" };
      const text = carries && message !== undefined ? message.text.trim() : null;
      if (text !== null && (text === "" || [...text].length > this.#limits.maxResponseChars)) return { ok: false, reason: "bad-message" };
      const at = new Date(now).toISOString();
      const next = version + 1;
      this.#db
        .query("UPDATE questions SET state = ?, version = ?, updated_at = ?, response = ?, response_source = ? WHERE id = ? AND version = ?")
        .run(to, next, at, text, text === null ? null : message?.source ?? null, id, version);
      this.#db.query("INSERT INTO question_events (question_id, at, actor, from_state, to_state, version) VALUES (?, ?, ?, ?, ?, ?)").run(id, at, actor, row.state, to, next);
      return { ok: true, version: next };
    });
    return run.immediate();
  }

  answer(id: string, version: number, actor: string, now: number, text: string, source: ResponseSource, guard?: () => void): ChangeResult {
    return this.transition(id, "answered", version, actor, now, { text, source }, guard);
  }

  /** Delete in any state: tombstone in, events and row out, all or nothing. False when there is no such row. */
  remove(id: string, reason: DeleteReason, now: number): boolean {
    const run = this.#db.transaction((): boolean => {
      const row = this.#db.query<{ scope: string; key_tag: string }, [string]>("SELECT scope, key_tag FROM questions WHERE id = ?").get(id);
      if (!row) return false;
      this.#db.query("INSERT INTO question_tombstones (scope, key_tag, deleted_at, reason) VALUES (?, ?, ?, ?)").run(row.scope, row.key_tag, new Date(now).toISOString(), reason);
      this.#db.query("DELETE FROM question_events WHERE question_id = ?").run(id);
      this.#db.query("DELETE FROM questions WHERE id = ?").run(id);
      return true;
    });
    return run.immediate();
  }

  /** Rows created before `cutoff` (ISO); each removed in its own transaction unless `dryRun`. */
  purgeBefore(cutoff: string, reason: DeleteReason, now: number, dryRun: boolean): string[] {
    const ids = this.#db.query<{ id: string }, [string]>("SELECT id FROM questions WHERE created_at < ? ORDER BY created_at, id").all(cutoff).map((r) => r.id);
    if (!dryRun) for (const id of ids) this.remove(id, reason, now);
    return ids;
  }

  counts(): { questions: number; events: number; tombstones: number } {
    const n = (table: string): number => this.#db.query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`).get()?.n ?? 0;
    return { questions: n("questions"), events: n("question_events"), tombstones: n("question_tombstones") };
  }

  close(): void {
    this.#db.close();
  }
}
