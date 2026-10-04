/**
 * One shared check for a TypeSafe Jev systemone response. Pure: no network, no I/O.
 * Clients import it by path; the cases in jev-answer.vectors.json are the shared test set.
 */

export const JEV_PIN = "jev-1.13.0";

export type JevReason =
  | "not-object" | "model" | "missing-answer" | "choice" | "confidence-range" | "keys" | "prob-range" | "mass" | "argmax";

export const JEV_REASONS: readonly JevReason[] = [
  "not-object", "model", "missing-answer", "choice", "confidence-range", "keys", "prob-range", "mass", "argmax",
];

export interface JevChecked {
  readonly choice: string;
  readonly confidence: number | null;
  readonly probabilities: Readonly<Record<string, number>> | null;
}

export type JevCheck =
  | { readonly ok: true; readonly answers: Readonly<Record<string, JevChecked>> }
  | { readonly ok: false; readonly questionId: string | null; readonly reason: JevReason };

const MASS_TOLERANCE = 0.02;
const ARGMAX_TOLERANCE = 1e-9;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(questionId: string | null, reason: JevReason): JevCheck {
  return { ok: false, questionId, reason };
}

function inUnitRange(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** `questions` maps each question id to its option names. Every id must be answered. */
export function checkJevResponse(
  response: unknown,
  questions: Readonly<Record<string, readonly string[]>>,
  pin: string = JEV_PIN,
): JevCheck {
  if (!isRecord(response)) return fail(null, "not-object");
  if (response.model !== pin) return fail(null, "model");
  const answers = isRecord(response.answers) ? response.answers : {};
  const out: Record<string, JevChecked> = {};
  for (const [id, options] of Object.entries(questions)) {
    const a = answers[id];
    if (!isRecord(a)) return fail(id, "missing-answer");
    const choice = a.choice;
    if (typeof choice !== "string" || !options.includes(choice)) return fail(id, "choice");
    const rawConfidence = a.confidence;
    let confidence: number | null = null;
    if (rawConfidence !== undefined && rawConfidence !== null) {
      if (!inUnitRange(rawConfidence)) return fail(id, "confidence-range");
      confidence = rawConfidence;
    }
    const rawProbs = a.probabilities;
    let probabilities: Record<string, number> | null = null;
    if (rawProbs !== undefined && rawProbs !== null) {
      if (!isRecord(rawProbs)) return fail(id, "keys");
      const keys = Object.keys(rawProbs);
      if (keys.length !== options.length || !options.every((o) => Object.hasOwn(rawProbs, o))) return fail(id, "keys");
      const probs: Record<string, number> = {};
      for (const k of keys) {
        const v = rawProbs[k];
        if (!inUnitRange(v)) return fail(id, "prob-range");
        Object.defineProperty(probs, k, { value: v, enumerable: true });
      }
      const values = Object.values(probs);
      if (Math.abs(values.reduce((s, v) => s + v, 0) - 1) > MASS_TOLERANCE) return fail(id, "mass");
      if ((probs[choice] ?? 0) < Math.max(...values) - ARGMAX_TOLERANCE) return fail(id, "argmax");
      probabilities = probs;
    }
    out[id] = { choice, confidence, probabilities };
  }
  return { ok: true, answers: out };
}
