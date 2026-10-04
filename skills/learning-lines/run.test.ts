import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL, JEV_URL, NO_KEY_MESSAGE, codexCost, parseArgs, parseCasesFile, run, sanitizedEnv, summarize, summaryLines,
} from "./run.ts";
import type { CaseRow, FetchInit, FetchLike } from "./run.ts";

const RUN = join(import.meta.dir, "run.ts");
const EXAMPLE = join(import.meta.dir, "example-refund.json");
const KEY = "test-jev-key-7f3a9";
const AUTH_OK = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" };
const CODEX_OK = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ANSWER"}}',
  '{"type":"turn.completed","usage":{"input_tokens":23547,"cached_input_tokens":11776,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join("\n");

type Sandbox = { dir: string; cases: string; env: NodeJS.ProcessEnv; log: string; done: () => void };

/** Fake claude and codex on PATH, a cases file, and a private TMPDIR, all inside one temp dir. */
function sandbox(opts: { auth?: object; login?: string; answer?: string; logArgs?: boolean } = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "learning-lines-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "tmp"));
  const log = join(dir, "args.jsonl");
  const record = 'if(process.env.FAKE_LOG)require("node:fs").appendFileSync(process.env.FAKE_LOG,JSON.stringify({a,cwd:process.cwd(),key:process.env.JEV_API_KEY??null})+"\\n");';
  const claude = "#!" + process.execPath + "\nconst a=process.argv.slice(2);" +
    `if(a[0]==="auth")console.log(${JSON.stringify(JSON.stringify(opts.auth ?? AUTH_OK))});` +
    'else if(a[0]==="--help")console.log("--safe-mode");' +
    "else{" + record + 'const m=a[a.indexOf("--model")+1];' +
    'console.log(JSON.stringify({is_error:false,result:process.env.FAKE_ANSWER||"yes",modelUsage:{[m]:{inputTokens:2,outputTokens:1,cacheReadInputTokens:10,cacheCreationInputTokens:8,costUSD:0.002,provider:"firstParty"}}}));}';
  const codex = "#!" + process.execPath + "\nconst a=process.argv.slice(2);" +
    'if(a[0]==="login")console.error(process.env.FAKE_LOGIN);' +
    "else{" + record + `process.stdout.write(${JSON.stringify(CODEX_OK)}.replace("ANSWER",process.env.FAKE_ANSWER||"yes"));}`;
  writeFileSync(join(bin, "claude"), claude, { mode: 0o700 });
  writeFileSync(join(bin, "codex"), codex, { mode: 0o700 });
  const cases = join(dir, "cases.json");
  writeFileSync(cases, JSON.stringify({
    question: "Is it a refund request?", workflow: "support inbox", acceptance: "2 of 2",
    choices: [{ name: "yes", definition: "asks for money back" }, { name: "no", definition: "anything else" }],
    cases: [{ id: "c1", text: "Refund me, please", expected: "yes" }, { id: "c2", text: "Opening hours?", expected: "no" }],
  }));
  const env: NodeJS.ProcessEnv = {
    PATH: bin + ":" + (process.env.PATH ?? ""), HOME: process.env.HOME, TMPDIR: join(dir, "tmp"), JEV_API_KEY: KEY,
    ANTHROPIC_API_KEY: "must-be-stripped", OPENAI_API_KEY: "must-be-stripped",
    FAKE_LOGIN: opts.login ?? "Logged in using ChatGPT", FAKE_ANSWER: opts.answer ?? "",
  };
  if (opts.logArgs) env.FAKE_LOG = log;
  return { dir, cases, env, log, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeJev(choice = "yes", status = 200) {
  const calls: { url: string; init: FetchInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.stringify({ model: "jev-1.13.0", answers: { q1: { choice, confidence: 0.93 } }, usage: { input_tokens: 120, output_tokens: 1 } });
    return { status, text: async () => (status === 200 ? body : '{"error":"unauthorized"}') };
  };
  return { fetchImpl, calls };
}

async function go(argv: string[], env: NodeJS.ProcessEnv, fetchImpl: FetchLike) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { env, fetch: fetchImpl, print: (l) => out.push(l), printErr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

describe("learning-lines", () => {
  test("[unit] LL.args defaults: --with claude and claude-sonnet-5-5; codex defaults to gpt-6-sol", () => {
    const o = parseArgs(["cases.json"]);
    expect(o.with).toBe("claude");
    expect(o.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-sonnet-5-5");
    expect(o.skipJev).toBe(false);
    expect(o.limit).toBeNull();
    const c = parseArgs(["cases.json", "--with", "codex", "--limit", "2"]);
    expect(c.model).toBe(DEFAULT_CODEX_MODEL);
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-6-sol");
    expect(c.limit).toBe(2);
    expect(parseArgs(["c.json", "--model", "claude-opus-5-5"]).model).toBe("claude-opus-5-5");
  });

  test("[unit] LL.args bad model ids and flags are refused", () => {
    for (const bad of ["sonnet", "opus", "gpt-6-sol", "claude-sonnet"]) expect(() => parseArgs(["c.json", "--model", bad])).toThrow("full Claude model id");
    for (const bad of ["sol", "gpt-6.1-sol", "claude-sonnet-5-5", "GPT-6-SOL"]) expect(() => parseArgs(["c.json", "--with", "codex", "--model", bad])).toThrow("must be one of");
    for (const bad of [[], ["c.json", "--with", "gemini"], ["c.json", "--limit", "0"], ["c.json", "--nope", "x"], ["c.json", "--model"]]) expect(() => parseArgs(bad)).toThrow();
  });

  test("[unit] LL.cases validation gives a clear error per defect", () => {
    const good = { question: "Q?", choices: [{ name: "yes", definition: "y" }, { name: "no", definition: "n" }], cases: [{ id: "c1", text: "t" }] };
    expect(parseCasesFile(JSON.stringify(good)).cases[0]?.expected).toBeNull();
    const bad: [unknown, string][] = [
      [{ ...good, question: "" }, "question must be a non-empty string"],
      [{ ...good, choices: [{ name: "yes", definition: "y" }] }, "at least two options"],
      [{ ...good, choices: [{ name: "yes", definition: "y" }, { name: "yes", definition: "n" }] }, "unique"],
      [{ ...good, choices: [{ name: "a|b", definition: "y" }, { name: "no", definition: "n" }] }, "must not contain |"],
      [{ ...good, cases: [] }, "non-empty array"],
      [{ ...good, cases: [{ id: "bad id", text: "t" }] }, "letters, digits"],
      [{ ...good, cases: [{ id: "c1", text: "t", expected: "maybe" }] }, '"maybe" is not one of yes, no'],
      [{ ...good, cases: [{ id: "c1", text: "t" }, { id: "c1", text: "u" }] }, "case ids must be unique"],
      [{ ...good, workflow: 7 }, "workflow must be a non-empty string"],
    ];
    for (const [v, msg] of bad) expect(() => parseCasesFile(JSON.stringify(v))).toThrow(msg);
    expect(() => parseCasesFile("{nope")).toThrow("not valid JSON");
    const ex = parseCasesFile(readFileSync(EXAMPLE, "utf8"));
    expect(ex.cases.length).toBe(40);
    expect(ex.workflow).not.toBeNull();
    expect(ex.acceptance).not.toBeNull();
  });

  test("[unit] LL.summary math: answered, matches, agreement, averages, cost per 1,000, median", () => {
    const a = (output: string, tokensIn: number, costUsd: number, latencyMs: number) => ({ output, tokensIn, tokensOut: 1, costUsd, latencyMs });
    const rows: CaseRow[] = [
      { id: "c1", expected: "yes", jev: a("yes", 100, 0.000004, 300), model: a("yes", 2000, 0.002, 1000) },
      { id: "c2", expected: "no", jev: a("no", 200, 0.000008, 100), model: a("yes", 4000, 0.004, 3000) },
      { id: "c3", expected: null, jev: a("no", 300, 0.000012, 200), model: a("no", 6000, 0.006, 2000) },
    ];
    expect(summarize(rows, "jev")).toEqual({ answered: 3, scored: 2, matched: 2, avgTokensIn: 200, avgTokensOut: 1, costPer1000: expect.closeTo(0.008, 12), medianLatencyMs: 200 });
    expect(summarize(rows, "model")).toMatchObject({ answered: 3, scored: 2, matched: 1, avgTokensIn: 4000, medianLatencyMs: 2000 });
    expect(summarize(rows, "model").costPer1000).toBeCloseTo(4, 12);
    const lines = summaryLines(rows, "claude-sonnet-5-5", false);
    expect(lines[1]).toMatch(/^Jev\s+3\s+2\/2\s+2\/3\s+200\s+1\s+\$0\.0080\s+200$/);
    expect(lines[2]).toMatch(/^claude-sonnet-5-5\s+3\s+1\/2\s+2\/3\s+4000\s+1\s+\$4\.0000\s+2000$/);
    expect(codexCost("gpt-6-sol", { inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheWriteInputTokens: 100_000, outputTokens: 200_000 })).toBeCloseTo(0.5 * 2 + 0.4 * 0.2 + 0.1 * 2.5 + 0.2 * 10, 12);
  });

  test("[unit] LL.env API keys and routing variables never reach the CLI", () => {
    const env = sanitizedEnv({ JEV_API_KEY: "x", ANTHROPIC_API_KEY: "x", ANTHROPIC_BASE_URL: "x", OPENAI_API_KEY: "x", CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "p", PATH: "/bin", HOME: "/h" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  });

  test("[integration] LL.jev missing JEV_API_KEY says how to get one; --skip-jev runs the model arm only", async () => {
    const s = sandbox();
    try {
      const jev = fakeJev();
      const { JEV_API_KEY: _drop, ...noKey } = s.env;
      const missing = await go([s.cases], noKey, jev.fetchImpl);
      expect(missing.code).toBe(1);
      expect(missing.err).toBe(NO_KEY_MESSAGE);
      expect(missing.err).toContain("console.typesafe.ai");
      const skipped = await go([s.cases, "--skip-jev"], noKey, jev.fetchImpl);
      expect(skipped.err).toBe("");
      expect(skipped.code).toBe(0);
      expect(jev.calls.length).toBe(0);
      expect(skipped.out).toContain("Jev vs model agree");
      expect(skipped.out).toMatch(/claude-sonnet-5-5\s+2\s+1\/2\s+n\/a/);
      const cli = spawnSync(process.execPath, [RUN, s.cases], { encoding: "utf8", env: noKey });
      expect(cli.status).toBe(1);
      expect(cli.stderr.trim()).toBe(NO_KEY_MESSAGE);
    } finally { s.done(); }
  });

  test("[integration] LL.claude fake claude + fake Jev: screen output, key only in the header, writes no files", async () => {
    const s = sandbox();
    try {
      const before = tree(s.dir);
      const jev = fakeJev("yes");
      const r = await go([s.cases], s.env, jev.fetchImpl);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(tree(s.dir)).toEqual(before);
      expect(jev.calls.length).toBe(2);
      expect(jev.calls[0]?.url).toBe(JEV_URL);
      expect(jev.calls[0]?.init.headers.Authorization).toBe(`Bearer ${KEY}`);
      const body: unknown = JSON.parse(jev.calls[0]?.init.body ?? "");
      expect(body).toEqual({ state: "Refund me, please", model: "jev-1.13.0", questions: { q1: { type: "choice", instructions: { question: "Is it a refund request?" }, criteria: { yes: "asks for money back", no: "anything else" } } } });
      expect(r.out).not.toContain(KEY);
      expect(r.out).toContain("Question: Is it a refund request?");
      expect(r.out).toContain("Choices: yes | no");
      expect(r.out).toContain("Workflow: support inbox");
      expect(r.out).toContain("Acceptance: 2 of 2");
      expect(r.out).toMatch(/c1\s+yes\s+yes\s+yes\s+agree/);
      expect(r.out).toMatch(/c2\s+yes\s+yes\s+no\s+agree/);
      expect(r.out).toMatch(/Jev\s+2\s+1\/2\s+2\/2\s+120\s+1\s+\$0\.0050\s+\d+/);
      expect(r.out).toMatch(/claude-sonnet-5-5\s+2\s+1\/2\s+2\/2\s+20\s+1\s+\$2\.0000\s+\d+/);
      expect(r.out).toContain("not what you pay on a subscription");
    } finally { s.done(); }
  });

  test("[integration] LL.claude CLI argv and env carry no key; safe flags and requested model", async () => {
    const s = sandbox({ logArgs: true });
    try {
      const r = await go([s.cases, "--limit", "1", "--model", "claude-haiku-4-5"], s.env, fakeJev().fetchImpl);
      expect(r.code).toBe(0);
      const calls = readFileSync(s.log, "utf8").trim().split("\n");
      expect(calls.length).toBe(1);
      expect(calls[0]).not.toContain(KEY);
      expect(calls[0]).toContain('"key":null');
      for (const flag of ["--safe-mode", "--strict-mcp-config", "--no-session-persistence", "claude-haiku-4-5"]) expect(calls[0]).toContain(flag);
    } finally { s.done(); }
  });

  test("[integration] LL.codex fake codex: ChatGPT login, gpt-6-sol cost, temp cwd removed, no files left", async () => {
    const s = sandbox();
    try {
      const before = tree(s.dir);
      const r = await go([s.cases, "--with", "codex"], s.env, fakeJev("no").fetchImpl);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(tree(s.dir)).toEqual(before);
      expect(r.out).toMatch(/c1\s+no\s+yes\s+yes\s+differ/);
      const perCall = ((23547 - 11776) * 2 + 11776 * 0.2 + 5 * 10) / 1e6;
      expect(r.out).toContain(`$${(perCall * 1000).toFixed(4)}`);
      expect(r.out).toContain("Codex CLI's own system prompt");
    } finally { s.done(); }
  });

  test("[integration] LL.auth subscription-login refusal for both CLIs, before any call", async () => {
    const c = sandbox({ auth: { ...AUTH_OK, authMethod: "apiKey" } });
    const x = sandbox({ login: "Logged in using an API key - sk-proj-***" });
    try {
      const jev = fakeJev();
      const rc = await go([c.cases], c.env, jev.fetchImpl);
      expect(rc.code).toBe(1);
      expect(rc.err).toContain("logged in with a Claude subscription");
      const rx = await go([x.cases, "--with", "codex"], x.env, jev.fetchImpl);
      expect(rx.code).toBe(1);
      expect(rx.err).toContain("logged in using ChatGPT");
      expect(jev.calls.length).toBe(0);
    } finally { c.done(); x.done(); }
  });

  test("[integration] LL.answer a non-choice answer stops the run with a clear message", async () => {
    const s = sandbox({ answer: "Yes." });
    try {
      const model = await go([s.cases], s.env, fakeJev().fetchImpl);
      expect(model.code).toBe(1);
      expect(model.err).toBe("Stopped at case c1 (claude-sonnet-5-5): Claude answer is not exactly one of yes|no");
      const jev = await go([s.cases], s.env, fakeJev("maybe").fetchImpl);
      expect(jev.err).toBe("Stopped at case c1 (Jev): Jev answer is not exactly one of yes|no");
      const denied = await go([s.cases], s.env, fakeJev("yes", 401).fetchImpl);
      expect(denied.err).toContain("Jev HTTP 401");
      expect(denied.err).not.toContain(KEY);
    } finally { s.done(); }
  });

  test("[integration] LL.cli --help prints usage and exits 0", () => {
    const s = sandbox();
    try {
      const r = spawnSync(process.execPath, [RUN, "--help"], { encoding: "utf8", env: s.env, cwd: s.dir });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("--with claude|codex");
    } finally { s.done(); }
  });
});
