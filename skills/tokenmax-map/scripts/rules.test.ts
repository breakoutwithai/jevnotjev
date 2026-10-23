// [unit] [integration] tokenmax-map 0.4.0 rules: #411 output tables, per-session limit, week windows, TokenMax score,
// helper size, the "Jev or not" table and the --dashboard page. Synthetic records in the shapes the mapper documents.
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_META_TYPE,
  helperOf,
  jevOrNot,
  jevVerdict,
  main,
  paceRule,
  renderDashboard,
  renderPrivate,
  scanClaude,
  scanCodex,
  scoreOf,
  scoreThresholds,
  summarise,
} from "./map.ts";

const FROM = Date.parse("2026-10-09T00:00:00Z");
const TO = Date.parse("2026-10-16T23:59:59Z");
const WEEK = 10080;
/** Em and en dash, built from code points so the source holds neither glyph. */
const DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];

const asst = (o: { id: string; ts: string; session: string; model?: string; output: number; input?: number; tools?: string[] }): string =>
  JSON.stringify({
    type: "assistant", sessionId: o.session, uuid: `u-${o.id}-${o.ts}`, timestamp: o.ts, cwd: "/home/x/projects/alpha", isSidechain: false,
    message: {
      id: o.id, model: o.model ?? "claude-opus-5-5",
      content: [{ type: "text", text: "SECRET BODY" }, ...(o.tools ?? []).map((id) => ({ type: "tool_use", id, name: "Bash", input: { command: "SECRET CMD" } }))],
      usage: { input_tokens: o.input ?? 1, output_tokens: o.output },
    },
  });
const cap = (ts: string, text: string, session: string): string =>
  JSON.stringify({ type: "assistant", sessionId: session, uuid: `cap-${ts}-${session}`, timestamp: ts, isApiErrorMessage: true, error: "rate_limit", message: { id: "x", model: "<synthetic>", content: [{ type: "text", text }] } });
const meta = (ts: string, id: string): string => JSON.stringify({ timestamp: ts, type: CODEX_META_TYPE, payload: { id, cwd: "/home/x/projects/beta" } });
const turn = (ts: string, model: string): string => JSON.stringify({ timestamp: ts, type: "turn_context", payload: { model } });
const call = (ts: string, kind = "function_call", id = `c-${ts}`): string => JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: kind, name: "shell", arguments: "SECRET ARGS", call_id: id } });
const callOut = (ts: string): string => JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "SECRET OUT" } });
const tc = (ts: string, input: number, cached: number, output: number, used = 10, resetsAt = 1760900000, wm = WEEK): string =>
  JSON.stringify({
    timestamp: ts, type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 } },
      rate_limits: { limit_id: "codex", primary: { used_percent: used, window_minutes: wm, resets_at: resetsAt }, secondary: null, rate_limit_reached_type: null },
    },
  });

function claudeDir(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "tmx-rules-claude-"));
  const proj = join(root, "-Users-x-projects-alpha");
  mkdirSync(proj, { recursive: true });
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(proj, name), lines.join("\n"));
  return root;
}
function codexDir(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "tmx-rules-codex-"));
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

// 2026-10-20T00:00:00Z as epoch seconds: a weekly window that started 2026-10-13T00:00:00Z.
const RESET_OPEN = Date.parse("2026-10-20T00:00:00Z") / 1000;
// 2026-10-15T00:00:00Z: a window that closed inside the period.
const RESET_CLOSED = Date.parse("2026-10-15T00:00:00Z") / 1000;

function mixedSources(): { claude: string; codex: string } {
  const claude = claudeDir({
    "s-big.jsonl": [
      asst({ id: "b1", ts: "2026-10-14T09:00:00Z", session: "s-big", output: 300_000, tools: ["t1", "t2"] }),
      // the same message written again with a later snapshot and one more tool block: tool ids count once
      asst({ id: "b1", ts: "2026-10-14T09:00:01Z", session: "s-big", output: 300_000, tools: ["t1", "t2", "t3"] }),
      asst({ id: "b2", ts: "2026-10-14T10:00:00Z", session: "s-big", output: 1_000, model: "claude-sonnet-5-5" }),
      cap("2026-10-14T10:05:00Z", "You've hit your session limit · resets 2pm (Europe/Warsaw)", "s-big"),
    ],
    "s-mid.jsonl": [asst({ id: "m1", ts: "2026-10-14T11:00:00Z", session: "s-mid", output: 50_000 })],
    "s-small.jsonl": [asst({ id: "k1", ts: "2026-10-15T11:00:00Z", session: "s-small", output: 500 })],
  });
  const codex = codexDir({
    "rollout-a.jsonl": [
      meta("2026-10-14T08:00:00Z", "cx-a"), turn("2026-10-14T08:00:01Z", "gpt-x"),
      call("2026-10-14T08:00:30Z"), callOut("2026-10-14T08:00:31Z"), call("2026-10-14T08:00:40Z", "custom_tool_call"),
      tc("2026-10-14T08:01:00Z", 1_000, 900, 40, 20, RESET_CLOSED),
      tc("2026-10-14T20:00:00Z", 3_000, 2_600, 100, 100, RESET_CLOSED),
      tc("2026-10-15T08:00:00Z", 4_000, 3_400, 150, 30, RESET_OPEN),
      tc("2026-10-15T09:00:00Z", 5_000, 4_300, 160, 40, RESET_OPEN + 2),
    ],
  });
  return { claude, codex };
}

describe("[unit] #411 day and model tables compare output tokens", () => {
  test("[integration] Codex day and model tables give output and uncached input; Claude day table gives output", async () => {
    const { claude, codex } = mixedSources();
    const s = summarise(await scanClaude(claude, FROM, TO), await scanCodex(codex, FROM, TO));
    expect(s.codex?.byModel.get("gpt-x")).toEqual({ output: 160, uncachedInput: 700, cachedInput: 4_300 });
    expect(s.codex?.byDay.get("2026-10-14")).toEqual({ output: 100, uncachedInput: 400 });
    expect(s.codex?.byDay.get("2026-10-15")).toEqual({ output: 60, uncachedInput: 300 });
    expect(s.claude?.byDay.get("2026-10-14")?.output).toBe(351_000);
    const text = renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Claude Code", "Codex"] });
    expect(text).toContain("| Model | Output | Uncached input | Cached input |");
    expect(text).toContain("| gpt-x | 160 | 700 | 4,300 |");
    expect(text).toContain("| Day (UTC) | Output | Uncached input |");
    expect(text).toContain("| 2026-10-14 | 100 | 400 |");
    expect(text).toContain("| Day (UTC) | Output | Uncached input | Cache write |");
    expect(text).toContain("| 2026-10-14 | 351,000 |");
    expect(text).not.toContain("Day, model and project totals use input + output");
  });
});

describe("[unit] per-session limit and week windows are rule outputs", () => {
  test("[integration] a session with a cap record says yes; the others say no; tool calls and output are per session", async () => {
    const { claude, codex } = mixedSources();
    const s = summarise(await scanClaude(claude, FROM, TO), await scanCodex(codex, FROM, TO));
    const big = s.evidence.find((e) => e.session === "s-big");
    const mid = s.evidence.find((e) => e.session === "s-mid");
    const cx = s.evidence.find((e) => e.session === "cx-a");
    expect(big?.limitHit).toBe(true);
    expect(mid?.limitHit).toBe(false);
    expect(cx?.limitHit).toBe(true);
    expect(big?.output).toBe(301_000);
    expect(big?.toolCalls).toBe(3);
    expect(cx?.toolCalls).toBe(2);
    expect(cx?.output).toBe(160);
    expect(big?.modelMix).toEqual({ "claude-opus": 100, "claude-sonnet": 0 });
    const text = renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Claude Code", "Codex"] });
    expect(text).toContain("| Session | Source | Source file | First (UTC) | Last (UTC) | Records | Cap notices | Limit hit | Output | Tool calls | Score | Helper (rule) |");
    expect(text).not.toContain("SECRET");
  });

  test("[integration] Codex weekly windows: readings a few seconds apart are one window; hit and pace come from the rule", async () => {
    const { codex } = mixedSources();
    const s = summarise(null, await scanCodex(codex, FROM, TO));
    const weeks = s.weeks;
    expect(weeks.length).toBe(2);
    const closed = weeks.find((w) => w.resetsAt === RESET_CLOSED * 1000);
    const open = weeks.find((w) => w.resetsAt === RESET_OPEN * 1000);
    expect(closed?.hit).toBe(true);
    expect(closed?.closed).toBe(true);
    expect(open?.hit).toBe(false);
    expect(open?.closed).toBe(false);
    expect(open?.usedPercent).toBe(40);
    expect(open?.readings).toBe(2);
    // read 2026-10-15T09:00 in a window 2026-10-13T00:00 to 2026-10-20T00:00: 57h of 168h elapsed
    expect(open?.elapsedPercent).toBeCloseTo((57 / 168) * 100, 1);
    const text = renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Codex"] });
    expect(text).toContain("## Week windows");
    expect(text).toContain("| Source | Window resets (UTC) | Readings | Last used | Max used | Predicted at (elapsed) | Used then | Pace projection | Pace rule: on course to hit | Weekly limit hit | Outcome label |");
  });

  test("[unit] pace rule: projected = used / elapsed x 100, yes at 100 or more", () => {
    expect(paceRule({ usedPercent: 30, elapsedPercent: 20 })).toEqual({ projected: 150, yes: true });
    expect(paceRule({ usedPercent: 10, elapsedPercent: 50 })).toEqual({ projected: 20, yes: false });
    expect(paceRule({ usedPercent: 50, elapsedPercent: 50 }).yes).toBe(true);
    expect(paceRule({ usedPercent: 5, elapsedPercent: 0 })).toEqual({ projected: null, yes: false });
  });

  test("[integration] Claude weekly cap notices are weekly windows with hit yes; no notice gives one line that says no weekly record", async () => {
    const withWeekly = claudeDir({ "s.jsonl": [asst({ id: "a", ts: "2026-10-14T09:00:00Z", session: "s", output: 5 }), cap("2026-10-14T09:10:00Z", "You've hit your weekly limit · resets Oct 20", "s")] });
    const s = summarise(await scanClaude(withWeekly, FROM, TO), null);
    expect(s.weeks).toHaveLength(1);
    expect(s.weeks[0]?.source).toBe("claude");
    expect(s.weeks[0]?.hit).toBe(true);
    const none = summarise(await scanClaude(claudeDir({ "s.jsonl": [asst({ id: "a", ts: "2026-10-14T09:00:00Z", session: "s", output: 5 })] }), FROM, TO), null);
    expect(none.weeks).toHaveLength(0);
    expect(renderPrivate(none, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Claude Code"] })).toContain("Claude Code: 0 weekly cap notices; the logs carry no weekly meter reading, so a Claude week counts as not hit only from the absence of a notice.");
  });
});

describe("[unit] TokenMax score and helper size", () => {
  test("[unit] terciles by output tokens within a source: bottom third low, middle ordinary, top third high", () => {
    const t = scoreThresholds([10, 20, 30, 40, 50, 60]);
    expect(t).toEqual({ low: 20, high: 40 });
    expect([10, 20, 30, 40, 50, 60].map((v) => scoreOf(v, t))).toEqual(["low", "low", "ordinary", "ordinary", "high", "high"]);
    expect(scoreThresholds([])).toEqual({ low: 0, high: 0 });
    expect(scoreOf(7, scoreThresholds([7]))).toBe("low");
  });

  test("[unit] helper rule: < 20,000 output and < 25 tools small; > 200,000 output or > 250 tools large; zero records none", () => {
    expect(helperOf({ output: 19_999, toolCalls: 24, records: 3 })).toBe("small");
    expect(helperOf({ output: 20_000, toolCalls: 0, records: 3 })).toBe("medium");
    expect(helperOf({ output: 200_001, toolCalls: 0, records: 3 })).toBe("large");
    expect(helperOf({ output: 10, toolCalls: 251, records: 3 })).toBe("large");
    expect(helperOf({ output: 0, toolCalls: 0, records: 0 })).toBe("none");
  });

  test("[integration] each session carries its score; the report states the method and the distribution", async () => {
    const { claude, codex } = mixedSources();
    const s = summarise(await scanClaude(claude, FROM, TO), await scanCodex(codex, FROM, TO));
    const level = (id: string) => s.evidence.find((e) => e.session === id)?.score;
    expect([level("s-small"), level("s-mid"), level("s-big")]).toEqual(["low", "ordinary", "high"]);
    expect(s.evidence.find((e) => e.session === "s-big")?.helper).toBe("large");
    expect(s.evidence.find((e) => e.session === "s-small")?.helper).toBe("small");
    const text = renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Claude Code", "Codex"] });
    expect(text).toContain("## TokenMax score per session");
    expect(text).toContain("| Claude Code | 1 | 1 | 1 |");
  });
});

describe("[unit] Jev or not", () => {
  test("[unit] verdict: exact rule questions are don't use Jev; fewer than 30 paired cases is not enough evidence", () => {
    expect(jevVerdict({ exact: true, paired: 0, jevAccepted: 0, ruleAccepted: 0 })).toBe("don't use Jev");
    expect(jevVerdict({ exact: false, paired: 29, jevAccepted: 29, ruleAccepted: 0 })).toBe("not enough evidence");
    expect(jevVerdict({ exact: false, paired: 30, jevAccepted: 30, ruleAccepted: 20 })).toBe("use Jev");
    expect(jevVerdict({ exact: false, paired: 30, jevAccepted: 20, ruleAccepted: 25 })).toBe("don't use Jev");
    expect(jevVerdict({ exact: false, paired: 30, jevAccepted: 25, ruleAccepted: 23 })).toBe("not enough evidence");
  });

  test("[integration] metadata mode: one row per question, Jev NOT RUN, the exact-rule rows say don't use Jev", async () => {
    const { claude, codex } = mixedSources();
    const s = summarise(await scanClaude(claude, FROM, TO), await scanCodex(codex, FROM, TO));
    const rows = jevOrNot(s, null);
    expect(rows.map((r) => r.type)).toEqual(["noul", "choice", "score", "box", "rule", "rule", "rule"]);
    expect(rows.slice(0, 4).every((r) => r.jev.startsWith("NOT RUN"))).toBe(true);
    expect(rows.slice(0, 4).every((r) => r.verdict === "not enough evidence")).toBe(true);
    expect(rows.slice(4).every((r) => r.verdict === "don't use Jev")).toBe(true);
    const text = renderPrivate(s, { from: "2026-10-09", to: "2026-10-16", byProject: false, sources: ["Claude Code", "Codex"] });
    expect(text.slice(text.lastIndexOf("## "))).toContain("| Question | Type | Jev result | Rule result | LLM result | Cost per accepted answer | Verdict |");
    expect(text.indexOf("## Jev or not")).toBeGreaterThan(text.indexOf("## Not covered"));
  });
});

describe("[integration] --dashboard", () => {
  test("[integration] writes a self-contained dashboard.html next to the report: no network, light and dark, no em or en dashes", async () => {
    const { claude, codex } = mixedSources();
    const out = join(mkdtempSync(join(tmpdir(), "tmx-dash-")), "r");
    const code = await quietly(() => main(["--claude", claude, "--codex", codex, "--from", "2026-10-09", "--to", "2026-10-16", "--out", out, "--dashboard"]));
    expect(code).toBe(0);
    const html = readFileSync(join(out, "dashboard.html"), "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    for (const banned of ["http://", "https://", "<script src", "<link", "@import", "url(", ...DASHES, "SECRET", "s-big", "cx-a"]) expect(html.includes(banned)).toBe(false);
    expect(html).toContain("prefers-color-scheme: dark");
    for (const part of ["Output tokens per day", "Limit episodes", "TokenMax score", "Jev or not", "class=\"tile\""]) expect(html).toContain(part);
    const noDash = join(mkdtempSync(join(tmpdir(), "tmx-nodash-")), "r");
    expect(await quietly(() => main(["--claude", claude, "--codex", "none", "--out", noDash]))).toBe(0);
    expect(existsSync(join(noDash, "dashboard.html"))).toBe(false);
  });

  test("[unit] the dashboard escapes text it did not write", () => {
    const html = renderDashboard({ heading: "<b>x</b>", tiles: [["Sessions", "1"]], days: [], episodes: [], scores: [], jev: [] });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("[integration] sources: both, either or none", () => {
  test("[integration] no source folder found names both folders it looked for and exits 2", async () => {
    const home = mkdtempSync(join(tmpdir(), "tmx-nohome-"));
    const lines: string[] = [];
    const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    let code = -1;
    try { code = await main(["--out", join(home, "r")], { home }); } finally { err.mockRestore(); }
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain(join(home, ".claude", "projects"));
    expect(lines.join("\n")).toContain(join(home, ".codex", "sessions"));
  });
});

describe("[unit] Codex review on #413: rules", () => {
  test("[unit] pace rule compares the unrounded projection: 49.99 used at 50 elapsed is not on course", () => {
    expect(paceRule({ usedPercent: 49.99, elapsedPercent: 50 })).toEqual({ projected: 100, yes: false });
  });

  test("[integration] a repeated Codex call_id counts once; a session with tool calls but no counted reading is still a session", async () => {
    const root = codexDir({
      "rollout-t.jsonl": [meta("2026-10-14T08:00:00Z", "cx-t"), ...Array.from({ length: 300 }, () => call("2026-10-14T08:00:30Z", "function_call", "same")), call("2026-10-14T08:01:00Z", "local_shell_call", "other")],
    });
    const s = summarise(null, await scanCodex(root, FROM, TO));
    const t = s.evidence.find((e) => e.session === "cx-t");
    expect(t?.toolCalls).toBe(2);
    expect(t?.helper).toBe("none");
    expect(s.codex?.sessions).toBe(1);
  });

  test("[integration] the prediction point is before the hit and at or before half the window; a closed window with a reading gap has an unknown outcome", async () => {
    const start = Date.parse("2026-10-09T00:00:00Z");
    const resetA = (start + 7 * 86_400_000) / 1000;
    const iso = (h: number): string => new Date(start + h * 3_600_000).toISOString();
    const root = codexDir({
      "rollout-w.jsonl": [
        meta(iso(0), "cx-w"),
        tc(iso(24), 100, 0, 10, 30, resetA), tc(iso(80), 200, 0, 20, 60, resetA), tc(iso(100), 300, 0, 30, 100, resetA),
        // next window: last reading 3 days before its end, then a newer window replaces it
        tc(iso(170), 400, 0, 40, 5, resetA + 7 * 86_400), tc(iso(200), 500, 0, 50, 10, resetA + 7 * 86_400),
        tc(iso(300), 600, 0, 60, 1, resetA + 14 * 86_400),
      ],
    });
    const s = summarise(null, await scanCodex(root, Date.parse("2026-10-09T00:00:00Z"), Date.parse("2026-10-30T00:00:00Z")));
    const [a, b, c] = s.weeks;
    expect(a?.outcome).toBe("hit");
    expect(a?.predUsed).toBe(60);
    expect(a?.elapsedPercent).toBeCloseTo((80 / 168) * 100, 1);
    expect(b?.outcome).toBe("unknown");
    expect(c?.outcome).toBe("open");
  });
});
