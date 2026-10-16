// [unit] tokenmax-map parser. Synthetic lines in the record shapes observed in real local history on 2026-10-16.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapOccurrence, CODEX_META_TYPE, classifyClaudeNotice, groupEpisodes, main, parseClaudeLine, projectOf, scanClaude, scanCodex, scanShare, summarise } from "./map.ts";

const FROM = Date.parse("2026-10-09T00:00:00Z");
const TO = Date.parse("2026-10-16T23:59:59Z");
/** A UUID-shaped string built at runtime, so no literal id sits in the source. */
const fakeUuid = (): string => [8, 4, 4, 4, 12].map((len) => "a1".repeat(len).slice(0, len)).join("-");

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
    expect(parseClaudeLine(apiErr("2026-10-14T10:00:00Z", "model_not_found"), { subagent: false, order: 0 })).toEqual({ kind: "error", category: "model_not_found" });
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
    expect(x?.byModel.get("gpt-x")).toBe(188);
  });

  test("[integration] CLI writes both files, share draft is clean, refuses to overwrite", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "tmx-out-")), "r");
    const argv = ["--claude", claudeFixture(), "--codex", codexFixture(), "--from", "2026-10-09", "--to", "2026-10-16", "--out", out, "--by-project"];
    expect(await main(argv)).toBe(0);
    const priv = readFileSync(join(out, "private-report.md"), "utf8");
    const share = readFileSync(join(out, "share-draft.md"), "utf8");
    for (const banned of ["SECRET", "acme", "s-1", "cx-a", "/home/"]) {
      expect(share.includes(banned)).toBe(false);
      expect(priv.includes(banned)).toBe(false);
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
