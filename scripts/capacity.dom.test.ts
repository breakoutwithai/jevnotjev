import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

// The /capacity/ aggregate view of the TokenMax board. A fake server answers GET /api/maps with a known board, counts
// reads, and can be told to fail, so each shown figure is checked against a sum worked out by hand here.

const SITE = join(import.meta.dir, "..", "site");

type Rec = Record<string, unknown>;
function row(id: string, alias: string, caps: [number, number, number], claude: number, codex: number, codexWeekly: number | null): Rec {
  return {
    id, alias, day: "2026-10-21", skill: "0.3.0", days: 7, sources: "claude+codex", sessions: 10, subagent_sessions: 1,
    caps: { short: caps[0], weekly: caps[1], unknown: caps[2] }, output_tokens: { claude, codex }, opus_share_pct: 50, codex_weekly_pct: codexWeekly,
  };
}
// No cap: A (Codex 20 used) and B (Codex 40 used). Hit a cap: C (2 short, 1 weekly; Codex 90) and D (1 unknown; no Codex reading).
const BOARD: Rec[] = [
  row("TM-00000000000A", "pseudo-aaa", [0, 0, 0], 1000, 100, 20),
  row("TM-00000000000B", "pseudo-bbb", [0, 0, 0], 2000, 200, 40),
  row("TM-00000000000C", "pseudo-ccc", [2, 1, 0], 30000, 3000, 90),
  row("TM-00000000000D", "pseudo-ddd", [0, 0, 1], 4000, 0, null),
];

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let origin = "";
let rows: Rec[] = [];
let reads = 0;
let failing = false;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === "/api/maps" && request.method === "GET") {
      reads += 1;
      if (failing) return new Response("down", { status: 503 });
      return Response.json({ rows, totals: { builders: rows.length, cap_episodes: 0, with_weekly_cap: 0 } }, { headers: { "cache-control": "no-store" } });
    }
    const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(file);
  } });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });
beforeEach(() => { rows = BOARD; reads = 0; failing = false; });

async function open(): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await page.clock.install();
  await page.goto(`${origin}/capacity/`, { waitUntil: "load" });
  await page.locator("#capBody").waitFor({ state: "visible" });
  return { page, close: () => context.close() };
}

const cellsOf = async (page: Page, id: string): Promise<string[][]> =>
  page.locator(`#${id} tr`).evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? "")));

test("[integration] tiles and cap windows equal the sums of the board", async () => {
  const { page, close } = await open();
  try {
    const tiles = await page.locator("#capTiles .cap-tile").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    expect(tiles).toEqual(["4maps shared", "2no cap recorded", "2hit a cap", "4cap episodes"]);
    expect(await cellsOf(page, "capWindows")).toEqual([["Short (session)", "2"], ["Weekly", "1"], ["Unknown window", "1"]]);
  } finally { await close(); }
});

test("[integration] headroom beside demand: Codex headroom only where a reading exists", async () => {
  const { page, close } = await open();
  try {
    expect(await cellsOf(page, "capSides")).toEqual([
      ["Maps", "2", "2"],
      ["Claude output tokens used", "3,000", "34,000"],
      ["Codex output tokens used", "300", "3,000"],
      ["Maps with a Codex weekly reading", "2", "1"],
      ["Mean Codex weekly used", "30%", "90%"],
      ["Mean Codex weekly headroom", "70%", "10%"],
    ]);
  } finally { await close(); }
});

test("[integration] a figure no map carries is shown as not measured, never invented", async () => {
  rows = [row("TM-00000000000E", "pseudo-eee", [1, 0, 0], 500, 0, null)];
  const { page, close } = await open();
  try {
    const sides = await cellsOf(page, "capSides");
    expect(sides.at(-2)).toEqual(["Mean Codex weekly used", "not measured", "not measured"]);
    expect(sides.at(-1)).toEqual(["Mean Codex weekly headroom", "not measured", "not measured"]);
    const gaps = await page.locator("#capGaps li").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    expect(gaps).toHaveLength(4);
    expect(gaps[0]).toContain("Plan tier (Lite or other): not measured");
    expect(gaps[1]).toContain("Unused tokens: not measured");
    expect(gaps[2]).toContain("Same-window matching of spare capacity to a capped session: not measured");
    expect(gaps[3]).toBe("Jev analysis of each map: not run. No model runs on board data.");
  } finally { await close(); }
});

test("[integration] the page names no builder: no alias, id or row appears", async () => {
  const { page, close } = await open();
  try {
    const text = await page.locator("body").innerText();
    for (const r of BOARD) {
      expect(text).not.toContain(String(r.alias));
      expect(text).not.toContain(String(r.id));
    }
    expect(await page.locator("body").evaluate((b) => b.innerHTML)).not.toContain("pseudo-");
  } finally { await close(); }
});

test("[integration] it reads the board again after 10 seconds and shows a new map", async () => {
  const { page, close } = await open();
  try {
    expect(reads).toBe(1);
    rows = [...BOARD, row("TM-00000000000F", "pseudo-fff", [0, 0, 0], 10, 10, 50)];
    await page.clock.runFor(10_000);
    await page.waitForFunction(() => document.querySelector("#capTiles .cap-tile b")?.textContent === "5");
    expect(reads).toBe(2);
  } finally { await close(); }
});

test("[integration] a failed read shows an alert and keeps the last good numbers", async () => {
  const { page, close } = await open();
  try {
    failing = true;
    await page.clock.runFor(10_000);
    await page.waitForFunction(() => (document.getElementById("capAlert")?.textContent ?? "").includes("could not be read"));
    expect((await page.locator("#capTiles .cap-tile b").first().textContent()) ?? "").toBe("4");
  } finally { await close(); }
});
