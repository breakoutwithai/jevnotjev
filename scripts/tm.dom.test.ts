import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import { main, renderShareBlock, shareLink, type SharePayload } from "../skills/tokenmax-map/scripts/map.ts";

// The /tm/ scroll story (#238): the v3 show built for production. Served from site/ by Bun.serve; every off-origin
// request (web fonts) is blocked, so the page is measured with its fallback fonts, the worst case for wrapping.

const SITE = join(import.meta.dir, "..", "site");
const COMMAND = "curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts | bun run - --share";
// One builder's real week, 16 Oct 2026 (the builder's own tokenmax-map run): Claude 515 sessions and 68 subagent,
// Codex 3,478 and 376; caps 1 short and 1 unknown window; output tokens as below; Opus-class 87%; Codex week 15%.
const REAL: SharePayload = {
  v: "tm-share/1",
  skill: "0.3.0",
  days: 7,
  sources: "claude+codex",
  sessions: 515 + 3478,
  subagent_sessions: 68 + 376,
  caps: { short: 1, weekly: 0, unknown: 1 },
  output_tokens: { claude: 9977232, codex: 7503143 },
  opus_share_pct: 87,
  codex_weekly_pct: 15,
};
const MOTIONS: ("no-preference" | "reduce")[] = ["no-preference", "reduce"];

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

async function open(width: number, height: number, motion: "no-preference" | "reduce", errors?: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  if (errors) page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}/tm/`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#wires path.wire").length === 3);
  return page;
}
async function close(page: Page): Promise<void> { await page.context().close(); }

/** Scroll to a share of the page and let the scroll handler draw one frame. */
async function scrollShare(page: Page, share: number): Promise<void> {
  await page.evaluate((s) => scrollTo(0, Math.round((document.documentElement.scrollHeight - innerHeight) * s)), share);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
}

const termLines = (page: Page): Promise<string[]> => page.locator("#out .ln").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));

for (const motion of MOTIONS) {
  test(`[integration] no horizontal scroll at 390x844 at 0, 50 and 100% of the scroll (${motion})`, async () => {
    const errors: string[] = [];
    const page = await open(390, 844, motion, errors);
    try {
      for (const share of [0, .5, 1]) {
        await scrollShare(page, share);
        const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        expect(widths.doc).toBeLessThanOrEqual(390);
        expect(widths.body).toBeLessThanOrEqual(390);
      }
      expect(errors).toEqual([]);
    } finally { await close(page); }
  }, 30000);

  test(`[integration] Copy sits in the first screen and copies the exact command; aria-live says Copied (${motion})`, async () => {
    for (const [width, height] of [[390, 844], [1440, 900]] as const) {
      const page = await open(width, height, motion);
      try {
        expect(await page.locator("#cmd").textContent()).toBe(COMMAND);
        const copy = page.getByRole("button", { name: "Copy" });
        const box = await copy.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, covered: hit === node || node.contains(hit) };
        });
        expect(box.top >= 0 && box.bottom <= height && box.left >= 0 && box.right <= width && box.covered).toBe(true);
        expect(await page.locator("#copyMsg").getAttribute("aria-live")).toBe("polite");
        await copy.click();
        await page.waitForFunction(() => (document.getElementById("copyMsg")?.textContent ?? "").length > 0);
        expect(await page.locator("#copyMsg").textContent()).toContain("Copied");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COMMAND);
      } finally { await close(page); }
    }
  }, 30000);
}

test("[integration] Copy falls back to selecting the command with a keyboard hint when the clipboard refuses", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } });
      document.execCommand = () => false;
    });
    await page.goto(`http://127.0.0.1:${server.port}/tm/`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Copy" }).click();
    await page.waitForFunction(() => (document.getElementById("copyMsg")?.textContent ?? "").length > 0);
    expect(await page.locator("#copyMsg").textContent()).toMatch(/selected\. Press (Cmd|Ctrl)\+C to copy it\./);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(COMMAND);
  } finally { await page.close(); }
}, 30000);

test("[integration] reduced motion shows every scene in its end state with nothing animating", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]] as const) {
    const page = await open(width, height, "reduce");
    try {
      const state = await page.evaluate(() => {
        const hidden: string[] = [];
        const opaque = (el: Element | null): boolean => {
          for (let n = el; n; n = n.parentElement) if (parseFloat(getComputedStyle(n).opacity) < 1) return false;
          return true;
        };
        const walk = document.createTreeWalker(document.querySelector("#track") ?? document.body, NodeFilter.SHOW_TEXT);
        for (let node = walk.nextNode(); node; node = walk.nextNode()) {
          const text = (node.textContent ?? "").trim();
          const el = node.parentElement;
          // The curtain, the surtitle and the Enter keycap are motion-only props (aria-hidden), not scene text.
          if (!text || !el || el.closest(".curtain, .sur, .key")) continue;
          if (!el.checkVisibility({ visibilityProperty: true }) || !opaque(el)) hidden.push(text);
        }
        return {
          hidden,
          animations: document.getAnimations().length,
          motion: document.documentElement.classList.contains("motion"),
          scenes: [...document.querySelectorAll(".scene")].map((s) => s.getBoundingClientRect().height > 0),
          typed: document.getElementById("typed")?.textContent,
          wiresDrawn: [...document.querySelectorAll("#wires path.wire")].every((p) => getComputedStyle(p).strokeDashoffset === "0px" || getComputedStyle(p).strokeDasharray === "none"),
          jobs: document.querySelectorAll("#jobs g").length,
        };
      });
      expect(state.motion).toBe(false);
      expect(state.hidden).toEqual([]);
      expect(state.animations).toBe(0);
      expect(state.scenes).toEqual([true, true, true]);
      expect(state.typed).toBe(COMMAND);
      expect(state.wiresDrawn).toBe(true);
      expect(state.jobs).toBe(3);
    } finally { await close(page); }
  }
}, 30000);

test("[integration] the page and its source carry no em or en dash and no home paths", async () => {
  const page = await open(1440, 900, "reduce");
  try {
    const text = await page.evaluate(() => document.documentElement.textContent ?? "");
    expect(text).not.toMatch(/[\u2013\u2014]/);
  } finally { await close(page); }
  for (const file of ["index.html", "tm.css", "tm.js"]) {
    const src = readFileSync(join(SITE, "tm", file), "utf8");
    expect(src).not.toMatch(/[\u2013\u2014]|&[mn]dash;/);
    expect(src).not.toMatch(/\/Users\/|~\/|\.claude\//);
  }
}, 30000);

test("[integration] the terminal prints what map.ts --share prints: real line shapes, the real share block, the real link", async () => {
  // Line shapes: run the real main() on an empty Claude folder and turn each stdout line into a pattern.
  const out = join(mkdtempSync(join(tmpdir(), "tm-dom-out-")), "r");
  const logged: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  try { expect(await main(["--share", "--claude", mkdtempSync(join(tmpdir(), "tm-dom-claude-")), "--codex", "none", "--out", out])).toBe(0); } finally { log.mockRestore(); }
  const stdout = logged.join("\n").split("\n");
  const shape = (line: string): RegExp => new RegExp(`^${line.split(out).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d+/g, "\\d+")).join("/[^ ]+")}$`);

  const page = await open(1440, 900, "reduce");
  try {
    const lines = await termLines(page);
    expect(lines[0]).toBe(`$ ${COMMAND}`);
    // wrote private-report, wrote share-draft (scan: clean), the sessions line, the blank line: same shapes as main().
    for (let i = 0; i < 4; i++) expect(lines[i + 1] ?? "").toMatch(shape(stdout[i] ?? "\u0000"));
    expect(lines[3]).toBe("claude sessions 515, codex sessions 3478, cap episodes 2");
    // The share block: every shown line equals renderShareBlock(REAL) in order; "..." stands for one or more whole lines.
    const expected = renderShareBlock(REAL).split("\n");
    const shown = lines.slice(5);
    expect(shown[0]).toBe(expected[0]);
    let j = 0;
    for (const line of shown) {
      if (line === "...") { j += 1; continue; }
      while (j < expected.length && expected[j] !== line) j += 1;
      expect(j).toBeLessThan(expected.length);
      j += 1;
    }
    expect(shown.at(-1)).toBe(shareLink(REAL));
    expect(shown.at(-2)).toBe("Open this link to review and share:");
    // Only whole lines are left out: what is shown plus what "..." stands for is the block, in order.
    const elided = expected.filter((l) => !shown.includes(l));
    expect(shown.filter((l) => l === "...").length).toBeGreaterThan(0);
    expect(elided.every((l) => !l.startsWith("Open") && !l.startsWith("https"))).toBe(true);
    expect(await page.locator("#openCard").getAttribute("href")).toBe(shareLink(REAL));
    expect(await page.locator("#term .bar").textContent()).toContain("one builder's real week, 16 Oct 2026");
    expect(await page.locator("#sceneB").textContent()).toContain("One builder's real week, 16 Oct 2026");
    expect(await page.locator('a[href="/maps/"]').count()).toBe(1);
  } finally { await close(page); }
}, 30000);

test("[integration] the router card says not run yet and shows no result: no percentage, no counts beyond 47 jobs and #236", async () => {
  const page = await open(390, 844, "reduce");
  try {
    const text = await page.locator("#sceneD").evaluate((node) => `${node.textContent ?? ""} ${node.querySelector("svg")?.getAttribute("aria-label") ?? ""}`);
    expect(text).toContain("47 jobs in rehearsal, not run yet");
    expect(text).toContain("no result yet");
    expect(text).not.toContain("%");
    expect([...text.matchAll(/\d+/g)].map((m) => m[0]).sort()).toEqual(["236", "47"]);
  } finally { await close(page); }
}, 30000);

for (const motion of MOTIONS) {
  test(`[integration] every text node renders at 12 px or more (${motion})`, async () => {
    for (const [width, height] of [[390, 844], [1440, 900]] as const) {
      const page = await open(width, height, motion);
      try {
        for (const share of motion === "reduce" ? [0] : [0, .3, .65, 1]) {
          await scrollShare(page, share);
          const small = await page.evaluate(() => {
            const found: string[] = [];
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let node = walk.nextNode(); node; node = walk.nextNode()) {
              const text = (node.textContent ?? "").trim();
              const el = node.parentElement;
              if (!text || !el || el.closest("script, style") || !el.checkVisibility({ visibilityProperty: true })) continue;
              let px = parseFloat(getComputedStyle(el).fontSize);
              if (el instanceof SVGGraphicsElement) {
                const m = el.getScreenCTM();
                if (m) px *= Math.hypot(m.a, m.b);
              }
              if (px < 11.95) found.push(`${text.slice(0, 30)} ${px.toFixed(1)}px`);
            }
            return found;
          });
          expect(small).toEqual([]);
        }
      } finally { await close(page); }
    }
  }, 60000);
}

/** Polylines sampled along each wire, in the wires layer's coordinates. */
async function wirePolylines(page: Page): Promise<{ x: number; y: number }[][]> {
  return page.locator("#wires path.wire").evaluateAll((paths) => paths.map((node) => {
    if (!(node instanceof SVGPathElement)) return [];
    const L = node.getTotalLength();
    return Array.from({ length: 241 }, (_, i) => { const p = node.getPointAtLength((L * i) / 240); return { x: p.x, y: p.y }; });
  }));
}
function crosses(a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean {
  const side = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) {
    const p1 = a[i - 1], p2 = a[i], q1 = b[j - 1], q2 = b[j];
    if (!p1 || !p2 || !q1 || !q2) continue;
    const d1 = side(q1, q2, p1), d2 = side(q1, q2, p2), d3 = side(p1, p2, q1), d4 = side(p1, p2, q2);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  }
  return false;
}

for (const motion of MOTIONS) {
  test(`[integration] the three wires never cross, at 390 and 1440 (${motion})`, async () => {
    for (const [width, height] of [[390, 844], [1440, 900]] as const) {
      const page = await open(width, height, motion);
      try {
        if (motion === "no-preference") await scrollShare(page, .45);
        const lines = await wirePolylines(page);
        expect(lines.length).toBe(3);
        for (const line of lines) expect(line.length).toBe(241);
        for (let i = 0; i < 3; i++) for (let k = i + 1; k < 3; k++) expect(crosses(lines[i] ?? [], lines[k] ?? [])).toBe(false);
        // Each wire ends on its own figure: the end point sits within the figure's picture horizontally.
        const ends = await page.evaluate(() => {
          const box = document.getElementById("wires")?.getBoundingClientRect();
          return [1, 2, 3].map((i) => {
            const svg = document.querySelector(`#pic${i} svg`)?.getBoundingClientRect();
            return box && svg ? { left: svg.left - box.left - 12, right: svg.right - box.left + 12 } : { left: 0, right: 0 };
          });
        });
        lines.forEach((line, i) => {
          const end = line.at(-1);
          const fig = ends[i];
          expect(end !== undefined && fig !== undefined && end.x >= fig.left && end.x <= fig.right).toBe(true);
        });
      } finally { await close(page); }
    }
  }, 30000);
}
