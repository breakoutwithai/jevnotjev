import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../src/format/validate.ts";
import {
  APPROVED_DRAFT_2026_10_03, CASES_COUNT, applyLabels, formatRecords, jevBody, loadExample, parseJevResponse,
  parseLlmResponse, parseRecords, parseTruth, provenanceFromRows, ruleOutput, ruleRecord, truthFromRows, type LabelProvenance,
} from "./arms.ts";

const EXAMPLE = fileURLToPath(new URL("../../examples/uc13-shop-bot/", import.meta.url));

describe("UC13 example", () => {
  test("[unit] UC13-1 the example holds 40 messages m01 to m40 and a synthetic fact sheet", async () => {
    const ex = await loadExample(EXAMPLE);
    expect(ex.cases.length).toBe(CASES_COUNT);
    expect(ex.cases.map((c) => c.case_id)).toEqual(Array.from({ length: 40 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`));
    expect(ex.factSheet).toContain("synthetic shop");
    expect(ex.factSheet).toContain("Not on this sheet:");
  });
});

describe("rule arm", () => {
  test("[unit] UC13-2 a term at a word start answers hand_off", () => {
    expect(ruleOutput("Do you rent avalanche gear, and how much is it?")).toBe("hand_off");
    expect(ruleOutput("I was charged twice on my card")).toBe("hand_off");
    expect(ruleOutput("My friend hurt her knee")).toBe("hand_off");
    expect(ruleOutput("someone got injured")).toBe("hand_off");
    expect(ruleOutput("Are there any left for THIS WEEKEND?")).toBe("hand_off");
  });

  test("[unit] UC13-2 no term, or a term inside a word, answers answer", () => {
    expect(ruleOutput("Do you sell helmets?")).toBe("answer");
    expect(ruleOutput("We're a group of 12. Is there a group rate?")).toBe("answer");
    expect(ruleOutput("Is the unsafe zone marked?")).toBe("answer");
  });

  test("[unit] UC13-2 the rule arm on the example gives 13 hand_off and 27 answer", async () => {
    const ex = await loadExample(EXAMPLE);
    const outputs = ex.cases.map((c) => ruleOutput(c.case_input));
    expect(outputs.filter((o) => o === "hand_off").length).toBe(13);
    expect(outputs.filter((o) => o === "answer").length).toBe(27);
  });

  test("[unit] UC13-3 rule records validate as jnj-record/1 with label gaps only", async () => {
    const ex = await loadExample(EXAMPLE);
    const result = validate(formatRecords(ex.cases.map(ruleRecord)));
    expect(result.errors).toEqual([]);
    expect(result.rows.length).toBe(40);
  });
});

describe("Jev arm", () => {
  test("[unit] UC13-4 the request carries the fact sheet, the message and both criteria", () => {
    const body = jevBody("SHEET", { case_id: "m01", case_input: "MSG" });
    expect(body.model).toBe("jev-1.13.0");
    expect(body.state).toBe("Fact sheet:\nSHEET\n\nCustomer message:\nMSG");
    expect(Object.keys(body.questions.q1.criteria).sort()).toEqual(["answer", "hand_off"]);
  });

  const good = {
    model: "jev-1.13.0",
    answers: { q1: { choice: "hand_off", confidence: 0.91234, probabilities: { answer: 0.08766, hand_off: 0.91234 } } },
    usage: { input_tokens: 500, output_tokens: 3 },
  };

  test("[unit] UC13-4 a pinned-model response becomes choice, confidence, tokens and cost", () => {
    const out = parseJevResponse(good, "m01");
    expect(out.choice).toBe("hand_off");
    expect(out.confidence).toBeCloseTo(0.91234, 6);
    expect(out.tokensIn).toBe(500);
    expect(out.costUsd).toBeCloseTo(500 * 0.042e-6, 12);
  });

  test("[unit] UC13-4 a different model or an off-set choice fails loudly", () => {
    expect(() => parseJevResponse({ ...good, model: "jev-1.12.0" }, "m01")).toThrow(/model/);
    expect(() => parseJevResponse({ ...good, answers: { q1: { choice: "maybe", confidence: 0.5 } } }, "m01")).toThrow(/m01/);
    expect(() => parseJevResponse({ model: "jev-1.13.0" }, "m02")).toThrow(/m02/);
  });

  test("[unit] UC13-4 probabilities that do not sum to one fail through the shared answer check", () => {
    const bad = { ...good, answers: { q1: { choice: "hand_off", confidence: 0.9, probabilities: { answer: 0.5, hand_off: 0.9 } } } };
    expect(() => parseJevResponse(bad, "m04")).toThrow(/mass/);
  });
});

describe("LLM arm", () => {
  const reply = {
    result: "hand_off",
    total_cost_usd: 0.0019,
    usage: { input_tokens: 400, cache_creation_input_tokens: 30, cache_read_input_tokens: 5, output_tokens: 7 },
    modelUsage: { "claude-haiku-4-5-20251001": {} },
  };

  test("[unit] UC13-5 reply word, all input tokens, reported cost and reported model are kept", () => {
    const out = parseLlmResponse(reply, "m01");
    expect(out.choice).toBe("hand_off");
    expect(out.tokensIn).toBe(435);
    expect(out.tokensOut).toBe(7);
    expect(out.costUsd).toBe(0.0019);
    expect(out.model).toBe("claude-haiku-4-5-20251001");
  });

  test("[unit] UC13-5 a reply with neither word, or no cost, fails loudly", () => {
    expect(() => parseLlmResponse({ ...reply, result: "not sure" }, "m03")).toThrow(/m03/);
    expect(() => parseLlmResponse({ ...reply, total_cost_usd: undefined }, "m03")).toThrow(/cost/);
  });
});

describe("labels", () => {
  test("[unit] UC13-6 M1 accept when the output equals the truth, reject otherwise, stamped human_reviewed; unlabelled stays empty", () => {
    const truth = parseTruth("case_id,truth\nm01,hand_off\nm02,answer\n");
    const rows = [
      ruleRecord({ case_id: "m01", case_input: "Is it safe?" }),
      ruleRecord({ case_id: "m02", case_input: "Is it safe?" }),
      ruleRecord({ case_id: "m03", case_input: "Is it safe?" }),
    ];
    const labelled = applyLabels(rows, truth, APPROVED_DRAFT_2026_10_03);
    expect(labelled.map((r) => [r.label, r.label_source, r.labelled_by, r.labelled_at, r.label_blind])).toEqual([
      ["accept", "human_reviewed", "operator", "2026-10-03", "false"],
      ["reject", "human_reviewed", "operator", "2026-10-03", "false"],
      ["", "", "", "", ""],
    ]);
    expect(validate(formatRecords(labelled)).errors).toEqual([]);
  });

  test("[unit] UC13-6 a truth outside the answer set is refused", () => {
    expect(() => parseTruth("case_id,truth\nm01,escalate\n")).toThrow(/m01/);
  });

  test("[unit] UC13-F11 duplicate, blank or unknown truth ids are refused", () => {
    expect(() => parseTruth("case_id,truth\nm01,answer\nm01,hand_off\n")).toThrow(/duplicate/);
    expect(() => parseTruth("case_id,truth\n,answer\n")).toThrow(/case_id/);
    const rows = [ruleRecord({ case_id: "m01", case_input: "Is it safe?" })];
    expect(() => applyLabels(rows, parseTruth("case_id,truth\nm09,answer\n"), APPROVED_DRAFT_2026_10_03)).toThrow(/m09/);
  });

  test("[unit] UC13-F2 truth is recovered from labelled rows and conflicts are refused", () => {
    const rows = applyLabels(
      [ruleRecord({ case_id: "m01", case_input: "Is it safe?" }), ruleRecord({ case_id: "m02", case_input: "helmets?" })],
      parseTruth("case_id,truth\nm01,answer\nm02,answer\n"),
      APPROVED_DRAFT_2026_10_03,
    );
    expect([...truthFromRows(rows)]).toEqual([["m01", "answer"], ["m02", "answer"]]);
    const first = rows[0];
    if (first === undefined) throw new Error("no row");
    expect(() => truthFromRows([...rows, { ...first, answerer: "jev", label: "accept" }])).toThrow(/m01/);
  });

  test("[unit] M1 labels without a provenance are refused; a rebuild reads the one provenance the rows carry", () => {
    const rows = [ruleRecord({ case_id: "m01", case_input: "Is it safe?" }), ruleRecord({ case_id: "m02", case_input: "helmets?" })];
    expect(() => applyLabels(rows, parseTruth("case_id,truth\nm01,answer\n"), null)).toThrow(/provenance/);
    expect(applyLabels(rows, new Map(), null).every((r) => r.label === "" && r.labelled_by === "")).toBe(true);
    const blind: LabelProvenance = { source: "human", by: "op-1", at: "2026-10-07T09:30:00Z", blind: true };
    const labelled = applyLabels(rows, parseTruth("case_id,truth\nm01,answer\nm02,answer\n"), blind);
    expect(provenanceFromRows(labelled)).toEqual(blind);
    expect(provenanceFromRows(rows)).toBeNull();
    const first = labelled[0];
    if (first === undefined) throw new Error("no row");
    expect(() => provenanceFromRows([...labelled, { ...first, answerer: "jev", label_source: "human_reviewed" }])).toThrow(/different provenance/);
    expect(() => provenanceFromRows([{ ...first, labelled_at: "" }])).toThrow(/complete provenance/);
  });

  test("[smoke] M1 the recorded UC13 run: all 120 labels are human_reviewed by the operator on 2026-10-03, not blind", async () => {
    const text = await Bun.file(fileURLToPath(new URL("../../docs/product/runs/2026-10-01-uc13-shop-bot/records.csv", import.meta.url))).text();
    const rows = parseRecords(text);
    expect(rows).toHaveLength(120);
    expect(rows.every((r) => r.format_version === "jnj-record/1.1")).toBe(true);
    expect(rows.filter((r) => r.label !== "")).toHaveLength(120);
    expect(provenanceFromRows(rows)).toEqual(APPROVED_DRAFT_2026_10_03);
    expect(rows.some((r) => r.label_source === "human")).toBe(false);
  });
});

describe("records file", () => {
  test("[unit] M1 a jnj-record/1 records file (TokenMax) still parses and round-trips byte for byte", () => {
    const v1 = { ...ruleRecord({ case_id: "m01", case_input: "Is it safe?" }), format_version: "jnj-record/1" };
    const { labelled_by: _by, labelled_at: _at, label_blind: _blind, ...row } = v1;
    const text = formatRecords([row]);
    expect(text.split("\n")[0]).not.toContain("labelled_by");
    expect(formatRecords(parseRecords(text))).toBe(text);
    expect(Object.keys(parseRecords(text)[0] ?? {})).not.toContain("labelled_by");
  });

  const good = formatRecords([ruleRecord({ case_id: "m01", case_input: "Is it safe?" })]);

  test("[unit] UC13-F10 a truncated, widened or re-headed records file is refused", () => {
    expect(parseRecords(good).length).toBe(1);
    const [header = "", row = ""] = good.split("\n");
    expect(() => parseRecords(`${header}\n${row.slice(0, row.lastIndexOf(","))}\n`)).toThrow(/line 2/);
    expect(() => parseRecords(`${header}\n${row},extra\n`)).toThrow(/line 2/);
    expect(() => parseRecords(`${header.replace("label_source", "source")}\n${row}\n`)).toThrow(/header/);
    expect(() => parseRecords(`${header}\n${row.replace("rule,keywords.v1,hand_off", "rule,keywords.v1,maybe")}\n`)).toThrow(/maybe/);
  });
});

describe("strict replies", () => {
  const jev = {
    model: "jev-1.13.0",
    answers: { q1: { choice: "answer", confidence: 0.9, probabilities: { answer: 0.9, hand_off: 0.1 } } },
    usage: { input_tokens: 500, output_tokens: 3 },
  };
  const llm = {
    result: "answer",
    total_cost_usd: 0.002,
    usage: { input_tokens: 10, output_tokens: 2 },
    modelUsage: { "claude-haiku-4-5-20251001": {} },
  };

  test("[unit] UC13-F3 the whole trimmed reply must be one answer word; error envelopes are refused", () => {
    expect(parseLlmResponse({ ...llm, result: " hand_off\n" }, "m01").choice).toBe("hand_off");
    expect(() => parseLlmResponse({ ...llm, result: "unanswerable" }, "m01")).toThrow(/m01/);
    expect(() => parseLlmResponse({ ...llm, result: "Do not answer; hand_off" }, "m01")).toThrow(/m01/);
    expect(() => parseLlmResponse({ ...llm, result: "Answer." }, "m01")).toThrow(/m01/);
    expect(() => parseLlmResponse({ ...llm, is_error: true, result: "hand_off" }, "m01")).toThrow(/error/);
  });

  test("[unit] UC13-F4 a reply without usage token counts is refused, not costed at zero", () => {
    expect(() => parseJevResponse({ ...jev, usage: undefined }, "m01")).toThrow(/usage/);
    expect(() => parseJevResponse({ ...jev, usage: { output_tokens: 3 } }, "m01")).toThrow(/input_tokens/);
    expect(() => parseLlmResponse({ ...llm, usage: undefined }, "m01")).toThrow(/usage/);
    expect(parseLlmResponse(llm, "m01").tokensIn).toBe(10);
  });

  test("[unit] UC13-F5 out-of-range confidence, token counts and cost are refused", () => {
    const withConf = (confidence: number) => ({ ...jev, answers: { q1: { ...jev.answers.q1, confidence } } });
    expect(() => parseJevResponse(withConf(2), "m01")).toThrow(/confidence/);
    expect(() => parseJevResponse(withConf(Number.NaN), "m01")).toThrow(/confidence/);
    expect(() => parseJevResponse({ ...jev, usage: { input_tokens: -1, output_tokens: 3 } }, "m01")).toThrow(/input_tokens/);
    expect(() => parseJevResponse({ ...jev, usage: { input_tokens: 1.5, output_tokens: 3 } }, "m01")).toThrow(/input_tokens/);
    expect(() => parseLlmResponse({ ...llm, total_cost_usd: -0.1 }, "m01")).toThrow(/cost/);
    expect(() => parseLlmResponse({ ...llm, usage: { ...llm.usage, cache_read_input_tokens: -4 } }, "m01")).toThrow(/cache_read/);
  });
});

describe("example loading", () => {
  async function exampleWith(sheet: string, lines: readonly string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "uc13-ex-"));
    await writeFile(join(dir, "fact-sheet.md"), sheet);
    await writeFile(join(dir, "cases.jsonl"), lines.join("\n") + "\n");
    return dir;
  }
  const forty = Array.from({ length: 40 }, (_, i) => JSON.stringify({ case_id: `m${String(i + 1).padStart(2, "0")}`, case_input: "hi" }));

  test("[unit] UC13-F7 an empty sheet, blank message, duplicate, missing or extra case is refused", async () => {
    const dirs = [
      await exampleWith("   \n", forty),
      await exampleWith("sheet", [JSON.stringify({ case_id: "m01", case_input: " " }), ...forty.slice(1)]),
      await exampleWith("sheet", [...forty.slice(0, 39), forty[0] ?? ""]),
      await exampleWith("sheet", forty.slice(0, 39)),
      await exampleWith("sheet", []),
    ];
    try {
      const [empty, blank, dup, short, none] = dirs;
      await expect(loadExample(empty ?? "")).rejects.toThrow(/fact-sheet/);
      await expect(loadExample(blank ?? "")).rejects.toThrow(/m01/);
      await expect(loadExample(dup ?? "")).rejects.toThrow(/duplicate/);
      await expect(loadExample(short ?? "")).rejects.toThrow(/m40/);
      await expect(loadExample(none ?? "")).rejects.toThrow(/m01/);
      expect((await loadExample(await exampleWith("sheet", forty))).cases.length).toBe(40);
    } finally {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
  });

  test("[unit] UC13-F6 a case id that is not m01 to m40, such as a path, is refused", async () => {
    const dir = await exampleWith("sheet", [JSON.stringify({ case_id: "../outside", case_input: "hi" }), ...forty.slice(1)]);
    try {
      await expect(loadExample(dir)).rejects.toThrow(/\.\.\/outside/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
