import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { RESAMPLES, fileSeed } from "../core/calc.ts";
import { decodeUtf8 } from "../format/validate.ts";
import { applyLabels, APPROVED_DRAFT_2026_10_03, formatRecords, parseRecords, parseTruth } from "../../scripts/uc13/arms.ts";
import type { Command } from "./cli-args.ts";

export class RescoreInputError extends Error {}

interface Input { readonly text: string; readonly sha256: string }

async function input(path: string): Promise<Input> {
  try {
    const bytes = await Bun.file(path).bytes();
    return { text: decodeUtf8(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    throw new RescoreInputError(`cannot read ${path}: ${error instanceof Error ? error.message : "read failed"}`);
  }
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): { readonly [key: string]: unknown } {
  if (!isRecord(value)) throw new RescoreInputError("manifest must be a JSON object");
  return value;
}

function check(want: unknown, got: unknown, field: string): void {
  if (typeof want === "object" && want !== null && !Array.isArray(want)) {
    const expected = record(want);
    if (!isRecord(got)) throw new RescoreInputError(`${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    const actual = got;
    for (const [name, value] of Object.entries(expected)) check(value, actual[name], field === "" ? name : `${field}.${name}`);
    return;
  }
  if (want !== got) throw new RescoreInputError(`${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

export async function rescoreInput(command: Extract<Command, { readonly cmd: "rescore" }>): Promise<{ readonly text: string; readonly seed: number }> {
  const { file, labels, manifest, writeManifest } = command;
  if (writeManifest !== undefined && [file, labels, manifest].some((path) => path !== undefined && resolve(path) === resolve(writeManifest))) {
    throw new RescoreInputError(`--write-manifest ${writeManifest} is an input file`);
  }
  const records = await input(file);
  const truthFile = await input(labels);
  if (truthFile.text.trim() === "") throw new RescoreInputError("labels.csv is empty: no case_id truth rows");
  try {
    let saved: unknown;
    if (manifest !== undefined) {
      const source = await input(manifest);
      try { saved = JSON.parse(source.text); } catch { throw new RescoreInputError(`${manifest}: invalid manifest JSON`); }
      const fields = record(saved);
      const inputs = isRecord(fields.inputs) ? fields.inputs : {};
      check(records.sha256, isRecord(inputs.records) ? inputs.records.sha256 : undefined, "inputs.records.sha256");
      check(truthFile.sha256, isRecord(inputs.labels) ? inputs.labels.sha256 : undefined, "inputs.labels.sha256");
      check(await fileSeed(records.text), fields.seed, "seed");
      check(RESAMPLES, fields.resamples, "resamples");
    }
    const rows = parseRecords(records.text);
    const truth = parseTruth(truthFile.text);
    if (truth.size === 0) throw new RescoreInputError("labels.csv is empty: no case_id truth rows");
    const caseIds = new Set(rows.map((row) => row.case_id));
    for (const id of caseIds) if (!truth.has(id)) throw new RescoreInputError(`labels.csv missing case_id ${id} present in records.csv`);
    const models: Record<string, string> = {};
    for (const row of rows) {
      const existing = models[row.answerer];
      if (existing !== undefined && existing !== row.answerer_model) throw new RescoreInputError(`answerer_model differs for ${row.answerer}: ${existing} vs ${row.answerer_model}`);
      models[row.answerer] = row.answerer_model;
    }
    const runIds = new Set(rows.map((row) => row.run_id));
    const versions = new Set(rows.map((row) => row.prompt_version));
    if (runIds.size !== 1 || versions.size !== 1) throw new RescoreInputError("records.csv needs one run_id and prompt_version for a run manifest");
    const seed = await fileSeed(records.text);
    const current = {
      format: "jnj-manifest/1", seed, resamples: RESAMPLES,
      models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
      inputs: { records: { sha256: records.sha256 }, labels: { sha256: truthFile.sha256 } },
      run_id: [...runIds][0], prompt_version: [...versions][0],
    };
    if (manifest !== undefined) check(current, saved, "");
    const labelled = applyLabels(rows, truth, APPROVED_DRAFT_2026_10_03);
    if (writeManifest !== undefined) {
      try { await Bun.write(writeManifest, JSON.stringify(current, null, 2) + "\n"); }
      catch (error) { throw new RescoreInputError(`cannot write ${writeManifest}: ${error instanceof Error ? error.message : "write failed"}`); }
    }
    return { text: formatRecords(labelled), seed };
  } catch (error) {
    if (error instanceof RescoreInputError) throw error;
    throw new RescoreInputError(error instanceof Error ? error.message : "invalid rescore input");
  }
}
