import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

// /tm/ With TokenMax week (operator report 2026-10-23, "a very annoying resizing"): while the show plays nothing on the
// stage changes size or position. Text changes inside fixed boxes; boxes may fade or change colour, never move. Every
// animation frame from the moment the With week starts until it settles, the stage, each poster, each seat grid, the
// session card, the shared pool box and the caption line are measured; any edge moving more than 1 px fails.

const SITE = join(import.meta.dir, "..", "site");
const TOLERANCE = 1;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

async function open(width: number, height: number, hash: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  const origin = `http://127.0.0.1:${server.port}`;
  // same-origin only: nothing leaves the test
  await page.route("**/*", (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  await page.goto(`${origin}/tm/${hash}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#run .poster").length === 7);
  return page;
}

type Shift = { key: string; edge: string; px: number; at: string };
type Report = { frames: number; keys: number; worst: Shift[]; clipped: string[] };

/** Starts measuring every frame; the first frame is the reference every later frame is compared with. */
async function startSampling(page: Page, view: "1x" | "100x"): Promise<void> {
  await page.evaluate((view) => {
    const boxes = (): Map<string, DOMRect> => {
      const m = new Map<string, DOMRect>();
      const add = (key: string, e: Element | null): void => { if (e) m.set(key, e.getBoundingClientRect()); };
      add("stage", document.getElementById("opening"));
      add("controls", document.getElementById("compare"));
      document.querySelectorAll("#poolPanel .pp-m").forEach((t, i) => add(`tile${i}`, t));
      if (view === "1x") {
        add("session", document.getElementById("jevBeat"));
        add("pool", document.getElementById("pool"));
        add("caption", document.getElementById("status"));
        add("decisions", document.getElementById("jevLog"));
        document.querySelectorAll("#run .poster").forEach((p, i) => { add(`poster${i}`, p); add(`seats${i}`, p.querySelector(".seats")); });
      } else {
        add("grid", document.getElementById("mosaic"));
        add("slips", document.getElementById("scaleFocus"));
        add("legend", document.querySelector(".mosaic-key"));
        add("checks", document.querySelector(".branches"));
        document.querySelectorAll("#run .poster").forEach((p, i) => add(`poster${i}`, p));
      }
      return m;
    };
    const ref = boxes();
    const worst = new Map<string, { edge: string; px: number; at: string }>();
    // a fixed box is only honest if its fullest state fits: text cut off by the box counts as a failure too
    const clipped = new Set<string>();
    const fits: [string, string][] = view === "1x" ? [["session", "#jevBeat"], ["question", "#jevQ"], ["pool", "#pool"], ["poolSlips", "#poolSlips"], ["caption", "#status"], ["controls", "#compare"]] : [["slips", "#scaleFocus"], ["legend", ".mosaic-key"], ["checks", ".branches"], ["controls", "#compare"]];
    let frames = 0;
    const tick = (): void => {
      if (Reflect.get(window, "__stop") === true) return;
      frames++;
      const at = `${document.getElementById("jevBeat")?.dataset.phase ?? ""} | ${document.getElementById("status")?.textContent ?? ""}`;
      for (const [key, r] of boxes()) {
        const r0 = ref.get(key);
        if (!r0) { worst.set(key, { edge: "appeared", px: Infinity, at }); continue; }
        const edges: ("x" | "y" | "width" | "height")[] = ["x", "y", "width", "height"];
        for (const edge of edges) {
          const px = Math.abs(r[edge] - r0[edge]);
          if (px > (worst.get(key)?.px ?? 0)) worst.set(key, { edge, px: Math.round(px * 10) / 10, at });
        }
      }
      for (const [key, sel] of fits) { const e = document.querySelector(sel); if (e && e.scrollHeight > e.clientHeight + 1) clipped.add(`${key} (${e.scrollHeight} > ${e.clientHeight}) at ${at}`); }
      Reflect.set(window, "__report", { clipped: [...clipped], frames, keys: ref.size, worst: [...worst].map(([key, w]) => ({ key, ...w })).sort((a, b) => b.px - a.px) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, view);
}
async function stopSampling(page: Page): Promise<Report> {
  return page.evaluate(() => {
    Reflect.set(window, "__stop", true);
    const r: unknown = Reflect.get(window, "__report");
    const empty: Report = { frames: 0, keys: 0, worst: [], clipped: [] };
    if (typeof r !== "object" || r === null) return empty;
    const frames = Reflect.get(r, "frames"), keys = Reflect.get(r, "keys"), worst = Reflect.get(r, "worst"), clipped = Reflect.get(r, "clipped");
    return typeof frames === "number" && typeof keys === "number" && Array.isArray(worst) && Array.isArray(clipped) ? { frames, keys, worst, clipped } : empty;
  });
}

for (const [hash, start, ready, mode] of [["#burn-before", "#dropBtn", "drop", "heavy"], ["#under-before", "#ghostBtn", "ghost", "lite"]] satisfies [string, string, string, string][]) {
  for (const [width, height] of [[390, 844], [1440, 900]] satisfies [number, number][]) {
    test(`[integration] TS-1 ${mode} With week at ${width}x${height}: stage, posters, seat grids, session card, pool box and caption never move or resize while the show plays`, async () => {
      const page = await open(width, height, hash);
      try {
        await page.waitForFunction((r) => { const e = document.getElementById(r); return e?.classList.contains("show-copy") === true || e?.classList.contains("on") === true; }, ready, { timeout: 30000 });
        await page.locator(start).click();
        // the With week has begun once the session card is on stage
        await page.waitForFunction(() => { const r = document.getElementById("jevRow"); return !!r && !r.hidden && r.getBoundingClientRect().height > 0; }, null, { timeout: 30000 });
        await startSampling(page, "1x");
        await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true, null, { timeout: 90000 });
        const report = await stopSampling(page);
        const moved = report.worst.filter((w) => w.px > TOLERANCE);
        console.log(`TS-1 ${mode} ${width}x${height}: ${report.frames} frames, ${report.keys} boxes, largest shift ${JSON.stringify(report.worst[0] ?? null)}`);
        // 24 boxes: stage, controls, 4 tiles, session, pool, caption, decisions and 7 posters with 7 seat grids
        expect({ boxes: report.keys, sampled: report.frames > 100 }).toEqual({ boxes: 24, sampled: true });
        expect(moved).toEqual([]);
        expect(report.clipped).toEqual([]);
      } finally { await page.context().close(); }
    }, 120000);
  }
}

// operator 2026-10-23: "we need to see the whole show in one screen (desktop)". With the explainer at the top of the
// window, the explainer, gauge, posters, session card with its answer, pool, result line, controls and the four tiles
// all fit in one viewport, during the show and at its end.
for (const [width, height] of [[1440, 900], [1280, 800]] satisfies [number, number][]) {
  for (const [hash, start, ready, mode] of [["#burn-before", "#dropBtn", "drop", "heavy"], ["#under-before", "#ghostBtn", "ghost", "lite"]] satisfies [string, string, string, string][]) {
    test(`[integration] TS-2 ${mode} at ${width}x${height}: from the top of the explainer to the bottom of the metric tiles fits one screen, mid-show and at the end`, async () => {
      const page = await open(width, height, hash);
      try {
        await page.waitForFunction((r) => { const e = document.getElementById(r); return e?.classList.contains("show-copy") === true || e?.classList.contains("on") === true; }, ready, { timeout: 30000 });
        await page.locator(start).click();
        const measure = (): Promise<{ span: number; parts: Record<string, boolean> }> => page.evaluate(() => {
          document.getElementById("explain")?.scrollIntoView({ block: "start" });
          const top = document.getElementById("explain")?.getBoundingClientRect().top ?? NaN;
          const tiles = [...document.querySelectorAll("#poolPanel .pp-m")].map((t) => t.getBoundingClientRect());
          const bottom = Math.max(...tiles.map((r) => r.bottom));
          const inView = (sel: string): boolean => { const r = document.querySelector(sel)?.getBoundingClientRect(); return !!r && r.height > 0 && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5; };
          return { span: Math.round(bottom - top), parts: Object.fromEntries(["#explain", "#gauge", "#run", "#jevBeat", "#jevA", "#pool", "#status", "#compare", "#poolPanel .pp-tiles"].map((s) => [s, inView(s)])) };
        });
        await page.waitForFunction(() => document.getElementById("jevBeat")?.dataset.phase === "answer", null, { timeout: 30000 });
        const mid = await measure();
        await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true, null, { timeout: 90000 });
        const end = await measure();
        console.log(`TS-2 ${mode} ${width}x${height}: span mid ${mid.span} px, end ${end.span} px, viewport ${height}`);
        const all = Object.fromEntries(Object.keys(mid.parts).map((k) => [k, true]));
        expect({ mid: mid.span <= height, end: end.span <= height, midParts: mid.parts, endParts: end.parts }).toEqual({ mid: true, end: true, midParts: all, endParts: all });
      } finally { await page.context().close(); }
    }, 120000);
  }
}

// operator 2026-10-23, the 100x view: "get rid of the shake and resizing". From Scale this to the stars to the end of the
// 100x run, the grid, the slip row, the legend, the check counts, the controls, the tiles and the posters stay put.
for (const [width, height] of [[390, 844], [1440, 900]] satisfies [number, number][]) {
  test(`[integration] TS-3 100x view at ${width}x${height}: grid, slips, legend, check counts, controls, tiles and posters never move or resize while it plays`, async () => {
    const page = await open(width, height, "#burn-after");
    try {
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true, null, { timeout: 30000 });
      await page.locator("#scaleUp").click();
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("scaled") === true && document.getElementById("poolPause")?.hidden === false);
      await page.waitForTimeout(100);
      await startSampling(page, "100x");
      await page.waitForFunction(() => document.getElementById("poolPause")?.hidden === true, null, { timeout: 120000 });
      await page.waitForTimeout(300);
      const report = await stopSampling(page);
      console.log(`TS-3 ${width}x${height}: ${report.frames} frames, ${report.keys} boxes, largest shift ${JSON.stringify(report.worst[0] ?? null)}`);
      // 17 boxes: stage, controls, 4 tiles, grid, slips, legend, check counts and 7 posters
      expect({ boxes: report.keys, sampled: report.frames > 100 }).toEqual({ boxes: 17, sampled: true });
      expect(report.worst.filter((w) => w.px > TOLERANCE)).toEqual([]);
      expect(report.clipped).toEqual([]);
    } finally { await page.context().close(); }
  }, 180000);
}

// operator 2026-10-23: "Without TokenMax" wrapped out of its pill. Every control in the left column fits its own box on
// one line and sits inside the column, mid-show (Pause and Skip shown) and at the end.
for (const [width, height] of [[1440, 900], [1280, 800], [390, 844]] satisfies [number, number][]) {
  test(`[integration] TS-4 at ${width}x${height} every control in the left column fits its box and the column, mid-show and at the end`, async () => {
    const page = await open(width, height, "#burn-before");
    try {
      await page.waitForFunction(() => document.getElementById("drop")?.classList.contains("show-copy") === true, null, { timeout: 30000 });
      await page.locator("#dropBtn").click();
      const check = (): Promise<{ controls: number; bad: string[] }> => page.evaluate(() => {
        const col = document.querySelector(".wing")?.getBoundingClientRect();
        const els = [...document.querySelectorAll<HTMLElement>("#compare button, #compare .seg-cap, #compare .seg")].filter((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden");
        const bad = els.flatMap((e) => {
          const r = e.getBoundingClientRect(), name = e.getAttribute("aria-label") ?? e.textContent?.trim() ?? e.className;
          const out: string[] = [];
          if (e.scrollWidth > e.clientWidth + 1) out.push(`${name}: width ${e.scrollWidth} > ${e.clientWidth}`);
          if (e.scrollHeight > e.clientHeight + 1) out.push(`${name}: height ${e.scrollHeight} > ${e.clientHeight}`);
          if (!col || r.left < col.left - 0.5 || r.right > col.right + 0.5 || r.top < col.top - 0.5 || r.bottom > col.bottom + 0.5) out.push(`${name}: outside the column`);
          return out;
        });
        return { controls: els.length, bad };
      });
      await page.waitForFunction(() => document.getElementById("poolPause")?.hidden === false && document.getElementById("jevBeat")?.dataset.phase === "ask", null, { timeout: 30000 });
      const mid = await check();
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true, null, { timeout: 90000 });
      const end = await check();
      expect({ mid: mid.bad, end: end.bad, midSome: mid.controls >= 6, endSome: end.controls >= 4 }).toEqual({ mid: [], end: [], midSome: true, endSome: true });
    } finally { await page.context().close(); }
  }, 120000);
}
