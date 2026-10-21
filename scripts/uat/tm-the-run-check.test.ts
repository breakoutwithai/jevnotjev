import { expect, test } from "bun:test";
import { badArgs, BANNED_ANYWHERE, bannedHits, expectedEnd, jargonHits, mapUnchanged, PROMPT, PROMPT_NEGATION, report, runTheRunCheck, summarise, type Check } from "./tm-the-run-check.ts";

// En and em dash, built from code points so no dash glyph sits in this file.
const DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const check = (width: number, ok: boolean, name = "x"): Check => ({ width, name, ok, detail: ok ? "" : "broke" });

test("[unit] TR-1 summarise counts per width and is clean only with checks and no failures", () => {
  const s = summarise([check(1440, true), check(390, true), check(390, false, "small text"), check(0, true)]);
  expect([...s.widths]).toEqual([[0, { run: 1, passed: 1, failed: 0 }], [390, { run: 2, passed: 1, failed: 1 }], [1440, { run: 1, passed: 1, failed: 0 }]]);
  expect(s.total).toEqual({ run: 4, passed: 3, failed: 1 });
  expect(s.clean).toBe(false);
  // Zero checks is not clean: a run that checked nothing proves nothing.
  expect(summarise([]).clean).toBe(false);
  expect(report([check(390, false, "small text")])).toContain("FAIL [390px] small text: broke");
  expect(report([check(390, true)])).toContain("CLEAN");
});

test("[unit] TR-2 each end-state deep link names what it must show", () => {
  const base = { drop: false, ghost: false, settled: false, half: 0, extra: 0, cancelled: 0, verdict: "", badge: "", focus: "", skipHidden: true, promptShown: false };
  expect(expectedEnd("#burn-before", { ...base, drop: true, cancelled: 3, verdict: "Walk out" })).toBeNull();
  expect(expectedEnd("#burn-before", { ...base, drop: true, cancelled: 2, verdict: "Walk out" })).not.toBeNull();
  expect(expectedEnd("#under-after", { ...base, settled: true, extra: 6, verdict: "Standing ovation", badge: "Target passed" })).toBeNull();
  expect(expectedEnd("#under-after", { ...base, settled: true, extra: 5, verdict: "Standing ovation", badge: "Target passed" })).not.toBeNull();
  expect(expectedEnd("#command", { ...base, focus: "command", promptShown: true })).toBeNull();
  expect(expectedEnd("#command", { ...base, focus: "command", promptShown: false })).not.toBeNull();
  expect(expectedEnd("#command", { ...base, focus: "copy", promptShown: true })).not.toBeNull();
});

test("[unit] TR-4 the issue #309 jargon list flags each word, whole words only; the prompt carries no curl or terminal", () => {
  for (const word of ["curl", "Bun", "terminal", "logs", "token", "tokens", "subagent", "JSONL"]) expect(jargonHits([`one ${word} here`])).toHaveLength(1);
  expect(jargonHits(["TokenMax presents", "Your week is a run of seven shows", "Claude Code or Codex", "bundle"])).toEqual([]);
  expect(PROMPT).not.toMatch(BANNED_ANYWHERE);
});

test("[unit] TR-6 the prompt is plain text: no link, no install step; banned words are caught anywhere except the prompt's own 'do not download' line", () => {
  expect(PROMPT).not.toMatch(/https?:\/\/|map\.ts|--share|\bbun\b|\bscript\b/i);
  for (const part of ["last 7 days", "Read only the usage records, never the words of my messages or the contents of my files", "'not recorded'", PROMPT_NEGATION, "\nTOKENMAX WEEK\nPeriod: <start date> to <end date>\n", "\nPattern: <running out | leaving most unused>\n", "Use 'not recorded' for any line you cannot fill. Round numbers freely. Do not add anything else."]) expect(PROMPT).toContain(part);
  // The last lines stop the assistant's own audit chatter.
  expect(PROMPT.endsWith("Print only the block above. No notes, caveats, warnings, checks, counts of duplicates or files, or explanations before or after it. If a number is approximate, just give the number.")).toBe(true);
  // Never sharing, uploading, links or maps; the block's own "Opus share of Claude output" label is a proportion.
  expect(PROMPT.replace("Opus share of Claude output", "")).not.toMatch(/upload|\blinks?\b|\bmaps?\b|\bshar(e|ed|ing)\b/i);
  expect(PROMPT).not.toMatch(DASH);
  expect(bannedHits(PROMPT)).toEqual([]);
  for (const word of ["bun", "Curl", "map.ts", "--share", "Terminal", "download", "script"]) expect(bannedHits(`then ${word} it`)).toHaveLength(1);
  expect(bannedHits(`${PROMPT} Now download this.`)).toHaveLength(1);
  expect(bannedHits("bundle, description, Codex")).toEqual([]);
});

test("[unit] TR-5 the map.ts check fails on a base that is not a commit; unknown CLI flags are refused", () => {
  for (const base of ["--cached", "no-such-ref-309"]) expect(mapUnchanged(base)).toMatchObject({ ok: false, detail: `${base} is not a commit` });
  expect(mapUnchanged("HEAD").ok).toBe(true);
  expect(badArgs([])).toBeNull();
  expect(badArgs(["--base", "origin/main", "--page", "x.html"])).toBeNull();
  expect(badArgs(["--bsae", "origin/main"])).toBe("unknown argument --bsae");
  expect(badArgs(["--base"])).toBe("--base needs a value");
});

test("[integration] TR-3 The Run on site/tm/index.html passes every check at 390 and 1440", async () => {
  // base null: map.ts is compared against a ref only from the command line (a fresh clone has no origin/main).
  const checks = await runTheRunCheck({ base: null });
  const s = summarise(checks);
  expect(checks.filter((c) => !c.ok).map((c) => `${c.width} ${c.name}: ${c.detail}`)).toEqual([]);
  expect(s.widths.get(390)?.run ?? 0).toBeGreaterThan(50);
  expect(s.widths.get(1440)?.run ?? 0).toBeGreaterThan(50);
  expect(s.clean).toBe(true);
}, 240000);
