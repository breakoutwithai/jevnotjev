// [unit] [integration] tokenmax-map --share: the tm-share/1 payload, its link and the printed share block.
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_META_TYPE,
  SHARE_BASE,
  SHARE_VERSION,
  type SharePayload,
  VERSION,
  buildShare,
  decodeShare,
  encodeShare,
  isRec,
  main,
  scanClaude,
  scanCodex,
  shareLink,
  shareRangeError,
  summarise,
} from "./map.ts";

const NOW = "2026-10-16T12:00:00Z";
const FROM = Date.parse("2026-10-09T12:00:00Z");
const TO = Date.parse(NOW);

/** A UUID-shaped session id built at runtime, so no literal id sits in the source. */
const fakeId = (seed: string): string => [8, 4, 4, 4, 12].map((len) => seed.repeat(len).slice(0, len)).join("-");
const SESSION_A = fakeId("ab");
const SESSION_B = fakeId("cd");

const asst = (o: { id: string; ts: string; model: string; output: number; session: string }): string =>
  JSON.stringify({
    type: "assistant",
    sessionId: o.session,
    uuid: fakeId("e1"),
    timestamp: o.ts,
    cwd: "/home/x/projects/acme",
    isSidechain: false,
    message: { id: o.id, model: o.model, content: [{ type: "text", text: "SECRET BODY" }], usage: { input_tokens: 10, output_tokens: o.output } },
  });
const cap = (ts: string, text: string, session: string): string =>
  JSON.stringify({ type: "assistant", sessionId: session, uuid: fakeId("f2"), timestamp: ts, isApiErrorMessage: true, error: "rate_limit", message: { id: "x", model: "<synthetic>", content: [{ type: "text", text }] } });

/** Claude: opus 30 + sonnet 10 output in the parent session, haiku 10 in a subagent; one short and one unknown cap. */
function claudeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tmx-share-claude-"));
  const proj = join(root, "-home-x-projects-acme");
  mkdirSync(join(proj, SESSION_A, "subagents"), { recursive: true });
  writeFileSync(
    join(proj, `${SESSION_A}.jsonl`),
    [
      asst({ id: "m1", ts: "2026-10-14T09:00:00Z", model: "claude-opus-5-5", output: 30, session: SESSION_A }),
      asst({ id: "m2", ts: "2026-10-14T09:05:00Z", model: "claude-sonnet-5-5", output: 10, session: SESSION_A }),
      cap("2026-10-14T09:10:00Z", "You've hit your session limit · resets 2pm (Europe/Warsaw)", SESSION_A),
      cap("2026-10-14T09:12:00Z", "You've hit your limit · resets 9pm (Europe/Warsaw)", SESSION_A),
    ].join("\n"),
  );
  writeFileSync(join(proj, SESSION_A, "subagents", "agent-1.jsonl"), asst({ id: "m3", ts: "2026-10-14T09:20:00Z", model: "claude-haiku-5-5", output: 10, session: SESSION_B }));
  return root;
}

type Slot = { used_percent: number; window_minutes: number; resets_at: number } | null;
const tc = (ts: string, input: number, output: number, primary: Slot, secondary: Slot = null): string =>
  JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 } },
      rate_limits: { limit_id: "codex", primary, secondary, rate_limit_reached_type: null },
    },
  });
const weekly = (used: number): Slot => ({ used_percent: used, window_minutes: 10080, resets_at: 1760900000 });
const fiveHour = (used: number): Slot => ({ used_percent: used, window_minutes: 300, resets_at: 1760700000 });

/** Codex: one fresh session, 40 output; a weekly reading 37.4, then a 5-hour cap at 100 and a later 5-hour reading 90. */
function codexFixture(o: { weeklyCap: boolean } = { weeklyCap: false }): string {
  const root = mkdtempSync(join(tmpdir(), "tmx-share-codex-"));
  const day = join(root, "2026", "10", "14");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, "rollout-a.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-10-14T08:00:00Z", type: CODEX_META_TYPE, payload: { id: SESSION_B, cwd: "/home/x/projects/acme" } }),
      JSON.stringify({ timestamp: "2026-10-14T08:00:01Z", type: "turn_context", payload: { model: "gpt-x" } }),
      tc("2026-10-14T08:01:00Z", 100, 20, weekly(37.4)),
      tc("2026-10-14T08:02:00Z", 150, 30, fiveHour(100), o.weeklyCap ? weekly(100) : null),
      tc("2026-10-14T08:03:00Z", 160, 40, fiveHour(90)),
    ].join("\n"),
  );
  return root;
}

const LEAF_KEYS = ["v", "skill", "days", "sources", "sessions", "subagent_sessions", "caps.short", "caps.weekly", "caps.unknown", "output_tokens.claude", "output_tokens.codex", "opus_share_pct", "codex_weekly_pct"];
const TOP_KEYS = ["v", "skill", "days", "sources", "sessions", "subagent_sessions", "caps", "output_tokens", "opus_share_pct", "codex_weekly_pct"];

const safeInt = (v: unknown, lo: number, hi: number): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;
const exactKeys = (v: unknown, keys: string[]): boolean => isRec(v) && JSON.stringify(Object.keys(v)) === JSON.stringify(keys);

/** The tm-share/1 contract, written out here so the test does not trust the code it checks. Returns the failing field or "". */
function contractFailure(p: unknown): string {
  if (!isRec(p) || !exactKeys(p, TOP_KEYS)) return "keys";
  if (p.v !== "tm-share/1") return "v";
  if (typeof p.skill !== "string" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(p.skill)) return "skill";
  if (!safeInt(p.days, 1, 90)) return "days";
  if (p.sources !== "claude" && p.sources !== "codex" && p.sources !== "claude+codex") return "sources";
  if (!safeInt(p.sessions, 0, 1_000_000)) return "sessions";
  if (typeof p.sessions !== "number" || !safeInt(p.subagent_sessions, 0, p.sessions)) return "subagent_sessions";
  const caps = p.caps;
  if (!isRec(caps) || !exactKeys(caps, ["short", "weekly", "unknown"])) return "caps";
  for (const k of ["short", "weekly", "unknown"]) if (!safeInt(caps[k], 0, 10_000)) return `caps.${k}`;
  const out = p.output_tokens;
  if (!isRec(out) || !exactKeys(out, ["claude", "codex"])) return "output_tokens";
  for (const k of ["claude", "codex"]) if (!safeInt(out[k], 0, 1_000_000_000_000)) return `output_tokens.${k}`;
  if (!safeInt(p.opus_share_pct, 0, 100)) return "opus_share_pct";
  if (p.codex_weekly_pct !== null && !safeInt(p.codex_weekly_pct, 0, 100)) return "codex_weekly_pct";
  return "";
}

/** Run main() with console.log captured; returns the exit code and the stdout lines. */
async function runCaptured(argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  try {
    return { code: await main(argv), lines: lines.join("\n").split("\n") };
  } finally {
    spy.mockRestore();
  }
}

/** The share block: from its header line to the link line, inclusive. */
function shareBlock(lines: string[]): string[] {
  const start = lines.indexOf("Share fields (tm-share/1). Nothing has been sent.");
  const linkAt = lines.indexOf("Open this link to review and share:");
  if (start < 0 || linkAt < start) return [];
  return lines.slice(start, linkAt + 2);
}

const outDir = (): string => join(mkdtempSync(join(tmpdir(), "tmx-share-out-")), "r");

describe("[integration] --share block", () => {
  test("[integration] M1 prints exactly the 13 contract leaf keys, in contract order", async () => {
    const r = await runCaptured(["--share", "--claude", claudeFixture(), "--codex", codexFixture(), "--now", NOW, "--out", outDir()]);
    expect(r.code).toBe(0);
    const block = shareBlock(r.lines);
    expect(block.length).toBe(LEAF_KEYS.length + 3);
    const fields = block.slice(1, 1 + LEAF_KEYS.length).map((l) => l.split(":")[0]);
    expect(fields).toEqual(LEAF_KEYS);
    expect(block[block.length - 1]?.startsWith(`${SHARE_BASE}#m=`)).toBe(true);
  });

  test("[integration] the block carries no project, alias, path, session id or timestamp, even with --by-project and --alias", async () => {
    const out = outDir();
    const r = await runCaptured(["--share", "--by-project", "--alias", "secret-alias", "--claude", claudeFixture(), "--codex", codexFixture(), "--now", NOW, "--out", out]);
    expect(r.code).toBe(0);
    const text = shareBlock(r.lines).join("\n");
    expect(text.length).toBeGreaterThan(0);
    for (const banned of ["acme", "secret-alias", "/home/", SESSION_A, SESSION_B, out]) expect(text.includes(banned)).toBe(false);
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)).toBe(false);
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)).toBe(false);
    expect(existsSync(join(out, "private-report.md"))).toBe(true);
    expect(existsSync(join(out, "share-draft.md"))).toBe(true);
  });

  test("[integration] without --share no share block is printed", async () => {
    const r = await runCaptured(["--claude", claudeFixture(), "--codex", "none", "--now", NOW, "--out", outDir()]);
    expect(r.code).toBe(0);
    expect(shareBlock(r.lines)).toEqual([]);
  });
});

describe("[unit] encode, decode and link", () => {
  test("[unit] decodeShare(encodeShare(p)) round-trips; link is SHARE_BASE#m= plus base64url without padding", async () => {
    const p = buildShare(summarise(await scanClaude(claudeFixture(), FROM, TO), await scanCodex(codexFixture(), FROM, TO)), { days: 7, sources: "claude+codex" });
    expect(decodeShare(encodeShare(p))).toEqual(p);
    const link = shareLink(p);
    expect(link.startsWith(`${SHARE_BASE}#m=`)).toBe(true);
    expect(/^[A-Za-z0-9_-]+$/.test(link.slice(`${SHARE_BASE}#m=`.length))).toBe(true);
    expect(shareLink(p, "https://example.test/maps/").startsWith("https://example.test/maps/#m=")).toBe(true);
    expect(SHARE_VERSION).toBe("tm-share/1");
    expect(SHARE_BASE).toBe("https://jevnotjev.breakoutwithai.com/maps/");
  });

  test("[unit] decodeShare of text that is not base64url JSON returns undefined", () => {
    expect(decodeShare("!!not-base64!!")).toBeUndefined();
    expect(decodeShare(Buffer.from("not json", "utf8").toString("base64url"))).toBeUndefined();
  });
});

describe("[integration] payload fields", () => {
  test("[integration] Claude only: sources claude, codex output 0, codex_weekly_pct null", async () => {
    const p = buildShare(summarise(await scanClaude(claudeFixture(), FROM, TO), null), { days: 7, sources: "claude" });
    expect(p.sources).toBe("claude");
    expect(p.output_tokens).toEqual({ claude: 50, codex: 0 });
    expect(p.codex_weekly_pct).toBeNull();
    expect(p.opus_share_pct).toBe(60);
    expect(p.sessions).toBe(2);
    expect(p.subagent_sessions).toBe(1);
  });

  test("[integration] Codex only: sources codex, opus_share_pct 0", async () => {
    const p = buildShare(summarise(null, await scanCodex(codexFixture(), FROM, TO)), { days: 7, sources: "codex" });
    expect(p.sources).toBe("codex");
    expect(p.opus_share_pct).toBe(0);
    expect(p.output_tokens).toEqual({ claude: 0, codex: 40 });
    expect(p.sessions).toBe(1);
  });

  test("[integration] codex_weekly_pct is the last weekly reading (37.4 -> 37), not a later 5-hour reading", async () => {
    const p = buildShare(summarise(null, await scanCodex(codexFixture(), FROM, TO)), { days: 7, sources: "codex" });
    expect(p.codex_weekly_pct).toBe(37);
  });

  test("[integration] caps from both sources are summed per window", async () => {
    const p = buildShare(summarise(await scanClaude(claudeFixture(), FROM, TO), await scanCodex(codexFixture({ weeklyCap: true }), FROM, TO)), { days: 7, sources: "claude+codex" });
    // Claude: short 1, unknown 1. Codex: 5-hour at 100 is short 1, weekly at 100 is weekly 1.
    expect(p.caps).toEqual({ short: 2, weekly: 1, unknown: 1 });
    expect(p.codex_weekly_pct).toBe(100);
  });

  test("[unit] the built payload passes the tm-share/1 contract check", async () => {
    const p: SharePayload = buildShare(summarise(await scanClaude(claudeFixture(), FROM, TO), await scanCodex(codexFixture(), FROM, TO)), { days: 7, sources: "claude+codex" });
    expect(contractFailure(p)).toBe("");
    expect(p.v).toBe("tm-share/1");
    expect(p.skill).toBe(VERSION);
    expect(VERSION).toBe("0.4.0");
    expect(contractFailure({ ...p, extra: 1 })).toBe("keys");
    // Out of range is refused, never pulled to a bound: a 400-day map must not be shared as 90 days.
    const long = buildShare(summarise(null, null), { days: 400, sources: "claude" });
    expect(long.days).toBe(400);
    expect(shareRangeError(long)).toBe("days is 400, outside the tm-share/1 range 1 to 90");
    expect(shareRangeError({ ...p, caps: { ...p.caps, weekly: 10_001 } })).toBe("caps.weekly is 10001, outside the tm-share/1 range 0 to 10000");
    expect(shareRangeError({ ...p, subagent_sessions: p.sessions + 1 })).toContain("more than sessions");
    expect(shareRangeError(p)).toBeNull();
  });

  test("[integration] --share with --days 400 prints no link and says the share was skipped; the report is still written", async () => {
    const out = outDir();
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    let code = -1;
    try { code = await main(["--share", "--days", "400", "--claude", claudeFixture(), "--codex", "none", "--out", out, "--now", NOW]); } finally { log.mockRestore(); }
    const text = lines.join("\n");
    expect(code).toBe(1);
    expect(text).toContain("Share skipped: days is 400, outside the tm-share/1 range 1 to 90");
    expect(text.includes("#m=")).toBe(false);
    expect(existsSync(join(out, "private-report.md"))).toBe(true);
  });
});

describe("[integration] piped and timed runs", () => {
  test("[integration] piped: map.ts on stdin to `bun run - --share` exits 0, prints the link, writes both reports", async () => {
    const out = outDir();
    const proc = Bun.spawn(["bun", "run", "-", "--share", "--claude", claudeFixture(), "--codex", "none", "--out", out, "--now", NOW], {
      stdin: Bun.file(join(import.meta.dir, "map.ts")),
      stdout: "pipe",
      stderr: "pipe",
      cwd: mkdtempSync(join(tmpdir(), "tmx-share-cwd-")),
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout.includes(`${SHARE_BASE}#m=`)).toBe(true);
    expect(existsSync(join(out, "private-report.md"))).toBe(true);
    expect(existsSync(join(out, "share-draft.md"))).toBe(true);
  });

  test("[integration] M2 a 7-day fixture of 50 Claude files x 200 lines and 20 Codex files x 200 lines maps in under 10 s", async () => {
    const croot = mkdtempSync(join(tmpdir(), "tmx-m2-claude-"));
    const proj = join(croot, "-home-x-projects-big");
    mkdirSync(proj, { recursive: true });
    for (let f = 0; f < 50; f++) {
      const session = fakeId(f.toString(16).padStart(2, "0"));
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        const ts = new Date(FROM + ((f * 200 + i) % (6 * 86_400)) * 1000).toISOString();
        lines.push(asst({ id: `m-${f}-${i}`, ts, model: i % 3 === 0 ? "claude-opus-5-5" : "claude-sonnet-5-5", output: 5, session }));
      }
      writeFileSync(join(proj, `f${f}.jsonl`), lines.join("\n"));
    }
    const xroot = mkdtempSync(join(tmpdir(), "tmx-m2-codex-"));
    const day = join(xroot, "2026", "10", "14");
    mkdirSync(day, { recursive: true });
    for (let f = 0; f < 20; f++) {
      const lines = [JSON.stringify({ timestamp: "2026-10-14T08:00:00Z", type: CODEX_META_TYPE, payload: { id: `cx-${f}` } })];
      for (let i = 1; i < 200; i++) lines.push(tc(new Date(Date.parse("2026-10-14T08:00:00Z") + i * 1000).toISOString(), i * 10, i, weekly(i % 100)));
      writeFileSync(join(day, `rollout-${f}.jsonl`), lines.join("\n"));
    }
    const started = performance.now();
    const r = await runCaptured(["--share", "--claude", croot, "--codex", xroot, "--now", NOW, "--out", outDir()]);
    const elapsed = Math.round(performance.now() - started);
    process.stdout.write(`M2 elapsed_ms=${elapsed}\n`);
    expect(r.code).toBe(0);
    expect(elapsed).toBeLessThan(10_000);
    expect(shareBlock(r.lines).some((l) => l === "sessions: 70")).toBe(true);
  }, 30_000);
});
