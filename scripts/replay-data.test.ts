import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readDictRows } from "../src/format/csv.ts";
import { RUN_SOURCES } from "../src/evidence/replay.ts";
import { REPLAY_OUT, REPO_URL, buildCustom, buildReplay, parseCustomArgs, readReplayScript, replayScript } from "./replay-data.ts";

const ROOT = join(import.meta.dir, "..");
const SITE = join(ROOT, "site", "replay");

function field(o: unknown, k: string): unknown {
  return typeof o === "object" && o !== null && k in o ? Reflect.get(o, k) : undefined;
}
function list(o: unknown): unknown[] {
  return Array.isArray(o) ? o : [];
}

describe("replay page data (scripts/replay-data.ts)", () => {
  test("[unit] RD-1 every run carries every CSV row once, with its line and a link to the file on main", async () => {
    const d = readReplayScript(replayScript(await buildReplay()));
    const runs = list(field(d, "runs"));
    expect(runs.map((r) => field(r, "key"))).toEqual(RUN_SOURCES.map((s) => s.key));
    for (const s of RUN_SOURCES) {
      const csv = readDictRows(await readFile(join(ROOT, s.file), "utf8"));
      const r = runs.find((x) => field(x, "key") === s.key);
      expect(list(field(r, "rows")).map((x) => field(x, "line"))).toEqual(csv.rows.map((x) => x.line));
      expect(field(r, "sourceUrl")).toBe(`${REPO_URL}/blob/main/${s.file}`);
    }
    expect(field(d, "min_paired")).toBe(30);
  });

  test("[integration] RD-2 committed site/replay/replay-data.js equals a fresh build (no drift), and --check says so", async () => {
    expect(await readFile(REPLAY_OUT, "utf8")).toBe(replayScript(await buildReplay()));
    expect(Bun.spawnSync(["bun", join(import.meta.dir, "replay-data.ts"), "--check"]).exitCode).toBe(0);
    const bad = Bun.spawnSync(["bun", join(import.meta.dir, "replay-data.ts"), "--chek"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain("usage");
  });

  test("[unit] RD-3 the page loads the generated data before its script, and neither makes a request or holds a local path", async () => {
    const page = await readFile(join(SITE, "index.html"), "utf8");
    expect(page.indexOf('src="replay-data.js"')).toBeGreaterThan(0);
    expect(page.indexOf('src="replay-data.js"')).toBeLessThan(page.indexOf('src="replay.js"'));
    const js = await readFile(join(SITE, "replay.js"), "utf8");
    const data = await readFile(REPLAY_OUT, "utf8");
    for (const text of [js, data]) {
      expect(text).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon/);
      expect(text).not.toMatch(/\/(?:Users|home)\//);
    }
  });

  test("[unit] RD-4 the page lists each question's limitation lines and each method's label source from the data, escaped", async () => {
    const built = await buildReplay();
    const d12 = built.runs.find((r) => r.key === "d12");
    if (d12 === undefined) throw new Error("no d12 run");
    const hostile = { ...d12, provenance: [...d12.provenance, "<b>x</b>"] };
    const data = { ...built, runs: built.runs.map((r) => (r.key === "d12" ? hostile : r)) };
    const els = new Map<string, { innerHTML: string; textContent: string; hidden: boolean }>();
    const el = (id: string) => {
      const found = els.get(id);
      if (found !== undefined) return found;
      const made = { innerHTML: "", textContent: "", hidden: false, classList: { toggle: () => {} }, style: {}, addEventListener: () => {}, focus: () => {} };
      els.set(id, made);
      return made;
    };
    const document = { getElementById: el, querySelectorAll: () => [], body: { setAttribute: () => {} } };
    const location = { search: "?run=d12", href: "https://example.test/replay/?run=d12" };
    const page = new Function("window", "document", "location", "history", "matchMedia", "CSS", await readFile(join(SITE, "replay.js"), "utf8"));
    page(await pageWindow(data), document, location, { replaceState: () => {} }, () => ({ matches: false }), { escape: (s: string) => s });
    const html = el("limits").innerHTML;
    expect(html).toContain("<li>Limitation: Uneven cases across methods: llm 4, rule 3, jev 4.</li>");
    expect(html).toContain("<li>Limitation: Missing costs: llm 1 row with no cost, so spend is incomplete.</li>");
    for (const line of d12.provenance) expect(html).toContain(`<li>${line}</li>`);
    expect(html).toContain("<li>&lt;b&gt;x&lt;/b&gt;</li>");
    expect(html).not.toContain("<b>x</b>");
  });

  test("[unit] RD-5 a question id repeated across prompt versions gets a heading naming its run and prompt", async () => {
    const built = await buildReplay();
    const d12 = built.runs.find((r) => r.key === "d12");
    if (d12 === undefined) throw new Error("no d12 run");
    const q = d12.questions[0];
    if (q === undefined) throw new Error("no d12 question");
    const twin = { ...d12, questions: [{ ...q, promptVersion: "p.v1" }, { ...q, promptVersion: "p.v2" }] };
    const data = { ...built, runs: built.runs.map((r) => (r.key === "d12" ? twin : r)) };
    const els = new Map<string, { innerHTML: string; textContent: string; hidden: boolean }>();
    const el = (id: string) => {
      const found = els.get(id);
      if (found !== undefined) return found;
      const made = { innerHTML: "", textContent: "", hidden: false, classList: { toggle: () => {} }, style: {}, addEventListener: () => {}, focus: () => {} };
      els.set(id, made);
      return made;
    };
    const document = { getElementById: el, querySelectorAll: () => [], body: { setAttribute: () => {} } };
    const location = { search: "?run=d12", href: "https://example.test/replay/?run=d12" };
    const page = new Function("window", "document", "location", "history", "matchMedia", "CSS", await readFile(join(SITE, "replay.js"), "utf8"));
    page(await pageWindow(data), document, location, { replaceState: () => {} }, () => ({ matches: false }), { escape: (s: string) => s });
    const html = el("limits").innerHTML;
    expect(html).toContain(`Question ${q.runId} p.v1 ${q.questionId}: `);
    expect(html).toContain(`Question ${q.runId} p.v2 ${q.questionId}: `);
  });

  test("[unit] RD-6 one-run mode parses its flags and refuses an unknown flag, a bad page size and a missing file", () => {
    const a = parseCustomArgs(["--records", "/x/records.csv", "--out", "/y/data.js", "--key", "k", "--page-by", "10", "--extra", "decisions", "--spotlight", "tim-q2=Heading here"]);
    expect(a.source.pageBy).toBe(10);
    expect(a.source.extraMethods).toEqual(["decisions"]);
    expect(a.source.spotlight).toEqual({ caseKey: "tim-q2", heading: "Heading here" });
    expect(a.source.file).toBe("records.csv");
    expect(() => parseCustomArgs(["--records", "a.csv", "--out", "b.js", "--page-by", "0"])).toThrow("positive");
    expect(() => parseCustomArgs(["--records", "a.csv", "--out", "b.js", "--bogus", "1"])).toThrow("bad argument");
    expect(() => parseCustomArgs(["--records", "a.csv"])).toThrow("required");
  });

  test("[integration] RD-7 a paged run with a spotlight case, an unreviewed extra method and generator labels reaches the page data", async () => {
    const header = "format_version,run_id,prompt_version,case_id,case_input,question_id,question,answer_set,answerer,answerer_model,output,confidence,label,label_source,tokens_in,tokens_out,cost_usd,latency_ms,labelled_by,labelled_at,label_blind";
    const rows: string[] = [];
    for (let i = 1; i <= 25; i++) {
      for (const [who, out] of [["llm", "yes"], ["rule", "no"], ["jev", "yes"]] as const) {
        const label = out === "yes" ? "accept" : "reject";
        rows.push(`jnj-record/1.1,r1,p1,c${i},"CV ${i}\nline two",q1,Q?,yes|no,${who},m-${who},${out},,${label},agent,1,1,0.001,1,synthetic-generator,2026-10-08,false`);
      }
    }
    const path = join(import.meta.dir, `.tmp-rd7-${process.pid}.csv`);
    await Bun.write(path, `${header}\n${rows.join("\n")}\n`);
    try {
      const a = parseCustomArgs(["--records", path, "--out", "unused.js", "--page-by", "10", "--extra", "decisions", "--spotlight", "c25=Recruit"]);
      const run = (await buildCustom(a)).runs[0];
      if (run === undefined) throw new Error("no run");
      expect(run.pageBy).toBe(10);
      expect(run.spotlight?.caseKey).toBe("c25");
      expect(run.methods).toEqual(["llm", "rule", "jev", "decisions"]);
      expect(run.rows.every((r) => r.generated === true && r.truth !== "")).toBe(true);
      expect(run.stats.find((s) => s.method === "jev")?.accept).toBe(25);
      expect(run.stats.find((s) => s.method === "rule")?.accept).toBe(0);
      expect(run.flags.map((f) => f.id)).toContain("custom-decisions-no-rows");
      expect(run.flags.some((f) => f.kind === "unlabelled" && f.method === "jev")).toBe(true);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("[unit] RD-8 the committed runs carry no paging and no generator-label marks", async () => {
    const built = await buildReplay();
    for (const r of built.runs) {
      expect(r.pageBy).toBeUndefined();
      expect(r.rows.some((x) => x.generated === true)).toBe(false);
    }
  });
});

/** The page's window: the data, plus the paging helpers the page script loads before itself. */
async function pageWindow(data: unknown): Promise<Record<string, unknown>> {
  const win: Record<string, unknown> = { JNJ_REPLAY: data };
  new Function("window", await readFile(join(SITE, "paging.js"), "utf8"))(win);
  return win;
}
