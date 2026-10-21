import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import { bundleTm, TM_OUT } from "./build-tm.ts";
import { BANNED_ANYWHERE, jargonHits, PROMPT } from "./uat/tm-the-run-check.ts";
import { shareLink, type SharePayload } from "../skills/tokenmax-map/scripts/map.ts";

// /tm/ "The Run": a plain front panel, the click-through TokenMax show, then Share my week (#command: one prompt for the
// Claude Code or Codex the visitor already uses), the share card (#sceneB) and the router card (#sceneD). Served from
// site/ by Bun.serve; every off-origin request is blocked. Issue #309 criterion 3: no jargon in the first viewport, no
// curl or terminal anywhere.

const SITE = join(import.meta.dir, "..", "site");
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
const VIEWS: readonly (readonly [number, number])[] = [[390, 844], [1440, 900]];
const TRUST = "Runs on your machine. Nothing sent until you press Share.";
// En and em dash, built from code points so no dash glyph sits in this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]|&[mn]dash;|\\\\u201[34]`);
const html = (): string => readFileSync(join(SITE, "tm", "index.html"), "utf8");

test("[unit] VP-6 the sample card link names the sample and marks its fragment", () => {
  const link = /<a class="open" id="openCard" href="([^"]+)">([^<]+)<\/a>/.exec(html());
  expect(link?.[1]).toMatch(/\/maps\/#m=[A-Za-z0-9_-]+&sample$/);
  expect(link?.[2]).toBe("Open a sample card");
});

test("[unit] VP-6 every linked map payload is marked as a sample", () => {
  const links = [...html().matchAll(/<a\b[^>]*href="([^"]*\/maps\/#m=[^"]+)"[^>]*>/g)].map((match) => match[1]);
  expect(links.length).toBeGreaterThan(0);
  for (const href of links) expect(href).toMatch(/&sample$/);
});

test("[unit] TM-1 the opening curtain scene and the terminal scene are gone; fonts are bundled, not fetched", () => {
  const page = html();
  for (const gone of ["curtain", "marquee", "sur", "halfL", "halfR", "sceneA", "term", "out", "pics"]) expect(page).not.toContain(`id="${gone}"`);
  expect(page).not.toMatch(/Scroll to open the show|Your Claude week, mapped|fonts\.googleapis|fonts\.gstatic/);
  const css = readFileSync(join(SITE, "tm", "tm.css"), "utf8");
  const fonts = [...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1] ?? "");
  expect(fonts.sort()).toEqual(["fonts/Alegreya-Italic.ttf", "fonts/Alegreya.ttf", "fonts/Archivo.ttf"]);
  for (const f of fonts) expect(existsSync(join(SITE, "tm", f))).toBe(true);
  expect(css).not.toMatch(/https?:\/\//);
  // #309: the command ticket is gone; no curl and no terminal wording in any shipped source of the page.
  for (const gone of ["cmd", "cmdText", "ticket", "tok1", "note1"]) expect(page).not.toContain(`id="${gone}"`);
  for (const file of [join(SITE, "tm", "index.html"), join(SITE, "tm", "tm.css"), join(SITE, "tm", "tm.js"), join(import.meta.dir, "..", "src", "browser", "tm-run.ts")]) {
    expect({ file, hit: BANNED_ANYWHERE.exec(readFileSync(file, "utf8"))?.[0] ?? null }).toEqual({ file, hit: null });
  }
});

test("[integration] TM-2 site/tm/tm.js is the current build of src/browser/tm-run.ts", async () => {
  expect(readFileSync(TM_OUT, "utf8")).toBe(await bundleTm());
});

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

async function open(width: number, height: number, motion: "no-preference" | "reduce", errors?: string[], hash = ""): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  if (errors) page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}/tm/${hash}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#run .poster").length === 7);
  return page;
}
async function close(page: Page): Promise<void> { await page.context().close(); }
async function scrollShare(page: Page, share: number): Promise<void> {
  await page.evaluate((s) => scrollTo(0, Math.round((document.documentElement.scrollHeight - innerHeight) * s)), share);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
}

for (const motion of MOTIONS) test(`[integration] TM-8 Share my week opens a prompt for Claude Code or Codex: it reads map.ts, says what it reads and sends, runs it locally, sends nothing itself (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    try {
      expect(await page.locator("#sharePrompt").isVisible()).toBe(false);
      await page.locator("#shareWeek").click();
      expect(await page.locator("#sharePrompt").isVisible()).toBe(true);
      const prompt = await page.locator("#sharePrompt").textContent();
      expect(prompt).toBe(PROMPT);
      expect(prompt).toContain("https://jevnotjev.breakoutwithai.com/tm/map.ts");
      for (const part of ["what it reads", "what it would send", "run it here", "Do not send or upload anything yourself"]) expect(prompt).toContain(part);
      expect(await page.locator("#promptBox .setup").innerText()).toContain("Claude Code or Codex");
      expect((await page.locator("#trust").innerText()).trim()).toBe(TRUST);
      expect(await page.locator("#trust").isVisible()).toBe(true);
    } finally { await close(page); }
  }
}, 30000);

for (const motion of MOTIONS) test(`[integration] TM-7 the first viewport, no scroll, says what you get, who it is for and not for, and that the router is not built, with no jargon-list word (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    try {
      const first = await page.evaluate(() => {
        const texts: string[] = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walk.nextNode(); node; node = walk.nextNode()) {
          const text = (node.textContent ?? "").trim();
          const el = node.parentElement;
          if (!text || !el || el.closest("script, style") || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          if ([...range.getClientRects()].some((r) => r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) texts.push(text);
        }
        const whole = (id: string): string => { const r = document.getElementById(id)?.getBoundingClientRect(); return r && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight ? (document.getElementById(id)?.textContent ?? "") : ""; };
        return { texts, lede: whole("lede"), audience: whole("audience"), notyet: whole("notyet"), share: whole("jumpCommand") };
      });
      expect({ width, hits: jargonHits(first.texts) }).toEqual({ width, hits: [] });
      expect(first.texts.length).toBeGreaterThan(5);
      expect(first.lede).toContain("share your own week");
      expect(first.audience).toMatch(/^For people who .+ Not for you if/);
      expect(first.notyet).toBe("The TokenMax router is being designed and does not work today. The weeks below are illustrative.");
      expect(first.share).toBe("Share my week");
      const anywhere = await page.evaluate(() => [document.documentElement.textContent ?? "", ...[...document.querySelectorAll("*")].flatMap((el) => ["title", "aria-label", "alt", "content", "href"].map((a) => el.getAttribute(a) ?? ""))].join(" "));
      expect(BANNED_ANYWHERE.exec(anywhere)?.[0] ?? null).toBeNull();
    } finally { await close(page); }
  }
}, 30000);

for (const motion of MOTIONS) {
  test(`[integration] no horizontal scroll at 390x844 at 0, 50 and 100% of the scroll, before and after a show (${motion})`, async () => {
    const errors: string[] = [];
    const page = await open(390, 844, motion, errors);
    try {
      for (const pick of [false, true]) {
        if (pick) { await scrollShare(page, 0); await page.locator(".pick-btn[data-mode=under]").click(); await page.waitForTimeout(400); }
        for (const share of [0, .5, 1]) {
          await scrollShare(page, share);
          const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
          expect(widths.doc).toBeLessThanOrEqual(390);
          expect(widths.body).toBeLessThanOrEqual(390);
        }
      }
      expect(errors).toEqual([]);
    } finally { await close(page); }
  }, 30000);

  test(`[integration] Copy copies the exact prompt; aria-live says Copied (${motion})`, async () => {
    for (const [width, height] of VIEWS) {
      const page = await open(width, height, motion);
      try {
        await page.locator("#shareWeek").click();
        expect(await page.locator("#sharePrompt").textContent()).toBe(PROMPT);
        const copy = page.getByRole("button", { name: "Copy" });
        await copy.scrollIntoViewIfNeeded();
        const box = await copy.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { onScreen: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, covered: hit === node || node.contains(hit) };
        });
        expect(box).toEqual({ onScreen: true, covered: true });
        expect(await page.locator("#copyMsg").getAttribute("aria-live")).toBe("polite");
        await copy.click();
        await page.waitForFunction(() => (document.getElementById("copyMsg")?.textContent ?? "").length > 0);
        expect(await page.locator("#copyMsg").textContent()).toBe("Copied. Paste it into Claude Code or Codex.");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
      } finally { await close(page); }
    }
  }, 30000);
}

test("[integration] Copy falls back to selecting the prompt with a keyboard hint when the clipboard refuses", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } });
      document.execCommand = () => false;
    });
    await page.goto(`http://127.0.0.1:${server.port}/tm/`, { waitUntil: "load" });
    await page.locator("#shareWeek").click();
    await page.getByRole("button", { name: "Copy" }).click();
    await page.waitForFunction(() => (document.getElementById("copyMsg")?.textContent ?? "").length > 0);
    expect(await page.locator("#copyMsg").textContent()).toMatch(/^The prompt is selected\. Press (Cmd|Ctrl)\+C to copy it\.$/);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(PROMPT);
  } finally { await page.close(); }
}, 30000);

test("[integration] TM-3 the visitor order: front panel, situation picker, stage, the three cards, Share my week, the share card, the shared maps", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "reduce");
    try {
      const order = await page.evaluate(() => ["#jumpCommand", "#lede", "#notyet", ".pick", "#stage", "#promptCard", "#review", "#command", "#shareWeek", "#trust", "#sceneB", "#openCard", "#sceneD", "#seeMaps"]
        .map((sel) => { const el = document.querySelector(sel); return { sel, top: el ? el.getBoundingClientRect().top + scrollY : -1 }; }));
      expect(order.every((o) => o.top >= 0)).toBe(true);
      // Cards sit side by side at 1440, so compare the sections that stack at every width.
      const stacked = order.filter((o) => !["#promptCard", "#review"].includes(o.sel)).map((o) => o.top);
      expect([...stacked].sort((a, b) => a - b)).toEqual(stacked);
      expect(await page.locator("#seeMaps").innerText()).toBe("See the shared maps");
      expect(await page.locator("#tokenmaxGuide").innerText()).toBe("Understand TokenMax and explore a recorded comparison");
      expect(await page.locator("#tokenmaxGuide").getAttribute("href")).toBe("/guide/#tokenmax");
      expect(await page.locator("#mapWeek").getAttribute("href")).toBe("#command");
    } finally { await close(page); }
  }
}, 30000);

for (const motion of MOTIONS) test(`[integration] TM-4 Share my week is the first Tab stop, visible at the top, and opens the prompt with focus on it (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    try {
      const skip = await page.locator("#jumpCommand").evaluate((el) => { const r = el.getBoundingClientRect(); return { text: el.textContent, onScreen: r.top >= 0 && r.bottom <= innerHeight && r.width >= 24 && r.height >= 24 }; });
      expect(skip).toEqual({ text: "Share my week", onScreen: true });
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("jumpCommand");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => { const d = document.getElementById("share"); return document.activeElement?.id === "command" && d instanceof HTMLDetailsElement && d.open; });
      expect(await page.locator("#sharePrompt").isVisible()).toBe(true);
      const at = await page.locator("#trust").evaluate((el, trust) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { text: (el.textContent ?? "").trim() === trust, inView: r.top >= 0 && r.bottom <= innerHeight, uncovered: hit === el || el.contains(hit), px: parseFloat(getComputedStyle(el).fontSize) >= 13 };
      }, TRUST);
      expect({ width, ...at }).toEqual({ width, text: true, inView: true, uncovered: true, px: true });
    } finally { await close(page); }
  }
}, 30000);

test("[integration] TM-5 reduced motion: picking a week and trying the prompt land on their end states at once, with nothing animating", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "reduce");
    try {
      await page.locator(".pick-btn[data-mode=burn]").click();
      const without = await page.evaluate(() => ({ drop: document.getElementById("drop")?.classList.contains("show-copy"), verdict: document.getElementById("verdict")?.textContent, skip: document.getElementById("skip")?.hidden, running: document.getAnimations().filter((a) => a.playState === "running").length }));
      expect(without).toEqual({ drop: true, verdict: "Walk out", skip: true, running: 0 });
      await page.locator("#dropBtn").click();
      const withTm = await page.evaluate(() => ({ settled: document.getElementById("stage")?.classList.contains("settled"), verdict: document.getElementById("verdict")?.textContent, badge: document.getElementById("gaugeBadge")?.textContent, running: document.getAnimations().filter((a) => a.playState === "running").length }));
      expect(withTm).toEqual({ settled: true, verdict: "Standing ovation", badge: "Lasted to Sunday", running: 0 });
    } finally { await close(page); }
  }
}, 30000);

test("[integration] TM-6 turning reduced motion on mid-show jumps to the end state", async () => {
  const page = await open(1440, 900, "no-preference");
  try {
    await page.locator(".pick-btn[data-mode=under]").click();
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.getElementById("ghost")?.classList.contains("on"))).toBe(false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.getElementById("ghost")?.classList.contains("on") === true, null, { timeout: 2000 });
    expect(await page.evaluate(() => ({ half: document.querySelectorAll(".poster.half").length, skip: document.getElementById("skip")?.hidden }))).toEqual({ half: 7, skip: true });
  } finally { await close(page); }
}, 30000);

test("[integration] the page and its sources carry no em or en dash and no home paths", async () => {
  const page = await open(1440, 900, "reduce", undefined, "#under-after");
  try {
    const text = await page.evaluate(() => document.documentElement.textContent ?? "");
    expect(text).not.toMatch(DASHES);
  } finally { await close(page); }
  const sources = [join(SITE, "tm", "index.html"), join(SITE, "tm", "tm.css"), join(SITE, "tm", "tm.js"), join(import.meta.dir, "..", "src", "browser", "tm-run.ts")];
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(DASHES);
    expect(src).not.toMatch(/\/Users\/|~\/|\.claude\//);
  }
}, 30000);

test("[integration] the share card links the real week's map as a sample; one link to /maps/", async () => {
  const page = await open(1440, 900, "reduce");
  try {
    expect(await page.locator("#openCard").getAttribute("href")).toBe(`${shareLink(REAL)}&sample`);
    expect(await page.locator("#openCard").innerText()).toBe("Open a sample card");
    expect(await page.locator("#sceneB").textContent()).toContain("One builder's real week, 16 Oct 2026");
    expect(await page.locator('a[href="/maps/"]').count()).toBe(1);
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
  test(`[integration] every visible text node renders at 11 px or more at 390, at rest and at both end states (${motion})`, async () => {
    for (const hash of ["", "#burn-before", "#under-after"]) {
      const page = await open(390, 844, motion, undefined, hash);
      try {
        await page.waitForTimeout(300);
        const small = await page.evaluate(() => {
          const found: string[] = [];
          const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walk.nextNode(); node; node = walk.nextNode()) {
            const text = (node.textContent ?? "").trim();
            const el = node.parentElement;
            if (!text || !el || el.closest("script, style") || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
            let px = parseFloat(getComputedStyle(el).fontSize);
            if (el instanceof SVGGraphicsElement) {
              const m = el.getScreenCTM();
              if (m) px *= Math.hypot(m.a, m.b);
            }
            if (px < 10.99) found.push(`${text.slice(0, 30)} ${px.toFixed(1)}px`);
          }
          return found;
        });
        expect({ hash, small }).toEqual({ hash, small: [] });
      } finally { await close(page); }
    }
  }, 60000);
}

test("[integration] one name for the cap event: cap hits, never cap episodes", async () => {
  const page = await open(1440, 900, "reduce");
  try {
    const all = await page.evaluate(() => [document.documentElement.textContent ?? "", ...[...document.querySelectorAll("*")].flatMap((el) => ["title", "aria-label", "alt", "content"].map((a) => el.getAttribute(a) ?? ""))].join(" "));
    expect(all).not.toMatch(/cap episode/i);
    expect(await page.locator(".fields dt").allTextContents()).toContain("Cap hits");
  } finally { await close(page); }
  for (const file of ["index.html", "tm.css", "tm.js"]) expect(readFileSync(join(SITE, "tm", file), "utf8")).not.toMatch(/cap episode/i);
}, 30000);

test("[integration] the router card walks one example ruled job and one unmatched job, labelled as an example, with no router result anywhere", async () => {
  const page = await open(390, 844, "reduce");
  try {
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
}, 30000);

for (const motion of MOTIONS) {
  test(`[integration] every visible button and link is at least 24x24 px with text at least 13 px (${motion})`, async () => {
    for (const [width, height] of VIEWS) {
      const page = await open(width, height, motion);
      try {
        let checked = 0;
        for (const pick of [false, true]) {
          if (pick) { await page.locator(".pick-btn[data-mode=burn]").click(); await page.locator("#replay").waitFor(); await page.locator("#shareWeek").click(); }
          const res = await page.evaluate(() => {
            const bad: string[] = [];
            let n = 0;
            for (const el of document.querySelectorAll("a[href], button, summary")) {
              if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
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
        // At rest: Share my week (link and summary), two picks, Try, the guide, the sample card, /maps/; then with the
        // show played and the prompt open, Replay, Try on the curtain, Copy and the rest again.
        expect(checked).toBeGreaterThanOrEqual(19);
      } finally { await close(page); }
    }
  }, 60000);
}

test("[integration] if tm.js does not load, the front panel, Share my week (it still opens), the share card and the maps link are still shown", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  try {
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.endsWith("/tm/tm.js")) return route.abort();
      return url.startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort();
    });
    await page.goto(`http://127.0.0.1:${server.port}/tm/`, { waitUntil: "load" });
    const hidden = await page.evaluate(() => {
      const out: string[] = [];
      for (const root of document.querySelectorAll(".front, #command, #sceneB, #sceneD")) {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walk.nextNode(); node; node = walk.nextNode()) {
          const text = (node.textContent ?? "").trim();
          const el = node.parentElement;
          // The prompt sits in a closed details until Share my week opens it, by design.
          if (!text || !el || el.id === "copyMsg" || el.closest("#promptBox")) continue;
          if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) out.push(text);
        }
      }
      return out;
    });
    expect(hidden).toEqual([]);
    await page.locator("#shareWeek").click();
    expect(await page.locator("#copy").isVisible()).toBe(true);
    expect(await page.locator("#sharePrompt").textContent()).toBe(PROMPT);
  } finally { await context.close(); }
}, 30000);

test("[integration] Tab from the top reaches Share my week, the prompt control, this week's card and /maps/, each on screen when focused", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "no-preference");
    try {
      const reached: { id: string; inView: boolean }[] = [];
      for (let i = 0; i < 30 && !reached.some((r) => r.id === "seeMaps"); i++) {
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => {
          const el = document.activeElement;
          if (!(el instanceof HTMLElement) || !el.id) return null;
          const r = el.getBoundingClientRect();
          return { id: el.id, inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth };
        });
        if (focused) reached.push(focused);
      }
      const want = ["jumpCommand", "shareWeek", "openCard", "seeMaps"];
      expect({ width, found: reached.filter((r) => want.includes(r.id)) }).toEqual({ width, found: want.map((id) => ({ id, inView: true })) });
    } finally { await close(page); }
  }
}, 30000);
