// Exercise the decide CLI and stdio MCP server from a clean clone of a commit.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readDictRows } from "../src/format/csv.ts";

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly reason?: string;
}

export function formatCheck(check: Check): string {
  return check.ok ? `PASS ${check.name}` : `FAIL ${check.name}: ${check.reason ?? "unknown failure"}`;
}

export function summarizeChecks(checks: readonly Check[]): { readonly line: string; readonly exitCode: number } {
  const passed = checks.filter((check) => check.ok).length;
  const ok = checks.length > 0 && passed === checks.length;
  return { line: `release-check: ${ok ? "PASS" : "FAIL"} ${ok ? passed : checks.length - passed}/${checks.length}`, exitCode: ok ? 0 : 1 };
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

function argsOf(argv: readonly string[]): { repo: string; ref: string } {
  let repo = join(import.meta.dir, "..");
  let ref = "HEAD";
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--repo" && flag !== "--ref") || value === undefined || value === "" || value.startsWith("-")) {
      throw new Error("usage: bun scripts/release-check.ts [--ref <git ref>] [--repo <path or URL>]");
    }
    if (flag === "--repo") repo = value;
    else ref = value;
  }
  const localRepo = !repo.includes("://") && !repo.startsWith("git@");
  return { repo: localRepo ? resolve(repo) : repo, ref };
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

function prepareInputs(clone: string, work: string): { questions: string; cases: string; fixtures: string; records: string; invalid: string; expectedRun: ExpectedRun } {
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

async function mcpChecks(clone: string, add: (name: string, fn: () => Promise<void>) => Promise<void>): Promise<void> {
  const transport = new StdioClientTransport({ command: "bun", args: ["src/mcp/server.ts"], cwd: clone, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, stderr: "pipe" });
  const client = new Client({ name: "release-check", version: "0.1.0" });
  try {
    await client.connect(transport);
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
    await client.close();
  }
}

export async function runReleaseCheck(argv: readonly string[]): Promise<number> {
  const checks: Check[] = [];
  const add = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
    console.log(formatCheck(checks[checks.length - 1] ?? { name, ok: false }));
  };
  const finish = (): number => {
    const summary = summarizeChecks(checks);
    console.log(summary.line);
    return summary.exitCode;
  };
  let options: { repo: string; ref: string };
  try {
    options = argsOf(argv);
  } catch (error) {
    await add("arguments", () => { throw error; });
    return finish();
  }
  const work = mkdtempSync(join(tmpdir(), "jnj-release-check-"));
  const clone = join(work, "clone");
  try {
    await add("fresh clone", () => {
      const cloned = command(["git", "clone", "--no-local", "--quiet", options.repo, clone], work, {}, "fresh clone");
      expectCode(cloned, 0);
      const localRepo = !options.repo.includes("://") && !options.repo.startsWith("git@");
      const localTarget = localRepo ? command(["git", "rev-parse", "--verify", `${options.ref}^{commit}`], options.repo, {}, "local ref") : null;
      const remoteTarget = command(["git", "rev-parse", "--verify", `origin/${options.ref}^{commit}`], clone, {}, "remote ref");
      const cloneTarget = command(["git", "rev-parse", "--verify", `${options.ref}^{commit}`], clone, {}, "clone ref");
      const target = localTarget?.code === 0 ? localTarget : remoteTarget.code === 0 ? remoteTarget : cloneTarget;
      expectCode(target, 0);
      const checkedOut = command(["git", "checkout", "--quiet", "--detach", target.stdout.trim()], clone, {}, "checkout");
      expectCode(checkedOut, 0);
    });
    if (!checks.at(-1)?.ok) return finish();
    await add("frozen install", () => expectCode(command(["bun", "install", "--frozen-lockfile"], clone, {}, "frozen install", 120_000), 0));
    if (!checks.at(-1)?.ok) return finish();
    const input = prepareInputs(clone, work);
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
    try {
      await mcpChecks(clone, add);
    } catch (error) {
      await add("mcp connect", () => { throw error; });
    }
    return finish();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) runReleaseCheck(process.argv.slice(2)).then((code) => process.exit(code)).catch((error: unknown) => {
  console.log(`FAIL release check: ${error instanceof Error ? error.message : String(error)}`);
  console.log("release-check: FAIL 1/1");
  process.exit(1);
});
