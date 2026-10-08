import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { COLUMNS, COLUMNS_V1_1, validate, type ParsedRow } from "../format/validate.ts";
import { formatRow } from "../format/csv.ts";
import { cohortMetrics, cohorts, costPerAccepted, describeCostPerAccepted, describeProvenance, labelProvenance, spendOf, type CohortMetrics } from "./metrics.ts";

const TINY = fileURLToPath(new URL("../../examples/d06-tiny/records.csv", import.meta.url));

function load(text: string): readonly ParsedRow[] {
  const result = validate(text);
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  return result.rows;
}

function arm(metrics: CohortMetrics, name: string) {
  const found = metrics.arms.find((totals) => totals.arm === name);
  if (found === undefined) throw new Error(`no ${name} arm`);
  return found;
}

type Cells = { [column: string]: string };

/** Build a small valid file: one row per entry, defaults filled in. */
function file(entries: readonly Cells[], columns: readonly string[] = COLUMNS): string {
  const base: Cells = {
    format_version: "jnj-record/1",
    run_id: "run-t",
    prompt_version: "t.v1",
    case_input: "synthetic",
    question_id: "q1",
    question: "Synthetic question?",
    answer_set: "yes|no",
    answerer_model: "m",
    output: "yes",
    confidence: "",
    label: "accept",
    label_source: "human",
    tokens_in: "",
    tokens_out: "",
    cost_usd: "0.001",
    latency_ms: "",
  };
  const rows = entries.map((entry) => {
    const row = { ...base, ...entry };
    if (row.label === "") row.label_source = "";
    if (row.case_input === "synthetic") row.case_input = `synthetic ${row.case_id}`;
    return columns.map((column) => row[column] ?? "");
  });
  return [columns, ...rows].map((fields) => formatRow(fields, "\n")).join("");
}

describe("[unit] d06-tiny matches expected.md", async () => {
  const rows = load(await Bun.file(TINY).text());
  const keys = cohorts(rows);

  test("[unit] two cohorts, one per question, never pooled", () => {
    expect(keys.map((key) => key.questionId)).toEqual(["q1", "q2"]);
  });

  test("[unit] q1 per-arm totals", () => {
    const q1 = cohortMetrics(rows, keys[0]!);
    expect(q1.cases).toBe(5);
    expect(arm(q1, "jev")).toMatchObject({ rows: 5, labelled: 5, accepted: 4, rejected: 1, unlabelled: 0 });
    expect(arm(q1, "llm")).toMatchObject({ rows: 5, labelled: 5, accepted: 5 });
    expect(arm(q1, "rule")).toMatchObject({ rows: 5, labelled: 5, accepted: 2 });
  });

  test("[unit] q1 Jev vs LLM: 5 pairs, cost per accepted 0.000025 vs 0.002, ratio 1/80", () => {
    const pair = cohortMetrics(rows, keys[0]!).jevVsLlm!;
    expect(pair).toMatchObject({ n: 5, excluded: 0, a: 4, b: 0, c: 1, d: 0, wins: 0, losses: 1, ties: 4 });
    expect(pair.jev.accepted).toBe(4);
    expect(pair.jev.acceptRate).toBeCloseTo(0.8, 12);
    expect(pair.otherArm.acceptRate).toBeCloseTo(1.0, 12);
    const jev = pair.jev.costPerAccepted;
    const llm = pair.otherArm.costPerAccepted;
    if (jev.kind !== "value" || llm.kind !== "value") throw new Error("expected values");
    expect(jev.usd).toBeCloseTo(0.000025, 12);
    expect(llm.usd).toBeCloseTo(0.002, 12);
    expect(jev.usd / llm.usd).toBeCloseTo(1 / 80, 12);
  });

  test("[unit] q1 Jev vs rule: a=2 b=2 c=0 d=1", () => {
    const pair = cohortMetrics(rows, keys[0]!).jevVsRule!;
    expect(pair).toMatchObject({ n: 5, a: 2, b: 2, c: 0, d: 1 });
    expect(pair.otherArm.accepted).toBe(2);
  });

  test("[unit] q2: unlabelled LLM row drops cv2 from the Jev/LLM pair only", () => {
    const q2 = cohortMetrics(rows, keys[1]!);
    expect(arm(q2, "llm")).toMatchObject({ rows: 5, labelled: 4, unlabelled: 1, accepted: 3 });
    const pair = q2.jevVsLlm!;
    expect(pair).toMatchObject({ n: 4, excluded: 1, a: 3, b: 0, c: 0, d: 1 });
    const jev = pair.jev.costPerAccepted;
    const llm = pair.otherArm.costPerAccepted;
    if (jev.kind !== "value" || llm.kind !== "value") throw new Error("expected values");
    expect(jev.usd).toBeCloseTo(0.00008 / 3, 12);
    expect(llm.usd).toBeCloseTo(0.008 / 3, 12);
    expect(jev.usd / llm.usd).toBeCloseTo(0.01, 12);
    expect(q2.jevVsRule).toMatchObject({ n: 5, excluded: 0, a: 4, b: 0, c: 0, d: 1 });
  });

  test("[unit] q2 rule spend is incomplete (cv5 cost missing), never a number", () => {
    const rule = arm(cohortMetrics(rows, keys[1]!), "rule");
    expect(rule.spend).toEqual({ kind: "incomplete", knownUsd: 0, missing: 1 });
    expect(rule.costPerAccepted).toEqual({ kind: "incomplete", reason: "cost missing" });
    expect(describeCostPerAccepted(rule.costPerAccepted)).toBe("incomplete (cost missing)");
  });

  test("[unit] whole-file accepted counts match the validator: jev 8, llm 8, rule 6", () => {
    const sum = (name: string) =>
      keys.map((key) => arm(cohortMetrics(rows, key), name).accepted).reduce((x, y) => x + y, 0);
    expect([sum("jev"), sum("llm"), sum("rule")]).toEqual([8, 8, 6]);
  });
});

describe("[unit] zero accepted results", () => {
  const rows = load(
    file([
      { case_id: "c1", answerer: "jev", label: "reject", cost_usd: "0.00002" },
      { case_id: "c2", answerer: "jev", label: "reject", cost_usd: "0.00002" },
      { case_id: "c1", answerer: "llm", label: "accept", cost_usd: "0.002" },
      { case_id: "c2", answerer: "llm", label: "reject", cost_usd: "0.002" },
    ]),
  );
  const metrics = cohortMetrics(rows, cohorts(rows)[0]!);

  test("[unit] an arm with nothing accepted has undefined cost per accepted, spend still shown", () => {
    const jev = arm(metrics, "jev");
    expect(jev.accepted).toBe(0);
    expect(jev.acceptRate).toBe(0);
    expect(jev.spend.kind).toBe("complete");
    expect(jev.costPerAccepted).toEqual({ kind: "undefined", reason: "zero accepted" });
    expect(describeCostPerAccepted(jev.costPerAccepted)).toBe("undefined (0 accepted)");
  });

  test("[unit] the other arm still gets its number", () => {
    const llm = metrics.jevVsLlm!.otherArm.costPerAccepted;
    expect(llm.kind).toBe("value");
    if (llm.kind === "value") expect(llm.usd).toBeCloseTo(0.004, 12);
  });

  test("[unit] both arms at zero: both undefined, no division", () => {
    const both = load(
      file([
        { case_id: "c1", answerer: "jev", label: "reject" },
        { case_id: "c1", answerer: "llm", label: "reject" },
      ]),
    );
    const pair = cohortMetrics(both, cohorts(both)[0]!).jevVsLlm!;
    expect(pair.jev.costPerAccepted.kind).toBe("undefined");
    expect(pair.otherArm.costPerAccepted.kind).toBe("undefined");
    expect(pair.d).toBe(1);
  });
});

describe("[unit] missing cost or label data", () => {
  test("[unit] a missing cost makes spend incomplete, even with accepted results", () => {
    const rows = load(
      file([
        { case_id: "c1", answerer: "llm", cost_usd: "" },
        { case_id: "c2", answerer: "llm", cost_usd: "0.003" },
      ]),
    );
    const llm = arm(cohortMetrics(rows, cohorts(rows)[0]!), "llm");
    expect(llm.spend).toEqual({ kind: "incomplete", knownUsd: 0.003, missing: 1 });
    expect(llm.costPerAccepted.kind).toBe("incomplete");
  });

  test("[unit] missing cost beats zero accepted: incomplete, not undefined", () => {
    expect(costPerAccepted({ kind: "incomplete", knownUsd: 0, missing: 2 }, 0).kind).toBe("incomplete");
  });

  test("[unit] an unlabelled row is neither accepted nor rejected, and leaves the pair", () => {
    const rows = load(
      file([
        { case_id: "c1", answerer: "jev", label: "" },
        { case_id: "c2", answerer: "jev", label: "accept" },
        { case_id: "c1", answerer: "llm", label: "accept" },
        { case_id: "c2", answerer: "llm", label: "reject" },
      ]),
    );
    const metrics = cohortMetrics(rows, cohorts(rows)[0]!);
    expect(arm(metrics, "jev")).toMatchObject({ rows: 2, labelled: 1, accepted: 1, rejected: 0, unlabelled: 1 });
    expect(arm(metrics, "jev").acceptRate).toBe(1);
    expect(metrics.jevVsLlm).toMatchObject({ n: 1, excluded: 1, b: 1 });
  });

  test("[unit] M1 an agent label is never counted as truth: the row reads as unlabelled and leaves the pair", () => {
    const v11 = { format_version: "jnj-record/1.1", labelled_by: "op-1", labelled_at: "2026-10-07", label_blind: "true" };
    const rows = load(
      file(
        [
          { ...v11, case_id: "c1", answerer: "jev", label: "accept", label_source: "agent", labelled_by: "claude-opus-5-5" },
          { ...v11, case_id: "c2", answerer: "jev", label: "accept" },
          { ...v11, case_id: "c1", answerer: "llm", label: "accept", label_source: "human_reviewed", label_blind: "false" },
          { ...v11, case_id: "c2", answerer: "llm", label: "reject" },
        ],
        COLUMNS_V1_1,
      ),
    );
    const metrics = cohortMetrics(rows, cohorts(rows)[0]!);
    expect(arm(metrics, "jev")).toMatchObject({ rows: 2, labelled: 1, accepted: 1, rejected: 0, unlabelled: 1 });
    expect(arm(metrics, "llm")).toMatchObject({ rows: 2, labelled: 2, accepted: 1, rejected: 1, unlabelled: 0 });
    expect(metrics.jevVsLlm).toMatchObject({ n: 1, excluded: 1, b: 1 });
  });

  test("[unit] nothing labelled: accept rate is null, not zero", () => {
    const rows = load(file([{ case_id: "c1", answerer: "rule", label: "", cost_usd: "0" }]));
    const rule = arm(cohortMetrics(rows, cohorts(rows)[0]!), "rule");
    expect(rule.acceptRate).toBeNull();
    expect(rule.costPerAccepted.kind).toBe("undefined");
  });

  test("[unit] an arm with no rows gives no paired sample instead of zeros", () => {
    const rows = load(file([{ case_id: "c1", answerer: "llm" }]));
    const metrics = cohortMetrics(rows, cohorts(rows)[0]!);
    expect(metrics.jevVsLlm).toBeNull();
    expect(metrics.jevVsRule).toBeNull();
  });

  test("[unit] empty spend is a complete zero", () => {
    expect(spendOf([])).toEqual({ kind: "complete", usd: 0 });
  });
});

describe("[unit] cohorts stay separate", () => {
  test("[unit] two runs of the same question never count toward each other", () => {
    const rows = load(
      file([
        { run_id: "run-a", case_id: "c1", answerer: "jev", label: "accept" },
        { run_id: "run-b", case_id: "c1", answerer: "jev", label: "reject" },
      ]),
    );
    const keys = cohorts(rows);
    expect(keys.length).toBe(2);
    expect(arm(cohortMetrics(rows, keys[0]!), "jev").accepted).toBe(1);
    expect(arm(cohortMetrics(rows, keys[1]!), "jev").accepted).toBe(0);
  });

  test("[unit] human rows stay in the file but are not an arm", () => {
    const rows = load(
      file([
        { case_id: "c1", answerer: "human", label: "accept" },
        { case_id: "c1", answerer: "jev", label: "accept" },
      ]),
    );
    expect(cohortMetrics(rows, cohorts(rows)[0]!).arms.map((totals) => totals.arm)).toEqual(["jev"]);
  });
});

describe("[unit] label provenance per method", () => {
  const v11 = { format_version: "jnj-record/1.1", labelled_by: "op-1", labelled_at: "2026-10-07", label_blind: "true" };
  const provenanceOf = (entries: readonly Cells[], columns: readonly string[], answerer: string): string => {
    const rows = load(file(entries, columns));
    return describeProvenance(labelProvenance(rows.map((row) => row.values).filter((row) => row.get("answerer") === answerer)));
  };

  test("[unit] a jnj-record/1 file shows its human labels and says blindness is not recorded", () => {
    expect(provenanceOf([{ case_id: "c1", answerer: "jev" }, { case_id: "c2", answerer: "jev", label: "reject" }], COLUMNS, "jev")).toBe("labels: human 2; blind: not recorded");
  });

  test("[unit] a 1.1 method counts its labels by source and says whether they were blind", () => {
    const entries = [
      { ...v11, case_id: "c1", answerer: "jev" },
      { ...v11, case_id: "c2", answerer: "jev" },
      { ...v11, case_id: "c3", answerer: "jev", label_source: "human_reviewed", label_blind: "false" },
      { ...v11, case_id: "c4", answerer: "jev", label_source: "agent", labelled_by: "claude-opus-5-5", label_blind: "false" },
    ];
    expect(provenanceOf(entries, COLUMNS_V1_1, "jev")).toBe("labels: human 2, human_reviewed 1, agent 1; blind: 2 yes, 2 no");
  });

  test("[unit] all blind says yes, none blind says no, and unlabelled rows are not counted", () => {
    const entries = [
      { ...v11, case_id: "c1", answerer: "llm" },
      { ...v11, case_id: "c2", answerer: "llm", label: "", labelled_by: "", labelled_at: "", label_blind: "" },
      { ...v11, case_id: "c1", answerer: "rule", label_blind: "false" },
    ];
    expect(provenanceOf(entries, COLUMNS_V1_1, "llm")).toBe("labels: human 1; blind: yes");
    expect(provenanceOf(entries, COLUMNS_V1_1, "rule")).toBe("labels: human 1; blind: no");
  });

  test("[unit] a method with no labels says so, and a mix of /1 and 1.1 rows never reports unknown blindness as yes", () => {
    expect(provenanceOf([{ ...v11, case_id: "c1", answerer: "jev", label: "", labelled_by: "", labelled_at: "", label_blind: "" }], COLUMNS_V1_1, "jev")).toBe("no labels");
    const mixed = [{ ...v11, case_id: "c1", answerer: "jev" }, { case_id: "c2", answerer: "jev", format_version: "jnj-record/1", labelled_by: "", labelled_at: "", label_blind: "" }];
    expect(provenanceOf(mixed, COLUMNS_V1_1, "jev")).toBe("labels: human 2; blind: 1 yes, 1 not recorded");
  });
});
