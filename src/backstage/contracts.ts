export const PROTOCOL_VERSION = "backstage/1";
export const MODELS = { jev: "jev-1.13.0", llm: "claude-haiku-4-5-20251001" };
export type Provider = "jev" | "llm";
export interface Choice {
  readonly name: string;
  readonly definition: string;
}
export interface Scene {
  readonly question: string;
  readonly choices: readonly [Choice, Choice];
  readonly acceptance: string;
  readonly exclusions: string;
  readonly keywords: readonly string[];
  readonly matchChoice: string;
  readonly otherwiseChoice: string;
  readonly cases: readonly { readonly id: string; readonly input: string }[];
}
export interface AnswerRequest {
  readonly version: typeof PROTOCOL_VERSION;
  readonly runId: string;
  readonly caseId: string;
  readonly question: string;
  readonly choices: readonly [Choice, Choice];
  readonly input: string;
  readonly provider: Provider;
  readonly key: string;
}
export interface AttemptEvidence {
  readonly runId: string;
  readonly caseId: string;
  readonly provider: Provider;
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly latencyMs: number;
  /** Requested pin. A successful result also verifies the returned model matches. */
  readonly model: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costUsd: number | null;
  readonly priceVersion: string;
}
export interface AnswerSuccess extends AttemptEvidence {
  readonly ok: true;
  readonly output: string;
  readonly confidence: number | null;
}
export interface AnswerFailure extends AttemptEvidence {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly charge: "none" | "unknown" | "known";
}
export type AnswerResult = AnswerSuccess | AnswerFailure;
