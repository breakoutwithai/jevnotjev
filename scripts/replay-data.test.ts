import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readDictRows } from "../src/format/csv.ts";
import { RUN_SOURCES } from "../src/evidence/replay.ts";
import { REPLAY_OUT, REPO_URL, buildReplay, readReplayScript, replayScript } from "./replay-data.ts";

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
      const made = { innerHTML: "", textContent: "", hidden: false, classList: { toggle: () => {} }, addEventListener: () => {}, focus: () => {} };
      els.set(id, made);
      return made;
    };
    const document = { getElementById: el, querySelectorAll: () => [], body: { setAttribute: () => {} } };
    const location = { search: "?run=d12", href: "https://example.test/replay/?run=d12" };
    const page = new Function("window", "document", "location", "history", "matchMedia", "CSS", await readFile(join(SITE, "replay.js"), "utf8"));
    page({ JNJ_REPLAY: data }, document, location, { replaceState: () => {} }, () => ({ matches: false }), { escape: (s: string) => s });
    const html = el("limits").innerHTML;
    expect(html).toContain("<li>Limitation: Uneven cases across methods: llm 4, rule 3, jev 4.</li>");
    expect(html).toContain("<li>Limitation: Missing costs: llm 1 row with no cost, so spend is incomplete.</li>");
    for (const line of d12.provenance) expect(html).toContain(`<li>${line}</li>`);
    expect(html).toContain("<li>&lt;b&gt;x&lt;/b&gt;</li>");
    expect(html).not.toContain("<b>x</b>");
  });
});
