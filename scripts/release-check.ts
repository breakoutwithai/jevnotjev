// Check a release candidate from a fresh clone: frozen install, five no-provider guide steps, the decide CLI, the stdio MCP server, the served sha and docs/LIMITS.md.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readDictRows } from "../src/format/csv.ts";

export type CheckState = "PASS" | "FAIL" | "NOT RUN";

export interface Check {
  readonly name: string;
  readonly state: CheckState;
  readonly reason?: string;
}

export function formatCheck(check: Check): string {
  if (check.state === "PASS") return `PASS ${check.name}`;
  const reason = (check.reason ?? "unknown reason").replace(/[\r\n]+/g, " | ").replace(/[\u0000-\u001f\u007f]/g, "");
  return `${check.state} ${check.name}: ${reason}`;
}

export function summarizeChecks(checks: readonly Check[]): { readonly line: string; readonly exitCode: number } {
  const total = checks.length;
  const failed = checks.filter((check) => check.state === "FAIL").length;
  const notRun = checks.filter((check) => check.state === "NOT RUN").length;
  if (total === 0) return { line: "release-check: FAIL 0/0", exitCode: 1 };
  if (failed > 0) return { line: `release-check: FAIL ${failed}/${total}${notRun > 0 ? `, ${notRun} not run` : ""}`, exitCode: 1 };
  if (notRun > 0) return { line: `release-check: NOT RUN ${notRun}/${total}`, exitCode: 2 };
  return { line: `release-check: PASS ${total}/${total}`, exitCode: 0 };
}

// Guide steps that touch no provider, network or key. Every other step in docs/GUIDE.md can spend money.
export const SAFE_GUIDE_STEPS: readonly string[] = ["prepare", "question", "rule", "cases", "estimate"];

// A tripwire for the known provider and network commands, not a sandbox: a step written to evade it still runs.
// What bounds a step is the environment it gets: PATH and an empty temp HOME, no provider key.
const UNSAFE_GUIDE_PATTERNS: readonly RegExp[] = [
  /\bdecide\b(?!\s+estimate\b)/, /\bcli\.ts\b(?!\s+estimate\b)/, /\bclaude\b/, /\b(?:curl|wget|nc|bunx|npx)\b/, /\bbun\s+add\b/,
  /\bfetch\s*\(/, /node:(?:https?|net|tls)/, /_API_KEY/,
];

export interface GuideStep {
  readonly id: string;
  readonly script: string;
}

export function guideSafeScripts(text: string): readonly GuideStep[] {
  const blocks = [...text.replace(/\r\n?/g, "\n").matchAll(/```sh\n([\s\S]*?)\n```/g)].map((match): GuideStep => {
    const lines = (match[1] ?? "").split("\n");
    const id = (lines[0] ?? "").match(/^# guide: ([a-z-]+)$/)?.[1] ?? "";
    return { id, script: lines.slice(1).join("\n") };
  });
  return SAFE_GUIDE_STEPS.map((id) => {
    const found = blocks.filter((entry) => entry.id === id);
    const step = found[0];
    if (step === undefined) throw new Error(`guide step ${id} missing`);
    if (found.length > 1) throw new Error(`guide step ${id} duplicated`);
    for (const pattern of UNSAFE_GUIDE_PATTERNS) {
      const hit = step.script.match(pattern);
      if (hit !== null) throw new Error(`guide step ${id} is not safe: ${hit[0].trim()}`);
    }
    return step;
  });
}

// Input is the text of docs/LIMITS.md at the candidate commit, or undefined when the commit has no such file.
// Returns the failure reason, or undefined when the file has non-whitespace content. Reading it is a manual item.
export function limitsTextFailure(text: string | undefined): string | undefined {
  if (text === undefined) return "docs/LIMITS.md missing";
  return text.trim() === "" ? "docs/LIMITS.md is empty" : undefined;
}

export async function assertServedSha(baseUrl: string, candidateSha: string, timeoutMs = 10_000): Promise<void> {
  const base = new URL(baseUrl);
  if (base.search !== "" || base.hash !== "") throw new Error("served URL must not carry a query or fragment");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/DEPLOYED_SHA`;
  const url = base.href;
  let status = 0;
  let served = "";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    status = response.status;
    if (response.ok) served = (await response.text()).trim();
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error(`request timed out after ${timeoutMs} ms`);
    throw new Error(`network error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (status < 200 || status > 299) throw new Error(`HTTP ${status}`);
  if (!/^[0-9a-f]{40}$/i.test(served)) throw new Error("served value is not a 40-character commit SHA");
  if (served.toLowerCase() !== candidateSha.toLowerCase()) throw new Error(`served ${served}, candidate ${candidateSha}`);
}

function record(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, ...keys: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of keys) current = record(current) ? current[key] : undefined;
  return current;
}

function parsed(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

function requireValue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// The guide's estimate step is the safe sample: it makes no provider call and must describe the 30+ case run the guide asks for.
function assertGuideEstimate(stdout: string): void {
  let body: unknown;
  try {
    body = parsed(stdout);
  } catch {
    throw new Error("estimate output is not JSON");
  }
  const cases = field(body, "cases");
  const calls = field(body, "calls");
  const costUsd = field(body, "costUsd");
  requireValue(typeof cases === "number" && Number.isInteger(cases) && cases >= 30, "expected at least 30 cases");
  requireValue(typeof calls === "number" && Number.isInteger(calls) && calls > 0, "expected a positive integer calls");
  requireValue(typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0, "expected positive finite costUsd");
}

interface ExpectedRun {
  readonly caseIds: readonly string[];
  readonly arms: readonly string[];
}

export function assertReleaseOutput(name: "arms" | "estimate" | "verdict" | "fixture run", body: unknown, expected?: string | ExpectedRun, records?: string): void {
  if (name === "arms") {
    const arms = field(body, "arms");
    requireValue(Array.isArray(arms) && arms.map((entry: unknown) => field(entry, "arm")).sort().join(",") === "decisions,jev,llm,rule", "documented arms missing");
  } else if (name === "estimate") {
    requireValue(expected !== undefined && typeof expected !== "string", "expected run missing");
    const cases = expected.caseIds.length;
    const calls = cases * expected.arms.length;
    requireValue(field(body, "calls") === calls, `expected ${calls} calls`);
    requireValue(field(body, "cases") === cases, `expected ${cases} cases`);
    const costUsd = field(body, "costUsd");
    requireValue(typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0, "expected positive finite costUsd");
  } else if (name === "verdict") {
    const verdicts = field(body, "verdicts");
    requireValue(Array.isArray(verdicts) && verdicts.length === 1, "expected exactly one verdict");
    requireValue(field(verdicts[0], "verdict") === expected, "expected verdict differs");
  } else {
    requireValue(expected !== undefined && typeof expected !== "string", "expected run missing");
    const count = expected.caseIds.length * expected.arms.length;
    requireValue(field(body, "rows") === count, `expected ${count} rows`);
    const parsedRecords = readDictRows(records ?? "");
    requireValue(parsedRecords.rows.length === count, `expected ${count} record rows`);
    const outcomeIndex = parsedRecords.header?.indexOf("outcome") ?? -1;
    requireValue(outcomeIndex >= 0 && parsedRecords.rows.every((row) => row.fields[outcomeIndex] === "answered"), "expected every row answered");
    const caseIndex = parsedRecords.header?.indexOf("case_id") ?? -1;
    const armIndex = parsedRecords.header?.indexOf("answerer") ?? -1;
    const versionIndex = parsedRecords.header?.indexOf("format_version") ?? -1;
    requireValue(versionIndex >= 0 && parsedRecords.rows.every((row) => row.fields[versionIndex] === "jnj-record/1.2"), "record format differs");
    const actual = parsedRecords.rows.map((row) => JSON.stringify([row.fields[caseIndex], row.fields[armIndex]])).sort();
    const wanted = expected.caseIds.flatMap((caseId) => expected.arms.map((arm) => JSON.stringify([caseId, arm]))).sort();
    requireValue(caseIndex >= 0 && armIndex >= 0 && JSON.stringify(actual) === JSON.stringify(wanted), "case-arm set differs");
  }
}

export interface Options {
  readonly repo: string;
  readonly ref: string;
  readonly url?: string;
}

export function argsOf(argv: readonly string[]): Options {
  const usage = "usage: bun scripts/release-check.ts [--ref <git ref>] [--repo <path or URL>] [--url <http(s) base URL>]";
  let repo = join(import.meta.dir, "..");
  let ref = "HEAD";
  let url: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--repo" && flag !== "--ref" && flag !== "--url") || value === undefined || value === "" || value.startsWith("-")) throw new Error(usage);
    if (flag === "--repo") repo = value;
    else if (flag === "--ref") ref = value;
    else {
      if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol) || value.includes("?") || value.includes("#")) throw new Error(usage);
      url = value;
    }
  }
  const localRepo = !repo.includes("://") && !repo.startsWith("git@");
  return { repo: localRepo ? resolve(repo) : repo, ref, ...(url === undefined ? {} : { url }) };
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function command(argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, step: string, timeoutMs = 30_000): CommandResult {
  const result = Bun.spawnSync([...argv], { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  if (result.exitedDueToTimeout) throw new Error(`${step} timed out after ${timeoutMs} ms`);
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function expectCode(result: CommandResult, code: number): void {
  requireValue(result.code === code, `exit ${result.code}, expected ${code}: ${result.stderr.trim().slice(-400)}`);
}

function expectBody(result: CommandResult, code: number): unknown {
  expectCode(result, code);
  return parsed(result.stdout);
}

interface Inputs {
  readonly questions: string;
  readonly cases: string;
  readonly fixtures: string;
  readonly records: string;
  readonly invalid: string;
  readonly expectedRun: ExpectedRun;
}

function prepareInputs(clone: string, work: string): Inputs {
  const questions = join(work, "questions.json");
  const cases = join(work, "cases.jsonl");
  const fixtures = join(work, "fixtures.json");
  const records = join(work, "records.csv");
  const invalid = join(work, "invalid.csv");
  writeFileSync(questions, JSON.stringify([{ name: "needs_human", type: "noul", instructions: "Does this message need a person?" }]));
  const example = readFileSync(join(clone, "examples/uc13-shop-bot/cases.jsonl"), "utf8").trim().split("\n").slice(0, 2);
  const caseIds: string[] = [];
  const mapped = example.map((line) => {
    const value = parsed(line);
    const id = field(value, "case_id");
    const input = field(value, "case_input");
    requireValue(typeof id === "string" && typeof input === "string", "example case has no id or text");
    caseIds.push(id);
    return JSON.stringify({ id, input });
  });
  writeFileSync(cases, mapped.join("\n") + "\n");
  const fixture = parsed(readFileSync(join(clone, "src/decide/fixtures/m0-jev.json"), "utf8"));
  writeFileSync(fixtures, JSON.stringify({ hosts: { "api.typesafe.ai": { http: field(fixture, "http"), response: field(fixture, "response") } } }));
  const valid = readFileSync(join(clone, "examples/d08-verdicts/r3-use-jev.csv"), "utf8");
  writeFileSync(invalid, valid.replace(/^format_version,/, "broken_format_version,"));
  return { questions, cases, fixtures, records, invalid, expectedRun: { caseIds, arms: ["jev"] } };
}

export async function mcpChecks(clone: string, add: (name: string, fn: () => Promise<void>) => Promise<void>, emit: (check: Check) => void): Promise<void> {
  const transport = new StdioClientTransport({ command: "bun", args: ["src/mcp/server.ts"], cwd: clone, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, stderr: "pipe" });
  const client = new Client({ name: "release-check", version: "0.1.0" });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      const reason = `connect failed: ${error instanceof Error ? error.message : String(error)}`;
      for (const name of MCP_ITEMS) emit({ name, state: "FAIL", reason });
      return;
    }
    await add("mcp tools/list", async () => {
      const listed = await client.listTools();
      requireValue(listed.tools.map((tool) => tool.name).sort().join(",") === "arms,ask,estimate,run,validate,verdict", "six tool names differ");
    });
    for (const name of ["validate", "verdict"]) {
      await add(`mcp ${name}`, async () => {
        const result = await client.callTool({ name, arguments: { file: join(clone, "examples/d08-verdicts/r3-use-jev.csv") } });
        requireValue(result.isError !== true, "tool returned an error");
        const content = Array.isArray(result.content) ? result.content : [];
        const first = content[0];
        const body = parsed(first?.type === "text" ? first.text : "");
        requireValue(field(body, "exit_code") === 0, "tool result exit_code is not 0");
        if (name === "validate") requireValue(field(body, "valid") === true, "record was not valid");
        else assertReleaseOutput("verdict", body, "use Jev");
      });
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

export type Add = (name: string, fn: () => void | Promise<void>) => Promise<void>;

const CLI_ITEMS: readonly string[] = [
  "cli help", "cli arms", "cli estimate", "cli validate valid", "cli validate invalid",
  "cli verdict use", "cli verdict insufficient", "cli verdict reject", "cli fixture run", "cli validate fixture records",
];
const MCP_ITEMS: readonly string[] = ["mcp tools/list", "mcp validate", "mcp verdict"];

// Every item the script reports, in run order. An item that never ran is still printed, marked NOT RUN.
export const RELEASE_ITEMS: readonly string[] = [
  "fresh clone", "frozen install", ...SAFE_GUIDE_STEPS.map((id) => `guide ${id}`), ...CLI_ITEMS, ...MCP_ITEMS, "served sha", "limits text",
];

// NOT RUN lines for every item that has no result yet, naming the first failure in the reason.
export function notRunChecks(reported: readonly Check[], items: readonly string[]): readonly Check[] {
  const seen = new Set(reported.map((check) => check.name));
  const firstFail = reported.find((check) => check.state === "FAIL");
  const reason = firstFail === undefined ? "not reached" : `not reached after ${firstFail.name}`;
  return items.filter((name) => !seen.has(name)).map((name): Check => ({ name, state: "NOT RUN", reason }));
}

export async function attempt(name: string, fn: () => void | Promise<void>, emit: (check: Check) => void): Promise<void> {
  try {
    await fn();
    emit({ name, state: "PASS" });
  } catch (error) {
    emit({ name, state: "FAIL", reason: error instanceof Error ? error.message : String(error) });
  }
}

// Every step runs with an empty temp HOME created under `work`, so it sees none of the operator's files or credentials.
export async function guideChecks(clone: string, add: Add, emit: (check: Check) => void, work = dirname(clone)): Promise<void> {
  let steps: readonly GuideStep[];
  let home = "";
  try {
    steps = guideSafeScripts(readFileSync(join(clone, "docs/GUIDE.md"), "utf8"));
    home = mkdtempSync(join(work, "guide-home-"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const id of SAFE_GUIDE_STEPS) emit({ name: `guide ${id}`, state: "FAIL", reason });
    return;
  }
  const stepHome = home;
  try {
    for (const step of steps) {
      await add(`guide ${step.id}`, () => {
        const result = command(["bash", "-e", "-o", "pipefail", "-c", step.script], clone, { HOME: stepHome }, `guide ${step.id}`, 60_000);
        expectCode(result, 0);
        if (step.id === "estimate") assertGuideEstimate(result.stdout);
      });
    }
  } finally {
    rmSync(stepHome, { recursive: true, force: true });
  }
}

export async function runReleaseCheck(argv: readonly string[]): Promise<number> {
  const started = Date.now();
  const checks: Check[] = [];
  const emit = (check: Check): void => {
    checks.push(check);
    console.log(formatCheck(check));
  };
  const add: Add = (name, fn) => attempt(name, fn, emit);
  const finish = (): number => {
    for (const check of notRunChecks(checks, RELEASE_ITEMS)) emit(check);
    const summary = summarizeChecks(checks);
    console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log(summary.line);
    return summary.exitCode;
  };
  let options: Options;
  try {
    options = argsOf(argv);
  } catch (error) {
    await add("arguments", () => { throw error; });
    return finish();
  }
  const work = mkdtempSync(join(tmpdir(), "jnj-release-check-"));
  const clone = join(work, "clone");
  let candidateSha = "";
  try {
    await add("fresh clone", () => {
      const cloned = command(["git", "clone", "--no-local", "--quiet", options.repo, clone], work, {}, "fresh clone", 120_000);
      expectCode(cloned, 0);
      const localRepo = !options.repo.includes("://") && !options.repo.startsWith("git@");
      const localTarget = localRepo ? command(["git", "rev-parse", "--verify", `${options.ref}^{commit}`], options.repo, {}, "local ref") : null;
      const remoteTarget = command(["git", "rev-parse", "--verify", `origin/${options.ref}^{commit}`], clone, {}, "remote ref");
      const cloneTarget = command(["git", "rev-parse", "--verify", `${options.ref}^{commit}`], clone, {}, "clone ref");
      const target = localTarget?.code === 0 ? localTarget : remoteTarget.code === 0 ? remoteTarget : cloneTarget;
      expectCode(target, 0);
      const checkedOut = command(["git", "checkout", "--quiet", "--detach", target.stdout.trim()], clone, {}, "checkout");
      expectCode(checkedOut, 0);
      candidateSha = target.stdout.trim();
    });
    if (checks.at(-1)?.state !== "PASS") return finish();
    console.log(`candidate: ${candidateSha}`);
    await add("frozen install", () => expectCode(command(["bun", "install", "--frozen-lockfile"], clone, {}, "frozen install", 120_000), 0));
    if (checks.at(-1)?.state !== "PASS") return finish();
    await guideChecks(clone, add, emit, work);
    let input: Inputs | undefined;
    try {
      input = prepareInputs(clone, work);
    } catch (error) {
      const reason = `cli inputs: ${error instanceof Error ? error.message : String(error)}`;
      for (const name of CLI_ITEMS) emit({ name, state: "FAIL", reason });
    }
    if (input !== undefined) await cliChecks(clone, input, add);
    await mcpChecks(clone, add, emit);
    if (options.url === undefined) {
      emit({ name: "served sha", state: "NOT RUN", reason: "no --url given" });
    } else {
      const url = options.url;
      await add("served sha", () => assertServedSha(url, candidateSha));
    }
    await add("limits text", () => {
      const shown = command(["git", "show", `${candidateSha}:docs/LIMITS.md`], clone, {}, "limits text");
      const failure = limitsTextFailure(shown.code === 0 ? shown.stdout : undefined);
      if (failure !== undefined) throw new Error(failure);
    });
    return finish();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function cliChecks(clone: string, input: Inputs, add: Add): Promise<void> {
  const cli = (parts: readonly string[], env: Readonly<Record<string, string>> = {}): CommandResult => command(["bun", "run", "decide", ...parts], clone, env, `cli ${parts[0] ?? "unknown"}`);
  await add("cli help", () => {
    const result = cli(["--help"]);
    expectCode(result, 0);
    requireValue(result.stdout.includes("Usage:"), "usage missing");
  });
  await add("cli arms", () => {
    const body = expectBody(cli(["arms"]), 0);
    assertReleaseOutput("arms", body);
  });
  await add("cli estimate", () => {
    const body = expectBody(cli(["estimate", "--questions", input.questions, "--cases", input.cases, "--arms", input.expectedRun.arms.join(",")]), 0);
    assertReleaseOutput("estimate", body, input.expectedRun);
  });
  await add("cli validate valid", () => {
    const body = expectBody(cli(["validate", "examples/d08-verdicts/r3-use-jev.csv"]), 0);
    requireValue(field(body, "valid") === true, "valid result missing");
  });
  await add("cli validate invalid", () => {
    const body = expectBody(cli(["validate", input.invalid]), 1);
    requireValue(field(body, "valid") === false, "invalid result missing");
  });
  const verdicts: readonly { name: string; file: string; code: number; verdict: string }[] = [
    { name: "use", file: "r3-use-jev.csv", code: 0, verdict: "use Jev" },
    { name: "insufficient", file: "r1-29-paired.csv", code: 4, verdict: "not enough evidence" },
    { name: "reject", file: "r2-jev-worse.csv", code: 3, verdict: "don't use Jev" },
  ];
  for (const { name, file, code, verdict } of verdicts) {
    await add(`cli verdict ${name}`, () => {
      const body = expectBody(cli(["verdict", `examples/d08-verdicts/${file}`]), code);
      requireValue(field(body, "exit_code") === code, "verdict exit_code differs");
      assertReleaseOutput("verdict", body, verdict);
    });
  }
  await add("cli fixture run", () => {
    const body = expectBody(cli(["run", "--questions", input.questions, "--cases", input.cases, "--arms", input.expectedRun.arms.join(","), "--out", input.records], {
      JNJ_DECIDE_FIXTURES: input.fixtures, JEV_API_KEY: "fixture-only",
    }), 0);
    const records = readFileSync(input.records, "utf8");
    assertReleaseOutput("fixture run", body, input.expectedRun, records);
  });
  await add("cli validate fixture records", () => {
    const body = expectBody(cli(["validate", input.records]), 0);
    requireValue(field(body, "valid") === true, "fixture records invalid");
  });
}

if (import.meta.main) runReleaseCheck(process.argv.slice(2)).then((code) => process.exit(code)).catch((error: unknown) => {
  console.log(`FAIL release check: ${error instanceof Error ? error.message : String(error)}`);
  console.log("release-check: FAIL 1/1");
  process.exit(1);
});
