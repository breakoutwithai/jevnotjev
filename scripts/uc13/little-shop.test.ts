import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CASE_IDS, parseRecords, type RecordRow } from "./arms.ts";
import { DATA_OUT, PAGE, RUN_URL, VERDICT_OUT, build, readShopScript } from "./little-shop.ts";
import { RUN_DIR } from "./stage-demo.ts";
import { shopVerdict } from "../../src/browser/shop-verdict.ts";

async function records(): Promise<RecordRow[]> {
  return parseRecords(await readFile(join(RUN_DIR, "records.csv"), "utf8"));
}
function field(o: unknown, k: string): unknown {
  return typeof o === "object" && o !== null && k in o ? Reflect.get(o, k) : undefined;
}
function list(o: unknown): unknown[] {
  return Array.isArray(o) ? o : [];
}

/** Runs the built verdict bundle in a sandbox and returns what it put on window. */
function loadBundle(js: string): unknown {
  const sandbox: Record<string, unknown> = {};
  new Function("globalThis", "window", "crypto", "TextEncoder", js)(sandbox, sandbox, crypto, TextEncoder);
  return sandbox.JNJShopVerdict;
}

describe("Little Shop data and verdict bundle (scripts/uc13/little-shop.ts)", () => {
  test("[unit] LS-1 all 40 messages, each arm's output and the message text exactly as records.csv holds them", async () => {
    const rows = await records();
    const d = readShopScript((await build()).data);
    const msgs = list(field(d, "messages"));
    expect(msgs.map((m) => field(m, "id"))).toEqual([...CASE_IDS]);
    let match = 0;
    for (const m of msgs) {
      const id = field(m, "id");
      const mine = rows.filter((r) => r.case_id === id);
      const ok = mine.length === 3 && mine.every((r) => field(field(m, "outputs"), r.answerer) === r.output && r.case_input === field(m, "text"));
      if (ok) match++;
    }
    console.log(`LS-1: ${match}/${msgs.length} messages match records.csv (${rows.length} rows)`);
    expect(match).toBe(40);
  });

  test("[unit] LS-2 each arm's spend is the sum of its 40 cost_usd cells; names and models as recorded", async () => {
    const rows = await records();
    const d = readShopScript((await build()).data);
    const arms = list(field(d, "arms"));
    expect(arms.map((a) => field(a, "key"))).toEqual(["llm", "rule", "jev"]);
    for (const a of arms) {
      const mine = rows.filter((r) => r.answerer === field(a, "key"));
      const sum = mine.reduce((s, r) => s + Number(r.cost_usd), 0);
      expect(Math.abs(Number(field(a, "spend_usd")) - sum)).toBeLessThan(1e-9);
      expect(field(a, "model")).toBe(mine[0]?.answerer_model);
    }
    expect(arms.map((a) => field(a, "spend_usd"))).toEqual([0.103167, 0, 0.00130176]);
    expect(arms.map((a) => field(a, "name"))).toEqual(["What you do now", "A simple rule", "Jev decides"]);
    expect(field(d, "records_csv")).toBe(await readFile(join(RUN_DIR, "records.csv"), "utf8"));
  });

  test("[integration] LS-3 committed site/little-shop/shop-data.js and verdict.js equal a fresh build (no drift)", async () => {
    const built = await build();
    expect(await readFile(DATA_OUT, "utf8")).toBe(built.data);
    expect(await readFile(VERDICT_OUT, "utf8")).toBe(built.verdict);
    expect(Bun.spawnSync(["bun", join(import.meta.dir, "little-shop.ts"), "--check"]).exitCode).toBe(0);
    const bad = Bun.spawnSync(["bun", join(import.meta.dir, "little-shop.ts"), "--chek"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain("usage");
  });

  test("[integration] LS-4 the browser bundle gives the same verdict as src/browser/shop-verdict.ts for the same calls", async () => {
    const built = await build();
    const api = loadBundle(built.verdict);
    const fn = field(api, "shopVerdict");
    if (typeof fn !== "function") throw new Error("bundle has no shopVerdict");
    const csv = await readFile(join(RUN_DIR, "records.csv"), "utf8");
    for (const n of [29, 30, 40]) {
      const calls: Record<string, string> = {};
      CASE_IDS.slice(0, n).forEach((id, i) => { calls[id] = i % 4 === 0 ? "answer" : "hand_off"; });
      const fromBundle: unknown = await fn(csv, calls);
      expect(fromBundle).toEqual(await shopVerdict(csv, calls));
    }
    expect(built.verdict).not.toMatch(/\/(?:Users|home)\//); // no absolute local paths in the bundle
  });

  test("[unit] LS-5 the run date the footer states is the run's date, and its link is the run folder", async () => {
    const d = readShopScript((await build()).data);
    expect(field(d, "run_id")).toBe("run-shopbot-2026-10-01");
    expect(field(d, "run_date")).toBe("2026-10-01");
    expect(field(d, "run_url")).toBe(RUN_URL);
    const page = await readFile(PAGE, "utf8");
    const footer = page.slice(page.indexOf("<footer"), page.indexOf("</footer>"));
    expect(footer).toContain("1 October 2026");
    expect(footer).toContain(`href="${RUN_URL}"`);
  });
});
