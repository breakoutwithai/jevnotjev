// The decisions arm: POST /v1/decisions (gpt-6-luna), one request per case with every question.
// Shapes measured in M0 (2026-10-08): choices {value, description}, levels {label, description}; refusal is {type, name} only.
import { questionText } from "./questions.ts";
import type { CallResult, QuestionResult, QuestionSpec } from "./types.ts";

export const DECISIONS_URL = "https://api.openai.com/v1/decisions";
export const DECISIONS_MODEL = "gpt-6-luna";

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

function decisionsQuestion(q: QuestionSpec): Record<string, unknown> {
  const base = { name: q.name, instructions: questionText(q) };
  if (q.type === "noul") return { type: "predicate", ...base };
  if (q.type === "choice") return { type: "choice", ...base, choices: q.choices.map((c) => ({ value: c.name, description: c.definition })) };
  return { type: "score", ...base, levels: q.levels.map((l) => ({ label: l.label, description: l.description })) };
}

export function decisionsBody(text: string, questions: readonly QuestionSpec[]): Record<string, unknown> {
  return { model: DECISIONS_MODEL, input: text, questions: questions.map(decisionsQuestion) };
}

export function decisionsHeaders(key: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${key}` };
}

function error(reason: string): QuestionResult {
  return { outcome: "error", output: null, confidence: null, reason };
}

function usage(response: unknown, name: string): number | null {
  const u = isRecord(response) && isRecord(response.usage) ? response.usage[name] : undefined;
  return typeof u === "number" && Number.isSafeInteger(u) && u >= 0 ? u : null;
}

/** Probabilities keyed by `key` of each item; null when any item is malformed. */
function probabilityMap(raw: unknown, key: "value" | "label"): Record<string, number> | null {
  if (!Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const item of raw) {
    if (!isRecord(item) || !unit(item.probability)) return null;
    const name = item[key];
    if (typeof name !== "string") return null;
    out[name] = item.probability;
  }
  return out;
}

function parseAnswer(q: QuestionSpec, a: { readonly [key: string]: unknown }): QuestionResult {
  if (a.type === "refusal") return { outcome: "refused", output: null, confidence: null, reason: "decisions refusal" };
  if (q.type === "noul") {
    if (a.type !== "predicate") return error(`answer type ${String(a.type)}`);
    if (!unit(a.probability)) return error("predicate probability out of range");
    const p = a.probability;
    return { outcome: "answered", output: p >= 0.5 ? "yes" : "no", confidence: Math.max(p, 1 - p), probability: p };
  }
  if (a.type !== q.type) return error(`answer type ${String(a.type)}`);
  const confidence = unit(a.confidence) ? a.confidence : null;
  if (q.type === "choice") {
    const names = q.choices.map((c) => c.name);
    if (typeof a.choice !== "string" || !names.includes(a.choice)) return error("choice outside answer_set");
    const probabilities = probabilityMap(a.probabilities, "value");
    return { outcome: "answered", output: a.choice, confidence, ...(probabilities ? { probabilities } : {}) };
  }
  const labels = q.levels.map((l) => l.label);
  const probabilities = probabilityMap(a.probabilities, "label");
  if (probabilities === null) return error("score probabilities missing or malformed");
  let output: string | null = null;
  let best = -1;
  for (const label of labels) {
    const p = probabilities[label] ?? 0;
    if (p > best) [best, output] = [p, label];
  }
  if (output === null) return error("score has no level");
  const score = typeof a.score === "number" && Number.isFinite(a.score) ? a.score : undefined;
  return { outcome: "answered", output, confidence, probabilities, ...(score !== undefined ? { score } : {}) };
}

export function parseDecisions(http: number, response: unknown, questions: readonly QuestionSpec[]): CallResult {
  const tokensIn = usage(response, "input_tokens");
  const tokensOut = usage(response, "output_tokens");
  if (http < 200 || http > 299) return { http, tokensIn, tokensOut, results: questions.map(() => error(`http ${http}`)) };
  const answers = isRecord(response) && Array.isArray(response.answers) ? response.answers : [];
  const results = questions.map((q): QuestionResult => {
    const a = answers.find((x: unknown) => isRecord(x) && x.name === q.name);
    return isRecord(a) ? parseAnswer(q, a) : error("missing answer");
  });
  return { http, tokensIn, tokensOut, results };
}
