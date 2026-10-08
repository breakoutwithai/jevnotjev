// src/mcp/server.ts (M4 of the API/MCP work): the six decide tools over stdio MCP, and the canary key.
// The stdio tests spawn the real server and talk to it with the SDK's own client. Provider answers come from the recorded
// fixtures in src/decide/fixtures through the test-only JNJ_DECIDE_FIXTURES file, the same injection the CLI uses; no test
// calls a provider or starts a real claude binary.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { validate } from "../format/validate.ts";
import { FIXTURES_ENV } from "../decide/cli-args.ts";
import type { DecideFetch } from "../decide/types.ts";
import { createDecideMcp, TOOL_NAMES } from "./server.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SERVER = join(ROOT, "src", "mcp", "server.ts");
const FX = join(ROOT, "src", "decide", "fixtures");
const SIX = ["arms", "ask", "estimate", "run", "validate", "verdict"];

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  let at: unknown = value;
  for (const key of path) {
    if (typeof key === "number") at = Array.isArray(at) ? at[key] : undefined;
    else at = isRecord(at) ? at[key] : undefined;
  }
  return at;
}

function json(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

// The three M0 questions, the shape the recorded fixtures answer.
const QUESTIONS = [
  { name: "needs_human", type: "noul", instructions: "Does answering this shop message need a person to check live stock, a booking or a policy?" },
  {
    name: "topic",
    type: "choice",
    instructions: "What is this shop message mainly about?",
    choices: [
      { name: "stock", definition: "Whether an item or size is available." },
      { name: "price", definition: "What something costs." },
      { name: "other", definition: "Anything else." },
    ],
  },
  {
    name: "urgency",
    type: "score",
    instructions: "How urgent is this shop message?",
    levels: [
      { label: "Not urgent", description: "General question." },
      { label: "Somewhat urgent", description: "Wants an answer today." },
      { label: "Very urgent", description: "Safety, injury or a booking about to start." },
    ],
  },
];
const M0_TEXT = "Do you have women's boots in size 6?";
const ALL_ARMS = { jev: true, decisions: true, llm: "claude-haiku-5-5" };

interface Called {
  readonly text: string;
  readonly isError: boolean;
  readonly body: unknown;
}

/** One tool call; the result's text blocks joined, parsed as JSON when they are JSON. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((c: unknown) => (typeof field(c, "text") === "string" ? String(field(c, "text")) : "")).join("\n");
  let body: unknown = null;
  try {
    body = json(text);
  } catch {
    body = null;
  }
  return { text, isError: result.isError === true, body };
}

interface Spawned {
  readonly client: Client;
  readonly stderr: () => string;
  readonly close: () => Promise<void>;
}

/** Start the real server over stdio with exactly this env (the SDK adds its default PATH, HOME, USER, SHELL, TERM). */
async function spawnServer(env: Readonly<Record<string, string>>, cwd: string): Promise<Spawned> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...env }, cwd, stderr: "pipe" });
  let err = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  const client = new Client({ name: "server-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => err, close: () => client.close() };
}

function fixtureFile(dir: string): string {
  const response = (name: string): unknown => {
    const raw = json(readFileSync(join(FX, name), "utf8"));
    return { http: field(raw, "http"), response: field(raw, "response") };
  };
  const path = join(dir, "fixtures.json");
  writeFileSync(path, JSON.stringify({
    hosts: {
      "api.typesafe.ai": response("m0-jev.json"),
      "api.openai.com": response("m0-decisions.json"),
      "api.anthropic.com": response("m0-llm.UNVERIFIED.json"),
    },
    cli: { stdout: readFileSync(join(FX, "m0-llm-cli.jsonl"), "utf8"), exitCode: 0 },
  }));
  return path;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("tools", () => {
  test("[integration] MCP-TOOLS a stdio client lists exactly the six tools and estimate prices a run (m5 == 6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-mcp-tools-"));
    // A fixture path that does not exist: any provider path taken by estimate would fail on reading it.
    const server = await spawnServer({ [FIXTURES_ENV]: join(dir, "no-such-fixtures.json") }, dir);
    try {
      const listed = await server.client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual(SIX);
      expect([...TOOL_NAMES].sort()).toEqual(SIX);
      const est = await call(server.client, "estimate", { questions: QUESTIONS, cases: [{ id: "m04", input: M0_TEXT }], arms: ALL_ARMS });
      expect(est.isError).toBe(false);
      expect(field(est.body, "calls")).toBe(3);
      const cost = field(est.body, "costUsd");
      expect(typeof cost === "number" && cost > 0).toBe(true);
      expect(field(est.body, "priceTableDate")).toBe("2026-10-08");
      expect(field(est.body, "casesForVerdict")).toBe(30);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[integration] MCP-ESTIMATE-0 estimate and a dry-run ask make zero provider calls (counted fetch and spawn)", async () => {
    let calls = 0;
    const fetch: DecideFetch = async () => {
      calls += 1;
      return new Response("{}", { status: 500 });
    };
    const server = createDecideMcp({
      env: { JEV_API_KEY: "k", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" },
      deps: { fetch, spawn: async () => { calls += 1; return { exitCode: 1, stdout: "" }; }, which: () => "claude" },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "server-test", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const est = await call(client, "estimate", { questions: QUESTIONS, cases: [{ id: "a", input: M0_TEXT }, { id: "b", input: M0_TEXT }], arms: ALL_ARMS });
      expect(est.isError).toBe(false);
      expect(field(est.body, "calls")).toBe(6);
      const dry = await call(client, "ask", { questions: QUESTIONS, case: { id: "a", input: M0_TEXT }, arms: ALL_ARMS, options: { dryRun: true } });
      expect(dry.isError).toBe(false);
      expect(field(dry.body, "calls")).toBe(0);
      expect(field(dry.body, "dryRun")).toBe(true);
      expect(calls).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("[integration] MCP-BADINPUT a bad question or a floating model id is a tool error naming the fix", async () => {
    const server = createDecideMcp({ env: {} });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "server-test", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const floating = await call(client, "estimate", { questions: QUESTIONS, cases: [{ id: "a", input: M0_TEXT }], arms: { llm: "claude-haiku-latest" } });
      expect(floating.isError).toBe(true);
      expect(floating.text).toContain("claude-haiku-5-5");
      const bad = await call(client, "estimate", { questions: [{ name: "q", type: "maybe", instructions: "?" }], cases: [{ id: "a", input: M0_TEXT }] });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("noul, choice or score");
    } finally {
      await client.close();
    }
  });
});

describe("fixture mode", () => {
  test("[integration] MCP-STAMP fixture-mode results carry the replay stamp; TYPESAFE_API_KEY stands in for JEV_API_KEY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-mcp-stamp-"));
    const fixtures = fixtureFile(dir);
    // Only the fallback name is set: the jev arm answers only if the server resolved it (the fixture fetch 401s a keyless call).
    const server = await spawnServer({ TYPESAFE_API_KEY: "fallback-key", [FIXTURES_ENV]: fixtures }, dir);
    try {
      const asked = await call(server.client, "ask", { questions: QUESTIONS, case: { id: "m04", input: M0_TEXT }, arms: { jev: true, llm: false }, options: { runId: "shop-001" } });
      const rows = field(asked.body, "rows");
      const list = Array.isArray(rows) ? rows : [];
      expect(list).toHaveLength(3);
      for (const row of list) {
        expect(field(row, "outcome")).toBe("answered");
        expect(field(row, "run_id")).toBe("shop-001-fixture");
        expect(field(row, "evidence", "replayed_fixture")).toBe(true);
      }
      const armsBody = await call(server.client, "arms");
      expect(field(armsBody.body, "arms", 0, "keySet")).toBe(true);
      const out = join(dir, "out", "r.csv");
      const ran = await call(server.client, "run", { questions: QUESTIONS, cases: [{ id: "m04", input: M0_TEXT }], arms: { jev: true, llm: false }, out });
      expect(ran.isError).toBe(false);
      expect(readFileSync(out, "utf8")).toContain("run-001-fixture");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("canary key", () => {
  test("[integration] KEY-CANARY-MCP a canary key in the server env reaches no tool result, stderr or written file (m3 == 0)", async () => {
    const canary = `sk-canary-${crypto.randomUUID().replaceAll("-", "")}`;
    const dir = mkdtempSync(join(tmpdir(), "jnj-mcp-canary-"));
    const outDir = join(dir, "out");
    const fixtures = fixtureFile(dir);
    const allKeys = { JEV_API_KEY: canary, OPENAI_API_KEY: canary, ANTHROPIC_API_KEY: canary, [FIXTURES_ENV]: fixtures };
    const noAnthropic = { JEV_API_KEY: canary, OPENAI_API_KEY: canary, [FIXTURES_ENV]: fixtures };
    const keyed = await spawnServer(allKeys, dir);
    const cliOnly = await spawnServer(noAnthropic, dir);
    const results: Called[] = [];
    try {
      const cases = [{ id: "m04", input: M0_TEXT }, { id: "m05", input: M0_TEXT }];
      const k = keyed.client;
      results.push(await call(k, "arms"));
      results.push(await call(k, "estimate", { questions: QUESTIONS, cases, arms: ALL_ARMS }));
      results.push(await call(k, "ask", { questions: QUESTIONS, case: cases[0], arms: ALL_ARMS }));
      results.push(await call(k, "run", { questions: QUESTIONS, cases, arms: ALL_ARMS, out: join(outDir, "api.csv") }));
      results.push(await call(k, "run", { questions: QUESTIONS, cases, arms: ALL_ARMS }));
      results.push(await call(k, "run", { questions: QUESTIONS, cases, options: { budgetUsd: 0 }, out: join(outDir, "capped.csv") }));
      results.push(await call(k, "ask", { questions: QUESTIONS, case: cases[0], arms: { llm: "claude-haiku-latest" } }));
      results.push(await call(k, "verdict", { file: join(outDir, "api.csv") }));
      results.push(await call(k, "validate", { file: join(outDir, "api.csv") }));
      results.push(await call(cliOnly.client, "run", { questions: QUESTIONS, cases, arms: { jev: false, llm: "claude-haiku-5-5" }, out: join(outDir, "cli.csv") }));

      // The calls did the work: keyed requests answered (the fixture fetch answers 401 to a request with no key).
      const askedOutcomes = field(results[2]?.body, "rows");
      const outcomes = Array.isArray(askedOutcomes) ? askedOutcomes.map((r: unknown) => field(r, "outcome")) : [];
      expect(outcomes).toHaveLength(9);
      expect(outcomes.every((o) => o === "answered")).toBe(true);
      expect(results[3]?.isError).toBe(false);
      expect(field(results[3]?.body, "rows")).toBe(18);
      expect(validate(readFileSync(join(outDir, "api.csv"), "utf8")).errors).toEqual([]);
      const inline = field(results[4]?.body, "rows");
      expect(Array.isArray(inline) ? inline.length : 0).toBe(18);
      expect(field(results[5]?.body, "stoppedByBudget")).toBe(true);
      expect(results[6]?.isError).toBe(true);
      expect(field(results[7]?.body, "exit_code")).toBe(4);
      expect(field(results[8]?.body, "valid")).toBe(true);
      expect(field(results[9]?.body, "counts", "llm", "answered")).toBe(6);
      expect(readFileSync(join(outDir, "cli.csv"), "utf8")).toContain(",llm,claude-haiku-5-5,yes,");
      expect(keyed.stderr()).toContain("test-only fixture mode");

      // The measure: every tool result, both servers' stderr and every file the server wrote.
      let count = 0;
      for (const r of results) count += occurrences(r.text, canary);
      count += occurrences(keyed.stderr(), canary) + occurrences(cliOnly.stderr(), canary);
      const written = filesUnder(outDir);
      expect(written.length).toBe(3);
      for (const file of written) count += occurrences(readFileSync(file, "utf8"), canary);
      expect(count).toBe(0);
    } finally {
      await keyed.close();
      await cliOnly.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run out guard", () => {
  const cases = [{ id: "g1", input: M0_TEXT }];
  const keys = (fixtures: string): Record<string, string> => ({ JEV_API_KEY: "k", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k", [FIXTURES_ENV]: fixtures });

  test("[integration] MCP-OUT-GUARD-REFUSE out naming package.json, a non-record csv or a directory is refused with a reason and nothing changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-mcp-outguard-"));
    const server = await spawnServer(keys(fixtureFile(dir)), dir);
    try {
      const pkg = join(dir, "package.json");
      const pkgBytes = Buffer.from('{"name":"keep-me"}\n');
      writeFileSync(pkg, pkgBytes);
      const notes = join(dir, "notes.csv");
      const notesBytes = Buffer.from("name,value\nkeep,me\n");
      writeFileSync(notes, notesBytes);
      const folder = join(dir, "folder.csv");
      mkdirSync(folder);
      const refused: Called[] = [];
      for (const out of [pkg, notes, folder]) refused.push(await call(server.client, "run", { questions: QUESTIONS, cases, arms: ALL_ARMS, out }));
      expect(refused.map((r) => r.isError)).toEqual([true, true, true]);
      expect(refused[0]?.text).toContain(".csv");
      expect(refused[1]?.text).toContain("jnj-record");
      expect(refused[2]?.text).toContain("directory");
      expect(readFileSync(pkg).equals(pkgBytes)).toBe(true);
      expect(readFileSync(notes).equals(notesBytes)).toBe(true);
      expect(statSync(folder).isDirectory()).toBe(true);
      expect(readdirSync(folder)).toEqual([]);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[integration] MCP-OUT-GUARD-ALLOW a new x.csv is written and an existing jnj-record csv is overwritten", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-mcp-outguard-"));
    const server = await spawnServer(keys(fixtureFile(dir)), dir);
    try {
      const fresh = join(dir, "x.csv");
      const first = await call(server.client, "run", { questions: QUESTIONS, cases, arms: ALL_ARMS, out: fresh });
      expect(first.isError).toBe(false);
      expect(validate(readFileSync(fresh, "utf8")).errors).toEqual([]);
      writeFileSync(fresh, readFileSync(fresh, "utf8").split("\n")[0] + "\n");
      const again = await call(server.client, "run", { questions: QUESTIONS, cases, arms: ALL_ARMS, out: fresh });
      expect(again.isError).toBe(false);
      expect(validate(readFileSync(fresh, "utf8")).errors).toEqual([]);
      expect(readFileSync(fresh, "utf8").split("\n").length).toBeGreaterThan(2);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[integration] MCP-OUT-GUARD-DRYRUN run with options.dryRun and out writes no file and returns the dry-run body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-mcp-outguard-"));
    const server = await spawnServer(keys(fixtureFile(dir)), dir);
    try {
      const dry = await call(server.client, "run", { questions: QUESTIONS, cases, arms: ALL_ARMS, options: { dryRun: true }, out: join(dir, "dry.csv") });
      expect(dry.isError).toBe(false);
      expect(field(dry.body, "dryRun")).toBe(true);
      expect(field(dry.body, "calls")).toBe(0);
      expect(readdirSync(dir).includes("dry.csv")).toBe(false);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
