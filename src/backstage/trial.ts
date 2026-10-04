import { Database } from "bun:sqlite";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface TrialConfig {
  readonly path: string;
  readonly fundedKey: string;
  readonly signingSecret: string;
  /** Operator has verified this bound covers the fixed model and request limits below. */
  readonly pricingVerified: boolean;
  readonly worstCostMicroUsd: number;
  readonly dailyBudgetMicroUsd: number;
  readonly dailyMintLimit: number;
  readonly dailyNetworkMintLimit: number;
  readonly dailyNetworkAttemptLimit: number;
  readonly now?: () => number;
}
export interface TrialInput {
  readonly question: string;
  readonly choices: readonly {
    readonly name: string;
    readonly definition: string;
  }[];
  readonly input: string;
}
export type TrialDenial = {
  readonly kind: "denied";
  readonly code: "trial-unavailable" | "trial-exhausted" | "invalid-request";
};
export type TrialReservation =
  | { readonly kind: "reserved"; readonly reservationId: string }
  | { readonly kind: "replay"; readonly state: string }
  | TrialDenial;
export type TrialSettlement =
  | { readonly kind: "known"; readonly costMicroUsd: number }
  | { readonly kind: "unknown"; readonly code: string }
  | { readonly kind: "pre-dispatch-none" };
interface ReservationRow {
  id: string;
  allowance: string;
  state: string;
  amount: number;
  day: string;
}
const TOKEN_LIFETIME_MS = 90 * 86400000;
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000_000;
}
function small(value: string, limit: number): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= limit &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
/** Bounds apply before reservation. No input, key or answer is written to this ledger. */
export function validTrialInput(input: TrialInput): boolean {
  return (
    small(input.question, 200) &&
    small(input.input, 1000) &&
    input.choices.length === 2 &&
    input.choices.every((c) => small(c.name, 32) && small(c.definition, 200)) &&
    input.choices[0]?.name !== input.choices[1]?.name
  );
}

export class TrialLedger {
  #db: Database;
  #secret: string;
  #clock: () => number;
  #closed = false;
  #prunedDay = "";
  #limits: Pick<
    TrialConfig,
    | "worstCostMicroUsd"
    | "dailyBudgetMicroUsd"
    | "dailyMintLimit"
    | "dailyNetworkMintLimit"
    | "dailyNetworkAttemptLimit"
  >;
  constructor(config: TrialConfig) {
    this.#secret = config.signingSecret;
    this.#clock = config.now ?? Date.now;
    this.#limits = {
      worstCostMicroUsd: config.worstCostMicroUsd,
      dailyBudgetMicroUsd: config.dailyBudgetMicroUsd,
      dailyMintLimit: config.dailyMintLimit,
      dailyNetworkMintLimit: config.dailyNetworkMintLimit,
      dailyNetworkAttemptLimit: config.dailyNetworkAttemptLimit,
    };
    if (
      existsSync(config.path) &&
      (!lstatSync(config.path).isFile() ||
        lstatSync(config.path).isSymbolicLink())
    )
      throw Error("Invalid ledger file");
    this.#db = new Database(config.path, { create: true, strict: true });
    chmodSync(config.path, 0o600);
    try {
      const version = this.#db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (version !== 0 && version !== 1)
        throw Error("Unsupported ledger schema");
      this.#db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
      );
      this.#db
        .transaction(() => {
          if (version === 0) {
            const tables = this.#db
              .query<
                { n: number },
                []
              >("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
              .get()?.n;
            if (tables !== 0) throw Error("Unversioned ledger");
            this.#db
              .exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), held INTEGER NOT NULL); INSERT INTO settings VALUES(1,0);
      CREATE TABLE allowances (id TEXT PRIMARY KEY, network TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE reservations (id TEXT PRIMARY KEY, allowance TEXT NOT NULL REFERENCES allowances(id), request TEXT NOT NULL, state TEXT NOT NULL, amount INTEGER NOT NULL, day TEXT NOT NULL, created INTEGER NOT NULL, code TEXT, UNIQUE(allowance,request));
      CREATE TABLE counters (day TEXT NOT NULL, bucket TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(day,bucket)); PRAGMA user_version=1;`);
          }
          // A process restart cannot prove an in-flight request was uncharged.
          this.#db.exec(
            "UPDATE reservations SET state='held-unknown', code='restart' WHERE state='pending'",
          );
          this.#prune();
        })
        .immediate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  #day() {
    return new Date(this.#clock()).toISOString().slice(0, 10);
  }
  #hash(value: string) {
    return createHmac("sha256", this.#secret).update(value).digest("hex");
  }
  #held() {
    return (
      this.#db
        .query<{ held: number }, []>("SELECT held FROM settings WHERE id=1")
        .get()?.held !== 0
    );
  }
  #count(bucket: string) {
    return (
      this.#db
        .query<
          { n: number },
          [string, string]
        >("SELECT n FROM counters WHERE day=? AND bucket=?")
        .get(this.#day(), bucket)?.n ?? 0
    );
  }
  #increment(bucket: string) {
    this.#db
      .query(
        "INSERT INTO counters(day,bucket,n) VALUES(?,?,1) ON CONFLICT(day,bucket) DO UPDATE SET n=n+1",
      )
      .run(this.#day(), bucket);
  }
  #tokenId(token: string): string | undefined {
    const [id, signature, ...extra] = token.split(".");
    if (
      !id ||
      !signature ||
      extra.length ||
      !/^[a-f0-9-]{36}$/.test(id) ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return;
    const expected = Buffer.from(this.#hash("token:" + id), "hex");
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return;
    return id;
  }
  #prune() {
    this.#prunedDay = this.#day();
    const cutoff = this.#clock() - TOKEN_LIFETIME_MS;
    // Expired tokens cannot reserve again. Keep uncertain spend for explicit reconciliation.
    this.#db
      .query(
        "DELETE FROM reservations WHERE created<? AND state IN ('settled','released')",
      )
      .run(cutoff);
    this.#db
      .query(
        "DELETE FROM allowances WHERE created<? AND NOT EXISTS(SELECT 1 FROM reservations WHERE allowance=allowances.id)",
      )
      .run(cutoff);
    this.#db
      .query("DELETE FROM counters WHERE day<?")
      .run(new Date(cutoff).toISOString().slice(0, 10));
  }
  mint(
    clientAddress: string,
  ): { readonly kind: "minted"; readonly token: string } | TrialDenial {
    try {
      return this.#db
        .transaction(() => {
          if (this.#prunedDay !== this.#day()) this.#prune();
          if (this.#held())
            return {
              kind: "denied",
              code: "trial-unavailable",
            } satisfies TrialDenial;
          if (!small(clientAddress, 128))
            return {
              kind: "denied",
              code: "invalid-request",
            } satisfies TrialDenial;
          const network = this.#hash("network:" + clientAddress);
          if (
            this.#count("mint") >= this.#limits.dailyMintLimit ||
            this.#count("mint:" + network) >= this.#limits.dailyNetworkMintLimit
          )
            return {
              kind: "denied",
              code: "trial-exhausted",
            } satisfies TrialDenial;
          const id = randomUUID();
          this.#db
            .query("INSERT INTO allowances(id,network,created) VALUES(?,?,?)")
            .run(id, network, this.#clock());
          this.#increment("mint");
          this.#increment("mint:" + network);
          return {
            kind: "minted",
            token: id + "." + this.#hash("token:" + id),
          } satisfies { kind: "minted"; token: string };
        })
        .immediate();
    } catch {
      return { kind: "denied", code: "trial-unavailable" };
    }
  }
  reserve(
    token: string,
    idempotencyKey: string,
    input: TrialInput,
  ): TrialReservation {
    try {
      if (
        !validTrialInput(input) ||
        !small(idempotencyKey, 128) ||
        !/^[-A-Za-z0-9_]+$/.test(idempotencyKey)
      )
        return { kind: "denied", code: "invalid-request" };
      const id = this.#tokenId(token);
      if (!id) return { kind: "denied", code: "invalid-request" };
      const requestHash = this.#hash("request:" + idempotencyKey);
      return this.#db
        .transaction(() => {
          const allowance = this.#db
            .query<
              { network: string; created: number; used: number },
              [string]
            >("SELECT network,created,used FROM allowances WHERE id=?")
            .get(id);
          if (
            !allowance ||
            allowance.created + TOKEN_LIFETIME_MS <= this.#clock()
          )
            return {
              kind: "denied",
              code: "trial-exhausted",
            } satisfies TrialDenial;
          const previous = this.#db
            .query<
              ReservationRow,
              [string, string]
            >("SELECT * FROM reservations WHERE allowance=? AND request=?")
            .get(id, requestHash);
          if (previous)
            return {
              kind: "replay",
              state: previous.state,
            } satisfies TrialReservation;
          if (this.#held())
            return {
              kind: "denied",
              code: "trial-unavailable",
            } satisfies TrialDenial;
          if (
            allowance.used ||
            this.spentMicroUsd() + this.#limits.worstCostMicroUsd >
              this.#limits.dailyBudgetMicroUsd ||
            this.#count("attempt:" + allowance.network) >=
              this.#limits.dailyNetworkAttemptLimit
          )
            return {
              kind: "denied",
              code: "trial-exhausted",
            } satisfies TrialDenial;
          const reservationId = randomUUID();
          this.#db
            .query(
              "INSERT INTO reservations(id,allowance,request,state,amount,day,created) VALUES(?,?,?,'pending',?,?,?)",
            )
            .run(
              reservationId,
              id,
              requestHash,
              this.#limits.worstCostMicroUsd,
              this.#day(),
              this.#clock(),
            );
          this.#db.query("UPDATE allowances SET used=1 WHERE id=?").run(id);
          this.#increment("attempt:" + allowance.network);
          return { kind: "reserved", reservationId } satisfies TrialReservation;
        })
        .immediate();
    } catch {
      return { kind: "denied", code: "trial-unavailable" };
    }
  }
  settle(reservationId: string, outcome: TrialSettlement): void {
    this.#db
      .transaction(() => {
        const row = this.#db
          .query<
            ReservationRow,
            [string]
          >("SELECT * FROM reservations WHERE id=?")
          .get(reservationId);
        if (!row) throw Error("Unknown trial reservation");
        if (row.state !== "pending") return; // Neither replay nor late completion can refund a recovered unknown.
        if (outcome.kind === "pre-dispatch-none") {
          this.#db
            .query(
              "UPDATE reservations SET state='released',amount=0,code='pre-dispatch-none' WHERE id=?",
            )
            .run(reservationId);
          this.#db
            .query("UPDATE allowances SET used=0 WHERE id=?")
            .run(row.allowance);
          return;
        }
        if (outcome.kind === "known") {
          if (
            !Number.isSafeInteger(outcome.costMicroUsd) ||
            outcome.costMicroUsd < 0 ||
            outcome.costMicroUsd > 1_000_000_000_000
          )
            throw Error("Invalid micro-USD settlement");
          this.#db
            .query(
              "UPDATE reservations SET state='settled',amount=? WHERE id=?",
            )
            .run(outcome.costMicroUsd, reservationId);
          if (outcome.costMicroUsd > row.amount)
            this.#db.exec("UPDATE settings SET held=1 WHERE id=1");
          return;
        }
        const code = [
          "http-401",
          "http-403",
          "http-429",
          "timeout",
          "stopped",
          "transport-failure",
          "invalid-response",
        ].includes(outcome.code)
          ? outcome.code
          : "unknown";
        this.#db
          .query(
            "UPDATE reservations SET state='held-unknown',code=? WHERE id=?",
          )
          .run(code, reservationId);
        if (["http-401", "http-403", "http-429"].includes(code))
          this.#db.exec("UPDATE settings SET held=1 WHERE id=1");
      })
      .immediate();
  }
  spentMicroUsd(): number {
    return (
      this.#db
        .query<
          { total: number },
          [string]
        >("SELECT coalesce(sum(amount),0) total FROM reservations WHERE day=?")
        .get(this.#day())?.total ?? 0
    );
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }
}
export function openTrial(
  config: TrialConfig | undefined,
):
  | { available: true; ledger: TrialLedger }
  | { available: false; reason: string } {
  if (
    !config ||
    !config.pricingVerified ||
    !isAbsolute(config.path) ||
    !small(config.fundedKey, 512) ||
    config.fundedKey.length < 8 ||
    config.signingSecret.length < 32 ||
    ![
      config.worstCostMicroUsd,
      config.dailyBudgetMicroUsd,
      config.dailyMintLimit,
      config.dailyNetworkMintLimit,
      config.dailyNetworkAttemptLimit,
    ].every(positive) ||
    config.worstCostMicroUsd > config.dailyBudgetMicroUsd
  )
    return {
      available: false,
      reason: "Trial funding configuration is incomplete.",
    };
  try {
    return { available: true, ledger: new TrialLedger(config) };
  } catch {
    return {
      available: false,
      reason: "Trial ledger unavailable or schema unsupported.",
    };
  }
}
