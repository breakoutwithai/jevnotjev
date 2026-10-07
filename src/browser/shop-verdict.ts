// The Little Shop page's verdict: the recorded run's records.csv, labelled with the visitor's calls, read by the
// same validate, metrics and verdict code the command line uses. Pure: no Node or Bun APIs, so it is bundled for
// the browser (site/little-shop/verdict.js, built by scripts/uc13/little-shop.ts).

import { fileSeed } from "../core/calc.ts";
import { cohortMetrics, cohorts } from "../core/metrics.ts";
import { verdict, type Condition, type VerdictName } from "../core/verdict.ts";
import { formatRows, readDictRows } from "../format/csv.ts";
import { PROVENANCE_COLUMNS, validate } from "../format/validate.ts";

export type Call = "answer" | "hand_off";

export interface ShopVerdict {
  readonly verdict: VerdictName;
  readonly condition: Condition;
  /** One line for the screen, as verdict.ts words it. */
  readonly reason: string;
  /** Paired labelled Jev and LLM cases the verdict read. */
  readonly paired: number;
}

function isCall(v: unknown): v is Call {
  return v === "answer" || v === "hand_off";
}

/**
 * records.csv with the visitor's calls as human labels: a called case's rows are accept when the output equals the
 * call and reject otherwise; every other row is unlabelled, whatever the source file held.
 */
export function labelRecords(csvText: string, calls: Readonly<Record<string, unknown>>): string {
  const { header, rows } = readDictRows(csvText);
  if (header === null) throw new Error("records.csv has no header");
  const at = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`records.csv has no ${name} column`);
    return i;
  };
  const caseAt = at("case_id");
  const outputAt = at("output");
  const labelAt = at("label");
  const sourceAt = at("label_source");
  const versionAt = at("format_version");
  for (const { fields, line } of rows) {
    if (fields.length !== header.length) throw new Error(`records.csv line ${line}: ${fields.length} fields, header has ${header.length}`);
    const version = fields[versionAt] ?? "";
    if (version !== "jnj-record/1" && version !== "jnj-record/1.1") {
      throw new Error(`records.csv line ${line}: format_version ${JSON.stringify(version)} is not jnj-record/1 or jnj-record/1.1`);
    }
  }
  const known = new Set(rows.map(({ fields }) => fields[caseAt] ?? ""));
  const own = Object.keys(calls);
  for (const id of own) {
    const call: unknown = calls[id];
    if (!known.has(id)) throw new Error(`no case ${JSON.stringify(id)} in records.csv`);
    if (!isCall(call)) throw new Error(`${id}: call ${JSON.stringify(call)} is not answer or hand_off`);
  }
  const callOf = (id: string): Call | null => {
    if (!Object.prototype.hasOwnProperty.call(calls, id)) return null;
    const c: unknown = calls[id];
    return isCall(c) ? c : null;
  };
  // The visitor's calls are a person's picks, held in the page and never exported: they are written as jnj-record/1
  // human labels. A jnj-record/1.1 source (its labels AI-drafted and approved) loses its provenance columns here, so
  // no recorded labeller or time is carried onto a visitor's call, and the labelled text matches a /1 source's.
  const keep = header.flatMap((name, i) => (PROVENANCE_COLUMNS.includes(name) ? [] : [i]));
  const out = rows.map(({ fields }) => {
    const row = [...fields];
    const call = callOf(fields[caseAt] ?? "");
    row[versionAt] = "jnj-record/1";
    row[labelAt] = call === null ? "" : fields[outputAt] === call ? "accept" : "reject";
    row[sourceAt] = call === null ? "" : "human";
    return keep.map((i) => row[i] ?? "");
  });
  return formatRows([keep.map((i) => header[i] ?? ""), ...out]);
}

/** The verdict on records.csv labelled with these calls; the seed is fileSeed() of the labelled text, as the CLI does. */
export async function shopVerdict(csvText: string, calls: Readonly<Record<string, unknown>>): Promise<ShopVerdict> {
  const labelled = labelRecords(csvText, calls);
  const { errors, rows } = validate(labelled);
  if (errors.length > 0) throw new Error(`labelled records are not valid jnj-record/1: ${errors.slice(0, 3).join("; ")}`);
  const [key, ...more] = cohorts(rows);
  if (key === undefined || more.length > 0) throw new Error("records.csv must hold exactly one cohort");
  const metrics = cohortMetrics(rows, key);
  const v = verdict(metrics, await fileSeed(labelled));
  return { verdict: v.verdict, condition: v.condition, reason: v.reason, paired: metrics.jevVsLlm?.n ?? 0 };
}
