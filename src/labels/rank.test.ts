// Ranking Jev's options for the blind-then-suggest labelling loop (labelling loop M2).
import { describe, expect, test } from "bun:test";
import { rankJevOptions, topSuggestion } from "./rank.ts";

describe("rankJevOptions", () => {
  test("[unit] M2 orders options by Jev's probability, highest first", () => {
    const ranking = rankJevOptions(["low", "mid", "high"], {
      choice: "high",
      confidence: 0.7,
      probabilities: { low: 0.1, mid: 0.2, high: 0.7 },
    });
    expect(ranking.ranked).toBe(true);
    expect(ranking.options.map((o) => [o.option, o.rank, o.probability, o.jevChoice])).toEqual([
      ["high", 1, 0.7, true],
      ["mid", 2, 0.2, false],
      ["low", 3, 0.1, false],
    ]);
  });

  test("[unit] M2 breaks equal probabilities by answer-set order", () => {
    const ranking = rankJevOptions(["a", "b", "c"], {
      choice: "c",
      confidence: null,
      probabilities: { a: 0.25, b: 0.25, c: 0.5 },
    });
    expect(ranking.options.map((o) => o.option)).toEqual(["c", "a", "b"]);
    const reversed = rankJevOptions(["b", "a", "c"], {
      choice: "c",
      confidence: null,
      probabilities: { a: 0.25, b: 0.25, c: 0.5 },
    });
    expect(reversed.options.map((o) => o.option)).toEqual(["c", "b", "a"]);
  });

  test("[unit] M2 a tie at the top keeps answer-set order, and the top suggestion is the first ranked option", () => {
    const ranking = rankJevOptions(["answer", "hand_off"], {
      choice: "hand_off",
      confidence: 0.5,
      probabilities: { answer: 0.5, hand_off: 0.5 },
    });
    expect(ranking.options.map((o) => o.option)).toEqual(["answer", "hand_off"]);
    expect(ranking.options.map((o) => o.rank)).toEqual([1, 2]);
    expect(topSuggestion(ranking)).toBe("answer");
  });

  test("[unit] M2 missing probabilities: Jev's choice first, the rest unranked in answer-set order", () => {
    const ranking = rankJevOptions(["a", "b", "c"], { choice: "b", confidence: 0.8, probabilities: null });
    expect(ranking.ranked).toBe(false);
    expect(ranking.options.map((o) => [o.option, o.rank, o.probability, o.jevChoice])).toEqual([
      ["b", 1, null, true],
      ["a", null, null, false],
      ["c", null, null, false],
    ]);
    expect(topSuggestion(ranking)).toBe("b");
  });

  test("[unit] M2 probabilities that do not cover exactly the answer set are treated as missing", () => {
    const partial = rankJevOptions(["a", "b", "c"], { choice: "a", confidence: null, probabilities: { a: 0.6, b: 0.4 } });
    expect(partial.ranked).toBe(false);
    expect(partial.options.map((o) => o.option)).toEqual(["a", "b", "c"]);
    const extra = rankJevOptions(["a", "b"], { choice: "a", confidence: null, probabilities: { a: 0.6, b: 0.3, z: 0.1 } });
    expect(extra.ranked).toBe(false);
  });

  test("[unit] M2 a non-finite or out-of-range probability is treated as missing", () => {
    for (const bad of [Number.NaN, -0.1, 1.5, Number.POSITIVE_INFINITY]) {
      const ranking = rankJevOptions(["a", "b"], { choice: "b", confidence: null, probabilities: { a: bad, b: 0.5 } });
      expect(ranking.ranked).toBe(false);
      expect(ranking.options[0]?.option).toBe("b");
    }
  });

  test("[unit] M2 a choice outside the answer set is refused, never ranked", () => {
    expect(() => rankJevOptions(["a", "b"], { choice: "c", confidence: null, probabilities: null })).toThrow("not in the answer set");
  });

  test("[unit] M2 an answer set with a repeated option is refused", () => {
    expect(() => rankJevOptions(["a", "a"], { choice: "a", confidence: null, probabilities: null })).toThrow("repeats");
  });

  test("[unit] M2 the input is not mutated and the confidence is carried through", () => {
    const answer = { choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } };
    const options = ["b", "a"];
    const ranking = rankJevOptions(options, answer);
    expect(options).toEqual(["b", "a"]);
    expect(answer.probabilities).toEqual({ a: 0.9, b: 0.1 });
    expect(ranking.confidence).toBe(0.9);
  });
});
