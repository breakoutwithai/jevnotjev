// Calibration before a tester's own cases (labelling loop M3): five practice cases with reference labels a person
// approved, and the tester's agreement with them. The reference labels are the UC13 human_reviewed truths.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readDictRows } from "../format/csv.ts";
import { APPROVED_DRAFT_2026_10_03, CRITERIA, QUESTION } from "../../scripts/uc13/arms.ts";
import { calibrationAgreement, type CalibrationCase } from "./calibration.ts";
import { UC13_CALIBRATION } from "./calibration-set.ts";

const ROOT = join(import.meta.dir, "..", "..");
const RUN = join(ROOT, "docs/product/runs/2026-10-01-uc13-shop-bot");

function truth(id: string, value: string): CalibrationCase {
  return { id, input: `case ${id}`, truth: value, source: "human_reviewed", labelledBy: "operator", labelledAt: "2026-10-03" };
}
const FIXTURE: readonly CalibrationCase[] = [
  truth("c1", "answer"),
  truth("c2", "hand_off"),
  truth("c3", "answer"),
  truth("c4", "hand_off"),
  truth("c5", "hand_off"),
];
const CHOICES = ["answer", "hand_off"];

describe("calibrationAgreement", () => {
  test("[unit] M3 agreement on a hand-computed fixture: 3 agree, 1 differs, 1 unsure -> 3 of 4 compared", () => {
    const picks = new Map<string, string | null>([
      ["c1", "answer"],
      ["c2", "hand_off"],
      ["c3", "hand_off"],
      ["c4", "hand_off"],
      ["c5", null],
    ]);
    expect(calibrationAgreement(FIXTURE, CHOICES, picks)).toEqual({
      total: 5,
      picked: 5,
      unsure: 1,
      compared: 4,
      agreed: 3,
      rate: 0.75,
      disagreed: ["c3"],
      done: true,
    });
  });

  test("[unit] M3 cases not yet picked count toward neither side; done only when every case is picked", () => {
    const picks = new Map<string, string | null>([["c2", "answer"]]);
    expect(calibrationAgreement(FIXTURE, CHOICES, picks)).toEqual({
      total: 5,
      picked: 1,
      unsure: 0,
      compared: 1,
      agreed: 0,
      rate: 0,
      disagreed: ["c2"],
      done: false,
    });
  });

  test("[unit] M3 with nothing compared the rate is null, never 0 or 1", () => {
    expect(calibrationAgreement(FIXTURE, CHOICES, new Map()).rate).toBeNull();
    const allUnsure = new Map<string, string | null>(FIXTURE.map((c) => [c.id, null]));
    const result = calibrationAgreement(FIXTURE, CHOICES, allUnsure);
    expect([result.rate, result.compared, result.unsure, result.done]).toEqual([null, 0, 5, true]);
  });

  test("[unit] M3 a pick for an unknown case, or outside the answer set, is refused", () => {
    expect(() => calibrationAgreement(FIXTURE, CHOICES, new Map([["c9", "answer"]]))).toThrow("c9");
    expect(() => calibrationAgreement(FIXTURE, CHOICES, new Map([["c1", "maybe"]]))).toThrow("maybe");
    expect(() => calibrationAgreement([FIXTURE[0], FIXTURE[0]].flatMap((c) => (c ? [c] : [])), CHOICES, new Map())).toThrow("repeat");
  });

  test("[unit] M3 an agent label is never a calibration truth, and a truth must be in the answer set", () => {
    const agent: CalibrationCase = { ...truth("c1", "answer"), source: "agent" };
    expect(() => calibrationAgreement([agent], CHOICES, new Map())).toThrow("agent");
    expect(() => calibrationAgreement([truth("c1", "unclear")], CHOICES, new Map())).toThrow("unclear");
  });
});

describe("UC13_CALIBRATION", () => {
  test("[unit] M3 five cases, both answers present, none from the review list of least certain calls", () => {
    expect(UC13_CALIBRATION.cases.length).toBe(5);
    expect(new Set(UC13_CALIBRATION.cases.map((c) => c.truth))).toEqual(new Set(["answer", "hand_off"]));
    // LABELS.md step 4: m07, m12, m28, m33, m35 were the five least certain calls; a practice case must be clear-cut.
    for (const id of ["m07", "m12", "m28", "m33", "m35"])
      expect(UC13_CALIBRATION.cases.map((c) => c.id)).not.toContain(id);
  });

  test("[unit] M3 every calibration truth and text is the approved UC13 file's, marked human_reviewed as approved", async () => {
    const labels = new Map(
      readDictRows(await Bun.file(join(RUN, "labels.csv")).text()).rows.map((r) => [r.fields[0] ?? "", r.fields[1] ?? ""]),
    );
    const inputs = new Map(
      (await Bun.file(join(ROOT, "examples/uc13-shop-bot/cases.jsonl")).text())
        .split("\n")
        .filter(Boolean)
        .map((line): [string, string] => {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null || !("case_id" in parsed) || !("case_input" in parsed))
            throw new Error("bad cases.jsonl line");
          return [String(parsed.case_id), String(parsed.case_input)];
        }),
    );
    for (const c of UC13_CALIBRATION.cases) {
      expect(c.truth).toBe(labels.get(c.id) ?? "missing");
      expect(c.input).toBe(inputs.get(c.id) ?? "missing");
      expect([c.source, c.labelledBy, c.labelledAt]).toEqual([
        APPROVED_DRAFT_2026_10_03.source,
        APPROVED_DRAFT_2026_10_03.by,
        APPROVED_DRAFT_2026_10_03.at,
      ]);
    }
  });

  test("[unit] M3 the calibration question, definitions and fact sheet are the UC13 run's own", async () => {
    expect(UC13_CALIBRATION.question).toBe(QUESTION);
    expect(UC13_CALIBRATION.choices.map((c) => [c.name, c.definition])).toEqual([
      ["answer", CRITERIA.answer],
      ["hand_off", CRITERIA.hand_off],
    ]);
    expect(UC13_CALIBRATION.context).toBe((await Bun.file(join(ROOT, "examples/uc13-shop-bot/fact-sheet.md")).text()).trim());
  });
});
