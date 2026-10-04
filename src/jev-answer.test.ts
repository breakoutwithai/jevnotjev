import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkJevResponse, JEV_PIN, JEV_REASONS, type JevCheck, type JevReason } from "./jev-answer.ts";

const Q: Record<string, readonly string[]> = { q1: ["answer", "hand_off"] };
const good = {
  model: "jev-1.13.0",
  answers: { q1: { choice: "hand_off", confidence: 0.91, probabilities: { answer: 0.09, hand_off: 0.91 } } },
};

function failure(check: JevCheck): { questionId: string | null; reason: JevReason } {
  if (check.ok) throw new Error("expected a failure");
  return { questionId: check.questionId, reason: check.reason };
}

describe("checkJevResponse", () => {
  test("[unit] JA-1 a pinned, well-formed answer passes and is returned per question", () => {
    const check = checkJevResponse(good, Q);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.answers.q1).toEqual({ choice: "hand_off", confidence: 0.91, probabilities: { answer: 0.09, hand_off: 0.91 } });
    expect(JEV_PIN).toBe("jev-1.13.0");
  });

  test("[unit] JA-1 confidence and probabilities are optional and come back as null", () => {
    const check = checkJevResponse({ model: "jev-1.13.0", answers: { q1: { choice: "answer" } } }, Q);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.answers.q1).toEqual({ choice: "answer", confidence: null, probabilities: null });
  });

  test("[unit] JA-2 not-object: a non-object response is refused", () => {
    expect(failure(checkJevResponse("x", Q))).toEqual({ questionId: null, reason: "not-object" });
    expect(failure(checkJevResponse(null, Q))).toEqual({ questionId: null, reason: "not-object" });
  });

  test("[unit] JA-2 model: a model other than the pin is refused, and the pin is overridable", () => {
    expect(failure(checkJevResponse({ ...good, model: "jev-1.12.0" }, Q))).toEqual({ questionId: null, reason: "model" });
    expect(checkJevResponse({ ...good, model: "jev-9" }, Q, "jev-9").ok).toBe(true);
  });

  test("[unit] JA-2 missing-answer: every question id needs an answer", () => {
    expect(failure(checkJevResponse({ model: "jev-1.13.0" }, Q))).toEqual({ questionId: "q1", reason: "missing-answer" });
    expect(failure(checkJevResponse(good, { ...Q, q2: ["x", "y"] }))).toEqual({ questionId: "q2", reason: "missing-answer" });
  });

  test("[unit] JA-2 choice: a choice outside the options is refused", () => {
    const r = { ...good, answers: { q1: { choice: "maybe" } } };
    expect(failure(checkJevResponse(r, Q))).toEqual({ questionId: "q1", reason: "choice" });
  });

  test("[unit] JA-2 confidence-range: confidence must be finite and within [0, 1]", () => {
    for (const confidence of [1.2, -0.1, Number.NaN, Number.POSITIVE_INFINITY, "0.5"]) {
      const r = { ...good, answers: { q1: { choice: "answer", confidence } } };
      expect(failure(checkJevResponse(r, Q))).toEqual({ questionId: "q1", reason: "confidence-range" });
    }
  });

  test("[unit] JA-2 keys: probability keys must equal the option set", () => {
    const r = { ...good, answers: { q1: { choice: "answer", probabilities: { answer: 0.5, other: 0.5 } } } };
    expect(failure(checkJevResponse(r, Q))).toEqual({ questionId: "q1", reason: "keys" });
    const short = { ...good, answers: { q1: { choice: "answer", probabilities: { answer: 1 } } } };
    expect(failure(checkJevResponse(short, Q))).toEqual({ questionId: "q1", reason: "keys" });
  });

  test("[unit] JA-2 prob-range: each probability must be finite and within [0, 1]", () => {
    const r = { ...good, answers: { q1: { choice: "answer", probabilities: { answer: 1.2, hand_off: -0.2 } } } };
    expect(failure(checkJevResponse(r, Q))).toEqual({ questionId: "q1", reason: "prob-range" });
  });

  test("[unit] JA-2 mass: probabilities must sum to 1 within 0.02", () => {
    const off = { ...good, answers: { q1: { choice: "answer", probabilities: { answer: 0.6, hand_off: 0.5 } } } };
    expect(failure(checkJevResponse(off, Q))).toEqual({ questionId: "q1", reason: "mass" });
    const near = { ...good, answers: { q1: { choice: "answer", probabilities: { answer: 0.6, hand_off: 0.41 } } } };
    expect(checkJevResponse(near, Q).ok).toBe(true);
  });

  test("[unit] JA-2 argmax: the choice must hold the largest probability", () => {
    const r = { ...good, answers: { q1: { choice: "answer", probabilities: { answer: 0.3, hand_off: 0.7 } } } };
    expect(failure(checkJevResponse(r, Q))).toEqual({ questionId: "q1", reason: "argmax" });
  });

  test("[unit] JA-3 several questions: each is checked and the failing id is named", () => {
    const Q2: Record<string, readonly string[]> = { q1: ["a", "b"], q2: ["x", "y"] };
    const r = {
      model: "jev-1.13.0",
      answers: { q1: { choice: "a" }, q2: { choice: "y", probabilities: { x: 0.9, y: 0.1 } } },
    };
    expect(failure(checkJevResponse(r, Q2))).toEqual({ questionId: "q2", reason: "argmax" });
    const ok = checkJevResponse({ ...r, answers: { ...r.answers, q2: { choice: "x" } } }, Q2);
    expect(ok.ok && Object.keys(ok.answers)).toEqual(["q1", "q2"]);
  });
});

describe("shared vectors", () => {
  const raw: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("./jev-answer.vectors.json", import.meta.url)), "utf8"));

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  test("[unit] JA-4 every vector in jev-answer.vectors.json gives its expected outcome", () => {
    if (!Array.isArray(raw)) throw new Error("vectors must be an array");
    expect(raw.length).toBeGreaterThanOrEqual(JEV_REASONS.length);
    const seen = new Set<string>();
    for (const v of raw) {
      if (!isRecord(v) || typeof v.name !== "string" || !isRecord(v.questions) || !isRecord(v.expect)) {
        throw new Error("malformed vector");
      }
      const questions: Record<string, string[]> = {};
      for (const [id, opts] of Object.entries(v.questions)) {
        if (!Array.isArray(opts) || !opts.every((o): o is string => typeof o === "string")) throw new Error(`${v.name}: bad options`);
        questions[id] = opts;
      }
      const check = checkJevResponse(v.response, questions);
      if (v.expect.ok === true) {
        expect(check.ok, v.name).toBe(true);
      } else {
        const { questionId, reason } = v.expect;
        if ((typeof questionId !== "string" && questionId !== null) || typeof reason !== "string") {
          throw new Error(`${v.name}: malformed expectation`);
        }
        const got = failure(check);
        expect(got.questionId, v.name).toBe(questionId);
        expect(String(got.reason), v.name).toBe(reason);
        seen.add(reason);
      }
    }
    expect([...seen].sort()).toEqual([...JEV_REASONS].sort());
  });
});

test("[unit] JA-1 prototype-named choices retain probabilities", () => {
  const probabilities = Object.fromEntries([["__proto__", 0.8], ["other", 0.2]]);
  const checked = checkJevResponse({model:JEV_PIN,answers:{q1:{choice:"__proto__",probabilities}}}, {q1:["__proto__","other"]});
  expect(checked.ok).toBe(true);
  if(checked.ok)expect(checked.answers.q1?.probabilities).toEqual(probabilities);
});
