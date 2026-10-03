// TokenMax live run. Reads the CVs and questions of examples/d06-tiny, writes docs/product/runs/2026-10-03-tokenmax/.
//
//   bun scripts/tokenmax/run.ts run      rule (no network), Jev (jev-1.13.0, one call per CV per question) and the
//                                        LLM (claude -p --model haiku, one call per CV per question); writes raw.json
//                                        (every request and full raw response) and records.csv with blank labels
//   bun scripts/tokenmax/run.ts replay   rebuild records.csv from raw.json alone, no network; labels in records.csv kept
//   bun scripts/tokenmax/run.ts page     label.html: each answer with its CV and question, no arm, model or confidence
//   bun scripts/tokenmax/run.ts label    merge labels.csv (item_id,label) from the page into records.csv
//
// Jev calls go through $JEV_CALL (default ~/.claude/scripts/jaylo-jev.sh call <body.json>), which reads the key
// itself; this process never holds it. The LLM runs with no tools, no MCP servers and no user settings.
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRecords, JEV_MODEL, parseRecords, type RecordRow } from "../uc13/arms.ts";
import { assertNoSecrets, assertPinned } from "../uc13/calls.ts";
import { pool, spawnJson } from "../uc13/run-arms.ts";
import {
  LLM_MODEL, LLM_PRICES, RUN_ID, applyItemLabels, armRecord, blindItems, inputsSha256, jevBody, llmRequest, loadInputs,
  parseJev, parseLlm, rowKey, ruleRecord, sha256Hex, type Case, type Inputs, type Question,
} from "./arms.ts";

export const FIXTURE_SCHEMA = "jnj-tokenmax-fixture/1";
const CONCURRENCY = 4;
const USAGE = "usage: bun scripts/tokenmax/run.ts run | replay | page | label";

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

/** Labels already in records.csv survive a replay, matched by CV, question and answerer. */
function keepLabels(rows: readonly RecordRow[], old: readonly RecordRow[]): RecordRow[] {
  const byKey = new Map(old.map((r) => [rowKey(r), r]));
  return rows.map((r) => {
    const o = byKey.get(rowKey(r));
    return o === undefined || o.output !== r.output ? r : { ...r, label: o.label, label_source: o.label_source };
  });
}

async function writeRecords(out: string, rows: readonly RecordRow[]): Promise<void> {
  await Bun.write(join(out, "records.csv"), formatRecords(rows));
  parseRecords(formatRecords(rows));
  console.log(`wrote records.csv rows=${rows.length}`);
}

async function run(paths: Paths, inputs: Inputs): Promise<void> {
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
    const fixture: Fixture = { inputs_sha256: inputsSha256(inputs), captured_utc: new Date().toISOString(), entries: [...jev, ...llm] };
    await Bun.write(join(paths.out, "raw.json"), fixtureJson(fixture));
    await writeRecords(paths.out, rowsFromFixture(inputs, fixture));
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
  await Bun.write(join(paths.out, "label.html"), renderPage(await Bun.file(paths.template).text(), rows));
  console.log(`wrote label.html with ${rows.length} answers`);
}

async function label(paths: Paths): Promise<void> {
  const rows = applyItemLabels(parseRecords(await Bun.file(join(paths.out, "records.csv")).text()), await Bun.file(join(paths.out, "labels.csv")).text());
  await writeRecords(paths.out, rows);
  console.log(`labelled ${rows.filter((r) => r.label !== "").length} of ${rows.length} rows`);
}

export async function main(argv: readonly string[], paths: Paths): Promise<void> {
  const [command, ...rest] = argv;
  if (rest.length > 0) throw new Error(USAGE);
  const inputs = loadInputs(await Bun.file(paths.d06).text());
  if (command === "run") await run(paths, inputs);
  else if (command === "replay") await replay(paths, inputs);
  else if (command === "page") await page(paths);
  else if (command === "label") await label(paths);
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
