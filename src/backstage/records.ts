/**
 * The records and spend a Backstage run exports, as pure functions of plain data. BackstageRun (src/backstage/run.ts)
 * writes its export with these and the export checker (src/backstage/export-check.ts) rebuilds an export with them,
 * so the two cannot drift apart.
 */
import { JEV_ARM_ID } from "./catalog.ts";
import { COLUMNS_V1_1, SUGGESTION_COLUMNS } from "../format/validate.ts";

/** Backstage writes jnj-record/1.1 with the blind loop's columns (format/README.md "Blind and final picks"). */
export const EXPORT_COLUMNS: readonly string[] = [...COLUMNS_V1_1, ...SUGGESTION_COLUMNS];

/** The scene fields a records row repeats. `cases` maps case id to input. */
export interface RecordScene {
  readonly promptVersion: string;
  readonly questionId: string;
  readonly question: string;
  readonly choices: readonly string[];
  readonly cases: ReadonlyMap<string, string>;
}
/** One answer's own values. */
export interface RecordAnswer {
  readonly caseId: string;
  readonly provider: string;
  readonly model: string;
  readonly output: string;
  readonly confidence: number | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
}
/** An answer's label and its provenance, as evidence() writes each labels entry; all null when unlabelled. */
export interface RecordLabel {
  readonly label: string | null;
  readonly labelSource: string | null;
  readonly labelledBy: string | null;
  readonly labelledAt: string | null;
  readonly labelBlind: boolean | null;
  readonly labelFinal: string | null;
  readonly suggestionShown: boolean | null;
}

/** One records row, column for column in EXPORT_COLUMNS order. */
export function recordRow(scene: RecordScene, a: RecordAnswer, l: RecordLabel, runId: string): string[] {
  const data: Record<string, string | number | null> = {
    format_version: "jnj-record/1.1",
    run_id: runId,
    prompt_version: scene.promptVersion,
    case_id: a.caseId,
    case_input: scene.cases.get(a.caseId) ?? "",
    question_id: scene.questionId,
    question: scene.question,
    answer_set: scene.choices.join("|"),
    answerer: a.provider === "jev" ? "jev" : a.provider === "rule" ? "rule" : "llm",
    answerer_model: a.model,
    output: a.output,
    confidence: a.confidence,
    label: l.label,
    label_source: l.labelSource,
    tokens_in: a.tokensIn,
    tokens_out: a.tokensOut,
    cost_usd: a.costUsd,
    latency_ms: a.latencyMs,
    labelled_by: l.labelledBy,
    labelled_at: l.labelledAt,
    label_blind: l.labelBlind === null ? null : String(l.labelBlind),
    label_final: l.labelFinal,
    suggestion_shown: l.suggestionShown === null ? null : String(l.suggestionShown),
  };
  return EXPORT_COLUMNS.map((k) => {
    const v = data[k];
    return v === null || v === undefined ? "" : String(v);
  });
}

/** The keyword rule's answer for a case input. */
export function ruleOutput(
  scene: { readonly keywords: readonly string[]; readonly matchChoice: string; readonly otherwiseChoice: string },
  input: string,
): string {
  return scene.keywords.some((k) => input.toLowerCase().includes(k.toLowerCase())) ? scene.matchChoice : scene.otherwiseChoice;
}
/** The fixed values every rule row carries. */
export const RULE_VALUES = Object.freeze({ model: "keywords-v1", confidence: null, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 });

export interface ComparisonPair {
  readonly armId: string;
  readonly runId: string;
  readonly filename: string;
}
/** The comparisons a run exports: one per LLM arm, else the rule, else Jev alone. */
export function comparisonPairs(arms: readonly string[], runId: string): ComparisonPair[] {
  const comparators = arms.filter((id) => id !== JEV_ARM_ID && id !== "rule");
  const ids = comparators.length ? comparators : [arms.includes("rule") ? "rule" : JEV_ARM_ID];
  return ids.map((armId, index) => ({
    armId,
    runId: ids.length === 1 ? runId : runId + "-pair-" + (index + 1),
    filename: "records-" + (index + 1) + ".csv",
  }));
}
/** Whether an answer from `armId` belongs to the comparison against `pairArmId`: Jev and the rule join every pair. */
export function inComparison(armId: string, pairArmId: string): boolean {
  return armId === JEV_ARM_ID || armId === pairArmId || armId === "rule";
}

/** What spend reads from an attempt. `charge` is only set on a failure. */
export interface Charged {
  readonly ok: boolean;
  readonly costUsd: number | null;
  readonly charge?: string | null;
}
export interface Spend {
  readonly knownUsd: number;
  readonly unknown: number;
}
/** Failed attempts: known dollars, plus a count of charges not known and not ruled out. */
export function extraSpend(attempts: readonly Charged[]): Spend {
  let knownUsd = 0,
    unknown = 0;
  for (const a of attempts)
    if (!a.ok) {
      if (a.costUsd !== null) knownUsd += a.costUsd;
      else if (a.charge !== "none") unknown++;
    }
  return { knownUsd, unknown };
}
/** Every attempt once: known dollars, plus a count of answers and charged failures with no known cost. */
export function totalSpend(attempts: readonly Charged[]): Spend {
  let knownUsd = 0,
    unknown = 0;
  for (const a of attempts) {
    if (a.costUsd !== null) knownUsd += a.costUsd;
    else if (a.ok || a.charge !== "none") unknown++;
  }
  return { knownUsd, unknown };
}
