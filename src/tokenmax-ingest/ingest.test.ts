import { describe, expect, test } from "bun:test";
import { ingestDraft, samples } from "./ingest.ts";

describe("TokenMax paste ingestion", () => {
  test("[integration] TM-I1 all three synthetic samples follow the same validation and map path", () => {
    for (const sample of samples()) {
      const result = ingestDraft(sample.text);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.publication).toBe("synthetic-excluded");
        expect(result.platform).toBe("pending");
        expect(result.value.synthetic).toBe(true);
        expect(result.map?.v).toBe("tm-share/1");
      }
    }
  });
  test("[unit] TM-I2 unknown fields and planted identifiers are rejected without losing the draft", () => {
    const sample = samples()[0];
    expect(sample).toBeDefined();
    if (!sample) return;
    const original: unknown = JSON.parse(sample.text);
    const draft = JSON.stringify({ ...Object(original), privatePath: ["", "Users", "SecretCanary", "client"].join("/") });
    const result = ingestDraft(draft);
    expect(result.ok).toBe(false);
    expect(result.draft).toBe(draft);
  });
  test("[unit] TM-I3 rejects unsafe numeric values, inconsistent totals and unsupported versions", () => {
    const sample = samples()[0];
    if (!sample) throw new Error("sample missing");
    for (const [from, to] of [
      ['"sessions": 8', '"sessions": -1'],
      ['"v": "tm-collection/1"', '"v": "tm-collection/9"'],
      ['"output": 24000', '"output": 24001'],
      ['"must_deliver": 1', '"must_deliver": 999'],
    ]) {
      if (from === undefined || to === undefined) throw new Error("mutation missing");
      expect(sample.text.includes(from)).toBe(true);
      expect(ingestDraft(sample.text.replace(from, to)).ok).toBe(false);
    }
  });
  test("[unit] TM-I4 malformed and oversize drafts are recoverable and never publish", () => {
    for (const draft of ["{", "x".repeat(16385)]) {
      const result = ingestDraft(draft);
      expect(result.ok).toBe(false);
      expect(result.draft).toBe(draft);
      expect(result.publication).toBe("blocked");
    }
  });
  test("[unit] TM-I5 real aggregates remain unpublished; local Jev does not imply platform verification", () => {
    const sample = samples()[0];
    if (!sample) throw new Error("sample missing");
    const result = ingestDraft(sample.text.replace('"synthetic": true', '"synthetic": false'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publication).toBe("not-published");
      expect(result.platform).toBe("pending");
    }
  });
});

test("[integration] TM-I6 platform checks receive only validated aggregates and preserve draft on failure", async () => {
  const { ingestPipeline } = await import("./ingest.ts");
  const sample = samples()[0];
  if (!sample) throw new Error("sample missing");
  let calls = 0;
  const checks = { check: async () => { calls++; return { status: "rejected", reason: "private" }; } };
  const invalid = await ingestPipeline('{"private":"secret"}', { checks: { check: async () => { calls++; throw new Error("should not run"); } } });
  expect(invalid.ok).toBe(false);
  expect(calls).toBe(0);
  const rejected = await ingestPipeline(sample.text, { checks: { check: async () => { calls++; return { status: "rejected", reason: "private" }; } } });
  expect(rejected.ok).toBe(false);
  expect(rejected.draft).toBe(sample.text);
  expect(calls).toBe(1);
  const stages: string[] = [];
  const accepted = await ingestPipeline(sample.text, { checks: { check: async () => ({ status: "accepted", reason: "ok" }) }, progress: stage => stages.push(stage) });
  expect(accepted.ok).toBe(true);
  expect(stages).toEqual(["received", "validated", "platform-checking", "platform-accepted", "map-generated"]);
  const unavailable = await ingestPipeline(sample.text, { checks: { check: async () => { throw new Error("secret private detail"); } } });
  expect(unavailable.ok).toBe(false);
  expect(JSON.stringify(unavailable)).not.toContain("secret private detail");
});

test("[unit] TM-I7 unknown Opus coverage blocks tm-share projection without rejecting the collection draft", () => {
  const sample = samples()[0];
  if (!sample) throw new Error("sample missing");
  const result = ingestDraft(sample.text.replace('"opus_share_pct": 0', '"opus_share_pct": null'));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.map).toBeNull();
});

test("[unit] TM-I8 visible prompts cover both providers and both modes without installation", async () => {
  const { promptFor } = await import("./ingest.ts");
  for (const provider of ["claude", "codex", "both"]) {
    if (provider !== "claude" && provider !== "codex" && provider !== "both") throw Error("provider");
    for (const mode of ["host", "jev"]) {
      if (mode !== "host" && mode !== "jev") throw Error("mode");
      const prompt = promptFor(provider, mode);
      expect(prompt).toContain("No installer");
      expect(prompt).toContain("rolling seven-day");
      expect(prompt).toContain("tm-collection/1");
      expect(prompt).toContain("Lutfiya Miller");
      expect(prompt).toContain(mode === "host" ? "ZERO Jev calls" : "NOT RUN/unavailable");
    }
  }
});
test("[unit] TM-I9 contradictory Jev provenance and provider readings are rejected", () => {
  const sample = samples()[0]; if (!sample) throw new Error("missing sample");
  for (const analysis of [
    {mode: "jev", status: "completed", model: "unavailable", jev_calls: 0, host_calls: 0},
    {mode: "jev", status: "completed", model: "jev-1.13.0", jev_calls: 3, host_calls: 1},
    {mode: "jev", status: "unavailable", model: "unavailable", jev_calls: 3, host_calls: 0},
    {mode: "jev", status: "completed", model: "jev-1.13.0", jev_calls: 0, host_calls: 0},
  ]) {
    const original: unknown = JSON.parse(sample.text);
    if (typeof original !== "object" || original === null || !("analysis" in original) || typeof original.analysis !== "object" || original.analysis === null) throw Error("fixture");
    expect(ingestDraft(JSON.stringify({...original, analysis: {...original.analysis, ...analysis}})).ok).toBe(false);
  }
  const original: unknown = JSON.parse(sample.text);
  if (typeof original !== "object" || original === null || !("map" in original) || typeof original.map !== "object" || original.map === null) throw Error("fixture");
  expect(ingestDraft(JSON.stringify({...original,map:{...original.map,codex_weekly_pct:30}})).ok).toBe(false);
});
