// [unit] tokenmax-map parser. Synthetic lines in the record shapes observed in real local history on 2026-10-16.
import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapOccurrence, CODEX_META_TYPE, classifyClaudeNotice, groupEpisodes, main, parseArgs, parseClaudeLine, perWeekLine, projectOf, renderPrivate, scanClaude, scanCodex, scanShare, summarise, weekTotals } from "./map.ts";

const FROM = Date.parse("2026-10-09T00:00:00Z");
const TO = Date.parse("2026-10-16T23:59:59Z");
/** A UUID-shaped string built at runtime, so no literal id sits in the source. */
const fakeUuid = (): string => [8, 4, 4, 4, 12].map((len) => "a1".repeat(len).slice(0, len)).join("-");

test("[integration] --help and -h print usage without reading logs or making a report", async () => {
  for (const flag of ["--help", "-h"]) {
    const cwd = mkdtempSync(join(tmpdir(), "tmx-help-"));
    const run = Bun.spawn(["bun", join(import.meta.dir, "map.ts"), flag], {
      cwd,
      env: { ...process.env, HOME: tmpdir() },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("bun map.ts");
    expect(stdout).toContain("curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts | bun run - --share");
    expect(stdout).toContain("last 7 days");
    expect(stdout).toContain("--days N");
    expect(stdout).toContain("[-h|--help]");
    expect(stdout).toContain("90");
    expect(stdout).toContain("--from YYYY-MM-DD --to YYYY-MM-DD");
    expect(readdirSync(cwd)).toEqual([]);
  }
});

test("[integration] help anywhere overrides other flags without reading available logs or making a report", async () => {
  for (const argv of [["--days", "30", "--help"], ["--help", "--days", "30"], ["--share", "-h"], ["--share", "--help"]]) {
    const cwd = mkdtempSync(join(tmpdir(), "tmx-help-mixed-"));
    const home = join(cwd, "home");
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    const piped = argv[0] === "--share" && argv[1] === "--help";
    const run = Bun.spawn(piped ? ["bun", "run", "-", ...argv] : ["bun", join(import.meta.dir, "map.ts"), ...argv], {
      cwd, env: { ...process.env, HOME: home }, stdin: piped ? Bun.file(join(import.meta.dir, "map.ts")) : "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: bun map.ts");
    expect(readdirSync(cwd)).toEqual(["home"]);
    expect(readdirSync(join(home, ".claude", "projects"))).toEqual([]);
  }
});

test("[integration] existing --out gives a new-folder or dated-folder instruction without changing the folder", async () => {
  const out = mkdtempSync(join(tmpdir(), "tmx-existing-"));
  writeFileSync(join(out, "keep.txt"), "keep");
  const lines: string[] = [];
  const error = spyOn(console, "error").mockImplementation((line: string) => { lines.push(line); });
  try {
    expect(await main(["--claude", claudeFixture(), "--codex", "none", "--out", out])).toBe(2);
  } finally { error.mockRestore(); }
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(out);
  expect(lines[0]).toContain("new folder name");
  expect(lines[0]).toContain("created for you");
  expect(lines[0]).toContain("leave --out off");
  expect(lines[0]).toContain("dated folder");
  expect(readdirSync(out)).toEqual(["keep.txt"]);
  expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("keep");
});

test("[unit] downloaded mapper header names bun map.ts", () => {
  const header = readFileSync(join(import.meta.dir, "map.ts"), "utf8").split("\n")[2] ?? "";
  expect(header).toContain("bun map.ts");
  expect(header).not.toContain("scripts/map.ts");
});

const asst = (o: { id: string; ts: string; model?: string; usage?: Record<string, number>; session?: string; cwd?: string }) =>
  JSON.stringify({
    type: "assistant",
    sessionId: o.session ?? "s-1",
    uuid: `u-${o.id}-${o.ts}`,
    timestamp: o.ts,
    cwd: o.cwd ?? "/home/x/projects/alpha",
    isSidechain: false,
    message: { id: o.id, model: o.model ?? "claude-opus-5-5", content: [{ type: "text", text: "SECRET BODY" }], usage: o.usage ?? { input_tokens: 1, output_tokens: 1 } },
  });
const cap = (ts: string, text: string, session = "s-1") =>
  JSON.stringify({ type: "assistant", sessionId: session, uuid: `cap-${ts}-${session}`, timestamp: ts, isApiErrorMessage: true, error: "rate_limit", message: { id: "x", model: "<synthetic>", content: [{ type: "text", text }] } });
const apiErr = (ts: string, error: string) =>
  JSON.stringify({ type: "assistant", sessionId: "s-1", uuid: `e-${ts}`, timestamp: ts, isApiErrorMessage: true, error, message: { id: "y", model: "<synthetic>", content: [{ type: "text", text: "model gone" }] } });

describe("[unit] claude lines", () => {
  test("[unit] notice text gives window and reset reading", () => {
    expect(classifyClaudeNotice("You've hit your session limit · resets 10:10pm (Europe/Warsaw)")).toEqual({ window: "short", reset: "10:10pm (Europe/Warsaw)" });
    expect(classifyClaudeNotice("You've hit your weekly limit · resets Oct 20")).toEqual({ window: "weekly", reset: "Oct 20" });
    expect(classifyClaudeNotice("You've hit your limit · resets 9pm (Europe/Warsaw)").window).toBe("unknown");
  });

  test("[unit] model_not_found is an error, not a cap; synthetic usage is skipped; non-usage lines are not parsed", () => {
    expect(parseClaudeLine(apiErr("2026-10-14T10:00:00Z", "model_not_found"), { subagent: false, order: 0 })).toEqual({ kind: "error", category: "model_not_found", ts: Date.parse("2026-10-14T10:00:00Z") });
    expect(parseClaudeLine(JSON.stringify({ type: "user", message: { content: "You've hit your limit" } }), { subagent: false, order: 0 }).kind).toBe("skip");
    expect(parseClaudeLine('{"type":"assistant","usage" BROKEN', { subagent: false, order: 0 }).kind).toBe("malformed");
  });

  test("[unit] worktree cwd rolls up to the repo", () => {
    expect(projectOf("/home/x/projects/tokenmax-wt/20261016-fix-history")).toBe("tokenmax");
    expect(projectOf(["", "home", "x", "projects", "jevnotjev", ".claude", "worktrees", "a1"].join("/"))).toBe("jevnotjev");
    expect(projectOf("/home/x/projects/alpha")).toBe("alpha");
  });
});

describe("[unit] episodes", () => {
  test("[unit] same window and reset across sessions is one episode; same reading next day is a new one", () => {
    const o = (ts: string, session: string): CapOccurrence => ({ source: "claude", ts: Date.parse(ts), window: "unknown", reset: "9pm", session, eventId: "" });
    const eps = groupEpisodes([o("2026-10-14T10:00:00Z", "a"), o("2026-10-14T11:00:00Z", "b"), o("2026-10-14T12:00:00Z", "a"), o("2026-10-15T12:00:00Z", "a")]);
    expect(eps.length).toBe(2);
    expect(eps[0]?.occurrences).toBe(3);
    expect(eps[0]?.sessions.size).toBe(2);
  });
});

function claudeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tmx-claude-"));
  const proj = join(root, "-Users-x-projects-alpha");
  mkdirSync(join(proj, "s-1", "subagents"), { recursive: true });
  writeFileSync(
    join(proj, "s-1.jsonl"),
    [
      asst({ id: "m1", ts: "2026-10-14T09:00:00Z", usage: { input_tokens: 10, output_tokens: 1 } }),
      asst({ id: "m1", ts: "2026-10-14T09:00:02Z", usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } }),
      asst({ id: "m2", ts: "2026-10-14T09:05:00Z", model: "claude-sonnet-5-5", usage: { input_tokens: 5, output_tokens: 7 } }),
      cap("2026-10-14T09:10:00Z", "You've hit your limit · resets 9pm (Europe/Warsaw)"),
      cap("2026-10-14T09:11:00Z", "You've hit your limit · resets 9pm (Europe/Warsaw)"),
      cap("2026-10-14T09:12:00Z", "You've hit your session limit · resets 2pm (Europe/Warsaw)"),
      apiErr("2026-10-14T09:13:00Z", "model_not_found"),
      '{"type":"assistant","usage" BROKEN',
      JSON.stringify({ type: "user", sessionId: "s-1", message: { content: "SECRET PROMPT /home/x/acme" } }),
      asst({ id: "old", ts: "2026-09-01T09:00:00Z", usage: { input_tokens: 999, output_tokens: 999 } }),
    ].join("\n"),
  );
  writeFileSync(
    join(proj, "s-1", "subagents", "agent-1.jsonl"),
    [asst({ id: "m3", ts: "2026-10-14T09:20:00Z", session: "s-sub", model: "claude-haiku-5-5", usage: { input_tokens: 4, output_tokens: 2 } }), cap("2026-10-14T09:21:00Z", "You've hit your limit · resets 9pm (Europe/Warsaw)", "s-sub")].join("\n"),
  );
  return root;
}

const tc = (ts: string, totals: Record<string, number>, rl?: Record<string, unknown>) =>
  JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: totals }, rate_limits: rl ?? { limit_id: "codex", primary: { used_percent: 40, window_minutes: 10080, resets_at: 1760900000 }, secondary: null, rate_limit_reached_type: null } } });
const tot = (input: number, output: number, cached = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });

function codexFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tmx-codex-"));
  const day = join(root, "2026", "10", "14");
  mkdirSync(day, { recursive: true });
  // fresh session: first total counts in full; then 100 -> 150 -> 10 (decrease, new baseline) -> 30
  writeFileSync(
    join(day, "rollout-a.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-10-14T08:00:00Z", type: CODEX_META_TYPE, payload: { id: "cx-a", cwd: "/home/x/projects/beta", base_instructions: "SECRET" } }),
      JSON.stringify({ timestamp: "2026-10-14T08:00:01Z", type: "turn_context", payload: { model: "gpt-x" } }),
      tc("2026-10-14T08:01:00Z", tot(100, 10, 40)),
      tc("2026-10-14T08:02:00Z", tot(150, 15, 60), { limit_id: "codex", primary: { used_percent: 100, window_minutes: 10080, resets_at: 1760900000 }, secondary: null, rate_limit_reached_type: null }),
      tc("2026-10-14T08:03:00Z", tot(10, 2, 0), { limit_id: "codex", primary: { used_percent: 100, window_minutes: 10080, resets_at: 1760900000 }, secondary: null, rate_limit_reached_type: null }),
      tc("2026-10-14T08:04:00Z", tot(30, 5, 0)),
    ].join("\n"),
  );
  // forked session: first total is an uncounted baseline
  writeFileSync(
    join(day, "rollout-b.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-10-14T09:00:00Z", type: CODEX_META_TYPE, payload: { id: "cx-b", parent_thread_id: "cx-a", forked_from_id: "cx-a" } }),
      tc("2026-10-14T09:01:00Z", tot(500, 50)),
      tc("2026-10-14T09:02:00Z", tot(525, 54)),
    ].join("\n"),
  );
  return root;
}

describe("[integration] scan and report", () => {
  test("[integration] claude: dedup, subagent file, caps grouped across sessions, exclusions", async () => {
    const s = summarise(await scanClaude(claudeFixture(), FROM, TO), null);
    const c = s.claude;
    expect(c?.sessions).toBe(2);
    expect(c?.subagentSessions).toBe(1);
    expect(c?.usageRecords).toBe(4);
    expect(c?.messages).toBe(3);
    expect(c?.byModel.get("claude-opus-5-5")).toEqual({ input: 12, output: 3, cacheRead: 100, cacheWrite: 20, messages: 1 });
    expect(c?.capOccurrences).toBe(4);
    expect(c?.capEpisodes).toEqual({ short: 1, weekly: 0, unknown: 1 });
    expect(s.episodes.find((e) => e.window === "unknown")?.sessions.size).toBe(2);
    expect(c?.errors.get("model_not_found")).toBe(1);
    expect(c?.cov.malformed).toBe(1);
    expect(c?.cov.outOfPeriod).toBe(1);
  });

  test("[integration] codex: start record counts the first total, decrease and fork are baselines, 100% window is a weekly cap", async () => {
    const s = summarise(null, await scanCodex(codexFixture(), FROM, TO));
    const x = s.codex;
    expect(x?.sessions).toBe(2);
    expect(x?.subagentSessions).toBe(1);
    // a: 100 + 50 + 20 = 170 input, 10 + 5 + 3 = 18 output; b: 25 input, 4 output
    expect(x?.totals.input).toBe(195);
    expect(x?.totals.output).toBe(22);
    expect(x?.totals.cachedInput).toBe(60);
    expect(x?.baselines).toBe(2);
    expect(x?.capOccurrences).toBe(2);
    expect(x?.capEpisodes).toEqual({ short: 0, weekly: 1, unknown: 0 });
    // #411: output and uncached input per model, never input + output
    expect(x?.byModel.get("gpt-x")).toEqual({ output: 18, uncachedInput: 110, cachedInput: 60 });
  });

  test("[integration] CLI writes both files, share draft is clean, refuses to overwrite", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "tmx-out-")), "r");
    const argv = ["--claude", claudeFixture(), "--codex", codexFixture(), "--from", "2026-10-09", "--to", "2026-10-16", "--out", out, "--by-project"];
    expect(await main(argv)).toBe(0);
    const priv = readFileSync(join(out, "private-report.md"), "utf8");
    const share = readFileSync(join(out, "share-draft.md"), "utf8");
    // The evidence index may name a source file (a Claude file is named after its session); nothing else in the report may.
    const privOutsideIndex = priv.replace(/## Evidence index[\s\S]*?(?=\n## )/, "");
    for (const banned of ["SECRET", "acme", "s-1", "cx-a", "/home/"]) {
      expect(share.includes(banned)).toBe(false);
      expect(privOutsideIndex.includes(banned)).toBe(false);
    }
    expect(priv.includes("| alpha |")).toBe(true);
    expect(share.includes("DRAFT - NOT APPROVED FOR SHARING")).toBe(true);
    expect(scanShare(share)).toEqual([]);
    expect(await main(argv)).toBe(2);
  });

  test("[unit] share scan flags paths, ids and timestamps", () => {
    expect(scanShare(`/home/x ${fakeUuid()} 2026-10-14T08:00`)).toEqual(["local path", "session or account id", "exact timestamp"]);
  });
});

describe("[integration] codex window reading", () => {
  test("[integration] keeps the latest primary reading", async () => {
    const x = summarise(null, await scanCodex(codexFixture(), FROM, TO)).codex;
    expect(x?.lastReading?.usedPercent).toBe(40);
    expect(x?.lastReading?.windowMinutes).toBe(10080);
  });
});

// ---------- PR #241 review batch (#238) ----------

const capWithId = (ts: string, uuid: string) =>
  JSON.stringify({ type: "assistant", sessionId: "s-1", uuid, timestamp: ts, isApiErrorMessage: true, error: "rate_limit", message: { id: "x", model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit · resets 9pm (Europe/Warsaw)" }] } });
const meta = (ts: string, id: string, extra: Record<string, string> = {}) => JSON.stringify({ timestamp: ts, type: CODEX_META_TYPE, payload: { id, cwd: "/home/x/projects/beta", ...extra } });
const turn = (ts: string, model: string) => JSON.stringify({ timestamp: ts, type: "turn_context", payload: { model } });
const ENV = { home: "/nonexistent-home", now: Date.parse("2026-10-16T12:00:00Z"), cwd: tmpdir() };

function codexFiles(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "tmx-review-codex-"));
  const day = join(root, "2026", "10", "14");
  mkdirSync(day, { recursive: true });
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(day, name), lines.join("\n"));
  return root;
}
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try { return await run(); } finally { log.mockRestore(); err.mockRestore(); }
}

describe("[integration] review #241: output folder", () => {
  test("[integration] two runs started together into one --out: exactly one writes, the other refuses", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "tmx-race-")), "r");
    const argv = ["--claude", claudeFixture(), "--codex", "none", "--from", "2026-10-09", "--to", "2026-10-16", "--out", out];
    const codes = await quietly(() => Promise.all([main(argv), main(argv)]));
    expect([...codes].sort()).toEqual([0, 2]);
  });
});

describe("[unit] review #241: CLI arguments", () => {
  const bad: string[][] = [
    ["--claud", "x"], ["--claude", "--share"], ["--out"], ["stray"], ["--days"],
    ["--days", "0"], ["--days", "0.5"], ["--days", "-1"], ["--days", "7d"],
    ["--from", "2026-02-30", "--to", "2026-03-01"], ["--from", "2026-10-09"], ["--to", "2026-10-16"],
    ["--days", "7", "--from", "2026-10-09", "--to", "2026-10-16"], ["--from", "20261009", "--to", "2026-10-16"],
  ];
  test("[unit] parseArgs refuses unknown flags, missing values, stray words and malformed periods", () => {
    const accepted = bad.filter((argv) => { try { parseArgs(argv, ENV); return true; } catch { return false; } });
    expect(accepted).toEqual([]);
  });
  test("[unit] parseArgs accepts the documented forms", () => {
    expect(parseArgs(["--days", "7", "--claude", "none", "--codex", "none", "--share"], ENV).days).toBe(7);
    expect(parseArgs(["--from", "2026-10-09", "--to", "2026-10-16", "--claude", "none", "--codex", "none"], ENV).days).toBe(8);
    expect(parseArgs(["--days", "400", "--claude", "none", "--codex", "none"], ENV).days).toBe(400);
  });
  test("[integration] main answers a bad argument or a source that is not a folder with exit 2 and writes nothing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tmx-badarg-"));
    const file = join(parent, "not-a-folder.jsonl");
    writeFileSync(file, "");
    const codes: number[] = [];
    for (const argv of [["--out"], ["--claude", file, "--codex", "none", "--out", join(parent, "a")], ["--codex", file, "--claude", "none", "--out", join(parent, "b")]]) {
      codes.push(await quietly(() => main(argv)));
    }
    expect(codes).toEqual([2, 2, 2]);
    expect(existsSync(join(parent, "a")) || existsSync(join(parent, "b"))).toBe(false);
  });
});

describe("[integration] review #241: records", () => {
  test("[integration] an old Claude API error in a recent file is out of period, not counted", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmx-err-"));
    writeFileSync(join(root, "s.jsonl"), [apiErr("2026-09-20T10:00:00Z", "authentication_failed"), apiErr("2026-10-14T10:00:00Z", "model_not_found")].join("\n"));
    const c = summarise(await scanClaude(root, FROM, TO), null).claude;
    expect(c?.errors.get("authentication_failed")).toBeUndefined();
    expect(c?.errors.get("model_not_found")).toBe(1);
    expect(c?.cov.outOfPeriod).toBe(1);
  });

  test("[integration] three cap notices with one event id are 3 occurrences, 1 distinct event, 1 episode", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmx-ev-"));
    writeFileSync(join(root, "s.jsonl"), ["2026-10-14T09:10:00Z", "2026-10-14T09:11:00Z", "2026-10-14T09:12:00Z"].map((ts) => capWithId(ts, "ev-1")).join("\n"));
    const s = summarise(await scanClaude(root, FROM, TO), null);
    expect(s.claude?.capOccurrences).toBe(3);
    expect(s.claude?.capEvents).toBe(1);
    expect(s.episodes.length).toBe(1);
    expect(renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Claude Code"] })).toContain("| Claude Code | 3 | 1 | 1 |");
  });

  test("[integration] Codex usage is credited to the model active at each reading", async () => {
    const root = codexFiles({ "rollout-m.jsonl": [meta("2026-10-14T08:00:00Z", "cx-m"), turn("2026-10-14T08:00:01Z", "model-a"), tc("2026-10-14T08:01:00Z", tot(100, 10)), turn("2026-10-14T08:02:00Z", "model-b"), tc("2026-10-14T08:03:00Z", tot(130, 20))] });
    const x = summarise(null, await scanCodex(root, FROM, TO)).codex;
    expect(x?.byModel.get("model-a")).toEqual({ output: 10, uncachedInput: 100, cachedInput: 0 });
    expect(x?.byModel.get("model-b")).toEqual({ output: 10, uncachedInput: 30, cachedInput: 0 });
  });

  test("[integration] a session with only a baseline still counts its baseline; a cap-only session is a session", async () => {
    const rl100 = { limit_id: "codex", primary: { used_percent: 100, window_minutes: 300, resets_at: 1760900000 }, secondary: null, rate_limit_reached_type: null };
    const root = codexFiles({
      "rollout-f.jsonl": [meta("2026-10-14T08:00:00Z", "cx-f", { forked_from_id: "cx-0" }), tc("2026-10-14T08:01:00Z", tot(500, 50))],
      "rollout-c.jsonl": [meta("2026-09-01T08:00:00Z", "cx-c"), tc("2026-10-14T09:01:00Z", tot(700, 70), rl100)],
    });
    const x = summarise(null, await scanCodex(root, FROM, TO)).codex;
    expect(x?.baselines).toBe(2);
    expect(x?.sessions).toBe(1);
    expect(x?.capOccurrences).toBe(1);
  });

  test("[integration] a missing or non-numeric used_percent is not a reading; an out-of-range resets_at renders as none", async () => {
    const slot = (used: unknown, resets: number) => ({ limit_id: "codex", primary: { used_percent: used, window_minutes: 10080, resets_at: resets }, secondary: null, rate_limit_reached_type: null });
    const root = codexFiles({ "rollout-r.jsonl": [meta("2026-10-14T08:00:00Z", "cx-r"), tc("2026-10-14T08:01:00Z", tot(10, 1), slot(37, 1760900000)), tc("2026-10-14T08:02:00Z", tot(20, 2), slot("high", 1760900000)), tc("2026-10-14T08:03:00Z", tot(30, 3), slot(undefined, 1760900000))] });
    const x = summarise(null, await scanCodex(root, FROM, TO)).codex;
    expect(x?.lastWeekly?.usedPercent).toBe(37);
    expect(x?.badReadings).toBe(2);
    const far = codexFiles({ "rollout-z.jsonl": [meta("2026-10-14T08:00:00Z", "cx-z"), tc("2026-10-14T08:01:00Z", tot(10, 1), slot(40, 9_000_000_000_000))] });
    const s = summarise(null, await scanCodex(far, FROM, TO));
    let text = "";
    expect(() => { text = renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Codex"] }); }).not.toThrow();
    expect(text).toContain("resets_at none");
  });

  test("[integration] the coverage table reports files that could not be read", async () => {
    const s = summarise(await scanClaude(claudeFixture(), FROM, TO), null);
    expect(renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Claude Code"] })).toContain("| Source | Files | Unreadable | Lines |");
  });
});

describe("[integration] review #241 round 2", () => {
  const CAP = { limit_id: "codex", primary: { used_percent: 100, window_minutes: 10080, resets_at: 1760900000 }, secondary: null, rate_limit_reached_type: null };
  const sessionFile = (id: string, totals: Array<[string, number, number]>, withCap = false): string =>
    [JSON.stringify({ timestamp: "2026-10-14T08:00:00Z", type: CODEX_META_TYPE, payload: { id } }), ...totals.map(([ts, i, o], k) => tc(ts, tot(i, o), withCap && k === 0 ? CAP : undefined))].join("\n");

  test("[integration] the same Codex session id in two files counts once; the newer history wins; its caps are not doubled", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmx-codex-dup-"));
    const day = join(root, "2026", "10", "14");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-copy.jsonl"), sessionFile("cx-dup", [["2026-10-14T08:01:00Z", 100, 10]], true));
    writeFileSync(join(day, "rollout-full.jsonl"), sessionFile("cx-dup", [["2026-10-14T08:01:00Z", 100, 10], ["2026-10-14T08:02:00Z", 300, 30]], true));
    const st = await scanCodex(root, FROM, TO);
    const s = summarise(null, st);
    expect(st.duplicateFiles).toBe(1);
    expect(s.codex?.sessions).toBe(1);
    expect(s.codex?.totals.input).toBe(300);
    expect(s.codex?.totals.output).toBe(30);
    expect(s.codex?.capOccurrences).toBe(1);
    expect(s.evidence.map((e) => e.files)).toEqual([["2026/10/14/rollout-full.jsonl"]]);
    const text = renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Codex"] });
    expect(text).toContain("1 Codex file(s) repeated a session id already read");
  });

  test("[integration] duplicate Codex files: the newer history wins over a larger total (counter reset) and over an equal total with a later cap", async () => {
    const reset = mkdtempSync(join(tmpdir(), "tmx-codex-reset-"));
    mkdirSync(join(reset, "d"), { recursive: true });
    writeFileSync(join(reset, "d", "a-copy.jsonl"), sessionFile("cx-r", [["2026-10-14T08:01:00Z", 100, 10], ["2026-10-14T08:02:00Z", 120, 12]]));
    writeFileSync(join(reset, "d", "b-newer.jsonl"), sessionFile("cx-r", [["2026-10-14T08:01:00Z", 100, 10], ["2026-10-14T08:02:00Z", 120, 12], ["2026-10-14T08:03:00Z", 10, 1], ["2026-10-14T08:04:00Z", 40, 4]], false));
    const r = summarise(null, await scanCodex(reset, FROM, TO)).codex;
    // 100 + 20 before the reset, the reset is an uncounted baseline, then 30 after it.
    expect(r?.totals.input).toBe(150);
    const tie = mkdtempSync(join(tmpdir(), "tmx-codex-tie-"));
    mkdirSync(join(tie, "d"), { recursive: true });
    writeFileSync(join(tie, "d", "a-copy.jsonl"), sessionFile("cx-t", [["2026-10-14T08:01:00Z", 100, 10]]));
    writeFileSync(join(tie, "d", "b-newer.jsonl"), [sessionFile("cx-t", [["2026-10-14T08:01:00Z", 100, 10]]), tc("2026-10-14T08:05:00Z", tot(100, 10), CAP)].join("\n"));
    const t = summarise(null, await scanCodex(tie, FROM, TO)).codex;
    expect(t?.totals.input).toBe(100);
    expect(t?.capOccurrences).toBe(1);
  });

  test("[integration] a session read from several files lists every file in the evidence index", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmx-claude-multi-"));
    const proj = join(root, "-Users-x-projects-alpha");
    mkdirSync(join(proj, "s-9", "subagents"), { recursive: true });
    writeFileSync(join(proj, "s-9.jsonl"), asst({ id: "p1", ts: "2026-10-14T09:00:00Z", session: "s-9" }));
    writeFileSync(join(proj, "s-9", "subagents", "agent-7.jsonl"), asst({ id: "p2", ts: "2026-10-14T09:01:00Z", session: "s-9" }));
    const text = renderPrivate(summarise(await scanClaude(root, FROM, TO), null), { from: "2026-10-09", to: "2026-10-16", byProject: true, sources: ["Claude Code"] });
    expect(text).toContain("| -Users-x-projects-alpha/s-9.jsonl; -Users-x-projects-alpha/s-9/subagents/agent-7.jsonl |");
  });

  test("[integration] the private report has an evidence index: aliases, source-relative files, no project name, and episodes point at it", async () => {
    const s = summarise(await scanClaude(claudeFixture(), FROM, TO), await scanCodex(codexFixture(), FROM, TO));
    const text = renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Claude Code", "Codex"] });
    const index = text.slice(text.indexOf("## Evidence index"), text.indexOf("## Proposals"));
    expect(index).toContain("| Session | Source | Source file |");
    expect(index).toMatch(/\| session-\d{3} \| claude \| dir-[0-9a-f]{8}\/s-1\.jsonl \|/);
    expect(index).toContain("2026/10/14/rollout-a.jsonl");
    expect(index).toMatch(/dir-[0-9a-f]{8}\/s-1\/subagents\/agent-1\.jsonl/);
    expect(index).not.toContain("alpha");
    expect(index).not.toContain("SECRET");
    // Every cap episode names the sessions it came from.
    const episodes = text.slice(text.indexOf("| Episode |"), text.indexOf("## Evidence index"));
    expect(episodes).toContain("| Evidence |");
    expect(episodes).toMatch(/session-00\d/);
    // The two sessions with caps come before the one without.
    const aliasOfNoCap = s.evidence.find((e) => e.caps === 0)?.alias ?? "";
    expect(s.evidence.slice(0, s.evidence.filter((e) => e.caps > 0).length).every((e) => e.caps > 0)).toBe(true);
    expect(aliasOfNoCap).not.toBe("session-001");
    const named = renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: true, sources: ["Claude Code", "Codex"] });
    expect(named).toContain("-Users-x-projects-alpha/s-1.jsonl");
  });

  test("[integration] --share is refused when a folder could not be read; the report says the totals are understated", async () => {
    const root = claudeFixture();
    const locked = join(root, "-Users-x-projects-locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "x.jsonl"), asst({ id: "mx", ts: "2026-10-14T09:00:00Z" }));
    chmodSync(locked, 0o000);
    const out = join(mkdtempSync(join(tmpdir(), "tmx-unread-")), "r");
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    let code = -1;
    try { code = await main(["--share", "--claude", root, "--codex", "none", "--out", out, "--now", "2026-10-16T12:00:00Z"]); } finally { spy.mockRestore(); chmodSync(locked, 0o755); }
    const output = lines.join("\n");
    expect(code).toBe(1);
    expect(output).toContain("Share skipped: 1 folder(s) or file(s) could not be read");
    expect(output).not.toContain("#m=");
    expect(readFileSync(join(out, "private-report.md"), "utf8")).toContain("could not be read: the totals below are understated");
    expect(readFileSync(join(out, "share-draft.md"), "utf8")).toContain("1 folders or files unreadable");
  });
});

test("[unit] #409 over 7 days the report states per-week averages, each total divided evenly by days / 7; 7 days or fewer has none", async () => {
  const totals = { sessions: 3296, claudeOutput: 10_000_000, codexOutput: 7_200_000, capHits: 3 };
  expect(perWeekLine({ days: 56, ...totals })).toBe("Per week on average over 8 weeks (56 days): 412 sessions, 1,250,000 Claude output tokens, 900,000 Codex output tokens, 0.4 cap hits. Totals divided evenly by days / 7; not a measured week.");
  expect(perWeekLine({ days: 30, ...totals })).toBe("Per week on average over 4.3 weeks (30 days): 769 sessions, 2,333,333 Claude output tokens, 1,680,000 Codex output tokens, 0.7 cap hits. Totals divided evenly by days / 7; not a measured week.");
  expect(perWeekLine({ days: 7, ...totals })).toBeNull();
  expect(perWeekLine({ days: 1, ...totals })).toBeNull();
  const s = summarise(await scanClaude(claudeFixture(), FROM, TO), await scanCodex(codexFixture(), FROM, TO));
  const t = weekTotals(s);
  const long = renderPrivate(s, { from: "2026-08-22", to: "2026-10-16", byProject: false, sources: ["Claude Code", "Codex"], days: 56 });
  expect(long).toContain(`## Per week on average\n\n${perWeekLine({ days: 56, ...t }) ?? "missing"}\n`);
  expect(renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Claude Code", "Codex"], days: 7 })).not.toContain("Per week on average");
  expect(t.sessions).toBe((s.claude?.sessions ?? 0) + (s.codex?.sessions ?? 0));
  expect(t.capHits).toBe(s.episodes.length);
  // A source that was not read is left out of the average, never shown as 0 (codex-discover on #410).
  const codexOnly = weekTotals(summarise(null, await scanCodex(codexFixture(), FROM, TO)));
  expect(codexOnly.claudeOutput).toBeNull();
  const line = perWeekLine({ days: 56, ...codexOnly }) ?? "missing";
  expect(line).not.toContain("Claude output");
  expect(line).toContain("Codex output tokens");
  expect(perWeekLine({ days: 56, ...weekTotals(summarise(await scanClaude(claudeFixture(), FROM, TO), null)) })).not.toContain("Codex output");
});
