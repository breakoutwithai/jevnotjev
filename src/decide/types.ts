// The v1 decide contract (docs/prompts jevnotjev-api-mcp, <contract>): typed questions, text cases, arms and run options.
// Pure types; no I/O. Keys are passed in by the caller per call and never appear in any type that is returned.

export interface ChoiceOption {
  readonly name: string;
  readonly definition: string;
}

export interface ScoreLevel {
  readonly label: string;
  readonly description: string;
}

/** One typed question. noul is yes/no; choice is one of 2 to 10 names; score is one of 2 to 10 levels, low to high. */
export type QuestionSpec =
  | { readonly name: string; readonly type: "noul"; readonly instructions: string; readonly criteria?: string }
  | { readonly name: string; readonly type: "choice"; readonly instructions: string; readonly choices: readonly ChoiceOption[] }
  | { readonly name: string; readonly type: "score"; readonly instructions: string; readonly levels: readonly ScoreLevel[] };

/** A non-text input (an image, a file). v1 reads text only, so every arm returns outcome unsupported for it. */
export interface NonTextInput {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface Case {
  readonly id: string;
  readonly input: string | NonTextInput;
}

export interface RuleArm {
  readonly keywords: readonly string[];
  readonly match: string;
  readonly otherwise: string;
}

/** Defaults: jev on, decisions off, llm "claude-haiku-5-5", rule off. */
export interface Arms {
  readonly jev?: boolean;
  readonly decisions?: boolean;
  readonly llm?: string | false;
  readonly rule?: RuleArm | false;
}

export interface RunOptions {
  readonly dryRun?: boolean;
  readonly budgetUsd?: number;
  readonly runId?: string;
  readonly promptVersion?: string;
}

/** The caller's provider keys for this call only. Never stored, logged or written into a row. */
export interface ProviderKeys {
  readonly jev?: string;
  readonly openai?: string;
  readonly anthropic?: string;
}

export interface FetchInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Set when the caller can go away (the HTTP API): a fetch should abort its call when it fires. */
  readonly signal?: AbortSignal;
}

/** The injected fetch: every provider call goes through it, so a test can count and answer calls. */
export type DecideFetch = (url: string, init: FetchInit) => Promise<Response>;

export type ArmName = "jev" | "decisions" | "llm" | "rule";

export type Outcome = "answered" | "refused" | "unsupported" | "error";

/** What a row keeps beside the record columns: never a CSV column, never a key. */
export interface Evidence {
  /** Why a row is not answered: "budget", "missing key: ...", "jev: provider server error (HTTP 500)", ... */
  readonly reason?: string;
  /** Probability per answer name (choice) or level label (score). */
  readonly probabilities?: Readonly<Record<string, number>>;
  /** The provider's numeric score: Jev's level index, Decisions' probability-weighted index. */
  readonly score?: number;
  /** noul / predicate probability of yes. */
  readonly probability?: number;
  /** How many question rows share the one provider call; its cost is split evenly over them. */
  readonly shared_by: number;
  /** The whole call's cost, before the split. */
  readonly call_cost_usd?: number | null;
  readonly http?: number;
  /** llm arm: which transport made the call. */
  readonly transport?: "messages-api" | "claude-cli";
  /** How cost_usd was found when not from usage x the price table. */
  readonly cost_basis?: string;
  /** Set by src/decide/fixture-stamp.ts when the row was answered from a test-only fixture file, not a provider. */
  readonly replayed_fixture?: true;
}

/** One jnj-record/1.2 row per (case, question, arm), plus its evidence. The label is always empty: a model answer is never truth. */
export interface DecideRow {
  readonly format_version: "jnj-record/1.2";
  readonly run_id: string;
  readonly prompt_version: string;
  readonly case_id: string;
  readonly case_input: string;
  readonly question_id: string;
  readonly question: string;
  readonly answer_set: string;
  readonly answerer: ArmName;
  readonly answerer_model: string;
  readonly output: string | null;
  readonly confidence: number | null;
  readonly label: null;
  readonly label_source: null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly cost_usd: number | null;
  readonly latency_ms: number | null;
  readonly price_table_date: string | null;
  readonly outcome: Outcome;
  readonly evidence: Evidence;
}

/** One question's result from an arm, before it becomes a row. */
export interface QuestionResult {
  readonly outcome: Outcome;
  readonly output: string | null;
  readonly confidence: number | null;
  readonly reason?: string;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly score?: number;
  readonly probability?: number;
}

/** A parsed provider response: one result per question (same order as asked) and the call's usage. */
export interface CallResult {
  readonly results: readonly QuestionResult[];
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly http: number;
}
