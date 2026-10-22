// The replay page leads with the outcome the product promises: a verdict and the cost per accepted answer per
// method, read here from the rendered page and compared with src/core calc on the same records file (#396).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { fileSeed } from "../src/core/calc.ts";
import { armsInFile, groupCohorts, metricsOfCohortRows } from "../src/core/metrics.ts";
import { verdict } from "../src/core/verdict.ts";
import { validate } from "../src/format/validate.ts";
import { RUN_SOURCES } from "../src/evidence/replay.ts";
import { resolveChromium } from "./uat/happy-path-lib.ts";

const ROOT = join(import.meta.dir, "..");
const SITE = join(ROOT, "site");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const file = Bun.file(join(SITE, path.endsWith("/") ? `${path}index.html` : path));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  browser = await chromium.launch({ executablePath: found.path });
});
afterAll(async () => {
  await browser.close();
  server.stop(true);
});

interface Expected { readonly questionId: string; readonly verdict: string; readonly reason: string; readonly cost: ReadonlyMap<string, number | null> }

async function expectedFor(file: string): Promise<Expected[]> {
  const text = readFileSync(join(ROOT, file), "utf8");
  const result = validate(text);
  const seed = await fileSeed(text);
  const arms = armsInFile(result.rows);
  return groupCohorts(result.rows).map(({ key, rows }) => {
    const metrics = metricsOfCohortRows(rows, key);
    const v = verdict(metrics, seed, arms);
    const cost = new Map(metrics.arms.map((a) => [a.arm, a.costPerAccepted.kind === "value" ? a.costPerAccepted.usd : null] as const));
    return { questionId: key.questionId, verdict: v.verdict, reason: v.reason, cost };
  });
}

describe("replay page verdict (site/replay)", () => {
  for (const source of RUN_SOURCES) {
    test(`[integration] RV-1 ${source.key} shows each question's verdict and cost per accepted answer as src/core computes them`, async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${server.port}/replay/?run=${source.key}`, { waitUntil: "load" });
        const expected = await expectedFor(source.file);
        const blocks = page.locator("#verdict .vq");
        expect(await blocks.count()).toBe(expected.length);
        for (const [i, want] of expected.entries()) {
          const block = blocks.nth(i);
          expect(await block.locator("[data-verdict]").innerText()).toBe(want.verdict);
          expect(await block.locator("[data-reason]").innerText()).toBe(want.reason);
          for (const [arm, usd] of want.cost) {
            const cell = block.locator(`[data-cpa="${arm}"]`);
            const shown = await cell.innerText();
            if (usd === null) expect(shown).toMatch(/incomplete|undefined/);
            else if (usd === 0) expect(shown).toBe("$0");
            else expect(Number(shown.replace("$", ""))).toBe(Number(usd.toPrecision(3)));
          }
        }
      } finally { await page.close(); }
    }, 30000);
  }

  test("[integration] RV-2 on the 100-case run the verdict sits above the replay deck and says use Jev", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.port}/replay/?run=uc13-100`, { waitUntil: "load" });
      expect(await page.locator("#verdict [data-verdict]").first().innerText()).toBe("use Jev");
      const above = await page.evaluate(() => {
        const v = document.getElementById("verdict");
        const d = document.getElementById("deck");
        return v !== null && d !== null && (v.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      expect(above).toBe(true);
    } finally { await page.close(); }
  }, 30000);
});
