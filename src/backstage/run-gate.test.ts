import { expect, test } from "bun:test";
import { getModelEntry, JEV_ARM_ID } from "./catalog.ts";
import { copyPrompt } from "./prompt.ts";
import { estimateRange, estimateSpend, formatUsd, runBlockers } from "./run-gate.ts";

const scene = {
  question: "Does this message ask for a refund?",
  choices: [
    { name: "yes", definition: "Asks for money back" },
    { name: "no", definition: "Anything else" },
  ],
  cases: [
    { id: "case-1", input: "Please refund my mug" },
    { id: "case-2", input: "Where is my parcel?" },
  ],
} as const;

test("[unit] UX-C01 no cases and no Jev key name both reasons", () => {
  expect(runBlockers({ caseCount: 0, armIds: [JEV_ARM_ID], keys: {} })).toEqual([
    "Add at least one case.",
    "Add your TypeSafe API key on Casting.",
  ]);
});

test("[unit] UX-C01 a case and a Jev key leave nothing blocking a Jev-only run", () => {
  expect(runBlockers({ caseCount: 1, armIds: [JEV_ARM_ID], keys: { jev: "jev-key-value" } })).toEqual([]);
});

test("[unit] UX-C01 a ticked model without its provider key blocks the run, the local rule needs none", () => {
  const blockers = runBlockers({
    caseCount: 2,
    armIds: [JEV_ARM_ID, "gpt-6-luna", "gpt-6.1-sol", "rule"],
    keys: { jev: "jev-key-value", openai: "   " },
  });
  expect(blockers).toEqual(["Add your OpenAI API key on Casting, or untick its models."]);
  expect(
    runBlockers({
      caseCount: 2,
      armIds: [JEV_ARM_ID, "gpt-6-luna", "rule"],
      keys: { jev: "jev-key-value", openai: "sk-value" },
    }),
  ).toEqual([]);
});

test("[unit] UX-C01 the estimate is a range from catalog prices, one call per case and priced model", () => {
  const estimate = estimateSpend(scene, [JEV_ARM_ID, "gpt-6-luna", "rule"]);
  expect(estimate.calls).toBe(4);
  expect(estimate.unpriced).toEqual([]);
  const jev = getModelEntry(JEV_ARM_ID)?.pricing;
  const luna = getModelEntry("gpt-6-luna");
  if (!jev || !luna?.pricing) throw new Error("catalog prices missing");
  let low = 0;
  let high = 0;
  for (const item of scene.cases) {
    const bytes = new TextEncoder().encode(copyPrompt(scene, item.input)).length;
    low += ((bytes / 4) * jev.inputUsdPerMillion + jev.outputUsdPerMillion) / 1e6;
    high += (bytes * jev.inputUsdPerMillion) / 1e6;
    low += ((bytes / 4) * luna.pricing.inputUsdPerMillion + luna.pricing.outputUsdPerMillion) / 1e6;
    high += (bytes * luna.pricing.inputUsdPerMillion + luna.parameters.maxOutputTokens * luna.pricing.outputUsdPerMillion) / 1e6;
  }
  expect(estimate.lowUsd).toBeCloseTo(low, 12);
  expect(estimate.highUsd).toBeCloseTo(high, 12);
  expect(estimate.lowUsd).toBeLessThan(estimate.highUsd);
});

test("[unit] UX-C01 a model with no catalog price is named as price unknown and left out of the money range", () => {
  const withGemini = estimateSpend(scene, [JEV_ARM_ID, "gemini-3.8-flash"]);
  const jevOnly = estimateSpend(scene, [JEV_ARM_ID]);
  expect(withGemini.unpriced).toEqual(["Gemini 3.8 Flash"]);
  expect(withGemini.calls).toBe(4);
  expect(withGemini.lowUsd).toBe(jevOnly.lowUsd);
  expect(withGemini.highUsd).toBe(jevOnly.highUsd);
});

test("[unit] UX-C01 money is shown in plain decimals, never exponent form", () => {
  expect(formatUsd(0)).toBe("$0");
  expect(formatUsd(0.0000042)).toBe("$0.0000042");
  expect(formatUsd(0.00000004)).toBe("$0.000000040");
  expect(formatUsd(0.00123)).toBe("$0.0012");
  expect(formatUsd(1.234)).toBe("$1.2");
  expect(formatUsd(12.4)).toBe("$12");
  expect(estimateRange({ calls: 1, lowUsd: 0.001, highUsd: 0.02, unpriced: [] })).toBe("estimated $0.0010 to $0.020");
  expect(estimateRange({ calls: 1, lowUsd: 0.0101, highUsd: 0.0102, unpriced: [] })).toBe("estimated $0.010");
});
