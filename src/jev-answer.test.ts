import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkJevAnswers, checkJevResponse, JEV_ANSWER_REASONS, JEV_PIN, JEV_REASONS, specsFromRequest,
  type JevAnswerReason, type JevAnswersCheck, type JevCheck, type JevSpec,
} from "./jev-answer.ts";

const Q: Record<string, readonly string[]> = { q1: ["answer", "hand_off"] };
const good = {
  model: "jev-1.13.0",
  answers: { q1: { choice: "hand_off", confidence: 0.91, probabilities: { answer: 0.09, hand_off: 0.91 } } },
};

function failure(check: JevCheck | JevAnswersCheck): { questionId: string | null; reason: JevAnswerReason } {
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
  const load = (file: string): unknown[] => {
    const raw: unknown = JSON.parse(readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"));
    if (!Array.isArray(raw)) throw new Error(`${file} must be an array`);
    return raw;
  };
  const shared = load("./jev-answer.vectors.json");
  const typed = load("./jev-answer.typed-vectors.json");

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  function isOptions(v: unknown): v is string[] {
    return Array.isArray(v) && v.every((o): o is string => typeof o === "string");
  }

  function parseQuestions(name: string, questions: unknown): Record<string, string[]> {
    if (!isRecord(questions)) throw new Error(`${name}: bad questions`);
    const out: Record<string, string[]> = {};
    for (const [id, opts] of Object.entries(questions)) {
      if (!isOptions(opts)) throw new Error(`${name}: bad options`);
      out[id] = opts;
    }
    return out;
  }

  function parseSpecs(name: string, specs: unknown): Record<string, JevSpec> {
    if (!isRecord(specs)) throw new Error(`${name}: bad specs`);
    const out: Record<string, JevSpec> = {};
    for (const [id, spec] of Object.entries(specs)) {
      if (!isRecord(spec)) throw new Error(`${name}: bad spec`);
      if (spec.type === "noul") out[id] = { type: "noul" };
      else if (spec.type === "score" && typeof spec.levels === "number") out[id] = { type: "score", levels: spec.levels };
      else if (spec.type === "choice" && isOptions(spec.options)) out[id] = { type: "choice", options: spec.options };
      else throw new Error(`${name}: bad spec`);
    }
    return out;
  }

  /** Runs every vector through `run`, asserts its expectation, and returns the failure reasons seen. */
  function runVectors(vectors: unknown[], run: (v: Record<string, unknown>, name: string) => JevCheck | JevAnswersCheck): Set<string> {
    const seen = new Set<string>();
    for (const v of vectors) {
      if (!isRecord(v) || typeof v.name !== "string" || !isRecord(v.expect)) throw new Error("malformed vector");
      const check = run(v, v.name);
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
    return seen;
  }

  test("[unit] JA-4 every shared vector gives its expected outcome through checkJevResponse and covers every JevReason", () => {
    expect(shared.length).toBeGreaterThanOrEqual(JEV_REASONS.length);
    const seen = runVectors(shared, (v, name) => checkJevResponse(v.response, parseQuestions(name, v.questions)));
    expect([...seen].sort()).toEqual([...JEV_REASONS].sort());
  });

  test("[unit] JA-4 every typed vector gives its expected outcome through checkJevAnswers and the union covers every JevAnswerReason", () => {
    const seenTyped = runVectors(typed, (v, name) => checkJevAnswers(v.response, parseSpecs(name, v.specs)));
    const seenShared = runVectors(shared, (v, name) => checkJevAnswers(v.response, Object.fromEntries(
      Object.entries(parseQuestions(name, v.questions)).map(([id, options]): [string, JevSpec] => [id, { type: "choice", options }]),
    )));
    expect([...new Set([...seenTyped, ...seenShared])].sort()).toEqual([...JEV_ANSWER_REASONS].sort());
  });

  // External consumers (see the header of jev-answer.ts) parse every entry of the shared file.
  test("[unit] JA-7 contract: every entry of jev-answer.vectors.json is choice-shaped, with no specs key", () => {
    for (const [i, v] of shared.entries()) {
      if (!isRecord(v)) throw new Error(`entry ${i} is not an object`);
      expect(typeof v.name, `entry ${i} name`).toBe("string");
      expect(isRecord(v.questions), `entry ${i} questions`).toBe(true);
      parseQuestions(String(v.name), v.questions);
      expect(isRecord(v.expect), `entry ${i} expect`).toBe(true);
      expect(Object.hasOwn(v, "specs"), `entry ${i} must not carry specs`).toBe(false);
    }
    for (const [i, v] of typed.entries()) {
      expect(isRecord(v) && Object.hasOwn(v, "specs"), `typed entry ${i} specs`).toBe(true);
    }
  });
});

test("[unit] JA-1 prototype-named choices retain probabilities", () => {
  const probabilities = Object.fromEntries([["__proto__", 0.8], ["other", 0.2]]);
  const checked = checkJevResponse({model:JEV_PIN,answers:{q1:{choice:"__proto__",probabilities}}}, {q1:["__proto__","other"]});
  expect(checked.ok).toBe(true);
  if(checked.ok)expect(checked.answers.q1?.probabilities).toEqual(probabilities);
});

const noulLive = { model: JEV_PIN, answers: { is_urgent: { type: "noul", noul: 0.95 } } };
const scoreLive = {
  model: JEV_PIN,
  answers: {
    frustration: {
      type: "score", score: 1.04, confidence: 0.94,
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "0": 0.0, "1": 0.96, "2": 0.04 },
    },
  },
};

describe("checkJevAnswers", () => {
  test("[unit] JA-5 a live noul answer comes back typed with its value", () => {
    const check = checkJevAnswers(noulLive, { is_urgent: { type: "noul" } });
    expect(check.ok && check.answers.is_urgent).toEqual({ type: "noul", noul: 0.95 });
  });

  test("[unit] JA-5 a live score answer comes back typed with score, legend and probabilities", () => {
    const check = checkJevAnswers(scoreLive, { frustration: { type: "score", levels: 3 } });
    expect(check.ok && check.answers.frustration).toEqual({
      type: "score", score: 1.04, confidence: 0.94,
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "0": 0.0, "1": 0.96, "2": 0.04 },
    });
  });

  test("[unit] JA-5 a score answer without confidence, legend or probabilities passes with nulls", () => {
    const check = checkJevAnswers({ model: JEV_PIN, answers: { s: { score: 0 } } }, { s: { type: "score", levels: 2 } });
    expect(check.ok && check.answers.s).toEqual({ type: "score", score: 0, confidence: null, legend: null, probabilities: null });
  });

  test("[unit] JA-5 a choice answer through checkJevAnswers carries type choice", () => {
    const check = checkJevAnswers(good, { q1: { type: "choice", options: ["answer", "hand_off"] } });
    expect(check.ok && check.answers.q1).toEqual({ type: "choice", choice: "hand_off", confidence: 0.91, probabilities: { answer: 0.09, hand_off: 0.91 } });
  });

  test("[unit] JA-5 a type that disagrees with the spec is refused with reason type", () => {
    expect(failure(checkJevAnswers(noulLive, { is_urgent: { type: "score", levels: 3 } }))).toEqual({ questionId: "is_urgent", reason: "type" });
  });

  test("[unit] JA-5 JEV_REASONS is exactly the original nine and JEV_ANSWER_REASONS extends it", () => {
    expect([...JEV_REASONS]).toEqual([
      "not-object", "model", "missing-answer", "choice", "confidence-range", "keys", "prob-range", "mass", "argmax",
    ]);
    expect([...JEV_ANSWER_REASONS]).toEqual([...JEV_REASONS, "type", "noul-range", "score-range", "legend"]);
  });

  test("[unit] JA-5 a choice answer carrying type noul: checkJevResponse ignores type, checkJevAnswers refuses it", () => {
    const r = { model: JEV_PIN, answers: { q1: { type: "noul", choice: "answer" } } };
    expect(checkJevResponse(r, Q).ok).toBe(true);
    expect(failure(checkJevAnswers(r, { q1: { type: "choice", options: ["answer", "hand_off"] } }))).toEqual({ questionId: "q1", reason: "type" });
  });

  test("[unit] JA-5 checkJevResponse still returns the untyped choice shape", () => {
    const withType = { model: JEV_PIN, answers: { q1: { type: "choice", choice: "answer" } } };
    const check = checkJevResponse(withType, Q);
    expect(check.ok && check.answers.q1).toEqual({ choice: "answer", confidence: null, probabilities: null });
  });
});

describe("specsFromRequest", () => {
  const mixed = {
    state: "Help! My payouts have been failing for 3 days.",
    model: JEV_PIN,
    questions: {
      department: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: null } },
      is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
      frustration: { type: "score", instructions: "How frustrated?", criteria: ["Calm", "Frustrated", "Very angry"] },
    },
  };

  test("[unit] JA-6 a mixed three-question body gives one spec per type", () => {
    const r = specsFromRequest(mixed);
    expect(r.ok && r.specs).toEqual({
      department: { type: "choice", options: ["billing", "technical"] },
      is_urgent: { type: "noul" },
      frustration: { type: "score", levels: 3 },
    });
  });

  test("[unit] JA-6 the specs from a request validate the live responses that answer it", () => {
    const r = specsFromRequest(mixed);
    if (!r.ok) throw new Error("expected specs");
    const response = {
      model: JEV_PIN,
      answers: { department: { type: "choice", choice: "billing" }, ...noulLive.answers, ...scoreLive.answers },
    };
    expect(checkJevAnswers(response, r.specs).ok).toBe(true);
  });

  test("[unit] JA-6 a noul question needs no criteria and a question with no type is a choice", () => {
    const r = specsFromRequest({ questions: { a: { type: "noul" }, b: { criteria: { x: "", y: "" } } } });
    expect(r.ok && r.specs).toEqual({ a: { type: "noul" }, b: { type: "choice", options: ["x", "y"] } });
  });

  test("[unit] JA-6 malformed bodies return a typed error", () => {
    const err = (b: unknown) => { const r = specsFromRequest(b); return r.ok ? null : { questionId: r.questionId, reason: r.reason }; };
    expect(err("x")).toEqual({ questionId: null, reason: "not-object" });
    expect(err({})).toEqual({ questionId: null, reason: "no-questions" });
    expect(err({ questions: {} })).toEqual({ questionId: null, reason: "no-questions" });
    expect(err({ questions: { q: 3 } })).toEqual({ questionId: "q", reason: "question" });
    expect(err({ questions: { q: { type: "rank" } } })).toEqual({ questionId: "q", reason: "type" });
    expect(err({ questions: { q: { type: "choice" } } })).toEqual({ questionId: "q", reason: "criteria" });
    expect(err({ questions: { q: { type: "choice", criteria: {} } } })).toEqual({ questionId: "q", reason: "criteria" });
    expect(err({ questions: { q: { type: "score", criteria: ["only"] } } })).toEqual({ questionId: "q", reason: "criteria" });
    expect(err({ questions: { q: { type: "score", criteria: { 0: "a", 1: "b" } } } })).toEqual({ questionId: "q", reason: "criteria" });
    expect(err({ questions: { q: { type: "score", criteria: Array.from({ length: 11 }, String) } } })).toEqual({ questionId: "q", reason: "criteria" });
  });
});
