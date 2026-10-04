import type { AnswerRequest } from "./contracts.ts";
import { test, expect } from "bun:test";
import { MODEL_CATALOG, CATALOG_VERSION, getModelEntry } from "./catalog.ts";
import { requestFingerprint } from "./fingerprint.ts";
import { copyPrompt } from "./prompt.ts";
test("[unit] JF1 dated catalog pins distinct models and freezes generation controls", async () => {
  expect(new Set(MODEL_CATALOG.map((m) => m.id)).size).toBe(
    MODEL_CATALOG.length,
  );
  for (const entry of MODEL_CATALOG) {
    expect(entry.catalogVersion).toBe(CATALOG_VERSION);
    expect(Object.isFrozen(entry.parameters)).toBe(true);
    expect(entry.acceptedResponseModelIds).toContain(entry.modelId);
  }
  const entry = getModelEntry("gpt-6.1-sol");
  if (!entry) throw new Error("missing");
  const request: Pick<
    AnswerRequest,
    | "question"
    | "choices"
    | "input"
    | "provider"
    | "modelId"
    | "armId"
    | "promptVersion"
    | "catalogVersion"
  > = {
    question: "Keep?",
    choices: [
      { name: "yes", definition: "good" },
      { name: "no", definition: "bad" },
    ],
    input: "case",
    provider: entry.provider,
    modelId: entry.modelId,
    armId: entry.id,
    promptVersion: "1",
    catalogVersion: CATALOG_VERSION,
  };
  const before = await requestFingerprint(request);
  expect(await requestFingerprint({ ...request, promptVersion: "2" })).not.toBe(
    before,
  );
  expect(
    await requestFingerprint(request, {
      ...entry,
      parameters: { ...entry.parameters, maxOutputTokens: 128 },
    }),
  ).not.toBe(before);
});
test("[unit] JF5 copy prompt preserves exact question choices and case", () => {
  const choices: readonly [
    { name: string; definition: string },
    { name: string; definition: string },
  ] = [
    { name: "yes", definition: "good" },
    { name: "no", definition: "bad" },
  ];
  expect(copyPrompt({ question: "Keep?", choices }, "exact case")).toContain(
    '"case":"exact case"',
  );
});
