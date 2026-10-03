// TokenMax live run. Reads the CVs and questions of examples/d06-tiny, writes docs/product/runs/2026-10-03-tokenmax/.
//
//   bun scripts/tokenmax/run.ts run      rule (no network), Jev (jev-1.13.0, one call per CV per question) and the
//                                        LLM (claude -p --model haiku, one call per CV per question); writes raw.json
//                                        (every request and full raw response) and records.csv with blank labels
//   bun scripts/tokenmax/run.ts replay   rebuild records.csv from raw.json alone, no network; labels in records.csv kept
//   bun scripts/tokenmax/run.ts page     label.html: each answer with its CV and question, no arm, model or confidence
//   bun scripts/tokenmax/run.ts label [labels.csv]   merge the page's download (item_id,label; default
//                                        <out>/labels.csv) into records.csv; a label for another run, CV, question or
//                                        answer is refused
//
// A run writes nothing until every call has succeeded; then raw.json and records.csv are each written to a temp name
// and renamed into place, records.csv only after it validates. Single operator: do not run commands concurrently.
//
// Jev calls go through $JEV_CALL (default ~/.claude/scripts/jaylo-jev.sh call <body.json>), which reads the key
// itself; this process never holds it. The LLM runs with no tools, no MCP servers and no user settings.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRecords, JEV_MODEL, parseRecords, type RecordRow } from "../uc13/arms.ts";
import { assertNoSecrets, assertPinned } from "../uc13/calls.ts";
import { pool, spawnJson } from "../uc13/run-arms.ts";
import { validate } from "../../src/format/validate.ts";
import {
  LLM_MODEL, LLM_MODEL_IDS, LLM_PRICES, RUN_ID, applyItemLabels, samePriceTable, armRecord, blindItems, inputsSha256, jevBody, llmRequest, loadInputs,
  parseJev, parseLlm, rowKey, ruleRecord, sha256Hex, type Case, type Inputs, type Question, type Reply,
} from "./arms.ts";

export const FIXTURE_SCHEMA = "jnj-tokenmax-fixture/1";
const CONCURRENCY = 4;
const USAGE = "usage: bun scripts/tokenmax/run.ts run | replay | page | label [labels.csv]";

export interface Paths { readonly d06: string; readonly out: string; readonly template: string; readonly jevCall: string; readonly claude: string }

export function defaultPaths(): Paths {
  return {
    d06: fileURLToPath(new URL("../../examples/d06-tiny/records.csv", import.meta.url)),
    out: fileURLToPath(new URL("../../docs/product/runs/2026-10-03-tokenmax/", import.meta.url)),
    template: fileURLToPath(new URL("./label.template.html", import.meta.url)),
    jevCall: process.env.JEV_CALL ?? join(homedir(), ".claude/scripts/jaylo-jev.sh"),
    claude: "claude",
  };
}

type Arm = "jev" | "llm";
const ARMS: readonly Arm[] = ["jev", "llm"];
export interface Entry {
  readonly arm: Arm;
  readonly case_id: string;
  readonly question_id: string;
  readonly request: unknown;
  readonly request_sha256: string;
  readonly response: unknown;
  readonly latency_ms: number;
  readonly utc: string;
}
export interface Fixture { readonly inputs_sha256: string; readonly captured_utc: string; readonly entries: readonly Entry[] }

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestFor(arm: Arm, c: Case, q: Question): unknown {
  return arm === "jev" ? jevBody(c, q) : llmRequest(c, q);
}

function pairs(inputs: Inputs): { c: Case; q: Question }[] {
  return inputs.cases.flatMap((c) => inputs.questions.map((q) => ({ c, q })));
}

/** One captured call; a response holding a secret, or a Jev call off the pin, is refused before it is kept. */
export function entry(arm: Arm, c: Case, q: Question, response: unknown, latencyMs: number, utc: string): Entry {
  const request = requestFor(arm, c, q);
  const who = `${arm} ${c.case_id} ${q.question_id}`;
  assertNoSecrets(response, who);
  if (arm === "jev") assertPinned(request, response, who);
  return { arm, case_id: c.case_id, question_id: q.question_id, request, request_sha256: sha256Hex(JSON.stringify(request)), response, latency_ms: latencyMs, utc };
}

export function fixtureJson(fixture: Fixture): string {
  const calls = { jev: fixture.entries.filter((e) => e.arm === "jev").length, llm: fixture.entries.filter((e) => e.arm === "llm").length };
  return JSON.stringify({
    schema: FIXTURE_SCHEMA, run_id: RUN_ID, captured_utc: fixture.captured_utc, inputs_sha256: fixture.inputs_sha256,
    jev_model: JEV_MODEL, llm_model_requested: LLM_MODEL, llm_price_table: LLM_PRICES, calls, entries: fixture.entries,
  }, null, 1) + "\n";
}

export function parseFixture(text: string): Fixture {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw) || raw.schema !== FIXTURE_SCHEMA || raw.run_id !== RUN_ID || typeof raw.inputs_sha256 !== "string" ||
    typeof raw.captured_utc !== "string" || !Array.isArray(raw.entries)) {
    throw new Error(`raw.json is not a ${FIXTURE_SCHEMA} fixture for ${RUN_ID}`);
  }
  if (!samePriceTable(raw.llm_price_table)) throw new Error("raw.json llm_price_table differs from the dated price table in scripts/tokenmax/arms.ts; costs would not match the capture");
  const entries = raw.entries.map((e: unknown, i: number): Entry => {
    if (!isObject(e) || (e.arm !== "jev" && e.arm !== "llm") || typeof e.case_id !== "string" || typeof e.question_id !== "string" ||
      typeof e.request_sha256 !== "string" || typeof e.latency_ms !== "number" || !Number.isInteger(e.latency_ms) || e.latency_ms < 0 || typeof e.utc !== "string") {
      throw new Error(`raw.json entry ${i} is malformed`);
    }
    return { arm: e.arm, case_id: e.case_id, question_id: e.question_id, request: e.request, request_sha256: e.request_sha256, response: e.response, latency_ms: e.latency_ms, utc: e.utc };
  });
  return { inputs_sha256: raw.inputs_sha256, captured_utc: raw.captured_utc, entries };
}

/**
 * The records from the fixture alone: rule rows recomputed, one Jev and one LLM row per CV per question, each from
 * exactly one entry whose stored request hashes to the request the current inputs would send.
 */
export function rowsFromFixture(inputs: Inputs, fixture: Fixture): RecordRow[] {
  if (fixture.inputs_sha256 !== inputsSha256(inputs)) throw new Error("raw.json inputs_sha256 does not match the current CVs, questions and prompts; rerun");
  const rows: RecordRow[] = pairs(inputs).map(({ c, q }) => ruleRecord(c, q));
  for (const arm of ARMS) {
    for (const { c, q } of pairs(inputs)) {
      const who = `${arm} ${c.case_id} ${q.question_id}`;
      const found = fixture.entries.filter((e) => e.arm === arm && e.case_id === c.case_id && e.question_id === q.question_id);
      const e = found[0];
      if (found.length !== 1 || e === undefined) throw new Error(`raw.json has ${found.length} entries for ${who}, expected 1`);
      const want = sha256Hex(JSON.stringify(requestFor(arm, c, q)));
      if (e.request_sha256 !== want || sha256Hex(JSON.stringify(e.request)) !== want) throw new Error(`raw.json ${who}: request changed; rerun`);
      assertNoSecrets(e.response, who);
      const reply = arm === "jev" ? parseJev(e.response, q.question_id, who) : parseLlm(e.response, who);
      rows.push(armRecord(c, q, arm, reply, e.latency_ms));
    }
  }
  if (fixture.entries.length !== rows.length - pairs(inputs).length) throw new Error("raw.json holds entries outside the 5 CVs x 2 questions");
  return rows;
}

const LABEL_BINDING: readonly (keyof RecordRow)[] = ["run_id", "prompt_version", "case_input", "question", "answer_set", "output"];

/** A label survives a replay only when the row it was given to shows the same run, prompt, CV, question, answer set and answer. */
export function keepLabels(rows: readonly RecordRow[], old: readonly RecordRow[]): RecordRow[] {
  const byKey = new Map(old.map((r) => [rowKey(r), r]));
  return rows.map((r) => {
    const o = byKey.get(rowKey(r));
    if (o === undefined || LABEL_BINDING.some((col) => o[col] !== r[col])) return r;
    return { ...r, label: o.label, label_source: o.label_source };
  });
}

/** Write to a uniquely named temp file in the same directory, then rename, so a reader never sees a half-written file. */
async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

/**
 * Every record the inputs would produce, with placeholder answers, through the jnj-record/1 validator: a CV or question
 * the record schema refuses (blank, over 8,000 characters, ...) stops the run before any paid call.
 */
export function preflight(inputs: Inputs): void {
  const reply = (model: string, confidence: number | null): Reply => ({ choice: "yes", model, confidence, tokensIn: 0, tokensOut: 0, costUsd: 0 });
  const rows = pairs(inputs).flatMap(({ c, q }) => [
    ruleRecord(c, q), armRecord(c, q, "jev", reply(JEV_MODEL, 0.5), 0), armRecord(c, q, "llm", reply(LLM_MODEL_IDS[0] ?? "", null), 0),
  ]);
  const { errors } = validate(formatRecords(rows));
  if (errors.length > 0) throw new Error(`inputs would not make valid records, no call made: ${errors.slice(0, 3).join("; ")}`);
}

/**
 * raw.json is the record of the run: validated (it must rebuild valid records), written atomically, then records.csv
 * is derived from it by its own atomic write. If that second write fails, `replay` rebuilds records.csv from raw.json.
 */
export async function publishRun(out: string, inputs: Inputs, fixture: Fixture): Promise<void> {
  const rawText = fixtureJson(fixture);
  const rows = rowsFromFixture(inputs, parseFixture(rawText));
  parseRecords(formatRecords(rows));
  await atomicWrite(join(out, "raw.json"), rawText);
  await writeRecords(out, rows);
}

/** records.csv is validated first and replaced only when valid. */
export async function writeRecords(out: string, rows: readonly RecordRow[]): Promise<void> {
  const text = formatRecords(rows);
  parseRecords(text);
  await atomicWrite(join(out, "records.csv"), text);
  console.log(`wrote records.csv rows=${rows.length}`);
}

async function run(paths: Paths, inputs: Inputs): Promise<void> {
  preflight(inputs);
  await mkdir(paths.out, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "tokenmax-"));
  const work = pairs(inputs);
  try {
    const jev = await pool(work, CONCURRENCY, async ({ c, q }, i) => {
      const bodyPath = join(dir, `req-${i}.json`);
      await Bun.write(bodyPath, JSON.stringify(jevBody(c, q)));
      const { json, ms } = await spawnJson([paths.jevCall, "call", bodyPath], dir, `Jev ${c.case_id} ${q.question_id}`);
      parseJev(json, q.question_id, `Jev ${c.case_id} ${q.question_id}`);
      return entry("jev", c, q, json, ms, new Date().toISOString());
    });
    const llm = await pool(work, CONCURRENCY, async ({ c, q }) => {
      const r = llmRequest(c, q);
      const { json, ms } = await spawnJson(
        [paths.claude, "-p", "--model", r.model, "--output-format", "json", "--tools", "", "--strict-mcp-config",
          "--setting-sources", "", "--no-session-persistence", "--system-prompt", r.system, r.user],
        dir, `claude -p ${c.case_id} ${q.question_id}`,
      );
      parseLlm(json, `LLM ${c.case_id} ${q.question_id}`);
      return entry("llm", c, q, json, ms, new Date().toISOString());
    });
    await publishRun(paths.out, inputs, { inputs_sha256: inputsSha256(inputs), captured_utc: new Date().toISOString(), entries: [...jev, ...llm] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function replay(paths: Paths, inputs: Inputs): Promise<void> {
  const fixture = parseFixture(await Bun.file(join(paths.out, "raw.json")).text());
  const file = Bun.file(join(paths.out, "records.csv"));
  const old = (await file.exists()) ? parseRecords(await file.text()) : [];
  await writeRecords(paths.out, keepLabels(rowsFromFixture(inputs, fixture), old));
}

/** JSON safe inside an inline <script>: every `<` is escaped. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderPage(template: string, rows: readonly RecordRow[]): string {
  return template.replace(/__ITEMS__/g, () => scriptJson(blindItems(rows)));
}

async function page(paths: Paths): Promise<void> {
  const rows = parseRecords(await Bun.file(join(paths.out, "records.csv")).text());
  await atomicWrite(join(paths.out, "label.html"), renderPage(await Bun.file(paths.template).text(), rows));
  console.log(`wrote label.html with ${rows.length} answers`);
}

async function label(paths: Paths, labelsPath: string): Promise<void> {
  const rows = applyItemLabels(parseRecords(await Bun.file(join(paths.out, "records.csv")).text()), await Bun.file(labelsPath).text());
  await writeRecords(paths.out, rows);
  console.log(`labelled ${rows.filter((r) => r.label !== "").length} of ${rows.length} rows`);
}

export async function main(argv: readonly string[], paths: Paths): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "label") {
    if (rest.length > 1) throw new Error(USAGE);
    await label(paths, rest[0] ?? join(paths.out, "labels.csv"));
    return;
  }
  if (rest.length > 0) throw new Error(USAGE);
  if (command === "page") await page(paths);
  else if (command === "run") await run(paths, loadInputs(await Bun.file(paths.d06).text()));
  else if (command === "replay") await replay(paths, loadInputs(await Bun.file(paths.d06).text()));
  else throw new Error(USAGE);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2), defaultPaths());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
