// The decide tools as a stdio MCP server, for coding agents (Claude Code via .mcp.json or `claude mcp add`). Six tools, the
// same contract as the CLI (src/decide/cli.ts) and the core (src/decide/): arms, estimate, ask, run, verdict, validate.
//
//   bun src/mcp/server.ts
//
// This file only maps tool arguments onto the CLI's own input parsing and tool functions; it holds no decide logic.
// Questions, cases and arms are JSON arguments (the contract's shapes), not file paths; verdict and validate take a
// records file path, as the CLI does. `run` writes the jnj-record/1.2 CSV when given `out`, and returns the rows inline
// when not.
// Keys come from the server process env only, through the CLI's keysFromEnv (JEV_API_KEY, else TYPESAFE_API_KEY;
// OPENAI_API_KEY; ANTHROPIC_API_KEY), read per call, and are never in a tool argument, a result or an error.
// In fixture mode rows are stamped by the CLI's own spendTool (src/decide/fixture-stamp.ts). With no ANTHROPIC_API_KEY the llm arm uses the local claude binary.
// stdout carries MCP; the only log line is the test-only fixture NOTE, on stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { armsReport, CliInputError, providerDeps, spendTool, validateTool, verdictTool, type Env, type ToolAnswer } from "../decide/cli.ts";
import { COMMANDS, keysFromEnv, parseCase, parseCases, parseQuestions, type Parsed } from "../decide/cli-args.ts";
import { DecideError, type DecideRequest, type RunDeps } from "../decide/run.ts";
import type { Arms, Case, QuestionSpec, RunOptions } from "../decide/types.ts";

export const TOOL_NAMES: readonly string[] = COMMANDS;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const reply = (body: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(body, null, 2) }] });
const refuse = (lines: readonly string[]): ToolResult => ({ content: [{ type: "text", text: lines.map((l) => `ERROR ${l}`).join("\n") }], isError: true });

function answer(a: ToolAnswer): ToolResult {
  return a.body === null ? refuse(a.errors) : reply(a.body);
}

function must<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new CliInputError(parsed.error);
  return parsed.value;
}

// ---- argument schemas: descriptive for the caller; the CLI's parsers and the core still decide what is valid ----

const question = z.looseObject({
  name: z.string().describe("[A-Za-z0-9_-]{1,64}"),
  type: z.string().describe("noul (yes/no), choice or score"),
  instructions: z.string(),
  criteria: z.string().optional().describe("noul only"),
  choices: z.array(z.object({ name: z.string(), definition: z.string() })).optional().describe("choice only: 2 to 10"),
  levels: z.array(z.object({ label: z.string(), description: z.string() })).optional().describe("score only: 2 to 10, low to high"),
});
const caseArg = z.object({
  id: z.string().describe("[A-Za-z0-9_-]{1,64}"),
  input: z.union([z.string(), z.looseObject({ type: z.string() })]).describe("text; a non-text input is answered outcome unsupported"),
});
const rule = z.strictObject({ keywords: z.array(z.string()), match: z.string(), otherwise: z.string() });
const arms = z
  .strictObject({
    jev: z.boolean().optional(),
    decisions: z.boolean().optional(),
    llm: z.union([z.string(), z.literal(false)]).optional().describe("a pinned model id (default claude-haiku-5-5) or false"),
    rule: z.union([rule, z.literal(false)]).optional(),
  })
  .describe("defaults: jev true, decisions false, llm claude-haiku-5-5, rule false");
const options = z.strictObject({
  dryRun: z.boolean().optional().describe("price only, no provider call"),
  budgetUsd: z.number().min(0).optional().describe("stop before a call that could pass this spend; the rest are outcome error, reason budget"),
  runId: z.string().optional(),
  promptVersion: z.string().optional(),
});

type ArmsArg = z.infer<typeof arms>;
type OptionsArg = z.infer<typeof options>;

function questionsOf(raw: unknown): readonly QuestionSpec[] {
  return must(parseQuestions(JSON.stringify(raw)));
}

function casesOf(raw: unknown): readonly Case[] {
  return must(parseCases(JSON.stringify(raw), "cases.json"));
}

// zod gives optional keys as `T | undefined`; the core's types are exact optionals, so absent keys are dropped here.
function armsOf(a: ArmsArg | undefined): Arms {
  if (a === undefined) return {};
  return {
    ...(a.jev !== undefined ? { jev: a.jev } : {}),
    ...(a.decisions !== undefined ? { decisions: a.decisions } : {}),
    ...(a.llm !== undefined ? { llm: a.llm } : {}),
    ...(a.rule !== undefined ? { rule: a.rule } : {}),
  };
}

function optionsOf(o: OptionsArg | undefined): RunOptions {
  if (o === undefined) return {};
  return {
    ...(o.dryRun !== undefined ? { dryRun: o.dryRun } : {}),
    ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
    ...(o.runId !== undefined ? { runId: o.runId } : {}),
    ...(o.promptVersion !== undefined ? { promptVersion: o.promptVersion } : {}),
  };
}

function requestOf(questions: unknown, cases: readonly Case[], a: ArmsArg | undefined, o: OptionsArg | undefined): DecideRequest {
  return { questions: questionsOf(questions), cases, arms: armsOf(a), options: optionsOf(o) };
}

export interface DecideMcpOptions {
  /** The env keys are read from on every call (the server's process.env in production). */
  readonly env: Env;
  /** Test-only: provider fetch/spawn/which to use instead of the network and the claude binary. */
  readonly deps?: Pick<RunDeps, "fetch" | "spawn" | "which">;
}

export function createDecideMcp(opts: DecideMcpOptions): McpServer {
  const { env } = opts;
  const deps = async (): Promise<RunDeps> =>
    opts.deps !== undefined ? { keys: keysFromEnv(env), ...opts.deps } : providerDeps(env, { err: (line) => process.stderr.write(line + "\n") });
  const guarded = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof CliInputError || error instanceof DecideError) return refuse([error.message]);
      throw error;
    }
  };
  const server = new McpServer({ name: "jevnotjev-decide", version: "1.0.0" });

  server.registerTool(
    "arms",
    {
      description: "The arms (jev, decisions, llm, rule), their pinned models, dated prices, question types, and which key env names are set. Spends 0.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> => reply(armsReport(env)),
  );

  server.registerTool(
    "estimate",
    {
      description: "Dry-run price of asking these questions about these cases: provider calls, upper-bound cost in USD, and paired labelled cases a verdict needs. Spends 0.",
      inputSchema: z.strictObject({ questions: z.array(question).min(1), cases: z.array(caseArg).min(1), arms: arms.optional(), options: options.optional() }),
      annotations: { readOnlyHint: true },
    },
    async (a): Promise<ToolResult> => guarded(async () => answer(await spendTool("estimate", requestOf(a.questions, casesOf(a.cases), a.arms, a.options), undefined, deps, env))),
  );

  server.registerTool(
    "ask",
    {
      description: "Ask the questions about one case of the chosen arms. Returns one jnj-record/1.2 row per (question, arm) with outcome, cost and evidence; label is always empty. Spends.",
      inputSchema: z.strictObject({ questions: z.array(question).min(1), case: caseArg, arms: arms.optional(), options: options.optional() }),
      annotations: { openWorldHint: true },
    },
    async (a): Promise<ToolResult> =>
      guarded(async () => answer(await spendTool("ask", requestOf(a.questions, [must(parseCase(JSON.stringify(a.case)))], a.arms, a.options), undefined, deps, env))),
  );

  server.registerTool(
    "run",
    {
      description:
        "Ask the questions about many cases, under an optional budget cap. With `out` (a file path on the server's machine) writes the jnj-record/1.2 CSV " +
        "there and returns a summary; without `out` returns the rows inline. Spends.",
      inputSchema: z.strictObject({
        questions: z.array(question).min(1), cases: z.array(caseArg).min(1), arms: arms.optional(), options: options.optional(),
        out: z.string().min(1).optional().describe("CSV path; relative paths resolve from the server's working directory"),
      }),
      annotations: { openWorldHint: true },
    },
    async (a): Promise<ToolResult> => guarded(async () => answer(await spendTool("run", requestOf(a.questions, casesOf(a.cases), a.arms, a.options), a.out, deps, env))),
  );

  server.registerTool(
    "verdict",
    {
      description:
        "A labelled jnj-record CSV to the verdict per question and exit_code: 0 use Jev, 3 don't use Jev, 4 not enough evidence (30 paired labelled cases), 2 invalid input. Spends 0.",
      inputSchema: z.strictObject({ file: z.string().min(1), question: z.string().optional().describe("score one question id") }),
      annotations: { readOnlyHint: true },
    },
    async (a): Promise<ToolResult> => guarded(async () => answer(await verdictTool(a.file, a.question))),
  );

  server.registerTool(
    "validate",
    {
      description: "The jnj-record validator on a records file: valid, exit_code (0 valid, 1 invalid), errors, gaps. Spends 0.",
      inputSchema: z.strictObject({ file: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async (a): Promise<ToolResult> => guarded(async () => answer(await validateTool(a.file))),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createDecideMcp({ env: process.env });
  const stop = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.stdin.on("end", () => void stop());
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`ERROR ${error instanceof Error ? error.message : "server failed"}\n`);
    process.exit(1);
  });
}
