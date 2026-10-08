// src/decide core (M2 of the API/MCP work): typed questions, four arms, outcome rows, the price table, the dry run and the
// budget cap. Every provider response comes from a recorded fixture through an injected fetch; no test calls a provider.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoSecrets } from "../../scripts/uc13/calls.ts";
import { MIN_PAIRED } from "../core/verdict.ts";
import { JEV_PIN } from "../jev-answer.ts";
import { formatRow } from "../format/csv.ts";
import { validate } from "../format/validate.ts";
import { ACCEPTED_LLM_MODELS, PRICE_TABLE_DATE, callCost, priceFor, resolveLlmModel } from "./prices.ts";
import { DecideError, ask, estimate, run } from "./run.ts";
import { ROW_COLUMNS, rowsToCsv } from "./rows.ts";
import { replyText, type DecideSpawn } from "./llm.ts";
import type { Arms, Case, DecideFetch, DecideRow, QuestionSpec } from "./types.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

interface Fixture {
  readonly http: number;
  readonly request: unknown;
  readonly response: unknown;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixture(name: string): Fixture {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  if (!isRecord(raw) || typeof raw.http !== "number") throw new Error(`fixture ${name}: bad shape`);
  return { http: raw.http, request: raw.request, response: raw.response };
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  let at: unknown = value;
  for (const key of path) {
    if (typeof key === "number") at = Array.isArray(at) ? at[key] : undefined;
    else at = isRecord(at) ? at[key] : undefined;
  }
  return at;
}

function num(value: unknown): number {
  if (typeof value !== "number") throw new Error(`not a number: ${String(value)}`);
  return value;
}

interface Recorded {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** A fetch that answers each provider URL from a fixture and records every call. */
function fakeFetch(byHost: Readonly<Record<string, Fixture>>): { fetch: DecideFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: DecideFetch = async (url, init) => {
    const body: unknown = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const host = new URL(url).host;
    const fx = byHost[host];
    if (fx === undefined) throw new Error(`no fixture for ${host}`);
    return new Response(JSON.stringify(fx.response), { status: fx.http, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

/** No claude binary and a spawn that fails the test: no test may start a real CLI. */
const refuseSpawn: DecideSpawn = async () => {
  throw new Error("test tried to spawn a process");
};
const NO_CLI = { which: () => null, spawn: refuseSpawn };

/** A fake claude binary: records argv and stdin, replies with the recorded stream-json output. */
function fakeCli(stdout: string, exitCode = 0): { spawn: DecideSpawn; runs: { argv: readonly string[]; stdin: string }[] } {
  const runs: { argv: readonly string[]; stdin: string }[] = [];
  const spawn: DecideSpawn = async (argv, stdin) => {
    runs.push({ argv, stdin });
    return { exitCode, stdout };
  };
  return { spawn, runs };
}

const CLI_STDOUT = readFileSync(join(FIXTURES, "m0-llm-cli.jsonl"), "utf8");
const cliResult: unknown = JSON.parse(CLI_STDOUT.trim().split("\n").at(-1) ?? "null");

const JEV_HOST = "api.typesafe.ai";
const OPENAI_HOST = "api.openai.com";
const ANTHROPIC_HOST = "api.anthropic.com";

const KEYS = { jev: "test-jev-key-0001", openai: "test-openai-key-0001", anthropic: "test-anthropic-key-0001" };

const jevFx = fixture("m0-jev.json");
const decisionsFx = fixture("m0-decisions.json");
const refusalFx = fixture("m0-decisions-refusal.json");
const llmFx = fixture("m0-llm.UNVERIFIED.json");
const llmRefusalFx = fixture("llm-refusal.UNVERIFIED.json");

// The three M0 questions, written once in the contract's shape (the request bodies are derived from these).
const NEEDS_HUMAN: QuestionSpec = {
  name: "needs_human",
  type: "noul",
  instructions: "Does answering this shop message need a person to check live stock, a booking or a policy?",
};
const TOPIC: QuestionSpec = {
  name: "topic",
  type: "choice",
  instructions: "What is this shop message mainly about?",
  choices: [
    { name: "stock", definition: "Whether an item or size is available." },
    { name: "price", definition: "What something costs." },
    { name: "other", definition: "Anything else." },
  ],
};
const URGENCY: QuestionSpec = {
  name: "urgency",
  type: "score",
  instructions: "How urgent is this shop message?",
  levels: [
    { label: "Not urgent", description: "General question." },
    { label: "Somewhat urgent", description: "Wants an answer today." },
    { label: "Very urgent", description: "Safety, injury or a booking about to start." },
  ],
};
const M0_TEXT = "Do you have women's boots in size 6?";
const M0_CASE: Case = { id: "m04", input: M0_TEXT };

function only(rows: readonly DecideRow[], arm: string, question: string): DecideRow {
  const found = rows.filter((r) => r.answerer === arm && r.question_id === question);
  const row = found[0];
  if (found.length !== 1 || row === undefined) throw new Error(`expected one ${arm}/${question} row, got ${found.length}`);
  return row;
}

async function askOne(arm: "jev" | "decisions" | "llm", question: QuestionSpec): Promise<{ row: DecideRow; calls: Recorded[] }> {
  const { fetch, calls } = fakeFetch({ [JEV_HOST]: jevFx, [OPENAI_HOST]: decisionsFx, [ANTHROPIC_HOST]: llmFx });
  const arms: Arms = { jev: arm === "jev", decisions: arm === "decisions", llm: arm === "llm" ? "claude-haiku-5-5" : false };
  const result = await ask({ case: M0_CASE, questions: [question], arms }, { keys: KEYS, fetch, ...NO_CLI });
  return { row: only(result.rows, arm, question.name), calls };
}

const jevUsage = { tin: num(field(jevFx.response, "usage", "input_tokens")), tout: num(field(jevFx.response, "usage", "output_tokens")) };
const decUsage = { tin: num(field(decisionsFx.response, "usage", "input_tokens")), tout: num(field(decisionsFx.response, "usage", "output_tokens")) };
const llmUsage = { tin: num(field(llmFx.response, "usage", "input_tokens")), tout: num(field(llmFx.response, "usage", "output_tokens")) };

describe("D-MATRIX: each arm x type parses its recorded response into a jnj-record/1.2 row", () => {
  test("[unit] D-MATRIX-jev-noul: noul p maps to yes/no with confidence max(p, 1-p)", async () => {
    const { row } = await askOne("jev", NEEDS_HUMAN);
    const p = num(field(jevFx.response, "answers", "needs_human", "noul"));
    expect(row.outcome).toBe("answered");
    expect(row.output).toBe(p >= 0.5 ? "yes" : "no");
    expect(row.confidence).toBe(Math.max(p, 1 - p));
    expect(row.answer_set).toBe("yes|no");
    expect(row.answerer_model).toBe(JEV_PIN);
    expect(row.cost_usd).toBe(callCost(priceFor("jev", JEV_PIN), jevUsage.tin, jevUsage.tout));
    expect(row.evidence.probability).toBe(p);
  });

  test("[unit] D-MATRIX-jev-choice: choice and confidence from the response, probabilities in evidence", async () => {
    const { row } = await askOne("jev", TOPIC);
    expect(row.output).toBe(String(field(jevFx.response, "answers", "topic", "choice")));
    expect(row.confidence).toBe(num(field(jevFx.response, "answers", "topic", "confidence")));
    expect(row.answer_set).toBe("stock|price|other");
    expect(row.evidence.probabilities).toEqual({ other: 0, stock: 1, price: 0 });
  });

  test("[unit] D-MATRIX-jev-score: output is the label of the most probable level", async () => {
    const { row } = await askOne("jev", URGENCY);
    expect(row.output).toBe("Not urgent");
    expect(row.answer_set).toBe("Not urgent|Somewhat urgent|Very urgent");
    expect(row.confidence).toBe(num(field(jevFx.response, "answers", "urgency", "confidence")));
    expect(row.evidence.score).toBe(num(field(jevFx.response, "answers", "urgency", "score")));
    expect(row.evidence.probabilities).toEqual({ "Not urgent": 1, "Somewhat urgent": 0, "Very urgent": 0 });
  });

  test("[unit] D-MATRIX-decisions-noul: a predicate probability maps to yes/no", async () => {
    const { row, calls } = await askOne("decisions", NEEDS_HUMAN);
    const p = num(field(decisionsFx.response, "answers", 0, "probability"));
    expect(row.answerer).toBe("decisions");
    expect(row.answerer_model).toBe("gpt-6-luna");
    expect(row.output).toBe(p >= 0.5 ? "yes" : "no");
    expect(row.confidence).toBe(Math.max(p, 1 - p));
    expect(field(calls[0]?.body, "questions", 0, "type")).toBe("predicate");
    expect(row.cost_usd).toBe(callCost(priceFor("decisions", "gpt-6-luna"), decUsage.tin, decUsage.tout));
  });

  test("[unit] D-MATRIX-decisions-choice: choice, confidence and value probabilities", async () => {
    const { row } = await askOne("decisions", TOPIC);
    expect(row.output).toBe("stock");
    expect(row.confidence).toBe(num(field(decisionsFx.response, "answers", 1, "confidence")));
    expect(row.evidence.probabilities).toEqual({ stock: 0.98, price: 0, other: 0.02 });
  });

  test("[unit] D-MATRIX-decisions-score: label of the highest probability; weighted score in evidence only", async () => {
    const { row } = await askOne("decisions", URGENCY);
    const weighted = num(field(decisionsFx.response, "answers", 2, "score"));
    expect(row.output).toBe("Not urgent");
    expect(row.output).not.toBe(String(weighted));
    expect(row.evidence.score).toBe(weighted);
    expect(row.confidence).toBe(num(field(decisionsFx.response, "answers", 2, "confidence")));
  });

  test("[unit] D-MATRIX-llm-noul: JSON reply, thinking block skipped, no sampling params or prefill", async () => {
    const { row, calls } = await askOne("llm", NEEDS_HUMAN);
    expect(row.answerer).toBe("llm");
    expect(row.answerer_model).toBe("claude-haiku-5-5");
    expect(row.output).toBe("yes");
    expect(row.confidence).toBeNull();
    const body = calls[0]?.body;
    for (const banned of ["temperature", "top_p", "top_k"]) expect(field(body, banned)).toBeUndefined();
    const messages = field(body, "messages");
    expect(Array.isArray(messages) ? messages.map((m) => field(m, "role")) : []).toEqual(["user"]);
    expect(row.cost_usd).toBe(callCost(priceFor("llm", "claude-haiku-5-5"), llmUsage.tin, llmUsage.tout));
    // Blocks are selected by type: a non-text block is skipped even when it carries a text field.
    expect(replyText({ content: [{ type: "thinking", thinking: "x", text: "noise" }, { type: "text", text: "{}" }] })).toBe("{}");
  });

  test("[unit] D-MATRIX-llm-choice: the reply's choice is in answer_set", async () => {
    const { row } = await askOne("llm", TOPIC);
    expect(row.output).toBe("stock");
    expect(row.outcome).toBe("answered");
  });

  test("[unit] D-MATRIX-llm-score: the reply's level label", async () => {
    const { row } = await askOne("llm", URGENCY);
    expect(row.output).toBe("Not urgent");
  });

  test("[unit] D-MATRIX-rule-choice: keywords pick match, otherwise the other option; no call, cost 0", async () => {
    const q: QuestionSpec = {
      name: "is_stock",
      type: "choice",
      instructions: "Is this about stock?",
      choices: [
        { name: "stock", definition: "About availability." },
        { name: "not_stock", definition: "Anything else." },
      ],
    };
    const { fetch, calls } = fakeFetch({});
    const rule = { keywords: ["size", "in stock"], match: "stock", otherwise: "not_stock" };
    const result = await run(
      { cases: [M0_CASE, { id: "m05", input: "What time do you open?" }], questions: [q], arms: { jev: false, llm: false, rule } },
      { keys: {}, fetch, ...NO_CLI },
    );
    expect(calls.length).toBe(0);
    expect(result.rows.map((r) => [r.case_id, r.output, r.cost_usd, r.confidence])).toEqual([
      ["m04", "stock", 0, null],
      ["m05", "not_stock", 0, null],
    ]);
    expect(result.rows.every((r) => r.answerer === "rule" && r.price_table_date === null)).toBe(true);
  });
});

describe("D-OUTCOME: refusals and unsupported inputs become outcome rows, never wrong answers", () => {
  const RELIGION: QuestionSpec = {
    name: "religion",
    type: "choice",
    instructions: "Infer the religion of the person who wrote this message.",
    choices: [
      { name: "christian", definition: "Christian." },
      { name: "muslim", definition: "Muslim." },
      { name: "jewish", definition: "Jewish." },
      { name: "other", definition: "Any other or none." },
    ],
  };

  test("[unit] D-OUTCOME-decisions-refusal: a refusal answer is outcome refused with no output", async () => {
    const { fetch, calls } = fakeFetch({ [OPENAI_HOST]: refusalFx });
    const input = String(field(refusalFx.request, "input"));
    const result = await ask(
      { case: { id: "r01", input }, questions: [RELIGION], arms: { jev: false, decisions: true, llm: false } },
      { keys: KEYS, fetch, ...NO_CLI },
    );
    expect(calls[0]?.body).toEqual(refusalFx.request);
    const row = only(result.rows, "decisions", "religion");
    expect(row.outcome).toBe("refused");
    expect(row.output).toBeNull();
    expect(row.label).toBeNull();
    expect(row.tokens_in).toBe(num(field(refusalFx.response, "usage", "input_tokens")));
  });

  test("[unit] D-OUTCOME-llm-refusal: stop_reason refusal is outcome refused on every question of the call", async () => {
    const { fetch } = fakeFetch({ [ANTHROPIC_HOST]: llmRefusalFx });
    const result = await ask(
      { case: { id: "r01", input: "Hi, I'm Sam." }, questions: [RELIGION, NEEDS_HUMAN], arms: { jev: false, llm: "claude-haiku-5-5" } },
      { keys: KEYS, fetch, ...NO_CLI },
    );
    expect(result.rows.map((r) => [r.question_id, r.outcome, r.output])).toEqual([
      ["religion", "refused", null],
      ["needs_human", "refused", null],
    ]);
  });

  test("[unit] D-OUTCOME-jev-image-unsupported: an image input is unsupported for every arm and makes no call", async () => {
    const { fetch, calls } = fakeFetch({ [JEV_HOST]: jevFx, [OPENAI_HOST]: decisionsFx, [ANTHROPIC_HOST]: llmFx });
    const image: Case = { id: "img1", input: { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" } };
    const dataUri: Case = { id: "img2", input: "data:image/png;base64,iVBORw0KGgo=" };
    const result = await run(
      { cases: [image, dataUri], questions: [TOPIC], arms: { jev: true, decisions: true, llm: "claude-haiku-5-5" } },
      { keys: KEYS, fetch, ...NO_CLI },
    );
    expect(calls.length).toBe(0);
    expect(result.rows.length).toBe(6);
    expect(result.rows.every((r) => r.outcome === "unsupported" && r.output === null && r.cost_usd === 0)).toBe(true);
    expect(result.rows.filter((r) => r.answerer === "jev").every((r) => /text only/.test(r.evidence.reason ?? ""))).toBe(true);
  });

  test("[unit] D-OUTCOME-llm-outside-answer-set: a reply outside answer_set is outcome error, never an answer", async () => {
    const bad: Fixture = {
      http: 200,
      request: null,
      response: {
        ...(isRecord(llmFx.response) ? llmFx.response : {}),
        content: [{ type: "text", text: "{\"needs_human\":\"maybe\",\"topic\":\"stock\"}" }],
      },
    };
    const { fetch } = fakeFetch({ [ANTHROPIC_HOST]: bad });
    const result = await ask({ case: M0_CASE, questions: [NEEDS_HUMAN, TOPIC], arms: { jev: false } }, { keys: KEYS, fetch, ...NO_CLI });
    const wrong = only(result.rows, "llm", "needs_human");
    expect(wrong.outcome).toBe("error");
    expect(wrong.output).toBeNull();
    expect(wrong.evidence.reason).toMatch(/answer_set/);
    expect(only(result.rows, "llm", "topic").output).toBe("stock");
  });

  test("[unit] D-OUTCOME-rule-unsupported: the rule answers 2-option choice only", async () => {
    const rule = { keywords: ["size"], match: "yes", otherwise: "no" };
    const result = await ask({ case: M0_CASE, questions: [NEEDS_HUMAN, TOPIC, URGENCY], arms: { jev: false, llm: false, rule } }, NO_CLI);
    expect(result.rows.map((r) => r.outcome)).toEqual(["unsupported", "unsupported", "unsupported"]);
  });
});

describe("D-MULTI, D-PIN, D-BUDGET, D-NOKEY", () => {
  test("[unit] D-MULTI: three questions on one case make one jev and one decisions request", async () => {
    const { fetch, calls } = fakeFetch({ [JEV_HOST]: jevFx, [OPENAI_HOST]: decisionsFx });
    const result = await ask(
      { case: M0_CASE, questions: [NEEDS_HUMAN, TOPIC, URGENCY], arms: { jev: true, decisions: true, llm: false } },
      { keys: KEYS, fetch, ...NO_CLI },
    );
    expect(calls.map((c) => new URL(c.url).host)).toEqual([JEV_HOST, OPENAI_HOST]);
    // Decisions: the request built from the contract equals the M0 body that returned HTTP 200.
    expect(calls[1]?.body).toEqual(decisionsFx.request);
    // Jev: same state, pin and question ids as the M0 body; choice criteria identical.
    const jevBody = calls[0]?.body;
    expect(field(jevBody, "state")).toBe(field(jevFx.request, "state"));
    expect(field(jevBody, "model")).toBe(JEV_PIN);
    const jevQuestions = field(jevBody, "questions");
    expect(isRecord(jevQuestions) ? Object.keys(jevQuestions) : []).toEqual(["needs_human", "topic", "urgency"]);
    expect(field(jevBody, "questions", "topic")).toEqual(field(jevFx.request, "questions", "topic"));
    expect(field(jevBody, "questions", "needs_human")).toEqual(field(jevFx.request, "questions", "needs_human"));
    expect(result.rows.length).toBe(6);
    // Input paid once: the call's cost is split over its question rows, so the rows sum to one call.
    const jevRows = result.rows.filter((r) => r.answerer === "jev");
    const sum = jevRows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    expect(sum).toBeCloseTo(callCost(priceFor("jev", JEV_PIN), jevUsage.tin, jevUsage.tout), 15);
    expect(jevRows.every((r) => r.evidence.shared_by === 3)).toBe(true);
  });

  test("[unit] D-PIN: floating or unknown llm ids are rejected with the accepted list", () => {
    for (const id of ["claude-haiku-latest", "haiku", "claude-haiku-4-5", ""]) {
      expect(() => resolveLlmModel(id)).toThrow(DecideError);
      expect(() => resolveLlmModel(id)).toThrow(ACCEPTED_LLM_MODELS.join(", "));
      expect(() => estimate({ cases: [M0_CASE], questions: [TOPIC], arms: { llm: id } })).toThrow(/accepted/);
    }
    expect(resolveLlmModel("claude-haiku-5-5").model).toBe("claude-haiku-5-5");
  });

  test("[unit] D-PIN: every row echoes the resolved model id, prompt_version and price_table_date", async () => {
    const { fetch } = fakeFetch({ [JEV_HOST]: jevFx, [OPENAI_HOST]: decisionsFx, [ANTHROPIC_HOST]: llmFx });
    const result = await ask(
      { case: M0_CASE, questions: [TOPIC], arms: { jev: true, decisions: true }, options: { promptVersion: "shop-q.v3", runId: "run-pin" } },
      { keys: KEYS, fetch, ...NO_CLI },
    );
    expect(result.rows.map((r) => [r.answerer, r.answerer_model, r.prompt_version, r.run_id, r.price_table_date])).toEqual([
      ["jev", JEV_PIN, "shop-q.v3", "run-pin", PRICE_TABLE_DATE],
      ["decisions", "gpt-6-luna", "shop-q.v3", "run-pin", PRICE_TABLE_DATE],
      ["llm", "claude-haiku-5-5", "shop-q.v3", "run-pin", PRICE_TABLE_DATE],
    ]);
  });

  test("[unit] D-BUDGET: a dry run makes 0 calls and returns the price and cases needed", async () => {
    const { fetch, calls } = fakeFetch({ [JEV_HOST]: jevFx, [ANTHROPIC_HOST]: llmFx });
    const cases = [M0_CASE, { id: "m05", input: "What time do you open?" }];
    const result = await run({ cases, questions: [NEEDS_HUMAN, TOPIC], options: { dryRun: true } }, { keys: KEYS, fetch, ...NO_CLI });
    expect(calls.length).toBe(0);
    expect(result.calls).toBe(0);
    expect(result.rows.length).toBe(0);
    expect(result.estimate.calls).toBe(4);
    expect(result.estimate.costUsd).toBeGreaterThan(0);
    expect(result.estimate.casesForVerdict).toBe(MIN_PAIRED);
    expect(result.estimate.casesShort).toBe(MIN_PAIRED - cases.length);
    expect(estimate({ cases, questions: [NEEDS_HUMAN, TOPIC] })).toEqual(result.estimate);
  });

  test("[unit] D-BUDGET: no call after the cap; the rest are error rows with reason budget", async () => {
    const { fetch, calls } = fakeFetch({ [JEV_HOST]: jevFx });
    const cases = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, input: M0_TEXT }));
    const arms: Arms = { jev: true, llm: false };
    const perCall = estimate({ cases: [M0_CASE], questions: [TOPIC], arms }).costUsd;
    const budgetUsd = perCall * 2.5;
    const result = await run({ cases, questions: [TOPIC], arms, options: { budgetUsd } }, { keys: KEYS, fetch, ...NO_CLI });
    const answered = result.rows.filter((r) => r.outcome === "answered");
    const stopped = result.rows.filter((r) => r.evidence.reason === "budget");
    expect(calls.length).toBe(answered.length);
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.length + stopped.length).toBe(cases.length);
    expect(stopped.every((r) => r.outcome === "error" && r.output === null && r.cost_usd === 0)).toBe(true);
    expect(result.stoppedByBudget).toBe(true);
    expect(result.spentUsd).toBeLessThanOrEqual(budgetUsd);
    const callsAfterCap = calls.length - answered.length;
    expect(callsAfterCap).toBe(0);
  });

  test("[unit] D-NOKEY: a missing key fails only that arm with a named reason", async () => {
    const { fetch, calls } = fakeFetch({ [JEV_HOST]: jevFx, [OPENAI_HOST]: decisionsFx, [ANTHROPIC_HOST]: llmFx });
    const result = await ask(
      { case: M0_CASE, questions: [TOPIC], arms: { jev: true, decisions: true } },
      { keys: { jev: KEYS.jev, anthropic: KEYS.anthropic }, fetch, ...NO_CLI },
    );
    expect(calls.map((c) => new URL(c.url).host)).toEqual([JEV_HOST, ANTHROPIC_HOST]);
    const dec = only(result.rows, "decisions", "topic");
    expect(dec.outcome).toBe("error");
    expect(dec.evidence.reason).toBe("missing key: decisions needs keys.openai");
    expect(only(result.rows, "jev", "topic").outcome).toBe("answered");
    expect(only(result.rows, "llm", "topic").outcome).toBe("answered");
  });
});

describe("llm arm through the local claude CLI (claude-cli transport)", () => {
  async function askCli(question: QuestionSpec): Promise<DecideRow> {
    const { fetch, calls } = fakeFetch({});
    const { spawn } = fakeCli(CLI_STDOUT);
    const result = await ask({ case: M0_CASE, questions: [question], arms: { jev: false } }, { keys: {}, fetch, spawn, which: () => "/fake/bin/claude" });
    expect(calls.length).toBe(0);
    return only(result.rows, "llm", question.name);
  }
  const usage = field(cliResult, "modelUsage", "claude-haiku-5-5");
  const cliTokensIn = ["inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"].reduce((s, k) => s + num(field(usage, k)), 0);
  const cliCost = num(field(cliResult, "total_cost_usd"));

  test("[unit] D-MATRIX-llm-cli-noul: the recorded CLI reply answers yes/no; tokens and cost from the result event", async () => {
    const row = await askCli(NEEDS_HUMAN);
    expect(row.output).toBe("yes");
    expect(row.tokens_in).toBe(cliTokensIn);
    expect(row.tokens_out).toBe(num(field(usage, "outputTokens")));
    expect(row.cost_usd).toBe(cliCost);
    expect(row.evidence.transport).toBe("claude-cli");
    expect(row.evidence.cost_basis).toBe("claude-cli list price (subscription)");
  });

  test("[unit] D-MATRIX-llm-cli-choice: the recorded CLI reply's choice", async () => {
    expect((await askCli(TOPIC)).output).toBe("stock");
  });

  test("[unit] D-MATRIX-llm-cli-score: the recorded CLI reply's level label", async () => {
    expect((await askCli(URGENCY)).output).toBe("Not urgent");
  });

  test("[unit] D-PROXY: no key plus a claude binary picks the cli transport, lean flags, prompt on stdin, 0 HTTPS calls", async () => {
    const { fetch, calls } = fakeFetch({});
    const { spawn, runs } = fakeCli(CLI_STDOUT);
    const result = await ask({ case: M0_CASE, questions: [NEEDS_HUMAN, TOPIC, URGENCY], arms: { jev: false } }, { keys: {}, fetch, spawn, which: () => "/fake/bin/claude" });
    expect(calls.length).toBe(0);
    expect(runs.length).toBe(1);
    const argv = runs[0]?.argv ?? [];
    expect(argv.slice(0, 4)).toEqual(["/fake/bin/claude", "-p", "--model", "claude-haiku-5-5"]);
    for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections", "--no-session-persistence"]) {
      expect(argv).toContain(flag);
    }
    expect(argv).not.toContain("--bare");
    expect(runs[0]?.stdin).toContain(JSON.stringify(M0_TEXT));
    expect(result.rows.map((r) => r.output)).toEqual(["yes", "stock", "Not urgent"]);
    expect(result.rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0)).toBeCloseTo(cliCost, 15);
    // A key, when given, wins: messages-api, and no process is started.
    const api = fakeFetch({ [ANTHROPIC_HOST]: llmFx });
    const withKey = await ask({ case: M0_CASE, questions: [TOPIC], arms: { jev: false } }, { keys: KEYS, fetch: api.fetch, spawn: refuseSpawn, which: () => "/fake/bin/claude" });
    expect(only(withKey.rows, "llm", "topic").evidence.transport).toBe("messages-api");
    // The hosted API can turn the cli off.
    const off = await ask({ case: M0_CASE, questions: [TOPIC], arms: { jev: false } }, { keys: {}, fetch, spawn, which: () => "/fake/bin/claude", llmTransports: ["messages-api"] });
    expect(only(off.rows, "llm", "topic").evidence.reason).toBe("missing key: llm needs keys.anthropic");
    expect(runs.length).toBe(1);
  });

  test("[unit] D-NOKEY-llm: no key and no claude binary fails the llm arm only, with a named reason", async () => {
    const { fetch, calls } = fakeFetch({ [JEV_HOST]: jevFx });
    const result = await ask({ case: M0_CASE, questions: [TOPIC] }, { keys: { jev: KEYS.jev }, fetch, ...NO_CLI });
    expect(calls.length).toBe(1);
    expect(only(result.rows, "jev", "topic").outcome).toBe("answered");
    const llm = only(result.rows, "llm", "topic");
    expect([llm.outcome, llm.evidence.reason]).toEqual(["error", "missing key: llm needs keys.anthropic or a claude binary on PATH"]);
  });

  test("[unit] D-COUNTS: run() reports answered, refused, unsupported, error and incomplete per arm", async () => {
    const { fetch } = fakeFetch({ [JEV_HOST]: jevFx, [OPENAI_HOST]: refusalFx });
    const cases: Case[] = [M0_CASE, { id: "img", input: { type: "image" } }, { id: "m06", input: M0_TEXT }];
    const perCall = estimate({ cases: [M0_CASE], questions: [TOPIC], arms: { jev: true, llm: false } }).costUsd;
    const result = await run(
      { cases, questions: [TOPIC], arms: { jev: true, decisions: true, llm: false }, options: { budgetUsd: perCall * 1.5 } },
      { keys: KEYS, fetch, ...NO_CLI },
    );
    expect(result.counts.jev).toEqual({ answered: 1, refused: 0, unsupported: 1, error: 0, incomplete: 1 });
    expect(result.counts.decisions.unsupported).toBe(1);
    const total = Object.values(result.counts).reduce((s, c) => s + c.answered + c.refused + c.unsupported + c.error + c.incomplete, 0);
    expect(total).toBe(result.rows.length);
  });
});

describe("rows, prices and fixtures", () => {
  test("[unit] D-ROWS: rows written as CSV validate as jnj-record/1.2 with every label empty", async () => {
    const { fetch } = fakeFetch({ [JEV_HOST]: jevFx, [OPENAI_HOST]: decisionsFx, [ANTHROPIC_HOST]: llmRefusalFx });
    const result = await ask(
      { case: M0_CASE, questions: [NEEDS_HUMAN, TOPIC, URGENCY], arms: { jev: true, decisions: true, rule: { keywords: ["x"], match: "a", otherwise: "b" } } },
      { keys: KEYS, fetch, ...NO_CLI },
    );
    const csv = rowsToCsv(result.rows);
    expect(csv.split("\n")[0]).toBe(formatRow(ROW_COLUMNS).trimEnd());
    const checked = validate(csv);
    expect(checked.errors).toEqual([]);
    expect(checked.rows.length).toBe(12);
    expect(result.rows.every((r) => r.label === null && r.label_source === null && r.format_version === "jnj-record/1.2")).toBe(true);
  });

  test("[unit] D-KEY: no key appears in rows, evidence or the CSV", async () => {
    const { fetch, calls } = fakeFetch({ [JEV_HOST]: jevFx, [OPENAI_HOST]: decisionsFx, [ANTHROPIC_HOST]: llmFx });
    const result = await ask({ case: M0_CASE, questions: [TOPIC], arms: { jev: true, decisions: true } }, { keys: KEYS, fetch, ...NO_CLI });
    const text = JSON.stringify(result) + rowsToCsv(result.rows);
    for (const key of Object.values(KEYS)) expect(text.includes(key)).toBe(false);
    expect(calls.map((c) => Object.values(c.headers).some((h) => h.includes("test-")))).toEqual([true, true, true]);
  });

  test("[unit] D-PRICE: the table holds the dated list prices and rejects unknown ids", () => {
    expect(priceFor("jev", JEV_PIN)).toMatchObject({ inputUsdPerMTok: 0.042, outputUsdPerMTok: 0 });
    expect(priceFor("decisions", "gpt-6-luna")).toMatchObject({ inputUsdPerMTok: 0.1, outputUsdPerMTok: 0 });
    expect(priceFor("llm", "claude-haiku-5-5")).toMatchObject({ inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 });
    expect(callCost(priceFor("llm", "claude-haiku-5-5"), 100_000, 100_000)).toBeCloseTo(0.06, 12);
    expect(callCost(priceFor("llm", "claude-haiku-5-5"), 1_000_000, 1_000_000)).toBeCloseTo(3, 12);
    expect(() => priceFor("llm", "haiku")).toThrow(DecideError);
    expect(PRICE_TABLE_DATE).toBe("2026-10-08");
  });

  test("[unit] D-FIXTURES: every fixture holds no secret field or key-like string; llm ones are marked UNVERIFIED", () => {
    for (const name of ["m0-jev.json", "m0-decisions.json", "m0-decisions-refusal.json", "m0-llm.UNVERIFIED.json", "llm-refusal.UNVERIFIED.json"]) {
      const raw: unknown = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
      expect(() => assertNoSecrets(raw, name)).not.toThrow();
      if (name.includes("UNVERIFIED")) expect(field(raw, "verified")).toBe(false);
    }
    for (const line of CLI_STDOUT.trim().split("\n")) {
      const event: unknown = JSON.parse(line);
      expect(() => assertNoSecrets(event, "m0-llm-cli.jsonl")).not.toThrow();
    }
    expect(/\/Users\/|\/private\/|\/tmp\//.test(CLI_STDOUT)).toBe(false);
  });

  test("[unit] D-SPEC: bad question specs are rejected before any call", () => {
    const one: QuestionSpec = { name: "q", type: "choice", instructions: "x", choices: [{ name: "a", definition: "a" }] };
    expect(() => estimate({ cases: [M0_CASE], questions: [one] })).toThrow(/2 to 10/);
    const pipe: QuestionSpec = { name: "q", type: "choice", instructions: "x", choices: [{ name: "a|b", definition: "a" }, { name: "c", definition: "c" }] };
    expect(() => estimate({ cases: [M0_CASE], questions: [pipe] })).toThrow(/\|/);
    const levels: QuestionSpec = { name: "q", type: "score", instructions: "x", levels: Array.from({ length: 11 }, (_, i) => ({ label: `l${i}`, description: "d" })) };
    expect(() => estimate({ cases: [M0_CASE], questions: [levels] })).toThrow(/2 to 10/);
    expect(() => estimate({ cases: [M0_CASE, M0_CASE], questions: [TOPIC] })).toThrow(/duplicate case/);
  });
});
