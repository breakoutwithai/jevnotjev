/**
 * Calibration before a tester labels their own cases (labelling loop M3): a few practice cases whose reference labels a
 * person made or approved, and the tester's agreement with them. Pure: no DOM, no network; the browser imports it.
 *
 * Agreement counts only the cases the tester picked with a choice: an unsure pick is reported, never counted as a
 * disagreement, and a case not yet picked counts toward neither side. With nothing compared the rate is null.
 */

/** format/README.md "Label provenance". An agent label is listed so data from anywhere can be checked, and refused. */
export type TruthSource = "human" | "human_reviewed" | "agent";

export interface CalibrationCase {
  readonly id: string;
  readonly input: string;
  /** The reference choice for the case. */
  readonly truth: string;
  readonly source: TruthSource;
  readonly labelledBy: string;
  readonly labelledAt: string;
}

export interface CalibrationChoice {
  readonly name: string;
  readonly definition: string;
}

export interface CalibrationSet {
  readonly question: string;
  readonly choices: readonly [CalibrationChoice, CalibrationChoice];
  /** What a labeller needs beside the case to decide (for UC13, the fact sheet). */
  readonly context: string;
  readonly cases: readonly CalibrationCase[];
}

export interface CalibrationAgreement {
  readonly total: number;
  /** Cases with a pick, unsure included. */
  readonly picked: number;
  readonly unsure: number;
  /** Picks with a choice: the denominator of rate. */
  readonly compared: number;
  readonly agreed: number;
  /** agreed / compared; null when nothing was compared. */
  readonly rate: number | null;
  /** Case ids where the pick differs from the reference, in case order. */
  readonly disagreed: readonly string[];
  /** True once every case has a pick (unsure counts as a pick). */
  readonly done: boolean;
}

/** picks: case id to the tester's choice, or null for unsure. */
export function calibrationAgreement(
  cases: readonly CalibrationCase[],
  answerSet: readonly string[],
  picks: ReadonlyMap<string, string | null>,
): CalibrationAgreement {
  for (const c of cases) {
    if (c.source === "agent") throw new Error(`Calibration case ${c.id} has an agent label; only a person's label is a reference.`);
    if (!answerSet.includes(c.truth)) throw new Error(`Calibration case ${c.id}: truth ${JSON.stringify(c.truth)} is not in the answer set.`);
  }
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) throw new Error("Calibration case ids repeat.");
  for (const [id, pick] of picks) {
    if (!ids.has(id)) throw new Error(`No calibration case ${JSON.stringify(id)}.`);
    if (pick !== null && !answerSet.includes(pick)) throw new Error(`Pick ${JSON.stringify(pick)} is not in the answer set.`);
  }
  let unsure = 0;
  let compared = 0;
  let agreed = 0;
  const disagreed: string[] = [];
  for (const c of cases) {
    if (!picks.has(c.id)) continue;
    const pick = picks.get(c.id) ?? null;
    if (pick === null) {
      unsure++;
      continue;
    }
    compared++;
    if (pick === c.truth) agreed++;
    else disagreed.push(c.id);
  }
  const picked = cases.filter((c) => picks.has(c.id)).length;
  return {
    total: cases.length,
    picked,
    unsure,
    compared,
    agreed,
    rate: compared === 0 ? null : agreed / compared,
    disagreed,
    done: picked === cases.length,
  };
}
