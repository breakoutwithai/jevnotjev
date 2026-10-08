// D14 replay view: the tally maths and the incomplete-evidence flags, checked against the repo's own record files.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MIN_PAIRED, verdict } from "../core/verdict.ts";
import { groupCohorts, metricsOfCohortRows } from "../core/metrics.ts";
import { validate } from "../format/validate.ts";
import { evaluateText } from "../browser/results-loader.ts";
import { RUN_SOURCES, parseRun, tallyThrough, usd, type ReplayRun, type RunSource } from "./replay.ts";

const ROOT = join(import.meta.dir, "..", "..");
const HEADER = "format_version,run_id,prompt_version,case_id,case_input,question_id,question,answer_set,answerer,answerer_model,output,confidence,label,label_source,tokens_in,tokens_out,cost_usd,latency_ms";
const INLINE: RunSource = { key: "t", file: "inline.csv", title: "Inline run", synthetic: true };

function source(key: string): RunSource {
  const found = RUN_SOURCES.find((s) => s.key === key);
  if (found === undefined) throw new Error(`no run source ${key}`);
  return found;
}
async function load(key: string): Promise<ReplayRun> {
  const s = source(key);
  return parseRun(await readFile(join(ROOT, s.file), "utf8"), s);
}
function stat(run: ReplayRun, method: string) {
  const found = run.stats.find((s) => s.method === method);
  if (found === undefined) throw new Error(`no stats for ${method}`);
  return found;
}

describe("replay evidence (src/evidence/replay.ts)", () => {
  test("[unit] RP-1 UC13 accepts are rule 29, jev 38, llm 38 of 40, all labelled, no flags", async () => {
    const uc13 = await load("uc13");
    expect(["rule", "jev", "llm"].map((m) => stat(uc13, m).accept)).toEqual([29, 38, 38]);
    expect(["rule", "jev", "llm"].map((m) => stat(uc13, m).rows)).toEqual([40, 40, 40]);
    expect(["rule", "jev", "llm"].map((m) => stat(uc13, m).labelled)).toEqual([40, 40, 40]);
    expect(uc13.cases.length).toBe(40);
    expect(uc13.flags).toEqual([]);
  });

  test("[unit] RP-2 UC13 costs are the cost_usd sums, shown in the site's cost format", async () => {
    const uc13 = await load("uc13");
    expect(stat(uc13, "jev").cost?.toFixed(6)).toBe("0.001302");
    expect(stat(uc13, "llm").cost?.toFixed(6)).toBe("0.103167");
    expect(stat(uc13, "rule").cost).toBe(0);
    expect(stat(uc13, "rule").costText).toBe("$0");
    expect(stat(uc13, "jev").costText).toBe("$0.001302");
    expect(uc13.rows.every((r) => r.costUsd !== null && !/\d{7,}/.test(r.costText))).toBe(true);
  });

  test("[unit] RP-3 TokenMax is rule 6, jev 10, llm 10 of 10, human_reviewed, and below the minimum per question", async () => {
    const tm = await load("tokenmax");
    expect(["rule", "jev", "llm"].map((m) => [stat(tm, m).accept, stat(tm, m).rows])).toEqual([[6, 10], [10, 10], [10, 10]]);
    expect(tm.labelSource).toContain("human_reviewed");
    expect(tm.flags.some((f) => f.kind === "unlabelled")).toBe(false);
    const below = tm.flags.filter((f) => f.kind === "below-minimum");
    expect(below.map((f) => f.id).sort()).toEqual(["tokenmax-below-minimum-q1", "tokenmax-below-minimum-q2"]);
    expect(below[0]?.text).toContain("5 paired labelled cases");
    expect(below[0]?.text).toContain(`a verdict needs ${MIN_PAIRED}`);
  });

  test("[unit] RP-4 d12 carries its two planted gaps and is below the minimum", async () => {
    const d12 = await load("d12");
    expect(d12.synthetic).toBe(true);
    expect(d12.flags.map((f) => f.id).sort()).toEqual(["d12-below-minimum", "d12-llm-cost-d02", "d12-rule-missing-d04"]);
    expect(d12.flags.find((f) => f.id === "d12-rule-missing-d04")?.kind).toBe("missing");
    expect(stat(d12, "rule").rows).toBe(3);
    expect(stat(d12, "llm").cost).toBeNull();
    expect(stat(d12, "llm").costText).toBe("incomplete");
    expect(stat(d12, "llm").knownCostText).toBe("$0.001000");
    expect([stat(d12, "rule").casesCovered, stat(d12, "jev").casesCovered]).toEqual([3, 4]);
    expect(d12.flags.find((f) => f.kind === "below-minimum")?.text).toContain("do not pick a method from this run yet");
    expect(d12.flags.find((f) => f.id === "d12-llm-cost-d02")?.lines.length).toBe(1);
  });

  test("[unit] RP-5 flag text never repeats the run name (the page groups flags under their run)", async () => {
    for (const s of RUN_SOURCES) {
      const run = await load(s.key);
      for (const f of run.flags) expect(f.text).not.toContain(s.title);
    }
  });

  test("[unit] RP-6 a quoted case_input with commas does not create a fake method", async () => {
    const tm = await load("tokenmax");
    expect(tm.methods).toEqual(["llm", "rule", "jev"]);
    expect(tm.rows.some((r) => r.input.includes(","))).toBe(true);
    const run = parseRun(`${HEADER}\njnj-record/1,r,p.v1,c1,"Hello, world, again",q1,"Is it, really?",yes|no,jev,jev-1,yes,0.9,accept,human,1,1,0.000001,1\n`, INLINE);
    expect(run.methods).toEqual(["jev"]);
    expect(run.rows[0]?.input).toBe("Hello, world, again");
  });

  test("[unit] RP-7 a run whose answered rows are unlabelled is flagged with every such row", () => {
    const run = parseRun([
      HEADER,
      "jnj-record/1,r,p.v1,c1,Hi,q1,Ok?,yes|no,jev,j,yes,0.9,,,1,1,0.000001,1",
      "jnj-record/1,r,p.v1,c1,Hi,q1,Ok?,yes|no,llm,m,yes,,,,1,1,0.000001,1",
      "jnj-record/1,r,p.v1,c2,Hi,q1,Ok?,yes|no,jev,j,no,0.9,,,1,1,0.000001,1",
    ].join("\n"), INLINE);
    const flags = run.flags.filter((f) => f.kind === "unlabelled");
    expect(flags.map((f) => [f.id, f.lines.length])).toEqual([["t-llm-unlabelled", 1], ["t-jev-unlabelled", 2]]);
    expect(flags[1]?.text).toBe("Jev decides: 2 of 2 answered rows have no reviewed label, so it has no accept rate");
  });

  test("[unit] RP-8 a 1.2 refused row is not answered, not a reject and not unlabelled", () => {
    const run = parseRun([
      `${HEADER},outcome`,
      "jnj-record/1.2,r,p.v1,c1,Hi,q1,Ok?,yes|no,llm,m,,,,,5,0,0.000006,10,refused",
      "jnj-record/1.2,r,p.v1,c1,Hi,q1,Ok?,yes|no,jev,j,yes,0.9,accept,human,5,1,0.000001,10,answered",
    ].join("\n"), INLINE);
    const llm = stat(run, "llm");
    expect([llm.rows, llm.answered, llm.reject, llm.unlabelled]).toEqual([1, 0, 0, 0]);
    expect(run.flags.some((f) => f.kind === "unlabelled")).toBe(false);
  });

  test("[unit] RP-9 the tally builds case by case and ends on the recorded totals", async () => {
    for (const s of RUN_SOURCES) {
      const run = await load(s.key);
      const end = tallyThrough(run, run.cases.length - 1);
      for (const st of run.stats) {
        const t = end.find((x) => x.method === st.method);
        expect([t?.accepted, t?.played]).toEqual([st.accept, st.rows]);
      }
      expect(run.steps.length).toBe(run.cases.length);
      expect(run.steps[run.steps.length - 1]).toEqual(end);
    }
    const uc13 = await load("uc13");
    const first = tallyThrough(uc13, 0);
    expect(first.map((t) => t.played)).toEqual([1, 1, 1]);
    const d12 = await load("d12");
    expect(tallyThrough(d12, 3).find((t) => t.method === "rule")?.missing).toBe(1);
  });

  test("[unit] RP-10 usd matches site/little-shop/seating.js for every value shape", async () => {
    const src = await readFile(join(ROOT, "site", "little-shop", "seating.js"), "utf8");
    const win: Record<string, unknown> = {};
    new Function("window", src)(win);
    const seating = win.JNJSeating;
    const fn: unknown = typeof seating === "object" && seating !== null ? Reflect.get(seating, "usd") : undefined;
    if (typeof fn !== "function") throw new Error("seating.js exposes no usd");
    for (const v of [0, 0.00003242, 0.103167, 0.00130176, 1.5, 12.34567]) expect(usd(v)).toBe(String(fn(v)));
    expect(usd(null)).toBe("incomplete");
  });

  test("[unit] RP-11 an agent label is not truth: not an accept, counted unlabelled, flagged, and shown as not counted", () => {
    const run = parseRun([
      HEADER,
      "jnj-record/1,r,p.v1,c1,Hi,q1,Ok?,yes|no,jev,j,yes,0.9,accept,agent,1,1,0.000001,1",
      "jnj-record/1,r,p.v1,c2,Hi,q1,Ok?,yes|no,jev,j,yes,0.9,accept,human,1,1,0.000001,1",
    ].join("\n"), INLINE);
    const jev = stat(run, "jev");
    expect([jev.accept, jev.labelled, jev.unlabelled]).toEqual([1, 1, 1]);
    expect(run.steps[0]?.[0]?.accepted).toBe(0);
    expect(run.flags.find((f) => f.kind === "unlabelled")?.lines).toEqual([2]);
    expect([run.rows[0]?.truth, run.rows[0]?.labelNote]).toEqual(["", "not counted (AI label, not reviewed)"]);
    expect([run.rows[1]?.truth, run.rows[1]?.labelNote]).toEqual(["accept", ""]);
  });

  test("[unit] RP-12 a method missing two cases says it covers the real count", () => {
    const lines = [HEADER];
    for (const c of ["d01", "d02", "d03", "d04"]) {
      for (const m of c === "d03" || c === "d04" ? ["jev"] : ["jev", "rule"]) lines.push(`jnj-record/1,r,p.v1,${c},Hi,q1,Ok?,yes|no,${m},x,yes,,accept,human,1,1,0.000001,1`);
    }
    const missing = parseRun(lines.join("\n"), INLINE).flags.filter((f) => f.kind === "missing");
    expect(missing.map((f) => f.caseKey)).toEqual(["d03", "d04"]);
    for (const f of missing) expect(f.text).toContain("covers 2 of 4 cases");
  });

  test("[unit] RP-13 one unlabelled llm row names that method and its count", () => {
    const run = parseRun([
      HEADER,
      "jnj-record/1,r,p.v1,c1,Hi,q1,Ok?,yes|no,jev,j,yes,0.9,accept,human,1,1,0.000001,1",
      "jnj-record/1,r,p.v1,c1,Hi,q1,Ok?,yes|no,llm,m,yes,,accept,human,1,1,0.000001,1",
      "jnj-record/1,r,p.v1,c2,Hi,q1,Ok?,yes|no,jev,j,no,0.9,reject,human,1,1,0.000001,1",
      "jnj-record/1,r,p.v1,c2,Hi,q1,Ok?,yes|no,llm,m,no,,,,1,1,0.000001,1",
    ].join("\n"), INLINE);
    const flags = run.flags.filter((f) => f.kind === "unlabelled");
    expect(flags.map((f) => [f.id, f.method, f.lines])).toEqual([["t-llm-unlabelled", "llm", [5]]]);
    expect(flags[0]?.text).toBe("What you do now: 1 of 2 answered rows has no reviewed label, so its accept rate counts 1 row");
  });

  test("[unit] RP-14 pairing keys on run, prompt version and question, and a duplicate row is refused by name", () => {
    const split = parseRun([
      HEADER,
      "jnj-record/1,r,p.v1,c1,Hi,q1,Ok?,yes|no,jev,j,yes,0.9,accept,human,1,1,0.000001,1",
      "jnj-record/1,r,p.v1,c1,Hi,q1,Ok?,yes|no,llm,m,yes,,accept,human,1,1,0.000001,1",
      "jnj-record/1,r,p.v2,c1,Hi,q1,Ok?,yes|no,llm,m,yes,,accept,human,1,1,0.000001,1",
    ].join("\n"), INLINE);
    expect(split.pairs.map((p) => [p.promptVersion, p.other, p.n])).toEqual([["p.v1", "llm", 1]]);
    expect(() => parseRun([
      HEADER,
      "jnj-record/1,r,p.v1,c1,Hi,q1,Ok?,yes|no,jev,j,yes,0.9,accept,human,1,1,0.000001,1",
      "jnj-record/1,r,p.v1,c1,Hi,q1,Ok?,yes|no,jev,j,no,0.9,reject,human,1,1,0.000001,1",
      "jnj-record/1,r,p.v1,c1,Hi,q1,Ok?,yes|no,llm,m,yes,,accept,human,1,1,0.000001,1",
    ].join("\n"), INLINE)).toThrow("more than one jev row for case c1");
  });

  test("[unit] RP-16 the planted d14 file gives each question the loader's limitation lines: missing label, missing cost, zero-row method", async () => {
    const run = parseRun(await readFile(join(ROOT, "examples/d14-gaps/records.csv"), "utf8"), { key: "d14", file: "examples/d14-gaps/records.csv", title: "Gaps", synthetic: true });
    const [q1, q2] = run.questions;
    expect(run.questions.map((q) => q.questionId)).toEqual(["q1", "q2"]);
    expect(q1?.limitations).toContain("Missing labels: rule 1 row with no label, left out of every pairing.");
    expect(q1?.limitations).toContain("Missing costs: llm 1 row with no cost, so spend is incomplete.");
    expect(q2?.limitations).toContain("Uneven cases across methods: llm 2, rule 0, jev 2.");
    expect(run.provenance).toEqual(["jev: labels: human 4; blind: not recorded", "llm: labels: human 4; blind: not recorded", "rule: labels: human 1; blind: not recorded"]);
  });

  test("[unit] RP-17 every record file's limitation and provenance lines equal the core verdict and loader output", async () => {
    for (const s of RUN_SOURCES) {
      const text = await readFile(join(ROOT, s.file), "utf8");
      const run = parseRun(text, s);
      const loaded = await evaluateText(s.file, text);
      expect(loaded.valid).toBe(true);
      expect(run.provenance).toEqual(loaded.provenance);
      expect(run.questions.map((q) => [q.runId, q.promptVersion, q.questionId, q.limitations])).toEqual(
        loaded.questions.map((q) => [q.runId, q.promptVersion, q.questionId, q.limitations]),
      );
    }
    const d12 = await load("d12");
    expect(d12.questions[0]?.limitations).toContain("Uneven cases across methods: llm 4, rule 3, jev 4.");
  });

  test("[unit] RP-18 only the synthetic generator's agent label counts in the tally; any other agent label stays not counted", () => {
    const head = `${HEADER},labelled_by,labelled_at,label_blind`;
    const row = (by: string): string => `jnj-record/1.1,r,p,c1,CV,q1,Q?,yes|no,jev,jev-1.13.0,yes,,accept,agent,1,1,0.001,1,${by},2026-10-08,false`;
    const gen = parseRun(`${head}\n${row("synthetic-generator")}\n`, INLINE);
    expect(gen.rows[0]?.truth).toBe("accept");
    expect(gen.rows[0]?.generated).toBe(true);
    const other = parseRun(`${head}\n${row("some-model")}\n`, INLINE);
    expect(other.rows[0]?.truth).toBe("");
    expect(other.rows[0]?.labelNote).toBe("not counted (AI label, not reviewed)");
    expect(other.rows[0]?.generated).toBeUndefined();
  });

  test("[unit] RP-15 paired and accept counts equal src/core/metrics.ts and verdict.ts on every record file", async () => {
    for (const s of RUN_SOURCES) {
      const text = await readFile(join(ROOT, s.file), "utf8");
      const run = parseRun(text, s);
      const checked = validate(text);
      expect(checked.errors).toEqual([]);
      const groups = groupCohorts(checked.rows).map((g) => ({ key: g.key, m: metricsOfCohortRows(g.rows, g.key) }));
      for (const arm of ["llm", "rule", "jev"]) {
        const want = groups.reduce((sum, g) => sum + (g.m.arms.find((a) => a.arm === arm)?.accepted ?? 0), 0);
        expect([s.key, arm, stat(run, arm).accept]).toEqual([s.key, arm, want]);
      }
      const want = groups.flatMap((g) => {
        const v = verdict(g.m, 1);
        const out: [string, string, string, string, number][] = [];
        if (g.m.jevVsLlm !== null) out.push([g.key.runId, g.key.promptVersion, g.key.questionId, "llm", v.numbers.jevVsLlm?.n ?? g.m.jevVsLlm.n]);
        const rule = v.ruleComparison;
        if (g.m.jevVsRule !== null) out.push([g.key.runId, g.key.promptVersion, g.key.questionId, "rule", rule.kind === "compared" ? rule.n : rule.paired]);
        return out;
      });
      expect(want.length).toBeGreaterThan(0);
      expect(run.pairs.map((p) => [p.runId, p.promptVersion, p.questionId, p.other, p.n])).toEqual(want);
    }
  });
});
