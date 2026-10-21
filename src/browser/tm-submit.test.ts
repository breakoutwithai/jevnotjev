import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { checkMap, MAP_BOUNDS } from "../backstage/maps.ts";
import { createHandler } from "../backstage/server.ts";
import { ALIAS_PATTERN, MAX_DAYS, newRequestKey, PASTED_SKILL, periodDays, rawNumberProblem, rejectionMessage, submitBody, weekToPayload } from "./tm-submit.ts";
import { parseWeek, SAMPLE_WEEK, type Week } from "./tm-week.ts";

// /tm/ Submit: the pasted TOKENMAX WEEK block becomes a tm-share/1 body. The mapping is checked against the server's own
// checkMap and, end to end, against the real POST /api/maps handler.

const BLOCK = [
  "TOKENMAX WEEK", "Period: 2026-10-14 to 2026-10-20", "Claude sessions: 288", "Codex sessions: 2925", "Claude output tokens: 7,940,728",
  "Codex output tokens: 4,315,259", "Opus share of Claude output: 42%", "Usage limit hits: 2", "Codex weekly window used: 7%",
].join("\n");
const KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const week = (text: string): Week => { const w = parseWeek(text); if (!w) throw new Error("fixture did not parse"); return w; };
const change = (from: string, to: string): string => BLOCK.replace(from, to);

describe("tm-submit mapping", () => {
  test("[unit] TM-42 pasted and sample periods include exactly seven days and share the server day bound", () => {
    expect(periodDays(week(BLOCK))).toBe(7);
    expect(periodDays(SAMPLE_WEEK)).toBe(7);
    expect([MAP_BOUNDS.days[0], MAX_DAYS]).toEqual([1, MAP_BOUNDS.days[1]]);
  });
  test("[unit] TM-40 maps board uses the pasted skill literal from Submit", () => {
    const script = readFileSync(join(import.meta.dir, "..", "..", "site", "maps", "maps.js"), "utf8");
    expect(/var PASTED_SKILL = "([^"]+)";/.exec(script)?.[1]).toBe(PASTED_SKILL);
  });
  test("[unit] TM-42 generated header describes Submit's network call", () => {
    const script = readFileSync(join(import.meta.dir, "..", "..", "site", "tm", "tm.js"), "utf8");
    expect(script.slice(0, 300)).not.toContain("No network calls");
    expect(script.slice(0, 300)).toContain("Submit");
  });
  test("[unit] TM-18 a full block maps to a tm-share/1 payload in contract order that the server's checkMap accepts", () => {
    const mapped = weekToPayload(week(BLOCK));
    if (!mapped.ok) throw new Error(mapped.message);
    expect(JSON.stringify(mapped.payload)).toBe(JSON.stringify({
      v: "tm-share/1", skill: PASTED_SKILL, days: 7, sources: "claude+codex", sessions: 3213, subagent_sessions: 0,
      caps: { short: 0, weekly: 0, unknown: 2 }, output_tokens: { claude: 7940728, codex: 4315259 }, opus_share_pct: 42, codex_weekly_pct: 7,
    }));
    const checked = checkMap(submitBody(mapped.payload, "builder-ab12", KEY));
    expect(checked.ok && "map" in checked ? checked.map.payload : null).toEqual(mapped.payload);
    expect(PASTED_SKILL).toBe("0.0.0");
  });

  test("[unit] TM-18 sources follow which session counts are above 0; a missing Codex window is null, not a guess", () => {
    const claudeOnly = weekToPayload(week(change("Codex sessions: 2925", "Codex sessions: 0").replace("Codex weekly window used: 7%", "Codex weekly window used: not recorded")));
    expect(claudeOnly.ok && claudeOnly.payload).toMatchObject({ sources: "claude", sessions: 288, codex_weekly_pct: null });
    const codexOnly = weekToPayload(week(change("Claude sessions: 288", "Claude sessions: 0")));
    expect(codexOnly.ok && codexOnly.payload).toMatchObject({ sources: "codex", sessions: 2925 });
    for (const result of [claudeOnly, codexOnly]) expect(result.ok && checkMap(submitBody(result.payload, "abc", KEY)).ok).toBe(true);
    const none = weekToPayload(week(change("Claude sessions: 288", "Claude sessions: 0").replace("Codex sessions: 2925", "Codex sessions: 0")));
    expect(none).toEqual({ ok: false, message: "Not submitted: both session counts are 0, so there is no week to show." });
  });

  test("[unit] TM-18 a tool with 0 sessions sends its not-recorded output and Opus share as 0 (#359)", () => {
    const codexOnly = weekToPayload(week(change("Claude sessions: 288", "Claude sessions: 0")
      .replace("Claude output tokens: 7,940,728", "Claude output tokens: not recorded")
      .replace("Opus share of Claude output: 42%", "Opus share of Claude output: not recorded")));
    if (!codexOnly.ok) throw new Error(codexOnly.message);
    expect(codexOnly.payload).toMatchObject({ sources: "codex", sessions: 2925, output_tokens: { claude: 0, codex: 4315259 }, opus_share_pct: 0 });
    const claudeOnly = weekToPayload(week(change("Codex sessions: 2925", "Codex sessions: 0")
      .replace("Codex output tokens: 4,315,259", "Codex output tokens: not recorded")
      .replace("Codex weekly window used: 7%", "Codex weekly window used: not recorded")));
    if (!claudeOnly.ok) throw new Error(claudeOnly.message);
    expect(claudeOnly.payload).toMatchObject({ sources: "claude", sessions: 288, output_tokens: { claude: 7940728, codex: 0 }, opus_share_pct: 42, codex_weekly_pct: null });
    for (const result of [codexOnly, claudeOnly]) expect(checkMap(submitBody(result.payload, "abc", KEY)).ok).toBe(true);
  });

  test("[unit] TM-18 a tool with sessions above 0 and its output or share not recorded is still refused (#359)", () => {
    const refused = (lines: string, verb: string, tool?: string): string => `Not submitted: ${lines} ${verb} not recorded in your result.${tool
      ? ` Submit needs a number on every one of these lines. If you did not use ${tool}, change its lines to 0 in the box. Otherwise run the prompt again and paste the whole result.`
      : " Run the prompt again and paste the whole result."}`;
    expect(weekToPayload(week(change("Claude output tokens: 7,940,728", "Claude output tokens: not recorded"))))
      .toEqual({ ok: false, message: refused("Claude output tokens", "is", "Claude") });
    expect(weekToPayload(week(change("Opus share of Claude output: 42%", "Opus share of Claude output: not recorded"))))
      .toEqual({ ok: false, message: refused("Opus share of Claude output", "is") });
    expect(weekToPayload(week(change("Codex output tokens: 4,315,259", "Codex output tokens: not recorded"))))
      .toEqual({ ok: false, message: refused("Codex output tokens", "is", "Codex") });
    // The other tool's 0 does not excuse this tool: Codex at 0 sessions, Claude at 288 with its output or share not recorded.
    expect(weekToPayload(week(change("Codex sessions: 2925", "Codex sessions: 0").replace("Claude output tokens: 7,940,728", "Claude output tokens: not recorded"))))
      .toEqual({ ok: false, message: refused("Claude output tokens", "is", "Claude") });
    expect(weekToPayload(week(change("Codex sessions: 2925", "Codex sessions: 0").replace("Opus share of Claude output: 42%", "Opus share of Claude output: not recorded"))))
      .toEqual({ ok: false, message: refused("Opus share of Claude output", "is") });
    // A session count is never defaulted, so its tool's lines are still required.
    const noCount = weekToPayload(week(change("Claude sessions: 288", "Claude sessions: not recorded").replace("Claude output tokens: 7,940,728", "Claude output tokens: not recorded")));
    expect(noCount).toEqual({ ok: false, message: refused("Claude sessions, Claude output tokens", "are", "Claude") });
  });

  test("[unit] TM-18 a required line that is not recorded refuses the submit and names every such line", () => {
    const one = weekToPayload(week(change("Usage limit hits: 2", "Usage limit hits: not recorded")));
    expect(one).toEqual({ ok: false, message: "Not submitted: Usage limit hits is not recorded in your result. Run the prompt again and paste the whole result." });
    const several = weekToPayload(week("TOKENMAX WEEK\nClaude sessions: 288\nCodex sessions: not recorded"));
    expect(several.ok).toBe(false);
    for (const label of ["Period", "Codex sessions", "Claude output tokens", "Codex output tokens", "Opus share of Claude output", "Usage limit hits"]) expect(!several.ok && several.message).toContain(label);
    expect(!several.ok && several.message).not.toContain("Claude sessions,");
    expect(weekToPayload(week(change("Period: 2026-10-14 to 2026-10-20", "Period: last week to today")))).toMatchObject({ ok: false });
  });

  test("[unit] TM-44 unused Codex lines can be changed from not recorded to zero", () => {
    const missing = BLOCK.replace("Codex sessions: 2925", "Codex sessions: not recorded").replace("Codex output tokens: 4,315,259", "Codex output tokens: not recorded");
    const result = weekToPayload(week(missing));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const phrase of ["Codex sessions", "Codex output tokens", "are not recorded", "Submit needs a number", "If you did not use Codex", "change its lines to 0"]) expect(result.message).toContain(phrase);
    expect((result.message.match(/If you did not use Codex/g) ?? []).length).toBe(1);
    const zero = missing.replace("Codex sessions: not recorded", "Codex sessions: 0").replace("Codex output tokens: not recorded", "Codex output tokens: 0");
    expect(weekToPayload(week(zero))).toMatchObject({ ok: true, payload: { sources: "claude" } });
    // An unreadable Period is not a "not recorded" tool line and gets no zero hint.
    const period = weekToPayload(week(change("Period: 2026-10-14 to 2026-10-20", "Period: Oct 14 to Oct 20, 2026")));
    expect(!period.ok && period.message).toBe("Not submitted: Period (two dates like 2026-10-14 to 2026-10-20) is not recorded in your result. Run the prompt again and paste the whole result.");
  });

  test("[unit] TM-35 a value with no digits (N/A, a note after not recorded) is left to the null rule, not refused as a bad number", () => {
    // Main submitted an N/A Codex weekly window as null; the raw check must not turn that into a refusal.
    const na = change("Codex weekly window used: 7%", "Codex weekly window used: N/A");
    expect(rawNumberProblem(na)).toBeNull();
    expect(weekToPayload(week(na))).toMatchObject({ ok: true, payload: { codex_weekly_pct: null } });
    const note = change("Codex sessions: 2925", "Codex sessions: not recorded (Codex not used)");
    expect(rawNumberProblem(note)).toBeNull();
    const result = weekToPayload(week(note));
    expect(!result.ok && result.message).toContain("If you did not use Codex");
    expect(rawNumberProblem(change("Claude sessions: 288", "Claude sessions: 288 (86 duplicates)"))).not.toBeNull();
  });

  test("[unit] TM-18 days run from Period start to end inclusive and must be 1 to 90", () => {
    expect(periodDays(week(change("2026-10-14 to 2026-10-20", "2026-10-14 to 2026-10-14")))).toBe(1);
    expect(periodDays(week(BLOCK))).toBe(7);
    const ninety = weekToPayload(week(change("2026-10-14 to 2026-10-20", "2026-07-01 to 2026-09-28")));
    expect(ninety.ok && ninety.payload.days).toBe(90);
    const ninetyOne = weekToPayload(week(change("2026-10-14 to 2026-10-20", "2026-07-01 to 2026-09-29")));
    expect(ninetyOne).toEqual({ ok: false, message: "Not submitted: the period is 91 days; a submitted week covers 1 to 90 days." });
    expect(weekToPayload(week(change("2026-10-14 to 2026-10-20", "2026-10-20 to 2026-10-14")))).toMatchObject({ ok: false });
    expect(weekToPayload(week(change("2026-10-14 to 2026-10-20", "2026-02-30 to 2026-03-02")))).toMatchObject({ ok: false });
  });

  test("[unit] TM-18 a number the contract cannot hold is refused, not rounded or clamped", () => {
    expect(weekToPayload(week(change("Opus share of Claude output: 42%", "Opus share of Claude output: 42.5%")))).toEqual({ ok: false, message: "Not submitted: Opus share of Claude output must be a whole number, not 42.5." });
    expect(weekToPayload(week(change("Codex weekly window used: 7%", "Codex weekly window used: 7.5%")))).toMatchObject({ ok: false });
    // Out of range but whole: the server's reason is shown (TM-19), the mapping does not invent a bound.
    const big = weekToPayload(week(change("Opus share of Claude output: 42%", "Opus share of Claude output: 420%")));
    expect(big.ok && checkMap(submitBody(big.payload, "abc", KEY))).toMatchObject({ ok: false, code: "bad-payload", field: "opus_share_pct" });
  });
});

describe("tm-submit raw numbers", () => {
  for (const bad of ["-12", "−12", "+5", "-42%", "-2", "1e6", "1E6", "5e3", "8M", "8m", "7.4M", "8k", "8 million", "9,977,232 tokens", "12 sessions", "1_000", "1,2", "1,23,456", "12abc", "0x10", "1.2.3", "42.5%", "12-14", "1 2", "(12)", "~12"]) {
    test(`[unit] TM-35 raw value ${bad} is refused before tolerant mapping`, () => {
      const text = change("Codex output tokens: 4,315,259", `Codex output tokens: ${bad}`);
      const parsed = week(text);
      const mapped = weekToPayload(parsed);
      if (!["7.4M", "1.2.3", "42.5%"].includes(bad)) expect(mapped.ok && checkMap(submitBody(mapped.payload, "abc", KEY)).ok).toBe(true);
      expect(rawNumberProblem(text)).toBe(`Not submitted: Codex output tokens must be a plain whole number like 1,234, not "${bad}". Run the prompt again and paste the whole result.`);
    });
  }
  test("[unit] TM-35 percent on a non-percent field is refused", () => {
    expect(rawNumberProblem(change("Usage limit hits: 2", "Usage limit hits: 5%"))).toContain("Usage limit hits must be a plain whole number");
  });
  test("[unit] TM-35 plain numbers and supported markup pass every raw line", () => {
    for (const good of ["0", "2925", "2,925", "87", "not recorded", "Not recorded."]) expect(rawNumberProblem(change("Claude sessions: 288", `Claude sessions: ${good}`))).toBeNull();
    for (const good of ["42%", "42 %", "87", "not recorded", "Not recorded."]) expect(rawNumberProblem(change("Opus share of Claude output: 42%", `Opus share of Claude output: ${good}`))).toBeNull();
    expect(rawNumberProblem(change("Claude sessions: 288", "| Claude sessions | 288 |"))).toBeNull();
    expect(rawNumberProblem(change("Claude sessions: 288", "- **Claude sessions**: 288"))).toBeNull();
    expect(rawNumberProblem(`${BLOCK}\n| Claude sessions | -12 |`)).toContain("Claude sessions must be a plain whole number");
    expect(rawNumberProblem(`${BLOCK}\n- **Claude sessions**: -12`)).toContain("Claude sessions must be a plain whole number");
  });
});

describe("tm-submit key, alias and messages", () => {
  test("[unit] TM-18 the request key is 32 characters of A-Za-z0-9_-, accepted by the server, and differs between calls", () => {
    const keys = Array.from({ length: 50 }, () => newRequestKey((bytes) => crypto.getRandomValues(bytes)));
    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(checkMap({ payload: weekPayload(), alias: "abc", request_key: key }).ok).toBe(true);
    }
    expect(new Set(keys).size).toBe(50);
    // Distinct byte values map to distinct characters (the mask keeps the low 6 bits).
    const all = newRequestKey((bytes) => { bytes.forEach((_, i) => { bytes[i] = i * 2; }); return bytes; });
    expect(new Set(all).size).toBe(32);
  });

  test("[unit] TM-18 the alias pattern is the server's: 3 to 24 of a-z, 0-9 and hyphen", () => {
    for (const ok of ["abc", "a-b", "builder-ab12", "a".repeat(24)]) expect({ ok, server: checkMap({ payload: weekPayload(), alias: ok, request_key: KEY }).ok, page: ALIAS_PATTERN.test(ok) }).toEqual({ ok, server: true, page: true });
    for (const bad of ["ab", "A-b", "a_b", "a b", "a".repeat(25), "", "me@example.com"]) expect({ bad, server: checkMap({ payload: weekPayload(), alias: bad, request_key: KEY }).ok, page: ALIAS_PATTERN.test(bad) }).toEqual({ bad, server: false, page: false });
  });

  test("[unit] TM-18 a rejection shows the server's field and reason, else a plain sentence for its code", () => {
    expect(rejectionMessage(400, { code: "bad-payload", field: "days", reason: "must be 1 to 90" })).toBe("Not submitted: days must be 1 to 90.");
    expect(rejectionMessage(400, { code: "bad-alias", field: "alias", reason: "3 to 24 of a-z, 0-9 and -" })).toBe("Not submitted: alias 3 to 24 of a-z, 0-9 and -.");
    expect(rejectionMessage(429, { code: "rate-limited" })).toBe("Not submitted: too many requests from this network, try again later.");
    expect(rejectionMessage(503, { code: "maps-unavailable" })).toBe("Not submitted: the board is not available right now.");
    expect(rejectionMessage(502, null)).toBe("Not submitted: the server answered 502.");
  });
});

function weekPayload() {
  const mapped = weekToPayload(week(BLOCK));
  if (!mapped.ok) throw new Error(mapped.message);
  return mapped.payload;
}

describe("tm-submit against the real POST /api/maps", () => {
  const ORIGIN = "http://localhost:3456";
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "tm-submit-"));
    return createHandler({ version: "test", origin: ORIGIN, staticRoot: join(dir, "site"), maps: { path: join(dir, "maps.sqlite") }, log: () => {}, auth: { clock: () => Date.UTC(2026, 9, 21, 12) } });
  }
  const send = (handler: ReturnType<typeof createHandler>, data: unknown) => handler(
    new Request(`${ORIGIN}/api/maps`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify(data) }),
    { remoteAddress: "203.0.113.9" },
  );

  test("[integration] TM-19 the body is stored, the same key replays without a second row, and the board labels the row skill 0.0.0", async () => {
    const handler = setup();
    const key = newRequestKey((bytes) => { bytes.set(randomBytes(bytes.length)); return bytes; });
    const body = submitBody(weekPayload(), "pasted-one", key);
    expect(JSON.stringify(Object.keys(body))).toBe(JSON.stringify(["payload", "alias", "request_key"]));
    const first = await send(handler, body);
    expect(first.status).toBe(200);
    const stored = await first.json();
    expect(stored).toMatchObject({ replay: false, delete: `/maps/#delete=${stored.id}.${key}` });
    const again = await send(handler, body);
    expect(await again.json()).toMatchObject({ id: stored.id, replay: true });
    const board = await (await handler(new Request(`${ORIGIN}/api/maps`))).json();
    expect(board.totals).toEqual({ builders: 1, cap_episodes: 2, with_weekly_cap: 0 });
    expect(board.rows[0]).toMatchObject({ alias: "pasted-one", skill: "0.0.0", days: 7, sources: "claude+codex", sessions: 3213 });
    // The same key with other details is the 409 the page resets its attempt on.
    const other = await send(handler, submitBody(weekPayload(), "pasted-two", key));
    expect(other.status).toBe(409);
  });

  test("[integration] TM-19 an out-of-range number comes back as field and reason that the page shows", async () => {
    const handler = setup();
    const mapped = weekToPayload(week(change("Opus share of Claude output: 42%", "Opus share of Claude output: 420%")));
    if (!mapped.ok) throw new Error(mapped.message);
    const response = await send(handler, submitBody(mapped.payload, "pasted-one", KEY));
    expect(response.status).toBe(400);
    const rejected = await response.json();
    expect(rejected).toEqual({ code: "bad-payload", field: "opus_share_pct", reason: "must be 0 to 100" });
    expect(rejectionMessage(response.status, rejected)).toBe("Not submitted: opus_share_pct must be 0 to 100.");
  });
});
