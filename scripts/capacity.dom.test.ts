import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

// The /capacity/ aggregate view of the TokenMax board. A fake server answers GET /api/maps with a known board, counts
// reads, and can be told to fail, so each shown figure is checked against a sum worked out by hand here.

const SITE = join(import.meta.dir, "..", "site");

type Rec = Record<string, unknown>;
const PASTED = "0.0.0"; // what /tm/ Submit sends for a pasted block (src/browser/tm-submit.ts PASTED_SKILL)
function row(id: string, alias: string, caps: [number, number, number], claude: number, codex: number, codexWeekly: number | null, skill = "0.3.0"): Rec {
  return {
    id, alias, day: "2026-10-21", skill, days: 7, sources: "claude+codex", sessions: 10, subagent_sessions: 1,
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
let stored: number | null = null; // the server's builders total; null means rows.length
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
      return Response.json({ rows, totals: { builders: stored ?? rows.length, cap_episodes: 0, with_weekly_cap: 0 } }, { headers: { "cache-control": "no-store" } });
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
beforeEach(() => { rows = BOARD; stored = null; reads = 0; failing = false; });

async function open(width = 1000, reducedMotion: "reduce" | "no-preference" = "no-preference"): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion });
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
    expect(tiles).toEqual(["4maps counted", "2no cap recorded", "2hit a cap", "4cap episodes"]);
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
    expect(await page.locator("#capAlert").textContent()).toMatch(/The numbers shown are from \d\d:\d\d:\d\d\./);
    expect(await page.locator("#capStamp").textContent()).toMatch(/^Last good read \d\d:\d\d:\d\d\.$/);
    failing = false;
    await page.clock.runFor(10_000);
    await page.waitForFunction(() => (document.getElementById("capAlert")?.textContent ?? "") === "");
  } finally { await close(); }
});

// Pasted blocks (skill 0.0.0) carry caps.short and caps.weekly fixed at 0 and count every hit as unknown (#341), so the page
// must not present a Short or Weekly figure over them as measured.
test("[integration] pasted blocks make Short and Weekly lower bounds and the page says why", async () => {
  rows = [
    row("TM-00000000000G", "pseudo-ggg", [1, 1, 0], 100, 0, null),
    row("TM-00000000000H", "pseudo-hhh", [0, 0, 3], 100, 0, null, PASTED),
    row("TM-00000000000I", "pseudo-iii", [0, 0, 0], 100, 0, null, PASTED),
  ];
  const { page, close } = await open();
  try {
    expect(await cellsOf(page, "capWindows")).toEqual([["Short (session)", "1 or more"], ["Weekly", "1 or more"], ["Unknown window", "3"]]);
    expect(await page.locator("#capPasted").textContent()).toBe("2 pasted TokenMax blocks report 3 limit hits without saying which kind. Those are counted as unknown window, so Short and Weekly are at least the figures shown, not measurements.");
  } finally { await close(); }
});

test("[integration] a board of mapper maps states no lower bound", async () => {
  const { page, close } = await open();
  try {
    expect(await cellsOf(page, "capWindows")).toEqual([["Short (session)", "2"], ["Weekly", "1"], ["Unknown window", "1"]]);
    expect(await page.locator("#capPasted").textContent()).toBe("");
  } finally { await close(); }
});

test("[integration] one sentence reads the counts and says they are unverified self-reports", async () => {
  const { page, close } = await open();
  try {
    expect(await page.locator("#capReading").textContent()).toBe("2 of 4 maps recorded at least one cap episode and 2 recorded none. These are the builders' own reports, not verified, and spare capacity is not measured beyond Codex's weekly percent.");
  } finally { await close(); }
});

test("[integration] an empty board shows no zero tables, only the empty sentence and the not-measured list", async () => {
  rows = [];
  const { page, close } = await open();
  try {
    expect(await page.locator("#capReading").textContent()).toBe("No maps are shared yet, so there is nothing to count.");
    expect(await page.locator("#capFull").isHidden()).toBe(true);
    expect(await page.locator("#capStatus").textContent()).toBe("No maps shared yet.");
    expect(await page.locator("#capGaps li").count()).toBe(4);
  } finally { await close(); }
});

test("[integration] when the server holds more maps than the board returns, the page says it counted the newest", async () => {
  stored = 150;
  const { page, close } = await open();
  try {
    expect(await page.locator("#capNote").textContent()).toBe("Sums cover the newest 4 of 150 shared maps.");
    expect(await page.locator("#capAlert").textContent()).toBe("");
  } finally { await close(); }
});

test("[integration] the polite status speaks when the counts change, not on every 10 second read", async () => {
  const { page, close } = await open();
  try {
    expect(await page.locator("#capStatus").textContent()).toBe("Board loaded: 4 maps counted, 2 hit a cap.");
    await page.evaluate(() => {
      Reflect.set(window, "statusMutations", 0);
      const el = document.getElementById("capStatus");
      if (el) new MutationObserver((list) => { Reflect.set(window, "statusMutations", Number(Reflect.get(window, "statusMutations")) + list.length); }).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const stamp = await page.locator("#capStamp").textContent();
    await page.clock.runFor(10_000);
    await page.waitForFunction((was) => document.getElementById("capStamp")?.textContent !== was, stamp);
    expect(reads).toBe(2);
    expect(await page.evaluate(() => Number(Reflect.get(window, "statusMutations")))).toBe(0);
    rows = [...BOARD, row("TM-00000000000F", "pseudo-fff", [1, 0, 0], 10, 10, 50)];
    await page.clock.runFor(10_000);
    await page.waitForFunction(() => document.getElementById("capStatus")?.textContent === "Board updated: 5 maps counted, 3 hit a cap.");
  } finally { await close(); }
});

// 390 and 320 px, both motion settings: no horizontal overflow, no figure broken across lines (the body's overflow-wrap:anywhere
// split 79,000,000 mid-digit), and each element measured by its OWN box, not isVisible().
const MOTIONS: Array<"no-preference" | "reduce"> = ["no-preference", "reduce"];
for (const reduce of MOTIONS) {
  for (const width of [390, 320]) {
    test(`[integration] ${width}px, motion ${reduce}: no horizontal overflow, whole figures, readable boxes`, async () => {
      rows = [
        row("TM-00000000000J", "pseudo-jjj", [0, 0, 0], 3_200_000, 280_000, 20),
        row("TM-00000000000K", "pseudo-kkk", [2, 1, 3], 79_000_000, 3_900_000, null, PASTED),
      ];
      const { page, close } = await open(width, reduce);
      try {
        const m = await page.evaluate(() => {
          const lines = (el: Element): number => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; };
          const box = (sel: string) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { w: b.width, h: b.height } : null; };
          return {
            scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
            broken: Array.from(document.querySelectorAll("td.cap-num")).filter((td) => lines(td) !== 1).map((td) => td.textContent),
            reading: box("#capReading"), tile: box("#capTiles .cap-tile"), table: box("#capSides"),
          };
        });
        expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
        expect(m.broken).toEqual([]);
        for (const b of [m.reading, m.tile, m.table]) { expect(b).not.toBeNull(); expect(b?.w ?? 0).toBeGreaterThan(1); expect(b?.h ?? 0).toBeGreaterThan(1); }
      } finally { await close(); }
    });
  }
}
