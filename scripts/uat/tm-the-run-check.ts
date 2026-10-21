// Headless check for /tm/ "The Run" (site/tm/index.html), a port of the prototype's check.py.
//
//   bun scripts/uat/tm-the-run-check.ts [--page <file>] [--base <git ref>] [--chromium <path>]
//
// At 390x844 (phone) and 1440x960 it loads the page and every deep link and fails on any JS error, console error or
// warning, network request other than the local page and its own files, the removed curtain scene (#curtain,
// #marquee, #sur), a deep link that does not reach its end state, and at 390 any visible text under 11px or any
// horizontal scroll. It drives the show by keyboard (pick, Skip to the end, Try this prompt, Skip; focus must land
// on Replay), checks Tab reaches Skip to the command and Copy, that reduced motion jumps to end states, that Copy
// copies the exact command, and at 1440 that the burn journey plays to its end with no skipping. With --base it also
// fails when site/tm/map.ts differs from that ref. Prints counts per width and CLEAN, or each problem; exit 1 on any.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { resolveChromium } from "./happy-path-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const TM_PAGE = join(ROOT, "site", "tm", "index.html");
export const COMMAND = "curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts | bun run - --share";
export const HASHES = ["", "#burn-before", "#burn-after", "#under-before", "#under-after", "#demo-burn", "#demo-under", "#command"];
export type Viewport = { readonly width: number; readonly height: number; readonly mobile: boolean };
export const VIEWPORTS: readonly Viewport[] = [{ width: 390, height: 844, mobile: true }, { width: 1440, height: 960, mobile: false }];
const MODES: readonly ("burn" | "under")[] = ["burn", "under"];

/** One check: the width it ran at (0 for repo-wide), its name, and the problem when it failed. */
export type Check = { readonly width: number; readonly name: string; readonly ok: boolean; readonly detail: string };
export type Tally = { readonly run: number; readonly passed: number; readonly failed: number };

/** Counts per width (0 = repo-wide), in ascending width order, plus the total. */
export function summarise(checks: readonly Check[]): { readonly widths: ReadonlyMap<number, Tally>; readonly total: Tally; readonly clean: boolean } {
  const widths = new Map<number, Tally>();
  for (const c of [...checks].sort((a, b) => a.width - b.width)) {
    const t = widths.get(c.width) ?? { run: 0, passed: 0, failed: 0 };
    widths.set(c.width, { run: t.run + 1, passed: t.passed + (c.ok ? 1 : 0), failed: t.failed + (c.ok ? 0 : 1) });
  }
  const failed = checks.filter((c) => !c.ok).length;
  const total = { run: checks.length, passed: checks.length - failed, failed };
  return { widths, total, clean: checks.length > 0 && failed === 0 };
}

/** The printed report: one count line per width, the total, then CLEAN or every problem. */
export function report(checks: readonly Check[]): string {
  const s = summarise(checks);
  const lines = [...s.widths].map(([w, t]) => `${w === 0 ? "repo" : `${w}px`}: ${t.run} checks run, ${t.passed} passed, ${t.failed} failed`);
  lines.push(`total: ${s.total.run} checks run, ${s.total.passed} passed, ${s.total.failed} failed`);
  if (s.clean) lines.push("CLEAN: no JS or console errors, no network requests, no phone text under 11px, no horizontal scroll at 390, curtain scene absent, deep links reach their end states, keyboard flow and Skip land on Replay, reduced motion jumps to end states, Copy copies the exact command");
  else for (const c of checks) if (!c.ok) lines.push(`FAIL [${c.width === 0 ? "repo" : `${c.width}px`}] ${c.name}: ${c.detail}`);
  return lines.join("\n");
}

const LOCAL = /^(file|data|blob|about):/;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

type Watch = { errors: string[]; consoles: string[]; requests: string[] };
function watch(page: Page): Watch {
  const w: Watch = { errors: [], consoles: [], requests: [] };
  page.on("pageerror", (e) => w.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning" || m.type() === "assert") w.consoles.push(`${m.type()}: ${m.text()}`); });
  page.on("request", (r) => { if (!LOCAL.test(r.url())) w.requests.push(r.url()); });
  return w;
}

/** Visible text under 11px, scaled by SVG viewBoxes and transforms (check.py's measure). */
const SMALL_TEXT = `(() => { const out = []; document.querySelectorAll('body *').forEach((el) => {
  if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e); if (c.display === 'none' || +c.opacity === 0 || c.visibility === 'hidden') return; }
  let fs = parseFloat(getComputedStyle(el).fontSize);
  const svg = el.closest('svg'); if (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) fs = fs * svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
  let sc = 1; for (let e = el; e && e !== document.body; e = e.parentElement) { const t = getComputedStyle(e).transform; if (t && t !== 'none') { const m = new DOMMatrix(t); sc *= Math.hypot(m.a, m.b); } }
  fs *= sc;
  if (fs < 10.99) out.push(el.tagName + '.' + (el.getAttribute('class') || '') + ' "' + el.textContent.trim().slice(0, 30) + '" ' + fs.toFixed(1) + 'px');
}); return out; })()`;

type EndState = { drop: boolean; ghost: boolean; settled: boolean; half: number; extra: number; cancelled: number; verdict: string; badge: string; focus: string; skipHidden: boolean };
const END_STATE = `(() => ({
  drop: document.getElementById('drop').classList.contains('show-copy'),
  ghost: document.getElementById('ghost').classList.contains('on'),
  settled: document.getElementById('stage').classList.contains('settled'),
  half: document.querySelectorAll('.poster.half').length,
  extra: document.querySelectorAll('.poster.has-extra').length,
  cancelled: document.querySelectorAll('.poster.cancel').length,
  verdict: document.getElementById('reviewFull').hidden ? '' : document.getElementById('verdict').textContent,
  badge: document.getElementById('gaugeBadge').textContent,
  focus: document.activeElement ? document.activeElement.id : '',
  skipHidden: document.getElementById('skip').hidden,
}))()`;
async function endState(page: Page): Promise<EndState> {
  const s: unknown = await page.evaluate(END_STATE);
  if (typeof s !== "object" || s === null) throw new Error("end state not readable");
  const get = (k: string): unknown => Reflect.get(s, k);
  const num = (k: string): number => { const v = get(k); return typeof v === "number" ? v : -1; };
  const str = (k: string): string => { const v = get(k); return typeof v === "string" ? v : ""; };
  const bool = (k: string): boolean => get(k) === true;
  return { drop: bool("drop"), ghost: bool("ghost"), settled: bool("settled"), half: num("half"), extra: num("extra"), cancelled: num("cancelled"), verdict: str("verdict"), badge: str("badge"), focus: str("focus"), skipHidden: bool("skipHidden") };
}

/** What each end-state deep link must show. */
export function expectedEnd(hash: string, s: EndState): string | null {
  const ok = (cond: boolean): string | null => cond ? null : JSON.stringify(s);
  if (hash === "#burn-before") return ok(s.drop && s.cancelled === 3 && s.verdict === "Walk out");
  if (hash === "#burn-after") return ok(s.settled && s.verdict === "Standing ovation" && s.badge === "Lasted to Sunday");
  if (hash === "#under-before") return ok(s.ghost && s.half === 7 && s.verdict === "Still in previews");
  if (hash === "#under-after") return ok(s.settled && s.extra === 6 && s.verdict === "Standing ovation" && s.badge === "Target passed");
  if (hash === "#command") return ok(s.focus === "command");
  return null;
}

async function press(page: Page, id: string): Promise<void> {
  await page.evaluate((target) => document.getElementById(target)?.focus(), id);
  await page.keyboard.press("Enter");
}
async function focusedId(page: Page): Promise<string> { return page.evaluate(() => document.activeElement?.id ?? ""); }

async function checkWidth(browser: Browser, vp: Viewport, url: string): Promise<Check[]> {
  const out: Check[] = [];
  const w = vp.width;
  const add = (name: string, problem: string | null): void => { out.push({ width: w, name, ok: problem === null, detail: problem ?? "" }); };
  const newContext = (motion: "reduce" | "no-preference"): Promise<BrowserContext> =>
    browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: vp.mobile, hasTouch: vp.mobile, reducedMotion: motion });
  const errorsOf = (label: string, seen: Watch): void => {
    add(`${label}: JS errors`, seen.errors.length ? seen.errors.join("; ") : null);
    add(`${label}: console errors`, seen.consoles.length ? seen.consoles.join("; ") : null);
    add(`${label}: network requests`, seen.requests.length ? seen.requests.join(" ") : null);
  };

  const context = await newContext("no-preference");
  try {
    // 1. the page and every deep link
    for (const hash of HASHES) {
      const page = await context.newPage();
      const seen = watch(page);
      const label = hash || "start";
      try {
        await page.goto(url + hash, { waitUntil: "load" });
        await sleep(hash.startsWith("#demo") ? 2500 : 1500);
        errorsOf(label, seen);
        const gone = await page.evaluate(() => ["curtain", "marquee", "sur"].filter((n) => document.getElementById(n) !== null));
        add(`${label}: curtain scene absent`, gone.length ? `found #${gone.join(", #")}` : null);
        const end = await endState(page);
        if (["#burn-before", "#burn-after", "#under-before", "#under-after", "#command"].includes(hash)) add(`${label}: end state`, expectedEnd(hash, end));
        if (vp.mobile) {
          const small: unknown = await page.evaluate(SMALL_TEXT);
          add(`${label}: no text under 11px`, Array.isArray(small) && small.length ? small.join("; ") : null);
          const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
          add(`${label}: no horizontal scroll`, widths.doc <= vp.width && widths.body <= vp.width ? null : JSON.stringify(widths));
        }
      } finally { await page.close(); }
    }

    // 2. the show by keyboard: pick, Skip to the end, Try this prompt, Skip; focus lands on Replay both times
    for (const mode of MODES) {
      const page = await context.newPage();
      const seen = watch(page);
      try {
        await page.goto(url, { waitUntil: "load" });
        await sleep(600);
        await page.evaluate((m) => { const el = document.querySelector(`.pick-btn[data-mode=${m}]`); if (el instanceof HTMLElement) el.focus(); }, mode);
        await page.keyboard.press("Enter");
        await sleep(1600);
        add(`keyboard ${mode}: Skip shows while the week plays`, (await page.evaluate(() => document.getElementById("skip")?.hidden === false)) ? null : "skip hidden");
        await press(page, "skip");
        await sleep(800);
        const first = await endState(page);
        const without = mode === "under" ? first.ghost && first.half === 7 : first.drop && first.cancelled === 3;
        add(`keyboard ${mode}: Skip reaches the Without end`, without && first.skipHidden ? null : JSON.stringify(first));
        add(`keyboard ${mode}: focus on Replay after Skip`, first.focus === "replay" ? null : `focus on ${first.focus || "nothing"}`);
        await press(page, mode === "under" ? "ghostBtn" : "dropBtn");
        await sleep(2400);
        add(`keyboard ${mode}: Skip shows while the prompt is seated`, (await page.evaluate(() => document.getElementById("skip")?.hidden === false)) ? null : "skip hidden");
        await press(page, "skip");
        await sleep(1000);
        const second = await endState(page);
        const withEnd = second.settled && second.verdict === "Standing ovation" && (mode === "under" ? second.extra === 6 : second.badge === "Lasted to Sunday");
        add(`keyboard ${mode}: Skip reaches the With end`, withEnd ? null : JSON.stringify(second));
        add(`keyboard ${mode}: focus on Replay after the second Skip`, second.focus === "replay" ? null : `focus on ${second.focus || "nothing"}`);
        errorsOf(`keyboard ${mode}`, seen);
      } finally { await page.close(); }
    }

    // 3. Tab: the first stop is Skip to the command; it moves focus to the ticket; Tab then reaches Copy
    {
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "load" });
        await page.keyboard.press("Tab");
        add("Tab: first stop is Skip to the command", (await focusedId(page)) === "jumpCommand" ? null : `first stop ${await focusedId(page)}`);
        await page.keyboard.press("Enter");
        await sleep(400);
        const at = await page.evaluate(() => {
          const el = document.getElementById("command");
          const r = el?.getBoundingClientRect();
          return { focus: document.activeElement?.id ?? "", inView: r !== undefined && r.top >= -1 && r.top < innerHeight };
        });
        add("Skip to the command: focus and view on the ticket", at.focus === "command" && at.inView ? null : JSON.stringify(at));
        let reached = false;
        for (let i = 0; i < 12 && !reached; i++) { await page.keyboard.press("Tab"); reached = (await focusedId(page)) === "copy"; }
        add("Tab: reaches Copy", reached ? null : `stopped on ${await focusedId(page)}`);
      } finally { await page.close(); }
    }

    // 4. Copy copies the exact command
    {
      const page = await context.newPage();
      try {
        await page.addInitScript(() => {
          Reflect.set(window, "__copied", "");
          Object.defineProperty(navigator, "clipboard", { value: { writeText: (t: string) => { Reflect.set(window, "__copied", t); return Promise.resolve(); } } });
        });
        await page.goto(url, { waitUntil: "load" });
        await page.locator("#copy").click();
        await page.waitForFunction(() => (document.getElementById("copyMsg")?.textContent ?? "").length > 0, null, { timeout: 3000 });
        const got = await page.evaluate(() => ({ copied: String(Reflect.get(window, "__copied")), msg: document.getElementById("copyMsg")?.textContent ?? "", shown: document.getElementById("cmd")?.textContent ?? "" }));
        add("Copy: copies the exact command", got.copied === COMMAND && got.shown === COMMAND && got.msg.startsWith("Copied") ? null : JSON.stringify(got));
      } finally { await page.close(); }
    }

    // 5. at 1440 the burn journey plays to its end with nothing skipped
    if (!vp.mobile) {
      const page = await context.newPage();
      const seen = watch(page);
      try {
        await page.goto(url, { waitUntil: "load" });
        await page.locator(".pick-btn[data-mode=burn]").click();
        await sleep(6500);
        const mid = await endState(page);
        add("natural burn: the curtain drops at the limit", mid.drop && mid.cancelled === 3 ? null : JSON.stringify(mid));
        await page.locator("#tryBtn").click();
        await sleep(17000);
        const end = await endState(page);
        add("natural burn: curtain call, Skip hidden at the end", end.settled && end.skipHidden && end.badge === "Lasted to Sunday" ? null : JSON.stringify(end));
        errorsOf("natural burn", seen);
      } finally { await page.close(); }
    }
  } finally { await context.close(); }

  // 6. reduced motion jumps straight to end states
  const reduced = await newContext("reduce");
  try {
    for (const mode of MODES) {
      const page = await reduced.newPage();
      const seen = watch(page);
      try {
        await page.goto(url, { waitUntil: "load" });
        await page.locator(`.pick-btn[data-mode=${mode}]`).click();
        await sleep(150);
        const first = await endState(page);
        add(`reduced motion ${mode}: Without end at once`, (mode === "burn" ? first.drop : first.ghost) && first.skipHidden ? null : JSON.stringify(first));
        await page.locator(mode === "burn" ? "#dropBtn" : "#ghostBtn").click();
        await sleep(150);
        const second = await endState(page);
        add(`reduced motion ${mode}: With end at once`, second.settled && second.skipHidden ? null : JSON.stringify(second));
        const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
        add(`reduced motion ${mode}: nothing animating`, running === 0 ? null : `${running} running animations`);
        errorsOf(`reduced motion ${mode}`, seen);
      } finally { await page.close(); }
    }
  } finally { await reduced.close(); }
  return out;
}

/** site/tm/map.ts must not differ from the base ref. */
export function mapUnchanged(base: string, cwd = ROOT): Check {
  const r = spawnSync("git", ["diff", "--name-only", base, "--", "site/tm/map.ts"], { cwd, encoding: "utf8" });
  const changed = r.stdout.trim();
  const problem = r.status !== 0 ? `git diff failed: ${r.stderr.trim()}` : changed ? `${changed} differs from ${base}` : null;
  return { width: 0, name: `map.ts unchanged against ${base}`, ok: problem === null, detail: problem ?? "" };
}

/** Run every check against a page file. base: a git ref for the map.ts check, or null to skip it. */
export async function runTheRunCheck(opts: { readonly page?: string; readonly base?: string | null; readonly chromium?: string | null } = {}): Promise<Check[]> {
  const pageFile = opts.page ?? TM_PAGE;
  const found = resolveChromium(opts.chromium ?? null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  const browser = await chromium.launch({ headless: true, executablePath: found.path });
  try {
    const url = pathToFileURL(pageFile).href;
    const results = await Promise.all(VIEWPORTS.map((vp) => checkWidth(browser, vp, url)));
    const checks = results.flat();
    const base = opts.base === undefined ? "origin/main" : opts.base;
    if (base !== null) checks.push(mapUnchanged(base));
    return checks;
  } finally { await browser.close(); }
}

function argValue(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? null : null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const checks = await runTheRunCheck({ page: argValue(args, "--page") ?? TM_PAGE, base: argValue(args, "--base") ?? "origin/main", chromium: argValue(args, "--chromium") });
  console.log(report(checks));
  process.exit(summarise(checks).clean ? 0 : 1);
}
