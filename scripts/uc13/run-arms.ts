// UC13 three-arm run. Reads examples/uc13-shop-bot/, writes docs/product/runs/2026-10-01-uc13-shop-bot/.
//
//   bun scripts/uc13/run-arms.ts run --dry   rule arm only, no network; prints the outputs, writes nothing
//   bun scripts/uc13/run-arms.ts run         rule, Jev (jev-1.13.0) and the LLM (claude -p --model haiku)
//   bun scripts/uc13/run-arms.ts run --arm jev   only the Jev arm calls out; rule and llm rows of records.csv are kept,
//                                            only when raw.json's inputs_sha256 matches the current inputs
//   bun scripts/uc13/run-arms.ts replay      rebuild the Jev rows from examples/uc13-shop-bot/fixtures/uc13.jev.json, no network
//   bun scripts/uc13/run-arms.ts page        label.html: fact sheet, acceptance rule, messages; no arm output
//   bun scripts/uc13/run-arms.ts label --source <s> --by <handle> --at <time> --blind <true|false>
//                                            merge labels.csv (case_id,truth) into records.csv, stamped with that
//                                            provenance (format/README.md "Label provenance"); no default
//
// Jev calls go through $JEV_CALL (default ~/.claude/scripts/jaylo-jev.sh call <body.json>), which reads the key
// itself; this process never holds it. The LLM arm runs with no tools, no MCP servers and no user settings,
// so its cost is the triage prompt alone. One call per message per arm. Labels already in records.csv survive
// replay and a Jev-only rerun.
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASE_IDS, CRITERIA, PROMPT_VERSION, QUESTION, RUN_ID, applyLabels, armRecord, formatRecords, jevBody, loadExample, isLabelSource,
  parseJevResponse, parseLlmResponse, parseRecords, parseTruth, provenanceByCase, ruleRecord, truthFromRows, type Answer,
  type ArmReply, type Case, type LabelProvenance, type RecordRow,
} from "./arms.ts";
import { jevEntry, readFixture, replayJev, sha256Hex, writeFixture, type JevEntry } from "./calls.ts";
import { isCalendarDate } from "../../src/format/validate.ts";

const LLM_MODEL = "haiku";
const CONCURRENCY = 4;
/** A call that has not answered by now is killed; the slowest recorded LLM call took under 10 s. */
const CALL_DEADLINE_MS = 120_000;
const USAGE =
  "usage: bun scripts/uc13/run-arms.ts run [--dry | --arm jev] | replay | page | " +
  "label --source <human|human_reviewed|agent> --by <handle> --at <YYYY-MM-DD or UTC time> --blind <true|false>";

export interface Paths {
  readonly example: string;
  readonly out: string;
  readonly fixture: string;
  readonly jevCall: string;
}

export function defaultPaths(): Paths {
  const example = fileURLToPath(new URL("../../examples/uc13-shop-bot/", import.meta.url));
  return {
    example,
    out: fileURLToPath(new URL("../../docs/product/runs/2026-10-01-uc13-shop-bot/", import.meta.url)),
    fixture: join(example, "fixtures/uc13.jev.json"),
    jevCall: process.env.JEV_CALL ?? join(homedir(), ".claude/scripts/jaylo-jev.sh"),
  };
}

type Arm = "jev" | "llm";
type Command = "run" | "replay" | "label" | "page";
export interface Args {
  readonly command: Command;
  readonly dry: boolean;
  readonly arm: "jev" | null;
  /** label only: how labels.csv was made. Required, so no label is ever stamped human by default. */
  readonly provenance: LabelProvenance | null;
}

function isCommand(value: string | undefined): value is Command {
  return value === "run" || value === "replay" || value === "label" || value === "page";
}

const LABEL_FLAGS = ["--source", "--by", "--at", "--blind"];
// Same rules as format/record-v1.schema.json, checked here so a bad flag fails before records.csv is touched.
const HANDLE = /^[A-Za-z0-9_.:+-]{1,64}$/;
const LABELLED_AT = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])(T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,3})?)?Z)?$/;

/** label --source <human|human_reviewed|agent> --by <handle> --at <time> --blind <true|false>, each exactly once. */
function labelProvenance(flags: readonly string[]): LabelProvenance {
  const given = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i] ?? "";
    const value = flags[i + 1];
    if (!LABEL_FLAGS.includes(flag) || given.has(flag)) throw new Error(`unknown or repeated flag ${flag}; ${USAGE}`);
    if (value === undefined) throw new Error(`${flag} needs a value; ${USAGE}`);
    given.set(flag, value);
  }
  const missing = LABEL_FLAGS.filter((flag) => !given.has(flag));
  if (missing.length > 0) throw new Error(`label needs ${missing.join(", ")}: say who labelled labels.csv and how; ${USAGE}`);
  const source = given.get("--source") ?? "";
  const by = given.get("--by") ?? "";
  const at = given.get("--at") ?? "";
  const blind = given.get("--blind") ?? "";
  if (!isLabelSource(source)) throw new Error(`--source takes human, human_reviewed or agent, got ${source}`);
  if (!HANDLE.test(by)) throw new Error(`--by takes a handle (letters, digits, _ . : + -), never an email, got ${by}`);
  if (!LABELLED_AT.test(at) || !isCalendarDate(at.slice(0, 10))) throw new Error(`--at takes YYYY-MM-DD or a UTC time like 2026-10-07T09:30:00Z, got ${at}`);
  if (blind !== "true" && blind !== "false") throw new Error(`--blind takes true or false, got ${blind}`);
  return { source, by, at, blind: blind === "true" };
}

/** The command line against an explicit whitelist; an unknown, repeated or conflicting flag fails before any side effect. */
export function parseArgs(argv: readonly string[]): Args {
  const [command, ...flags] = argv;
  if (!isCommand(command)) throw new Error(USAGE);
  if (command === "label") return { command, dry: false, arm: null, provenance: labelProvenance(flags) };
  let dry = false;
  let arm: "jev" | null = null;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (command !== "run") throw new Error(`${command} takes no flags, got ${flag ?? ""}; ${USAGE}`);
    if (flag === "--dry" && !dry) dry = true;
    else if (flag === "--arm" && arm === null) {
      if (flags[i + 1] !== "jev") throw new Error(`--arm takes jev, got ${flags[i + 1] ?? "nothing"}`);
      arm = "jev";
      i++;
    } else throw new Error(`unknown or repeated flag ${flag ?? ""}; ${USAGE}`);
  }
  if (dry && arm !== null) throw new Error("--dry and --arm jev conflict: a dry run calls no arm");
  return { command, dry, arm, provenance: null };
}

function llmSystem(factSheet: string): string {
  return "You are the triage step of a ski shop's website and phone bot. Rules: unknown availability stays unknown; " +
    "an enquiry is not a confirmed booking; the bot may only state facts from the fact sheet.\n\n" +
    `Fact sheet:\n${factSheet}\n\nFor the customer message you are given, decide: ${QUESTION}\n` +
    `answer: ${CRITERIA.answer}\nhand_off: ${CRITERIA.hand_off}\n` +
    "Reply with exactly one word: answer or hand_off.";
}

/** Everything an arm's answer depends on; a kept arm is only comparable to a rerun one when this is unchanged. */
export function inputsSha256(factSheet: string, cases: readonly Case[]): string {
  return sha256Hex(JSON.stringify({ prompt_version: PROMPT_VERSION, llm_model: LLM_MODEL, system: llmSystem(factSheet), cases }));
}

/** Run a command for its JSON stdout; killed and rejected at the deadline. */
export async function spawnJson(cmd: readonly string[], cwd: string, what: string, deadlineMs = CALL_DEADLINE_MS): Promise<{ json: unknown; ms: number }> {
  const t0 = performance.now();
  const proc = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, deadlineMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const ms = Math.round(performance.now() - t0);
    if (timedOut) throw new Error(`${what} timed out after ${deadlineMs} ms`);
    if (code !== 0) throw new Error(`${what} exited ${code}: ${stderr.trim().slice(0, 300)}`);
    const json: unknown = JSON.parse(stdout);
    return { json, ms };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run fn over items, at most `limit` at a time, results in input order. After the first failure no new item starts,
 * and the pool rejects only once every in-flight call has settled, so the caller's cleanup never races a worker.
 */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  let failed = false;
  let firstError: unknown = null;
  await Promise.allSettled(Array.from({ length: limit }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      const item = items[i];
      if (item === undefined) continue;
      try {
        out[i] = await fn(item, i);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  }));
  if (failed) throw firstError;
  return out;
}

interface Timed { readonly reply: ArmReply; readonly ms: number }
interface RawCall { readonly case_id: string; readonly arm: Arm; readonly model: string; readonly choice: string; readonly probabilities: unknown }
interface Raw { readonly inputsSha256: string | null; readonly calls: readonly RawCall[] }

function rawCall(c: Case, arm: Arm, reply: ArmReply): RawCall {
  return { case_id: c.case_id, arm, model: reply.model, choice: reply.choice, probabilities: reply.probabilities };
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** raw.json, strictly: this run's id, an optional inputs fingerprint, and well-formed calls. */
async function readRaw(out: string): Promise<Raw> {
  const raw: unknown = JSON.parse(await Bun.file(join(out, "raw.json")).text());
  if (!isObject(raw) || raw.run_id !== RUN_ID || !Array.isArray(raw.calls)) throw new Error(`raw.json is not the ${RUN_ID} call list`);
  const fp = raw.inputs_sha256;
  if (fp !== undefined && typeof fp !== "string") throw new Error("raw.json inputs_sha256 is not a string");
  const calls = raw.calls.map((x: unknown, i: number): RawCall => {
    if (!isObject(x) || typeof x.case_id !== "string" || (x.arm !== "jev" && x.arm !== "llm") || typeof x.model !== "string" || typeof x.choice !== "string") {
      throw new Error(`raw.json call ${i} is malformed`);
    }
    return { case_id: x.case_id, arm: x.arm, model: x.model, choice: x.choice, probabilities: x.probabilities };
  });
  return { inputsSha256: fp ?? null, calls };
}

/** One row and one raw call per case for the arm, agreeing on model and output; anything else fails. */
function assertArmComplete(arm: Arm, rows: readonly RecordRow[], calls: readonly RawCall[]): void {
  for (const id of CASE_IDS) {
    const r = rows.filter((x) => x.case_id === id);
    const c = calls.filter((x) => x.case_id === id);
    const row = r[0];
    const call = c[0];
    if (r.length !== 1 || c.length !== 1 || row === undefined || call === undefined) {
      throw new Error(`records.csv/raw.json: ${arm} arm has ${r.length} rows and ${c.length} raw calls for ${id}, expected 1 and 1`);
    }
    if (row.output !== call.choice || row.answerer_model !== call.model) throw new Error(`records.csv/raw.json: ${arm} ${id} row and raw call disagree`);
  }
  if (rows.length !== CASE_IDS.length || calls.length !== CASE_IDS.length) {
    throw new Error(`records.csv/raw.json: ${arm} arm holds cases outside m01 to m${CASE_IDS.length}`);
  }
}

interface Kept {
  readonly rows: RecordRow[];
  readonly calls: readonly RawCall[];
  readonly truth: Map<string, Answer>;
  /** How the kept labels were made, carried through a rebuild unchanged. */
  readonly provenance: Map<string, LabelProvenance>;
  readonly inputsSha256: string | null;
}

/** The recorded llm arm, complete and consistent, plus the truth its labels encode. */
async function keptLlm(out: string): Promise<Kept> {
  const all = parseRecords(await Bun.file(join(out, "records.csv")).text());
  const raw = await readRaw(out);
  const rows = all.filter((r) => r.answerer === "llm");
  const calls = raw.calls.filter((x) => x.arm === "llm");
  assertArmComplete("llm", rows, calls);
  return { rows, calls, truth: truthFromRows(all), provenance: provenanceByCase(all), inputsSha256: raw.inputsSha256 };
}

async function write(out: string, rows: readonly RecordRow[], calls: readonly RawCall[], inputs: string | null): Promise<void> {
  await Bun.write(join(out, "records.csv"), formatRecords(rows));
  const raw = { run_id: RUN_ID, llm_model_requested: LLM_MODEL, ...(inputs === null ? {} : { inputs_sha256: inputs }), calls };
  await Bun.write(join(out, "raw.json"), JSON.stringify(raw, null, 1) + "\n");
  const arms = [...new Set(rows.map((r) => r.answerer))].sort().join(",");
  console.log(`wrote records.csv rows=${rows.length} cases=${CASE_IDS.length} arms=${arms}`);
}

async function run(paths: Paths, dry: boolean, only: Arm | null): Promise<void> {
  const { factSheet, cases } = await loadExample(paths.example);
  if (dry) {
    const rows = cases.map(ruleRecord);
    for (const r of rows) console.log(`${r.case_id} ${r.output}`);
    const handOff = rows.filter((r) => r.output === "hand_off").length;
    console.log(`dry run: rule arm hand_off=${handOff} answer=${rows.length - handOff}; nothing written`);
    return;
  }
  const inputs = inputsSha256(factSheet, cases);
  const kept = only === "jev" ? await keptLlm(paths.out) : null;
  if (kept !== null && kept.inputsSha256 !== inputs) {
    throw new Error(
      "run --arm jev: raw.json has no inputs_sha256 matching the current fact sheet, cases and prompt; " +
        "the kept LLM arm may come from other inputs, so a full run is required",
    );
  }
  const captured: JevEntry[] = [];
  const jevArm = async (c: Case, i: number, dir: string): Promise<Timed> => {
    const bodyPath = join(dir, `req-${i}.json`); // never derived from case_id
    const body = jevBody(factSheet, c);
    await Bun.write(bodyPath, JSON.stringify(body)); // these exact bytes are what jaylo-jev.sh hashes and POSTs
    const { json, ms } = await spawnJson([paths.jevCall, "call", bodyPath], dir, `Jev ${c.case_id}`);
    const reply = parseJevResponse(json, c.case_id);
    captured.push(jevEntry(c.case_id, body, json, ms, new Date().toISOString()));
    return { reply, ms };
  };
  const llmArm = async (c: Case, _i: number, dir: string): Promise<Timed> => {
    const { json, ms } = await spawnJson(
      ["claude", "-p", "--model", LLM_MODEL, "--output-format", "json", "--tools", "", "--strict-mcp-config",
        "--setting-sources", "", "--no-session-persistence", "--system-prompt", llmSystem(factSheet), `Customer message: ${c.case_input}`],
      dir, `claude -p ${c.case_id}`,
    );
    return { reply: parseLlmResponse(json, c.case_id), ms };
  };
  const rows: RecordRow[] = cases.map(ruleRecord);
  const calls: RawCall[] = [];
  const dir = await mkdtemp(join(tmpdir(), "uc13-"));
  try {
    const arms: readonly (readonly [Arm, (c: Case, i: number, dir: string) => Promise<Timed>])[] = [["jev", jevArm], ["llm", llmArm]];
    for (const [arm, fn] of arms) {
      if (only !== null && only !== arm) continue;
      const results = await pool(cases, CONCURRENCY, (c, i) => fn(c, i, dir));
      results.forEach(({ reply, ms }, i) => {
        const c = cases[i];
        if (c === undefined) return;
        rows.push(armRecord(c, arm, reply, ms));
        calls.push(rawCall(c, arm, reply));
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (captured.length > 0) {
    const order = new Map(cases.map((c, i) => [c.case_id, i]));
    captured.sort((a, b) => (order.get(a.case_id) ?? 0) - (order.get(b.case_id) ?? 0));
    await writeFixture(paths.fixture, captured, new Date().toISOString());
  }
  const all = kept === null ? rows : applyLabels([...rows, ...kept.rows], kept.truth, kept.provenance);
  await write(paths.out, all, [...calls, ...(kept?.calls ?? [])], inputs);
}

/** Rebuild the Jev rows and raw calls from the fixture alone; rule rows are recomputed, llm rows and all labels kept. */
async function replay(paths: Paths): Promise<void> {
  const { factSheet, cases } = await loadExample(paths.example);
  const kept = await keptLlm(paths.out);
  if (kept.inputsSha256 !== null && kept.inputsSha256 !== inputsSha256(factSheet, cases)) {
    throw new Error("replay: raw.json inputs_sha256 does not match the current fact sheet, cases and prompt; the kept LLM arm is stale");
  }
  const replayed = replayJev(await readFixture(paths.fixture), cases, (c) => jevBody(factSheet, c));
  const rows = [...cases.map(ruleRecord), ...replayed.map(({ case_, reply, ms }) => armRecord(case_, "jev", reply, ms)), ...kept.rows];
  const calls = [...replayed.map(({ case_, reply }) => rawCall(case_, "jev", reply)), ...kept.calls];
  await write(paths.out, applyLabels(rows, kept.truth, kept.provenance), calls, kept.inputsSha256);
}

/** Merge labels.csv, stamped with the provenance the command line states (there is no default). */
async function label(paths: Paths, provenance: LabelProvenance): Promise<void> {
  const truth = parseTruth(await Bun.file(join(paths.out, "labels.csv")).text());
  const rows = applyLabels(parseRecords(await Bun.file(join(paths.out, "records.csv")).text()), truth, provenance);
  await Bun.write(join(paths.out, "records.csv"), formatRecords(rows));
  console.log(`labelled ${rows.filter((r) => r.label !== "").length} of ${rows.length} rows from ${truth.size} truth labels`);
}

/** JSON safe inside an inline <script>: every `<` is escaped, so data cannot close the tag or open a comment. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Fill the template's markers in one pass with a callback, so `$&` in the data and marker text in it stay literal. */
export function renderPage(template: string, factSheet: string, cases: readonly Case[]): string {
  const values: Readonly<Record<string, string>> = { __SHEET__: scriptJson(factSheet), __CASES__: scriptJson(cases) };
  return template.replace(/__SHEET__|__CASES__/g, (marker) => values[marker] ?? marker);
}

async function page(paths: Paths): Promise<void> {
  const { factSheet, cases } = await loadExample(paths.example);
  const template = await Bun.file(join(paths.example, "label.template.html")).text();
  await Bun.write(join(paths.out, "label.html"), renderPage(template, factSheet, cases));
  console.log(`wrote label.html with ${cases.length} messages`);
}

export async function main(argv: readonly string[], paths: Paths): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "run") await run(paths, args.dry, args.arm);
  else if (args.command === "replay") await replay(paths);
  else if (args.command === "label") {
    if (args.provenance === null) throw new Error(USAGE);
    await label(paths, args.provenance);
  }
  else await page(paths);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  try {
    parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  await main(argv, defaultPaths());
}
