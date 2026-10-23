import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import snapshot from "../src/browser/tm-maps-20261022.json";
import { focusPair, IDLE_QUESTION, readSnapshot, simulate, TASK_QUESTION, timeline } from "../src/browser/tm-pool.ts";

// /tm/ Jev task pooling (TASK d28 task-pooling) in a real browser: the With week asks Jev's two questions at the moment
// they are asked, moves the same slip between the session and the shared pool, and the panel and 100x view count from
// the same event stream. Served from site/ by Bun.serve; every off-origin request is blocked.

const SITE = join(import.meta.dir, "..", "site");
const ROWS = readSnapshot(snapshot);
const END1 = (() => { const r = simulate(ROWS, 1); return timeline(r)(r.end); })();
const END100 = (() => { const r = simulate(ROWS, 100); return timeline(r)(r.end); })();
const fmt = (n: number): string => n.toLocaleString("en-US");
const FOCUS = focusPair(ROWS);
const aliasOf = (instance: string): string => ROWS.find((r) => instance.startsWith(`${r.id}-r`))?.alias ?? "";
const HEAVY_ALIAS = aliasOf(FOCUS.heavy), LITE_ALIAS = aliasOf(FOCUS.lite);

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

/** The only requests the page may make: GET of its own same-origin assets, by exact path. */
const ALLOWED = new Set(["/tm/", "/page.css", "/tm/tm.css", "/tm/tm.js", "/skill-panel.css", "/skill-panel.js", "/tm/fonts/Alegreya.ttf", "/tm/fonts/Alegreya-Italic.ttf", "/tm/fonts/Archivo.ttf"]);
/** One count from the panel, by its data-metric name, read as text (some sit behind a closed details toggle). The
 * composite names are the counts the panel used to print on one line, built from the separate tiles. */
async function metric(page: Page, k: string): Promise<string> {
  const one = (key: string): Promise<string> => page.locator(`[data-metric=${key}]`).evaluate((e) => e.textContent ?? "");
  switch (k) {
    case "scale": return `${await one("scale")} · ${await one("instances")}`;
    case "decisions": return `${await one("decisions")} (task checks ${await one("taskChecks")} · idle checks ${await one("idleChecks")})`;
    case "task": return `YES ${await one("taskYes")} · NO ${await one("taskNo")}`;
    case "idle": return `YES ${await one("idleYes")} · NO ${await one("idleNo")}`;
    case "pool": return `${await one("poolWaiting")} · ${await one("pickedUp")} · ${await one("completed")}`;
    case "parallel": return `${await one("parallelNow")} · ${await one("parallelPeak")} task runs`;
    default: return one(k);
  }
}
/** Jev's log as "YES, kept local" style rows: the chip, then what it did. */
const logOf = (page: Page): Promise<string[]> => page.locator("#jevLog li").evaluateAll((ls) => ls.map((l) => `${l.querySelector(".chip")?.textContent ?? ""}, ${l.querySelector(".lg-act")?.textContent ?? ""}`));
/** Every request outside the allowlist, recorded before it is blocked; close() fails the test when any was attempted. */
const blocked = new WeakMap<Page, string[]>();

async function open(width: number, height: number, motion: "no-preference" | "reduce", hash: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion });
  const page = await context.newPage();
  const sent: string[] = [];
  blocked.set(page, sent);
  const origin = `http://127.0.0.1:${server.port}`;
  await page.route("**/*", (route) => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === "GET" && url.origin === origin && url.search === "" && ALLOWED.has(url.pathname)) return route.continue();
    sent.push(`${req.method()} ${req.url()}`);
    return route.abort();
  });
  await page.goto(`${origin}/tm/${hash}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#run .poster").length === 7);
  return page;
}
async function close(page: Page): Promise<void> {
  const sent = blocked.get(page) ?? [];
  await page.context().close();
  expect(sent).toEqual([]);
}

type Snap = { ev: string; phase: string; check: string; answer: string; q: string; slot: string; status: string; pool: string[]; docked: string[]; extras: string[]; count: string; takenBy: string[]; others: number; live: number };
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
        q: document.getElementById("jevQ")?.textContent ?? "", slot: beat.querySelector(".tslip b")?.textContent ?? "", status: document.getElementById("status")?.textContent ?? "",
        pool: [...document.querySelectorAll("#poolSlips .tslip b")].map((b) => b.textContent ?? ""),
        docked: [...document.querySelectorAll("#run .poster .tslip b")].map((b) => b.textContent ?? ""),
        extras: [...document.querySelectorAll("#run .poster.has-extra .ex-job")].map((b) => b.textContent ?? ""),
        count: document.getElementById("poolCount")?.textContent ?? "",
        takenBy: [...document.querySelectorAll("#poolSlips .tslip .taken-by")].map((b) => `${b.parentElement?.querySelector("b")?.textContent ?? ""}|${b.textContent ?? ""}`), others: document.querySelectorAll("#poolOthers .oslip").length,
        live: document.querySelectorAll("#poolSlips .tslip:not(.taken)").length,
      });
    }).observe(opening, { attributes: true, attributeFilter: ["data-phase"], childList: true, subtree: true });
  });
}
const beats = (page: Page): Promise<Snap[]> => page.evaluate(() => { const b: unknown = Reflect.get(window, "__beats"); return Array.isArray(b) ? b : []; });

test("[integration] TP-D1 heavy With week: the task question shows when asked; YES settles the slip into the session, NO moves that same slip into the pool", async () => {
  const page = await open(1440, 900, "no-preference", "#burn-before");
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
    expect(await logOf(page)).toEqual(["YES, kept local", "NO, to pool", "YES, kept local", "NO, to pool"]);
    // the only scripted disclosure is the explainer above the show
    expect(await page.locator("#explain").innerText()).toContain("This show is scripted");
    expect(await page.locator("#jevTag").count()).toBe(0);
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
    // NO moves nothing: across the whole NO interval (the answer, its status and its hold) every task stays where it was
    for (const no of [answers[1], answers[3]]) {
      if (!no) throw new Error("missing NO answer");
      const later = seen.slice(seen.indexOf(no) + 1);
      const end = later.findIndex((x) => x.status !== no.status && !x.status.includes("no pooled task fits"));
      const during = end < 0 ? later : later.slice(0, end);
      expect(during.some((x) => x.status.includes("no pooled task fits"))).toBe(true);
      for (const x of during) expect({ pool: x.pool, docked: x.docked, extras: x.extras }).toEqual({ pool: no.pool, docked: no.docked, extras: no.extras });
    }
    expect([await page.locator("#jevA .jb-word").innerText(), await page.locator("#jevA .jb-act").textContent()]).toEqual(["NO", "Nothing fits: wait"]);
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

test("[integration] TP-D3b Pause holds the ordinary day playback too: gauge, seats, days played and travelling slips stand still", async () => {
  const page = await open(1440, 900, "no-preference", "#burn-before");
  try {
    await page.waitForFunction(() => document.getElementById("drop")?.classList.contains("show-copy") === true);
    await page.locator("#dropBtn").click();
    // Monday plays without a Jev beat: pause in the middle of its seat-filling tween
    await page.waitForFunction(() => document.querySelectorAll("#run .poster.playing .f").length > 0 && document.getElementById("jevBeat")?.dataset.phase === "rest", null, { timeout: 30000 });
    await page.locator("#poolPause").click();
    const read = (): Promise<{ gauge: string; seats: number; played: number; status: string; running: number }> => page.evaluate(() => ({
      gauge: document.getElementById("leftPct")?.textContent ?? "", seats: document.querySelectorAll("#run .f").length, played: document.querySelectorAll("#run .poster.played").length,
      status: document.getElementById("status")?.textContent ?? "",
      running: (document.getElementById("stage")?.getAnimations({ subtree: true }) ?? []).filter((x) => x.playState === "running").length,
    }));
    const a = await read();
    await page.waitForTimeout(1500);
    expect(await read()).toEqual(a);
    expect(a.running).toBe(0);
    await page.locator("#poolPause").click();
    await page.waitForFunction((g) => document.getElementById("leftPct")?.textContent !== g, a.gauge, { timeout: 5000 });
    // a slip travelling to the pool stops mid-flight too
    await page.waitForFunction(() => (document.getElementById("stage")?.getAnimations({ subtree: true }) ?? []).some((x) => x.playState === "running" && x.effect instanceof KeyframeEffect && x.effect.target instanceof HTMLElement && x.effect.target.classList.contains("tslip")), null, { timeout: 30000 });
    await page.locator("#poolPause").click();
    await page.waitForTimeout(150); // a pause takes effect on the next frame
    const t1 = await page.evaluate(() => (document.querySelector(".tslip")?.getAnimations() ?? []).map((x) => String(x.currentTime)));
    await page.waitForTimeout(800);
    const t2 = await page.evaluate(() => (document.querySelector(".tslip")?.getAnimations() ?? []).map((x) => String(x.currentTime)));
    expect(t2).toEqual(t1);
  } finally { await close(page); }
}, 90000);

test("[integration] TP-D4 reduced motion: the same decisions and resulting task locations, nothing travelling; Replay resets rather than adds", async () => {
  for (const [hash, answers, extras] of [["#burn-after", ["YES, kept local", "NO, to pool", "YES, kept local", "NO, to pool"], 0], ["#under-after", ["YES, picked up", "NO, nothing fits", "YES, picked up", "NO, nothing fits"], 6]] satisfies [string, string[], number][]) {
    const page = await open(1440, 900, "reduce", hash);
    try {
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
      const state = async (): Promise<{ log: string[]; pool: number; extras: number; running: number; decisions: string; label: string }> => ({
        log: await logOf(page),
        pool: await page.locator("#poolSlips .tslip").count(), extras: await page.locator("#run .poster.has-extra").count(),
        running: await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length),
        decisions: await metric(page, "decisions"), label: await page.locator("#act").innerText(),
      });
      const first = await state();
      expect(first).toEqual({ log: answers, pool: 0, extras, running: 0, decisions: `${fmt(END1.decisions)} (task checks ${fmt(END1.taskChecks)} · idle checks ${fmt(END1.idleChecks)})`, label: first.label });
      expect(first.label).toBe("1 week, with Jev");
      await page.locator("#replay").click();
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
      expect(await state()).toEqual(first);
    } finally { await close(page); }
  }
}, 60000);

for (const [hash, start, ready, answers, extras] of [
  ["#burn-before", "#dropBtn", "drop", ["YES, kept local", "NO, to pool", "YES, kept local", "NO, to pool"], 0],
  ["#under-before", "#ghostBtn", "ghost", ["YES, picked up", "NO, nothing fits", "YES, picked up", "NO, nothing fits"], 6],
] satisfies [string, string, string, string[], number][]) {
  test(`[integration] TP-D4b Skip during playback, and Skip while paused, end on the same decisions and task locations; elapsed counts playback only (${hash})`, async () => {
    const page = await open(1440, 900, "no-preference", hash);
    try {
      await page.waitForFunction((r) => { const e = document.getElementById(r); return e?.classList.contains("show-copy") === true || e?.classList.contains("on") === true; }, ready, { timeout: 30000 });
      await page.locator(start).click();
      const end = async (): Promise<{ log: string[]; pool: number; slips: number; extras: number; decisions: string; pause: boolean }> => ({
        log: await logOf(page),
        pool: await page.locator("#poolSlips .tslip").count(), slips: await page.locator("#run .tslip, #jevBeat .tslip").count(),
        extras: await page.locator("#run .poster.has-extra").count(), decisions: await metric(page, "decisions"),
        pause: await page.locator("#poolPause").isVisible(),
      });
      const want = { log: answers, pool: 0, slips: 0, extras, decisions: `${fmt(END1.decisions)} (task checks ${fmt(END1.taskChecks)} · idle checks ${fmt(END1.idleChecks)})`, pause: false };
      const secs = async (): Promise<number> => parseFloat(await metric(page, "elapsed"));
      // 1: Skip during active playback
      await page.waitForFunction(() => document.getElementById("jevBeat")?.dataset.phase === "ask", null, { timeout: 30000 });
      await page.locator("#skip").click();
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
      expect(await end()).toEqual(want);
      expect(await secs()).toBeGreaterThan(0.3);
      // 2: Replay, Pause, wait, then Skip: the same end, and the paused stretch is not counted
      await page.locator("#replay").click();
      await page.waitForFunction(() => document.getElementById("jevBeat")?.dataset.phase === "ask", null, { timeout: 30000 });
      await page.locator("#poolPause").click();
      const before = await secs();
      await page.waitForTimeout(2500);
      await page.locator("#skip").click();
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
      expect(await end()).toEqual(want);
      const after = await secs();
      expect(after).toBeGreaterThan(0.3);
      expect(after - before).toBeLessThan(0.5);
    } finally { await close(page); }
  }, 90000);
}

test("[integration] TP-D5 Scale this to the stars: 21 maps to 2,100 simulated instances counted from the run; Back to 1x restarts 1x without double counting", async () => {
  const page = await open(1440, 900, "reduce", "#burn-after");
  try {
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
    const m = (k: string): Promise<string> => metric(page, k);
    expect(await page.locator("#scaleUp").innerText()).toBe("Scale this to the stars");
    expect(await m("scale")).toBe("1× · 21 source maps · 21 simulated instances");
    await page.locator("#scaleUp").click();
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("scaled") === true);
    expect(await m("scale")).toBe("100× · 21 source maps · 2,100 simulated instances");
    expect(await m("task")).toBe(`YES ${fmt(END100.taskYes)} · NO ${fmt(END100.taskNo)}`);
    expect(await m("idle")).toBe(`YES ${fmt(END100.idleYes)} · NO ${fmt(END100.idleNo)}`);
    expect(await m("pool")).toBe(`${fmt(END100.poolWaiting)} · ${fmt(END100.pickedUp)} · ${fmt(END100.completed)}`);
    expect(await m("parallel")).toBe(`0 · ${fmt(END100.parallelPeak)} task runs`);
    expect(await m("latency")).toBe("Scripted run, no model calls");
    expect(await page.locator("#act").innerText()).toBe("100x sessions");
    expect(await page.locator("#exampleTag").isVisible()).toBe(false);
    expect(await page.locator(".mosaic-key").innerText()).toMatch(/^Own task\s+Picked up\s+Waiting$/);
    expect(await page.locator(".branches .chip").allTextContents()).toEqual([`YES ${fmt(END100.taskYes)}`, `NO ${fmt(END100.taskNo)}`, `YES ${fmt(END100.idleYes)}`, `NO ${fmt(END100.idleNo)}`]);
    expect(await page.locator("#poolSource").textContent()).toContain("captured 2026-10-22");
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

test("[integration] TP-D5b Skip while paused at 100x keeps the playback already timed: the pause is subtracted once, not twice", async () => {
  const page = await open(1440, 900, "no-preference", "#burn-after");
  try {
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
    await page.locator("#scaleUp").click();
    await page.waitForTimeout(1500);
    await page.locator("#poolPause").click();
    const before = parseFloat(await metric(page, "elapsed"));
    await page.waitForTimeout(2500);
    await page.locator("#skip").click();
    const after = parseFloat(await metric(page, "elapsed"));
    expect(before).toBeGreaterThan(1);
    expect(Math.abs(after - before)).toBeLessThan(0.3);
  } finally { await close(page); }
}, 60000);

test("[integration] TP-D5c Scale this to the stars while a kept slip is docked on its poster clears every 1x slip from the stage", async () => {
  const page = await open(1440, 900, "no-preference", "#burn-before");
  try {
    await page.waitForFunction(() => document.getElementById("drop")?.classList.contains("show-copy") === true);
    await page.locator("#dropBtn").click();
    await page.waitForFunction(() => document.querySelector("#run .poster .tslip") !== null, null, { timeout: 30000 });
    await page.locator("#scaleUp").click();
    const left = (): Promise<number> => page.locator("#run .tslip, #poolSlips .tslip, #jevBeat .tslip").count();
    expect(await left()).toBe(0);
    await page.waitForTimeout(1500);
    expect(await left()).toBe(0);
  } finally { await close(page); }
}, 60000);

test("[integration] TP-D5d the pool says what its slips are: the sessions on stage, apart from the count across all 21 maps", async () => {
  const page = await open(1440, 900, "reduce", "#burn-after");
  try {
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
    expect(await page.locator("#poolHead").innerText()).toMatch(/^SHARED POOL/);
    // the box never reads empty beside a count above 0: the other maps' waiting tasks show as blank slips
    expect(await page.locator("#poolSlips .tslip").count()).toBe(0);
    expect(await page.locator("#poolOthers .oslip").count()).toBe(Math.min(12, END1.poolWaiting));
    expect(await page.locator("#poolCount").textContent()).toBe(`${fmt(END1.poolWaiting)} waiting across all 21 maps`);
  } finally { await close(page); }
}, 60000);

test("[integration] TP-D7 the ribbon and the mosaic follow their CSS size: every mosaic row fits, and a resize redraws both at the new width", async () => {
  const page = await open(1440, 900, "reduce", "#burn-after");
  try {
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
    // a 300 px mosaic at DPR 1 matches the canvas default width: its height must still be set for 2,100 squares
    await page.addStyleTag({ content: "#mosaic { width: 300px !important; }" });
    await page.locator("#poolRun > summary").click();
    await page.locator("#scaleUp").click();
    const fits = (): Promise<{ ribbon: boolean; ribbonCursor: boolean; mosaicW: boolean; mosaicRows: boolean }> => page.evaluate(() => {
      const dpr = window.devicePixelRatio || 1;
      const rb = document.getElementById("ribbon"), mo = document.getElementById("mosaic");
      if (!(rb instanceof HTMLCanvasElement) || !(mo instanceof HTMLCanvasElement)) throw new Error("no canvases");
      // the chart is two rows of days (Mon to Thu, Fri to Sun): at the end the cursor stands at the end of Sunday
      const dw = Math.floor(Math.floor(rb.clientWidth) / 4);
      const px = rb.getContext("2d")?.getImageData(Math.round((3 * dw - 1) * dpr), rb.height - 1, 1, 1).data ?? [];
      const w = Math.floor(mo.clientWidth), cols = Math.max(10, Math.floor(w / (w < 500 ? 7 : 9))), rows = Math.ceil(2100 / cols);
      return {
        ribbon: rb.width === Math.round(Math.floor(rb.clientWidth) * dpr), ribbonCursor: px[0] === 246 && px[1] === 220 && px[2] === 142,
        mosaicW: mo.width === Math.round(w * dpr), mosaicRows: mo.height >= Math.floor(rows * (w / cols) * dpr),
      };
    });
    const ok = { ribbon: true, ribbonCursor: true, mosaicW: true, mosaicRows: true };
    expect(await fits()).toEqual(ok);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    expect(await fits()).toEqual(ok);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(400);
    expect(await fits()).toEqual(ok);
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
      expect(await page.locator("#jevA .jb-word").evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(24);
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

/** Waiting tasks across all 21 maps, read from "All 21 maps: N tasks waiting". */
const waitingOf = (count: string): number => Number(/^([\d,]+) waiting/.exec(count)?.[1]?.replace(/,/g, "") ?? NaN);

// ux-swarm 2026-10-23 c02: 4 of 5 could not see what a NO did. The slip lands in the pool box and stays readable; a
// pickup labels it with the session that took it before it leaves; the box never reads empty beside a waiting count.
for (const [hash, start, ready, mode] of [["#burn-before", "#dropBtn", "drop", "heavy"], ["#under-before", "#ghostBtn", "ghost", "lite"]] satisfies [string, string, string, string][]) {
  test(`[integration] TP-D8 ${mode} With week: a NO lands its slip in the pool box, a pickup names the session and takes it out, and the box always matches its count`, async () => {
    const page = await open(1440, 900, "no-preference", hash);
    try {
      await page.waitForFunction((r) => { const e = document.getElementById(r); return e?.classList.contains("show-copy") === true || e?.classList.contains("on") === true; }, ready, { timeout: 30000 });
      await record(page);
      await page.locator(start).click();
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true, null, { timeout: 60000 });
      const seen = await beats(page);
      expect(seen.length).toBeGreaterThan(20);
      // the box and the count agree in every recorded frame: live slips plus blank slips = tasks waiting
      for (const s of seen) {
        const n = waitingOf(s.count), live = s.live;
        // named slips for the two sessions on stage, blank ones (at most 12) for the rest
        expect({ count: s.count, others: s.others }).toEqual({ count: s.count, others: Math.min(12, Math.max(0, n - live)) });
        expect(live).toBeLessThanOrEqual(n);
      }
      // both views follow the same two pooled tasks: sent by the heavy session, picked up by the lite one
      const pooled = ["Review last week’s PRs", "Write tests for the login page"];
      for (const title of pooled) {
        const landed = seen.findIndex((s) => s.pool.includes(title) && s.takenBy.length === 0);
        expect({ title, landed: landed >= 0 }).toEqual({ title, landed: true });
        const after = seen.slice(landed);
        // this slip leaves the box only after it carries its own "Picked up by" label naming the lite session
        const gone = after.findIndex((s) => !s.pool.includes(title));
        const label = `${title}|Picked up by ${LITE_ALIAS}`;
        const named = after.findIndex((s) => s.pool.includes(title) && s.takenBy.includes(label));
        expect({ title, leaves: gone > 0, namedBeforeLeaving: named >= 0 && named < gone }).toEqual({ title, leaves: true, namedBeforeLeaving: true });
      }
      // the lite view names the heavy session that sent the slip
      if (mode === "lite") expect(seen.some((s) => s.status.includes(`${HEAVY_ALIAS}’s heavy session answers NO and sends`))).toBe(true);
    } finally { await close(page); }
  }, 90000);
}

// ux-swarm 2026-10-23 c10: on the Lite Without end at 390 px "Lights on. Nobody home." was drawn over "53% HOUSE LIGHTS".
for (const [width, height] of [[390, 844], [1440, 900]] satisfies [number, number][]) {
  test(`[integration] TP-D9 at ${width}x${height} the Lite Without end copy does not overlap the gauge reading`, async () => {
    const page = await open(width, height, "reduce", "#under-before");
    try {
      await page.waitForFunction(() => document.getElementById("ghost")?.classList.contains("on") === true, null, { timeout: 30000 });
      const boxes = await page.evaluate(() => {
        // a box only for an element that is drawn: missing, display:none or visibility:hidden all fail the test below
        const box = (e: Element | null): [number, number, number, number] | null => { const r = e?.getBoundingClientRect(); return e && r && r.width > 0 && e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) ? [r.left, r.top, r.right, r.bottom] : null; };
        return { copy: box(document.querySelector(".ghost-copy")), read: box(document.getElementById("leftPct")), name: box(document.getElementById("gaugeName")), doc: document.documentElement.scrollWidth };
      });
      const hit = (a: readonly number[] | null, b: readonly number[] | null): boolean => !!a && !!b && (a[0] ?? 0) < (b[2] ?? 0) && (b[0] ?? 0) < (a[2] ?? 0) && (a[1] ?? 0) < (b[3] ?? 0) && (b[1] ?? 0) < (a[3] ?? 0);
      expect({ copy: !!boxes.copy, read: !!boxes.read, name: !!boxes.name, overRead: hit(boxes.copy, boxes.read), overName: hit(boxes.copy, boxes.name), doc: boxes.doc }).toEqual({ copy: true, read: true, name: true, overRead: false, overName: false, doc: width });
      expect(await page.locator("#ghostBtn").isVisible()).toBe(true);
    } finally { await close(page); }
  }, 60000);
}

/** "rgb(r, g, b)" from getComputedStyle as [r, g, b]. */
const rgb = (c: string): number[] => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);

// operator 2026-10-23 and ux-swarm c01: the answer is the hero. NO is a big bright red word, YES a bright green one, and
// the action under it glows neon green; the pool box carries the same green.
test("[integration] TP-D10 the answer reads as a colour: NO bright red, YES bright green, the action and the pool box glow green", async () => {
  const page = await open(1440, 900, "no-preference", "#burn-before");
  try {
    await page.waitForFunction(() => document.getElementById("drop")?.classList.contains("show-copy") === true);
    await page.locator("#dropBtn").click();
    const look = async (answer: string): Promise<{ word: string; size: number; red: boolean; green: boolean; wordGlow: boolean; act: string; actGreen: boolean; actGlow: boolean }> => {
      await page.waitForFunction((a) => document.getElementById("jevBeat")?.dataset.answer === a, answer, { timeout: 30000 });
      const s = await page.evaluate(() => {
        const w = document.querySelector("#jevA .jb-word"), a = document.querySelector("#jevA .jb-act");
        if (!w || !a) throw new Error("no answer parts");
        const ws = getComputedStyle(w), as = getComputedStyle(a);
        return { word: w.textContent ?? "", size: parseFloat(ws.fontSize), color: ws.color, shadow: ws.textShadow, act: a.textContent ?? "", actColor: as.color, actShadow: as.textShadow };
      });
      const [r = 0, g = 0, b = 0] = rgb(s.color), [ar = 0, ag = 0, ab = 0] = rgb(s.actColor);
      return { word: s.word, size: s.size, red: r > 200 && g < 110 && b < 110, green: g > 200 && r < 130 && b < 180, wordGlow: s.shadow !== "none", act: s.act, actGreen: ag > 200 && ar < 160 && ab < 200, actGlow: s.actShadow !== "none" };
    };
    expect(await look("yes")).toEqual({ word: "YES", size: 46, red: false, green: true, wordGlow: true, act: "Keep local", actGreen: true, actGlow: true });
    expect(await look("no")).toEqual({ word: "NO", size: 46, red: true, green: false, wordGlow: true, act: "Pool it", actGreen: true, actGlow: true });
    const pool = await page.locator("#pool").evaluate((e) => { const s = getComputedStyle(e); return { border: s.borderTopColor, glow: s.boxShadow }; });
    const [pr = 0, pg = 0] = rgb(pool.border);
    expect({ green: pg > 200 && pr < 130, glow: pool.glow !== "none" }).toEqual({ green: true, glow: true });
    const chips = await page.locator("#jevLog .chip").evaluateAll((cs) => cs.map((c) => `${c.textContent ?? ""} ${getComputedStyle(c).backgroundColor}`));
    expect(chips.slice(0, 2).map((c) => { const [r = 0, g = 0] = rgb(c.replace(/^\w+ /, "")); return `${c.split(" ")[0] ?? ""}:${g > r ? "green" : "red"}`; })).toEqual(["YES:green", "NO:red"]);
  } finally { await close(page); }
}, 60000);

// operator 2026-10-23 and ux-swarm c02 to c05: the metrics are four icon tiles (the rest behind a toggle), the cast is one
// closed line, the show label appears once with a SCRIPTED badge, and on a phone the tiles are 2 by 2 and the whole
// section fits one screen.
for (const [width, height] of [[390, 844], [1440, 900]] satisfies [number, number][]) {
  test(`[integration] TP-D11 at ${width}x${height} the metrics are four icon tiles with every count still readable; details and cast stay closed; the label shows once`, async () => {
    const page = await open(width, height, "reduce", "#burn-after");
    try {
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
      const view = await page.evaluate(() => {
        const vis = (e: Element): boolean => e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && e.getBoundingClientRect().width > 0;
        const tiles = [...document.querySelectorAll("#poolPanel .pp-m")].filter(vis);
        const label = [...document.querySelectorAll("body *")].filter((e) => vis(e) && e.children.length === 0 && /scripted/i.test(e.textContent ?? "")).length;
        const panel = document.getElementById("poolPanel")?.getBoundingClientRect();
        return {
          tiles: tiles.length, icons: tiles.filter((t) => t.querySelector("svg.pp-icon") !== null).length,
          cols: new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().left))).size,
          runOpen: document.querySelector<HTMLDetailsElement>("#poolRun")?.open ?? null, castOpen: document.querySelector<HTMLDetailsElement>("#poolCastBox")?.open ?? null,
          cast: document.querySelector("#poolCastBox summary")?.textContent ?? "", badge: document.querySelector("#jevTag") === null,
          label, panelH: panel ? Math.round(panel.height) : 0, gauge: document.getElementById("gaugeName")?.textContent ?? "",
        };
      });
      expect({ ...view, panelH: view.panelH < 844 }).toEqual({
        tiles: 4, icons: 4, cols: width < 500 ? 2 : 4, runOpen: false, castOpen: false, cast: "Cast: 21 public maps", badge: true, label: 1, panelH: true, gauge: "Weekly limit left",
      });
      // nothing lost: every count is still on the page, from the same run
      expect(await metric(page, "decisions")).toBe(`${fmt(END1.decisions)} (task checks ${fmt(END1.taskChecks)} · idle checks ${fmt(END1.idleChecks)})`);
      expect(await metric(page, "yes")).toBe(fmt(END1.taskYes + END1.idleYes));
      expect(await metric(page, "no")).toBe(fmt(END1.taskNo + END1.idleNo));
      expect(await metric(page, "pool")).toBe(`${fmt(END1.poolWaiting)} · ${fmt(END1.pickedUp)} · ${fmt(END1.completed)}`);
      expect(await metric(page, "parallelPeak")).toBe(fmt(END1.parallelPeak));
      expect(await page.locator("#jevLog li").count()).toBe(4);
    } finally { await close(page); }
  }, 60000);
}

// operator 2026-10-23: Jev's decisions belong near the day cards. On desktop each of the four decision rows sits inside the
// stage block, and the day it belongs to carries a YES/NO chip naming the task.
for (const [width, height] of [[1440, 900], [1280, 800]] satisfies [number, number][]) {
  test(`[integration] TP-D12 at ${width}x${height} each decision row sits in the stage, under the posters, and its day carries a YES/NO chip`, async () => {
    const page = await open(width, height, "reduce", "#burn-after");
    try {
      await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
      const r = await page.evaluate(() => {
        const st = document.getElementById("opening")?.getBoundingClientRect(), run = document.getElementById("run")?.getBoundingClientRect();
        const rows = [...document.querySelectorAll("#jevLog li")].map((li) => li.getBoundingClientRect());
        return {
          rows: rows.length,
          inside: rows.every((b) => !!st && b.left >= st.left - 0.5 && b.right <= st.right + 0.5 && b.top >= st.top - 0.5 && b.bottom <= st.bottom + 0.5),
          underPosters: rows.every((b) => !!run && b.top >= run.bottom - 0.5),
          chips: [...document.querySelectorAll("#run .poster")].map((p) => [...p.querySelectorAll(".pchip")].map((c) => `${c.textContent ?? ""}:${c instanceof HTMLElement ? c.dataset.task ?? "" : ""}`)),
        };
      });
      expect({ rows: r.rows, inside: r.inside, underPosters: r.underPosters }).toEqual({ rows: 4, inside: true, underPosters: true });
      expect(r.chips).toEqual([[], ["YES:Rename the env settings", "NO:Review last week’s PRs"], [], [], ["YES:Patch the login copy", "NO:Write tests for the login page"], [], []]);
    } finally { await close(page); }
  }, 60000);
}
