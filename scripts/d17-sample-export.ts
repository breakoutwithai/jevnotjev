/**
 * D17 sample export: drives a real BackstageRun through its public API with a fictional, deterministic transport,
 * labels every answer, reveals, and returns run.evidence(). Nothing here calls a provider or reads a credential.
 *
 *   bun scripts/d17-sample-export.ts            writes examples/d17-sample-export/export.json
 *   bun scripts/d17-sample-export.ts --check    exits 1 when the committed file differs from a fresh export
 */
import { setSystemTime } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BACKSTAGE_PICK, BackstageRun, inputFingerprint } from "../src/backstage/run.ts";
import { getModelEntry } from "../src/backstage/catalog.ts";
import type { AnswerRequest, AnswerSuccess, Scene } from "../src/backstage/contracts.ts";

export const SAMPLE_EXPORT_PATH = fileURLToPath(new URL("../examples/d17-sample-export/export.json", import.meta.url));
const CLOCK = "2026-10-11T09:00:00.000Z";
const LLM_ARM = "claude-haiku-4-5-20251001";
/** Fictional keys: the run needs one per provider to start; neither reaches the export. */
const SAMPLE_KEYS = { jev: "sample-jev-not-a-real-key", anthropic: "sample-llm-not-a-real-key" };
const CASES = 32;
/** Cases each answerer gets wrong, so labels hold both accepts and rejects. */
const JEV_WRONG = new Set(["c05", "c19"]);
const LLM_WRONG = new Set(["c03", "c08", "c14", "c21", "c27", "c30"]);

function caseId(n: number): string {
  return "c" + String(n).padStart(2, "0");
}
/** Odd cases are qualified; every fourth qualified case says "TS" only, so the keyword rule misses it. */
function input(n: number): string {
  if (n % 2 === 0) return `Case ${n}: gardener, no software work`;
  return n % 4 === 3 ? `Case ${n}: TS builder, ships weekly` : `Case ${n}: TypeScript builder, ships weekly`;
}
function truth(id: string): "yes" | "no" {
  return Number(id.slice(1)) % 2 === 1 ? "yes" : "no";
}
function flip(choice: "yes" | "no"): "yes" | "no" {
  return choice === "yes" ? "no" : "yes";
}

export function sampleScene(): Scene {
  return {
    question: "Is this person a qualified TypeScript builder?",
    choices: [
      { name: "yes", definition: "Builds software in TypeScript" },
      { name: "no", definition: "Does not build software in TypeScript" },
    ],
    acceptance: "The answer matches the person described",
    exclusions: "None",
    keywords: ["typescript"],
    matchChoice: "yes",
    otherwiseChoice: "no",
    cases: Array.from({ length: CASES }, (_, i) => ({ id: caseId(i + 1), input: input(i + 1) })),
  };
}

async function transport(r: AnswerRequest): Promise<AnswerSuccess> {
  const jev = r.provider === "jev";
  const wrong = (jev ? JEV_WRONG : LLM_WRONG).has(r.caseId);
  const right = truth(r.caseId);
  const parameters = getModelEntry(r.armId)?.parameters;
  if (!parameters) throw new Error(`No catalog entry for ${r.armId}.`);
  return {
    ok: true,
    runId: r.runId,
    revision: r.revision,
    caseId: r.caseId,
    provider: r.provider,
    attemptId: `sample-${r.armId}-${r.caseId}`,
    fingerprint: await inputFingerprint(r),
    startedAt: CLOCK,
    finishedAt: CLOCK,
    latencyMs: jev ? 120 : 480,
    model: r.modelId,
    armId: r.armId,
    catalogVersion: r.catalogVersion,
    promptVersion: r.promptVersion,
    requestedModel: r.modelId,
    returnedModel: r.modelId,
    parameters,
    tokensIn: jev ? 40 : 180,
    tokensOut: 1,
    costUsd: jev ? 0.0002 : 0.0011,
    priceVersion: "2026-10-03",
    output: wrong ? flip(right) : right,
    confidence: null,
  };
}

let patching = false;
/**
 * Swaps crypto.randomUUID for a counter while `work` runs, so the run id is the same on every generation.
 * The swap is global, so a second overlapping call would restore the wrong originals: it throws instead.
 */
async function withFixedIds<T>(work: () => Promise<T>): Promise<T> {
  if (patching) throw new Error("sampleRun() cannot overlap: it patches crypto.randomUUID and the clock globally.");
  patching = true;
  const original = crypto.randomUUID;
  let n = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  setSystemTime(new Date(CLOCK));
  try {
    return await work();
  } finally {
    crypto.randomUUID = original;
    setSystemTime();
    patching = false;
  }
}

/** A finished compare run: Jev, one LLM arm and the keyword rule over 32 fictional cases, every answer labelled. */
export async function sampleRun(): Promise<BackstageRun> {
  return withFixedIds(async () => {
    const run = new BackstageRun(sampleScene(), "d17-sample", { arms: ["jev", LLM_ARM, "rule"] });
    await run.start(SAMPLE_KEYS, transport);
    run.beginLabeling();
    for (const card of run.cards())
      run.label(card.id, card.output === truth(card.caseId) ? "accept" : "reject", BACKSTAGE_PICK, new Date(CLOCK));
    run.reveal();
    return run;
  });
}

/** The sample export exactly as the file holds it. */
export async function sampleExportText(): Promise<string> {
  const run = await sampleRun();
  // evidence() exports verdicts only after report() has computed them from the same records.
  await run.report();
  return JSON.stringify(run.evidence(), null, 2) + "\n";
}

if (import.meta.main) {
  const text = await sampleExportText();
  if (process.argv.includes("--check")) {
    const same = readFileSync(SAMPLE_EXPORT_PATH, "utf8") === text;
    console.log(same ? "sample export is current" : "sample export differs from a fresh export: regenerate it");
    process.exit(same ? 0 : 1);
  }
  writeFileSync(SAMPLE_EXPORT_PATH, text);
  console.log(`wrote ${SAMPLE_EXPORT_PATH}`);
}
