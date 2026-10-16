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
// One builder's real week, 16 Oct 2026 (the builder's own tokenmax-map 0.2.0 run, recorded in the private planning folder's
// use-cases/tim-tokenmax/RUNS.md, "Builder's real history with 0.2.0"): Claude 515 sessions and 68 subagent,
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
          // Both real jobs stand at their doors: the walk's progress is 1.
          walks: [...document.querySelectorAll(".walk")].map((w) => getComputedStyle(w).getPropertyValue("--t").trim()),
        };
      });
      expect(state.motion).toBe(false);
      expect(state.hidden).toEqual([]);
      expect(state.animations).toBe(0);
      expect(state.scenes).toEqual([true, true, true]);
      expect(state.typed).toBe(COMMAND);
      expect(state.wiresDrawn).toBe(true);
      expect(state.walks).toEqual(["1", "1"]);
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
    expect(lines[3]).toBe("claude sessions 515, codex sessions 3478, cap hits 2");
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
    // The router card's link, and the skip link that reaches it while motion hides the card.
    expect(await page.locator('a[href="/maps/"]').count()).toBe(2);
  } finally { await close(page); }
}, 30000);

test("[integration] the router card says not run yet and shows no result: no percentage, no counts beyond 47 jobs and #236", async () => {
  const page = await open(390, 844, "reduce");
  try {
    const text = await page.locator("#sceneD").evaluate((node) => [node.textContent ?? "", ...[...node.querySelectorAll("[aria-label], [title]")].map((el) => `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`)].join(" "));
    expect(text.replace(/\s+/g, " ")).toContain("47 jobs in rehearsal, not run yet");
    expect(text).toContain("no result yet");
    expect(text).not.toContain("%");
    expect([...new Set([...text.matchAll(/\d+/g)].map((m) => m[0]))].sort()).toEqual(["236", "47"]);
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
type Pt = { x: number; y: number };
/** True when any segment of polyline a touches any segment of b: proper crossings, a touch at a vertex, and collinear overlap. */
function crosses(a: Pt[], b: Pt[]): boolean {
  const EPS = 1e-9;
  const side = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const sign = (v: number) => (v > EPS ? 1 : v < -EPS ? -1 : 0);
  const onSegment = (p: Pt, q: Pt, r: Pt) => Math.min(p.x, q.x) - EPS <= r.x && r.x <= Math.max(p.x, q.x) + EPS && Math.min(p.y, q.y) - EPS <= r.y && r.y <= Math.max(p.y, q.y) + EPS;
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) {
    const p1 = a[i - 1], p2 = a[i], q1 = b[j - 1], q2 = b[j];
    if (!p1 || !p2 || !q1 || !q2) continue;
    const d1 = sign(side(q1, q2, p1)), d2 = sign(side(q1, q2, p2)), d3 = sign(side(p1, p2, q1)), d4 = sign(side(p1, p2, q2));
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    if ((d1 === 0 && onSegment(q1, q2, p1)) || (d2 === 0 && onSegment(q1, q2, p2)) || (d3 === 0 && onSegment(p1, p2, q1)) || (d4 === 0 && onSegment(p1, p2, q2))) return true;
  }
  return false;
}

test("[unit] crosses() catches a proper crossing, a touch at a sampled vertex and a collinear overlap; parallel lines pass", () => {
  const line = (...xy: number[]): Pt[] => { const out: Pt[] = []; for (let i = 0; i + 1 < xy.length; i += 2) out.push({ x: xy[i] ?? 0, y: xy[i + 1] ?? 0 }); return out; };
  expect(crosses(line(0, 0, 10, 10), line(0, 10, 10, 0))).toBe(true);
  expect(crosses(line(0, 0, 5, 5, 10, 0), line(5, 5, 5, 10))).toBe(true);
  expect(crosses(line(0, 0, 10, 0), line(5, 0, 15, 0))).toBe(true);
  expect(crosses(line(0, 0, 10, 0), line(0, 1, 10, 1))).toBe(false);
});

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

// ---------- Second pass (#238 roast): whose week, trust line, annotated command, cap hits, router walk, tap targets ----------

const WHOSE = "One builder's real week (16 Oct 2026). Run it to see yours.";
const TRUST = "Runs on your machine. Nothing sent until you press Share.";
const VIEWS = [[390, 844], [1440, 900]] as const;

for (const motion of MOTIONS) {
  test(`[integration] the first screen says whose week it is before any figure (${motion})`, async () => {
    for (const [width, height] of VIEWS) {
      const page = await open(width, height, motion);
      try {
        await scrollShare(page, 0);
        const seen = await page.evaluate((whose) => {
          const opacity = (el: Element): number => { let o = 1; for (let n: Element | null = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
          const ticketTop = document.getElementById("ticket")?.getBoundingClientRect().top ?? innerHeight;
          const onScreen = (el: Element, min: number): DOMRect | null => {
            const r = el.getBoundingClientRect();
            const shown = el.checkVisibility({ visibilityProperty: true }) && opacity(el) >= min && r.width > 0 && r.height > 0;
            return shown && r.top >= 0 && r.bottom <= Math.min(innerHeight, ticketTop) && r.left >= 0 && r.right <= innerWidth ? r : null;
          };
          const lines = [...document.querySelectorAll("#whose, .mq-whose")].filter((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim() === whose);
          const line = lines.map((el) => onScreen(el, .99)).find((r) => r !== null) ?? null;
          // Every figure the first screen shows at all (opacity over 5%) sits below the whose-week line.
          const figures = [...document.querySelectorAll("#num1, #num2, #num3, .pic b, .fields dd, #lnk")]
            .map((el) => ({ text: el.textContent ?? "", r: onScreen(el, .05) }))
            .filter((f) => f.r !== null);
          const whoseEl = document.getElementById("whose");
          const out = document.getElementById("out");
          return {
            copies: lines.length,
            line: line ? { top: line.top, bottom: line.bottom } : null,
            above: figures.filter((f) => line === null || (f.r?.top ?? 0) < line.bottom).map((f) => f.text),
            firstInSource: !!whoseEl && !!out && (whoseEl.compareDocumentPosition(out) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          };
        }, WHOSE);
        expect(seen.copies).toBeGreaterThan(0);
        expect(seen.line).not.toBeNull();
        expect(seen.above).toEqual([]);
        expect(seen.firstInSource).toBe(true);
      } finally { await close(page); }
    }
  }, 30000);

  test(`[integration] the trust line is on screen and uncovered at 390 and 1440, all through the scroll (${motion})`, async () => {
    for (const [width, height] of VIEWS) {
      const page = await open(width, height, motion);
      try {
        for (const share of [0, .5, 1]) {
          await scrollShare(page, share);
          const trust = await page.locator("#trust").evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
              text: (el.textContent ?? "").trim(),
              visible: el.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
              inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.height > 0,
              uncovered: hit === el || el.contains(hit),
              px: parseFloat(getComputedStyle(el).fontSize),
            };
          });
          expect(trust).toEqual({ text: TRUST, visible: true, inView: true, uncovered: true, px: trust.px });
          expect(trust.px).toBeGreaterThanOrEqual(13);
        }
      } finally { await close(page); }
    }
  }, 30000);
}

test("[integration] the command is annotated before Copy: three underlined parts, each tied to its note, the script linked", async () => {
  const page = await open(390, 844, "no-preference");
  try {
    expect(await page.locator("#cmd").textContent()).toBe(COMMAND);
    const parts = await page.locator("#cmd .tok").evaluateAll((toks) => toks.map((tok) => {
      const note = document.getElementById(tok.getAttribute("aria-describedby") ?? "");
      const link = note?.closest("a") ?? note?.querySelector("a") ?? null;
      return {
        part: tok.textContent,
        note: note?.textContent?.trim() ?? null,
        href: link?.getAttribute("href") ?? null,
        underlined: getComputedStyle(tok).textDecorationLine.includes("underline"),
        beforeCopy: !!note && !!document.getElementById("copy") && (note.compareDocumentPosition(document.getElementById("copy") ?? note) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      };
    }));
    expect(parts).toEqual([
      { part: "curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts", note: "the script, readable", href: "/tm/map.ts", underlined: true, beforeCopy: true },
      { part: "bun run -", note: "runs on your machine", href: null, underlined: true, beforeCopy: true },
      { part: "--share", note: "a link you choose to press", href: null, underlined: true, beforeCopy: true },
    ]);
    // The linked script is served from the same origin.
    expect((await page.request.get(`http://127.0.0.1:${server.port}/tm/map.ts`)).status()).toBe(200);
    // At 390 the FULL command is visible: no clipping, no ellipsis, no fade mask, every glyph box on screen and uncovered.
    const fit = await page.locator("#cmdText").evaluate((code) => {
      const s = getComputedStyle(code);
      const box = code.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("cmd") ?? code);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      const covered = rects.filter((r) => {
        const hit = document.elementFromPoint(r.left + Math.min(4, r.width / 2), r.top + r.height / 2);
        return !(hit && code.contains(hit));
      }).length;
      return {
        overflow: code.scrollWidth > code.clientWidth + 1 || code.scrollHeight > code.clientHeight + 1,
        ellipsis: s.textOverflow === "ellipsis",
        masked: s.maskImage !== "none" || s.getPropertyValue("-webkit-mask-image") !== "none" && s.getPropertyValue("-webkit-mask-image") !== "",
        offscreen: rects.filter((r) => r.left < box.left - 1 || r.right > box.right + 1 || r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight).length,
        covered,
        lines: new Set(rects.map((r) => Math.round(r.top))).size,
      };
    });
    expect(fit).toEqual({ overflow: false, ellipsis: false, masked: false, offscreen: 0, covered: 0, lines: fit.lines });
    expect(fit.lines).toBeGreaterThan(1);
  } finally { await close(page); }
}, 30000);

test("[integration] one name for the cap event: cap hits, never cap episodes; the curtain parts sideways and never covers a figure", async () => {
  const reduced = await open(1440, 900, "reduce");
  try {
    const all = await reduced.evaluate(() => [document.documentElement.textContent ?? "", ...[...document.querySelectorAll("*")].flatMap((el) => ["title", "aria-label", "alt", "content"].map((a) => el.getAttribute(a) ?? ""))].join(" "));
    expect(all).not.toMatch(/cap episode/i);
    expect((await reduced.locator("#pic1 p").textContent())?.replace(/\s+/g, " ").trim()).toBe("2 cap hits, Wed 14 Oct 16:20 UTC");
    expect(await reduced.locator(".fields dt").allTextContents()).toContain("Cap hits");
  } finally { await close(reduced); }
  for (const file of ["index.html", "tm.css", "tm.js"]) expect(readFileSync(join(SITE, "tm", file), "utf8")).not.toMatch(/cap episode/i);

  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "no-preference");
    try {
      for (const share of [0, .1, .3, .5, .65, 1]) {
        await scrollShare(page, share);
        const clash = await page.evaluate((at) => {
          const opacity = (el: Element): number => { let o = 1; for (let n: Element | null = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
          const halves = [...document.querySelectorAll(".curtain .half")];
          const moves = halves.map((h) => { const m = new DOMMatrix(getComputedStyle(h).transform); return m.b === 0 && m.c === 0 && m.a === 1 && m.d === 1 && m.f === 0; });
          const boxes = halves.map((h) => h.getBoundingClientRect());
          const hits: string[] = [];
          // Every figure the scroll has revealed (opacity over 5%) must sit clear of both curtain halves.
          for (const el of document.querySelectorAll("#num1, #num2, #num3, .pic b, .pic p, .fields dd, #lnk, .walk, .poster")) {
            if (!el.checkVisibility({ visibilityProperty: true }) || opacity(el) < .05) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 1 || r.height <= 1) continue;
            if (boxes.some((b) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top)) hits.push(`${at}: ${(el.textContent ?? "").trim().slice(0, 30)}`);
          }
          return { sideways: moves.every(Boolean), hits };
        }, `${width}@${share}`);
        expect(clash).toEqual({ sideways: true, hits: [] });
      }
    } finally { await close(page); }
  }
}, 60000);

test("[integration] the router card walks one example ruled job and one unmatched job, labelled as an example, with no router result anywhere", async () => {
  for (const motion of MOTIONS) {
    const page = await open(390, 844, motion);
    try {
      if (motion === "no-preference") await scrollShare(page, 1);
      const card = await page.locator("#sceneD").evaluate((scene) => {
        const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
        const ruled = scene.querySelector(".walk.ruled");
        const unmatched = scene.querySelector(".walk.unmatched");
        const path = ruled?.querySelector(".path") ?? null;
        return {
          all: text(scene),
          ruledJob: text(ruled?.querySelector(".job") ?? null),
          ruledRule: text(ruled?.querySelector(".rule") ?? null),
          yoursOnDashedLine: !!path?.querySelector(".yours") && getComputedStyle(path, "::before").borderTopStyle + getComputedStyle(path, "::before").borderLeftStyle,
          ruledDoor: text(ruled?.querySelector(".door") ?? null),
          openJob: text(unmatched?.querySelector(".job") ?? null),
          openRule: text(unmatched?.querySelector(".rule") ?? null),
          openDoor: text(unmatched?.querySelector(".door") ?? null),
          jev: text(scene.querySelector("#jevdef")),
          example: text(scene.querySelector("#router .eg")),
        };
      });
      // No source holds the jobs, the rule or the count 47 (site/tm/index.html, Scene D sources), so the card says example.
      expect(card.example).toBe("Example jobs, rule and count");
      expect(card.ruledJob).toBe("Job Implement a feature in a client app");
      expect(card.ruledRule).toBe("Example rule R-PRO matches \\bimplement(s|ed|ing|ation)?\\b, seat pro_ok");
      expect(String(card.yoursOnDashedLine)).toContain("dashed");
      expect(card.ruledDoor).toBe("Door Claude, ChatGPT or Codex window");
      expect(card.openJob).toBe("Job Pick up the next ticket");
      expect(card.openRule).toBe("No rule matches: abstain");
      expect(card.openDoor).toBe("Door Jev in rehearsal, 47 jobs (example), not run yet");
      expect(card.jev).toBe("Jev picks from a fixed list of answers, fast and cheap");
      expect(card.all).not.toMatch(/route most|most jobs|%/i);
      expect([...new Set([...card.all.matchAll(/\d+/g)].map((m) => m[0]))].sort()).toEqual(["236", "47"]);
    } finally { await close(page); }
  }
}, 30000);

for (const motion of MOTIONS) {
  test(`[integration] every button and link is at least 24x24 px with text at least 13 px (${motion})`, async () => {
    for (const [width, height] of VIEWS) {
      const page = await open(width, height, motion);
      try {
        let checked = 0;
        for (const share of motion === "reduce" ? [0] : [0, .3, .65, 1]) {
          await scrollShare(page, share);
          const res = await page.evaluate(() => {
            const opacity = (el: Element): number => { let o = 1; for (let n: Element | null = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
            const bad: string[] = [];
            let n = 0;
            for (const el of document.querySelectorAll("a[href], button")) {
              if (!el.checkVisibility({ visibilityProperty: true }) || opacity(el) < .05) continue;
              n += 1;
              const r = el.getBoundingClientRect();
              const px = parseFloat(getComputedStyle(el).fontSize);
              if (r.width < 24 || r.height < 24 || px < 13) bad.push(`${(el.textContent ?? "").trim()} ${r.width.toFixed(0)}x${r.height.toFixed(0)} ${px}px`);
            }
            return { bad, n };
          });
          expect(res.bad).toEqual([]);
          checked += res.n;
        }
        // Copy and the script link are always on screen; reduced motion also shows the card and the maps link.
        expect(checked).toBeGreaterThanOrEqual(motion === "reduce" ? 4 : 8);
      } finally { await close(page); }
    }
  }, 60000);
}

// ---------- PR #241 review batch ----------

/** Every scene's text that is hidden or transparent, the motion class and both walks' progress. */
async function staticState(page: Page): Promise<{ motion: boolean; hidden: string[]; walks: string[]; typed: string | null | undefined }> {
  return page.evaluate(() => {
    const hidden: string[] = [];
    const opaque = (el: Element | null): boolean => {
      for (let n = el; n; n = n.parentElement) if (parseFloat(getComputedStyle(n).opacity) < 1) return false;
      return true;
    };
    const walk = document.createTreeWalker(document.querySelector("#track") ?? document.body, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (!text || !el || el.closest(".curtain, .sur, .key")) continue;
      if (!el.checkVisibility({ visibilityProperty: true }) || !opaque(el)) hidden.push(text);
    }
    return {
      motion: document.documentElement.classList.contains("motion"),
      hidden,
      walks: [...document.querySelectorAll(".walk")].map((w) => getComputedStyle(w).getPropertyValue("--t").trim()),
      typed: document.getElementById("typed")?.textContent,
    };
  });
}

test("[integration] if tm.js does not load, the page falls back to the static layout with every scene shown", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  try {
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.endsWith("/tm/tm.js")) return route.abort();
      return url.startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort();
    });
    await page.goto(`http://127.0.0.1:${server.port}/tm/`, { waitUntil: "load" });
    // Past the .15 s and .25 s opacity transitions the static layout starts from.
    await page.waitForTimeout(600);
    const state = await staticState(page);
    expect(state.motion).toBe(false);
    expect(state.hidden).toEqual([]);
    expect(state.typed).toBe(COMMAND);
  } finally { await context.close(); }
}, 30000);

test("[integration] turning reduced motion on while the page is open switches to the static end state", async () => {
  const page = await open(1440, 900, "no-preference");
  try {
    await scrollShare(page, .3);
    expect((await staticState(page)).motion).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
    const state = await staticState(page);
    expect(state.motion).toBe(false);
    expect(state.hidden).toEqual([]);
    expect(state.walks).toEqual(["1", "1"]);
    expect(state.typed).toBe(COMMAND);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  } finally { await close(page); }
}, 30000);

test("[integration] in motion mode the keyboard reaches /maps/ and this week's card from the top, and the focused link is on screen", async () => {
  const page = await open(390, 844, "no-preference");
  try {
    await scrollShare(page, 0);
    const reached: { href: string; inView: boolean }[] = [];
    // Four Tabs from the top, before focus could wrap round to the start again.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!(el instanceof HTMLAnchorElement)) return null;
        const r = el.getBoundingClientRect();
        return { href: el.getAttribute("href") ?? "", inView: r.width >= 24 && r.height >= 24 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth };
      });
      if (focused) reached.push(focused);
    }
    expect(reached.filter((f) => f.href === "/maps/").map((f) => f.inView)).toEqual([true]);
    expect(reached.filter((f) => f.href === shareLink(REAL)).map((f) => f.inView)).toEqual([true]);
  } finally { await close(page); }
}, 30000);

test("[integration] in the stacked layout a focused link scrolls clear of the fixed ticket", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "reduce");
    try {
      for (const id of ["openCard", "seeMaps"]) {
        await scrollShare(page, 0);
        await page.locator(`#${id}`).focus();
        const box = await page.evaluate((target) => {
          const r = document.getElementById(target)?.getBoundingClientRect();
          const ticket = document.getElementById("ticket")?.getBoundingClientRect();
          return r && ticket ? { bottom: r.bottom, ticketTop: ticket.top } : null;
        }, id);
        expect({ width, id, clear: box !== null && box.bottom <= box.ticketTop }).toEqual({ width, id, clear: true });
      }
    } finally { await close(page); }
  }
}, 30000);
