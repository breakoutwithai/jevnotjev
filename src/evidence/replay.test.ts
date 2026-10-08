// D14 replay view: the tally maths and the incomplete-evidence flags, checked against the repo's own record files.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MIN_PAIRED } from "../core/verdict.ts";
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
    const flag = run.flags.find((f) => f.kind === "unlabelled");
    expect(flag?.id).toBe("t-unlabelled");
    expect(flag?.lines.length).toBe(3);
    expect(flag?.text).toBe("0 of 3 answered rows labelled, so no method has an accept rate");
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
});
