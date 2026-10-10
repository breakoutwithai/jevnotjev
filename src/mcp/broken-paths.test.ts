import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DecideFetch } from "../decide/types.ts";
import { createDecideMcp } from "./server.ts";

const EXAMPLES = join(import.meta.dir, "..", "..", "examples", "d08-verdicts");
const QUESTIONS = [{ name: "q", type: "noul", instructions: "Is this useful?" }];
const CASE = { id: "c1", input: "A shop question" };
const KEY = "private-test-key";
const VERDICT_CASES: readonly (readonly [string, string, string])[] = [
  ["r1-both-zero.csv", "zero-accepted", "not enough evidence: Jev and the LLM both accepted 0 of 30 paired cases, so neither has a cost per accepted answer; check both arms' labels"],
  ["r1-jev-zero.csv", "zero-accepted", "not enough evidence: Jev accepted 0 of 30 paired cases and the LLM 1, so Jev has no cost per accepted answer; check the Jev labels"],
  ["r1-llm-zero.csv", "zero-accepted", "not enough evidence: the LLM accepted 0 of 30 paired cases and Jev 1, so the LLM has no cost per accepted answer; check the LLM labels"],
  ["r1-no-jev.csv", "no-jev-rows", "not enough evidence: no Jev results"],
  ["r1-no-llm.csv", "no-llm-rows", "not enough evidence: no LLM results"],
];

interface Answer { readonly text: string; readonly isError: boolean; readonly body: unknown }
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}
async function withClient(fetch: DecideFetch | undefined, fn: (client: Client) => Promise<void>): Promise<void> {
  const server = createDecideMcp({
    env: { JEV_API_KEY: KEY, OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY },
    ...(fetch === undefined ? {} : { deps: { fetch, which: () => null } }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "broken-path-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try { await fn(client); } finally { await client.close(); await server.close(); }
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Answer> {
  const result = await client.callTool({ name, arguments: args });
  const content: readonly unknown[] = Array.isArray(result.content) ? result.content : [];
  const text = content.map((part) => String(field(part, "text") ?? "")).join("\n");
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* An invalid input returns readable text. */ }
  expect(text).not.toMatch(/Internal error|private-test-key|(?:^|\n)\s+at \S+/);
  return { text, isError: result.isError === true, body };
}
function errorRow(body: unknown, arm: string, reason: string): void {
  const rows = field(body, "rows");
  expect(Array.isArray(rows)).toBe(true);
  if (!Array.isArray(rows)) return;
  expect(rows).toHaveLength(1);
  const row: unknown = rows[0];
  expect(field(row, "case_id")).toBe("c1");
  expect(field(row, "answerer")).toBe(arm);
  expect(field(row, "outcome")).toBe("error");
  expect(field(field(row, "evidence"), "reason")).toBe(reason);
}

test("[integration] D16-MCP-EMPTY empty records name the file as empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jnj-broken-mcp-"));
  try {
    const file = join(dir, "empty.csv");
    await withClient(undefined, async (client) => {
      writeFileSync(file, "");
      for (const tool of ["verdict", "validate"]) {
        const got = await call(client, tool, { file });
        expect(got.isError).toBe(tool === "verdict");
        if (tool === "validate") {
          expect(field(got.body, "exit_code")).toBe(1);
          expect(field(got.body, "errors")).toEqual(["the file is empty: expected a header row and data rows"]);
        } else expect(got.text).toBe(`ERROR ${file}: the file is empty: expected a header row and data rows`);
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[integration] D16-MCP-HEADER header-only records name zero data rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jnj-broken-mcp-"));
  try {
    const file = join(dir, "header.csv");
    writeFileSync(file, readFileSync(join(EXAMPLES, "r1-both-zero.csv"), "utf8").split("\n")[0] + "\n");
    await withClient(undefined, async (client) => {
      for (const tool of ["verdict", "validate"]) {
        const got = await call(client, tool, { file });
        expect(got.isError).toBe(tool === "verdict");
        if (tool === "validate") {
          expect(field(got.body, "exit_code")).toBe(1);
          expect(field(got.body, "errors")).toEqual(["file has no data rows"]);
        }
        if (tool === "verdict") expect(got.text).toBe("ERROR file has no data rows");
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[integration] D16-MCP-INVALID validate returns invalid file data without a tool error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jnj-broken-mcp-"));
  try {
    const file = join(dir, "invalid.csv");
    writeFileSync(file, "bad,header\nx,y\n");
    await withClient(undefined, async (client) => {
      const got = await call(client, "validate", { file });
      expect(got.isError).toBe(false);
      expect(field(got.body, "exit_code")).toBe(1);
      expect(field(got.body, "errors")).toEqual([
        "header: missing columns ['format_version', 'run_id', 'prompt_version', 'case_id', 'case_input', 'question_id', 'question', 'answer_set', 'answerer', 'answerer_model', 'output', 'confidence', 'label', 'label_source', 'tokens_in', 'tokens_out', 'cost_usd', 'latency_ms']",
        "header: unknown columns ['bad', 'header']",
      ]);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[integration] D16-MCP-CASES zero cases in run and estimate return named tool errors", async () => {
  await withClient(undefined, async (client) => {
    for (const tool of ["run", "estimate"]) {
      const got = await call(client, tool, { questions: QUESTIONS, cases: [], arms: { jev: true, llm: false } });
      expect(got.isError).toBe(true);
      expect(got.text).toBe(`MCP error -32602: Input validation error: Invalid arguments for tool ${tool}: no cases at cases`);
    }
  });
});

test("[integration] D16-MCP-ASK-EMPTY ask rejects a missing case with a named tool error", async () => {
  await withClient(undefined, async (client) => {
    const got = await call(client, "ask", { questions: QUESTIONS, arms: { jev: true, llm: false } });
    expect(got.isError).toBe(true);
    expect(got.text).toBe("MCP error -32602: Input validation error: Invalid arguments for tool ask: Invalid input: expected object, received undefined at case");
  });
});

for (const [name, condition, reason] of VERDICT_CASES) {
  test(`[integration] D16-MCP-VERDICT ${name} names ${condition} with exit code 4`, async () => {
    await withClient(undefined, async (client) => {
      const got = await call(client, "verdict", { file: join(EXAMPLES, name) });
      expect(field(got.body, "exit_code")).toBe(4);
      const verdicts = field(got.body, "verdicts");
      expect(Array.isArray(verdicts)).toBe(true);
      if (!Array.isArray(verdicts)) return;
      const verdict: unknown = verdicts[0];
      expect(field(verdict, "verdict")).toBe("not enough evidence");
      expect(field(verdict, "condition")).toBe(condition);
      expect(field(verdict, "reason")).toBe(reason);
    });
  });
}

test("[integration] D16-MCP-ARM ask and run reject unknown arm input", async () => {
  await withClient(undefined, async (client) => {
    for (const tool of ["ask", "run"]) {
      const args = tool === "ask" ? { questions: QUESTIONS, case: CASE, arms: { mystery: true } } : { questions: QUESTIONS, cases: [CASE], arms: { mystery: true } };
      const got = await call(client, tool, args);
      expect(got.isError).toBe(true);
      expect(got.text).toBe(`MCP error -32602: Input validation error: Invalid arguments for tool ${tool}: Unrecognized key: "mystery" at arms`);
    }
  });
});

for (const arm of ["jev", "decisions", "llm"]) {
  const statuses: readonly (readonly [number, string])[] = [
    [429, `${arm}: rate limited by the provider (HTTP 429)`],
    [503, `${arm}: provider server error (HTTP 503)`],
    [418, `${arm}: provider returned HTTP 418`],
    [0, `${arm}: provider request timed out`],
  ];
  for (const [status, reason] of statuses) {
    test(`[integration] D16-MCP-PROVIDER ${arm} ${status} gives named error rows in ask and run`, async () => {
      const fetch: DecideFetch = async () => {
        if (status === 0) throw new DOMException("Request timed out", "TimeoutError");
        return new Response(JSON.stringify({ error: KEY }), { status });
      };
      await withClient(fetch, async (client) => {
        const arms = { jev: arm === "jev", decisions: arm === "decisions", llm: arm === "llm" ? "claude-haiku-5-5" : false };
        for (const tool of ["ask", "run"]) {
          const args = tool === "ask" ? { questions: QUESTIONS, case: CASE, arms } : { questions: QUESTIONS, cases: [CASE], arms };
          const got = await call(client, tool, args);
          expect(got.isError).toBe(false);
          errorRow(got.body, arm, reason);
          expect(field(got.body, "errorReasons")).toEqual([reason]);
          expect(got.text).not.toContain(KEY);
        }
      });
    });
  }
}

const FAILURES: readonly (readonly [string, Error])[] = [["network", new TypeError("fetch failed")], ["abort", new DOMException("Aborted", "AbortError")]];
for (const [name, failure] of FAILURES) {
  test(`[integration] D16-MCP-${name.toUpperCase()} fetch failures are network errors, not timeouts`, async () => {
    const fetch: DecideFetch = async () => { throw failure; };
    await withClient(fetch, async (client) => {
      const got = await call(client, "ask", { questions: QUESTIONS, case: CASE, arms: { jev: true, llm: false } });
      expect(got.isError).toBe(false);
      errorRow(got.body, "jev", "jev: network error contacting provider");
      expect(got.text).not.toContain("timed out");
    });
  });
}
