import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_DISABLED_FEATURES, DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL, JEV_URL, MAX_TEXT, NO_KEY_MESSAGE, codexArgs, codexCost, execute, jevBody,
  parseArgs, parseCasesFile, parseClaude, parseCodex, redact, run, sanitizedEnv, summarize, summaryLines, visible, widthsOf,
} from "./run.ts";
import type { CaseRow, FetchInit, FetchLike } from "./run.ts";

const RUN = join(import.meta.dir, "run.ts");
const EXAMPLE = join(import.meta.dir, "example-refund.json");
const KEY = "test-jev-key-7f3a9";
const YN = ["yes", "no"];
const AUTH_OK = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" };
const CODEX_OK = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ANSWER"}}',
  '{"type":"turn.completed","usage":{"input_tokens":23547,"cached_input_tokens":11776,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join("\n");
const CODEX_TOOL = [
  '{"type":"thread.started","thread_id":"t2"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"cat /etc/hosts","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"cat /etc/hosts","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"yes"}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":1}}',
].join("\n");

type SandboxOpts = { auth?: object; authExit?: number; login?: string; loginExit?: number; answer?: string; stream?: string; logArgs?: boolean };
type Sandbox = { dir: string; cases: string; env: NodeJS.ProcessEnv; log: string; done: () => void };

/** Fake claude and codex on PATH, a cases file, and a private HOME and TMPDIR, all inside one temp dir. */
function sandbox(opts: SandboxOpts = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "learning-lines-test-"));
  const bin = join(dir, "bin");
  for (const d of [bin, join(dir, "tmp"), join(dir, "home")]) mkdirSync(d);
  const log = join(dir, "args.jsonl");
  const record = 'const input=require("node:fs").readFileSync(0,"utf8");if(process.env.FAKE_LOG)require("node:fs").appendFileSync(process.env.FAKE_LOG,JSON.stringify({a,input,cwd:process.cwd(),key:process.env.JEV_API_KEY??null})+"\\n");';
  const claude = "#!" + process.execPath + "\nconst a=process.argv.slice(2);" +
    `if(a[0]==="auth"){console.log(${JSON.stringify(JSON.stringify(opts.auth ?? AUTH_OK))});process.exit(${opts.authExit ?? 0});}` +
    'else if(a[0]==="--help")console.log("--safe-mode");' +
    "else{" + record + 'const m=a[a.indexOf("--model")+1];' +
    'console.log(JSON.stringify({is_error:false,result:process.env.FAKE_ANSWER||"yes",modelUsage:{[m]:{inputTokens:2,outputTokens:1,cacheReadInputTokens:10,cacheCreationInputTokens:8,costUSD:0.002,provider:"firstParty"}}}));}';
  const codex = "#!" + process.execPath + "\nconst a=process.argv.slice(2);" +
    `if(a[0]==="login"){console.error(process.env.FAKE_LOGIN);process.exit(${opts.loginExit ?? 0});}` +
    "else{" + record + 'process.stdout.write(process.env.FAKE_STREAM.replace("ANSWER",process.env.FAKE_ANSWER||"yes"));}';
  writeFileSync(join(bin, "claude"), claude, { mode: 0o700 });
  writeFileSync(join(bin, "codex"), codex, { mode: 0o700 });
  const cases = join(dir, "cases.json");
  writeFileSync(cases, JSON.stringify({
    question: "Is it a refund request?", workflow: "support inbox", acceptance: "2 of 2",
    choices: [{ name: "yes", definition: "asks for money back" }, { name: "no", definition: "anything else" }],
    cases: [{ id: "c1", text: "Refund me, please", expected: "yes" }, { id: "c2", text: "Opening hours?", expected: "no" }],
  }));
  const env: NodeJS.ProcessEnv = {
    PATH: bin + ":" + (process.env.PATH ?? ""), HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), JEV_API_KEY: KEY,
    ANTHROPIC_API_KEY: "must-be-stripped", OPENAI_API_KEY: "must-be-stripped",
    FAKE_LOGIN: opts.login ?? "Logged in using ChatGPT", FAKE_ANSWER: opts.answer ?? "", FAKE_STREAM: opts.stream ?? CODEX_OK,
  };
  if (opts.logArgs) env.FAKE_LOG = log;
  return { dir, cases, env, log, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeJev(choice = "yes", status = 200, body: string | null = null) {
  const calls: { url: string; init: FetchInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const ok = JSON.stringify({ model: "jev-1.13.0", answers: { q1: { choice, confidence: 0.93 } }, usage: { input_tokens: 120, output_tokens: 1 } });
    return { status, text: async () => body ?? ok };
  };
  return { fetchImpl, calls };
}

async function go(argv: string[], env: NodeJS.ProcessEnv, fetchImpl: FetchLike) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { env, fetch: fetchImpl, print: (l) => out.push(l), printErr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** Every path under dir with a content hash for files, so a rewrite or a new file shows up. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort().map((p) => {
    const full = join(dir, p);
    return statSync(full).isFile() ? `${p} ${createHash("sha256").update(readFileSync(full)).digest("hex")}` : `${p}/`;
  });
}

function logged(s: Sandbox): { a: string[]; input: string; key: string | null }[] {
  return readFileSync(s.log, "utf8").trim().split("\n").map((l) => {
    const v: unknown = JSON.parse(l);
    if (typeof v !== "object" || v === null || !("a" in v) || !("input" in v) || !("key" in v)) throw Error("bad log line");
    const a = Array.isArray(v.a) ? v.a.map(String) : [];
    return { a, input: String(v.input), key: v.key === null ? null : String(v.key) };
  });
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
    for (const bad of [[], ["c.json", "--with", "gemini"], ["c.json", "--limit", "0"], ["c.json", "--limit", "1e308"], ["c.json", "--nope", "x"], ["c.json", "--model"]]) expect(() => parseArgs(bad)).toThrow();
  });

  test("[unit] LL.cases validation gives a clear error per defect, including length caps and control characters", () => {
    const good = { question: "Q?", choices: [{ name: "yes", definition: "y" }, { name: "no", definition: "n" }], cases: [{ id: "c1", text: "t" }] };
    expect(parseCasesFile(JSON.stringify(good)).cases[0]?.expected).toBeNull();
    const long = "x".repeat(MAX_TEXT + 1);
    const bad: [unknown, string][] = [
      [{ ...good, question: "" }, "question must be a non-empty string"],
      [{ ...good, question: long }, `question is longer than ${MAX_TEXT} characters`],
      [{ ...good, choices: [{ name: "yes", definition: long }, { name: "no", definition: "n" }] }, "choices[0].definition is longer"],
      [{ ...good, cases: [{ id: "c1", text: long }] }, "cases[0].text is longer"],
      [{ ...good, choices: [{ name: "yes", definition: "y" }] }, "at least two options"],
      [{ ...good, choices: [{ name: "yes", definition: "y" }, { name: "yes", definition: "n" }] }, "unique"],
      [{ ...good, choices: [{ name: "a|b", definition: "y" }, { name: "no", definition: "n" }] }, "must not contain |"],
      [{ ...good, choices: [{ name: "y\nes", definition: "y" }, { name: "no", definition: "n" }] }, "control characters"],
      [{ ...good, choices: [{ name: "\u001b[31mred", definition: "y" }, { name: "no", definition: "n" }] }, "control characters"],
      [{ ...good, cases: [] }, "non-empty array"],
      [{ ...good, cases: [{ id: "bad id", text: "t" }] }, "letters, digits"],
      [{ ...good, cases: [{ id: "c\u0007", text: "t" }] }, "letters, digits"],
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

  test("[unit] LL.proto reserved choice names are refused and Jev criteria are own properties", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const v = { question: "Q?", choices: [{ name, definition: "y" }, { name: "no", definition: "n" }], cases: [{ id: "c1", text: "t" }] };
      expect(() => parseCasesFile(JSON.stringify(v))).toThrow("is reserved");
    }
    const file = parseCasesFile(JSON.stringify({ question: "Q?", choices: [{ name: "toString", definition: "a" }, { name: "valueOf", definition: "b" }], cases: [{ id: "c1", text: "t" }] }));
    const first = file.cases[0];
    if (first === undefined) throw Error("no case");
    const criteria = jevBody(file, first).questions.q1.criteria;
    expect(Object.keys(criteria)).toEqual(["toString", "valueOf"]);
    expect(JSON.parse(JSON.stringify(criteria))).toEqual({ toString: "a", valueOf: "b" });
  });

  test("[unit] LL.summary math: answered, matches, agreement, averages, cost per 1,000, median; widths for 200,000 rows", () => {
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
    const many = Array.from({ length: 200_000 }, (_, i) => [`c${i}`]);
    expect(widthsOf(many)).toEqual([7]);
  });

  test("[unit] LL.numbers unsafe integers and infinite costs are refused", () => {
    const huge = CODEX_OK.replace('"input_tokens":23547', '"input_tokens":1e308');
    expect(() => parseCodex(huge.replace("ANSWER", "yes"), "gpt-6-sol", YN)).toThrow("not a non-negative integer");
    const claude = (cost: string) => `{"is_error":false,"result":"yes","modelUsage":{"claude-sonnet-5-5":{"inputTokens":2,"outputTokens":1,"costUSD":${cost}}}}`;
    expect(parseClaude(claude("0.002"), "claude-sonnet-5-5", YN).costUsd).toBe(0.002);
    expect(() => parseClaude(claude("1e400"), "claude-sonnet-5-5", YN)).toThrow("finite");
    expect(() => parseClaude(claude("-1"), "claude-sonnet-5-5", YN)).toThrow("finite");
  });

  test("[unit] LL.codex tools are disabled in argv and any tool item in the stream fails the case", () => {
    const args = codexArgs("gpt-6-sol");
    for (const f of ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use"]) expect(CODEX_DISABLED_FEATURES).toContain(f);
    for (const f of CODEX_DISABLED_FEATURES) expect(args.join(" ")).toContain(`--disable ${f}`);
    expect(args).toContain('web_search="disabled"');
    expect(args[args.length - 1]).toBe("-");
    expect(() => parseCodex(CODEX_TOOL, "gpt-6-sol", YN)).toThrow("Codex used a tool (command_execution)");
    for (const type of ["file_change", "mcp_tool_call", "web_search"]) {
      const s = CODEX_OK.replace("ANSWER", "yes").replace('"type":"turn.started"}', `"type":"turn.started"}\n{"type":"item.completed","item":{"id":"x","type":"${type}"}}`);
      expect(() => parseCodex(s, "gpt-6-sol", YN)).toThrow(`(${type})`);
    }
    const reasoning = CODEX_OK.replace("ANSWER", "no").replace('"type":"turn.started"}', '"type":"turn.started"}\n{"type":"item.completed","item":{"id":"r","type":"reasoning","text":"t"}}');
    expect(parseCodex(reasoning, "gpt-6-sol", YN).output).toBe("no");
  });

  test("[unit] LL.env API keys and routing variables never reach the CLI; redact and visible", () => {
    const env = sanitizedEnv({ JEV_API_KEY: "x", ANTHROPIC_API_KEY: "x", ANTHROPIC_BASE_URL: "x", OPENAI_API_KEY: "x", CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "p", PATH: "/bin", HOME: "/h" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    expect(redact(`invalid key ${KEY}; Bearer ${KEY}`, KEY)).toBe("invalid key [redacted]; Bearer [redacted]");
    expect(visible("a\u001b[31mb\nc")).toBe("a\\u001b[31mb\\u000ac");
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
      expect(skipped.out).toMatch(/claude-sonnet-5-5\s+2\s+1\/2\s+n\/a/);
      const cli = spawnSync(process.execPath, [RUN, s.cases], { encoding: "utf8", env: noKey });
      expect(cli.status).toBe(1);
      expect(cli.stderr.trim()).toBe(NO_KEY_MESSAGE);
    } finally { s.done(); }
  });

  test("[integration] LL.claude fake claude + fake Jev: screen output; the script leaves its HOME, TMPDIR and cwd unchanged", async () => {
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
      expect(r.out).toContain("one CLI call per case (the CLI may retry internally)");
      expect(r.out).toMatch(/c1\s+yes\s+yes\s+yes\s+agree/);
      expect(r.out).toMatch(/c2\s+yes\s+yes\s+no\s+agree/);
      expect(r.out).toMatch(/Jev\s+2\s+1\/2\s+2\/2\s+120\s+1\s+\$0\.0050\s+\d+/);
      expect(r.out).toMatch(/claude-sonnet-5-5\s+2\s+1\/2\s+2\/2\s+20\s+1\s+\$2\.0000\s+\d+/);
      expect(r.out).toContain("not what you pay on a subscription");
      expect(r.out).toContain("This script writes no files; the Claude and Codex CLIs keep their own state in their home folders as usual.");
    } finally { s.done(); }
  });

  test("[integration] LL.claude prompt goes on stdin, not argv; argv and env carry no key; safe flags and requested model", async () => {
    const s = sandbox({ logArgs: true });
    try {
      const r = await go([s.cases, "--limit", "1", "--model", "claude-haiku-4-5"], s.env, fakeJev().fetchImpl);
      expect(r.code).toBe(0);
      const calls = logged(s);
      expect(calls.length).toBe(1);
      const call = calls[0];
      if (call === undefined) throw Error("no call");
      expect(call.key).toBeNull();
      expect(call.a.join(" ")).not.toContain(KEY);
      expect(call.a.join(" ")).not.toContain("Refund me, please");
      expect(call.input).toContain('{"case":"Refund me, please"}');
      for (const flag of ["--safe-mode", "--strict-mcp-config", "--no-session-persistence", "claude-haiku-4-5"]) expect(call.a).toContain(flag);
    } finally { s.done(); }
  });

  test("[integration] LL.codex fake codex: stdin prompt, gpt-6-sol cost, temp cwd removed, HOME and TMPDIR unchanged", async () => {
    const s = sandbox({ logArgs: true });
    try {
      const r = await go([s.cases, "--with", "codex"], s.env, fakeJev("no").fetchImpl);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(readdirSync(join(s.dir, "tmp"))).toEqual([]);
      expect(readdirSync(join(s.dir, "home"))).toEqual([]);
      expect(r.out).toMatch(/c1\s+no\s+yes\s+yes\s+differ/);
      const perCall = ((23547 - 11776) * 2 + 11776 * 0.2 + 5 * 10) / 1e6;
      expect(r.out).toContain(`$${(perCall * 1000).toFixed(4)}`);
      expect(r.out).toContain("Codex CLI's own system prompt");
      expect(r.out).toContain("still loads the AGENTS.md in its home folder");
      const call = logged(s)[0];
      expect(call?.a[call.a.length - 1]).toBe("-");
      expect(call?.input).toContain('{"case":"Refund me, please"}');
    } finally { s.done(); }
  });

  test("[integration] LL.codex a stream with a command_execution item stops the run", async () => {
    const s = sandbox({ stream: CODEX_TOOL });
    try {
      const r = await go([s.cases, "--with", "codex"], s.env, fakeJev().fetchImpl);
      expect(r.code).toBe(1);
      expect(r.err).toBe("Stopped at case c1 (gpt-6-sol): Codex used a tool (command_execution); a classification must not run tools, so this case fails");
    } finally { s.done(); }
  });

  test("[integration] LL.auth subscription-login refusal for both CLIs, and a nonzero status exit is refused, before any call", async () => {
    const boxes = [
      { s: sandbox({ auth: { ...AUTH_OK, authMethod: "apiKey" } }), args: [], msg: "logged in with a Claude subscription" },
      { s: sandbox({ authExit: 1 }), args: [], msg: "claude auth status failed (exit 1" },
      { s: sandbox({ login: "Logged in using an API key - sk-proj-***" }), args: ["--with", "codex"], msg: "logged in using ChatGPT" },
      { s: sandbox({ loginExit: 2 }), args: ["--with", "codex"], msg: "codex login status failed (exit 2" },
    ];
    try {
      const jev = fakeJev();
      for (const b of boxes) {
        const r = await go([b.s.cases, ...b.args], b.s.env, jev.fetchImpl);
        expect(r.code).toBe(1);
        expect(r.err).toContain(b.msg);
      }
      expect(jev.calls.length).toBe(0);
    } finally { for (const b of boxes) b.s.done(); }
  });

  test("[integration] LL.answer a non-choice answer stops the run; the Jev key is redacted from every error", async () => {
    const s = sandbox({ answer: "Yes." });
    try {
      const model = await go([s.cases], s.env, fakeJev().fetchImpl);
      expect(model.code).toBe(1);
      expect(model.err).toBe("Stopped at case c1 (claude-sonnet-5-5): Claude answer is not exactly one of yes|no");
      const jev = await go([s.cases], s.env, fakeJev("maybe").fetchImpl);
      expect(jev.err).toBe("Stopped at case c1 (Jev): Jev answer is not exactly one of yes|no");
      const denied = await go([s.cases], s.env, fakeJev("yes", 401, `{"error":"invalid key ${KEY}","auth":"Bearer ${KEY}"}`).fetchImpl);
      expect(denied.err).toContain("Jev HTTP 401");
      expect(denied.err).toContain("invalid key [redacted]");
      expect(denied.err).not.toContain(KEY);
      const throwing: FetchLike = async (_url, init) => { throw Error(`connect failed with header ${init.headers.Authorization}`); };
      const thrown = await go([s.cases], s.env, throwing);
      expect(thrown.code).toBe(1);
      expect(thrown.err).toBe("Stopped at case c1 (Jev): connect failed with header Bearer [redacted]");
    } finally { s.done(); }
  });

  test("[integration] LL.display control characters in the question are shown escaped", async () => {
    const s = sandbox();
    try {
      writeFileSync(s.cases, JSON.stringify({ question: "Refund?\u001b[2J", choices: [{ name: "yes", definition: "y" }, { name: "no", definition: "n" }], cases: [{ id: "c1", text: "t" }] }));
      const r = await go([s.cases, "--skip-jev"], s.env, fakeJev().fetchImpl);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Question: Refund?\\u001b[2J");
      expect(r.out).not.toContain("\u001b");
    } finally { s.done(); }
  });

  test("[integration] LL.timeout kills the CLI's whole process group, children included", async () => {
    const s = sandbox();
    try {
      const hang = join(s.dir, "bin", "hang");
      writeFileSync(hang, "#!" + process.execPath + '\nconst c=require("node:child_process").spawn("sleep",["30"],{stdio:"ignore"});process.stdout.write(String(c.pid)+"\\n");setInterval(()=>{},1000);', { mode: 0o700 });
      const r = await execute(hang, [], 1500, s.env, s.dir);
      expect(r.error).toBe("timeout");
      const pid = Number(r.stdout.trim());
      expect(pid).toBeGreaterThan(0);
      await Bun.sleep(100);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { s.done(); }
  });

  test("[integration] LL.overflow output past the limit fails the call instead of being cut", async () => {
    const s = sandbox();
    try {
      const big = join(s.dir, "bin", "big");
      writeFileSync(big, "#!" + process.execPath + '\nprocess.stdout.write("x".repeat(2100000));', { mode: 0o700 });
      const r = await execute(big, [], 20000, s.env, s.dir);
      expect(r.error).toBe("output larger than 2000000 characters");
    } finally { s.done(); }
  });

  test("[integration] LL.redact the key is redacted from argument errors and across the old truncation boundary", async () => {
    const s = sandbox();
    try {
      const arg = await go([s.cases, KEY], s.env, fakeJev().fetchImpl);
      expect(arg.code).toBe(1);
      expect(arg.err).toBe("Unexpected argument [redacted]");
      const edge = await go([s.cases], s.env, fakeJev("yes", 401, "x".repeat(190) + KEY).fetchImpl);
      expect(edge.err).toContain("[redacted]");
      expect(edge.err).not.toContain("test-jev");
    } finally { s.done(); }
  });

  test("[unit] LL.codex an item-level error fails the case even when an answer follows", () => {
    const s = CODEX_OK.replace("ANSWER", "yes").replace('"type":"turn.started"}', '"type":"turn.started"}\n{"type":"item.completed","item":{"id":"e","type":"error","message":"boom"}}');
    expect(() => parseCodex(s, "gpt-6-sol", YN)).toThrow("Codex error: boom");
  });

  test("[integration] LL.signal SIGINT stops the running CLI's process group and exits 130", async () => {
    const s = sandbox();
    const pidFile = join(s.dir, "child.pid");
    let pid = 0;
    try {
      writeFileSync(join(s.dir, "bin", "claude"), "#!" + process.execPath + "\nconst a=process.argv.slice(2);" +
        `if(a[0]==="auth")console.log(${JSON.stringify(JSON.stringify(AUTH_OK))});` +
        'else if(a[0]==="--help")console.log("--safe-mode");' +
        `else{const c=require("node:child_process").spawn("sleep",["30"],{stdio:"ignore"});require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);}`, { mode: 0o700 });
      const proc = Bun.spawn([process.execPath, RUN, s.cases, "--skip-jev"], { env: s.env, stdout: "ignore", stderr: "ignore" });
      for (let i = 0; i < 100 && pid === 0; i++) { await Bun.sleep(100); try { pid = Number(readFileSync(pidFile, "utf8")); } catch { /* not yet */ } }
      expect(pid).toBeGreaterThan(0);
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(130);
      await Bun.sleep(200);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      s.done();
    }
  });

  test("[integration] LL.path relative PATH entries resolve against the caller's folder for the CLI and its shebang interpreter; a folder named claude is skipped", () => {
    const s = sandbox();
    try {
      symlinkSync(process.execPath, join(s.dir, "bin", "fakebun"));
      const claude = join(s.dir, "bin", "claude");
      writeFileSync(claude, readFileSync(claude, "utf8").replace(/^#![^\n]*/, "#!/usr/bin/env fakebun"), { mode: 0o700 });
      mkdirSync(join(s.dir, "decoy", "claude"), { recursive: true });
      const env = { ...s.env, PATH: "decoy:bin:" + (process.env.PATH ?? "") };
      const r = spawnSync(process.execPath, [RUN, "cases.json", "--skip-jev"], { encoding: "utf8", env, cwd: s.dir });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/c1\s+yes\s+yes/);
    } finally { s.done(); }
  });

  test("[integration] LL.cli --help prints usage and exits 0", () => {
    const r = spawnSync(process.execPath, [RUN, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--with claude|codex");
  });
});
