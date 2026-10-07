export const PROTOCOL_VERSION = "backstage/2";
export type Provider = "jev" | "anthropic" | "openai" | "google" | "xai";
export type RunMode = "jev-only" | "compare";
export type Arm = string;
export type ProviderKeys = Partial<Record<Provider, string>>;
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
export interface GenerationParameters {
  readonly maxOutputTokens: number;
  readonly reasoningEffort: "low" | "none" | null;
  readonly thinking: "adaptive" | "disabled" | null;
}
export interface ModelPricing {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly version: string;
  readonly sourceUrl: string;
}
export interface ModelEntry {
  readonly id: string;
  readonly label: string;
  readonly provider: Provider;
  readonly modelId: string;
  readonly acceptedResponseModelIds: readonly string[];
  readonly parameters: GenerationParameters;
  readonly catalogVersion: string;
  readonly checkedDate: string;
  readonly sourceUrl: string;
  readonly enabled: boolean;
  readonly preview: boolean;
  readonly pricing: ModelPricing | null;
}
export interface SelectedArm {
  readonly catalogEntryId: string;
}
export interface AnswerRequest {
  readonly version: typeof PROTOCOL_VERSION;
  readonly revision: string;
  readonly runId: string;
  readonly caseId: string;
  readonly catalogVersion: string;
  readonly armId: string;
  readonly provider: Provider;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly question: string;
  readonly choices: readonly [Choice, Choice];
  readonly input: string;
  readonly key: string;
}
export interface AttemptEvidence {
  readonly revision: string;
  readonly runId: string;
  readonly caseId: string;
  readonly provider: Provider;
  readonly armId: string;
  readonly catalogVersion: string;
  readonly promptVersion: string;
  readonly requestedModel: string;
  readonly returnedModel: string | null;
  readonly parameters: GenerationParameters;
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly latencyMs: number;
  /** Requested model retained for record-v1 export compatibility. */
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
  /** Jev's per-option probabilities when it returned them (keys = the two choice names); absent or null otherwise. */
  readonly probabilities?: Readonly<Record<string, number>> | null;
}
export interface AnswerFailure extends AttemptEvidence {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly charge: "none" | "unknown" | "known";
}
export type AnswerResult = AnswerSuccess | AnswerFailure;
export interface DispatchError {
  readonly dispatched: false;
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly error: string;
  readonly charge: "none";
}
