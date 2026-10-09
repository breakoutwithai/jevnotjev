import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { RESAMPLES, fileSeed } from "../core/calc.ts";
import { formatRows, readDictRows } from "../format/csv.ts";
import { decodeUtf8 } from "../format/validate.ts";
import { applyLabels, formatRecords, isLabelSource, parseRecords, parseTruth, type LabelProvenance } from "../../scripts/uc13/arms.ts";
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
    for (const name of Object.keys(actual)) {
      if (!Object.hasOwn(expected, name)) throw new RescoreInputError(`${field === "" ? name : `${field}.${name}`}: unexpected field`);
    }
    return;
  }
  if (want !== got) throw new RescoreInputError(`${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}

export async function rescoreInput(command: Extract<Command, { readonly cmd: "rescore" }>): Promise<{
  readonly text: string;
  readonly seed: number;
  readonly manifest?: { readonly path: string; readonly text: string };
}> {
  const { file, labels, manifest, writeManifest } = command;
  if (writeManifest !== undefined) {
    const target = await canonical(writeManifest);
    const targetStat = statSync(writeManifest, { throwIfNoEntry: false });
    for (const path of [file, labels, manifest]) {
      if (path === undefined) continue;
      const inputStat = targetStat === undefined ? undefined : statSync(path, { throwIfNoEntry: false });
      if (target === await canonical(path) || (targetStat !== undefined && inputStat !== undefined &&
          targetStat.dev === inputStat.dev && targetStat.ino === inputStat.ino)) {
        throw new RescoreInputError(`--write-manifest ${writeManifest} is an input file`);
      }
    }
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
    const { header, rows: csvRows } = readDictRows(records.text);
    const labelAt = (header ?? []).indexOf("label");
    const sourceAt = (header ?? []).indexOf("label_source");
    const byAt = (header ?? []).indexOf("labelled_by");
    const atAt = (header ?? []).indexOf("labelled_at");
    const blindAt = (header ?? []).indexOf("label_blind");
    const normalized = formatRows([header ?? [], ...csvRows.map(({ fields }) => fields.map((value, i) =>
      fields[labelAt] === "" && [sourceAt, byAt, atAt, blindAt].includes(i) ? "" : value))]);
    const rows = parseRecords(normalized).map((row, i) => {
      const fields = csvRows[i]?.fields;
      if (fields === undefined) throw new RescoreInputError("records.csv row mismatch");
      return {
        ...row,
        label_source: fields[sourceAt] ?? "",
        labelled_by: fields[byAt] ?? "",
        labelled_at: fields[atAt] ?? "",
        label_blind: fields[blindAt] ?? "",
      };
    });
    const provenance = new Map<string, LabelProvenance>();
    for (const row of rows) {
      if (!isLabelSource(row.label_source) || !row.labelled_by || !row.labelled_at ||
          (row.label_blind !== "true" && row.label_blind !== "false")) continue;
      const value: LabelProvenance = {
        source: row.label_source, by: row.labelled_by, at: row.labelled_at, blind: row.label_blind === "true",
      };
      const existing = provenance.get(row.case_id);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) {
        throw new RescoreInputError(`records carry conflicting label provenance for case ${row.case_id}`);
      }
      provenance.set(row.case_id, value);
    }
    const candidateTruth = readDictRows(truthFile.text);
    const idAt = (candidateTruth.header ?? []).indexOf("case_id");
    const truthAt = (candidateTruth.header ?? []).indexOf("truth");
    if (idAt >= 0 && truthAt >= 0) {
      for (const candidate of candidateTruth.rows) {
        const id = candidate.fields[idAt];
        const value = candidate.fields[truthAt];
        for (const row of rows) {
          if (row.case_id !== id) continue;
          const allowed = row.answer_set.split("|");
          if (!allowed.includes(value ?? "")) {
            throw new RescoreInputError(`case ${row.case_id} question ${row.question_id}: truth ${JSON.stringify(value)} is not in answer_set: ${allowed.join(", ")}`);
          }
        }
      }
    }
    const truth = parseTruth(truthFile.text);
    if (truth.size === 0) throw new RescoreInputError("labels.csv is empty: no case_id truth rows");
    const caseIds = new Set(rows.map((row) => row.case_id));
    for (const id of caseIds) if (!truth.has(id)) throw new RescoreInputError(`labels.csv missing case_id ${id} present in records.csv`);
    for (const row of rows) {
      const value = truth.get(row.case_id);
      if (value === undefined) continue;
      const allowed = row.answer_set.split("|");
      if (!allowed.includes(value)) {
        throw new RescoreInputError(`case ${row.case_id} question ${row.question_id}: truth ${JSON.stringify(value)} is not in answer_set: ${allowed.join(", ")}`);
      }
      if (!provenance.has(row.case_id)) throw new RescoreInputError(`records carry no label provenance for case ${row.case_id}`);
    }
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
    const labelled = applyLabels(rows, truth, provenance);
    return {
      text: formatRecords(labelled), seed,
      ...(writeManifest === undefined ? {} : { manifest: { path: writeManifest, text: JSON.stringify(current, null, 2) + "\n" } }),
    };
  } catch (error) {
    if (error instanceof RescoreInputError) throw error;
    throw new RescoreInputError(error instanceof Error ? error.message : "invalid rescore input");
  }
}
