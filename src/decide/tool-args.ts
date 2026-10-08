// The decide tools' JSON arguments, shared by the MCP server (src/mcp/server.ts) and the HTTP API (src/backstage/api-v1.ts).
// The zod schemas describe the shapes for the caller; the CLI's own parsers (cli-args.ts) and the core still decide what
// is valid, so a request means the same thing on every surface.
import { z } from "zod";
import { CliInputError } from "./cli.ts";
import { parseCase, parseCases, parseQuestions, type Parsed } from "./cli-args.ts";
import type { DecideRequest } from "./run.ts";
import type { Arms, Case, QuestionSpec, RunOptions } from "./types.ts";

export function must<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new CliInputError(parsed.error);
  return parsed.value;
}

export const questionArg = z.looseObject({
  name: z.string().describe("[A-Za-z0-9_-]{1,64}"),
  type: z.string().describe("noul (yes/no), choice or score"),
  instructions: z.string(),
  criteria: z.string().optional().describe("noul only"),
  choices: z.array(z.object({ name: z.string(), definition: z.string() })).optional().describe("choice only: 2 to 10"),
  levels: z.array(z.object({ label: z.string(), description: z.string() })).optional().describe("score only: 2 to 10, low to high"),
});
export const caseArg = z.object({
  id: z.string().describe("[A-Za-z0-9_-]{1,64}"),
  input: z.union([z.string(), z.looseObject({ type: z.string() })]).describe("text; a non-text input is answered outcome unsupported"),
});
const ruleArg = z.strictObject({ keywords: z.array(z.string()), match: z.string(), otherwise: z.string() });
export const armsArg = z
  .strictObject({
    jev: z.boolean().optional(),
    decisions: z.boolean().optional(),
    llm: z.union([z.string(), z.literal(false)]).optional().describe("a pinned model id (default claude-haiku-5-5) or false"),
    rule: z.union([ruleArg, z.literal(false)]).optional(),
  })
  .describe("defaults: jev true, decisions false, llm claude-haiku-5-5, rule false");
export const optionsArg = z.strictObject({
  dryRun: z.boolean().optional().describe("price only, no provider call"),
  budgetUsd: z.number().min(0).optional().describe("stop before a call that could pass this spend; the rest are outcome error, reason budget"),
  runId: z.string().optional(),
  promptVersion: z.string().optional(),
});

export type ArmsArg = z.infer<typeof armsArg>;
export type OptionsArg = z.infer<typeof optionsArg>;

export function questionsOf(raw: unknown): readonly QuestionSpec[] {
  return must(parseQuestions(JSON.stringify(raw)));
}

export function casesOf(raw: unknown): readonly Case[] {
  return must(parseCases(JSON.stringify(raw), "cases.json"));
}

export function caseOf(raw: unknown): Case {
  return must(parseCase(JSON.stringify(raw)));
}

// zod gives optional keys as `T | undefined`; the core's types are exact optionals, so absent keys are dropped here.
export function armsOf(a: ArmsArg | undefined): Arms {
  if (a === undefined) return {};
  return {
    ...(a.jev !== undefined ? { jev: a.jev } : {}),
    ...(a.decisions !== undefined ? { decisions: a.decisions } : {}),
    ...(a.llm !== undefined ? { llm: a.llm } : {}),
    ...(a.rule !== undefined ? { rule: a.rule } : {}),
  };
}

export function optionsOf(o: OptionsArg | undefined): RunOptions {
  if (o === undefined) return {};
  return {
    ...(o.dryRun !== undefined ? { dryRun: o.dryRun } : {}),
    ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
    ...(o.runId !== undefined ? { runId: o.runId } : {}),
    ...(o.promptVersion !== undefined ? { promptVersion: o.promptVersion } : {}),
  };
}

export function requestOf(questions: unknown, cases: readonly Case[], a: ArmsArg | undefined, o: OptionsArg | undefined): DecideRequest {
  return { questions: questionsOf(questions), cases, arms: armsOf(a), options: optionsOf(o) };
}
