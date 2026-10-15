import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { sampleRun } from "./d17-sample-export.ts";
import { EXIT_CODES, parseCsv, toCsv } from "./math-check.ts";
import { main, render, verifyCore, type CheckId, type CheckResult, type PageReport } from "./verify-core.ts";
import type { BackstageRun } from "../src/backstage/run.ts";

type Evidence = ReturnType<BackstageRun["evidence"]>;

const IDS: readonly CheckId[] = ["export-check", "three-methods", "cost-per-accepted", "verdict", "hand-math"];

let page: PageReport;
let exp: Evidence;

beforeAll(async () => {
  // sampleRun() patches the clock and crypto globally and throws on overlap: build it once, clone per test.
  const run = await sampleRun();
  page = await run.report();
  exp = run.evidence();
});

const text = (e: Evidence): string => JSON.stringify(e, null, 2);
const freshExport = (): Evidence => structuredClone(exp);
const freshPage = (): PageReport => structuredClone(page);

function byId(results: readonly CheckResult[], id: CheckId): CheckResult {
  const found = results.find((r) => r.id === id);
  if (!found) throw new Error(`no result for ${id}`);
  return found;
}
function failing(results: readonly CheckResult[]): CheckId[] {
  return results.filter((r) => !r.ok).map((r) => r.id);
}
/** Rebuild a page with pair `index` replaced; the report types are readonly, so mutate by copying. */
function withPair(p: PageReport, index: number, change: (pair: PageReport["pairs"][number]) => PageReport["pairs"][number]): PageReport {
  return { ...p, pairs: p.pairs.map((pair, i) => (i === index ? change(pair) : pair)) };
}
/** Replace one arm's totals in a pair's metrics. */
function withArm(
  pair: PageReport["pairs"][number],
  arm: string,
  change: (a: PageReport["pairs"][number]["metrics"]["arms"][number]) => PageReport["pairs"][number]["metrics"]["arms"][number],
): PageReport["pairs"][number] {
  return { ...pair, metrics: { ...pair.metrics, arms: pair.metrics.arms.map((a) => (a.arm === arm ? change(a) : a)) } };
}
function dropArmRows(csv: string, answerer: string): string {
  const rows = parseCsv(csv);
  const header = rows[0];
  if (!header) throw new Error("empty csv");
  const col = header.indexOf("answerer");
  if (col < 0) throw new Error("no answerer column");
  return toCsv(rows.filter((r, i) => i === 0 || r[col] !== answerer));
}
function firstVerdict(e: Evidence): NonNullable<NonNullable<Evidence["verdicts"]>[number]["verdict"]> {
  const v = e.verdicts?.[0]?.verdict;
  if (!v) throw new Error("sample has no verdict");
  return v;
}

describe("verifyCore on the real sample", () => {
  test("[integration] row 1: all five checks pass in order and render ends PASS (5/5)", async () => {
    const results = await verifyCore(freshPage(), text(freshExport()));
    expect(results.map((r) => r.id)).toEqual([...IDS]);
    expect(failing(results)).toEqual([]);
    expect(render(results).trimEnd().split("\n").at(-1)).toBe("verify-core: PASS (5/5)");
  });

  test("[unit] row 2: a flipped label fails export-check only", async () => {
    const e = freshExport();
    const first = e.labels[0];
    if (!first) throw new Error("no labels");
    e.labels = e.labels.map((l, i) => (i === 0 ? { ...l, label: first.label === "accept" ? "reject" : "accept" } : l));
    const results = await verifyCore(freshPage(), text(e));
    expect(failing(results)).toEqual(["export-check"]);
  });

  test("[unit] row 3: non-JSON and [] fail every check without throwing", async () => {
    for (const bad of ["not json {", "[]"]) {
      const results = await verifyCore(freshPage(), bad);
      expect(results.map((r) => r.id)).toEqual([...IDS]);
      expect(failing(results)).toEqual([...IDS]);
    }
  });

  test("[unit] row 4: a page without the rule arm fails three-methods and cost-per-accepted", async () => {
    // Remove rule from every pair so the page union lacks it.
    const p = freshPage();
    const all = { ...p, pairs: p.pairs.map((pair) => ({ ...pair, metrics: { ...pair.metrics, arms: pair.metrics.arms.filter((a) => a.arm !== "rule") } })) };
    const results = await verifyCore(all, text(freshExport()));
    expect(byId(results, "three-methods").ok).toBe(false);
    expect(byId(results, "three-methods").detail).toContain("page");
    expect(byId(results, "three-methods").detail).toContain("rule");
    expect(byId(results, "cost-per-accepted").ok).toBe(false);
    expect(byId(results, "verdict").ok).toBe(true);
    expect(byId(results, "export-check").ok).toBe(true);
  });

  test("[unit] row 5: export comparisons without rule rows fail three-methods on the export side", async () => {
    const e = freshExport();
    e.comparisons = e.comparisons.map((c) => ({ ...c, csv: dropArmRows(c.csv, "rule") }));
    const results = await verifyCore(freshPage(), text(e));
    const three = byId(results, "three-methods");
    expect(three.ok).toBe(false);
    expect(three.detail).toContain("export");
    expect(byId(results, "verdict").ok).toBe(true);
  });

  test("[unit] row 6: jev cost per accepted + 1e-6 on the page fails cost-per-accepted only", async () => {
    let p = freshPage();
    let changed = 0;
    p = {
      ...p,
      pairs: p.pairs.map((pair) =>
        withArm(pair, "jev", (a) => {
          const c = a.costPerAccepted;
          if (c.kind !== "value") throw new Error("sample jev cost is not a value");
          changed += 1;
          return { ...a, costPerAccepted: { kind: "value", usd: c.usd + 1e-6 } };
        }),
      ),
    };
    expect(changed).toBeGreaterThan(0);
    const results = await verifyCore(p, text(freshExport()));
    expect(failing(results)).toEqual(["cost-per-accepted"]);
    expect(byId(results, "cost-per-accepted").detail).toContain("jev");
  });

  test("[unit] row 7: jev cost undefined on the page fails cost-per-accepted", async () => {
    const p = withPair(freshPage(), 0, (pair) =>
      withArm(pair, "jev", (a) => ({ ...a, costPerAccepted: { kind: "undefined", reason: "zero accepted" } })),
    );
    const results = await verifyCore(p, text(freshExport()));
    expect(byId(results, "cost-per-accepted").ok).toBe(false);
    expect(byId(results, "three-methods").ok).toBe(true);
  });

  test("[unit] row 8a: an extra page pair fails cost-per-accepted", async () => {
    const p = freshPage();
    const extra = p.pairs[0];
    if (!extra) throw new Error("no pair");
    const results = await verifyCore({ ...p, pairs: [...p.pairs, { ...extra, armId: "ghost-arm" }] }, text(freshExport()));
    expect(byId(results, "cost-per-accepted").ok).toBe(false);
  });

  test("[unit] row 8b: a duplicate export comparison fails cost-per-accepted", async () => {
    const e = freshExport();
    const dup = e.comparisons[0];
    if (!dup) throw new Error("no comparison");
    e.comparisons = [...e.comparisons, dup];
    const results = await verifyCore(freshPage(), text(e));
    expect(byId(results, "cost-per-accepted").ok).toBe(false);
  });

  test("[unit] row 8c: a differing page runId fails cost-per-accepted", async () => {
    const p = withPair(freshPage(), 0, (pair) => ({ ...pair, runId: pair.runId + "-x" }));
    const results = await verifyCore(p, text(freshExport()));
    expect(byId(results, "cost-per-accepted").ok).toBe(false);
  });

  test("[unit] row 9: a changed exported verdict name fails verdict", async () => {
    const e = freshExport();
    const v = firstVerdict(e);
    const other = v.verdict === "use Jev" ? "don't use Jev" : "use Jev";
    e.verdicts = (e.verdicts ?? []).map((entry, i) => (i === 0 ? { ...entry, verdict: { ...v, verdict: other } } : entry));
    const results = await verifyCore(freshPage(), text(e));
    expect(byId(results, "verdict").ok).toBe(false);
    expect(byId(results, "three-methods").ok).toBe(true);
    expect(byId(results, "cost-per-accepted").ok).toBe(true);
  });

  test("[unit] row 10: verdicts = null fails verdict", async () => {
    const e = freshExport();
    e.verdicts = null;
    const results = await verifyCore(freshPage(), text(e));
    expect(byId(results, "verdict").ok).toBe(false);
    expect(byId(results, "three-methods").ok).toBe(true);
    expect(byId(results, "cost-per-accepted").ok).toBe(true);
  });

  test("[unit] row 11: a null page verdict against an exported one fails verdict", async () => {
    const p = withPair(freshPage(), 0, (pair) => ({ ...pair, verdict: null }));
    const results = await verifyCore(p, text(freshExport()));
    expect(failing(results)).toEqual(["verdict"]);
  });

  test("[unit] row 12: a changed page verdict reason (same name) fails verdict", async () => {
    const p = withPair(freshPage(), 0, (pair) => {
      if (!pair.verdict) throw new Error("sample pair has no verdict");
      return { ...pair, verdict: { ...pair.verdict, reason: pair.verdict.reason + " (edited)" } };
    });
    const results = await verifyCore(p, text(freshExport()));
    expect(failing(results)).toEqual(["verdict"]);
  });

  test("[integration] row 13: empty or missing records fail hand-math", async () => {
    const empty = freshExport();
    empty.records = "";
    expect(byId(await verifyCore(freshPage(), text(empty)), "hand-math").ok).toBe(false);
    const missing: Record<string, unknown> = { ...freshExport() };
    delete missing.records;
    const results = await verifyCore(freshPage(), JSON.stringify(missing));
    expect(byId(results, "hand-math").ok).toBe(false);
  });

  test("[integration] row 14: header-only records never pass hand-math", async () => {
    const e = freshExport();
    e.records = (e.records.split("\n")[0] ?? "") + "\n";
    const results = await verifyCore(freshPage(), text(e));
    expect(byId(results, "hand-math").ok).toBe(false);
  });

  test("[unit] row 16: a page with pairs = [] fails without throwing", async () => {
    const results = await verifyCore({ ...freshPage(), pairs: [] }, text(freshExport()));
    expect(results.map((r) => r.id)).toEqual([...IDS]);
    expect(byId(results, "three-methods").ok).toBe(false);
    expect(byId(results, "cost-per-accepted").ok).toBe(false);
    expect(byId(results, "verdict").ok).toBe(false);
  });
});

type PageVerdict = NonNullable<PageReport["pairs"][number]["verdict"]>;
/** A verdict with its cost-ratio upper bound replaced; the sample has a cost ratio, so a missing one is a test defect. */
function withUpper(v: PageVerdict, upper: number): PageVerdict {
  const ratio = v.numbers.costRatio;
  if (!ratio) throw new Error("sample verdict has no cost ratio");
  return { ...v, numbers: { ...v.numbers, costRatio: { ...ratio, upper } } };
}
/** Built at run time so the file holds no key-shaped literal. */
const planted = (): string => "sk-ant-api03-" + "x".repeat(90);

describe("verifyCore defects found in review of PR #226", () => {
  test("[unit] row 18: Infinity on the page and null in the export (what JSON does) still passes verdict", async () => {
    const p = withPair(freshPage(), 0, (pair) => {
      if (!pair.verdict) throw new Error("sample pair has no verdict");
      return { ...pair, verdict: withUpper(pair.verdict, Infinity) };
    });
    const e = freshExport();
    e.verdicts = (e.verdicts ?? []).map((entry, i) => (i === 0 && entry.verdict ? { ...entry, verdict: withUpper(entry.verdict, Infinity) } : entry));
    const exported = text(e);
    expect(exported).toContain('"upper": null');
    expect(byId(await verifyCore(p, exported), "verdict").ok).toBe(true);
  });

  test("[unit] row 19: Infinity on the page against a finite exported number fails verdict", async () => {
    const p = withPair(freshPage(), 0, (pair) => {
      if (!pair.verdict) throw new Error("sample pair has no verdict");
      return { ...pair, verdict: withUpper(pair.verdict, Infinity) };
    });
    expect(byId(await verifyCore(p, text(freshExport())), "verdict").ok).toBe(false);
  });

  test("[unit] row 20a: a credential-shaped armId on an export comparison is never printed", async () => {
    const key = planted();
    const a = freshExport();
    a.comparisons = a.comparisons.map((c, i) => (i === 0 ? { ...c, armId: key } : c));
    const ra = await verifyCore(freshPage(), text(a));
    expect(byId(ra, "cost-per-accepted").ok).toBe(false);
    expect(render(ra)).not.toContain(key);
  });

  test("[unit] row 20b: a credential-shaped armId on an export verdict is never printed", async () => {
    const key = planted();
    const b = freshExport();
    b.verdicts = (b.verdicts ?? []).map((v, i) => (i === 0 ? { ...v, armId: key } : v));
    const rb = await verifyCore(freshPage(), text(b));
    expect(byId(rb, "verdict").ok).toBe(false);
    expect(render(rb)).not.toContain(key);
  });

  test("[unit] row 20c: a credential-shaped case_id in the export records is never printed", async () => {
    const key = planted();
    const c = freshExport();
    c.records = c.records.replaceAll(",c01,", `,${key},`);
    expect(c.records).toContain(key);
    const rc = await verifyCore(freshPage(), text(c));
    expect(failing(rc).length).toBeGreaterThan(0);
    expect(render(rc)).not.toContain(key);
  });

  test("[unit] row 21: hand-math never prints the runner's err text, only the exit name and the counts line", async () => {
    const key = planted();
    const leak = (): { code: number; out: string; err: string } => ({ code: EXIT_CODES.mismatch, out: `${key}\n`, err: key });
    const bad = byId(await verifyCore(freshPage(), text(freshExport()), leak), "hand-math");
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("mismatch");
    expect(bad.detail).not.toContain(key);
    const counts = (): { code: number; out: string; err: string } => ({
      code: EXIT_CODES.mismatch,
      out: "compared=4 states=2 mismatches=1 excluded=0\n",
      err: key,
    });
    const withCounts = byId(await verifyCore(freshPage(), text(freshExport()), counts), "hand-math");
    expect(withCounts.detail).toContain("compared=4 states=2 mismatches=1 excluded=0");
    expect(withCounts.detail).not.toContain(key);
  });

  test("[unit] row 22: a repeated arm inside a page pair fails three-methods and cost-per-accepted", async () => {
    const p = withPair(freshPage(), 0, (pair) => {
      const jev = pair.metrics.arms.find((a) => a.arm === "jev");
      if (!jev) throw new Error("sample pair has no jev");
      const wrong = { ...jev, costPerAccepted: { kind: "value" as const, usd: 999 } };
      return { ...pair, metrics: { ...pair.metrics, arms: [wrong, ...pair.metrics.arms] } };
    });
    const results = await verifyCore(p, text(freshExport()));
    expect(byId(results, "three-methods").ok).toBe(false);
    expect(byId(results, "cost-per-accepted").ok).toBe(false);
  });

  test("[unit] row 23: no verdict on either side fails verdict", async () => {
    const p = withPair(freshPage(), 0, (pair) => ({ ...pair, verdict: null }));
    const e = freshExport();
    e.verdicts = (e.verdicts ?? []).map((v, i) => (i === 0 ? { ...v, verdict: null } : v));
    expect(byId(await verifyCore(p, text(e)), "verdict").ok).toBe(false);
  });

  test("[unit] row 24: five ok results all named export-check render FAIL", () => {
    const same: CheckResult[] = [1, 2, 3, 4, 5].map(() => ({ id: "export-check", ok: true, detail: "x" }));
    expect(render(same).trimEnd().split("\n").at(-1)?.startsWith("verify-core: FAIL")).toBe(true);
  });

  test("[unit] row 25: in a multi-pair run, a pair without rule fails three-methods", async () => {
    const p = freshPage();
    const first = p.pairs[0];
    if (!first) throw new Error("no pair");
    const second = { ...first, armId: "second-arm", metrics: { ...first.metrics, arms: first.metrics.arms.filter((a) => a.arm !== "rule") } };
    const e = freshExport();
    const c = e.comparisons[0];
    const v = e.verdicts?.[0];
    if (!c || !v) throw new Error("no comparison or verdict");
    e.comparisons = [c, { ...c, armId: "second-arm" }];
    e.verdicts = [v, { ...v, armId: "second-arm" }];
    const results = await verifyCore({ ...p, pairs: [first, second] }, text(e));
    const three = byId(results, "three-methods");
    expect(three.ok).toBe(false);
    expect(three.detail).toContain("pairs[1]");
  });

  test("[unit] row 26: verdicts = [] and an extra export verdict entry both fail verdict", async () => {
    const none = freshExport();
    none.verdicts = [];
    expect(byId(await verifyCore(freshPage(), text(none)), "verdict").ok).toBe(false);
    const extra = freshExport();
    const v = extra.verdicts?.[0];
    if (!v) throw new Error("no verdict");
    extra.verdicts = [v, { ...v, armId: "ghost-arm" }];
    expect(byId(await verifyCore(freshPage(), text(extra)), "verdict").ok).toBe(false);
  });

  test("[unit] row 27: a math-check exit of nothingCompared fails hand-math", async () => {
    const stub = (): { code: number; out: string; err: string } => ({ code: EXIT_CODES.nothingCompared, out: "compared=0 states=0 mismatches=0 excluded=0\n", err: "" });
    const hand = byId(await verifyCore(freshPage(), text(freshExport()), stub), "hand-math");
    expect(hand.ok).toBe(false);
    expect(hand.detail).toContain("nothingCompared");
  });

  test("[unit] row 28: a repeated page pair fails cost-per-accepted", async () => {
    const p = freshPage();
    const first = p.pairs[0];
    if (!first) throw new Error("no pair");
    const results = await verifyCore({ ...p, pairs: [first, first] }, text(freshExport()));
    expect(byId(results, "cost-per-accepted").ok).toBe(false);
    expect(byId(results, "cost-per-accepted").detail).toContain("pairs[1]");
  });

  test("[unit] row 29: a comparison whose records fail validation fails three-methods and cost-per-accepted", async () => {
    const e = freshExport();
    e.comparisons = e.comparisons.map((c, i) => (i === 0 ? { ...c, csv: "not,a,record\nx,y,z\n" } : c));
    const results = await verifyCore(freshPage(), text(e));
    for (const id of ["three-methods", "cost-per-accepted"] as const) {
      expect(byId(results, id).ok).toBe(false);
      expect(byId(results, id).detail).toContain("comparisons[0]");
    }
  });

  test("[unit] row 30: NaN in a page verdict (addN) against an exported null fails verdict only", async () => {
    const p = withPair(freshPage(), 0, (pair) => {
      if (!pair.verdict) throw new Error("sample pair has no verdict");
      return { ...pair, verdict: { ...pair.verdict, addN: NaN } };
    });
    const exported = text(freshExport());
    expect(exported).toContain('"addN": null');
    const results = await verifyCore(p, exported);
    expect(failing(results)).toEqual(["verdict"]);
    expect(byId(results, "verdict").detail).toContain("pairs[0]: verdict differs from export verdicts at addN");
  });

  test("[unit] row 31: NaN nested in verdict.numbers (costRatio.upper) against an exported null fails verdict", async () => {
    const p = withPair(freshPage(), 0, (pair) => {
      if (!pair.verdict) throw new Error("sample pair has no verdict");
      return { ...pair, verdict: withUpper(pair.verdict, NaN) };
    });
    const e = freshExport();
    e.verdicts = (e.verdicts ?? []).map((entry, i) => (i === 0 && entry.verdict ? { ...entry, verdict: withUpper(entry.verdict, NaN) } : entry));
    const exported = text(e);
    expect(exported).toContain('"upper": null');
    const results = await verifyCore(p, exported);
    expect(byId(results, "verdict").ok).toBe(false);
    expect(byId(results, "verdict").detail).toContain("pairs[0]: verdict differs from export verdicts at numbers.costRatio.upper");
  });

  /** A page and an export that both carry `change` applied to the first verdict; JSON turns Infinity into null in the export. */
  function bothWith(change: (v: PageVerdict) => PageVerdict): { page: PageReport; exported: string } {
    const p = withPair(freshPage(), 0, (pair) => {
      if (!pair.verdict) throw new Error("sample pair has no verdict");
      return { ...pair, verdict: change(pair.verdict) };
    });
    const e = freshExport();
    e.verdicts = (e.verdicts ?? []).map((entry, i) => (i === 0 && entry.verdict ? { ...entry, verdict: change(entry.verdict) } : entry));
    return { page: p, exported: text(e) };
  }

  test("[unit] row 32: Infinity in a page verdict (addN) against an exported null fails verdict only", async () => {
    const { page: p, exported } = bothWith((v) => ({ ...v, addN: Infinity }));
    expect(exported).toContain('"addN": null');
    const results = await verifyCore(p, exported);
    expect(failing(results)).toEqual(["verdict"]);
    expect(byId(results, "verdict").detail).toContain("pairs[0]: verdict differs from export verdicts at addN");
  });

  test("[unit] row 33: Infinity in numbers.jevAccepted against an exported null fails verdict", async () => {
    const { page: p, exported } = bothWith((v) => ({ ...v, numbers: { ...v.numbers, jevAccepted: Infinity } }));
    expect(exported).toContain('"jevAccepted": null');
    const results = await verifyCore(p, exported);
    expect(byId(results, "verdict").ok).toBe(false);
    expect(byId(results, "verdict").detail).toContain("at numbers.jevAccepted");
  });

  test("[unit] row 34: -Infinity in costRatio.upper against an exported null fails verdict", async () => {
    const { exported } = bothWith((v) => withUpper(v, Infinity));
    expect(exported).toContain('"upper": null');
    const minus = withPair(freshPage(), 0, (pair) => {
      if (!pair.verdict) throw new Error("sample pair has no verdict");
      return { ...pair, verdict: withUpper(pair.verdict, -Infinity) };
    });
    const results = await verifyCore(minus, exported);
    expect(byId(results, "verdict").ok).toBe(false);
    expect(byId(results, "verdict").detail).toContain("at numbers.costRatio.upper");
  });

  test("[unit] row 35: an extra key on a page verdict that the export lacks fails verdict", async () => {
    const p = withPair(freshPage(), 0, (pair) => {
      if (!pair.verdict) throw new Error("sample pair has no verdict");
      const widened = { ...pair.verdict, extra: 1 };
      return { ...pair, verdict: widened };
    });
    const results = await verifyCore(p, text(freshExport()));
    expect(failing(results)).toEqual(["verdict"]);
    expect(byId(results, "verdict").detail).toContain("pairs[0]: verdict differs from export verdicts at extra");
  });
});

describe("render and main", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test("[unit] row 17: render prints one line per check and a FAIL summary with the count", () => {
    const out = render([
      { id: "export-check", ok: true, detail: "fine" },
      { id: "three-methods", ok: false, detail: "bad" },
    ]);
    expect(out).toContain("PASS export-check: fine");
    expect(out).toContain("FAIL three-methods: bad");
    expect(out.trimEnd().split("\n").at(-1)).toBe("verify-core: FAIL (1/5)");
  });

  test("[integration] row 15: main() on the real sample returns 0 and prints 5 PASS lines", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    let code: number;
    try {
      code = await main();
    } finally {
      spy.mockRestore();
    }
    const out = lines.join("\n");
    expect(code).toBe(0);
    expect(out.split("\n").filter((l) => l.startsWith("PASS ")).length).toBe(5);
    expect(out).toContain("verify-core: PASS (5/5)");
  });
});
