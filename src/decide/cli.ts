// The decide command line: six subcommands over the src/decide core, JSON on stdout, errors on stderr.
//
//   bun src/decide/cli.ts arms
//   bun src/decide/cli.ts estimate --questions <q.json> --cases <cases.jsonl> [arm and run flags]
//   bun src/decide/cli.ts ask      --questions <q.json> (--case <case.json> | --input <text> [--case-id <id>]) [flags] [--dry-run]
//   bun src/decide/cli.ts run      --questions <q.json> --cases <cases.jsonl> --out <records.csv> [flags] [--dry-run]
//   bun src/decide/cli.ts verdict  <labelled.csv> [--question <id>]
//   bun src/decide/cli.ts validate <records.csv>
//
// Keys come from the caller's env only (JEV_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY) and are never printed or written.
// With no ANTHROPIC_API_KEY the llm arm uses the local claude binary (the core's claude-cli transport).
// Exit codes: verdict 0 use Jev, 3 don't use Jev, 4 not enough evidence, 2 invalid input. validate keeps the validator's
// 0 valid, 1 invalid, 2 usage. The other subcommands: 0 done, 2 invalid input or usage, 1 could not write --out.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileSeed } from "../core/calc.ts";
import { groupCohorts, metricsOfCohortRows } from "../core/metrics.ts";
import { MIN_PAIRED, verdict, type Verdict } from "../core/verdict.ts";
import { decodeUtf8, report, validate } from "../format/validate.ts";
import {
  FIXTURES_ENV, KEY_ENV, parseArgs, parseCase, parseCases, parseFixtures, parseQuestions, parseRule, toArms, keysFromEnv,
  type FixtureSet, type Parsed, type SpendCommand,
} from "./cli-args.ts";
import { whichClaude } from "./cli-spawn.ts";
import { LLM_TRANSPORTS, type DecideSpawn } from "./llm.ts";
import { PRICE_TABLE, PRICE_TABLE_DATE } from "./prices.ts";
import { RULE_MODEL } from "./rule.ts";
import { rowsToCsv } from "./rows.ts";
import { DEFAULT_LLM, DEFAULT_PROMPT_VERSION, DEFAULT_RUN_ID, DecideError, estimate, run, type RunDeps } from "./run.ts";
import type { Case, DecideFetch, ProviderKeys, RuleArm } from "./types.ts";

export const EXIT = { ok: 0, useJev: 0, failure: 1, invalid: 2, dontUseJev: 3, notEnoughEvidence: 4 } satisfies Record<string, number>;

export const USAGE = `Jev!Jev decide: ask typed questions of Jev, the Decisions API, an LLM and a rule; price, run, verdict.

Usage: bun src/decide/cli.ts <command> [flags]
  arms                                       arms, models, dated prices, question types (spends 0)
  estimate --questions F --cases F           dry-run price and cases needed for a verdict (spends 0)
  ask      --questions F (--case F | --input TEXT [--case-id ID])   one case (spends)
  run      --questions F --cases F --out F   many cases; writes jnj-record/1.2 CSV (spends)
  verdict  FILE [--question ID]              labelled records to verdict and exit code (spends 0)
  validate FILE                              the record validator (spends 0)
Arm and run flags: --arms jev,decisions,llm,rule  --llm-model ID  --rule F  --budget USD  --dry-run  --run-id ID  --prompt-version V
Keys from env only: ${KEY_ENV.jev}, ${KEY_ENV.openai}, ${KEY_ENV.anthropic}. No ${KEY_ENV.anthropic}: the llm arm uses the local claude binary.
Exit: verdict 0 use Jev, 3 don't use Jev, 4 not enough evidence, 2 invalid input; validate 0 valid, 1 invalid, 2 usage.
Docs: docs/api.md`;

export interface Io {
  readonly out: (text: string) => void;
  readonly err: (line: string) => void;
}

export type Env = Readonly<Record<string, string | undefined>>;

class CliInputError extends Error {}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function must<T>(parsed: Parsed<T>, file: string): T {
  if (!parsed.ok) throw new CliInputError(`${file}: ${parsed.error}`);
  return parsed.value;
}

async function readText(path: string): Promise<string> {
  try {
    return decodeUtf8(await Bun.file(path).bytes());
  } catch (error) {
    throw new CliInputError(`cannot read ${path} as UTF-8: ${error instanceof Error ? error.message : "read failed"}`);
  }
}

/** Test-only provider deps: every call answered from the fixture file, 401 when the request carries no key. */
export function fixtureDeps(set: FixtureSet): Pick<RunDeps, "fetch" | "spawn" | "which"> {
  const fetch: DecideFetch = async (url, init) => {
    const fx = set.hosts[new URL(url).host];
    if (fx === undefined) throw new Error("no fixture for this host");
    const keyed = [init.headers.authorization, init.headers["x-api-key"]].some((v) => v !== undefined && v !== "" && v !== "Bearer ");
    if (!keyed) return new Response(JSON.stringify({ error: "no key" }), { status: 401 });
    return new Response(JSON.stringify(fx.response), { status: fx.http, headers: { "content-type": "application/json" } });
  };
  const cli = set.cli;
  const spawn: DecideSpawn = async () => {
    if (cli === null) throw new Error("no cli fixture");
    return { exitCode: cli.exitCode, stdout: cli.stdout };
  };
  return { fetch, spawn, which: () => (cli === null ? null : "claude") };
}

async function providerDeps(env: Env, io: Io): Promise<RunDeps> {
  const keys: ProviderKeys = keysFromEnv(env);
  const fixturePath = env[FIXTURES_ENV];
  if (fixturePath === undefined || fixturePath === "") return { keys };
  io.err(`NOTE ${FIXTURES_ENV} is set: test-only fixture mode, no provider is called`);
  const set = must(parseFixtures(await readText(fixturePath)), FIXTURES_ENV);
  return { keys, ...fixtureDeps(set) };
}

function armsReport(env: Env): unknown {
  const keySet = (name: string): boolean => (env[name] ?? "") !== "";
  const fixtureMode = (env[FIXTURES_ENV] ?? "") !== "";
  const models = (arm: string): unknown[] =>
    PRICE_TABLE.filter((p) => p.arm === arm).map((p) => ({
      model: p.model,
      inputUsdPerMTok: p.inputUsdPerMTok,
      outputUsdPerMTok: p.outputUsdPerMTok,
      ...(p.longPromptTokens !== undefined ? { longPromptTokens: p.longPromptTokens, longInputUsdPerMTok: p.longInputUsdPerMTok, longOutputUsdPerMTok: p.longOutputUsdPerMTok } : {}),
      readDate: p.readDate,
      source: p.source,
    }));
  const llmTransport = keySet(KEY_ENV.anthropic) ? "messages-api" : !fixtureMode && whichClaude() !== null ? "claude-cli" : null;
  return {
    priceTableDate: PRICE_TABLE_DATE,
    types: ["noul", "choice", "score"],
    defaults: { jev: true, decisions: false, llm: DEFAULT_LLM, rule: false, runId: DEFAULT_RUN_ID, promptVersion: DEFAULT_PROMPT_VERSION },
    casesForVerdict: MIN_PAIRED,
    arms: [
      { arm: "jev", default: true, keyEnv: KEY_ENV.jev, keySet: keySet(KEY_ENV.jev), models: models("jev") },
      { arm: "decisions", default: false, keyEnv: KEY_ENV.openai, keySet: keySet(KEY_ENV.openai), models: models("decisions") },
      {
        arm: "llm", default: true, keyEnv: KEY_ENV.anthropic, keySet: keySet(KEY_ENV.anthropic), models: models("llm"),
        transports: LLM_TRANSPORTS, transportNow: llmTransport,
      },
      { arm: "rule", default: false, keyEnv: null, keySet: false, models: [{ model: RULE_MODEL, inputUsdPerMTok: 0, outputUsdPerMTok: 0 }], types: ["choice (2 options)"] },
    ],
    exitCodes: { verdict: { useJev: 0, dontUseJev: 3, notEnoughEvidence: 4, invalidInput: 2 }, validate: { valid: 0, invalid: 1, usage: 2 } },
  };
}

interface SpendInput {
  readonly cases: readonly Case[];
  readonly request: Parameters<typeof estimate>[0];
}

async function spendInput(c: SpendCommand): Promise<SpendInput> {
  const questions = must(parseQuestions(await readText(c.questions)), c.questions);
  let cases: readonly Case[];
  if (c.cases !== undefined) cases = must(parseCases(await readText(c.cases), c.cases), c.cases);
  else if (c.casePath !== undefined) cases = [must(parseCase(await readText(c.casePath)), c.casePath)];
  else cases = [{ id: c.caseId ?? "case-1", input: c.input ?? "" }];
  const rule: RuleArm | null = c.rulePath === undefined ? null : must(parseRule(await readText(c.rulePath)), c.rulePath);
  const options = {
    ...(c.dryRun ? { dryRun: true } : {}),
    ...(c.budgetUsd !== undefined ? { budgetUsd: c.budgetUsd } : {}),
    ...(c.runId !== undefined ? { runId: c.runId } : {}),
    ...(c.promptVersion !== undefined ? { promptVersion: c.promptVersion } : {}),
  };
  return { cases, request: { cases, questions, arms: toArms(c, rule), options } };
}

async function spend(c: SpendCommand, io: Io, env: Env): Promise<number> {
  const { request } = await spendInput(c);
  if (c.cmd === "estimate") {
    io.out(json(estimate(request)));
    return EXIT.ok;
  }
  if (c.dryRun) {
    io.out(json({ dryRun: true, calls: 0, spentUsd: 0, estimate: estimate(request) }));
    return EXIT.ok;
  }
  estimate(request); // reject bad input before any key or fixture is read
  const result = await run(request, await providerDeps(env, io));
  const summary = { calls: result.calls, spentUsd: result.spentUsd, stoppedByBudget: result.stoppedByBudget, budgetNote: result.budgetNote, counts: result.counts, estimate: result.estimate };
  if (c.cmd === "ask") {
    io.out(json({ rows: result.rows, ...summary }));
    return EXIT.ok;
  }
  const out = c.out ?? "";
  try {
    await mkdir(dirname(out), { recursive: true });
    await Bun.write(out, rowsToCsv(result.rows));
  } catch (error) {
    io.err(`ERROR cannot write ${out}: ${error instanceof Error ? error.message : "write failed"}`);
    return EXIT.failure;
  }
  io.out(json({ out, rows: result.rows.length, ...summary }));
  return EXIT.ok;
}

function exitFor(verdicts: readonly Verdict[]): number {
  if (verdicts.some((v) => v.verdict === "don't use Jev")) return EXIT.dontUseJev;
  if (verdicts.some((v) => v.verdict === "not enough evidence")) return EXIT.notEnoughEvidence;
  return EXIT.useJev;
}

async function verdictCommand(file: string, question: string | undefined, io: Io): Promise<number> {
  const text = await readText(file);
  const result = validate(text);
  if (result.errors.length > 0) {
    for (const e of result.errors) io.err(`ERROR ${e}`);
    return EXIT.invalid;
  }
  const groups = groupCohorts(result.rows).filter((g) => question === undefined || g.key.questionId === question);
  if (groups.length === 0) throw new CliInputError(question === undefined ? `${file}: no rows` : `${file}: no rows for question ${question}`);
  const seed = await fileSeed(text);
  const verdicts = groups.map((g) => ({ key: g.key, v: verdict(metricsOfCohortRows(g.rows, g.key), seed) }));
  const code = exitFor(verdicts.map((x) => x.v));
  io.out(json({
    exit_code: code,
    verdicts: verdicts.map(({ key, v }) => ({
      run_id: key.runId, prompt_version: key.promptVersion, question_id: key.questionId,
      verdict: v.verdict, rule: v.rule, condition: v.condition, unmet: v.unmet, reason: v.reason, addN: v.addN,
      limitations: v.limitations, numbers: v.numbers, ruleComparison: v.ruleComparison,
    })),
  }));
  return code;
}

async function validateCommand(file: string, io: Io): Promise<number> {
  let text: string;
  try {
    text = await readText(file);
  } catch (error) {
    io.err(`ERROR ${error instanceof Error ? error.message : "read failed"}`);
    return 1;
  }
  const result = validate(text);
  const { lines, exitCode } = report(result);
  for (const e of result.errors) io.err(`ERROR ${e}`);
  io.out(json({ valid: exitCode === 0, exit_code: exitCode, errors: result.errors, gaps: result.gaps, summary: lines.at(-1) ?? "", lines }));
  return exitCode;
}

export async function main(argv: readonly string[], io: Io, env: Env): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.err(`ERROR ${parsed.error}`);
    io.err(USAGE);
    return EXIT.invalid;
  }
  const c = parsed.value;
  try {
    switch (c.cmd) {
      case "help":
        io.out(USAGE + "\n");
        return EXIT.ok;
      case "arms":
        io.out(json(armsReport(env)));
        return EXIT.ok;
      case "verdict":
        return await verdictCommand(c.file, c.question, io);
      case "validate":
        return await validateCommand(c.file, io);
      default:
        return await spend(c, io, env);
    }
  } catch (error) {
    if (error instanceof CliInputError || error instanceof DecideError) {
      io.err(`ERROR ${error.message}`);
      return EXIT.invalid;
    }
    if (c.cmd === "verdict" && error instanceof Error) {
      io.err(`ERROR ${error.message}`);
      return EXIT.invalid;
    }
    throw error;
  }
}

if (import.meta.main) {
  const code = await main(Bun.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (line) => process.stderr.write(line + "\n"),
  }, process.env);
  process.exit(code);
}
