// The jev arm: one TypeSafe systemone request per case carrying every question, checked with src/jev-answer.ts.
import { JEV_PIN, checkJevAnswers, specsFromRequest } from "../jev-answer.ts";
import { questionText } from "./questions.ts";
import type { CallResult, QuestionResult, QuestionSpec } from "./types.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jevQuestion(q: QuestionSpec): Record<string, unknown> {
  const instructions = { question: questionText(q) };
  if (q.type === "noul") return { type: "noul", instructions };
  if (q.type === "choice") return { type: "choice", instructions, criteria: Object.fromEntries(q.choices.map((c) => [c.name, c.definition])) };
  return { type: "score", instructions, criteria: q.levels.map((l) => `${l.label}: ${l.description}`) };
}

export function jevBody(text: string, questions: readonly QuestionSpec[]): Record<string, unknown> {
  return { state: text, model: JEV_PIN, questions: Object.fromEntries(questions.map((q) => [q.name, jevQuestion(q)])) };
}

export function jevHeaders(key: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${key}` };
}

function error(reason: string): QuestionResult {
  return { outcome: "error", output: null, confidence: null, reason };
}

function usage(response: unknown, name: string): number | null {
  const u = isRecord(response) && isRecord(response.usage) ? response.usage[name] : undefined;
  return typeof u === "number" && Number.isSafeInteger(u) && u >= 0 ? u : null;
}

/** Each question is checked on its own, so one bad answer fails that row only. */
export function parseJev(http: number, response: unknown, body: unknown, questions: readonly QuestionSpec[]): CallResult {
  const tokensIn = usage(response, "input_tokens");
  const tokensOut = usage(response, "output_tokens");
  if (http < 200 || http > 299) return { http, tokensIn, tokensOut, results: questions.map(() => error(`http ${http}`)) };
  const derived = specsFromRequest(body);
  if (!derived.ok) return { http, tokensIn, tokensOut, results: questions.map(() => error(`jev request ${derived.reason}`)) };
  const results = questions.map((q): QuestionResult => {
    const spec = derived.specs[q.name];
    if (spec === undefined) return error("jev request missing question");
    const check = checkJevAnswers(response, { [q.name]: spec });
    if (!check.ok) return error(`jev check ${check.reason}`);
    const a = check.answers[q.name];
    if (a === undefined) return error("jev check missing-answer");
    if (a.type === "noul") {
      return { outcome: "answered", output: a.noul >= 0.5 ? "yes" : "no", confidence: Math.max(a.noul, 1 - a.noul), probability: a.noul };
    }
    if (a.type === "choice") {
      return { outcome: "answered", output: a.choice, confidence: a.confidence, ...(a.probabilities ? { probabilities: a.probabilities } : {}) };
    }
    if (q.type !== "score") return error("jev check type");
    const labels = q.levels.map((l) => l.label);
    let index = Math.round(a.score);
    let probabilities: Record<string, number> | undefined;
    if (a.probabilities !== null) {
      probabilities = {};
      let best = -1;
      for (let i = 0; i < labels.length; i++) {
        const p = a.probabilities[String(i)] ?? 0;
        probabilities[labels[i] ?? String(i)] = p;
        if (p > best) [best, index] = [p, i];
      }
    }
    const output = labels[index];
    if (output === undefined) return error("jev check score-range");
    return { outcome: "answered", output, confidence: a.confidence, score: a.score, ...(probabilities ? { probabilities } : {}) };
  });
  return { http, tokensIn, tokensOut, results };
}
