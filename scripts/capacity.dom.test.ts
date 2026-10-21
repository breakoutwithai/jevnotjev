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
      ["Map days covered", "14", "14"],
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

// Pasted blocks (skill 0.0.0) carry caps.short and caps.weekly fixed at 0 and count every hit as unknown (#341). The page states
// that once and changes no number.
test("[integration] pasted blocks are stated once as submitting their hits as unknown window, numbers unchanged", async () => {
  rows = [
    row("TM-00000000000G", "pseudo-ggg", [1, 1, 0], 100, 0, null),
    row("TM-00000000000H", "pseudo-hhh", [0, 0, 3], 100, 0, null, PASTED),
    row("TM-00000000000I", "pseudo-iii", [0, 0, 0], 100, 0, null, PASTED),
  ];
  const { page, close } = await open();
  try {
    expect(await cellsOf(page, "capWindows")).toEqual([["Short (session)", "1"], ["Weekly", "1"], ["Unknown window", "3"]]);
    expect(await page.locator("#capPasted").textContent()).toBe("1 pasted TokenMax block was submitted with its limit hits as unknown window and Short and Weekly as 0.");
  } finally { await close(); }
});

test("[integration] a board of mapper maps carries no pasted-block note", async () => {
  const { page, close } = await open();
  try {
    expect(await cellsOf(page, "capWindows")).toEqual([["Short (session)", "2"], ["Weekly", "1"], ["Unknown window", "1"]]);
    expect(await page.locator("#capPasted").textContent()).toBe("");
  } finally { await close(); }
});

test("[integration] one sentence reads the counts and says they are unverified self-reports", async () => {
  const { page, close } = await open();
  try {
    expect(await page.locator("#capReading").textContent()).toBe("2 of 4 maps recorded at least one cap episode and 2 recorded none. Every figure is self-reported and not verified, and spare capacity is not measured beyond Codex's weekly percent.");
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

// 390 and 320 px, both motion settings, a typical board and the largest the contract allows (100 rows, 10^12 tokens each): no
// horizontal overflow, no figure broken across lines (the body's overflow-wrap:anywhere split 79,000,000 mid-digit), and each
// element measured by its OWN box, not isVisible().
const MOTIONS: Array<"no-preference" | "reduce"> = ["no-preference", "reduce"];
const TYPICAL: Rec[] = [
  row("TM-00000000000J", "pseudo-jjj", [0, 0, 0], 3_200_000, 280_000, 20),
  row("TM-00000000000K", "pseudo-kkk", [2, 1, 3], 79_000_000, 3_900_000, null, PASTED),
];
const LARGEST: Rec[] = Array.from({ length: 100 }, (_, i) => row(`TM-${String(i).padStart(12, "0")}`, `pseudo-${i}`, i % 2 === 0 ? [0, 0, 0] : [10_000, 10_000, 10_000], 1_000_000_000_000, 1_000_000_000_000, 99, i % 3 === 0 ? PASTED : "0.3.0"));
const BOARDS: Array<{ name: string; board: Rec[] }> = [{ name: "typical", board: TYPICAL }, { name: "largest", board: LARGEST }];
for (const { name, board } of BOARDS) {
  for (const reduce of MOTIONS) {
    for (const width of [390, 320]) {
      test(`[integration] ${name} board, ${width}px, motion ${reduce}: no horizontal overflow, whole figures, readable boxes`, async () => {
        rows = board;
        const { page, close } = await open(width, reduce);
        try {
          const m = await page.evaluate(() => {
            const lines = (el: Element): number => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; };
            const box = (sel: string) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { w: b.width, h: b.height } : null; };
            const cells = Array.from(document.querySelectorAll("#capWindows td.cap-num, #capSides td.cap-num"));
            return {
              maps: document.querySelectorAll("#capMaps > li").length, ddBroken: Array.from(document.querySelectorAll("#capMaps dd")).filter((dd) => lines(dd) !== 1).length,
              scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
              cells: cells.length, broken: cells.filter((td) => lines(td) !== 1).map((td) => td.textContent),
              reading: box("#capReading"), tile: box("#capTiles .cap-tile"), table: box("#capSides"),
            };
          });
          expect(m.cells).toBe(17); // 3 window rows + 7 measure rows x 2 sides; an empty set would pass "none broken" vacuously
          expect(m.maps).toBe(board.length);
          expect(m.ddBroken).toBe(0);
          expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
          expect(m.broken).toEqual([]);
          for (const b of [m.reading, m.tile, m.table]) { expect(b).not.toBeNull(); expect(b?.w ?? 0).toBeGreaterThan(1); expect(b?.h ?? 0).toBeGreaterThan(1); }
        } finally { await close(); }
      });
    }
  }
}

// A map that did not read a provider carries a placeholder 0 for it; counting that would show a measured 0 where nothing was measured.
test("[integration] a provider no map read is not measured, and a placeholder Codex reading is not averaged", async () => {
  rows = [
    { ...row("TM-00000000000L", "pseudo-lll", [0, 0, 0], 5000, 0, 77), sources: "claude" },
    { ...row("TM-00000000000M", "pseudo-mmm", [1, 0, 0], 7000, 0, 88), sources: "claude" },
  ];
  const { page, close } = await open();
  try {
    expect(await cellsOf(page, "capSides")).toEqual([
      ["Maps", "1", "1"],
      ["Map days covered", "7", "7"],
      ["Claude output tokens used", "5,000", "7,000"],
      ["Codex output tokens used", "not measured", "not measured"],
      ["Maps with a Codex weekly reading", "0", "0"],
      ["Mean Codex weekly used", "not measured", "not measured"],
      ["Mean Codex weekly headroom", "not measured", "not measured"],
    ]);
  } finally { await close(); }
});

// Maps cover 1 to 90 days: the token sums are totals, so the days each side covers is shown beside them.
test("[integration] map days are summed per side and a single map reads in the singular", async () => {
  rows = [{ ...row("TM-00000000000N", "pseudo-nnn", [0, 0, 0], 100, 0, null), days: 1 }, { ...row("TM-00000000000O", "pseudo-ooo", [1, 0, 0], 900, 0, null), days: 90 }];
  const { page, close } = await open();
  try {
    const sides = await cellsOf(page, "capSides");
    expect(sides[1]).toEqual(["Map days covered", "1", "90"]);
    expect(await page.locator("#capBody").innerText()).toContain("the map days row is their sum");
  } finally { await close(); }
  rows = [row("TM-00000000000P", "pseudo-ppp", [0, 0, 0], 1, 0, null)];
  const one = await open();
  try {
    expect(await one.page.locator("#capTiles .cap-tile").evaluateAll((els) => els.map((e) => e.textContent ?? ""))).toEqual(["1map counted", "1no cap recorded", "0hit a cap", "0cap episodes"]);
  } finally { await one.close(); }
});

const mapsOf = async (page: Page): Promise<Array<{ name: string; flags: string[]; figures: Array<[string, string]> }>> =>
  page.locator("#capMaps > li").evaluateAll((lis) => lis.map((li) => ({
    name: li.querySelector(".cap-map-head")?.firstChild?.textContent ?? "",
    flags: Array.from(li.querySelectorAll(".cap-flag")).map((f) => f.textContent ?? ""),
    figures: Array.from(li.querySelectorAll("dl > div")).map((d): [string, string] => [d.querySelector("dt")?.textContent ?? "", d.querySelector("dd")?.textContent ?? ""]),
  })));

// Every map as submitted: raw values, newest first, numbered, no alias, id or day. Nothing is ratioed, discounted or rounded.
test("[integration] every map is listed with its submitted values, anonymously", async () => {
  const { page, close } = await open();
  try {
    const list = await mapsOf(page);
    expect(list.map((m) => m.name)).toEqual(["Map 1", "Map 2", "Map 3", "Map 4"]);
    expect(list[2]).toEqual({
      name: "Map 3",
      flags: ["self-reported by tokenmax-map 0.3.0, not verified"],
      figures: [
        ["Sessions", "10"], ["Days", "7"], ["Cap episodes, short", "2"], ["Cap episodes, weekly", "1"], ["Cap episodes, unknown window", "0"],
        ["Claude output tokens", "30,000"], ["Codex output tokens", "3,000"], ["Opus share", "50%"], ["Codex weekly used", "90%"],
      ],
    });
    expect(list[3]?.figures.at(-1)).toEqual(["Codex weekly used", "not in the logs"]); // D read Codex but recorded no percent
    const text = await page.locator("#capMaps").innerText();
    for (const r of BOARD) { expect(text).not.toContain(String(r.alias)); expect(text).not.toContain(String(r.id)); }
    expect(text).not.toContain("2026-10-21"); // the day
    expect(await page.locator("#capBody").innerHTML()).not.toContain("pseudo-");
  } finally { await close(); }
});

test("[integration] a pasted block is labelled as the board labels it, and no figure is ratioed or discounted", async () => {
  rows = [{ ...row("TM-00000000000S", "pseudo-sss", [0, 0, 85], 1, 0, null, PASTED), sessions: 12 }];
  const { page, close } = await open();
  try {
    const [m] = await mapsOf(page);
    expect(m?.flags).toEqual(["self-reported from a pasted TokenMax block, not verified"]);
    expect(m?.figures.slice(0, 5)).toEqual([["Sessions", "12"], ["Days", "7"], ["Cap episodes, short", "0"], ["Cap episodes, weekly", "0"], ["Cap episodes, unknown window", "85"]]);
    expect(await page.locator("#capBody").innerText()).not.toMatch(/per 100|retries|comparable/);
  } finally { await close(); }
});

// A quiet week is the row's own sessions divided by its days under 1: a plain statement, no interpretation.
test("[integration] a quiet week is flagged when sessions per day is under 1, and the sessions and days are shown", async () => {
  rows = [
    { ...row("TM-00000000000Q", "pseudo-qqq", [0, 0, 0], 1, 0, null), sessions: 7, days: 7 },  // exactly 1 a day: not quiet
    { ...row("TM-00000000000R", "pseudo-rrr", [0, 0, 0], 1, 0, null), sessions: 6, days: 7 },  // quiet
    { ...row("TM-00000000000T", "pseudo-ttt", [0, 0, 0], 1, 0, null), sessions: 0, days: 7 },  // quiet, 0 sessions
    { ...row("TM-00000000000U", "pseudo-uuu", [1, 1, 0], 1, 0, null, PASTED), sessions: 3, days: 90 }, // quiet and pasted
  ];
  const { page, close } = await open();
  try {
    const list = await mapsOf(page);
    expect(list.map((m) => m.flags.includes("Quiet week: under 1 session a day"))).toEqual([false, true, true, true]);
    expect(list.map((m) => [m.figures[0]?.[1], m.figures[1]?.[1]])).toEqual([["7", "7"], ["6", "7"], ["0", "7"], ["3", "90"]]);
  } finally { await close(); }
});

// A map that did not read a provider is labelled as the /maps/ board labels it, not shown as a measured 0.
test("[integration] a provider a map did not read is shown as not collected", async () => {
  rows = [{ ...row("TM-00000000000V", "pseudo-vvv", [0, 0, 0], 5000, 0, 77), sources: "claude" }, { ...row("TM-00000000000W", "pseudo-www", [0, 0, 0], 0, 800, 33), sources: "codex" }];
  const { page, close } = await open();
  try {
    const [claudeOnly, codexOnly] = await mapsOf(page);
    expect(claudeOnly?.figures.slice(5)).toEqual([["Claude output tokens", "5,000"], ["Codex output tokens", "not collected"], ["Opus share", "50%"], ["Codex weekly used", "not collected"]]);
    expect(codexOnly?.figures.slice(5)).toEqual([["Claude output tokens", "not collected"], ["Codex output tokens", "800"], ["Opus share", "not collected"], ["Codex weekly used", "33%"]]);
  } finally { await close(); }
});

// Exact totals, not rounded to fit: stacked on a narrow screen so a 19-digit sum is whole and nothing overflows.
test("[integration] the largest totals are shown exactly", async () => {
  rows = Array.from({ length: 100 }, (_, i) => row(`TM-${String(i).padStart(12, "0")}`, `pseudo-${i}`, [0, 0, 0], 1_000_000_000_000, 1_000_000_000_000, 99));
  const { page, close } = await open(320);
  try {
    const sides = await cellsOf(page, "capSides");
    expect(sides[2]).toEqual(["Claude output tokens used", "100,000,000,000,000", "not measured"]);
    expect(sides[3]).toEqual(["Codex output tokens used", "100,000,000,000,000", "not measured"]);
  } finally { await close(); }
});

test("[integration] Codex weekly means keep one decimal", async () => {
  rows = [row("TM-00000000000X", "pseudo-xxx", [0, 0, 0], 1, 1, 20), row("TM-00000000000Y", "pseudo-yyy", [0, 0, 0], 1, 1, 21), row("TM-00000000000Z", "pseudo-zzz", [0, 0, 0], 1, 1, 21)];
  const { page, close } = await open();
  try {
    const sides = await cellsOf(page, "capSides");
    expect(sides.at(-2)).toEqual(["Mean Codex weekly used", "20.7%", "not measured"]);
    expect(sides.at(-1)).toEqual(["Mean Codex weekly headroom", "79.3%", "not measured"]);
  } finally { await close(); }
});

test("[integration] a provider read with no percent recorded is not in the logs, as on the board", async () => {
  rows = [{ ...row("TM-00000000000a", "pseudo-aaa2", [0, 0, 0], 5000, 0, null), opus_share_pct: null }];
  const { page, close } = await open();
  try {
    const [m] = await mapsOf(page);
    expect(m?.figures.slice(7)).toEqual([["Opus share", "not in the logs"], ["Codex weekly used", "not in the logs"]]);
  } finally { await close(); }
});
