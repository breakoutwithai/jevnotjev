import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Answer, type RecordRow, applyLabels, formatRecords, parseRecords, record, ruleOutput } from "./arms.ts";
import {
  ARMS, DEMO_IDS, DEMO_OUT, EXAMPLE_DIR, LABEL_OUT, RUN_DIR, build, buildDemo, judge, labelPage, readDemoScript,
} from "./stage-demo.ts";

const RECORDS = join(RUN_DIR, "records.csv");

async function records(): Promise<RecordRow[]> {
  return parseRecords(await readFile(RECORDS, "utf8"));
}
async function sheet(): Promise<string> {
  return (await readFile(join(EXAMPLE_DIR, "fact-sheet.md"), "utf8")).trim();
}

/** Narrow the committed demo file back to plain records for comparison, without trusting its declared types. */
function field(o: unknown, k: string): unknown {
  return typeof o === "object" && o !== null && k in o ? Reflect.get(o, k) : undefined;
}
function list(o: unknown): unknown[] {
  return Array.isArray(o) ? o : [];
}

/** Totals straight from the CSV rows, computed without the generator. */
function csvTotals(rows: readonly RecordRow[]): Map<string, { answer: number; hand_off: number; cost: number }> {
  const t = new Map<string, { answer: number; hand_off: number; cost: number }>();
  for (const r of rows) {
    const s = t.get(r.answerer) ?? { answer: 0, hand_off: 0, cost: 0 };
    if (r.output === "answer") s.answer++;
    else s.hand_off++;
    s.cost += Number(r.cost_usd || 0);
    t.set(r.answerer, s);
  }
  return t;
}

describe("stage-door demo data", () => {
  test("[unit] UC13-STAGE-1 pending mode: 8 messages, each arm's answer as recorded, every verdict pending", async () => {
    // The recorded rows with no labels: the first-round state, and still testable after labels land.
    const rows = (await records()).map((r) => ({ ...r, label: "", label_source: "" }));
    const d = buildDemo(rows, await sheet());
    expect(d.mode).toBe("pending");
    expect(d.messages.map((m) => m.id)).toEqual([...DEMO_IDS]);
    let compared = 0;
    for (const m of d.messages) {
      expect(m.label).toBeNull();
      for (const a of ARMS) {
        const row = rows.find((r) => r.case_id === m.id && r.answerer === a.key);
        expect<string | undefined>(m.outputs[a.key]?.output).toBe(row?.output ?? "missing");
        expect(m.outputs[a.key]?.verdict).toBe("pending");
        expect(m.text).toBe(row?.case_input ?? "missing");
        compared++;
      }
    }
    expect(compared).toBe(24);
    const totals = csvTotals(rows);
    expect(d.cases_total).toBe(40);
    for (const a of ARMS) {
      const t = d.tally[a.key];
      const c = totals.get(a.key);
      expect(t?.answer).toBe(c?.answer ?? -1);
      expect(t?.hand_off).toBe(c?.hand_off ?? -1);
      expect(t?.cost_usd).toBeCloseTo(c?.cost ?? -1, 8);
      expect(t?.accept).toBeNull();
      expect(t?.labelled).toBe(0);
      expect((t?.answer ?? 0) + (t?.hand_off ?? 0)).toBe(40);
    }
    expect(d.note).toContain("40 messages we wrote about a made-up shop");
    expect(d.label_page).toBe("label/");
  });

  test("[unit] UC13-STAGE-2 labelled mode on a labelled copy: accept is output equals the human answer, tally adds accepts and misses", async () => {
    const rows = await records();
    // A fixture label set, applied through the real merge step (run-arms.ts label): even-numbered messages hand off.
    const truth = new Map<string, Answer>(rows.map((r) => [r.case_id, Number(r.case_id.slice(1)) % 2 === 0 ? "hand_off" : "answer"]));
    const dir = await mkdtemp(join(tmpdir(), "jnj-stage-"));
    try {
      await cp(RUN_DIR, dir, { recursive: true });
      await writeFile(join(dir, "records.csv"), formatRecords(applyLabels(rows, truth)));
      const labelled = parseRecords(await readFile(join(dir, "records.csv"), "utf8"));
      const built = await build(dir, EXAMPLE_DIR);
      const d = buildDemo(labelled, await sheet());
      expect(readDemoScript(built.demo)).toEqual(JSON.parse(JSON.stringify(d)));
      expect(d.mode).toBe("labelled");
      for (const m of d.messages) {
        expect(m.label).toBe(truth.get(m.id) ?? "answer");
        for (const a of ARMS) {
          const o = m.outputs[a.key];
          expect(o?.verdict).toBe(o?.output === truth.get(m.id) ? "accept" : "reject");
        }
      }
      for (const a of ARMS) {
        const arm = rows.filter((r) => r.answerer === a.key);
        const right = arm.filter((r) => r.output === truth.get(r.case_id)).length;
        const unsafe = arm.filter((r) => r.output === "answer" && truth.get(r.case_id) === "hand_off").length;
        const careful = arm.filter((r) => r.output === "hand_off" && truth.get(r.case_id) === "answer").length;
        const t = d.tally[a.key];
        expect(t?.labelled).toBe(40);
        expect(t?.accept).toBe(right);
        expect(t?.answered_should_hand_off).toBe(unsafe);
        expect(t?.handed_off_could_answer).toBe(careful);
        expect(right + unsafe + careful).toBe(40);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("[unit] UC13-STAGE-3 a label column holding the answer itself is judged the same as accept / reject", () => {
    const base = record({ case_id: "m01", case_input: "x" }, "jev", "jev-1.13.0", "answer");
    expect(judge({ ...base, label: "" })).toEqual({ verdict: "pending", truth: null });
    expect(judge({ ...base, label: "accept" })).toEqual({ verdict: "accept", truth: "answer" });
    expect(judge({ ...base, label: "reject" })).toEqual({ verdict: "reject", truth: "hand_off" });
    expect(judge({ ...base, label: "hand_off" })).toEqual({ verdict: "reject", truth: "hand_off" });
    expect(judge({ ...base, label: "answer" })).toEqual({ verdict: "accept", truth: "answer" });
    expect(() => judge({ ...base, label: "maybe" })).toThrow();
  });

  test("[unit] UC13-STAGE-4 the 8 include a rule-word message the rule hands off and a no-rule-word message another arm hands off", async () => {
    const d = buildDemo(await records(), await sheet());
    expect(d.messages.some((m) => ruleOutput(m.text) === "hand_off" && m.outputs.jev?.output === "answer")).toBe(true);
    expect(d.messages.some((m) => ruleOutput(m.text) === "answer" && m.outputs.jev?.output === "hand_off")).toBe(true);
  });

  test("[integration] UC13-STAGE-5 committed site/uc13-demo.js matches records.csv: 8/8 rows, 40-message tally, pending = unlabelled (M3)", async () => {
    const rows = await records();
    const built = await build();
    const committed = await readFile(DEMO_OUT, "utf8");
    expect(committed).toBe(built.demo);
    const d = readDemoScript(committed);
    const msgs = list(field(d, "messages"));
    let match = 0;
    let pending = 0;
    let unlabelled = 0;
    for (const m of msgs) {
      const id = field(m, "id");
      const outs = field(m, "outputs");
      const csv = ARMS.map((a) => rows.find((r) => r.case_id === id && r.answerer === a.key));
      // output as recorded; verdict accept when output equals the label's answer, reject otherwise, pending when unlabelled
      const ok = ARMS.every((a, i) => {
        const r = csv[i];
        return r !== undefined && field(field(outs, a.key), "output") === r.output && field(field(outs, a.key), "verdict") === judge(r).verdict;
      });
      if (ok) match++;
      if (ARMS.every((a) => field(field(outs, a.key), "verdict") === "pending")) pending++;
      if (csv.every((r) => r?.label === "")) unlabelled++;
    }
    const totals = csvTotals(rows);
    const tally = field(d, "tally");
    const tallyOk = ARMS.every((a) => {
      const t = field(tally, a.key);
      const c = totals.get(a.key);
      return field(t, "answer") === c?.answer && field(t, "hand_off") === c?.hand_off && Math.abs(Number(field(t, "cost_usd")) - (c?.cost ?? NaN)) < 1e-8;
    });
    console.log(`M3: ${match}/${msgs.length} demo rows match records.csv; tally equals the ${new Set(rows.map((r) => r.case_id)).size}-message totals (${rows.length} rows): ${tallyOk}; pending ${pending} of ${unlabelled} unlabelled`);
    expect(msgs.length).toBe(8);
    expect(match).toBe(8);
    expect(tallyOk).toBe(true);
    expect(pending).toBe(unlabelled);
  });

  test("[integration] UC13-STAGE-6 the live label page is the run's page plus a back link, self-contained, no dashes", async () => {
    const page = await readFile(LABEL_OUT, "utf8");
    expect(page).toBe(labelPage(await readFile(join(RUN_DIR, "label.html"), "utf8")));
    expect(page).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|import\(/);
    expect(page).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(page).toContain("labels.csv");
    expect(page).toContain('href="../"');
    for (const code of [0x2013, 0x2014]) expect(page.includes(String.fromCharCode(code))).toBe(false);
    // Blind labelling: no arm's model id appears on the page.
    for (const r of await records()) expect(page.includes(r.answerer_model)).toBe(false);
  });
});
