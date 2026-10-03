import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readDictRows } from "../../src/format/csv.ts";
import {
  applyItemLabels, armRecord, blindItems, itemId, jevBody, llmCost, llmRequest, loadInputs, parseJev, parseLlm, ruleOutput,
  ruleRecord, type Reply,
} from "./arms.ts";

const D06 = fileURLToPath(new URL("../../examples/d06-tiny/records.csv", import.meta.url));
const d06Text = await Bun.file(D06).text();
const inputs = loadInputs(d06Text);
const [cv1] = inputs.cases;
const [q1, q2] = inputs.questions;

const jevReply = (choice: string, confidence: unknown = 0.8) => ({
  model: "jev-1.13.0", answers: { q1: { type: "choice", choice, confidence } }, usage: { input_tokens: 120, output_tokens: 2 },
});
const llmReply = (result: string, model = "claude-haiku-4-5-20251001") => ({
  type: "result", is_error: false, result, total_cost_usd: 0.002,
  usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 4 },
  modelUsage: { [model]: { inputTokens: 10 } },
});

describe("TokenMax inputs and rule", () => {
  test("[unit] TM-1 the d06 file yields 5 CVs and 2 questions, inputs only", () => {
    expect(inputs.cases.map((c) => c.case_id)).toEqual(["cv1", "cv2", "cv3", "cv4", "cv5"]);
    expect(inputs.questions.map((q) => q.question_id)).toEqual(["q1", "q2"]);
  });

  test("[unit] TM-2 the keyword rule gives the same outputs as the d06 rule rows (the only real rows there)", () => {
    const { header, rows } = readDictRows(d06Text);
    const h = header ?? [];
    const at = (name: string) => h.indexOf(name);
    for (const { fields } of rows.filter(({ fields }) => fields[at("answerer")] === "rule")) {
      const c = inputs.cases.find((x) => x.case_id === fields[at("case_id")]);
      const q = inputs.questions.find((x) => x.question_id === fields[at("question_id")]);
      if (c === undefined || q === undefined) throw new Error("d06 row outside the inputs");
      expect(ruleOutput(c, q)).toBe(fields[at("output")] === "yes" ? "yes" : "no");
    }
  });

  test("[unit] TM-3 rule rows cost 0 and carry no label", () => {
    if (cv1 === undefined || q1 === undefined) throw new Error("no inputs");
    const r = ruleRecord(cv1, q1);
    expect([r.answerer, r.answerer_model, r.cost_usd, r.label, r.label_source]).toEqual(["rule", "keywords:token pot|pool", "0", "", ""]);
  });

  test("[unit] TM-4 Jev and the LLM get the same question and the same yes/no definitions", () => {
    if (cv1 === undefined || q2 === undefined) throw new Error("no inputs");
    const body = jevBody(cv1, q2);
    const crit = body.questions.q2?.criteria;
    const llm = llmRequest(cv1, q2);
    expect(body.model).toBe("jev-1.13.0");
    expect(llm.system).toContain(q2.question);
    expect(llm.system).toContain(`yes: ${crit?.yes ?? "missing"}`);
    expect(llm.user).toContain(cv1.case_input);
    expect(body.state).toContain(cv1.case_input);
  });
});

describe("TokenMax replies", () => {
  test("[unit] TM-5 a Jev reply gives choice, confidence, tokens and cost at $0.042 per million input", () => {
    const r = parseJev(jevReply("yes"), "q1", "t");
    expect([r.choice, r.confidence, r.tokensIn, r.tokensOut]).toEqual(["yes", 0.8, 120, 2]);
    expect(r.costUsd).toBeCloseTo((120 * 0.042) / 1e6, 15);
  });

  test("[unit] TM-5 a Jev reply off the pin, outside yes|no, or without a valid confidence is refused", () => {
    expect(() => parseJev({ ...jevReply("yes"), model: "jev-1.12.0" }, "q1", "t")).toThrow(/jev-1.13.0/);
    expect(() => parseJev(jevReply("maybe"), "q1", "t")).toThrow(/yes\|no/);
    expect(() => parseJev(jevReply("no", 1.5), "q1", "t")).toThrow(/confidence/);
    expect(() => parseJev(jevReply("no"), "q2", "t")).toThrow(/answer missing/);
  });

  test("[unit] TM-6 LLM cost comes from the dated table: input 1, 5 m write 1.25, 1 h write 2, read 0.10, output 5 per million", () => {
    expect(llmCost({ input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 4 }, "t"))
      .toBeCloseTo((10 * 1 + 1000 * 1.25 + 2000 * 0.1 + 4 * 5) / 1e6, 15);
    expect(llmCost({ input_tokens: 0, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 40 }, output_tokens: 0 }, "t"))
      .toBeCloseTo((60 * 1.25 + 40 * 2) / 1e6, 15);
  });

  test("[unit] TM-6 an LLM reply gives one word, all input tokens and the table cost, never the CLI's own figure", () => {
    const r = parseLlm(llmReply(" No.\n"), "t");
    expect([r.choice, r.model, r.tokensIn, r.tokensOut, r.confidence]).toEqual(["no", "claude-haiku-4-5-20251001", 3010, 4, null]);
    expect(r.costUsd).not.toBe(0.002);
  });

  test("[unit] TM-6 an LLM reply that is not one word, is an error, or comes from a model outside the table is refused", () => {
    expect(() => parseLlm(llmReply("yes, because"), "t")).toThrow(/not exactly/);
    expect(() => parseLlm({ ...llmReply("yes"), is_error: true }, "t")).toThrow(/error envelope/);
    expect(() => parseLlm(llmReply("yes", "claude-sonnet-5-5"), "t")).toThrow(/price table/);
  });
});

describe("TokenMax blind labelling", () => {
  if (cv1 === undefined || q1 === undefined) throw new Error("no inputs");
  const reply: Reply = { choice: "yes", model: "jev-1.13.0", confidence: 0.77, tokensIn: 1, tokensOut: 1, costUsd: 0 };
  const rows = [ruleRecord(cv1, q1), armRecord(cv1, q1, "jev", reply, 300), armRecord(cv1, q1, "llm", { ...reply, model: "claude-haiku-4-5-x", confidence: null }, 900)];

  test("[unit] TM-7 blind items carry no answerer, model, confidence, tokens or cost", () => {
    const items = blindItems(rows);
    expect(items.length).toBe(3);
    const text = JSON.stringify(items);
    for (const banned of ["jev", "llm", "rule", "haiku", "keywords", "0.77", "answerer"]) expect(text).not.toContain(banned);
  });

  test("[unit] TM-8 labels.csv sets accept/reject by opaque id and leaves the rest blank; bad input fails", () => {
    const id = itemId(rows[1] ?? rows[0] ?? ruleRecord(cv1, q1));
    const out = applyItemLabels(rows, `item_id,label\n${id},reject\n`);
    expect(out.map((r) => [r.answerer, r.label, r.label_source])).toEqual([["rule", "", ""], ["jev", "reject", "human"], ["llm", "", ""]]);
    expect(() => applyItemLabels(rows, "item_id,label\nnope,accept\n")).toThrow(/unknown item_id/);
    expect(() => applyItemLabels(rows, `item_id,label\n${id},maybe\n`)).toThrow(/accept or reject/);
    expect(() => applyItemLabels(rows, `item_id,label\n${id},accept\n${id},accept\n`)).toThrow(/duplicate/);
  });
});
