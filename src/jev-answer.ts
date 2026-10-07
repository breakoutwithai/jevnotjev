/**
 * One shared check for a TypeSafe Jev systemone response. Pure: no network, no I/O.
 * Clients import it by path; the cases in jev-answer.vectors.json are the shared test set.
 * Handles all three question types: choice, noul and score.
 *
 * FROZEN for external consumers that import this file or parse its vectors by path:
 *   - JevReason / JEV_REASONS (exactly the original nine) and the checkJevResponse signature;
 *   - the schema of jev-answer.vectors.json: every entry is { name, questions, expect }, never `specs`.
 * Typed (noul/score) vectors live in jev-answer.typed-vectors.json. Consumers, by path:
 *   ~/.agents/skills/repo-interest-classifier/scripts/ric.ts and ric.test.ts
 *   ~/.agents/skills/create-ref-handovers/scripts/jev-checks.ts and jev-checks.test.ts
 *   ~/.agents/skills/jev-vs-claude/scripts/run.ts
 *   src/backstage/providers.ts, scripts/uc13/arms.ts
 */

export const JEV_PIN = "jev-1.13.0";

/** Reasons checkJevResponse can return. Frozen: existing callers index a Record<JevReason, ...> with it. */
export type JevReason =
  | "not-object" | "model" | "missing-answer" | "choice" | "confidence-range" | "keys" | "prob-range" | "mass" | "argmax";

export const JEV_REASONS: readonly JevReason[] = [
  "not-object", "model", "missing-answer", "choice", "confidence-range", "keys", "prob-range", "mass", "argmax",
];

/** Reasons checkJevAnswers can return: the original ones plus the type-aware ones. */
export type JevAnswerReason = JevReason | "type" | "noul-range" | "score-range" | "legend";

export const JEV_ANSWER_REASONS: readonly JevAnswerReason[] = [
  ...JEV_REASONS, "type", "noul-range", "score-range", "legend",
];

export interface JevChecked {
  readonly choice: string;
  readonly confidence: number | null;
  readonly probabilities: Readonly<Record<string, number>> | null;
}

export type JevCheck =
  | { readonly ok: true; readonly answers: Readonly<Record<string, JevChecked>> }
  | { readonly ok: false; readonly questionId: string | null; readonly reason: JevReason };

/** What one question expects back. `levels` is the length of a score question's criteria array (2..10). */
export type JevSpec =
  | { readonly type: "choice"; readonly options: readonly string[] }
  | { readonly type: "noul" }
  | { readonly type: "score"; readonly levels: number };

export type JevCheckedAnswer =
  | ({ readonly type: "choice" } & JevChecked)
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "score";
      readonly score: number;
      readonly confidence: number | null;
      readonly legend: Readonly<Record<string, string>> | null;
      readonly probabilities: Readonly<Record<string, number>> | null;
    };

export type JevAnswersCheck =
  | { readonly ok: true; readonly answers: Readonly<Record<string, JevCheckedAnswer>> }
  | { readonly ok: false; readonly questionId: string | null; readonly reason: JevAnswerReason };

export type JevSpecsReason = "not-object" | "no-questions" | "question" | "type" | "criteria";

export type JevSpecs =
  | { readonly ok: true; readonly specs: Readonly<Record<string, JevSpec>> }
  | { readonly ok: false; readonly questionId: string | null; readonly reason: JevSpecsReason };

/** Probabilities must sum to 1 within this; exported so other checkers of a Jev answer use the same bound. */
export const MASS_TOLERANCE = 0.02;
/** Jev's choice must carry the top probability within this. */
export const ARGMAX_TOLERANCE = 1e-9;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failAnswer(questionId: string | null, reason: JevAnswerReason): JevAnswersCheck {
  return { ok: false, questionId, reason };
}

function inUnitRange(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

class Fault {
  constructor(readonly reason: JevAnswerReason) {}
}

/** Optional confidence: absent or null is null; anything else must lie in [0, 1]. */
function readConfidence(raw: unknown): number | null | Fault {
  if (raw === undefined || raw === null) return null;
  return inUnitRange(raw) ? raw : new Fault("confidence-range");
}

/** Optional probabilities over exactly `keys`: each in [0, 1], summing to 1 within tolerance. */
function readProbabilities(raw: unknown, keys: readonly string[]): Record<string, number> | null | Fault {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return new Fault("keys");
  if (Object.keys(raw).length !== keys.length || !keys.every((k) => Object.hasOwn(raw, k))) return new Fault("keys");
  const probs: Record<string, number> = {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (!inUnitRange(v)) return new Fault("prob-range");
    Object.defineProperty(probs, k, { value: v, enumerable: true });
  }
  const total = Object.values(probs).reduce((s, v) => s + v, 0);
  if (Math.abs(total - 1) > MASS_TOLERANCE) return new Fault("mass");
  return probs;
}

/** Optional legend: keys exactly the level keys, string values. */
function readLegend(raw: unknown, keys: readonly string[]): Record<string, string> | null | Fault {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return new Fault("legend");
  if (Object.keys(raw).length !== keys.length || !keys.every((k) => Object.hasOwn(raw, k))) return new Fault("legend");
  const legend: Record<string, string> = {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (typeof v !== "string") return new Fault("legend");
    Object.defineProperty(legend, k, { value: v, enumerable: true });
  }
  return legend;
}

function checkChoice(a: Readonly<Record<string, unknown>>, options: readonly string[]): JevCheckedAnswer | Fault {
  const choice = a.choice;
  if (typeof choice !== "string" || !options.includes(choice)) return new Fault("choice");
  const confidence = readConfidence(a.confidence);
  if (confidence instanceof Fault) return confidence;
  const probabilities = readProbabilities(a.probabilities, options);
  if (probabilities instanceof Fault) return probabilities;
  if (probabilities !== null) {
    const top = Math.max(...Object.values(probabilities));
    if ((probabilities[choice] ?? 0) < top - ARGMAX_TOLERANCE) return new Fault("argmax");
  }
  return { type: "choice", choice, confidence, probabilities };
}

function checkNoul(a: Readonly<Record<string, unknown>>): JevCheckedAnswer | Fault {
  return inUnitRange(a.noul) ? { type: "noul", noul: a.noul } : new Fault("noul-range");
}

function checkScore(a: Readonly<Record<string, unknown>>, levels: number): JevCheckedAnswer | Fault {
  const score = a.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > levels - 1) return new Fault("score-range");
  const confidence = readConfidence(a.confidence);
  if (confidence instanceof Fault) return confidence;
  const keys = Array.from({ length: levels }, (_, i) => String(i));
  const legend = readLegend(a.legend, keys);
  if (legend instanceof Fault) return legend;
  const probabilities = readProbabilities(a.probabilities, keys);
  if (probabilities instanceof Fault) return probabilities;
  return { type: "score", score, confidence, legend, probabilities };
}

/**
 * Type-aware check. `specs` maps each question id to what it expects; every id must be answered.
 * An answer that carries `type` must agree with its spec; a missing `type` is accepted (older choice vectors omit it).
 */
export function checkJevAnswers(
  response: unknown,
  specs: Readonly<Record<string, JevSpec>>,
  pin: string = JEV_PIN,
): JevAnswersCheck {
  return checkSpecs(response, specs, pin, true);
}

function checkSpecs(response: unknown, specs: Readonly<Record<string, JevSpec>>, pin: string, enforceType: boolean): JevAnswersCheck {
  if (!isRecord(response)) return failAnswer(null, "not-object");
  if (response.model !== pin) return failAnswer(null, "model");
  const answers = isRecord(response.answers) ? response.answers : {};
  const out: Record<string, JevCheckedAnswer> = {};
  for (const [id, spec] of Object.entries(specs)) {
    const a = answers[id];
    if (!isRecord(a)) return failAnswer(id, "missing-answer");
    if (enforceType && a.type !== undefined && a.type !== spec.type) return failAnswer(id, "type");
    const checked =
      spec.type === "choice" ? checkChoice(a, spec.options) : spec.type === "noul" ? checkNoul(a) : checkScore(a, spec.levels);
    if (checked instanceof Fault) return failAnswer(id, checked.reason);
    out[id] = checked;
  }
  return { ok: true, answers: out };
}

/** `questions` maps each question id to its option names. Every id must be answered. Choice only, and an answer's `type` is ignored; see checkJevAnswers. */
export function checkJevResponse(
  response: unknown,
  questions: Readonly<Record<string, readonly string[]>>,
  pin: string = JEV_PIN,
): JevCheck {
  const specs: Record<string, JevSpec> = {};
  for (const [id, options] of Object.entries(questions)) specs[id] = { type: "choice", options };
  const check = checkSpecs(response, specs, pin, false);
  if (!check.ok) {
    // Choice-only specs with the type check off can only fail with an original reason.
    const reason = JEV_REASONS.find((r) => r === check.reason);
    if (reason === undefined) throw new Error(`unreachable reason ${check.reason}`);
    return { ok: false, questionId: check.questionId, reason };
  }
  const answers: Record<string, JevChecked> = {};
  for (const [id, a] of Object.entries(check.answers)) {
    if (a.type === "choice") answers[id] = { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  }
  return { ok: true, answers };
}

function specsFail(questionId: string | null, reason: JevSpecsReason): JevSpecs {
  return { ok: false, questionId, reason };
}

/**
 * Derive specs from a request body's `questions`: choice from the criteria keys, noul needs no criteria,
 * score from the criteria array length (2..10). A question with no `type` is a choice, as before.
 */
export function specsFromRequest(body: unknown): JevSpecs {
  if (!isRecord(body)) return specsFail(null, "not-object");
  const questions = body.questions;
  if (!isRecord(questions) || Object.keys(questions).length === 0) return specsFail(null, "no-questions");
  const specs: Record<string, JevSpec> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (!isRecord(q)) return specsFail(id, "question");
    const type = q.type ?? "choice";
    if (type === "noul") {
      specs[id] = { type: "noul" };
    } else if (type === "choice") {
      if (!isRecord(q.criteria) || Object.keys(q.criteria).length === 0) return specsFail(id, "criteria");
      specs[id] = { type: "choice", options: Object.keys(q.criteria) };
    } else if (type === "score") {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      if (n < MIN_SCORE_LEVELS || n > MAX_SCORE_LEVELS) return specsFail(id, "criteria");
      specs[id] = { type: "score", levels: n };
    } else {
      return specsFail(id, "type");
    }
  }
  return { ok: true, specs };
}
