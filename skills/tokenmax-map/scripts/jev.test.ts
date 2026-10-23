// [unit] [integration] tokenmax-map optional Jev mode. Every Jev call is stubbed: no test reaches the network.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  CODEX_META_TYPE,
  JEV_ENDPOINT,
  JEV_KEY_VAR,
  JEV_MODEL,
  JEV_BOX_MODEL,
  type JevCall,
  buildJevPlan,
  imageSize,
  isRec,
  main,
  resolveJevKey,
  scanClaude,
  scanCodex,
  summarise,
} from "./map.ts";

const FROM = Date.parse("2026-10-09T00:00:00Z");
const TO = Date.parse("2026-10-16T23:59:59Z");
/** A fake key built at runtime; the tests assert it never reaches stdout, stderr or a written file. */
const KEY = ["tsk", "test", "x".repeat(24)].join("_");

const asst = (id: string, ts: string, session: string, output: number): string =>
  JSON.stringify({ type: "assistant", sessionId: session, uuid: `u-${id}`, timestamp: ts, cwd: "/home/x/p", isSidechain: false, message: { id, model: "claude-opus-5-5", content: [{ type: "text", text: "SECRET BODY" }], usage: { input_tokens: 1, output_tokens: output } } });
const tc = (ts: string, input: number, output: number, used: number, resetsAt: number): string =>
  JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } }, rate_limits: { primary: { used_percent: used, window_minutes: 10080, resets_at: resetsAt }, secondary: null, rate_limit_reached_type: null } } });

function sources(sessions = 3): { claude: string; codex: string } {
  const claude = mkdtempSync(join(tmpdir(), "tmx-jev-claude-"));
  mkdirSync(join(claude, "p"), { recursive: true });
  for (let i = 0; i < sessions; i++) writeFileSync(join(claude, "p", `s${i}.jsonl`), asst(`m${i}`, `2026-10-14T08:${String(i).padStart(2, "0")}:00Z`, `s-${i}`, 1000 * (i + 1)));
  const codex = mkdtempSync(join(tmpdir(), "tmx-jev-codex-"));
  mkdirSync(join(codex, "d"), { recursive: true });
  const reset = Date.parse("2026-10-20T00:00:00Z") / 1000;
  writeFileSync(join(codex, "d", "r.jsonl"), [JSON.stringify({ timestamp: "2026-10-14T08:00:00Z", type: CODEX_META_TYPE, payload: { id: "cx-1" } }), tc("2026-10-14T08:01:00Z", 100, 10, 20, reset), tc("2026-10-15T08:01:00Z", 200, 20, 45, reset)].join("\n"));
  return { claude, codex };
}

type Captured = { url: string; headers: Record<string, string>; body: unknown };
/** A fetch stand-in that records each request and answers every question with a valid answer for its type. */
function stubFetch(model = JEV_MODEL): { calls: Captured[]; fetch: (url: string, init: RequestInit) => Promise<Response> } {
  const calls: Captured[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const body: unknown = JSON.parse(String(init.body));
    calls.push({ url, headers, body });
    const answers: Record<string, unknown> = {};
    const qs = isRec(body) && isRec(body.questions) ? body.questions : {};
    for (const [id, q] of Object.entries(qs)) {
      const type = isRec(q) ? q.type : "";
      if (type === "noul") answers[id] = { type, noul: 0.2 };
      if (type === "choice") answers[id] = { type, choice: "small", probabilities: { small: 0.9, medium: 0.05, large: 0.05, none: 0 }, confidence: 0.85 };
      if (type === "score") answers[id] = { type, score: 0.1, legend: { "0": "a", "1": "b", "2": "c" }, probabilities: { "0": 0.9, "1": 0.1, "2": 0 }, confidence: 0.8 };
      if (type === "box") answers[id] = { type, box: { top: 0.1, bottom: 0.3, left: 0.2, right: 0.8 }, confidence: 0.7 };
    }
    return new Response(JSON.stringify({ model, answers, usage: { input_tokens: 400, output_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

async function capture(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  try { return { code: await run(), out: lines.join("\n") }; } finally { log.mockRestore(); err.mockRestore(); }
}
const readAll = (dir: string): string => readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

/** A minimal valid PNG header of the given size: signature plus an IHDR chunk (enough for imageSize). */
function png(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(1))), chunk("IEND", Buffer.alloc(0))]);
}

describe("[unit] key lookup", () => {
  test("[unit] the variable name is the one the TypeSafe docs name; the environment wins over .env.local", () => {
    expect(JEV_KEY_VAR).toBe("TYPESAFE_API_KEY");
    expect(JEV_ENDPOINT).toBe("https://api.typesafe.ai/v1/systemone");
    const cwd = mkdtempSync(join(tmpdir(), "tmx-key-"));
    writeFileSync(join(cwd, ".env.local"), `OTHER=1\nexport ${JEV_KEY_VAR}="${KEY}-file"\n`);
    expect(resolveJevKey({ [JEV_KEY_VAR]: KEY }, cwd)).toEqual({ key: KEY, from: "environment" });
    expect(resolveJevKey({}, cwd)).toEqual({ key: `${KEY}-file`, from: ".env.local" });
    expect(resolveJevKey({ [JEV_KEY_VAR]: "  " }, mkdtempSync(join(tmpdir(), "tmx-nokey-")))).toBeNull();
    const single = mkdtempSync(join(tmpdir(), "tmx-key1-"));
    writeFileSync(join(single, ".env.local"), `${JEV_KEY_VAR}='${KEY}'  # comment\n`);
    expect(resolveJevKey({}, single)?.key).toBe(KEY);
  });
});

describe("[unit] the plan follows the question definitions", () => {
  test("[integration] Q1 one body per week window; Q2 and Q3 share one body per session; state holds numbers, never message text", async () => {
    const { claude, codex } = sources();
    const s = summarise(await scanClaude(claude, FROM, TO), await scanCodex(codex, FROM, TO));
    const plan = buildJevPlan(s, { maxCalls: 40, now: TO });
    const q1 = plan.filter((c) => c.question === "q1");
    const q23 = plan.filter((c) => c.question === "q2q3");
    expect(q1).toHaveLength(1);
    expect(q23).toHaveLength(4);
    const b1 = q1[0]?.body;
    expect(b1?.model).toBe(JEV_MODEL);
    expect(b1?.questions).toEqual({
      will_hit: {
        type: "noul",
        instructions: "Using the numbers in `window`, will this usage window reach 100% used before it resets? High means yes.",
        criteria: { true: "Used share is on course to reach 100% before resets_at, given the share of the window already elapsed.", false: "Used share will still be below 100% at resets_at at the current pace." },
      },
    });
    const w = isRec(b1?.state) && isRec(b1.state.window) ? b1.state.window : {};
    expect(Object.keys(w).sort()).toEqual(["elapsed_percent", "read_at", "resets_at", "source", "used_percent", "used_percent_history", "window_minutes"]);
    const b2 = q23[0]?.body;
    const qs = isRec(b2?.questions) ? b2.questions : {};
    expect(Object.keys(qs)).toEqual(["helper_size", "tokenmax_score"]);
    expect(qs.helper_size).toEqual({
      type: "choice",
      instructions: "Which helper size would have been enough for this session's work, judged only from the numbers in `session`?",
      criteria: {
        small: "Short, light session: few output tokens and few tool calls; a small model would do.",
        medium: "Moderate output and tool use; a mid-size model is the fit.",
        large: "Heavy output or many tool calls, or long run with subagents; the large model is justified.",
        none: "The numbers cannot tell (for example zero records).",
      },
    });
    expect(qs.tokenmax_score).toEqual({
      type: "score",
      instructions: "How heavily did this session use the person's token allowance, judged only from the numbers in `session`?",
      criteria: ["Light: a few messages, little output, no subagents", "Ordinary: a normal working session, moderate output and tool use", "Heavy: long session or many subagents, large share of the day's tokens"],
    });
    const sess = isRec(b2?.state) && isRec(b2.state.session) ? b2.state.session : {};
    expect(Object.keys(sess).sort()).toEqual(["has_subagents", "minutes", "model_mix", "output_tokens", "records", "share_of_day_output_percent", "source", "tool_calls"]);
    expect(JSON.stringify(plan)).not.toContain("SECRET");
    expect(JSON.stringify(plan)).not.toContain("s-0");
    expect(buildJevPlan(s, { maxCalls: 2, now: TO })).toHaveLength(2);
  });

  test("[unit] a usage-page screenshot adds one box call on the 1.14 model with the images header; a small image is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "tmx-shot-"));
    const good = join(dir, "usage.png");
    writeFileSync(good, png(400, 300));
    expect(imageSize(readFileSync(good))).toEqual({ format: "png", width: 400, height: 300 });
    const s = summarise(null, null);
    const plan = buildJevPlan(s, { maxCalls: 40, now: TO, screenshot: good });
    const box = plan.find((c: JevCall) => c.question === "q4");
    expect(box?.images).toBe(true);
    expect(box?.body.model).toBe(JEV_BOX_MODEL);
    const qs = isRec(box?.body.questions) ? box.body.questions : {};
    expect(qs.meter).toEqual({ type: "box", instructions: "the usage meter (the bar or percentage showing how much of the limit is used) in `pic`" });
    const small = join(dir, "small.png");
    writeFileSync(small, png(200, 300));
    expect(() => buildJevPlan(s, { maxCalls: 40, now: TO, screenshot: small })).toThrow("280 to 1568");
  });
});

describe("[integration] --jev", () => {
  test("[integration] no key: says how to add one, finishes in metadata mode with Jev NOT RUN, makes no call", async () => {
    const { claude, codex } = sources();
    const cwd = mkdtempSync(join(tmpdir(), "tmx-jev-nokey-"));
    const out = join(cwd, "r");
    const stub = stubFetch();
    const { code, out: printed } = await capture(() => main(["--claude", claude, "--codex", codex, "--from", "2026-10-09", "--to", "2026-10-16", "--out", out, "--jev", "--yes"], { env: {}, cwd, fetch: stub.fetch }));
    expect(code).toBe(0);
    expect(stub.calls).toHaveLength(0);
    expect(printed).toContain(`Jev NOT RUN: no ${JEV_KEY_VAR}`);
    expect(printed).toContain(".env.local");
    expect(readFileSync(join(out, "private-report.md"), "utf8")).toContain("Jev analysis: NOT RUN");
  });

  test("[integration] with a key and --yes: shows the payload and call count first, sends with the key, never prints or writes it", async () => {
    const { claude, codex } = sources();
    const cwd = mkdtempSync(join(tmpdir(), "tmx-jev-key-"));
    writeFileSync(join(cwd, ".env.local"), `${JEV_KEY_VAR}=${KEY}\n`);
    const out = join(cwd, "r");
    const stub = stubFetch();
    const { code, out: printed } = await capture(() => main(["--claude", claude, "--codex", codex, "--from", "2026-10-09", "--to", "2026-10-16", "--out", out, "--jev", "--yes", "--dashboard"], { env: {}, cwd, fetch: stub.fetch }));
    expect(code).toBe(0);
    expect(stub.calls).toHaveLength(5);
    expect(stub.calls.every((c) => c.url === JEV_ENDPOINT && c.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(printed).toContain("5 call(s) to https://api.typesafe.ai/v1/systemone");
    expect(printed).toContain("jev-payload.json");
    expect(printed.indexOf("5 call(s)")).toBeLessThan(printed.indexOf("Jev: 5 of 5 call(s) answered"));
    expect(printed).not.toContain(KEY);
    expect(readAll(out)).not.toContain(KEY);
    const payload: unknown = JSON.parse(readFileSync(join(out, "jev-payload.json"), "utf8"));
    expect(Array.isArray(payload) && payload.length).toBe(5);
    const report = readFileSync(join(out, "private-report.md"), "utf8");
    expect(report).toContain("Jev analysis: RUN, 5 of 5 call(s) answered");
    const table = report.slice(report.indexOf("## Jev or not"));
    expect(table).toContain("| Will this week hit the weekly limit before reset? | noul | 1 answered");
    expect(table).toContain("$0.000084");
    expect(table).not.toContain("NOT RUN (no key");
  });

  test("[integration] with a key but no yes: nothing is sent", async () => {
    const { claude, codex } = sources();
    const cwd = mkdtempSync(join(tmpdir(), "tmx-jev-decline-"));
    const stub = stubFetch();
    let asked = "";
    const { code, out: printed } = await capture(() => main(["--claude", claude, "--codex", codex, "--from", "2026-10-09", "--to", "2026-10-16", "--out", join(cwd, "r"), "--jev"], { env: { [JEV_KEY_VAR]: KEY }, cwd, fetch: stub.fetch, confirm: async (q) => { asked = q; return false; } }));
    expect(code).toBe(0);
    expect(asked).toContain("Send 5 call(s)");
    expect(stub.calls).toHaveLength(0);
    expect(printed).toContain("Jev NOT RUN: not approved");
    const quiet = stubFetch();
    await capture(() => main(["--claude", claude, "--codex", "none", "--from", "2026-10-09", "--to", "2026-10-16", "--out", join(cwd, "r2"), "--jev"], { env: { [JEV_KEY_VAR]: KEY }, cwd, fetch: quiet.fetch, interactive: false }));
    expect(quiet.calls).toHaveLength(0);
  });

  test("[integration] an answer from a different model is a failure, not a Jev result", async () => {
    const { claude } = sources(1);
    const cwd = mkdtempSync(join(tmpdir(), "tmx-jev-model-"));
    const out = join(cwd, "r");
    const stub = stubFetch("jev-9.9.9");
    const { out: printed } = await capture(() => main(["--claude", claude, "--codex", "none", "--from", "2026-10-09", "--to", "2026-10-16", "--out", out, "--jev", "--yes"], { env: { [JEV_KEY_VAR]: KEY }, cwd, fetch: stub.fetch }));
    expect(stub.calls).toHaveLength(1);
    expect(printed).toContain("Jev: 0 of 1 call(s) answered, 1 failed");
    expect(readFileSync(join(out, "private-report.md"), "utf8")).toContain("model jev-9.9.9, not jev-1.13.0");
  });
});

describe("[integration] sessions.csv and a labels file", () => {
  test("[integration] sessions.csv lists every session with its label key and metadata only", async () => {
    const { claude, codex } = sources(3);
    const out = join(mkdtempSync(join(tmpdir(), "tmx-csv-")), "r");
    await capture(() => main(["--claude", claude, "--codex", codex, "--from", "2026-10-09", "--to", "2026-10-16", "--out", out]));
    const csv = readFileSync(join(out, "sessions.csv"), "utf8").trim().split("\n");
    expect(csv[0]).toBe("alias,key,source,first_utc,last_utc,minutes,records,output_tokens,tool_calls,subagent,limit_hit,tokenmax_score,helper_rule,share_of_day_output_percent");
    expect(csv).toHaveLength(5);
    expect(csv.slice(1).every((row) => /^session-\d{3},[0-9a-f]{12},(claude|codex),/.test(row))).toBe(true);
    for (const banned of ["SECRET", "s-0", "cx-1", "/home/", ".jsonl"]) expect(csv.join("\n").includes(banned)).toBe(false);
  });

  test("[integration] 30 or more labelled sessions give a computed verdict; the labelled sessions are asked first", async () => {
    const { claude } = sources(32);
    const cwd = mkdtempSync(join(tmpdir(), "tmx-labels-"));
    const first = join(cwd, "r1");
    await capture(() => main(["--claude", claude, "--codex", "none", "--from", "2026-10-09", "--to", "2026-10-16", "--out", first]));
    const keys = readFileSync(join(first, "sessions.csv"), "utf8").trim().split("\n").slice(1).map((row) => row.split(",")[1] ?? "");
    expect(keys).toHaveLength(32);
    const labels = join(cwd, "labels.csv");
    writeFileSync(labels, ["key,question,label", ...keys.map((k) => `${k},helper_size,small`), "not-a-key,helper_size,small", `${keys[0] ?? ""},helper_size,huge`].join("\n"));
    const stub = stubFetch();
    const out = join(cwd, "r2");
    await capture(() => main(["--claude", claude, "--codex", "none", "--from", "2026-10-09", "--to", "2026-10-16", "--out", out, "--jev", "--yes", "--labels", labels], { env: { [JEV_KEY_VAR]: KEY }, cwd, fetch: stub.fetch }));
    expect(stub.calls).toHaveLength(32);
    const report = readFileSync(join(out, "private-report.md"), "utf8");
    // Jev says small for all 32 (stub); the rule says small for the 19 sessions under 20,000 output tokens.
    expect(report).toMatch(/\| Which helper size fits this session\? \| choice \|[^\n]*\| use Jev \|/);
    expect(report).toContain("Basis: labels: 32 in your labels file; 32 paired, 30 needed");
    expect(report).toContain("Labels file: 32 label(s) read, 2 line(s) rejected.");
    expect(report).toMatch(/\| TokenMax score of this session[^\n]*\| not enough evidence \|/);
  });
});
