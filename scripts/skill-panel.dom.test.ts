import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import { bannedHits } from "./uat/tm-the-run-check.ts";

// The tokenmax-map skill surfaced on the home page and on /tm/ (operator request 2026-10-23): a two-half block, the
// skill on the left (what it does, Copy the install prompt, the folder on GitHub) and, on the right, one real
// self-reported week from the public board (shared with permission) printing row by row. On /tm/ the long Submit consent paragraph becomes a "What does Submit send?" disclosure
// with the same words, and the skill block sits where that paragraph sat, above "Rules first, Jev for the rest".

const SITE = join(import.meta.dir, "..", "site");
const VIEWS: readonly (readonly [number, number])[] = [[390, 844], [1440, 900]];
const MOTIONS: ("no-preference" | "reduce")[] = ["no-preference", "reduce"];
const PAGES = ["/", "/tm/"] as const;
const SKILL_URL = "https://github.com/breakoutwithai/jevnotjev/tree/main/skills/tokenmax-map";
// Operator correction 2026-10-23: the skill serves Claude Code and Codex from one canonical folder with a link per tool.
const INSTALL = `Install the tokenmax-map skill from ${SKILL_URL}: copy the folder to ~/.agents/skills/tokenmax-map, then link it into ~/.claude/skills/tokenmax-map for Claude Code and ~/.codex/skills/tokenmax-map for Codex (create a link only where that tool's folder exists). Then run a TokenMax audit of my last 8 weeks for both Claude Code and Codex and show me the private report.`;
// The paragraph that sat under Show my week / Show Sample / Submit before this change, word for word.
const CONSENT = "Pressing Submit sends the numbers from your result and your nickname to this site: days covered; sources (Claude, Codex or both, taken from which of your session counts are above 0); total sessions; subagent sessions (always 0); short cap hits (0), weekly cap hits (0), and unknown cap hits (your usage limit hits); Claude output tokens and Codex output tokens; Opus share of Claude output; Codex weekly window used; the format name tm-share/1; mapper version 0.0.0, which marks a pasted block; and a random request key that lets a repeat press be recognised. They appear on the public board at /maps/, shown as self-reported and not verified. Nothing is sent until you press Submit. Pressing Submit again on this page never adds a second row for the same result and nickname; after reloading or closing the page, pressing Submit sends a new key and can add a second row. This page keeps the delete key and retry key only in its own memory, not in browser storage. They are gone when the page is closed or reloaded.";
// The private report the skill writes (renderPrivate), for what the sample panel says it leaves out.
// The real week shown in the sample panel: one public board row, kept with its source URL and capture time (AGENTS.md:13).
type SampleRow = { id: string; alias: string; day: string; days: number; sources: string; sessions: number; caps: { short: number; weekly: number; unknown: number }; output_tokens: { claude: number; codex: number }; opus_share_pct: number; codex_weekly_pct: number };
const SAMPLE: { source: string; captured_at: string; row: SampleRow } = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "skill-sample-kingkong-23.json"), "utf8"));
const MAP_TS = readFileSync(join(import.meta.dir, "..", "skills", "tokenmax-map", "scripts", "map.ts"), "utf8");

const read = (rel: string): string => readFileSync(join(SITE, rel), "utf8");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === "/api/tickets/ranking") return Response.json({ ids: [], counts: {} });
    const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

async function open(path: string, width: number, height: number, motion: "no-preference" | "reduce"): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: "load" });
  return page;
}
async function close(page: Page): Promise<void> { await page.context().close(); }

test("[unit] SK-1 the home page carries the skill block directly after the week hero and before the example week", () => {
  const html = read("index.html");
  const week = html.indexOf('<section class="entry" id="week"');
  const skill = html.indexOf('<section class="skillbill" id="skill"');
  const payoff = html.indexOf('<section class="payoff" id="payoff"');
  expect({ week: week > 0, order: week < skill && skill < payoff }).toEqual({ week: true, order: true });
  // Nothing else sits between the hero's end and the skill block, or between the skill block and the payoff.
  expect(html.slice(html.lastIndexOf("</section>", skill), skill).trim()).toBe("</section>");
  expect(html.slice(html.lastIndexOf("</section>", payoff), payoff).trim()).toBe("</section>");
});

// The site flow never shows a run command (operator rule): no curl, no bun, no terminal, inside the block or its files.
const RUN_WORDS = /\bcurl\b|\bbun\b|terminal|\bnpx\b|\bnpm\b/i;
const skillBlock = (html: string): string => /<section class="skillbill" id="skill"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
test("[unit] SK-2 no curl one-liner, no bun run and no terminal wording on either page or in the block's own files", () => {
  for (const rel of ["index.html", "tm/index.html"]) {
    const html = read(rel);
    expect({ rel, curl: /\bcurl\b/i.test(html), pipe: /\|\s*bun\b/.test(html) }).toEqual({ rel, curl: false, pipe: false });
    const block = skillBlock(html);
    expect(block.length).toBeGreaterThan(1000);
    expect({ rel, run: RUN_WORDS.exec(block)?.[0] ?? null }).toEqual({ rel, run: null });
  }
  for (const rel of ["skill-panel.js", "skill-panel.css"]) expect({ rel, run: RUN_WORDS.exec(read(rel))?.[0] ?? null }).toEqual({ rel, run: null });
  expect(RUN_WORDS.exec(INSTALL)).toBeNull();
  // The checker fails planted run wording.
  for (const planted of ["Open your terminal and run bun run map", "curl -fsSL x", "npx tokenmax"]) expect(RUN_WORDS.test(planted)).toBe(true);
});

test("[unit] SK-3 the sample is the recorded board row: every shown figure comes from the fixture, labelled as a real self-reported week", () => {
  const { source, captured_at: captured, row } = SAMPLE;
  expect(source).toBe("https://jevnotjev.breakoutwithai.com/api/maps");
  expect(captured).toMatch(/^2026-10-23T/);
  const n = (v: number): string => v.toLocaleString("en-US");
  const limitHits = row.caps.short + row.caps.weekly + row.caps.unknown;
  const shown = [
    `public board row ${row.id}`, `${row.alias}'s week`, `${row.days} days, shared ${row.day}. Sources: Claude Code and Codex.`,
    `<dt>Sessions</dt><dd>${n(row.sessions)}</dd>`, `<dt>Claude output tokens</dt><dd>${n(row.output_tokens.claude)}</dd>`,
    `<dt>Codex output tokens</dt><dd>${n(row.output_tokens.codex)}</dd>`, `<dt>Usage limit hits</dt><dd>${n(limitHits)}</dd>`,
    `<th scope="row">Claude Code and Codex</th><td>${row.caps.short}</td><td>${row.caps.weekly}</td><td>${row.caps.unknown}</td>`, "<th scope=\"col\">Unknown window</th>",
    `<span>Codex weekly window used</span><b>${row.codex_weekly_pct}%</b><i style="--v:${row.codex_weekly_pct}">`,
    `<span>Opus share of Claude output</span><b>${row.opus_share_pct}%</b><i style="--v:${row.opus_share_pct}">`,
    "A real week from an outside user (kingkong-23), self-reported, shared with permission",
    "Not in this map: subagent sessions, the split by model and the proposals.",
  ];
  expect(row.sources).toBe("claude+codex");
  // The consented row (kingkong-23), not its duplicate TM-0BDC6129175D and not kingkong, who gave no permission.
  expect([row.id, row.alias]).toEqual(["TM-7460C713BC39", "kingkong-23"]);
  for (const rel of ["index.html", "tm/index.html"]) {
    const block = skillBlock(read(rel));
    for (const text of shown) expect({ rel, text, has: block.includes(text) }).toEqual({ rel, text, has: true });
    // Every figure in the sheet is one the row carries: no invented or averaged value is left.
    const figures = [...block.matchAll(/<(?:dd|td|b)>([^<]+)<\/(?:dd|td|b)>/g)].map((m) => m[1] ?? "");
    const allowed = new Set([n(row.sessions), n(row.output_tokens.claude), n(row.output_tokens.codex), n(limitHits), String(row.caps.short), String(row.caps.weekly), String(row.caps.unknown), `${row.codex_weekly_pct}%`, `${row.opus_share_pct}%`]);
    expect({ rel, stray: figures.filter((v) => !allowed.has(v)) }).toEqual({ rel, stray: [] });
    expect({ rel, invented: /invented|EXAMPLE/.test(block), private: block.includes("private-report.md") }).toEqual({ rel, invented: false, private: false });
    expect({ rel, link: block.includes(`href="${SKILL_URL}"`) }).toEqual({ rel, link: true });
    // Claude Code and Codex both, never one tool alone.
    expect({ rel, oneTool: /run by Claude Code on|into Claude Code:|Claude Code skills folder/.test(block) }).toEqual({ rel, oneTool: false });
  }
});

test("[unit] SK-3b the private report the skill writes does carry what the sample leaves out (split by model, proposals)", () => {
  for (const heading of ["## Claude Code usage", "| Model | Messages | Input | Output |", "## Proposals (not measured savings)"]) expect(MAP_TS).toContain(heading);
});

test("[integration] SK-9 /tm/ without tm.js the consent text shows in place and the control stays hidden", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.endsWith("/tm/tm.js")) return route.abort();
      return url.startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort();
    });
    await page.goto(`http://127.0.0.1:${server.port}/tm/`, { waitUntil: "load" });
    expect(await page.locator("#submitConsent").isVisible()).toBe(true);
    expect(await page.locator("#consentTip").isVisible()).toBe(false);
  } finally { await context.close(); }
});

test("[unit] SK-4 /tm/: the Submit disclosure holds the old paragraph word for word, and the skill block sits after the form and before Rules first", () => {
  const html = read("tm/index.html");
  const consent = /<p class="hint" id="submitConsent">([^<]+)<\/p>/.exec(html)?.[1] ?? "";
  expect(consent).toBe(CONSENT);
  const submit = html.indexOf('id="submitWeek"'), skill = html.indexOf('id="skill"'), scene = html.indexOf('id="sceneD"');
  expect(submit > 0 && submit < skill && skill < scene).toBe(true);
});

for (const path of PAGES) test(`[integration] SK-5 ${path} Copy the install prompt copies the exact prompt and says Copied`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(path, width, height, "reduce");
    try {
      const btn = page.locator("#skillCopy");
      expect(await btn.innerText()).toBe("Copy the install prompt");
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(INSTALL);
      await page.waitForFunction(() => (document.getElementById("skillCopy")?.textContent ?? "") === "Copied");
      expect(await page.locator("#skillCopyMsg").innerText()).toContain("Copied");
      expect(await page.locator("#skillPrompt").innerText()).toBe(INSTALL);
      expect(bannedHits(INSTALL)).toEqual([]);
    } finally { await close(page); }
  }
}, 40000);

for (const path of PAGES) test(`[integration] SK-6 ${path} reduced motion shows the finished report; motion builds it line by line`, async () => {
  for (const motion of MOTIONS) for (const [width, height] of VIEWS) {
    const page = await open(path, width, height, motion);
    try {
      const rows = page.locator("#skillOut .sk-row");
      const count = await rows.count();
      expect(count).toBeGreaterThanOrEqual(6);
      if (motion === "reduce") {
        expect(await page.locator("#skillOut").getAttribute("data-state")).toBe("done");
      } else {
        // Before it is in view, the report waits at its first frame.
        expect(await page.locator("#skillOut").getAttribute("data-state")).toBe("ready");
        await page.locator("#skillOut").scrollIntoViewIfNeeded();
        // Mid-print: some rows shown, some still waiting, while playing.
        await page.waitForFunction(() => {
          const out = document.getElementById("skillOut"), all = out?.querySelectorAll(".sk-row").length ?? 0, on = out?.querySelectorAll(".sk-row.on").length ?? 0;
          return out?.getAttribute("data-state") === "playing" && on > 0 && on < all;
        }, undefined, { timeout: 10000 });
        await page.waitForFunction(() => document.getElementById("skillOut")?.getAttribute("data-state") === "done", undefined, { timeout: 15000 });
      }
      const shown = await rows.evaluateAll((els) => els.map((e) => Number(getComputedStyle(e).opacity)));
      expect({ motion, width, shown: shown.every((o) => o === 1) }).toEqual({ motion, width, shown: true });
      const widths = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
      expect({ width, widths }).toEqual({ width, widths: Math.min(widths, width) });
    } finally { await close(page); }
  }
}, 90000);

for (const [width, height] of VIEWS) test(`[integration] SK-7 the skill half comes first and the halves sit side by side only on a wide screen (${width})`, async () => {
  for (const path of PAGES) {
    const page = await open(path, width, height, "reduce");
    try {
      const box = await page.evaluate(() => {
        const a = document.querySelector("#skill .sk-skill")?.getBoundingClientRect(), b = document.getElementById("skillOut")?.getBoundingClientRect();
        return a && b ? { aTop: a.top, aLeft: a.left, bTop: b.top, bLeft: b.left, aBottom: a.bottom } : null;
      });
      if (!box) throw new Error("block missing");
      if (width >= 900) expect({ path, sideBySide: box.aLeft < box.bLeft && Math.abs(box.aTop - box.bTop) < 80 }).toEqual({ path, sideBySide: true });
      else expect({ path, stacked: box.bTop >= box.aBottom - 1 }).toEqual({ path, stacked: true });
    } finally { await close(page); }
  }
}, 40000);

test("[integration] SK-8 /tm/ What does Submit send? opens on focus, on click and on hover, Escape closes it, and Submit stays described by it", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open("/tm/", width, height, "reduce");
    try {
      const tip = page.locator("#consentTip"), text = page.locator("#submitConsent");
      expect(await tip.innerText()).toBe("What does Submit send?");
      expect(await tip.getAttribute("aria-controls")).toBe("submitConsent");
      expect(await page.locator("#submitWeek").getAttribute("aria-describedby")).toBe("submitConsent");
      expect(await text.isVisible()).toBe(false);
      expect(await tip.getAttribute("aria-expanded")).toBe("false");
      expect(await text.textContent()).toBe(CONSENT);
      // Keyboard focus
      await tip.focus();
      expect(await text.isVisible()).toBe(true);
      expect(await tip.getAttribute("aria-expanded")).toBe("true");
      // The pointer passing over and away does not close it while the control keeps keyboard focus.
      await tip.hover();
      await page.locator("#hCmd").hover();
      await page.waitForTimeout(300);
      expect(await text.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      expect(await text.isVisible()).toBe(false);
      expect(await tip.getAttribute("aria-expanded")).toBe("false");
      // Click (a tap on a phone): opens and stays open, a second click closes
      await page.locator("#showSample").focus();
      await tip.click();
      expect(await text.isVisible()).toBe(true);
      await tip.click();
      expect(await text.isVisible()).toBe(false);
      // Hover: the pointer leaves the control first, so entering it is a fresh hover
      await page.locator("#showSample").focus();
      await page.locator("#hCmd").hover();
      await tip.hover();
      expect(await text.isVisible()).toBe(true);
      await page.locator("#hCmd").hover();
      await page.waitForFunction(() => getComputedStyle(document.getElementById("submitConsent") ?? document.body).display === "none");
      const widths = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
      expect({ width, widths }).toEqual({ width, widths: Math.min(widths, width) });
    } finally { await close(page); }
  }
}, 40000);

for (const [width, height] of [[900, 900], [1024, 768], [1200, 900], [1440, 900]] as const) test(`[integration] SK-10 every sample figure stays inside its cell at ${width}`, async () => {
  for (const path of PAGES) {
    const page = await open(path, width, height, "reduce");
    try {
      const spill = await page.evaluate(() => [...document.querySelectorAll("#skillOut .sk-stats dd, #skillOut .sk-stats dt")].flatMap((el) => {
        const range = document.createRange(); range.selectNodeContents(el);
        // Inside the cell's padding, not just its border.
        const host = el.parentElement ?? el, text = range.getBoundingClientRect(), cell = host.getBoundingClientRect(), pad = getComputedStyle(host);
        const right = cell.right - parseFloat(pad.paddingRight) - parseFloat(pad.borderRightWidth), left = cell.left + parseFloat(pad.paddingLeft) + parseFloat(pad.borderLeftWidth);
        return text.right > right + 0.5 || text.left < left - 0.5 ? [el.textContent ?? ""] : [];
      }));
      expect({ path, spill }).toEqual({ path, spill: [] });
    } finally { await close(page); }
  }
}, 30000);
