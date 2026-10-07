// Where a labeller's Jev suggestion comes from, and what it costs (labelling loop M2, metric m4):
// a recorded Jev arm output costs 0 calls; with none recorded, at most 1 call per case and only on the labeller's own key.
import { describe, expect, test } from "bun:test";
import { SuggestionBook, callsForPick, suggestionPlan, type JevSuggestionClient } from "./suggest.ts";
import type { JevSuggestion } from "./rank.ts";

const RECORDED: JevSuggestion = { choice: "hand_off", confidence: 0.9, probabilities: { answer: 0.1, hand_off: 0.9 } };

function countingClient(answer: JevSuggestion | null = RECORDED): { client: JevSuggestionClient; calls: { caseId: string; key: string }[] } {
  const calls: { caseId: string; key: string }[] = [];
  return {
    calls,
    client: {
      ask: async (caseId, key) => {
        calls.push({ caseId, key });
        return answer;
      },
    },
  };
}

describe("suggestionPlan", () => {
  test("[unit] M2 m4 a recorded Jev output is reused; with none, the labeller's key is called; without a key, no suggestion", () => {
    expect(suggestionPlan(RECORDED, "lab-key")).toBe("recorded");
    expect(suggestionPlan(RECORDED, null)).toBe("recorded");
    expect(suggestionPlan(null, "lab-key")).toBe("call");
    expect(suggestionPlan(null, null)).toBe("none");
    expect(suggestionPlan(null, "   ")).toBe("none");
  });
});

describe("SuggestionBook", () => {
  test("[unit] M2 m4 suggestion uses the recorded Jev arm output when present: 0 calls", async () => {
    const { client, calls } = countingClient();
    const book = new SuggestionBook(client);
    const first = await book.get("m01", RECORDED, "lab-key");
    const again = await book.get("m01", RECORDED, "lab-key");
    expect(calls).toEqual([]);
    expect(first).toEqual({ kind: "recorded", answer: RECORDED });
    expect(again).toEqual(first);
  });

  test("[unit] M2 m4 with no recorded output, one call per case on the labeller's key, however often it is asked", async () => {
    const { client, calls } = countingClient();
    const book = new SuggestionBook(client);
    const results = await Promise.all([book.get("m02", null, "lab-key"), book.get("m02", null, "lab-key")]);
    const later = await book.get("m02", null, "lab-key");
    await book.get("m03", null, "lab-key");
    expect(calls).toEqual([
      { caseId: "m02", key: "lab-key" },
      { caseId: "m03", key: "lab-key" },
    ]);
    expect(results[0]).toEqual({ kind: "called", answer: RECORDED });
    expect(results[1]).toEqual(results[0]);
    expect(later).toEqual(results[0]);
  });

  test("[unit] M2 m4 with no recorded output and no key: no call, 'no suggestion yet'", async () => {
    const { client, calls } = countingClient();
    const book = new SuggestionBook(client);
    expect(await book.get("m04", null, null)).toEqual({ kind: "none", reason: "no-key" });
    expect(await book.get("m04", null, "")).toEqual({ kind: "none", reason: "no-key" });
    expect(calls).toEqual([]);
  });

  test("[unit] M2 m4 a failed or empty call is not retried for that case", async () => {
    let failures = 0;
    const failing: JevSuggestionClient = {
      ask: async () => {
        failures += 1;
        throw new Error("network");
      },
    };
    const book = new SuggestionBook(failing);
    expect(await book.get("m05", null, "lab-key")).toEqual({ kind: "none", reason: "call-failed" });
    expect(await book.get("m05", null, "lab-key")).toEqual({ kind: "none", reason: "call-failed" });
    expect(failures).toBe(1);
    const { client, calls } = countingClient(null);
    const empty = new SuggestionBook(client);
    expect(await empty.get("m06", null, "lab-key")).toEqual({ kind: "none", reason: "call-failed" });
    expect(await empty.get("m06", null, "lab-key")).toEqual({ kind: "none", reason: "call-failed" });
    expect(calls.length).toBe(1);
  });

  test("[unit] M2 m4 a suggestion is never a label: the book holds no label API", () => {
    const { client } = countingClient();
    const book = new SuggestionBook(client);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(book)).filter((name) => /label/i.test(name))).toEqual([]);
  });
});

describe("callsForPick", () => {
  test("[unit] M2 the blind pick sets label, the final pick sets label_final, per answer", () => {
    expect(callsForPick("hand_off", { blind: "hand_off", final: "answer", suggestionShown: true })).toEqual({
      label: "accept",
      labelFinal: "reject",
      suggestionShown: true,
    });
    expect(callsForPick("answer", { blind: "hand_off", final: "answer", suggestionShown: true })).toEqual({
      label: "reject",
      labelFinal: "accept",
      suggestionShown: true,
    });
  });

  test("[unit] M2 no final pick yet leaves label_final and suggestion_shown empty", () => {
    expect(callsForPick("answer", { blind: "answer", final: null, suggestionShown: null })).toEqual({
      label: "accept",
      labelFinal: null,
      suggestionShown: null,
    });
  });

  test("[unit] M2 unsure records no label and no final pick", () => {
    expect(callsForPick("answer", { blind: null, final: null, suggestionShown: null })).toEqual({
      label: null,
      labelFinal: null,
      suggestionShown: null,
    });
  });

  test("[unit] M2 a final pick without a blind pick is refused", () => {
    expect(() => callsForPick("answer", { blind: null, final: "answer", suggestionShown: true })).toThrow("blind pick");
  });

  test("[unit] M2 a final pick and the suggestion-shown flag come together or not at all", () => {
    expect(() => callsForPick("answer", { blind: "answer", final: "answer", suggestionShown: null })).toThrow("suggestion was shown");
    expect(() => callsForPick("answer", { blind: "answer", final: null, suggestionShown: false })).toThrow("suggestion was shown");
  });
});
