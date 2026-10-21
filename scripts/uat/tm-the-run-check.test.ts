import { expect, test } from "bun:test";
import { expectedEnd, report, runTheRunCheck, summarise, type Check } from "./tm-the-run-check.ts";

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
  const base = { drop: false, ghost: false, settled: false, half: 0, extra: 0, cancelled: 0, verdict: "", badge: "", focus: "", skipHidden: true };
  expect(expectedEnd("#burn-before", { ...base, drop: true, cancelled: 3, verdict: "Walk out" })).toBeNull();
  expect(expectedEnd("#burn-before", { ...base, drop: true, cancelled: 2, verdict: "Walk out" })).not.toBeNull();
  expect(expectedEnd("#under-after", { ...base, settled: true, extra: 6, verdict: "Standing ovation", badge: "Target passed" })).toBeNull();
  expect(expectedEnd("#under-after", { ...base, settled: true, extra: 5, verdict: "Standing ovation", badge: "Target passed" })).not.toBeNull();
  expect(expectedEnd("#command", { ...base, focus: "command" })).toBeNull();
  expect(expectedEnd("#command", { ...base, focus: "copy" })).not.toBeNull();
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
