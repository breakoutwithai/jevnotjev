// The curtain opens onto the four-questions pictures (#260 first-visit clarity). These tests pin the reveal: no
// "Sample run" chip in the nav, the four pictures first after the curtain, then "One question..." and
// "Where does your week go?", no Pause button, motion that honours reduced motion and ends by
// itself within 5 seconds, and the four captions identical in both pages.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

const SITE = join(import.meta.dir, "..", "site");
const LANDING = join(SITE, "index.html");
const EXPLAINER = join(SITE, "explainer", "index.html");
const WIDTHS: [number, number][] = [[390, 844], [768, 1024], [1440, 900]];

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
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(file);
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

async function pageAt(width: number, height: number, motion: "no-preference" | "reduce", path = "/", fakeClock = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion });
  if (fakeClock) await page.clock.install();
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}

// The text of each poster caption, in order, read from the page source.
function captions(html: string): string[] {
  return [...html.matchAll(/<p class="p-cap">([^<]*)<\/p>/g)].map((m) => m[1] ?? "");
}

// What the four pictures show right now: the dial reading, the lit ticket, the ladder marker and the frame drawing.
const posterState = (page: Page): Promise<string> => page.evaluate(() => [
  document.getElementById("noul-read")?.textContent ?? "missing",
  document.getElementById("choice-read")?.textContent ?? "missing",
  document.getElementById("pin")?.style.transform ?? "missing",
  document.getElementById("box-frame")?.getAttribute("class") ?? "missing",
].join("|"));

for (const motion of ["no-preference", "reduce"] as const) {
  test(`[integration] R1 the house bar says no "Sample run" with the curtain closed or open; House lights stays (${motion})`, async () => {
    for (const [width, height] of WIDTHS) {
      const page = await pageAt(width, height, motion);
      try {
        await page.waitForFunction(() => document.documentElement.dataset.curtain !== undefined);
        const closed = await page.evaluate(() => ({
          house: document.querySelector("header.house")?.textContent ?? "",
          chip: document.getElementById("sampleBadge")?.textContent ?? "",
        }));
        expect({ width, house: /sample run/i.test(closed.house), chip: /sample run/i.test(closed.chip) }).toEqual({ width, house: false, chip: false });
        expect(await page.locator("#lights").count()).toBe(1);
        await page.evaluate(() => { window.location.hash = "types"; });
        await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
        const shown = await page.locator("header.house").innerText();
        expect({ width, open: /sample run/i.test(shown), lights: /house lights/i.test(shown) }).toEqual({ width, open: false, lights: true });
      } finally { await page.close(); }
    }
  }, 30000);
}

test("[integration] R2 the curtain opens onto the four pictures: they are the first content after the marquee, in view once open, then One question..., then Where does your week go?", async () => {
  for (const [width, height] of WIDTHS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "closed");
      const order = await page.evaluate(() => {
        // The page's top-level blocks in order: main's own sections, and the sections of any wrapper div in it.
        const blocks = [...document.querySelectorAll("main > section, main > div > section")];
        return blocks.slice(0, 4).map((n) => n.id || n.className);
      });
      expect({ width, order: order.slice(0, 3) }).toEqual({ width, order: ["types", "story", "week"] });
      expect(await page.locator("#types article.poster").count()).toBe(4);
      // textContent, not innerText: behind the closed curtain the tiles wait hidden (c03), and innerText of a hidden box is "".
      expect((await page.locator("#types .poster .p-title").allTextContents()).map((t) => t.trim())).toEqual(["Yes or no", "Pick one", "How hard", "Where"]);
      expect((await page.locator("#story .kick").innerText()).toLowerCase()).toBe("one question...");
      expect(await page.locator("#week h2").innerText()).toBe("Where does your week go?");
      expect(await page.locator("#results, #resultBars, #resultsTitle").count()).toBe(0);
      // Open the curtain the way a visitor does: scroll over it until it is open.
      await page.mouse.move(width / 2, height / 2);
      for (let i = 0; i < 60 && await page.evaluate(() => document.documentElement.dataset.curtain !== "open"); i++) {
        await page.mouse.wheel(0, 60);
        await page.waitForTimeout(30);
      }
      const view = await page.evaluate(() => {
        const first = document.querySelector("#types article.poster")?.getBoundingClientRect();
        return { state: document.documentElement.dataset.curtain, top: first ? first.top : NaN, overflow: document.documentElement.scrollWidth - innerWidth };
      });
      expect({ width, state: view.state, posterInView: view.top >= 0 && view.top < height, overflow: view.overflow }).toEqual({ width, state: "open", posterInView: true, overflow: 0 });
    } finally { await page.close(); }
  }
}, 60000);

test("[integration] R3 from the keyboard the curtain opens onto the four pictures and focus lands on them", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "closed");
    await page.keyboard.press("Tab");
    await page.keyboard.press("End");
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
    const after = await page.evaluate(() => ({ focus: document.activeElement?.id ?? "", top: document.getElementById("types")?.getBoundingClientRect().top ?? NaN }));
    expect({ focus: after.focus, inView: after.top >= -1 && after.top < 900 }).toEqual({ focus: "types", inView: true });
  } finally { await page.close(); }
});

test("[integration] R4 no Pause the motion button or text on the landing page, in either motion setting", async () => {
  for (const path of ["/"]) for (const motion of ["no-preference", "reduce"] as const) {
    const page = await pageAt(1440, 900, motion, path);
    try {
      await page.waitForLoadState("load");
      const found = await page.evaluate(() => ({ text: /pause the motion|play the motion/i.test(document.body.textContent ?? ""), buttons: document.querySelectorAll("button.pause, #pause-motion").length }));
      expect({ path, motion, ...found }).toEqual({ path, motion, text: false, buttons: 0 });
    } finally { await page.close(); }
  }
  for (const file of [LANDING, EXPLAINER]) expect(/pause the motion/i.test(readFileSync(file, "utf8"))).toBe(false);
}, 30000);

test("[integration] R5 the four pictures move under motion and stop by themselves within 5 seconds of coming into view", async () => {
  for (const path of ["/#types"]) for (const [width, height] of [[390, 844], [1440, 900]] as const) {
    const page = await pageAt(width, height, "no-preference", path, true);
    try {
      await page.waitForFunction(() => document.getElementById("noul-read") !== null && document.readyState !== "loading");
      await page.locator("#types").scrollIntoViewIfNeeded();
      // The faked clock does not let the page render, so give it real time to report the pictures in view.
      await page.waitForTimeout(150);
      await page.clock.runFor(200);
      const start = await posterState(page);
      const seen: string[] = [start];
      for (let t = 0; t < 5000; t += 250) { await page.clock.runFor(250); seen.push(await posterState(page)); }
      const atFive = await posterState(page);
      await page.clock.runFor(15000);
      const later = await posterState(page);
      expect({ path, width, moved: new Set(seen).size > 1, stopped: later === atFive }).toEqual({ path, width, moved: true, stopped: true });
    } finally { await page.close(); }
  }
}, 60000);

test("[integration] R6 under reduced motion the four pictures never move by themselves", async () => {
  for (const path of ["/#types"]) {
    const page = await pageAt(390, 844, "reduce", path, true);
    try {
      await page.waitForFunction(() => document.getElementById("noul-read") !== null && document.readyState !== "loading");
      await page.locator("#types").scrollIntoViewIfNeeded();
      const start = await posterState(page);
      await page.clock.runFor(20000);
      expect({ path, state: await posterState(page) }).toEqual({ path, state: start });
      expect(start.includes("missing")).toBe(false);
    } finally { await page.close(); }
  }
}, 30000);

test("[unit] R7 /explainer/ is only a redirect stub: a meta refresh and a plain link to /, no pictures and no picture copy", () => {
  const stub = readFileSync(EXPLAINER, "utf8");
  expect(stub).toMatch(/<meta http-equiv="refresh" content="0; url=\/">/);
  expect(stub).toMatch(/<a href="\/">[^<]+<\/a>/);
  expect({ svg: /<svg/i.test(stub), captions: captions(stub).length, scripts: /<script/i.test(stub), story: /One question|weekly limit|Jev answers/i.test(stub) }).toEqual({ svg: false, captions: 0, scripts: false, story: false });
  expect(captions(readFileSync(LANDING, "utf8"))).toHaveLength(4);
});

test("[integration] R8 an old /explainer/ link lands on the landing page, and no landing or guide link points at /explainer/", async () => {
  const page = await pageAt(1440, 900, "reduce", "/explainer/");
  try {
    await page.waitForURL((url) => url.pathname === "/", { timeout: 5000 });
    expect(await page.locator("#types article.poster").count()).toBe(4);
  } finally { await page.close(); }
  for (const file of [LANDING, join(SITE, "guide", "index.html")]) expect({ file, link: /href="[^"]*explainer/.test(readFileSync(file, "utf8")) }).toEqual({ file, link: false });
});

// Review of #273: the ladder marker, label sizes in the four-column grid, focus rings on the dark Pick one picture, and
// reduced motion turned on while the demonstration runs.
const contrastOf = (a: string, b: string): number => {
  const lum = (css: string): number => {
    const hex = css.startsWith("#") ? css.slice(1) : "";
    const parts = hex.length === 6 ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) : (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const [r, g, b2] = parts.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b2 ?? 0);
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test("[integration] R9 choosing a rung on How hard moves the marker onto that rung", async () => {
  for (const path of ["/"]) {
    const page = await pageAt(1440, 900, "reduce", path);
    try {
      for (const [i, name] of [[2, "hard"], [0, "easy"], [1, "ordinary"]] as const) {
        await page.locator(`#rungs [data-i="${i}"]`).click();
        const at = await page.evaluate((k) => {
          const pin = document.querySelector("#pin circle")?.getBoundingClientRect();
          const rung = document.querySelector(`#rungs [data-i="${k}"] rect + rect`)?.getBoundingClientRect();
          const rungs = [...document.querySelectorAll("#rungs [data-i] rect + rect")].map((r) => r.getBoundingClientRect());
          if (!pin || !rung) return { nearest: false, pressed: "" };
          const mid = (r: DOMRect): number => r.top + r.height / 2, y = mid(pin);
          const nearest = rungs.every((r) => Math.abs(mid(rung) - y) <= Math.abs(mid(r) - y));
          return { nearest, pressed: document.querySelector('#rungs [aria-pressed="true"]')?.getAttribute("data-i") ?? "" };
        }, i);
        expect({ path, name, ...at }).toEqual({ path, name, nearest: true, pressed: String(i) });
      }
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] R10 every label in the four pictures renders at 14 px or more at 390 and 12 px or more at 900, 1000, 1200 and 1440", async () => {
  for (const path of ["/"]) for (const [width, floor] of [[390, 14], [900, 12], [1000, 12], [1200, 12], [1440, 12]] as const) {
    const page = await pageAt(width, 900, "reduce", path);
    try {
      await page.waitForLoadState("load");
      const small = await page.evaluate((min) => [...document.querySelectorAll("#types svg text")].flatMap((node) => {
        const svg = node.closest("svg");
        if (!(svg instanceof SVGSVGElement)) return [];
        const px = parseFloat(node.getAttribute("font-size") ?? "0") * svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
        return px < min ? [`${node.textContent}: ${px.toFixed(1)}px`] : [];
      }), floor);
      expect({ path, width, small }).toEqual({ path, width, small: [] });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] R11 the keyboard focus ring on every picture control is 3:1 or better against the picture behind it", async () => {
  for (const path of ["/"]) {
    const page = await pageAt(1440, 900, "reduce", path);
    try {
      await page.waitForLoadState("load");
      await page.keyboard.press("Tab");
      const count = await page.locator("#types .hit").count();
      const weak: string[] = [];
      for (let i = 0; i < count; i++) {
        const control = page.locator("#types .hit").nth(i);
        await control.focus();
        const seen = await control.evaluate((node) => {
          const svg = node.closest("svg");
          // What the ring sits on: the picture's own painted background rect, else the picture's CSS background.
          const painted = svg ? [...svg.querySelectorAll("rect")].map((r) => r.getAttribute("fill") ?? "").find((f) => /^#[0-9a-f]{6}$/i.test(f)) : undefined;
          const behind = painted ?? (svg ? getComputedStyle(svg).backgroundColor : "");
          return { label: node.getAttribute("aria-label") ?? "", visible: node.matches(":focus-visible"), ring: getComputedStyle(node).outlineColor, behind };
        });
        if (!seen.visible) weak.push(`${seen.label}: no visible focus`);
        else if (contrastOf(seen.ring, seen.behind) < 3) weak.push(`${seen.label}: ${contrastOf(seen.ring, seen.behind).toFixed(2)}:1`);
      }
      expect({ path, weak }).toEqual({ path, weak: [] });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] R12 turning reduced motion on mid-demonstration stops the pictures at once and shows the three scenes still", async () => {
  for (const path of ["/#types"]) {
    const page = await pageAt(1440, 900, "no-preference", path, true);
    try {
      await page.waitForFunction(() => document.getElementById("noul-read") !== null && document.readyState !== "loading");
      await page.locator("#types").scrollIntoViewIfNeeded();
      // The faked clock does not let the page render, so give it real time to report the pictures in view.
      await page.waitForTimeout(150);
      await page.clock.runFor(300);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForTimeout(100);
      const held = await posterState(page);
      await page.clock.runFor(10000);
      const after = await page.evaluate(() => ({
        pinned: document.documentElement.classList.contains("pinned"),
        scenes: [...document.querySelectorAll("#story .frame")].map((f) => f.classList.contains("on")),
      }));
      expect({ path, moved: (await posterState(page)) !== held, ...after }).toEqual({ path, moved: false, pinned: false, scenes: [true, true, true] });
    } finally { await page.close(); }
  }
}, 30000);

test("[unit] R13 the Where caption says it plainly: no \"frames it\" on the landing page or the old /explainer stub (#271)", () => {
  for (const file of [LANDING, EXPLAINER]) expect({ file, framesIt: /frames it/i.test(readFileSync(file, "utf8")) }).toEqual({ file, framesIt: false });
  expect(captions(readFileSync(LANDING, "utf8"))[3]).toBe("Where is my limit? Jev finds the meter.");
});

test("[integration] R14 the landing footer carries one plain Little Shop link, so a visitor with no curtain can reach it", async () => {
  for (const motion of ["reduce", "no-preference"] as const) {
    const page = await pageAt(390, 844, motion);
    try {
      await page.waitForLoadState("load");
      const link = page.locator("footer.site-foot a", { hasText: "Little Shop" });
      expect(await link.count()).toBe(1);
      expect(await link.innerText()).toBe("Little Shop");
      expect(new URL(await link.getAttribute("href") ?? "", page.url()).pathname).toBe("/little-shop/");
      if (motion === "reduce") expect(await link.isVisible()).toBe(true);
    } finally { await page.close(); }
  }
}, 30000);

// Review of #273, round 2: payoff labels on light and dark, focus rings on the page background, and a demonstration
// that waits for the curtain.
const BG = { dark: "#12060a", light: "#e8e5df" } as const;

test("[integration] R15 every label on a payoff bar is 4.5:1 or better against its slice, in light and dark", async () => {
  for (const theme of ["dark", "light"] as const) {
    const page = await pageAt(1440, 900, "reduce");
    try {
      await page.waitForLoadState("load");
      await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, theme);
      const pairs = await page.locator("#payoff .tube .seg span").evaluateAll((nodes) => nodes.map((n) => ({ text: (n.textContent ?? "").trim(), fg: getComputedStyle(n).color, bg: getComputedStyle(n.parentElement ?? n).backgroundColor })));
      expect(pairs.length).toBeGreaterThanOrEqual(4);
      const weak = pairs.filter((p) => contrastOf(p.fg, p.bg) < 4.5).map((p) => `${p.text}: ${contrastOf(p.fg, p.bg).toFixed(2)}:1`);
      expect({ theme, weak }).toEqual({ theme, weak: [] });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] R16 the keyboard focus ring on the story's page links (week, developers, guide) is 3:1 or better against the page, in light and dark", async () => {
  for (const theme of ["dark", "light"] as const) {
    const page = await pageAt(1440, 900, "reduce");
    try {
      await page.waitForLoadState("load");
      await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, theme);
      await page.keyboard.press("Tab");
      const links = page.locator(".jx a.cta, .jx a.dev");
      const count = await links.count();
      expect(count).toBe(3);
      const weak: string[] = [];
      for (let i = 0; i < count; i++) {
        await links.nth(i).focus();
        const seen = await links.nth(i).evaluate((node) => ({ name: (node.textContent ?? "").trim(), visible: node.matches(":focus-visible"), ring: getComputedStyle(node).outlineColor }));
        if (!seen.visible) weak.push(`${seen.name}: no visible focus`);
        else if (contrastOf(seen.ring, BG[theme]) < 3) weak.push(`${seen.name}: ${contrastOf(seen.ring, BG[theme]).toFixed(2)}:1`);
      }
      expect({ theme, weak }).toEqual({ theme, weak: [] });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] R17 the demonstration waits for the curtain: nothing plays behind it, and it plays once the curtain opens", async () => {
  const page = await pageAt(1440, 900, "no-preference", "/", true);
  try {
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "closed");
    await page.waitForTimeout(150);
    const start = await posterState(page);
    await page.clock.runFor(6000);
    expect({ behind: await posterState(page) }).toEqual({ behind: start });
    await page.evaluate(() => { window.location.hash = "types"; });
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
    await page.waitForTimeout(150);
    await page.clock.runFor(2000);
    expect(await posterState(page)).not.toBe(start);
  } finally { await page.close(); }
}, 30000);
