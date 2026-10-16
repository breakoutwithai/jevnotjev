import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  argsOf, assertReleaseOutput, assertServedSha, attempt, command, formatCheck, guideChecks, guideSafeScripts, limitsTextFailure, mcpChecks, notRunChecks,
  RELEASE_ITEMS, SAFE_GUIDE_STEPS, summarizeChecks,
  type Check,
} from "./release-check.ts";

test("[unit] RELEASE-CHECK-TIMEOUT names the timed out step", () => {
  expect(() => command([process.execPath, "-e", "Bun.sleepSync(200)"], import.meta.dir, {}, "cli timeout probe", 10)).toThrow("cli timeout probe timed out after 10 ms");
});

test("[unit] RELEASE-CHECK-ARMS requires all four documented arms", () => {
  expect(() => assertReleaseOutput("arms", { arms: [] })).toThrow("documented arms missing");
  expect(() => assertReleaseOutput("arms", { arms: ["jev", "decisions", "llm", "rule"].map((arm) => ({ arm })) })).not.toThrow();
  expect(() => assertReleaseOutput("arms", { arms: ["jev", "decisions", "llm", "rule", "extra"].map((arm) => ({ arm })) })).toThrow("documented arms missing");
});

const expectedRun = { caseIds: ["m01", "m02"], arms: ["jev"] };

test("[unit] RELEASE-CHECK-ESTIMATE rejects one fewer call and wrong case count", () => {
  expect(() => assertReleaseOutput("estimate", { cases: 2, calls: 1, costUsd: 0.000035658 }, expectedRun)).toThrow("expected 2 calls");
  expect(() => assertReleaseOutput("estimate", { cases: 1, calls: 2, costUsd: 0.000035658 }, expectedRun)).toThrow("expected 2 cases");
  expect(() => assertReleaseOutput("estimate", { cases: 2, calls: 2, costUsd: 0.000035658 }, expectedRun)).not.toThrow();
});

test("[unit] RELEASE-CHECK-ESTIMATE requires a positive finite cost", () => {
  const valid = { cases: 2, calls: 2, costUsd: 0.000035658 };
  expect(() => assertReleaseOutput("estimate", valid, expectedRun)).not.toThrow();
  for (const costUsd of [undefined, 0, -1, null, "broken"]) {
    expect(() => assertReleaseOutput("estimate", { ...valid, costUsd }, expectedRun)).toThrow("expected positive finite costUsd");
  }
});

test("[unit] RELEASE-CHECK-VERDICT requires the expected named verdict", () => {
  for (const verdict of ["use Jev", "don't use Jev", "not enough evidence"]) {
    expect(() => assertReleaseOutput("verdict", { exit_code: 0, verdicts: [] }, verdict)).toThrow("expected exactly one verdict");
    expect(() => assertReleaseOutput("verdict", { verdicts: [{ verdict }] }, verdict)).not.toThrow();
    expect(() => assertReleaseOutput("verdict", { verdicts: [{ verdict }, { verdict: "contradictory" }] }, verdict)).toThrow("expected exactly one verdict");
  }
});

test("[unit] RELEASE-CHECK-FIXTURE rejects one missing row and the wrong case-arm set", () => {
  const records = "format_version,case_id,answerer,outcome\njnj-record/1.2,m01,jev,answered\njnj-record/1.2,m02,jev,answered\n";
  expect(() => assertReleaseOutput("fixture run", { rows: 1 }, expectedRun, records)).toThrow("expected 2 rows");
  expect(() => assertReleaseOutput("fixture run", { rows: 2 }, expectedRun, records.replace("jnj-record/1.2,m02,jev,answered\n", ""))).toThrow("expected 2 record rows");
  expect(() => assertReleaseOutput("fixture run", { rows: 2 }, expectedRun, records.replace("m02", "m01"))).toThrow("case-arm set differs");
  expect(() => assertReleaseOutput("fixture run", { rows: 2 }, expectedRun, records.replace("m02,jev,answered", "m02,jev,error"))).toThrow("expected every row answered");
  expect(() => assertReleaseOutput("fixture run", { rows: 2 }, expectedRun, records)).not.toThrow();
});

test("[unit] RELEASE-CHECK-LINES formats one pass, one failure with a reason and one not-run line", () => {
  expect(formatCheck({ name: "cli help", state: "PASS" })).toBe("PASS cli help");
  expect(formatCheck({ name: "mcp validate", state: "FAIL", reason: "wrong exit code" })).toBe("FAIL mcp validate: wrong exit code");
  expect(formatCheck({ name: "served sha", state: "NOT RUN", reason: "no --url given" })).toBe("NOT RUN served sha: no --url given");
});

test("[unit] RELEASE-CHECK-LINES a reason with line breaks or control characters prints one line", () => {
  const line = formatCheck({ name: "guide rule", state: "FAIL", reason: "bad\nPASS cli help\r\n\r\nmore\u0007\u001b[31m" });
  expect(line).toBe("FAIL guide rule: bad | PASS cli help | more[31m");
  expect(line.split("\n").length).toBe(1);
  expect(/[\u0000-\u001f\u007f]/.test(line)).toBe(false);
});

test("[unit] RELEASE-CHECK-SUMMARY covers empty, all-pass, fail, fail with not-run and not-run only", () => {
  const pass: Check = { name: "a", state: "PASS" };
  const fail: Check = { name: "b", state: "FAIL", reason: "bad" };
  const notRun: Check = { name: "c", state: "NOT RUN", reason: "no --url given" };
  expect(summarizeChecks([])).toEqual({ line: "release-check: FAIL 0/0", exitCode: 1 });
  expect(summarizeChecks([pass, pass])).toEqual({ line: "release-check: PASS 2/2", exitCode: 0 });
  expect(summarizeChecks([pass, fail])).toEqual({ line: "release-check: FAIL 1/2", exitCode: 1 });
  expect(summarizeChecks([pass, fail, notRun])).toEqual({ line: "release-check: FAIL 1/3, 1 not run", exitCode: 1 });
  expect(summarizeChecks([pass, notRun, notRun])).toEqual({ line: "release-check: NOT RUN 2/3", exitCode: 2 });
});

const repoRoot = join(import.meta.dir, "..");

const EXPECTED_ITEMS: string[] = [
  "fresh clone", "frozen install",
  "guide prepare", "guide question", "guide rule", "guide cases", "guide estimate",
  "cli help", "cli arms", "cli estimate", "cli validate valid", "cli validate invalid",
  "cli verdict use", "cli verdict insufficient", "cli verdict reject", "cli fixture run", "cli validate fixture records",
  "mcp tools/list", "mcp validate", "mcp verdict",
  "served sha", "limits text",
];

test("[unit] RELEASE-CHECK-ITEMS lists the 22 items in run order", () => {
  expect(RELEASE_ITEMS).toEqual(EXPECTED_ITEMS);
  expect(new Set(RELEASE_ITEMS).size).toBe(22);
});

test("[unit] RELEASE-CHECK-NOTRUN fills every unreported item and names the first failure", () => {
  const items = ["a", "b", "c", "d"];
  const pass: Check = { name: "a", state: "PASS" };
  const fail: Check = { name: "b", state: "FAIL", reason: "bad" };
  const laterFail: Check = { name: "c", state: "FAIL", reason: "worse" };
  expect(notRunChecks([pass, fail], items)).toEqual([
    { name: "c", state: "NOT RUN", reason: "not reached after b" },
    { name: "d", state: "NOT RUN", reason: "not reached after b" },
  ]);
  expect(notRunChecks([pass, fail, laterFail], items)).toEqual([{ name: "d", state: "NOT RUN", reason: "not reached after b" }]);
  expect(notRunChecks([pass, fail, laterFail, { name: "d", state: "PASS" }], items)).toEqual([]);
  expect(notRunChecks([], ["a"])).toEqual([{ name: "a", state: "NOT RUN", reason: "not reached" }]);
  expect(notRunChecks([pass], ["a", "b"])).toEqual([{ name: "b", state: "NOT RUN", reason: "not reached" }]);
});

function block(id: string, body: string): string {
  return "```sh\n# guide: " + id + "\n" + body + "\n```\n";
}

function guideWith(overrides: Readonly<Record<string, string>>, omit: readonly string[] = []): string {
  return SAFE_GUIDE_STEPS.filter((id) => !omit.includes(id)).map((id) => block(id, overrides[id] ?? `echo ${id}`)).join("\ntext\n");
}

test("[unit] RELEASE-CHECK-GUIDE returns the five safe scripts of the repo guide in order", () => {
  expect(SAFE_GUIDE_STEPS).toEqual(["prepare", "question", "rule", "cases", "estimate"]);
  const steps = guideSafeScripts(readFileSync(join(repoRoot, "docs/GUIDE.md"), "utf8"));
  expect(steps.map((step) => step.id)).toEqual(["prepare", "question", "rule", "cases", "estimate"]);
  expect(steps[0]?.script).toContain("mkdir -p guide-work");
  expect(steps[4]?.script).toContain("decide estimate");
  expect(steps.every((step) => !step.script.startsWith("# guide:"))).toBe(true);
});

test("[unit] RELEASE-CHECK-GUIDE fails on a missing or duplicated safe step", () => {
  expect(() => guideSafeScripts(guideWith({}, ["rule"]))).toThrow("guide step rule missing");
  expect(() => guideSafeScripts("")).toThrow("guide step prepare missing");
  expect(() => guideSafeScripts(guideWith({}) + block("cases", "echo again"))).toThrow("guide step cases duplicated");
});

test("[unit] RELEASE-CHECK-GUIDE refuses every way a safe step could reach a provider or the network", () => {
  const unsafe: readonly (readonly [string, string])[] = [
    ["decide run", "bun run decide run --arms jev"],
    ["decide -- run", "bun run decide -- run"],
    ["decide ask", "bun run decide   ask --q x"],
    ["cli.ts run", "bun src/decide/cli.ts run"],
    ["decide continued", "bun run decide \\\nrun"],
    ["decide quoted", "bun run decide 'run'"],
    ["decide bare", "bun run decide"],
    ["quoted claude", "\"claude\" -p hi"],
    ["claude path", "/usr/local/bin/claude"],
    ["claude bare", "claude -p hello"],
    ["claude heredoc", "cat <<EOF\nclaude -p x\nEOF"],
    ["curl", "curl https://example.com"],
    ["wget", "wget https://example.com"],
    ["nc", "nc example.com 80"],
    ["bunx", "bunx x"],
    ["npx", "npx x"],
    ["bun add", "bun add left-pad"],
    ["fetch(", "bun -e 'await fetch(\"https://example.com\")'"],
    ["fetch (", "fetch (u)"],
    ["node:https", "bun -e 'import(\"node:https\")'"],
    ["node:net", "bun -e 'import(\"node:net\")'"],
    ["node:tls", "bun -e 'import(\"node:tls\")'"],
    ["_API_KEY", "echo $ANTHROPIC_API_KEY"],
  ];
  for (const [label, body] of unsafe) {
    expect(() => guideSafeScripts(guideWith({ question: body })), label).toThrow("guide step question is not safe");
  }
});

test("[unit] RELEASE-CHECK-GUIDE still allows decide estimate and normalizes CRLF before parsing", () => {
  const allowed = "bun run decide estimate --questions guide-work/question.json --cases guide-work/cases.jsonl --arms jev,rule";
  expect(() => guideSafeScripts(guideWith({ question: allowed }))).not.toThrow();
  expect(() => guideSafeScripts(guideWith({ question: allowed }).replace(/\n/g, "\r\n"))).not.toThrow();
  expect(() => guideSafeScripts(guideWith({ question: "bun run decide\nrun" }).replace(/\n/g, "\r\n"))).toThrow("guide step question is not safe");
  expect(() => guideSafeScripts(guideWith({ question: "claude -p hi" }).replace(/\n/g, "\r\n"))).toThrow("guide step question is not safe");
});

test("[unit] RELEASE-CHECK-GUIDE does not apply the safety check to a step outside the safe set", () => {
  const text = guideWith({}) + block("without-jev", "bun run decide run --arms llm,rule");
  expect(guideSafeScripts(text).map((step) => step.id)).toEqual([...SAFE_GUIDE_STEPS]);
});

const goodEstimate = "echo '{\"cases\":30,\"calls\":60,\"costUsd\":0.1}'";

function craftedGuide(overrides: Readonly<Record<string, string>> = {}): string {
  const defaults: Readonly<Record<string, string>> = { prepare: "mkdir -p guide-work", question: "echo q", rule: "echo r", cases: "echo c", estimate: goodEstimate };
  return SAFE_GUIDE_STEPS.map((id) => block(id, overrides[id] ?? defaults[id] ?? "true")).join("\ntext\n");
}

async function runGuide(guide: string | undefined, work?: string): Promise<readonly Check[]> {
  const dir = mkdtempSync(join(tmpdir(), "jnj-guide-check-"));
  try {
    mkdirSync(join(dir, "docs"));
    if (guide !== undefined) writeFileSync(join(dir, "docs/GUIDE.md"), guide);
    const checks: Check[] = [];
    const emit = (check: Check): void => { checks.push(check); };
    await guideChecks(dir, (name, fn) => attempt(name, fn, emit), emit, work);
    return checks;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("[integration] RELEASE-CHECK-GUIDE-RUN a good crafted guide gives five PASS lines", async () => {
  const checks = await runGuide(craftedGuide());
  expect(checks.map(formatCheck)).toEqual(SAFE_GUIDE_STEPS.map((id) => `PASS guide ${id}`));
});

test("[integration] RELEASE-CHECK-GUIDE-RUN a step that exits non-zero fails and names the exit", async () => {
  const checks = await runGuide(craftedGuide({ rule: "exit 3" }));
  expect(checks.map((check) => `${check.state} ${check.name}`)).toEqual([
    "PASS guide prepare", "PASS guide question", "FAIL guide rule", "PASS guide cases", "PASS guide estimate",
  ]);
  expect(checks[2]?.reason).toContain("exit 3, expected 0");
});

test("[integration] RELEASE-CHECK-GUIDE-RUN a guide estimate output that is not a safe sample fails", async () => {
  const bad: readonly (readonly [string, string, string])[] = [
    ["cases 29", "echo '{\"cases\":29,\"calls\":58,\"costUsd\":0.1}'", "expected at least 30 cases"],
    ["cases not an integer", "echo '{\"cases\":30.5,\"calls\":60,\"costUsd\":0.1}'", "expected at least 30 cases"],
    ["calls 0", "echo '{\"cases\":30,\"calls\":0,\"costUsd\":0.1}'", "expected a positive integer calls"],
    ["costUsd 0", "echo '{\"cases\":30,\"calls\":60,\"costUsd\":0}'", "expected positive finite costUsd"],
    ["not JSON", "echo not json", "estimate output is not JSON"],
  ];
  for (const [label, estimate, reason] of bad) {
    const checks = await runGuide(craftedGuide({ estimate }));
    expect(checks.at(-1), label).toMatchObject({ name: "guide estimate", state: "FAIL", reason });
  }
  const good = await runGuide(craftedGuide({ estimate: "echo '{\"cases\":30,\"calls\":1,\"costUsd\":0.000001}'" }));
  expect(good.at(-1)).toEqual({ name: "guide estimate", state: "PASS" });
});

test("[integration] RELEASE-CHECK-GUIDE-RUN an unparseable or missing guide gives five FAIL lines", async () => {
  for (const guide of ["", "no blocks here", craftedGuide({ question: "bun run decide run" }), undefined]) {
    const checks = await runGuide(guide);
    expect(checks.map((check) => `${check.state} ${check.name}`)).toEqual(SAFE_GUIDE_STEPS.map((id) => `FAIL guide ${id}`));
    expect(checks.every((check) => (check.reason ?? "") !== "")).toBe(true);
  }
});

test("[integration] RELEASE-CHECK-MCP-CONNECT a server that cannot start fails all three mcp items with the connect reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jnj-mcp-check-"));
  try {
    const checks: Check[] = [];
    const emit = (check: Check): void => { checks.push(check); };
    await mcpChecks(dir, (name, fn) => attempt(name, fn, emit), emit);
    expect(checks.map((check) => `${check.state} ${check.name}`)).toEqual(["FAIL mcp tools/list", "FAIL mcp validate", "FAIL mcp verdict"]);
    expect(checks.every((check) => check.reason?.startsWith("connect failed: "))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("[unit] RELEASE-CHECK-LIMITS fails on a missing or empty file and passes any non-blank content", () => {
  expect(limitsTextFailure(undefined)).toBe("docs/LIMITS.md missing");
  for (const text of ["", " \n\t\n", "\r\n\r\n"]) expect(limitsTextFailure(text), JSON.stringify(text)).toBe("docs/LIMITS.md is empty");
  for (const text of ["# Limits\n", "It cannot judge audio.\n", "# Limits\r\n\r\nIt cannot judge audio.\r\n"]) expect(limitsTextFailure(text), JSON.stringify(text)).toBeUndefined();
});

test("[integration] RELEASE-CHECK-GUIDE-HOME a guide step gets an empty temp HOME, not the real one", async () => {
  const realHome = process.env.HOME ?? "";
  expect(realHome).not.toBe("");
  const probe = `bash -c 'test -d "$HOME" && test "$HOME" != "$1" && test -z "$(ls -A "$HOME")"' _ ${JSON.stringify(realHome)}`;
  const checks = await runGuide(craftedGuide({ question: probe }));
  expect(checks.map((check) => `${check.state} ${check.name}`), JSON.stringify(checks)).toEqual(SAFE_GUIDE_STEPS.map((id) => `PASS guide ${id}`));
});

test("[integration] RELEASE-CHECK-GUIDE-RUN a failing intermediate command fails the step, including inside a pipe", async () => {
  const masked = await runGuide(craftedGuide({ rule: "false; printf done" }));
  expect(masked[2]).toMatchObject({ name: "guide rule", state: "FAIL" });
  const piped = await runGuide(craftedGuide({ rule: "false | cat" }));
  expect(piped[2]).toMatchObject({ name: "guide rule", state: "FAIL" });
});

test("[integration] RELEASE-CHECK-GUIDE-RUN a temp HOME that cannot be created fails the five guide items", async () => {
  const checks = await runGuide(craftedGuide(), join(tmpdir(), "jnj-no-such-dir", "deeper"));
  expect(checks.map((check) => `${check.state} ${check.name}`)).toEqual(SAFE_GUIDE_STEPS.map((id) => `FAIL guide ${id}`));
  expect(checks.every((check) => (check.reason ?? "") !== "")).toBe(true);
});

test("[unit] RELEASE-CHECK-ARGS rejects a --url carrying a query or fragment", () => {
  for (const url of ["http://host/?x=1", "http://host/#frag", "http://host/app?x=1#f", "http://host/?"]) {
    expect(() => argsOf(["--url", url]), url).toThrow("usage:");
  }
});

const candidate = "0123456789abcdef0123456789abcdef01234567";

test("[integration] RELEASE-CHECK-SERVED requests the sub-path of a base URL and refuses a query or fragment base", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => (new URL(request.url).pathname === "/app/DEPLOYED_SHA" && new URL(request.url).search === "" ? new Response(candidate) : new Response("wrong path", { status: 404 })) });
  try {
    await assertServedSha(`http://127.0.0.1:${server.port}/app/`, candidate);
    await assertServedSha(`http://127.0.0.1:${server.port}/app//`, candidate);
    await expect(assertServedSha(`http://127.0.0.1:${server.port}/?x=1`, candidate)).rejects.toThrow("served URL must not carry a query or fragment");
    await expect(assertServedSha(`http://127.0.0.1:${server.port}/app#frag`, candidate)).rejects.toThrow("served URL must not carry a query or fragment");
  } finally {
    await server.stop(true);
  }
});

async function servedCase(body: string, status = 200): Promise<Error | undefined> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => (new URL(request.url).pathname === "/x/DEPLOYED_SHA" ? new Response(body, { status }) : new Response("wrong path", { status: 418 })) });
  try {
    await assertServedSha(`http://127.0.0.1:${server.port}/x`, candidate);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    await server.stop(true);
  }
}

test("[integration] RELEASE-CHECK-SERVED accepts the full sha, uppercase and a trailing newline", async () => {
  expect(await servedCase(candidate)).toBeUndefined();
  expect(await servedCase(candidate.toUpperCase())).toBeUndefined();
  expect(await servedCase(`${candidate}\n`)).toBeUndefined();
});

test("[integration] RELEASE-CHECK-SERVED rejects a prefix, a sha that shares only the first 7 characters, HTML, 404 and empty", async () => {
  const sameStart = candidate.slice(0, 7) + "f".repeat(33);
  expect((await servedCase(candidate.slice(0, 7)))?.message).toBe("served value is not a 40-character commit SHA");
  expect((await servedCase(sameStart))?.message).toBe(`served ${sameStart}, candidate ${candidate}`);
  expect((await servedCase("f".repeat(40)))?.message).toBe(`served ${"f".repeat(40)}, candidate ${candidate}`);
  expect((await servedCase("not found", 404))?.message).toBe("HTTP 404");
  expect((await servedCase("<!doctype html><html><body>app</body></html>"))?.message).toBe("served value is not a 40-character commit SHA");
  expect((await servedCase(""))?.message).toBe("served value is not a 40-character commit SHA");
});

test("[integration] RELEASE-CHECK-SERVED joins a trailing-slash base without a double slash", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => (new URL(request.url).pathname === "/DEPLOYED_SHA" ? new Response(candidate) : new Response("wrong path", { status: 404 })),
  });
  try {
    await assertServedSha(`http://127.0.0.1:${server.port}/`, candidate);
    await assertServedSha(`http://127.0.0.1:${server.port}`, candidate);
  } finally {
    await server.stop(true);
  }
});

test("[integration] RELEASE-CHECK-SERVED names a timeout and a refused connection", async () => {
  const slow = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { await Bun.sleep(500); return new Response(candidate); } });
  try {
    await expect(assertServedSha(`http://127.0.0.1:${slow.port}`, candidate, 50)).rejects.toThrow("timed out after 50 ms");
  } finally {
    await slow.stop(true);
  }
  await expect(assertServedSha("http://127.0.0.1:1", candidate)).rejects.toThrow("network error");
});

test("[integration] RELEASE-CHECK-SERVED refuses a redirect even when the target serves the right sha", async () => {
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(candidate) });
  const redirector = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${target.port}/DEPLOYED_SHA` } }) });
  try {
    await expect(assertServedSha(`http://127.0.0.1:${redirector.port}`, candidate)).rejects.toThrow("network error");
  } finally {
    await redirector.stop(true);
    await target.stop(true);
  }
});

test("[integration] RELEASE-CHECK-SERVED a body that stalls after the headers times out with the normalized reason", async () => {
  const stalled = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("0123")); } }), { status: 200 }),
  });
  try {
    await expect(assertServedSha(`http://127.0.0.1:${stalled.port}`, candidate, 200)).rejects.toThrow("request timed out after 200 ms");
  } finally {
    await stalled.stop(true);
  }
});

test("[unit] RELEASE-CHECK-DOC every item and the stated item count match docs/RELEASE-CHECKLIST.md", () => {
  const doc = readFileSync(join(repoRoot, "docs/RELEASE-CHECKLIST.md"), "utf8");
  for (const name of RELEASE_ITEMS) expect(doc.includes(`\`${name}\``), name).toBe(true);
  const stated = doc.match(/Every one of the (\d+) items/)?.[1];
  expect(Number(stated)).toBe(RELEASE_ITEMS.length);
});

test("[unit] RELEASE-CHECK-ARGS accepts --url and rejects a non-http value or a missing value", () => {
  expect(argsOf(["--url", "https://jevnotjev.breakoutwithai.com"]).url).toBe("https://jevnotjev.breakoutwithai.com");
  expect(argsOf(["--url", "http://127.0.0.1:1", "--ref", "v0.1.0"])).toMatchObject({ url: "http://127.0.0.1:1", ref: "v0.1.0" });
  expect(argsOf([]).url).toBeUndefined();
  expect(() => argsOf(["--url", "ftp://x"])).toThrow("usage:");
  expect(() => argsOf(["--url"])).toThrow("usage:");
  expect(() => argsOf(["--url", "not a url"])).toThrow("usage:");
});

async function runCli(args: readonly string[]): Promise<{ readonly output: string; readonly code: number }> {
  const proc = Bun.spawn([process.execPath, "scripts/release-check.ts", ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { output: `${stdout}${stderr}`, code: await proc.exited };
}

function itemLines(output: string): string[] {
  return output.split("\n").filter((line) => /^(PASS|FAIL|NOT RUN) /.test(line));
}

function itemName(line: string): string {
  return line.replace(/^(PASS|FAIL|NOT RUN) /, "").replace(/:.*$/, "");
}

test("[integration] RELEASE-CHECK-ARGUMENTS a bad flag prints FAIL arguments and 22 NOT RUN lines", async () => {
  const { output, code } = await runCli(["--bogus", "x"]);
  const lines = itemLines(output);
  expect(code, output).toBe(1);
  expect(lines[0], output).toMatch(/^FAIL arguments: usage:/);
  expect(lines.length, output).toBe(23);
  expect(lines.slice(1).every((line) => line.startsWith("NOT RUN ") && line.endsWith(": not reached after arguments")), output).toBe(true);
  expect(lines.slice(1).map(itemName), output).toEqual(EXPECTED_ITEMS);
  expect(output.trimEnd().split("\n").at(-1)).toBe("release-check: FAIL 1/23, 22 not run");
});

test("[integration] RELEASE-CHECK-REF an unknown ref prints FAIL fresh clone and 21 NOT RUN lines", async () => {
  const { output, code } = await runCli(["--repo", ".", "--ref", "doesnotexist"]);
  const lines = itemLines(output);
  expect(code, output).toBe(1);
  expect(lines[0], output).toMatch(/^FAIL fresh clone: /);
  expect(lines.length, output).toBe(22);
  expect(lines.slice(1).every((line) => line.startsWith("NOT RUN ") && line.endsWith(": not reached after fresh clone")), output).toBe(true);
  expect(lines.map(itemName), output).toEqual(EXPECTED_ITEMS);
  expect(output.trimEnd().split("\n").at(-1)).toBe("release-check: FAIL 1/22, 21 not run");
}, 60_000);

function git(cwd: string, ...args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

// A candidate made from HEAD with one input file the CLI items need deleted.
function craftedCandidate(parent: string): string {
  const dir = join(parent, "candidate");
  mkdirSync(dir);
  const tarball = join(parent, "head.tar");
  git(repoRoot, "archive", "--format=tar", "-o", tarball, "HEAD");
  const unpacked = Bun.spawnSync(["tar", "-xf", tarball, "-C", dir], { stdout: "pipe", stderr: "pipe" });
  if (unpacked.exitCode !== 0) throw new Error(`tar: ${unpacked.stderr.toString()}`);
  rmSync(join(dir, "src/decide/fixtures/m0-jev.json"));
  git(dir, "init", "--quiet");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=release-check", "-c", "user.email=release-check@example.invalid", "commit", "--quiet", "-m", "candidate");
  return dir;
}

test("[integration] RELEASE-CHECK-INPUTS a candidate missing an input file fails every cli item and the run without --url never passes", async () => {
  const parent = mkdtempSync(join(tmpdir(), "jnj-release-crafted-"));
  try {
    const { output, code } = await runCli(["--repo", craftedCandidate(parent), "--ref", "HEAD"]);
    const lines = itemLines(output);
    expect(lines.map(itemName), output).toEqual(EXPECTED_ITEMS);
    const cli = lines.filter((line) => itemName(line).startsWith("cli "));
    expect(cli.length, output).toBe(10);
    expect(cli.every((line) => /^FAIL cli [^:]+: cli inputs: /.test(line)), output).toBe(true);
    expect(lines, output).toContain("NOT RUN served sha: no --url given");
    const summary = output.trimEnd().split("\n").at(-1) ?? "";
    expect(summary, output).toMatch(/^release-check: FAIL \d+\/22, \d+ not run$/);
    expect(summary).not.toContain("PASS");
    expect(code, output).toBe(1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 240_000);

test("[integration] RELEASE-CHECK-FRESH relative repo runs every guide, CLI, MCP, limits and served-sha check from a local fresh clone", async () => {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot, stdout: "pipe" }).stdout.toString().trim();
  expect(head).toMatch(/^[0-9a-f]{40}$/);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => (new URL(request.url).pathname === "/DEPLOYED_SHA" ? new Response(`${head}\n`) : new Response("not found", { status: 404 })) });
  try {
    const shown = Bun.spawnSync(["git", "show", "HEAD:docs/LIMITS.md"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const limits = limitsTextFailure(shown.exitCode === 0 ? shown.stdout.toString() : undefined);
    const { output, code } = await runCli(["--repo", ".", "--ref", "HEAD", "--url", `http://127.0.0.1:${server.port}`]);
    expect(code, output).toBe(limits === undefined ? 0 : 1);
    const lines = itemLines(output);
    const names = lines.map(itemName);
    expect(names, output).toEqual(EXPECTED_ITEMS);
    const passed = lines.filter((line) => line.startsWith("PASS ")).map((line) => line.slice(5));
    expect(passed, output).toEqual(names.filter((name) => name !== "limits text" || limits === undefined));
    expect(lines.filter((line) => line.startsWith("FAIL ")), output).toEqual(limits === undefined ? [] : [`FAIL limits text: ${limits}`]);
    expect(output).toMatch(/^candidate: [0-9a-f]{40}$/m);
    const tail = output.trimEnd().split("\n");
    expect(tail.at(-1)).toBe(limits === undefined ? "release-check: PASS 22/22" : "release-check: FAIL 1/22");
    expect(tail.at(-2)).toMatch(/^elapsed: \d+(\.\d+)? s$/);
  } finally {
    await server.stop(true);
  }
}, 240_000);
