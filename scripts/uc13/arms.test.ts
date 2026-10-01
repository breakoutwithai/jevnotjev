import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { validate } from "../../src/format/validate.ts";
import {
  CASES_COUNT, applyLabels, formatRecords, jevBody, loadExample, parseJevResponse, parseLlmResponse, parseTruth,
  ruleOutput, ruleRecord,
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
  test("[unit] UC13-6 accept when the output equals the truth, reject otherwise, unlabelled stays empty", () => {
    const truth = parseTruth("case_id,truth\nm01,hand_off\nm02,answer\n");
    const rows = [
      ruleRecord({ case_id: "m01", case_input: "Is it safe?" }),
      ruleRecord({ case_id: "m02", case_input: "Is it safe?" }),
      ruleRecord({ case_id: "m03", case_input: "Is it safe?" }),
    ];
    const labelled = applyLabels(rows, truth);
    expect(labelled.map((r) => [r.label, r.label_source])).toEqual([["accept", "human"], ["reject", "human"], ["", ""]]);
  });

  test("[unit] UC13-6 a truth outside the answer set is refused", () => {
    expect(() => parseTruth("case_id,truth\nm01,escalate\n")).toThrow(/m01/);
  });
});
