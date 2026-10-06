// The case-by-method view of one question's rows (D12): every case with its llm, rule and jev answer side by side.
// Shared by the result view (scripts/result-view.ts) and the browser loader (src/browser/results-loader.ts), so the
// wording for a missing row, a missing cost and a missing label is written once. Pure: strings and maps only.

import { ARMS, type Arm } from "./metrics.ts";
import type { Row } from "../format/validate.ts";

/** One case: its id and the first row each method gave it (undefined when the file has none). `human` rows are not a method. */
export interface CaseLine {
  readonly caseId: string;
  readonly rows: Readonly<Record<Arm, Row | undefined>>;
}

function text(row: Row, column: string): string {
  return String(row.get(column));
}

/** Cases in file order, one pass over the rows. The first row wins when a method repeats a case. */
export function caseLines(rows: readonly Row[]): CaseLine[] {
  const byCase = new Map<string, Map<string, Row>>();
  for (const row of rows) {
    const caseId = text(row, "case_id");
    const answerer = text(row, "answerer");
    const methods = byCase.get(caseId) ?? new Map<string, Row>();
    if (!methods.has(answerer)) methods.set(answerer, row);
    byCase.set(caseId, methods);
  }
  return [...byCase].map(([caseId, methods]) => ({ caseId, rows: { llm: methods.get("llm"), rule: methods.get("rule"), jev: methods.get("jev") } }));
}

/** One method's answer to one case: output and cost, with the missing cost or label said in words (D12). */
export function caseCell(row: Row | undefined): string {
  if (row === undefined) return "missing";
  const cost = row.get("cost_usd");
  const parts = [text(row, "output"), typeof cost === "number" ? `$${cost.toFixed(6)}` : "cost missing"];
  if (row.get("label") === null) parts.push("unlabelled");
  return parts.join(", ");
}

/**
 * Which methods the label accepts for one case, in llm, rule, jev order: "llm, jev"; "none" when every present
 * method is labelled and none is accepted; "unlabelled" when no present method has a label. A missing method never matches.
 * A method with no label is unknown, not a non-match: it is named ("none among labelled methods; llm unlabelled").
 */
export function matchingMethods(line: CaseLine): string {
  const present = ARMS.flatMap((arm) => {
    const row = line.rows[arm];
    return row === undefined ? [] : [{ arm, label: row.get("label") }];
  });
  if (present.every((p) => p.label === null)) return "unlabelled";
  const accepted = present.filter((p) => p.label === "accept").map((p) => p.arm);
  const unknown = present.filter((p) => p.label === null).map((p) => p.arm);
  const note = unknown.length === 0 ? "" : "; " + unknown.join(", ") + " unlabelled";
  if (accepted.length === 0) return (unknown.length === 0 ? "none" : "none among labelled methods") + note;
  return accepted.join(", ") + note;
}
