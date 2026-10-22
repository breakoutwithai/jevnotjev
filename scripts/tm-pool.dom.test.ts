import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import snapshot from "../src/browser/tm-maps-20261022.json";
import { IDLE_QUESTION, readSnapshot, simulate, TASK_QUESTION, timeline } from "../src/browser/tm-pool.ts";

// /tm/ Jev task pooling (TASK d28 task-pooling) in a real browser: the With week asks Jev's two questions at the moment
// they are asked, moves the same slip between the session and the shared pool, and the panel and 100x view count from
// the same event stream. Served from site/ by Bun.serve; every off-origin request is blocked.

const SITE = join(import.meta.dir, "..", "site");
const ROWS = readSnapshot(snapshot);
const END1 = (() => { const r = simulate(ROWS, 1); return timeline(r)(r.end); })();
const END100 = (() => { const r = simulate(ROWS, 100); return timeline(r)(r.end); })();
const fmt = (n: number): string => n.toLocaleString("en-US");

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

async function open(width: number, height: number, motion: "no-preference" | "reduce", hash: string, sent?: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion });
  const page = await context.newPage();
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (sent && !/\.(html|css|js|ttf)$|\/tm\/$/.test(new URL(url).pathname)) sent.push(url);
    return url.startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.port}/tm/${hash}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#run .poster").length === 7);
  return page;
}
async function close(page: Page): Promise<void> { await page.context().close(); }

type Snap = { ev: string; phase: string; check: string; answer: string; q: string; slot: string; pool: string[]; docked: string[]; extras: string[] };
/** Records the beat card, the pool and the posters every time Jev's beat changes phase or a slip moves. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const out: Snap[] = [];
    Reflect.set(window, "__beats", out);
    const beat = document.getElementById("jevBeat");
    if (!beat) throw new Error("no beat card");
    const opening = document.getElementById("opening");
    if (!opening) throw new Error("no stage");
    new MutationObserver((list) => {
      out.push({
        ev: list.some((m) => m.type === "attributes") ? "phase" : "move",
        phase: beat.dataset.phase ?? "", check: beat.dataset.check ?? "", answer: beat.dataset.answer ?? "",
        q: document.getElementById("jevQ")?.textContent ?? "", slot: beat.querySelector(".tslip b")?.textContent ?? "",
        pool: [...document.querySelectorAll("#poolSlips .tslip b")].map((b) => b.textContent ?? ""),
        docked: [...document.querySelectorAll("#run .poster .tslip b")].map((b) => b.textContent ?? ""),
        extras: [...document.querySelectorAll("#run .poster.has-extra .ex-job")].map((b) => b.textContent ?? ""),
      });
    }).observe(opening, { attributes: true, attributeFilter: ["data-phase"], childList: true, subtree: true });
  });
}
const beats = (page: Page): Promise<Snap[]> => page.evaluate(() => { const b: unknown = Reflect.get(window, "__beats"); return Array.isArray(b) ? b : []; });

test("[integration] TP-D1 heavy With week: the task question shows when asked; YES settles the slip into the session, NO moves that same slip into the pool", async () => {
  const sent: string[] = [];
  const page = await open(1440, 900, "no-preference", "#burn-before", sent);
  try {
    await page.waitForFunction(() => document.getElementById("drop")?.classList.contains("show-copy") === true);
    await record(page);
    await page.locator("#dropBtn").click();
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true, null, { timeout: 60000 });
    const seen = await beats(page);
    const asks = seen.filter((s) => s.ev === "phase" && s.phase === "ask"), answers = seen.filter((s) => s.ev === "phase" && s.phase === "answer");
    expect(asks.map((s) => [s.check, s.q])).toEqual(Array.from({ length: 4 }, () => ["task", `“${TASK_QUESTION}”`]));
    expect(answers.map((s) => [s.answer, s.slot])).toEqual([["yes", "Rename the env settings"], ["no", "Review last week’s PRs"], ["yes", "Patch the login copy"], ["no", "Write tests for the login page"]]);
    // the slip is in the beat card while Jev answers, never already moved
    for (const a of answers) expect([a.pool.includes(a.slot), a.docked.includes(a.slot)]).toEqual([false, false]);
    // after the answer the same slip has left the card: into the session poster on YES, into the pool on NO
    for (const a of answers) {
      const later = seen.slice(seen.indexOf(a) + 1);
      const moved = later.find((s) => s.slot !== a.slot);
      expect({ slip: a.slot, docked: !!moved?.docked.includes(a.slot), pooled: !!moved?.pool.includes(a.slot) }).toEqual({ slip: a.slot, docked: a.answer === "yes", pooled: a.answer === "no" });
    }
    const log = await page.locator("#jevLog li").allTextContents();
    expect(log.map((l) => /YES, kept local|NO, sent to the pool/.exec(l)?.[0])).toEqual(["YES, kept local", "NO, sent to the pool", "YES, kept local", "NO, sent to the pool"]);
    expect(await page.locator("#jevTag").innerText()).toContain("scripted Jev decisions");
    expect(sent).toEqual([]);
  } finally { await close(page); }
}, 90000);

test("[integration] TP-D2 lite With week: the idle question shows when asked; YES moves the pooled slip in as the +1 JOB slip, NO leaves the session idle and the pool as it was", async () => {
  const page = await open(1440, 900, "no-preference", "#under-before");
  try {
    await page.waitForFunction(() => document.getElementById("ghost")?.classList.contains("on") === true);
    await record(page);
    await page.locator("#ghostBtn").click();
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true, null, { timeout: 60000 });
    const seen = await beats(page);
    const asks = seen.filter((s) => s.ev === "phase" && s.phase === "ask"), answers = seen.filter((s) => s.ev === "phase" && s.phase === "answer");
    expect(asks.map((s) => [s.check, s.q])).toEqual(Array.from({ length: 4 }, () => ["idle", `“${IDLE_QUESTION}”`]));
    expect(answers.map((s) => s.answer)).toEqual(["yes", "no", "yes", "no"]);
    // before YES the pooled task waits in the pool; at the next NO it has become that session's +1 job
    expect(answers[0]?.pool).toEqual(["Review last week’s PRs"]);
    expect(answers[1]?.pool).toEqual([]);
    expect(answers[1]?.extras).toContain("Review last week’s PRs");
    expect(answers[2]?.pool).toEqual(["Write tests for the login page"]);
    expect(answers[3]?.extras).toContain("Write tests for the login page");
    // NO moves nothing: the next snapshot after a NO has the same pool and +1 jobs
    const noIdx = seen.indexOf(answers[1] ?? seen[0] ?? answers[0] ?? { ev: "", phase: "", check: "", answer: "", q: "", slot: "", pool: [], docked: [], extras: [] });
    const next = seen[noIdx + 1];
    if (next) expect([next.pool, next.extras.length]).toEqual([answers[1]?.pool ?? [], answers[1]?.extras.length ?? -1]);
    expect(await page.locator("#jevA").innerText()).toBe("NO · Chill out");
    expect(await page.locator("#run .poster.has-extra").count()).toBe(6);
  } finally { await close(page); }
}, 90000);

test("[integration] TP-D3 Pause holds Jev's beat and the wall clock; Resume carries on", async () => {
  const page = await open(1440, 900, "no-preference", "#burn-before");
  try {
    await page.waitForFunction(() => document.getElementById("drop")?.classList.contains("show-copy") === true);
    await page.locator("#dropBtn").click();
    await page.waitForFunction(() => document.getElementById("jevBeat")?.dataset.phase === "ask", null, { timeout: 30000 });
    await page.locator("#poolPause").click();
    const read = (): Promise<{ phase: string; elapsed: string }> => page.evaluate(() => ({ phase: document.getElementById("jevBeat")?.dataset.phase ?? "", elapsed: document.querySelector("[data-metric=elapsed]")?.textContent ?? "" }));
    const a = await read();
    await page.waitForTimeout(1800);
    const b = await read();
    expect(b).toEqual(a);
    expect(await page.locator("#poolPause").getAttribute("aria-pressed")).toBe("true");
    await page.locator("#poolPause").click();
    await page.waitForFunction(() => document.getElementById("jevBeat")?.dataset.phase !== "ask", null, { timeout: 5000 });
  } finally { await close(page); }
}, 60000);

test("[integration] TP-D4 reduced motion: the same decisions and resulting task locations, nothing travelling; Replay and Skip reset rather than add", async () => {
  for (const [hash, answers, extras] of [["#burn-after", ["YES, kept local", "NO, sent to the pool", "YES, kept local", "NO, sent to the pool"], 0], ["#under-after", ["YES, picked up", "NO, chill out", "YES, picked up", "NO, chill out"], 6]] satisfies [string, string[], number][]) {
    const page = await open(1440, 900, "reduce", hash);
    try {
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
      const state = async (): Promise<{ log: (string | undefined)[]; pool: number; extras: number; running: number; decisions: string; label: string }> => ({
        log: (await page.locator("#jevLog li").allTextContents()).map((l) => /YES, kept local|NO, sent to the pool|YES, picked up|NO, chill out/.exec(l)?.[0]),
        pool: await page.locator("#poolSlips .tslip").count(), extras: await page.locator("#run .poster.has-extra").count(),
        running: await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length),
        decisions: await page.locator("[data-metric=decisions]").innerText(), label: await page.locator("#poolLabel").innerText(),
      });
      const first = await state();
      expect(first).toEqual({ log: answers, pool: 0, extras, running: 0, decisions: `${fmt(END1.decisions)} (task checks ${fmt(END1.taskChecks)} · idle checks ${fmt(END1.idleChecks)})`, label: first.label });
      expect(first.label).toMatch(/^Illustrative tasks and limits/);
      await page.locator("#replay").click();
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
      expect(await state()).toEqual(first);
    } finally { await close(page); }
  }
}, 60000);

test("[integration] TP-D5 Scale this to the stars: 21 maps to 2,100 simulated instances counted from the run; Back to 1x restarts 1x without double counting", async () => {
  const page = await open(1440, 900, "reduce", "#burn-after");
  try {
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
    const m = (k: string): Promise<string> => page.locator(`[data-metric=${k}]`).innerText();
    expect(await page.locator("#scaleUp").innerText()).toBe("Scale this to the stars");
    expect(await m("scale")).toBe("1× · 21 source maps · 21 simulated instances");
    await page.locator("#scaleUp").click();
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("scaled") === true);
    expect(await m("scale")).toBe("100× · 21 source maps · 2,100 simulated instances");
    expect(await m("task")).toBe(`YES ${fmt(END100.taskYes)} · NO ${fmt(END100.taskNo)}`);
    expect(await m("idle")).toBe(`YES ${fmt(END100.idleYes)} · NO ${fmt(END100.idleNo)}`);
    expect(await m("pool")).toBe(`${fmt(END100.poolWaiting)} · ${fmt(END100.pickedUp)} · ${fmt(END100.completed)}`);
    expect(await m("parallel")).toBe(`0 · ${fmt(END100.parallelPeak)} task runs`);
    expect(await m("latency")).toBe("Scripted decisions: no model call, so no latency to measure");
    expect(await page.locator("#act").innerText()).toBe("100× SIMULATION · SCRIPTED JEV DECISIONS · BASED ON 21 PUBLIC MAPS");
    expect(await page.locator("#poolSource").innerText()).toContain("captured 2026-10-22");
    expect(await page.locator("#mosaic").isVisible()).toBe(true);
    // Replay at 100x restarts the same run: the same totals, not doubled
    await page.locator("#replay").click();
    expect(await m("task")).toBe(`YES ${fmt(END100.taskYes)} · NO ${fmt(END100.taskNo)}`);
    await page.locator("#scaleDown").click();
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
    expect(await m("scale")).toBe("1× · 21 source maps · 21 simulated instances");
    expect(await m("task")).toBe(`YES ${fmt(END1.taskYes)} · NO ${fmt(END1.taskNo)}`);
    expect(await page.locator("#scaleUp").isVisible()).toBe(true);
    // the Without view hides everything pooling adds
    await page.locator("#seg button[data-v=without]").click();
    expect(await page.locator("#poolPanel").isVisible()).toBe(false);
    expect(await page.locator("#jevRow").isVisible()).toBe(false);
  } finally { await close(page); }
}, 60000);

for (const [width, height] of [[390, 844], [1440, 900]] satisfies [number, number][]) {
  test(`[integration] TP-D6 at ${width}x${height} the question, the answer, the pool and the seventh day stay on stage with no horizontal scroll, at 1x and 100x`, async () => {
    const page = await open(width, height, "no-preference", "#burn-before");
    try {
      await page.waitForFunction(() => document.getElementById("drop")?.classList.contains("show-copy") === true);
      await page.locator("#dropBtn").click();
      await page.waitForFunction(() => document.getElementById("jevBeat")?.dataset.phase === "answer", null, { timeout: 30000 });
      const fit = (): Promise<{ doc: number; inside: boolean[] }> => page.evaluate(() => {
        const stage = document.getElementById("stage")?.getBoundingClientRect();
        const ids = ["jevQ", "jevA", "pool"];
        const els = [...ids.map((i) => document.getElementById(i)), document.querySelector("#run .poster:last-child")];
        return { doc: document.documentElement.scrollWidth, inside: els.map((e) => { const r = e?.getBoundingClientRect(); return !!r && !!stage && r.width > 0 && r.left >= stage.left - 0.5 && r.right <= stage.right + 0.5; }) };
      });
      expect(await fit()).toEqual({ doc: width, inside: [true, true, true, true] });
      expect(await page.locator("#jevA").evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(24);
      await page.locator("#scaleUp").click();
      await page.waitForTimeout(800);
      const scaled = await page.evaluate(() => {
        const stage = document.getElementById("stage")?.getBoundingClientRect(), m = document.getElementById("mosaic")?.getBoundingClientRect();
        return { doc: document.documentElement.scrollWidth, mosaic: !!m && !!stage && m.width > 100 && m.height > 40 && m.right <= stage.right + 0.5 };
      });
      expect(scaled).toEqual({ doc: width, mosaic: true });
    } finally { await close(page); }
  }, 60000);
}
