// The llm arm: Claude Haiku 5.5 asked for a JSON-only reply, through one of two transports.
//   messages-api: HTTPS to the Messages API with the caller's key. No temperature/top_p/top_k (Haiku 5.5 rejects them),
//                 no assistant prefill; text blocks are selected by type, so thinking blocks are skipped.
//   claude-cli:   the local `claude` binary, prompt on stdin, lean flags (measured 2026-10-08: without them the CLI adds
//                 about 146k context tokens per call). Used when no key is supplied and the binary is on PATH.
// stop_reason "refusal" is outcome refused; a reply outside answer_set is outcome error, never a wrong answer.
import { answerNames, questionText } from "./questions.ts";
import type { CallResult, QuestionResult, QuestionSpec } from "./types.ts";

export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const LLM_MAX_TOKENS = 1024;
export const LLM_SYSTEM = "You answer typed questions about a case. Reply with one JSON object only: no prose, no code fence.";

export type LlmTransport = "messages-api" | "claude-cli";
export const LLM_TRANSPORTS: readonly LlmTransport[] = ["messages-api", "claude-cli"];
export const CLI_COST_BASIS = "claude-cli list price (subscription)";

export interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Runs argv with `stdin` on standard input; the real one runs it from an empty temp directory. */
export type DecideSpawn = (argv: readonly string[], stdin: string) => Promise<SpawnResult>;

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeQuestion(q: QuestionSpec): string {
  const text = questionText(q).replace(/\s+/g, " ");
  if (q.type === "noul") return `${q.name}: ${text}`;
  if (q.type === "choice") return `${q.name}: ${text} ${q.choices.map((c) => `${c.name} = ${c.definition}`).join("; ")}.`;
  return `${q.name}: ${text} ${q.levels.map((l) => `${l.label} = ${l.description}`).join("; ")}.`;
}

/** The user message: the case, the exact reply shape, then each question. */
export function llmPrompt(text: string, questions: readonly QuestionSpec[]): string {
  const shape = questions.map((q) => `${JSON.stringify(q.name)}:${answerNames(q).map((n) => JSON.stringify(n)).join("|")}`).join(",");
  return [
    `Case: ${JSON.stringify(text)}`,
    `Answer ${questions.length} question${questions.length === 1 ? "" : "s"}. Reply with JSON only, no prose, exactly this shape:`,
    `{${shape}}`,
    ...questions.map(describeQuestion),
    "",
  ].join("\n");
}

export function messagesBody(model: string, text: string, questions: readonly QuestionSpec[]): Record<string, unknown> {
  return { model, max_tokens: LLM_MAX_TOKENS, system: LLM_SYSTEM, messages: [{ role: "user", content: llmPrompt(text, questions) }] };
}

export function messagesHeaders(key: string): Record<string, string> {
  return { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
}

/** argv for the claude-cli transport; the prompt goes on stdin. `--bare` is not used: it requires ANTHROPIC_API_KEY. */
export function cliArgv(binary: string, model: string): string[] {
  return [
    binary, "-p", "--model", model, "--output-format", "stream-json", "--verbose", "--tools", "", "--setting-sources", "",
    "--strict-mcp-config", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections", "--no-session-persistence",
    "--system-prompt", LLM_SYSTEM,
  ];
}

function error(reason: string): QuestionResult {
  return { outcome: "error", output: null, confidence: null, reason };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Text blocks only, in order; thinking and any other block type are skipped. */
export function replyText(message: unknown): string {
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
  return content
    .filter((b: unknown) => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b: unknown) => (isRecord(b) && typeof b.text === "string" ? b.text : ""))
    .join("");
}

function parseReply(text: string): Readonly<Record<string, unknown>> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** One reply text and stop reason to per-question results. */
export function answersFrom(text: string, stopReason: unknown, questions: readonly QuestionSpec[]): QuestionResult[] {
  if (stopReason === "refusal") return questions.map(() => ({ outcome: "refused", output: null, confidence: null, reason: "stop_reason refusal" }));
  if (stopReason === "max_tokens") return questions.map(() => error("stop_reason max_tokens"));
  const reply = parseReply(text);
  if (reply === null) return questions.map(() => error("reply is not a JSON object"));
  return questions.map((q): QuestionResult => {
    const value = reply[q.name];
    if (value === undefined) return error("reply missing question");
    if (typeof value !== "string" || !answerNames(q).includes(value)) return error("reply outside answer_set");
    return { outcome: "answered", output: value, confidence: null };
  });
}

export function parseMessages(http: number, response: unknown, questions: readonly QuestionSpec[]): CallResult {
  const u = isRecord(response) && isRecord(response.usage) ? response.usage : {};
  const tokensIn = count(u.input_tokens);
  const tokensOut = count(u.output_tokens);
  if (http < 200 || http > 299) return { http, tokensIn, tokensOut, results: questions.map(() => error(`http ${http}`)) };
  const stop = isRecord(response) ? response.stop_reason : undefined;
  return { http, tokensIn, tokensOut, results: answersFrom(replyText(response), stop, questions) };
}

export interface CliResult extends CallResult {
  /** total_cost_usd from the result event, or null when absent. */
  readonly costUsd: number | null;
}

/**
 * Parse stream-json output. The assistant event's message is Messages-shaped, but its stop_reason is null in the stream;
 * the final stop_reason, total_cost_usd and modelUsage come from the result event.
 */
export function parseCli(spawned: SpawnResult, model: string, questions: readonly QuestionSpec[]): CliResult {
  let message: unknown;
  let result: Readonly<Record<string, unknown>> | undefined;
  for (const line of spawned.stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "assistant") message = event.message;
    else if (event.type === "result") result = event;
  }
  const fail = (reason: string): CliResult => ({ http: 0, tokensIn: null, tokensOut: null, costUsd: null, results: questions.map(() => error(reason)) });
  if (result === undefined) return fail(spawned.exitCode === 0 ? "claude-cli gave no result event" : `claude-cli exit ${spawned.exitCode}`);
  const usage = isRecord(result.modelUsage) && isRecord(result.modelUsage[model]) ? result.modelUsage[model] : undefined;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  if (isRecord(usage)) {
    const parts = [usage.inputTokens, usage.cacheCreationInputTokens, usage.cacheReadInputTokens].map(count);
    tokensIn = parts.every((p) => p !== null) ? parts.reduce<number>((s, p) => s + (p ?? 0), 0) : null;
    tokensOut = count(usage.outputTokens);
  }
  const cost = result.total_cost_usd;
  const costUsd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
  if (result.is_error === true || spawned.exitCode !== 0) {
    return { http: 0, tokensIn, tokensOut, costUsd, results: questions.map(() => error(`claude-cli exit ${spawned.exitCode}`)) };
  }
  if (usage === undefined) return { http: 0, tokensIn, tokensOut, costUsd, results: questions.map(() => error(`claude-cli answered with a model other than ${model}`)) };
  return { http: 0, tokensIn, tokensOut, costUsd, results: answersFrom(replyText(message), result.stop_reason, questions) };
}
