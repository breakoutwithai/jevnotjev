// Headless check for /tm/ "The Run" (site/tm/index.html), a port of the prototype's check.py.
//
//   bun scripts/uat/tm-the-run-check.ts [--page <file>] [--base <git ref>] [--chromium <path>]
//
// At 390x844 (phone) and 1440x900 it loads the page and every deep link and fails on any JS error, console error or
// warning, network request other than the local page and its own files, the removed curtain scene (#curtain,
// #marquee, #sur), a deep link that does not reach its end state, any visible text under 12px at 1440 or 11px at 390,
// and at 390 any horizontal scroll. Issue #309 criterion 3: the first viewport (no scroll) must show what the visitor gets, who it
// is for and not for, and that the router is not built, with no word from the jargon list; no "curl" or "terminal"
// anywhere on the page. The prompt is shown in full with no click, and no bun, curl, map.ts, --share, terminal,
// download or script appears in the visible text or the copied prompt (the prompt's own "do not ... download" line
// excepted). It drives the show by keyboard (pick, Skip to the end, See it with TokenMax, Skip; focus must land on Replay),
// checks Tab reaches Skip to the command and Copy, that reduced motion jumps to end states, that Copy copies the exact
// prompt, and at 1440 that the burn journey plays to its end with no skipping. With --base it also fails when site/tm/map.ts differs from that ref. Prints counts per width and CLEAN,
// or each problem; exit 1 on any.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { resolveChromium } from "./happy-path-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const TM_PAGE = join(ROOT, "site", "tm", "index.html");
/** The exact prompt /tm/ shows in full, to paste into Claude Code or Codex (operator wording, 2026-10-21). */
export const PROMPT = [
  "Look at my Claude Code and Codex history on this computer for the last 7 days. Read only the usage records, never the words of my messages or the contents of my files. Tell me: how many sessions I ran in each tool; how many times I hit a usage limit, and when; and which models each tool used, as a rough split of big versus smaller models, if the records show it. Say 'not recorded' for anything the records do not show, never guess. Then, in one sentence, say which pattern fits my week: running out before the end of the week, or leaving most of it unused. Do not send, install or download anything. Show me the result here as exactly this plain block and nothing else:",
  "",
  "TOKENMAX WEEK",
  "Period: <start date> to <end date>",
  "Claude sessions: <number>",
  "Codex sessions: <number>",
  "Claude output tokens: <number>",
  "Codex output tokens: <number>",
  "Opus share of Claude output: <percent>",
  "Usage limit hits: <number>",
  "Sessions per day: <7 numbers separated by commas, oldest day first, Claude Code plus Codex together>",
  "Limit hit days: <dates as YYYY-MM-DD separated by commas, or none>",
  "Codex weekly window used: <percent>",
  "Pattern: <running out | leaving most unused>",
  "",
  "The period is the start and end date, both included, 7 days in total.",
  "Sessions per day: seven numbers, one per day of the period, oldest day first. Limit hit days: the dates on which I hit a usage limit, or none.",
  "Use 'not recorded' for any line you cannot fill. Round numbers freely. Do not add anything else.",
  "Print only the block above. No notes, caveats, warnings, checks, counts of duplicates or files, or explanations before or after it. If a number is approximate, just give the number.",
].join("\n");
/** The operator's own aggregate week (already a sample on the site), as the prompt asks the assistant to print it. */
export const SAMPLE_RESULT = [
  "TOKENMAX WEEK",
  "Period: 2026-10-14 to 2026-10-20",
  "Claude sessions: 288",
  "Codex sessions: 2925",
  "Claude output tokens: 7,940,728",
  "Codex output tokens: 4,315,259",
  "Opus share of Claude output: 42%",
  "Usage limit hits: 2",
  "Codex weekly window used: 7%",
].join("\n");
/** What the Your week card must show for SAMPLE_RESULT, label then value. */
export const SAMPLE_CARD: readonly (readonly [string, string])[] = [
  ["Claude sessions", "288"],
  ["Codex sessions", "2,925"],
  ["Claude output tokens", "7,940,728"],
  ["Codex output tokens", "4,315,259"],
  ["Opus share", "42%"],
  ["Usage limit hits", "2"],
  ["Codex weekly window used", "7%"],
];
/** The Show Sample card's rows (the recorded run: 515 + 3,478 = 3,993 sessions). */
export const SAMPLE_WEEK_ROWS = "Claude sessions=515; Codex sessions=3,478; Claude output tokens=9,977,232; Codex output tokens=7,503,143; Opus share=87%; Usage limit hits=2; Codex weekly window used=15%";
/** The one sentence of the prompt allowed to name a banned word, because it forbids it. */
export const PROMPT_NEGATION = "Do not send, install or download anything.";
/** Never on the page as visible text, and never in the copied prompt outside PROMPT_NEGATION. */
export const BANNED_TEXT = /\bbun\b|\bcurl\b|map\.ts|--share|terminal|download|\bscript\b/i;

/** Banned words in a text; the prompt's own negation sentence is removed first. */
export function bannedHits(text: string): string[] {
  const m = BANNED_TEXT.exec(text.split(PROMPT_NEGATION).join(" "));
  return m ? [`"${m[0]}" in: ${text.slice(Math.max(0, m.index - 30), m.index + 30)}`] : [];
}
/** Issue #309 criterion 3: none of these words may show in the first viewport. */
export const JARGON = /\b(curl|bun|terminal|logs?|tokens?|subagents?|jsonl)\b/i;
/** Nowhere on the page, visible or not. */
export const BANNED_ANYWHERE = /\bcurl\b|terminal/i;
export const HASHES = ["", "#burn-before", "#burn-after", "#under-before", "#under-after", "#demo-burn", "#demo-under", "#command"];
export type Viewport = { readonly width: number; readonly height: number; readonly mobile: boolean };
export const VIEWPORTS: readonly Viewport[] = [{ width: 390, height: 844, mobile: true }, { width: 1440, height: 900, mobile: false }];

/** Jargon-list words in a list of visible text snippets, as "word in: snippet". */
export function jargonHits(texts: readonly string[]): string[] {
  return texts.flatMap((t) => { const m = JARGON.exec(t); return m ? [`${m[0]} in: ${t.slice(0, 60)}`] : []; });
}
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
  if (s.clean) lines.push("CLEAN: no JS or console errors, no network requests, no text under 11px at 390 or 12px at 1440, no horizontal scroll at 390, curtain scene absent, deep links reach their end states, keyboard flow and Skip land on Replay, reduced motion jumps to end states, first viewport plain with no jargon, no curl or terminal anywhere, the prompt shown in full with no banned word, Copy copies the exact prompt");
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

/** Text floors: 12px at 1440 (#309 criterion 6), 11px at 390 (the prototype's STYLE rule, an operator decision). */
export const TEXT_FLOOR: Readonly<Record<number, number>> = { 390: 11, 1440: 12 };
/** Visible text under the floor, scaled by SVG viewBoxes and transforms (check.py's measure). */
const smallText = (min: number): string => `(() => { const out = []; document.querySelectorAll('body *').forEach((el) => {
  if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e); if (c.display === 'none' || +c.opacity === 0 || c.visibility === 'hidden') return; }
  let fs = parseFloat(getComputedStyle(el).fontSize);
  const svg = el.closest('svg'); if (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) fs = fs * svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
  let sc = 1; for (let e = el; e && e !== document.body; e = e.parentElement) { const t = getComputedStyle(e).transform; if (t && t !== 'none') { const m = new DOMMatrix(t); sc *= Math.hypot(m.a, m.b); } }
  fs *= sc;
  if (fs < ${min} - 0.01) out.push(el.tagName + '.' + (el.getAttribute('class') || '') + ' "' + el.textContent.trim().slice(0, 30) + '" ' + fs.toFixed(1) + 'px');
}); return out; })()`;

export type EndState = { drop: boolean; ghost: boolean; settled: boolean; half: number; extra: number; cancelled: number; act: string; badge: string; focus: string; skipHidden: boolean; promptShown: boolean };
const END_STATE = `(() => ({
  drop: document.getElementById('drop').classList.contains('show-copy'),
  ghost: document.getElementById('ghost').classList.contains('on'),
  settled: document.getElementById('stage').classList.contains('settled'),
  half: document.querySelectorAll('.poster.half').length,
  extra: document.querySelectorAll('.poster.has-extra').length,
  cancelled: document.querySelectorAll('.poster.cancel').length,
  act: document.getElementById('act').textContent,
  badge: document.getElementById('gaugeBadge').textContent,
  focus: document.activeElement ? document.activeElement.id : '',
  skipHidden: document.getElementById('skip').hidden,
  promptShown: document.getElementById('sharePrompt').checkVisibility({ visibilityProperty: true, opacityProperty: true }),
}))()`;
async function endState(page: Page): Promise<EndState> {
  const s: unknown = await page.evaluate(END_STATE);
  if (typeof s !== "object" || s === null) throw new Error("end state not readable");
  const get = (k: string): unknown => Reflect.get(s, k);
  const num = (k: string): number => { const v = get(k); return typeof v === "number" ? v : -1; };
  const str = (k: string): string => { const v = get(k); return typeof v === "string" ? v : ""; };
  const bool = (k: string): boolean => get(k) === true;
  return { drop: bool("drop"), ghost: bool("ghost"), settled: bool("settled"), half: num("half"), extra: num("extra"), cancelled: num("cancelled"), act: str("act"), badge: str("badge"), focus: str("focus"), skipHidden: bool("skipHidden"), promptShown: bool("promptShown") };
}

/** The stage's act line for each ending (the review card that once named the verdict is gone, operator 2026-10-21). */
export const WITHOUT_ACT = "Without TokenMax \u00b7 every step in the royal box";
export const WITH_ACT = { burn: "With TokenMax \u00b7 each step in its seat", under: "With TokenMax \u00b7 cheaper seats, then more jobs" };
/** What each end-state deep link must show. */
export function expectedEnd(hash: string, s: EndState): string | null {
  const ok = (cond: boolean): string | null => cond ? null : JSON.stringify(s);
  if (hash === "#burn-before") return ok(s.drop && s.cancelled === 3 && s.act === WITHOUT_ACT);
  if (hash === "#burn-after") return ok(s.settled && s.act === WITH_ACT.burn && s.badge === "Lasted to Sunday");
  if (hash === "#under-before") return ok(s.ghost && s.half === 7 && s.act === WITHOUT_ACT);
  if (hash === "#under-after") return ok(s.settled && s.extra === 6 && s.act === WITH_ACT.under && s.badge === "Target passed");
  if (hash === "#command") return ok(s.focus === "command" && s.promptShown);
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
        await sleep(hash.startsWith("#demo") ? 2500 : hash === "" ? 2600 : 1500);
        errorsOf(label, seen);
        const gone = await page.evaluate(() => ["curtain", "marquee", "sur"].filter((n) => document.getElementById(n) !== null));
        add(`${label}: curtain scene absent`, gone.length ? `found #${gone.join(", #")}` : null);
        const end = await endState(page);
        if (["#burn-before", "#burn-after", "#under-before", "#under-after", "#command"].includes(hash)) add(`${label}: end state`, expectedEnd(hash, end));
        // The tagline fades in only once a week has played to its end: on every end-state deep link, never at rest.
        if (hash === "" || hash.endsWith("-before") || hash.endsWith("-after")) {
          const shown = await page.evaluate(() => { const el = document.getElementById("keepLights"); return !!el && el.classList.contains("shown") && el.checkVisibility({ visibilityProperty: true }); });
          add(`${label}: tagline ${hash === "" ? "hidden at rest" : "shown at the end"}`, shown === (hash !== "") ? null : `shown ${String(shown)}`);
        }
        if (hash === "") {
          // Issue #309 criterion 3, first viewport, no scroll: every visible text node that intersects the viewport.
          const first = await page.evaluate(() => {
            const texts: string[] = [];
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let node = walk.nextNode(); node; node = walk.nextNode()) {
              const text = (node.textContent ?? "").trim();
              const el = node.parentElement;
              if (!text || !el || el.closest("script, style") || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
              // Word by word: a long text node (the prompt) may start in the first viewport and run on below it.
              const words: string[] = [];
              for (const m of (node.textContent ?? "").matchAll(/\S+/g)) {
                const range = document.createRange(); range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
                if ([...range.getClientRects()].some((r) => r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) words.push(m[0]);
              }
              if (words.length) texts.push(words.join(" "));
            }
            const rect = (el: Element | null): { top: number; bottom: number; left: number; right: number; height: number } | null => {
              if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
            };
            const cue = document.getElementById("pickCue");
            return {
              texts, h1: rect(document.querySelector("h1")), boxes: [...document.querySelectorAll(".pick-btn")].map(rect), cue: rect(cue),
              cueOn: !!cue && getComputedStyle(cue).opacity === "1" && getComputedStyle(cue).pointerEvents === "none" && cue.getAttribute("aria-hidden") === "true",
              vh: innerHeight,
            };
          });
          add("first viewport: no jargon-list word", jargonHits(first.texts).join("; ") || null);
          // Operator decision (2026-10-21): the headline and two big boxes are the first viewport; the cue straddles their seam.
          const [b1, b2] = first.boxes;
          const minH = vp.mobile ? 88 : 96;
          const boxesOk = !!first.h1 && !!b1 && !!b2 && [b1, b2].every((b) => !!b && b.top >= (first.h1?.bottom ?? 0) && b.bottom <= first.vh && b.height >= minH);
          add(`first viewport: two picker boxes at least ${minH}px tall, wholly on screen, below the headline`, boxesOk ? null : JSON.stringify(first.boxes));
          const straddles = !!b1 && !!b2 && !!first.cue && (vp.mobile ? first.cue.top < b1.bottom && first.cue.bottom > b2.top : first.cue.left < b1.right && first.cue.right > b2.left);
          add("first viewport: the cue is on after about 1.5 s, over the seam, below the headline, click-through, aria-hidden", first.cueOn && straddles && (first.cue?.top ?? 0) >= (first.h1?.bottom ?? 0) ? null : JSON.stringify({ cue: first.cue, on: first.cueOn }));
          const anywhere = await page.evaluate(() => [document.documentElement.textContent ?? "", ...[...document.querySelectorAll("*")].flatMap((el) => ["title", "aria-label", "alt", "content", "href"].map((a) => el.getAttribute(a) ?? ""))].join(" "));
          const banned = new RegExp(BANNED_ANYWHERE.source, "i").exec(anywhere);
          add("no curl or terminal anywhere on the page", banned ? `found "${banned[0]}"` : null);
          // The whole page's visible text, scrolled or not: none of the banned words (the prompt's negation excepted).
          const visible = await page.evaluate(() => document.body.innerText);
          add("no bun, curl, map.ts, --share, terminal, download or script in the visible text", bannedHits(visible).join("; ") || null);
          const prompt = await page.evaluate(() => {
            const el = document.getElementById("sharePrompt");
            return { text: el?.textContent ?? "", shown: !!el && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && (el.getBoundingClientRect().height > 0), inDetails: !!el?.closest("details") };
          });
          add("the exact prompt is shown in full with no click", prompt.text === PROMPT && prompt.shown && !prompt.inDetails ? null : JSON.stringify(prompt));
          const control = await page.evaluate(() => {
            const h = document.getElementById("hCmd")?.getBoundingClientRect(), t = document.getElementById("trust")?.getBoundingClientRect();
            return {
              jump: document.getElementById("jumpCommand")?.textContent ?? "", mapGone: document.getElementById("mapWeek") === null && document.querySelector(".foot") === null, illustrative: /illustrative/i.test(document.documentElement.textContent ?? ""), keepShown: document.getElementById("keepLights")?.classList.contains("shown") ?? true,
              keep: document.getElementById("keepLights")?.textContent ?? "", pasteLine: document.getElementById("pasteLine") !== null, heading: document.getElementById("hCmd")?.textContent ?? "",
              trust: document.getElementById("trust")?.textContent ?? "", copy: document.getElementById("copy")?.textContent ?? "", details: document.querySelectorAll("details").length,
              cards: ["promptCard", "houseCard", "review", "tryBtn", "seating"].filter((n) => document.getElementById(n) !== null),
              // the trust line shares the heading's line at 1440 (it may wrap under it on a phone)
              sameLine: !!h && !!t && Math.abs(h.bottom - t.bottom) < 12, below: !!h && !!t && t.top >= h.bottom - 2,
            };
          });
          const headOk = vp.mobile ? control.sameLine || control.below : control.sameLine;
          add("no button or footer under the stage, the tagline hidden until a week ends, no Illustrative text, Map your real week heading with the trust line, Copy names where to paste, no gate, no cards", control.jump === "Skip to the command" && control.mapGone && !control.illustrative && !control.keepShown && control.keep === "TokenMax + Jev can help keep the lights on" && !control.pasteLine && control.heading === "Map your real week" && control.trust === "Pasting and Show my week stay in your browser. Only Submit sends anything." && control.copy === "Copy for Claude Code or Codex" && control.details === 0 && control.cards.length === 0 && headOk ? null : JSON.stringify(control));
        }
        const floor = TEXT_FLOOR[vp.width] ?? 12;
        const small: unknown = await page.evaluate(smallText(floor));
        add(`${label}: no text under ${floor}px`, Array.isArray(small) && small.length ? small.join("; ") : null);
        if (vp.mobile) {
          const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
          add(`${label}: no horizontal scroll`, widths.doc <= vp.width && widths.body <= vp.width ? null : JSON.stringify(widths));
        }
      } finally { await page.close(); }
    }

    // 2. the show by keyboard: pick, Skip to the end, See it with TokenMax, Skip; focus lands on Replay both times
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
        const withEnd = second.settled && second.act === WITH_ACT[mode] && (mode === "under" ? second.extra === 6 : second.badge === "Lasted to Sunday");
        add(`keyboard ${mode}: Skip reaches the With end`, withEnd ? null : JSON.stringify(second));
        add(`keyboard ${mode}: focus on Replay after the second Skip`, second.focus === "replay" ? null : `focus on ${second.focus || "nothing"}`);
        errorsOf(`keyboard ${mode}`, seen);
      } finally { await page.close(); }
    }

    // 3. Tab: the first stop is Skip to the command (off screen until focused); it moves focus and view to the prompt; Tab then reaches Copy
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
        add("Skip to the command: focus and view on the prompt section", at.focus === "command" && at.inView ? null : JSON.stringify(at));
        let reached = false;
        for (let i = 0; i < 12 && !reached; i++) { await page.keyboard.press("Tab"); reached = (await focusedId(page)) === "copy"; }
        add("Tab: reaches Copy", reached ? null : `stopped on ${await focusedId(page)}`);
      } finally { await page.close(); }
    }

    // 4. the prompt is on the page with no click; Copy copies exactly that text, which carries no banned word
    {
      const page = await context.newPage();
      try {
        await page.addInitScript(() => {
          Reflect.set(window, "__copied", "");
          Object.defineProperty(navigator, "clipboard", { value: { writeText: (t: string) => { Reflect.set(window, "__copied", t); return Promise.resolve(); } } });
        });
        await page.goto(url, { waitUntil: "load" });
        const ready = await page.locator("#copy").isVisible();
        await page.locator("#copy").click();
        await page.waitForFunction(() => (document.getElementById("copyMsg")?.textContent ?? "").length > 0, null, { timeout: 3000 });
        const got = await page.evaluate(() => ({ copied: String(Reflect.get(window, "__copied")), msg: document.getElementById("copyMsg")?.textContent ?? "", shown: document.getElementById("sharePrompt")?.textContent ?? "" }));
        add("Copy: visible with no click first", ready ? null : "Copy not visible at load");
        add("Copy: copies the exact prompt", got.copied === PROMPT && got.shown === PROMPT && got.msg.startsWith("Copied") ? null : JSON.stringify(got));
        add("Copy: the copied text has no banned word", bannedHits(got.copied).join("; ") || null);
      } finally { await page.close(); }
    }

    // 4b. paste the result back: the card shows the parsed values only; a non-result is refused in plain words
    {
      const page = await context.newPage();
      const seen = watch(page);
      try {
        await page.goto(url, { waitUntil: "load" });
        // Show Sample: hidden at load; on request the card shows the sample's values, titled Sample week, a Sample tag and no link.
        const before = await page.evaluate(() => ({ cardHidden: document.getElementById("yourWeek")?.hidden === true, sampleLink: document.querySelectorAll("a[href*='/maps/#m='], #openCard, #sceneB").length }));
        add("sample: card hidden at load, no sample section or sample link", before.cardHidden && before.sampleLink === 0 ? null : JSON.stringify(before));
        await page.locator("#showSample").click();
        const sample = await page.evaluate(() => ({
          rows: [...document.querySelectorAll("#yourFields dt")].map((dt) => `${dt.textContent ?? ""}=${dt.nextElementSibling?.textContent ?? ""}`).join("; "),
          tag: document.getElementById("sampleTag")?.checkVisibility() === true, links: document.querySelectorAll("#yourWeek a").length,
          title: document.getElementById("hYour")?.textContent ?? "", y: Math.round(scrollY),
        }));
        add("sample: Show Sample shows the sample's values, titled Sample week, with a Sample tag and no link", sample.rows === SAMPLE_WEEK_ROWS && sample.title === "Sample week" && sample.tag && sample.links === 0 ? null : JSON.stringify(sample));
        const sampleFloor = TEXT_FLOOR[vp.width] ?? 12;
        const sampleSmall: unknown = await page.evaluate(smallText(sampleFloor));
        add(`sample: no text under ${sampleFloor}px with the sample card shown`, Array.isArray(sampleSmall) && sampleSmall.length ? sampleSmall.join("; ") : null);
        const caveat = "Not checked: the duplicate files were counted twice.";
        await page.locator("#pasteBox").fill(`${caveat}\n\n${SAMPLE_RESULT}\n\n${caveat}`);
        await page.locator("#showWeek").click();
        const card = await page.evaluate(() => ({
          shown: document.getElementById("yourWeek")?.hidden === false,
          rows: [...document.querySelectorAll("#yourFields dt")].map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]),
          line: document.getElementById("yourLine")?.textContent ?? "", period: document.getElementById("yourPeriod")?.textContent ?? "", focus: document.activeElement?.id ?? "",
          tag: document.querySelector("#yourWeek .local-tag")?.textContent ?? "",
          body: document.body.innerText,
        }));
        add("paste: the card shows the parsed sample week", card.shown && JSON.stringify(card.rows) === JSON.stringify(SAMPLE_CARD) && card.line === "Heavy load: you hit your limit 2 times" && card.period === "2026-10-14 to 2026-10-20" && card.tag === "Your numbers, shown on this page only" ? null : JSON.stringify({ ...card, body: "" }));
        add("paste: pasted caveat text never reaches the page", card.body.includes("duplicate files") ? "caveat text shown" : null);
        if (vp.mobile) {
          const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
          add("paste: no horizontal scroll with the card shown", widths.doc <= vp.width && widths.body <= vp.width ? null : JSON.stringify(widths));
        }
        const floor = TEXT_FLOOR[vp.width] ?? 12;
        const small: unknown = await page.evaluate(smallText(floor));
        add(`paste: no text under ${floor}px with the card shown`, Array.isArray(small) && small.length ? small.join("; ") : null);
        await page.locator("#playMine").click();
        await sleep(400);
        await page.locator("#skip").click().catch(() => undefined);
        await sleep(600);
        const played = await page.evaluate(() => ({ big: document.getElementById("dataBig")?.textContent ?? "", cancelled: document.querySelectorAll(".poster.cancel").length, drop: document.getElementById("drop")?.classList.contains("show-copy") }));
        add("paste: Play my week plays the pasted numbers, derived ending, no crossed-out days", played.big === "You hit your limit 2 times" && played.cancelled === 0 && !played.drop ? null : JSON.stringify(played));
        await page.locator("#pasteBox").fill("hello, this is not it");
        await page.locator("#showWeek").click();
        const refused = await page.evaluate(() => ({ msg: document.getElementById("pasteError")?.textContent ?? "", card: document.getElementById("yourWeek")?.hidden === true }));
        add("paste: a non-result is refused with one plain message", refused.msg === "That doesn't look like the result. Run the prompt again and paste what it prints." && refused.card ? null : JSON.stringify(refused));
        const stored = await page.evaluate(() => localStorage.length + sessionStorage.length);
        add("paste: nothing stored", stored === 0 ? null : `${stored} storage keys`);
        errorsOf("paste", seen);
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
        await page.locator("#dropBtn").click();
        // The With week holds for Jev's task checks on Tuesday and Friday, so it runs longer than the bare week: wait
        // for the settled curtain call (up to 45 s) instead of a fixed sleep, then a beat for Skip to hide.
        await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true, null, { timeout: 45000 }).catch(() => undefined);
        await sleep(300);
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

/** site/tm/map.ts must not differ from the base ref. A base that is not a commit (a flag such as --cached, a typo) fails. */
export function mapUnchanged(base: string, cwd = ROOT): Check {
  const name = `map.ts unchanged against ${base}`;
  const ref = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { cwd, encoding: "utf8" });
  if (base.startsWith("-") || ref.status !== 0) return { width: 0, name, ok: false, detail: `${base} is not a commit` };
  const r = spawnSync("git", ["diff", "--name-only", base, "--", "site/tm/map.ts"], { cwd, encoding: "utf8" });
  const changed = r.stdout.trim();
  const problem = r.status !== 0 ? `git diff failed: ${r.stderr.trim()}` : changed ? `${changed} differs from ${base}` : null;
  return { width: 0, name, ok: problem === null, detail: problem ?? "" };
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

/** Each argument must be a known flag followed by its value; returns the first problem, or null. */
export function badArgs(args: readonly string[]): string | null {
  const known = ["--page", "--base", "--chromium"];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? "";
    if (!known.includes(flag)) return `unknown argument ${flag}`;
    if (args[i + 1] === undefined) return `${flag} needs a value`;
  }
  return null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const bad = badArgs(args);
  if (bad) { console.error(`${bad}\nusage: bun scripts/uat/tm-the-run-check.ts [--page <file>] [--base <git ref>] [--chromium <path>]`); process.exit(2); }
  const checks = await runTheRunCheck({ page: argValue(args, "--page") ?? TM_PAGE, base: argValue(args, "--base") ?? "origin/main", chromium: argValue(args, "--chromium") });
  console.log(report(checks));
  process.exit(summarise(checks).clean ? 0 : 1);
}
