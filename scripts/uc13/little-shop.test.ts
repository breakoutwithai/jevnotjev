import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASE_IDS, parseRecords, type RecordRow } from "./arms.ts";
import { DATA_OUT, PAGE, RUN_URL, VERDICT_OUT, build, buildData, readShopScript } from "./little-shop.ts";
import { EXAMPLE_DIR, RUN_DIR } from "./stage-demo.ts";
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
  test("[integration] S6 recorded result page leads with headline, verdict, then projection", async () => {
    const source = (await readFile(PAGE, "utf8")).replace(/<div class="recorded-run"[^>]*>[\s\S]*?<\/div>/, "");
    expect(source).not.toContain('class="recorded-run"');
    const built = await build(RUN_DIR, EXAMPLE_DIR, source);
    const block = built.page.match(/<div class="recorded-run"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    const children = [...block.matchAll(/<(h3|p) class="([^"]+)">([^<]*)<\/\1>/g)].map((match) => ({ className: match[2], text: match[3] }));
    expect(children).toEqual([
      { className: "recorded-caption", text: "Recorded run, 1 October 2026: 40 paired cases" },
      { className: "recorded-headline", text: "Same accuracy as the LLM (38/40 each) at 1/79th of the cost" },
      { className: "recorded-verdict", text: "Verdict: not enough evidence" },
      { className: "recorded-why", text: "Not proven yet: the lower bound of Jev minus the LLM is -0.11, below the -0.10 margin, on 40 paired cases. If the next cases split the same way, about 6 more paired cases would bring it inside the margin." },
    ]);
    expect(await readFile(PAGE, "utf8")).toBe(built.page);
  });

  test("[integration] S6 resolved run directory spelling gives the same result", async () => {
    expect(await build(`${RUN_DIR}/.`)).toEqual(await build(RUN_DIR));
  });

  test("[integration] S6 a different run directory supplies its own headline", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jnj-shop-run-"));
    const other = join(temp, "2026-10-02-other-run");
    try {
      await mkdir(other);
      const csv = await readFile(join(RUN_DIR, "records.csv"), "utf8");
      const changed = csv.replace(",0.00209100,4189,", ",0.20209100,4189,");
      expect(changed).not.toBe(csv);
      await writeFile(join(other, "records.csv"), changed);
      await writeFile(join(other, "label.html"), await readFile(join(RUN_DIR, "label.html"), "utf8"));
      const built = await build(other);
      expect(built.page).not.toContain("Same accuracy as the LLM (38/40 each) at 1/79th of the cost");
      expect(built.page).toContain('class="recorded-headline"');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

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
    // the run id is read from the parsed rows, so a quoted first field reads the same
    const csv = await readFile(join(RUN_DIR, "records.csv"), "utf8");
    const quoted = csv.replace(/^jnj-record\/1\.1,/gm, '"jnj-record/1.1",');
    expect(quoted).not.toBe(csv);
    expect(buildData(quoted, "sheet").run_date).toBe("2026-10-01");
    expect(list(field(field(d, "fact_sheet"), "lines")).length).toBeGreaterThan(0);
    const page = await readFile(PAGE, "utf8");
    const footer = page.slice(page.indexOf("<footer"), page.indexOf("</footer>"));
    expect(footer).toContain("1 October 2026");
    expect(footer).toContain(`href="${RUN_URL}"`);
  });
});
