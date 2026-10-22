import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import posters from "../site/shows/posters.json";

declare global {
  interface Window {
    JNJ: { cases: { id: string; prompt: string; truth: string; arms: { C: { picked: string; confidence?: number } } }[] };
  }
}

const SITE = process.env.LANDING_TEST_SITE ?? join(import.meta.dir, "..", "site");
const RECORDS = readFileSync(join(import.meta.dir, "..", "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv"), "utf8");
const RECORDS_100 = readFileSync(join(import.meta.dir, "..", "docs/product/runs/2026-10-11-uc13-shop-bot-100/records.csv"), "utf8");
const FIRST_SHOW = posters.posters.find((p) => p.stage === "show")?.id;
const VIEWPORTS: [number, number][] = [[390, 844], [1440, 900]];
const ACTION_VIEWPORTS: [number, number][] = [[390, 844], [1280, 900], [1440, 900]];
const MOTIONS: ("no-preference" | "reduce")[] = ["no-preference", "reduce"];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const posted: unknown[] = [];

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === "/api/tickets/ranking") return Response.json({ ids: [], counts: {} });
    if (pathname === "/api/tickets" && request.method === "POST") {
      const body: unknown = await request.json();
      posted.push(body);
      const kind = typeof body === "object" && body !== null && Reflect.get(body, "kind") === "backstage" ? "backstage" : "show";
      return Response.json({ ticket: "T1", kind, show: kind === "show" ? FIRST_SHOW : null });
    }
    const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(file);
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

async function pageAt(width: number, height: number, motion: "no-preference" | "reduce" = "reduce", hash = "", catalogueFails = false, errors?: string[], setup?: (page: Page) => Promise<void>): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion });
  if (errors) page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  if (catalogueFails) await page.route("**/shows/posters.json", (route) => route.fulfill({ status: 500, body: "unavailable" }));
  if (setup) await setup(page);
  await page.goto(`http://127.0.0.1:${server.port}/${hash}`, { waitUntil: "domcontentloaded" });
  if (!catalogueFails) await page.waitForFunction(() => document.querySelectorAll("#tkPosters .tk-poster").length > 0);
  return page;
}

async function guideAt(width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}/guide/`, { waitUntil: "domcontentloaded" });
  return page;
}

test("[integration] VP8 guide pages load without any request leaving the local server", async () => {
  const reached: string[] = [];
  const page = await guideAt(1440, 900);
  try {
    page.on("requestfinished", (request) => { if (!request.url().startsWith(`http://127.0.0.1:${server.port}/`)) reached.push(request.url()); });
    await page.reload();
    expect(reached).toEqual([]);
  } finally { await page.close(); }
});

test("[integration] VP1 returning visitors can see the status path beside Ask", async () => {
  const page = await pageAt(1440, 900);
  try {
    const status = page.getByRole("link", { name: "Asked a question already? Check its status" });
    expect(await status.isVisible()).toBe(true);
    expect(await status.getAttribute("href")).toBe("/ask/#status");
  } finally { await page.close(); }
});

test("[integration] VP1 the status link has a visible box on a 390px home page after the curtain opens", async () => {
  const page = await pageAt(390, 844);
  try {
    expect((await curtain(page)).state).toBe("open");
    const status = page.getByRole("link", { name: "Asked a question already? Check its status" });
    expect(await status.isVisible()).toBe(true);
    const box = await status.boundingBox();
    expect(box?.width).toBeGreaterThan(1);
    expect(box?.height).toBeGreaterThan(1);
  } finally { await page.close(); }
});

test("[integration] VP8 feedback is visible in the home footer", async () => {
  const page = await pageAt(1440, 900);
  try {
    const feedback = page.locator("footer").getByRole("link", { name: "Send feedback" });
    expect(await feedback.isVisible()).toBe(true);
    expect(await feedback.getAttribute("href")).toBe("/feedback/?from=home");
  } finally { await page.close(); }
});

test("[integration] VP8 the feedback link has a visible box on a 390px home page after the curtain opens", async () => {
  const page = await pageAt(390, 844);
  try {
    expect((await curtain(page)).state).toBe("open");
    const feedback = page.locator("footer").getByRole("link", { name: "Send feedback" });
    expect(await feedback.isVisible()).toBe(true);
    const box = await feedback.boundingBox();
    expect(box?.width).toBeGreaterThan(1);
    expect(box?.height).toBeGreaterThan(1);
  } finally { await page.close(); }
});

test("[integration] VP9 the playground link has no pending image placeholder", async () => {
  const page = await pageAt(1440, 900);
  try {
    await page.locator("#officeOpen").click();
    expect(await page.locator("#tkPlayground").isVisible()).toBe(true);
    expect(await page.locator("#tkPlayground").innerText()).toBe("Open the Jev playground");
    expect(await page.locator("body").innerText()).not.toContain("Playground image pending permission");
  } finally { await page.close(); }
});

test("[integration] VP8 the guide footer offers feedback and the glossary describes it", async () => {
  const page = await guideAt(1440, 900);
  try {
    const feedback = page.locator("footer").getByRole("link", { name: "Send feedback" });
    expect(await feedback.isVisible()).toBe(true);
    expect(await feedback.getAttribute("href")).toBe("/feedback/?from=guide");
    await page.locator("#reference > summary").click();
    const meaning = await page.locator("#reference dd").filter({ hasText: "A footer link for feedback or a problem" }).innerText();
    expect(meaning).toContain("in Backstage it opens a new issue on the project's GitHub");
    expect(meaning).toContain("on the home page, this guide and the TokenMax page it opens a short feedback form");
  } finally { await page.close(); }
});

test("[integration] VP9 the field guide announces that it opens and reveals its body", async () => {
  const page = await guideAt(1440, 900);
  try {
    const summary = page.locator("#reference > summary");
    expect(await summary.isVisible()).toBe(true);
    expect(await summary.innerText()).toMatch(/^Open field guide:/);
    expect(await page.locator("#reference .reference-body").isVisible()).toBe(false);
    await summary.click();
    expect(await page.locator("#reference .reference-body").isVisible()).toBe(true);
  } finally { await page.close(); }
});

test("[integration] VP9 Raise the curtain opens on first visit and stays hidden on reload and with reduced motion", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    const raise = page.getByRole("button", { name: "Raise the curtain" });
    expect(await raise.isVisible()).toBe(true);
    await raise.click();
    expect((await curtain(page)).state).toBe("open");
    expect(await page.locator("#types").isVisible()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    expect((await curtain(page)).state).toBe("open");
    expect(await page.locator("#types").isVisible()).toBe(true);
    expect(await raise.isVisible()).toBe(false);
    const reduced = await pageAt(1440, 900, "reduce");
    try {
      expect(await reduced.getByRole("button", { name: "Raise the curtain" }).isVisible()).toBe(false);
    } finally { await reduced.close(); }
  } finally { await page.close(); }
});

test("[integration] L1b the billing breaks as two lines, before \"in four questions\", at 390 and 1440", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height);
    try {
      const box = await page.locator("#t1").evaluate((node) => {
        const em = node.querySelector("em");
        if (!em) throw new Error("billing has no em");
        const lead = document.createRange();
        lead.selectNodeContents(node.firstChild ?? node);
        const first = lead.getBoundingClientRect();
        const second = em.getBoundingClientRect();
        const line = document.createRange();
        line.selectNodeContents(em);
        return { firstBottom: first.bottom, emTop: second.top, text: node.textContent, emLines: line.getClientRects().length, emHeight: second.height, lineHeight: parseFloat(getComputedStyle(em).lineHeight), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(box.text).toBe("To Jev or not to Jev in four questions");
      expect(box.emTop).toBeGreaterThanOrEqual(box.firstBottom - 6);
      expect(Math.round(box.emHeight / box.lineHeight)).toBe(1);
      expect(box.overflow).toBe(false);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] L1c the closed curtain's billing copy breaks as two lines, before \"in four questions\", at 390 and 1440", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      const box = await page.locator("#overture .marquee .billing").evaluate((node) => {
        const em = node.querySelector("em");
        if (!em) throw new Error("curtain billing has no em");
        const lead = document.createRange();
        lead.selectNodeContents(node.firstChild ?? node);
        const first = lead.getBoundingClientRect();
        const second = em.getBoundingClientRect();
        return { firstTop: first.top, emTop: second.top, leadLines: lead.getClientRects().length, emHeight: second.height, lineHeight: parseFloat(getComputedStyle(em).lineHeight), emFits: second.right <= (node.closest(".marquee")?.getBoundingClientRect().right ?? 0) };
      });
      expect(box.leadLines).toBe(1);
      expect(box.emTop - box.firstTop).toBeGreaterThanOrEqual(box.lineHeight * 0.8);
      expect(Math.round(box.emHeight / box.lineHeight)).toBe(1);
      expect(box.emFits).toBe(true);
    } finally { await page.close(); }
  }
}, 30000);

for (const motion of MOTIONS) {
  test(`[integration] L1-L5 the title comes first, then the four pictures and the cards; no result bars or sample hero (${motion})`, async () => {
    for (const [width, height] of ACTION_VIEWPORTS) {
      const page = await pageAt(width, height, motion);
      try {
        expect(await page.locator(":is(h1,h2,h3)").first().getAttribute("id")).toBe("t1");
        // The page h1 is the billing in the marquee band, in the page and never on the curtain.
        expect(await page.locator("#t1").innerText()).toBe("To Jev or not to Jev\nin four questions");
        if (width >= 1280) expect(await page.locator("#t1").evaluate((node) => {
          // Lines, not inline fragments: the billing's em is its own box on the same line.
          return Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight));
        })).toBeLessThanOrEqual(2);
        // The curtain opens onto the picture story (#260): the Kept answers panel and its sample hero are gone.
        expect(await page.locator("#results, #resultBars, #aboutSample, #heroResult").count()).toBe(0);
        if (motion === "reduce") {
          // No curtain: the four pictures start on the first screen.
          expect(await page.locator("#types").evaluate((node) => node.getBoundingClientRect().top < innerHeight)).toBe(true);
        } else {
          const seat = await page.locator(MADMAX).evaluate((node) => {
            const box = node.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return { top: box.top, covered: hit === node || node.contains(hit) };
          });
          expect(seat.top >= 0 && seat.top < height && seat.covered).toBe(true);
        }
        expect(await page.evaluate(() => {
          const ids = ["types", "tkPosters", "tkForm", "door"].map((id) => document.getElementById(id));
          return ids.every(Boolean) && Boolean(ids[0] && ids[1] && ids[2] && ids[3] &&
            (ids[0].compareDocumentPosition(ids[1]) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            (ids[1].compareDocumentPosition(ids[2]) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            (ids[1].compareDocumentPosition(ids[3]) & Node.DOCUMENT_POSITION_FOLLOWING));
        })).toBe(true);
        expect(await page.locator("body").evaluate((node) => node.textContent)).not.toMatch(/Rule \d+ fired/);
      } finally { await page.close(); }
    }
  }, 30000);
}

test("[integration] L6-L8 links, cards and removed elements", async () => {
  const page = await pageAt(1440, 900);
  try {
    const names = await page.locator("a[href]:visible").evaluateAll((links) => links.map((link) => link.getAttribute("aria-label") || link.textContent?.trim() || ""));
    expect(new Set(names).size).toBe(names.length);
    await page.evaluate(() => document.querySelectorAll("details").forEach((node) => { node.open = true; }));
    const expanded = await page.locator("a[href]:visible").evaluateAll((links) => links.map((link) => link.getAttribute("aria-label") || link.textContent?.trim() || ""));
    expect(expanded.filter((name, i) => expanded.indexOf(name) !== i)).toEqual([]);
    await page.evaluate(() => document.querySelectorAll("details").forEach((node) => { node.open = false; }));
    const cards = page.locator("#tkPosters .tk-poster");
    for (let i = 0; i < await cards.count(); i++) {
      const card = cards.nth(i);
      expect(await card.locator(".tk-verdict").count()).toBe(1);
      // The explained verdict leads the card's disclosure: hidden while it is closed, first inside it.
      expect(await card.locator(".tk-verdict").isVisible()).toBe(false);
      expect(await card.locator("details.tk-more > summary + .tk-verdict").count()).toBe(1);
      expect(await card.locator(".tk-figure").evaluateAll((nodes) => nodes.every((node) => !node.closest("details")))).toBe(true);
      expect(await card.locator(".tk-primary").count()).toBe(1);
      expect(await card.locator(".tk-figure").count()).toBe(await card.evaluate((node) => node.classList.contains("tk-script-reading") ? 0 : 1));
      const figure = await card.locator(".tk-figure").count() ? await card.locator(".tk-figure").innerText() : "";
      if (/\d+ of \d+/.test(figure)) expect(figure.match(/\b(Jev|LLM|simple rule)\b[^\d]*\d+ of \d+/gi)).toHaveLength(1);
    }
    expect(await page.locator("#tkPosters").innerText()).not.toMatch(/Fit check: .* \/ /);
    expect(await page.locator("#askForm, #askInput, #runway").count()).toBe(0);
  } finally { await page.close(); }
});

test("[integration] L10-L11 office panel button and deep links", async () => {
  const page = await pageAt(390, 844);
  try {
    expect(await page.locator("#officePanel").isVisible()).toBe(false);
    expect(await page.locator("#officeOpen").getAttribute("aria-expanded")).toBe("false");
    await page.locator("#officeOpen").click();
    expect(await page.locator("#officeOpen").getAttribute("aria-expanded")).toBe("true");
    for (const selector of ["#officePanel", "#tkForm", "#dropzone"]) expect(await page.locator(selector).isVisible()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("tkEmail");
  } finally { await page.close(); }
  for (const hash of ["#tkForm", "#csv"]) {
    const deep = await pageAt(390, 844, "reduce", hash);
    try {
      expect(await deep.locator("#officePanel").isVisible()).toBe(true);
      if (hash === "#tkForm") await deep.waitForFunction(() => document.activeElement?.id === "tkEmail");
    } finally { await deep.close(); }
  }
}, 15000);

test("[integration] NS1 watching needs no email; the office only takes a request to test your own decision", async () => {
  const page = await pageAt(390, 844);
  const posts: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") posts.push(request.url()); });
  try {
    expect(await page.locator('#tkForm input[name="kind"][value="show"]').count()).toBe(0);
    expect(await page.locator("#tkShow").count()).toBe(0);
    expect(await page.locator('#tkForm input[name="kind"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("value")))).toEqual(["backstage"]);
    expect(await page.locator("#tkForm").innerText()).not.toMatch(/watch a show/i);
    expect(await page.locator(".office-lede").innerText()).toContain("Watching the recorded shows is free and needs nothing");
    expect(await page.locator('input[type="email"]').evaluateAll((nodes) => nodes.filter((node) => !node.closest("#officePanel")).length)).toBe(0);
    expect(await page.locator("#officePanel").isVisible()).toBe(false);
    const withWatch = posters.posters.filter((p) => p.watch);
    expect(withWatch.length).toBeGreaterThan(0);
    for (const p of withWatch) {
      const link = page.locator(`.tk-poster[data-id="${p.id}"] a.tk-primary`);
      expect(await link.innerText()).toBe("Watch now");
      expect(await link.isVisible()).toBe(true);
      expect(await link.getAttribute("href")).toBe(p.watch);
    }
    await page.locator("#officeOpen").click();
    await page.locator("#tkForm .tk-submit").click();
    expect(await page.locator("#tkEmailErr").isVisible()).toBe(true);
    expect(await page.locator("#tkConsentErr").isVisible()).toBe(true);
    await page.locator("#tkEmail").fill("person@example.com");
    await page.locator("#tkForm .tk-submit").click();
    expect(await page.locator("#tkEmailErr").isVisible()).toBe(false);
    expect(await page.locator("#tkConsentErr").isVisible()).toBe(true);
    expect(posts).toEqual([]);
  } finally { await page.close(); }
  for (const p of posters.posters.filter((item) => item.watch)) {
    const target = await pageAt(390, 844);
    try {
      const expected = new URL(p.watch ?? "", `http://127.0.0.1:${server.port}/`);
      await target.locator(`.tk-poster[data-id="${p.id}"] a.tk-primary`).click();
      await target.waitForURL(expected.href, { timeout: 5000 });
      const visibleEmail = () => target.locator('input[type="email"]').evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).length);
      if (expected.hash) {
        const shown = target.locator(expected.hash);
        await shown.waitFor({ state: "visible" });
        expect(await shown.evaluate((node) => { const box = node.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0; })).toBe(true);
        expect((await shown.innerText()).trim().length).toBeGreaterThan(0);
        expect(await target.locator("#officePanel").isVisible()).toBe(false);
      } else {
        const heading = target.locator("h1");
        await heading.waitFor({ state: "visible" });
        expect((await heading.innerText()).trim().length).toBeGreaterThan(0);
        expect(await target.locator("#officePanel").count()).toBe(0);
      }
      expect(await visibleEmail()).toBe(0);
    } finally { await target.close(); }
  }
  for (const path of ["little-shop/", "replay/"]) {
    const target = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      const response = await target.goto(`http://127.0.0.1:${server.port}/${path}`, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      expect(await target.locator('input[type="email"], input[type="password"], form').count()).toBe(0);
    } finally { await target.close(); }
  }
}, 30000);

test("[integration] NS2 a sent request posts kind backstage, no show, and exactly the fields given", async () => {
  const page = await pageAt(390, 844);
  try {
    posted.length = 0;
    await page.locator("#officeOpen").click();
    await page.locator("#tkEmail").fill("Person@Example.com");
    await page.locator("#tkWebsite").fill("https://shop.example.com");
    await page.locator("#tkIdea").fill("Can my shop bot answer this message?");
    await page.locator("#tkConsent").check();
    await page.locator("#tkFollow").check();
    await page.locator("#tkForm .tk-submit").click();
    await page.locator("#tkIssued").waitFor({ state: "visible" });
    expect(posted).toHaveLength(1);
    const body = posted[0];
    expect(typeof body === "object" && body !== null).toBe(true);
    const field = (name: string): unknown => typeof body === "object" && body !== null ? Reflect.get(body, name) : undefined;
    expect(field("kind")).toBe("backstage");
    expect(field("show")).toBeNull();
    expect(field("email")).toBe("Person@Example.com");
    expect(field("website")).toBe("https://shop.example.com");
    expect(field("idea")).toBe("Can my shop bot answer this message?");
    expect(field("consent")).toBe(true);
    expect(field("follow_up")).toBe(true);
    expect(field("nickname")).toBe("");
    expect(field("request_key")).toMatch(/^[0-9a-f]{32}$/);
  } finally { await page.close(); }
}, 15000);

test("[integration] T-reopen issued request can be followed by a fresh form", async () => {
  const page = await pageAt(390, 844);
  try {
    await page.locator("#officeOpen").click();
    await page.locator("#tkEmail").fill("person@example.com");
    await page.locator("#tkConsent").check();
    await page.locator("#tkForm .tk-submit").click();
    await page.locator("#tkIssued").waitFor({ state: "visible" });
    expect(await page.locator("#tkIssued").innerText()).toContain("T1");
    await page.locator("#officeOpen").click();
    await page.locator("#officeOpen").click();
    expect(await page.locator("#tkIssued").isVisible()).toBe(true);
    expect(await page.locator("#tkIssued").innerText()).toContain("T1");
    await page.evaluate(() => { window.location.hash = "#tkForm"; });
    await page.waitForTimeout(50);
    expect(await page.locator("#tkIssued").isVisible()).toBe(true);
    expect(await page.locator("#tkIssued").innerText()).toContain("T1");
    expect(await page.locator("#tkForm").isVisible()).toBe(false);
    await page.getByRole("button", { name: "Get another ticket" }).click();
    expect(await page.locator("#tkForm").isVisible()).toBe(true);
    expect(await page.locator("#tkIssued").isVisible()).toBe(false);
    expect(await page.locator("#tkEmail").inputValue()).toBe("");
    expect(await page.locator("#tkConsent").isChecked()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("tkEmail");
  } finally { await page.close(); }
}, 15000);

test("[integration] T-reopen-backstage after a request the reopened form is a working request form", async () => {
  const page = await pageAt(390, 844);
  try {
    await page.locator("#officeOpen").click();
    await page.locator("#tkEmail").fill("person@example.com");
    await page.locator("#tkConsent").check();
    await page.locator("#tkForm .tk-submit").click();
    await page.locator("#tkIssued").waitFor({ state: "visible" });
    expect(await page.locator("#tkIssued").innerText()).toContain("T1");
    await page.locator("#officeOpen").click();
    await page.locator("#officeOpen").click();
    expect(await page.locator("#tkIssued").isVisible()).toBe(true);
    expect(await page.locator("#tkIssued").innerText()).toContain("T1");
    await page.getByRole("button", { name: "Get another ticket" }).click();
    expect(await page.locator("#tkIssued").isVisible()).toBe(false);
    expect(await page.locator("#tkForm").isVisible()).toBe(true);
    expect(await page.locator("#tkEmail").inputValue()).toBe("");
    expect(await page.locator("#tkConsent").isChecked()).toBe(false);
    expect(await page.locator("#tkWebsiteField").isVisible()).toBe(true);
    expect(await page.locator("#tkIdeaField").isVisible()).toBe(true);
    expect(await page.locator("#tkForm .tk-submit").innerText()).toBe("Send my request");
  } finally { await page.close(); }
}, 15000);

test("[integration] T-catalogue failed catalogue still takes a request", async () => {
  const errors: string[] = [];
  const page = await pageAt(390, 844, "reduce", "", true, errors);
  try {
    await page.waitForFunction(() => (document.getElementById("tkPosters")?.textContent ?? "").includes("did not load"));
    await page.locator("#officeOpen").click();
    expect(await page.locator("#tkForm .tk-submit").isEnabled()).toBe(true);
    expect(await page.locator("#tkPosters").innerText()).toContain("The show list did not load");
    expect(await page.locator(".tk-stages").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 15000);

async function measurePage(page: Page): Promise<{ overflow: number; outside: string[]; small: string[] }> {
  return page.evaluate(() => {
    const visible = (node: Element) => {
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && box.width > 0 && box.height > 0 && box.right > 0 && box.left < innerWidth;
    };
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      outside: [...document.querySelectorAll("body *")].filter((node) => visible(node) && node.getBoundingClientRect().right > innerWidth + 1).map((node) => `${node.tagName}#${node.id}.${node.className}`),
      small: [...document.querySelectorAll("button,a,input,select,summary")].filter((node) => {
        const box = node.getBoundingClientRect(); return visible(node) && (box.width < 24 || box.height < 24);
      }).map((node) => `${node.tagName}#${node.id}.${node.className}`)
    };
  });
}

test("[integration] T-panel-open-measure open office fits both viewports", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height);
    try {
      await page.locator("#officeOpen").click();
      await page.locator("#door").click();
      expect(await page.locator("#doorDemo").isVisible()).toBe(true);
      expect(await page.getByText("Choose a file", { exact: true }).count()).toBe(1);
      expect(await page.locator("#csv").evaluate((node) => getComputedStyle(node).opacity)).toBe("0");
      expect(await measurePage(page)).toEqual({ overflow: 0, outside: [], small: [] });
    } finally { await page.close(); }
  }
});

test("[integration] T-door-replay Play again restarts the animated demo", async () => {
  const page = await pageAt(390, 844, "no-preference");
  try {
    expect(await page.locator("html").getAttribute("class")).toContain("motion");
    await page.locator("#door").click();
    expect(await page.locator("#doorDemo .dd-msg").last().evaluate((node) => getComputedStyle(node).opacity)).toBe("0");
    await page.waitForFunction(() => document.querySelectorAll("#doorDemo .dd-msg.on").length >= 2);
    await page.getByRole("button", { name: "Play again" }).click();
    expect(await page.locator("#doorDemo .dd-msg.on").count()).toBe(0);
    expect(await page.locator("#doorDemo").getAttribute("data-played")).toBe("playing");
  } finally { await page.close(); }
}, 15000);

test("[integration] T-csv a loaded file shows its verdict in the loaded result without overflow", async () => {
  const page = await pageAt(390, 844);
  try {
    await page.locator("#officeOpen").click();
    await page.locator("#csv").setInputFiles({ name: "uc13-records.csv", mimeType: "text/csv", buffer: Buffer.from(RECORDS) });
    await page.locator("#loadedResult").waitFor({ state: "visible" });
    expect(await page.locator("#loadedResult").innerText()).toMatch(/VERDICT PER QUESTION[\s\S]*not enough evidence/i);
    expect(await measurePage(page)).toEqual({ overflow: 0, outside: [], small: [] });
  } finally { await page.close(); }
}, 30000);

test("[integration] T-contrast visible links, buttons and badges meet 4.5:1 in both themes", async () => {
  const page = await pageAt(1440, 900);
  try {
    await page.locator("#officeOpen").click();
    await page.locator("#door").click();
    await page.locator(".tk-more").evaluateAll((details) => details.forEach((node) => node.setAttribute("open", "")));
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const failures = await page.locator("a[href]:visible, button:visible, .tk-stamp:visible").evaluateAll((links) => {
        const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
        const lum = (a: number[]) => a.slice(0, 3).map((v) => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
        return links.flatMap((link) => {
          let node: Element | null = link;
          let bg = [18, 6, 10];
          while (node) {
            const c = rgb(getComputedStyle(node).backgroundColor);
            if (c.length >= 3 && (c.length === 3 || c[3] === 1)) { bg = c; break; }
            node = node.parentElement;
          }
          const fg = rgb(getComputedStyle(link).color), a = lum(fg), b = lum(bg);
          const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
          return ratio < 4.5 ? [`${link.textContent?.trim()}: ${ratio.toFixed(2)}`] : [];
        });
      });
      expect(failures).toEqual([]);
    }
  } finally { await page.close(); }
}, 15000);

test("[integration] L12-L14 page dimensions and tap targets", async () => {
  for (const [width, height] of VIEWPORTS) for (const motion of MOTIONS) {
    const page = await pageAt(width, height, motion);
    try {
      const measure = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        small: [...document.querySelectorAll("button,a,input,select,summary")].filter((node) => {
          const style = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          return style.visibility !== "hidden" && box.width > 0 && box.height > 0 && (box.width < 24 || box.height < 24);
        }).map((node) => `${node.tagName}#${node.id}.${node.className}`) }));
      // Issue #203's limits: under 8,000 px at 390 and under 5,000 px at 1440.
      expect(measure.height).toBeLessThan(width === 390 ? 8000 : 5000);
      expect(measure.small).toEqual([]);
      expect(measure.overflow).toBe(0);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] L15 each poster leads with its plain stamp: Tested, Small test, or Coming for an idea", async () => {
  const page = await pageAt(1440, 900);
  try {
    for (const [stage, label] of [["show", "Tested"], ["rehearsal", "Small test"], ["script-reading", "Coming"]]) {
      const stamp = page.locator(`.tk-${stage} > .tk-stamp`).first();
      expect(await stamp.textContent()).toBe(label ?? "");
      expect(await stamp.evaluate((node) => node.parentElement?.firstElementChild === node)).toBe(true);
    }
  } finally { await page.close(); }
});

/*
 * The curtain (theatre.js, decided before first paint by the inline head script). Curtain mode is motion on and the
 * first page of the tab session (sessionStorage jnj-overture). In curtain mode the page loads closed at scrollY 0 and
 * stays closed until the visitor acts: scrolling parts it in step (fully open after html[data-runway] pixels), Skip the
 * overture, any focus outside the curtain's own controls, or a #hash opens it at once. Scrolling the opened page back to its top closes
 * it again (L41).
 * html[data-curtain] is closed, rising or open; the root's --reveal is how far it has parted (0 to 1), and the result
 * bars are drawn at --w times --reveal.
 */
const CURTAIN_VIEWPORTS: [number, number][] = [[1280, 900], [390, 844]];
const CLOSED_VIEWPORTS: [number, number][] = [[1440, 900], [390, 844]];
/** The 96f5b14 colours restored on the curtain: marquee #1a0508, ticket #efe2c4. */
const MARQUEE_BG = "rgb(26, 5, 8)";
const TICKET_BG = "rgb(239, 226, 196)";

/** The scroll distance (px) over which the curtain parts, as theatre.js records it. */
async function runway(page: Page): Promise<number> {
  await page.waitForFunction(() => Number(document.documentElement.dataset.runway) > 0, undefined, { timeout: 3000 });
  return Number(await page.evaluate(() => document.documentElement.dataset.runway));
}

/**
 * Scrolls, at once, the scroller a wheel at the centre of the screen would move (the nearest scrollable ancestor of
 * what is there; else, while the page is locked under the curtain, the curtain, which is where theatre.js sends that
 * wheel; else the page) to `top` px, then lets two frames pass so the curtain script has run. V10 drives the same paths
 * with real wheel, touch and key input.
 */
async function scrollAtCentre(page: Page, top: number): Promise<void> {
  await page.evaluate((y) => {
    for (let node = document.elementFromPoint(innerWidth / 2, innerHeight / 2); node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (/^(auto|scroll)$/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) {
        node.scrollTo({ top: y, behavior: "instant" });
        return;
      }
    }
    const ov = document.getElementById("overture");
    if (ov && getComputedStyle(document.documentElement).overflowY === "hidden" && getComputedStyle(ov).display !== "none") {
      ov.scrollTo({ top: y, behavior: "instant" });
      return;
    }
    window.scrollTo({ top: y, behavior: "instant" });
  }, top);
  await frames(page);
}

/** Scrolls to a fraction of the curtain's runway at once, the way a wheel at the centre would, then lets two frames pass. */
async function scrollToRunway(page: Page, fraction: number): Promise<void> {
  await scrollAtCentre(page, fraction * await runway(page));
}

/** One part of the closed curtain: its box, whether it lies wholly in the viewport, hit-tests to itself, and is turned. */
interface Part { left: number; right: number; top: number; bottom: number; inView: boolean; hit: boolean; turned: boolean }

/** The Mad TokenMax poster on the curtain: one link to tm/ carrying the poster and the ADMIT ONE ticket (#248). */
const MADMAX = '#overture a[href="tm/"]';

const PARTS: Record<string, string> = {
  marquee: "#overture .marquee", ticket: "#overture .ticket", cue: "#overture .cue-scroll",
  poster: "#overture .poster", madmax: MADMAX, chip: "#sampleBadge", lights: "#lights",
};

/**
 * Opens the curtain onto the results the way a keyboard visitor does since #248 removed Skip the overture: focus on a
 * curtain control (the Mad TokenMax poster) and scroll the curtain past the fade; theatre.js then opens it, brings the
 * result bars to the top and moves focus to their heading.
 */
async function openOntoResults(page: Page): Promise<void> {
  await page.locator(MADMAX).focus();
  await scrollToRunway(page, 1.2);
  await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
}

async function curtainParts(page: Page): Promise<Record<string, Part | null>> {
  return page.evaluate((parts) => {
    const out: Record<string, Part | null> = {};
    for (const [name, selector] of Object.entries(parts)) {
      const node = document.querySelector(selector);
      if (!node) { out[name] = null; continue; }
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const t = getComputedStyle(node).transform;
      const turned = t !== "none" && Math.abs(new DOMMatrix(t).b) > 0.005;
      out[name] = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, turned, hit: hit === node || node.contains(hit),
        inView: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
    }
    return out;
  }, PARTS);
}

/** The screenshot's colour (r, g, b) at each viewport point: what is actually painted there. */
async function pixelsAt(page: Page, points: [number, number][]): Promise<[number, number, number][]> {
  const shot = (await page.screenshot()).toString("base64");
  return page.evaluate(async ({ b64, pts }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    ctx.drawImage(img, 0, 0);
    return pts.map(([x, y]): [number, number, number] => {
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
    });
  }, { b64: shot, pts: points });
}

/** Curtain red: any shade of the drape (light theme), never the page's background. */
function isCurtainRed([r, g, b]: [number, number, number]): boolean {
  return r >= 30 && r > 2 * g && r > 1.4 * b;
}

/**
 * What a viewer sees of one curtain: on-screen width, whether it spans the screen's height under the first-screen band
 * (from the band's bottom, or the top with no band, to the bottom edge), effective opacity, visibility.
 */
interface CurtainView { left: number; right: number; onScreen: number; fullHeight: boolean; opacity: number; visible: boolean }

async function viewCurtains(page: Page): Promise<CurtainView[]> {
  return page.evaluate(() => [...document.querySelectorAll(".overture .curtain")].map((node) => {
    let opacity = 1;
    for (let el: Element | null = node; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
    const box = node.getBoundingClientRect();
    const onScreen = node.getClientRects().length > 0 && box.height > 0 ? Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0)) : 0;
    const band = document.getElementById("tmFirst")?.getBoundingClientRect();
    const edge = band ? Math.max(0, band.bottom) : 0;
    return { left: Math.round(box.left), right: Math.round(box.right), onScreen: Math.round(onScreen), fullHeight: box.top <= edge + 0.5 && box.bottom >= innerHeight, opacity, visible: getComputedStyle(node).visibility === "visible" };
  }));
}

/** Curtains a viewer could see: on screen, not hidden, not transparent. */
async function shownCurtains(page: Page): Promise<number> {
  return (await viewCurtains(page)).filter((c) => c.onScreen > 0 && c.visible && c.opacity > 0).length;
}

/**
 * Both curtains together cover the whole screen under the first-screen band, edge to edge and from the band's bottom to
 * the bottom edge, opaque, and paint curtain red: the screenshot at points down both outer edges of that area (clear of
 * the playbill and the chip) is the drape, not the page.
 */
async function coversViewport(page: Page): Promise<boolean> {
  const [l, r] = await viewCurtains(page);
  const { width, height, edge } = await page.evaluate(() => {
    const band = document.getElementById("tmFirst")?.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, edge: band ? Math.max(0, band.bottom) : 0 };
  });
  if (!l || !r) return false;
  const geometry = l.left <= 0 && r.right >= width && l.right >= r.left && [l, r].every((c) => c.fullHeight && c.visible && c.opacity === 1);
  const points: [number, number][] = [];
  for (const x of [0.03, 0.97]) for (const y of [0.3, 0.5, 0.7]) points.push([x * width, edge + y * (height - edge)]);
  return geometry && (await pixelsAt(page, points)).every(isCurtainRed);
}

/** What the pointer reaches on a 9x9 grid over the viewport: the curtain (with everything on it), the sample chip, the first-screen band, or anything else. */
async function closedScreenHits(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const ov = document.getElementById("overture"), chip = document.getElementById("sampleBadge"), band = document.getElementById("tmFirst");
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) {
      const hit = document.elementFromPoint((i + 0.5) * innerWidth / 9, (j + 0.5) * innerHeight / 9);
      out.add(!hit ? "none" : ov?.contains(hit) ? "curtain" : chip?.contains(hit) ? "chip" : band?.contains(hit) ? "band" : `${hit.tagName}#${hit.id}.${hit.className}`);
    }
    return [...out].sort();
  });
}

/** Whether the topmost element at the centre of the selector's box is that element (or inside it). */
async function hitsItself(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === node || node.contains(hit);
  });
}

async function curtain(page: Page): Promise<{ state: string; reveal: number }> {
  return page.evaluate(() => ({
    state: document.documentElement.dataset.curtain ?? "unset",
    reveal: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--reveal")),
  }));
}

/** The four pictures the curtain opens onto (#260): whether each poster is laid out with a box, fully opaque. */
async function pictureBoxes(page: Page): Promise<boolean[]> {
  return page.locator("#types article.poster").evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    let opacity = 1;
    for (let el: Element | null = node; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
    return box.width > 0 && box.height > 0 && opacity === 1;
  }));
}

function allShown(list: boolean[]): boolean {
  return list.length === 4 && list.every(Boolean);
}

/** What the pointer reaches in the middle of the gap between the parting curtains, level with the first picture. */
async function gapHit(page: Page): Promise<string> {
  return page.evaluate(() => {
    const [cl, cr] = [...document.querySelectorAll(".overture .curtain")].map((node) => node.getBoundingClientRect());
    const left = Math.max(0, cl ? cl.right : 0), right = Math.min(innerWidth, cr ? cr.left : innerWidth);
    const first = document.querySelector("#types article.poster")?.getBoundingClientRect();
    if (!first || right <= left) return "no gap";
    const y = Math.min(innerHeight - 4, Math.max(4, first.top + Math.min(first.height, innerHeight - first.top) / 2));
    const node = document.elementFromPoint((left + right) / 2, y);
    return node?.closest("#types") ? "pictures" : node ? `${node.tagName}.${node.className}` : "none";
  });
}
/** Scrolls to a fraction of the viewport height at once, then lets two frames pass so the curtain script has run. */
async function scrollToVh(page: Page, fraction: number): Promise<void> {
  await page.evaluate((f) => { window.scrollTo({ top: f * innerHeight, behavior: "instant" }); }, fraction);
  await frames(page);
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/**
 * A page with theatre.js held at the network, so what the head script decided before first paint can be read before
 * any curtain script runs. release() opens the gate (safe twice); ready() waits for theatre.js to record its state.
 */
interface Held { page: Page; release: () => void; ready: () => Promise<void> }

async function held(width: number, height: number, motion: "no-preference" | "reduce"): Promise<Held> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion });
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  try {
    await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await page.route("**/theatre.js", async (route) => { await gate; await route.continue(); });
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "commit" });
    await page.waitForFunction(() => document.querySelector('#overture a[href="tm/"]') !== null && document.getElementById("types") !== null && document.querySelectorAll(".overture .curtain").length === 2);
  } catch (error) {
    open();
    await page.close();
    throw error;
  }
  const ready = async (): Promise<void> => {
    await page.waitForFunction(() => document.documentElement.dataset.curtain !== undefined, undefined, { timeout: 5000 });
  };
  return { page, release: open, ready };
}

async function onHeld(width: number, height: number, motion: "no-preference" | "reduce", body: (stage: Held) => Promise<void>): Promise<void> {
  const stage = await held(width, height, motion);
  try {
    await body(stage);
  } finally {
    try { stage.release(); } finally { await stage.page.close(); }
  }
}

test("[integration] L16 at scrollY 0 with no input the curtain is still closed after 1.8s and covers the screen under the first-screen band; only the band, the curtain's composition and the sample chip show", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect(await page.evaluate(() => document.documentElement.classList.contains("overture-play"))).toBe(true);
      // Longer than the old auto-parting curtain's 1.3s animation and 1.8s fallback: nothing opens it but the visitor.
      await page.waitForTimeout(2000);
      expect({ width, state: (await curtain(page)).state, y: await page.evaluate(() => scrollY) }).toEqual({ width, state: "closed", y: 0 });
      expect(await coversViewport(page)).toBe(true);
      const hits = await closedScreenHits(page);
      expect(hits).toContain("curtain");
      // The first-screen band sits above the curtain; nothing of the page behind the curtain is reachable.
      expect(hits.filter((h) => !["curtain", "chip", "band"].includes(h))).toEqual([]);
      expect(await hitsItself(page, MADMAX)).toBe(true);
      // The curtain is a named region; its painted drapes are hidden from assistive technology, its controls are not.
      const named = await page.evaluate(() => {
        const ov = document.getElementById("overture");
        return {
          role: ov?.getAttribute("role") ?? "", label: ov?.getAttribute("aria-label") ?? "", hidden: ov?.getAttribute("aria-hidden") ?? null,
          drapes: [...document.querySelectorAll(".overture .curtain")].map((node) => node.getAttribute("aria-hidden")),
          controlsHidden: [...document.querySelectorAll('#overture a[href="tm/"], #overture .poster .p-cta')].some((node) => node.closest("[aria-hidden=true]") !== null),
        };
      });
      expect(named).toEqual({ role: "region", label: "Opening curtain", hidden: null, drapes: ["true", "true"], controlsHidden: false });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] L16b the curtain is decided before first paint: closed and covering the screen before the curtain script runs", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    await onHeld(width, height, "no-preference", async ({ page, release, ready }) => {
      expect(await page.evaluate(() => ({
        motion: document.documentElement.classList.contains("motion"),
        play: document.documentElement.classList.contains("overture-play"),
        state: document.documentElement.dataset.curtain ?? "unset",
      }))).toEqual({ motion: true, play: true, state: "unset" });
      expect(await coversViewport(page)).toBe(true);
      release();
      await ready();
      expect((await curtain(page)).state).toBe("closed");
      expect(await coversViewport(page)).toBe(true);
    });
  }
}, 30000);

test("[integration] V1 the closed curtain carries the composition: marquee, the Mad TokenMax poster with the ADMIT ONE ticket on it, the Little Shop poster, Raise the curtain and the sample chip, and no Skip (a short phone curtain sets Raise the curtain aside, never clips it)", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      expect(await page.locator("#overture .marquee").innerText()).toMatch(/Jev!Jev presents[\s\S]*To Jev or not to Jev\s+in four questions/i);
      expect(await page.locator("#overture .marquee").getAttribute("aria-hidden")).toBe("true");
      const ticket = await page.locator("#overture .ticket").textContent() ?? "";
      for (const word of ["ADMIT ONE", "J-EV", "No. 0042"]) expect(ticket).toContain(word);
      expect(await page.locator("#overture .poster .p-title").innerText()).toBe("Little Shop of Horrors");
      expect(await page.locator("#overture .poster a").count()).toBe(0);
      expect(await page.locator("#overture .poster .p-cta").innerText()).toMatch(/^open the curtain$/i);
      expect(await page.locator("#overture .cue-scroll").innerText()).toMatch(/^raise the curtain$/i);
      expect({ width, skip: await page.locator("#skipOverture").count(), button: await page.getByRole("button", { name: /skip/i }).count() }).toEqual({ width, skip: 0, button: 0 });
      expect(await page.locator("#overture .ticket").evaluate((node) => node.closest("a")?.getAttribute("href") ?? "")).toBe("tm/");
      // The chip carries House lights only: no "Sample run" label (#260).
      expect(await page.locator("#sampleBadge").innerText()).toMatch(/^house lights (up|down)$/i);
      const parts = await curtainParts(page);
      // A phone curtain of 520px of stage or less is theatre.css's short phone curtain: the scroll cue steps out (display none, never clipped).
      const roomy = width > 720 || height > 520;
      const stepsOut = roomy ? [] : ["cue"];
      for (const [name, part] of Object.entries(parts)) {
        if (stepsOut.includes(name)) continue;
        expect({ width, name, inView: part?.inView, hit: part?.hit }).toEqual({ width, name, inView: true, hit: true });
      }
      expect({ width, out: await page.evaluate((names) => names.map((n) => getComputedStyle(document.querySelector(n === "ticket" ? "#overture .ticket" : "#overture .cue-scroll") ?? document.body).display), stepsOut) })
        .toEqual({ width, out: stepsOut.map(() => "none") });
      const { marquee, ticket: tk, madmax, poster, chip } = parts;
      if (!marquee || !tk || !madmax || !poster || !chip) throw new Error("a part of the curtain is missing");
      // The chip sits top right of the curtain, as in the references.
      expect({ width, right: chip.right >= width - 24, top: chip.top >= 0 && chip.top <= 40, side: (chip.left + chip.right) / 2 > width / 2 }).toEqual({ width, right: true, top: true, side: true });
      // The ticket rides on the Mad TokenMax poster, both under the marquee, left of the Little Shop poster.
      const onPoster = tk.left < madmax.right && tk.right > madmax.left && tk.top < madmax.bottom && tk.bottom > madmax.top;
      expect({ width, onPoster, posterRight: poster.left > tk.right && poster.left > madmax.right, marqueeAbove: marquee.bottom <= madmax.top && marquee.bottom <= poster.top })
        .toEqual({ width, onPoster: true, posterRight: true, marqueeAbove: true });
      if (width >= 1100) {
        expect(await page.locator("#overture .p-blurb").isVisible()).toBe(true);
      } else {
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
        // The phone poster keeps the short copy.
        expect(await page.locator("#overture .p-blurb").isVisible()).toBe(false);
      }
      expect({ poster: poster.turned, ticket: roomy ? tk.turned : true }).toEqual({ poster: true, ticket: true });
      expect(await page.evaluate(() => ({
        marquee: getComputedStyle(document.querySelector("#overture .marquee") ?? document.body).backgroundColor,
        ticket: getComputedStyle(document.querySelector("#overture .ticket") ?? document.body).backgroundColor,
      }))).toEqual({ marquee: MARQUEE_BG, ticket: TICKET_BG });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] V2 no generic opening: no #opening or #takeSeat, nothing named Take your seat, and the one h1 is in the page, not on the curtain", async () => {
  const roles: ("button" | "link" | "heading")[] = ["button", "link", "heading"];
  for (const motion of MOTIONS) for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, motion);
    try {
      expect(await page.locator("#opening, #takeSeat, .opening, .take-seat").count()).toBe(0);
      for (const role of roles) expect({ motion, role, count: await page.getByRole(role, { name: "Take your seat", exact: true }).count() }).toEqual({ motion, role, count: 0 });
      expect(await page.locator("h1").count()).toBe(1);
      expect(await page.locator("h1").evaluate((node) => node.id === "t1" && node.closest("#overture") === null && node.closest("main .marquee-band") !== null)).toBe(true);
      expect(await page.locator("#overture .poster").getAttribute("aria-label")).toBeNull();
      expect({ motion, open: await page.getByRole("button", { name: "Open the curtain", exact: true }).count() }).toEqual({ motion, open: motion === "reduce" ? 0 : 1 });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] V3 there is no Skip the overture (#248); from the keyboard the curtain still opens: scrolling the curtain from a curtain poster (and PageDown there) opens it onto the result bars with focus on their heading, and Tab past House lights opens it", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      // c01 made the scroll cue a button, Raise the curtain (UX2); nothing on the curtain is a Skip.
      expect({ width, skip: await page.locator("#skipOverture").count(), buttons: await page.locator("#overture button").evaluateAll((nodes) => nodes.map((n) => n.id)) }).toEqual({ width, skip: 0, buttons: ["openCurtain", "raise"] });
      await openOntoResults(page);
      const after = await page.evaluate(() => {
        const ov = document.getElementById("overture"), head = document.getElementById("types");
        return {
          state: document.documentElement.dataset.curtain, active: document.activeElement?.id, overture: ov ? getComputedStyle(ov).display : "missing",
          top: document.getElementById("types")?.getBoundingClientRect().top ?? NaN, headTop: head?.getBoundingClientRect().top ?? NaN, y: scrollY,
        };
      });
      expect({ width, state: after.state, active: after.active, overture: after.overture }).toEqual({ width, state: "open", active: "types", overture: "none" });
      expect(after.y).toBeGreaterThan(0);
      expect(Math.abs(after.top)).toBeLessThan(2);
      expect(after.headTop >= -1 && after.headTop < height).toBe(true);
      expect(await shownCurtains(page)).toBe(0);
      expect(allShown(await pictureBoxes(page))).toBe(true);
    } finally { await page.close(); }
    // A real key: PageDown with focus on the Mad TokenMax poster scrolls the curtain and opens it onto the results.
    const keyed = await pageAt(width, height, "no-preference");
    try {
      await keyed.locator(MADMAX).focus();
      for (let i = 0; i < 6 && (await curtain(keyed)).state !== "open"; i++) { await keyed.keyboard.press("PageDown"); await keyed.waitForTimeout(150); await frames(keyed); }
      expect({ width, key: "PageDown", state: (await curtain(keyed)).state, focus: await keyed.evaluate(() => document.activeElement?.id ?? "") }).toEqual({ width, key: "PageDown", state: "open", focus: "types" });
    } finally { await keyed.close(); }
    // Tab only: the two posters, Raise the curtain and House lights keep it closed; the next Tab lands on the page and opens it.
    const tabs = await pageAt(width, height, "no-preference");
    try {
      const note = await noteShown(tabs);
      expect({ width, note }).toEqual({ width, note: NOTE_RENDERED });
      const stops = await tabStops(tabs, note ? 7 : 6);
      expect({ width, stops: stops.map((s) => `${s.stop}:${s.state}`) }).toEqual({ width, stops: ["madmax poster:closed", "openCurtain:closed", ...(note ? ["testimonial:closed"] : []), "raise:closed", "lights:closed", "programLink:closed", "A.house-link:open"] });
      expect(await shownCurtains(tabs)).toBe(0);
    } finally { await tabs.close(); }
  }
}, 30000);

/** The ux-swarm c01 pass check: the first screen says what Jev is, in one plain sentence. */
const PRODUCT_LINE = /^Jev\b.*\b(picks|rates|answers|gives)\b/i;
const FIRST_SCREENS: [number, number][] = [[1280, 800], [1440, 900], [390, 844]];

test("[integration] UX1 c01 the closed curtain says what Jev is: one plain product sentence under the marquee and above the posters, on screen and reachable at 1280x800, 1440x900 and 390x844", async () => {
  for (const [width, height] of FIRST_SCREENS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      expect(await page.locator("#overture .pitch").count()).toBe(1);
      expect({ width, text: PRODUCT_LINE.test(await page.locator("#overture .pitch").innerText()) }).toEqual({ width, text: true });
      const at = await page.evaluate(() => {
        const box = (s: string): DOMRect | null => document.querySelector(s)?.getBoundingClientRect() ?? null;
        const marquee = box("#overture .marquee"), pitch = box("#overture .pitch"), bills = box("#overture .showbills");
        if (!marquee || !pitch || !bills) return null;
        return { under: marquee.bottom <= pitch.top, above: pitch.bottom <= bills.top, inView: pitch.top >= 0 && pitch.bottom <= innerHeight && pitch.left >= 0 && pitch.right <= innerWidth,
          hidden: document.querySelector("#overture .pitch")?.closest("[aria-hidden=true]") !== null };
      });
      expect({ width, at }).toEqual({ width, at: { under: true, above: true, inView: true, hidden: false } });
      expect(await hitsItself(page, "#overture .pitch")).toBe(true);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] UX2 c01 Raise the curtain is a button on the closed curtain, 24px or more each way, in the Tab order after the two posters; a click or Enter opens it onto the four pictures with focus on them", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      const raise = page.getByRole("button", { name: "Raise the curtain", exact: true });
      expect(await raise.count()).toBe(1);
      expect(await raise.evaluate((node) => node.closest("#overture") !== null && node.closest("[aria-hidden=true]") === null)).toBe(true);
      const box = await raise.boundingBox();
      expect({ width, w: (box?.width ?? 0) >= 24, h: (box?.height ?? 0) >= 24 }).toEqual({ width, w: true, h: true });
      expect(await hitsItself(page, "#overture .cue-scroll")).toBe(true);
      await raise.click();
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      const after = await page.evaluate(() => ({ focus: document.activeElement?.id ?? "", top: document.getElementById("types")?.getBoundingClientRect().top ?? NaN }));
      expect({ width, focus: after.focus, inView: after.top >= -1 && after.top < height }).toEqual({ width, focus: "types", inView: true });
    } finally { await page.close(); }
    const keyed = await pageAt(width, height, "no-preference");
    try {
      const note = await noteShown(keyed);
      expect({ width, note }).toEqual({ width, note: NOTE_RENDERED });
      const stops = await tabStops(keyed, note ? 4 : 3);
      expect({ width, stops: stops.map((s) => `${s.stop}:${s.state}`) }).toEqual({ width, stops: ["madmax poster:closed", "openCurtain:closed", ...(note ? ["testimonial:closed"] : []), "raise:closed"] });
      await keyed.keyboard.press("Enter");
      await keyed.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      expect({ width, focus: await keyed.evaluate(() => document.activeElement?.id ?? "") }).toEqual({ width, focus: "types" });
    } finally { await keyed.close(); }
  }
}, 30000);

/** The four tiles' titles, in order (c02: each tile's title is a real button with that name). */
const TILE_NAMES = ["Yes or no", "Pick one", "How hard", "Where"];

/** Per tile: whether it is lit, its named controls, whether its one-line example shows, and the page height. */
async function tileState(page: Page): Promise<{ lit: boolean[]; names: string[]; example: boolean[]; height: number }> {
  return page.evaluate(() => {
    const tiles = [...document.querySelectorAll("#types article.poster")];
    return {
      lit: tiles.map((t) => t.hasAttribute("data-lit")),
      names: tiles.map((t) => [...t.querySelectorAll("button, a[href]")].map((b) => (b.textContent ?? "").trim()).join("|")),
      example: tiles.map((t) => { const ex = t.querySelector(".p-ex"); return ex !== null && ex.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); }),
      height: document.documentElement.scrollHeight,
    };
  });
}

/** The follow-spot (#types::before): its computed look and whether it is switched on. */
async function spot(page: Page): Promise<{ on: boolean; display: string; position: string; blend: string; width: string; image: string; duration: string }> {
  return page.evaluate(() => {
    const types = document.getElementById("types");
    const s = getComputedStyle(types ?? document.body, "::before");
    return { on: types?.hasAttribute("data-spot") ?? false, display: s.display, position: s.position, blend: s.mixBlendMode, width: s.width, image: s.backgroundImage.slice(0, 15), duration: s.transitionDuration };
  });
}

test("[integration] UX3 c02 the four tiles are controls: each title is a button named for its tile; the gold follow-spot travels from the marquee to Yes or no once the curtain opens and holds there with a ring and a Start here chip; hover or focus moves it", async () => {
  for (const [width, height] of [[1280, 900], [390, 844]] as [number, number][]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect({ width, names: (await tileState(page)).names }).toEqual({ width, names: TILE_NAMES });
      // Nothing is lit behind the closed curtain.
      expect({ width, spot: (await spot(page)).on, lit: (await tileState(page)).lit }).toEqual({ width, spot: false, lit: [false, false, false, false] });
      await openOntoResults(page);
      await page.waitForFunction(() => document.querySelector("#types article.poster")?.hasAttribute("data-lit") === true, undefined, { timeout: 3000 });
      await page.waitForTimeout(400);
      // It travelled there over 900 ms and holds.
      expect(await spot(page)).toEqual({ on: true, display: "block", position: "fixed", blend: "screen", width: "520px", image: "radial-gradient", duration: "0.9s, 0.4s" });
      const start = await page.evaluate(() => {
        const tile = document.querySelector("#types article.poster");
        const chip = tile?.querySelector(".p-chip");
        return { chip: chip?.textContent ?? "", shown: chip?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ?? false, ring: getComputedStyle(tile ?? document.body).boxShadow.includes("rgb(255, 230, 166)") };
      });
      expect({ width, start }).toEqual({ width, start: { chip: "Start here: Yes or no", shown: true, ring: true } });
      const before = (await tileState(page)).height;
      // Hover moves the light to the tile under the pointer in 350 ms and changes a computed style on every tile.
      for (let i = 0; i < 4; i++) {
        const tile = page.locator("#types article.poster").nth(i);
        await tile.scrollIntoViewIfNeeded();
        await page.mouse.move(1, 1);
        await page.waitForTimeout(400);
        const look = (): Promise<string> => tile.evaluate((n) => { const s = getComputedStyle(n); return [s.transform, s.boxShadow, s.borderTopColor, s.filter].join("|"); });
        const was = await look();
        const s0 = (await spot(page)).duration;
        await tile.hover({ position: { x: 20, y: 20 } });
        await page.waitForTimeout(500);
        expect({ width, i, changed: (await look()) !== was, lit: (await tileState(page)).lit[i], dur: await spot(page).then((s) => s.duration) }).toEqual({ width, i, changed: true, lit: true, dur: i === 0 ? s0 : "0.35s, 0.4s" });
      }
      // Focus moves it too; the title button opens the tile's one-line example, which takes no room on the page.
      await page.locator("#types article.poster").nth(1).locator("button.p-name").focus();
      expect((await tileState(page)).lit).toEqual([false, true, false, false]);
      await page.keyboard.press("Enter");
      const opened = await tileState(page);
      expect({ width, example: opened.example, expanded: await page.locator("#types article.poster").nth(1).locator("button.p-name").getAttribute("aria-expanded"), height: opened.height }).toEqual({ width, example: [false, true, false, false], expanded: "true", height: before });
      expect(await page.locator("#types article.poster").nth(1).locator(".p-ex").innerText()).toMatch(/^Example: /);
      // Lighting another tile closes the first one's example.
      await page.locator("#types article.poster").nth(3).locator("button.p-name").focus();
      expect((await tileState(page)).example).toEqual([false, false, false, false]);
    } finally { await page.close(); }
  }
}, 40000);

test("[integration] UX4 c02 on a touch screen a tap on a tile moves the light there and shows its one-line example; the picture's own tap still works", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "no-preference" });
  const page = await context.newPage();
  try {
    await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.port}/#types`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
    const caption = page.locator("#types article.poster").nth(2).locator(".p-cap");
    await caption.scrollIntoViewIfNeeded();
    await caption.tap();
    const after = await tileState(page);
    expect({ lit: after.lit, example: after.example }).toEqual({ lit: [false, false, true, false], example: [false, false, true, false] });
    const pin = await page.evaluate(() => document.getElementById("pin")?.style.transform ?? "");
    await page.locator('#rungs [data-i="2"]').tap();
    expect(await page.evaluate(() => document.getElementById("pin")?.style.transform ?? "")).not.toBe(pin);
  } finally { await context.close(); }
}, 20000);

test("[integration] UX5 c02 under reduced motion there is no follow-spot and nothing travels: Yes or no carries a static ring and the Start here chip from load, and the tiles have no transitions", async () => {
  for (const [width, height] of [[1280, 900], [390, 844]] as [number, number][]) {
    const page = await pageAt(width, height, "reduce");
    try {
      expect({ width, display: (await spot(page)).display }).toEqual({ width, display: "none" });
      const look = await page.evaluate(() => [...document.querySelectorAll("#types article.poster")].map((t) => ({
        lit: t.hasAttribute("data-lit"), chip: t.querySelector(".p-chip") !== null, moves: getComputedStyle(t).transitionDuration.split(",").some((d) => parseFloat(d) > 0),
      })));
      expect({ width, look }).toEqual({ width, look: [{ lit: true, chip: true, moves: false }, ...[1, 2, 3].map(() => ({ lit: false, chip: false, moves: false }))] });
      expect(await page.locator("#types article.poster").first().evaluate((n) => getComputedStyle(n).boxShadow.includes("rgb(255, 230, 166)"))).toBe(true);
    } finally { await page.close(); }
  }
}, 30000);

/** Whether each of the four tiles could be seen (CSS visibility and opacity, not occlusion). */
async function tilesShown(page: Page): Promise<boolean[]> {
  return page.locator("#types article.poster").evaluateAll((nodes) => nodes.map((n) => n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })));
}

test("[integration] UX6 c03 while the curtain parts the four tiles wait hidden, so no panel crops them: hidden at reveal 0.2, 0.4, 0.6 and 0.8 by a real scroll and when --reveal is set directly; all four show once it is open", async () => {
  for (const [width, height] of FIRST_SCREENS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect({ width, closed: await tilesShown(page) }).toEqual({ width, closed: [false, false, false, false] });
      for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
        await scrollToRunway(page, fraction);
        expect({ width, fraction, state: (await curtain(page)).state, tiles: await tilesShown(page) }).toEqual({ width, fraction, state: "rising", tiles: [false, false, false, false] });
      }
      // The rule reads html[data-curtain], not the script's progress: set from outside, it still holds.
      await page.evaluate(() => { document.documentElement.style.setProperty("--reveal", "0.5"); document.documentElement.dataset.curtain = "rising"; });
      expect({ width, direct: await tilesShown(page) }).toEqual({ width, direct: [false, false, false, false] });
      await scrollToRunway(page, 1.2);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      expect({ width, open: await tilesShown(page) }).toEqual({ width, open: [true, true, true, true] });
    } finally { await page.close(); }
  }
}, 40000);

test("[integration] UX7 c04 a scene not yet lit stays readable (its lit parts at opacity 0.6 or more, each with a box, lighting after 0.15 s); the scene nearest the middle of the screen gets the lamp (a warm heading glow and a gold bar), and a passed scene settles at 0.85", async () => {
  for (const [width, height] of [[1280, 800], [390, 844]] as [number, number][]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      const unlit = await page.evaluate(() => [...document.querySelectorAll("#story .frame:not(.on) .lit")].map((n) => {
        const r = n.getBoundingClientRect(), s = getComputedStyle(n);
        return { opacity: Number(s.opacity), box: r.width > 0 && r.height > 0 && s.display !== "none", delay: s.transitionDelay };
      }));
      expect({ width, count: unlit.length > 0, low: unlit.filter((u) => u.opacity < 0.6).length, boxless: unlit.filter((u) => !u.box).length, delays: [...new Set(unlit.map((u) => u.delay))] })
        .toEqual({ width, count: true, low: 0, boxless: 0, delays: ["0.15s"] });
      await openOntoResults(page);
      const lamp = async (i: number): Promise<{ lit: number[]; glow: boolean; bar: string; passed: number[] }> => {
        await page.evaluate((n) => { document.querySelectorAll("#story .frame")[n]?.scrollIntoView({ block: "center", behavior: "instant" }); }, i);
        await page.waitForTimeout(1300);
        return page.evaluate((n) => {
          const frames = [...document.querySelectorAll("#story .frame")];
          const cap = frames[n]?.querySelector(".cap");
          const words = frames[n]?.querySelector(".words");
          return {
            lit: frames.flatMap((f, k) => f.hasAttribute("data-lit") ? [k] : []),
            glow: cap ? getComputedStyle(cap).textShadow !== "none" : false,
            bar: words ? getComputedStyle(words, "::before").backgroundColor : "",
            passed: frames.slice(0, n).flatMap((f) => [...f.querySelectorAll(".lit")].map((p) => Number(getComputedStyle(p).opacity))),
          };
        }, i);
      };
      const first = await lamp(0);
      expect({ width, lit: first.lit, glow: first.glow, bar: first.bar }).toEqual({ width, lit: [0], glow: true, bar: "rgb(224, 176, 78)" });
      const second = await lamp(1);
      expect({ width, lit: second.lit, glow: second.glow }).toEqual({ width, lit: [1], glow: true });
      const third = await lamp(2);
      expect({ width, lit: third.lit, passed: [...new Set(third.passed)] }).toEqual({ width, lit: [2], passed: [0.85] });
    } finally { await page.close(); }
  }
}, 40000);

test("[integration] V4 the curtain poster opens the curtain, like Raise the curtain, and never navigates: a click on the poster or its Open the curtain button, and Enter or Space on the focused button", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    for (const how of ["poster click", "button click", "Enter", "Space"]) {
      const page = await pageAt(width, height, "no-preference");
      try {
        const before = page.url();
        const button = page.getByRole("button", { name: "Open the curtain", exact: true });
        expect({ width, how, state: (await curtain(page)).state }).toEqual({ width, how, state: "closed" });
        if (how === "poster click") await page.locator("#overture .poster .p-title").click();
        else if (how === "button click") await button.click();
        else { await button.focus(); await page.keyboard.press(how); }
        await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
        const after = await page.evaluate(() => ({ state: document.documentElement.dataset.curtain, focus: document.activeElement?.id ?? "" }));
        expect({ width, how, state: after.state, focus: after.focus, url: page.url() }).toEqual({ width, how, state: "open", focus: "types", url: before });
        expect(new URL(page.url()).pathname).not.toMatch(/little-shop/);
      } finally { await page.close(); }
    }
  }
}, 60000);

test("[integration] V5 mid-reveal the pictures' section shows in the gap between the parting curtains and its four tiles wait hidden (c03): at reveal 0.4 and 0.7 the pointer in the gap reaches the section, never a tile, at 1280, 1440 and 390, in both themes", async () => {
  const checks: [number, number, number, string][] = [[1280, 900, 0.4, "light"], [1440, 900, 0.4, "light"], [390, 844, 0.4, "light"], [1440, 900, 0.7, "light"], [390, 844, 0.7, "light"], [1440, 900, 0.7, "dark"]];
  for (const [width, height, fraction, theme] of checks) {
    const page = await pageAt(width, height, "no-preference");
    try {
      await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, theme);
      await scrollToRunway(page, fraction);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising");
      expect(Math.abs((await curtain(page)).reveal - fraction)).toBeLessThan(0.02);
      expect({ width, fraction, theme, hit: await gapHit(page), tiles: await tilesShown(page) }).toEqual({ width, fraction, theme, hit: "pictures", tiles: [false, false, false, false] });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] V6 once open nothing of the opening is left: back at the top the house bar, marquee and results show, with no screen-high block", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) for (const how of ["keys", "scroll"]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      if (how === "keys") await openOntoResults(page);
      else await scrollToRunway(page, 1.2);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
      await page.evaluate(() => { window.scrollTo({ top: 0, behavior: "instant" }); });
      await frames(page);
      const view = await page.evaluate(() => {
        // A screen-high block: a direct child of body, other than header, main and footer, that is shown on screen, at
        // least 0.9 of the viewport tall, and either takes space in the flow or paints a background.
        const blocks = [...document.body.children].filter((node) => !["HEADER", "MAIN", "FOOTER", "SCRIPT"].includes(node.tagName)).filter((node) => {
          const s = getComputedStyle(node), r = node.getBoundingClientRect();
          const painted = s.backgroundImage !== "none" || !/^(transparent|rgba\(.*,\s*0\))$/.test(s.backgroundColor);
          const inFlow = ["static", "relative", "sticky"].includes(s.position);
          return s.display !== "none" && s.visibility !== "hidden" && r.height >= 0.9 * innerHeight && r.bottom > 0 && r.top < innerHeight && (painted || inFlow);
        }).map((node) => `${node.tagName}#${node.id}.${node.className}`);
        const top = (selector: string): number => document.querySelector(selector)?.getBoundingClientRect().top ?? NaN;
        const ov = document.getElementById("overture");
        return { blocks, overture: ov ? getComputedStyle(ov).display : "missing", house: top(".house"), band: document.getElementById("tmFirst")?.getBoundingClientRect().bottom ?? 0, marquee: top("main .marquee"), results: top("#types .kick"), y: scrollY };
      });
      expect({ width, how, blocks: view.blocks, overture: view.overture, y: view.y }).toEqual({ width, how, blocks: [], overture: "none", y: 0 });
      // The house bar follows the first-screen band directly: nothing of the opening is left between them.
      expect(Math.abs(view.house - view.band)).toBeLessThan(1);
      expect(view.marquee > 0 && view.marquee < height && view.results > view.marquee && view.results < height).toBe(true);
    } finally { await page.close(); }
  }
}, 30000);

/** The results heading's top and bottom on screen, and any horizontal overflow of the page. */
async function headingView(page: Page): Promise<{ top: number; bottom: number; overflow: number }> {
  return page.evaluate(() => {
    const r = document.querySelector("#types .kick")?.getBoundingClientRect();
    return { top: r ? r.top : NaN, bottom: r ? r.bottom : NaN, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
}

test("[integration] V7 the page holds still while the curtain parts: at least half a screen of scroll from closed to open, the results heading unmoved, in view at open, then the page scrolls on", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      const closed = await headingView(page);
      const distance = await runway(page);
      const moved: number[] = [];
      for (const fraction of [0.3, 0.7]) {
        await scrollToRunway(page, fraction);
        await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising");
        moved.push(Math.round(Math.abs((await headingView(page)).top - closed.top)));
      }
      // One pixel short of the runway the curtain is still parting; at the runway it is open.
      await scrollAtCentre(page, distance - 1);
      const before = await headingView(page);
      const short = (await curtain(page)).state;
      await scrollAtCentre(page, distance);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      const after = await headingView(page);
      expect({
        width, enough: distance >= 0.5 * height ? "yes" : `${distance}px < ${0.5 * height}px`, short, still: moved.every((m) => m < 1) ? "yes" : moved,
        inView: after.top >= 0 && after.bottom <= height ? "yes" : `top ${Math.round(after.top)}`, jump: Math.abs(after.top - before.top) < 4 ? "no" : `${Math.round(after.top - before.top)}px`,
        overflow: [closed.overflow, before.overflow, after.overflow],
      }).toEqual({ width, enough: "yes", short: "rising", still: "yes", inView: "yes", jump: "no", overflow: [0, 0, 0] });
      // Open, the page scrolls natively from where it stands.
      const y = await page.evaluate(() => scrollY);
      await page.evaluate(() => { window.scrollBy({ top: 120, behavior: "instant" }); });
      await frames(page);
      expect(Math.round(after.top - (await headingView(page)).top)).toBe(Math.round(await page.evaluate(() => scrollY) - y));
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(y);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] V9 short screens (390x600, 390x560, 740x600, 844x390) and 390x844 fit the closed curtain: the whole marquee on screen and clear of the chip, the Mad TokenMax poster and its ticket and the Little Shop poster's Open the curtain on screen and reachable, no horizontal scroll", async () => {
  const shorts: [number, number][] = [[390, 844], [390, 600], [390, 560], [740, 600], [844, 390]];
  for (const [width, height] of shorts) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      const fit = await page.evaluate(() => {
        const box = (selector: string): DOMRect | null => document.querySelector(selector)?.getBoundingClientRect() ?? null;
        const inside = (r: DOMRect | null): boolean => r !== null && r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        const meets = (a: DOMRect | null, b: DOMRect | null): boolean => a !== null && b !== null && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        // The pointer at the middle of `selector` reaches `owner` (the control that acts) or something inside it.
        const reach = (selector: string, owner: string): boolean => {
          const node = document.querySelector(selector), control = document.querySelector(owner), r = node?.getBoundingClientRect();
          if (!node || !control || !r) return false;
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit !== null && (hit === control || control.contains(hit));
        };
        const marquee = box("#overture .marquee"), title = box("#overture .marquee .billing"), chip = box("#sampleBadge");
        return {
          marqueeTop: marquee ? Math.round(marquee.top) : NaN, marquee: inside(marquee), chipClear: !meets(chip, marquee) && !meets(chip, title),
          ticket: inside(box("#overture .ticket")) && reach("#overture .ticket", '#overture a[href="tm/"]'), seat: inside(box("#overture .poster .p-cta")) && reach("#overture .poster .p-cta", "#overture .poster .p-cta"),
          madmax: inside(box('#overture a[href="tm/"]')) && reach('#overture a[href="tm/"]', '#overture a[href="tm/"]'),
          poster: inside(box("#overture .poster")), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect({ width, height, ...fit, marqueeTop: fit.marqueeTop >= 0 }).toEqual({ width, height, marqueeTop: true, marquee: true, chipClear: true, ticket: true, seat: true, madmax: true, poster: true, overflow: 0 });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] V8 at 390x844 mid-reveal the sample chip covers no visible in-page text; House lights works closed and open", async () => {
  const page = await pageAt(390, 844, "no-preference");
  try {
    const theme = () => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await page.locator("#lights").click();
    const lit = await theme();
    expect({ state: (await curtain(page)).state, lit: ["light", "dark"].includes(lit ?? "") }).toEqual({ state: "closed", lit: true });
    for (const fraction of [0.15, 0.3, 0.5, 0.7, 0.9]) {
      await scrollToRunway(page, fraction);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising");
      const covered = await page.evaluate(() => {
        const chip = document.getElementById("sampleBadge"), ov = document.getElementById("overture");
        if (!chip || !ov) return ["missing chip or curtain"];
        let opacity = 1;
        for (let el: Element | null = chip; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
        const c = chip.getBoundingClientRect();
        if (opacity === 0 || getComputedStyle(chip).visibility !== "visible" || c.width === 0) return [];
        const [cl, cr] = [...document.querySelectorAll(".overture .curtain")].map((node) => node.getBoundingClientRect());
        const gapLeft = Math.max(0, cl ? cl.right : 0), gapRight = Math.min(innerWidth, cr ? cr.left : innerWidth);
        const shown = (el: Element): boolean => {
          for (let e: Element | null = el; e; e = e.parentElement) {
            const s = getComputedStyle(e);
            if (s.display === "none" || s.visibility !== "visible" || Number(s.opacity) === 0) return false;
          }
          return true;
        };
        const out: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement, text = (node.textContent ?? "").trim();
          if (!parent || !text || ov.contains(parent) || chip.contains(parent) || !shown(parent)) continue;
          // The body of a closed disclosure is not shown (its text still reports laid-out boxes); its summary is.
          const closed = parent.closest("details:not([open])");
          if (closed && !parent.closest("summary")) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of range.getClientRects()) {
            // The part of the text a viewer can see: inside the viewport and in the gap between the curtains.
            const left = Math.max(r.left, gapLeft, 0), right = Math.min(r.right, gapRight, innerWidth), top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
            if (right > left && bottom > top && c.left < right && c.right > left && c.top < bottom && c.bottom > top) { out.push(text.slice(0, 40)); break; }
          }
        }
        return out;
      });
      expect({ fraction, covered }).toEqual({ fraction, covered: [] });
    }
    await scrollToRunway(page, 1.2);
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
    await page.locator("#lights").click();
    expect({ state: (await curtain(page)).state, flipped: (await theme()) !== lit }).toEqual({ state: "open", flipped: true });
  } finally { await page.close(); }
}, 30000);

/** A page on a touch screen (hasTouch), in curtain mode. Close it with page.context().close(). */
async function touchPageAt(width: number, height: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "no-preference", hasTouch: true });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#tkPosters .tk-poster").length > 0);
  return page;
}

/** A real one-finger swipe from (x, fromY) to (x, toY), through the browser's touch input. */
async function swipe(page: Page, x: number, fromY: number, toY: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: fromY + (toY - fromY) * i / 8 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
  await page.waitForTimeout(150);
  await frames(page);
}

/** Where the page stands: its scrollY, the curtain's state, and the results heading's top. */
async function stand(page: Page): Promise<{ y: number; state: string; top: number }> {
  return page.evaluate(() => ({ y: scrollY, state: document.documentElement.dataset.curtain ?? "unset", top: document.getElementById("types")?.getBoundingClientRect().top ?? NaN }));
}

/**
 * Repeats `step` until the curtain is open (at most `limit` times). Returns the number of steps, the largest scrollY
 * seen before open, the heading's largest move before open, and where the page stood at the moment it opened (recorded in
 * the page as html[data-curtain] turns open, before any later input moves the open page).
 */
async function stepToOpen(page: Page, step: () => Promise<void>, limit: number): Promise<{ steps: number; yBefore: number; moved: number; open: { y: number; state: string; top: number } }> {
  await page.evaluate(() => {
    const root = document.documentElement;
    new MutationObserver(() => {
      if (root.dataset.curtain !== "open" || root.dataset.testOpen) return;
      root.dataset.testOpen = `${scrollY} ${document.getElementById("types")?.getBoundingClientRect().top ?? NaN}`;
    }).observe(root, { attributes: true, attributeFilter: ["data-curtain"] });
  });
  const closed = await stand(page);
  const atOpen = async (): Promise<{ y: number; state: string; top: number } | null> => {
    const mark = await page.evaluate(() => document.documentElement.dataset.testOpen ?? "");
    if (!mark) return null;
    const [y, top] = mark.split(" ").map(Number);
    return { y: y ?? NaN, state: "open", top: top ?? NaN };
  };
  let yBefore = 0, moved = 0, steps = 0;
  for (; steps < limit; ) {
    await step();
    steps++;
    const opened = await atOpen();
    if (opened) return { steps, yBefore, moved, open: opened };
    const now = await stand(page);
    yBefore = Math.max(yBefore, now.y);
    moved = Math.max(moved, Math.round(Math.abs(now.top - closed.top)));
  }
  return { steps, yBefore, moved, open: await stand(page) };
}

test("[integration] V10 every way of scrolling drives the curtain's runway and the page stays at scrollY 0 until it opens: PageDown, Space and End on the page, ArrowDown from the Mad TokenMax poster, a wheel and a swipe over the sample chip, a real wheel and a real swipe over the curtain", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    // PageDown from the page: one press parts it without moving the page; more presses open it with the heading in view.
    const page = await pageAt(width, height, "no-preference");
    try {
      const closed = await stand(page);
      await page.keyboard.press("PageDown");
      await frames(page);
      const once = await stand(page);
      expect({ width, key: "PageDown", state: once.state, y: once.y, moved: Math.round(Math.abs(once.top - closed.top)) }).toEqual({ width, key: "PageDown", state: "rising", y: 0, moved: 0 });
      const run = await stepToOpen(page, async () => { await page.keyboard.press("PageDown"); await frames(page); }, 8);
      expect({ width, key: "PageDown", yBefore: run.yBefore, moved: run.moved, state: run.open.state, y: run.open.y, inView: run.open.top >= 0 && run.open.top < height })
        .toEqual({ width, key: "PageDown", yBefore: 0, moved: 0, state: "open", y: 0, inView: true });
    } finally { await page.close(); }
    // Space parts it the same way; End opens it.
    const keys = await pageAt(width, height, "no-preference");
    try {
      await keys.keyboard.press("Space");
      await frames(keys);
      expect({ width, key: "Space", ...(await stand(keys)), top: 0 }).toEqual({ width, key: "Space", y: 0, state: "rising", top: 0 });
      await keys.keyboard.press("End");
      await frames(keys);
      const end = await stand(keys);
      expect({ width, key: "End", y: end.y, state: end.state, inView: end.top >= 0 && end.top < height }).toEqual({ width, key: "End", y: 0, state: "open", inView: true });
    } finally { await keys.close(); }
    // ArrowDown with focus on the Mad TokenMax poster scrolls the curtain natively; when the playbill fades it opens onto the results.
    const arrows = await pageAt(width, height, "no-preference");
    try {
      // The first Tab stop is the first curtain poster.
      await tabToCurtain(arrows);
      const run = await stepToOpen(arrows, async () => { await arrows.keyboard.press("ArrowDown"); await arrows.waitForTimeout(40); await frames(arrows); }, 40);
      expect({ width, key: "ArrowDown", yBefore: run.yBefore, moved: run.moved, state: run.open.state, inView: run.open.top >= -1 && run.open.top < height, focus: await arrows.evaluate(() => document.activeElement?.id) })
        .toEqual({ width, key: "ArrowDown", yBefore: 0, moved: 0, state: "open", inView: true, focus: "types" });
    } finally { await arrows.close(); }
  }
  // A wheel over the sample chip (off the curtain) moves the runway, never the page; then a real wheel over the curtain.
  const wheel = await pageAt(1440, 900, "no-preference");
  try {
    const chip = await wheel.locator("#sampleBadge").boundingBox();
    if (!chip) throw new Error("no chip");
    await wheel.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
    await wheel.mouse.wheel(0, 100);
    await wheel.waitForFunction(() => document.documentElement.dataset.curtain === "rising", undefined, { timeout: 3000 });
    expect((await stand(wheel)).y).toBe(0);
    await wheel.mouse.move(720, 450);
    const run = await stepToOpen(wheel, async () => { await wheel.mouse.wheel(0, 100); await wheel.waitForTimeout(120); await frames(wheel); }, 20);
    expect({ input: "wheel", yBefore: run.yBefore, moved: run.moved, state: run.open.state, y: run.open.y, inView: run.open.top >= 0 && run.open.top < 900 })
      .toEqual({ input: "wheel", yBefore: 0, moved: 0, state: "open", y: 0, inView: true });
  } finally { await wheel.close(); }
  // A swipe that starts on the sample chip moves the runway, never the page; then real swipes over the curtain.
  const touch = await touchPageAt(390, 844);
  try {
    const chip = await touch.locator("#sampleBadge").boundingBox();
    if (!chip) throw new Error("no chip");
    await swipe(touch, chip.x + chip.width / 2, chip.y + chip.height / 2 + 200, chip.y + chip.height / 2);
    await swipe(touch, chip.x + chip.width / 2, chip.y + chip.height / 2, chip.y + chip.height / 2 - 30);
    const first = await stand(touch);
    expect({ input: "swipe on chip", y: first.y, state: first.state }).toEqual({ input: "swipe on chip", y: 0, state: "rising" });
    const run = await stepToOpen(touch, () => swipe(touch, 195, 600, 400), 12);
    expect({ input: "swipe", yBefore: run.yBefore, moved: run.moved, state: run.open.state, y: run.open.y, inView: run.open.top >= 0 && run.open.top < 844 })
      .toEqual({ input: "swipe", yBefore: 0, moved: 0, state: "open", y: 0, inView: true });
  } finally { await touch.context().close(); }
}, 60000);

test("[integration] V11 when the playbill fades with focus on a curtain poster, focus is not dropped: the curtain opens onto the results and the results heading has focus", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      // The first Tab stop is the first curtain poster.
      await tabToCurtain(page);
      await scrollToRunway(page, 0.5);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      const after = await page.evaluate(() => ({ focus: document.activeElement?.id ?? "BODY", top: document.getElementById("types")?.getBoundingClientRect().top ?? NaN }));
      expect({ width, focus: after.focus, inView: after.top >= -1 && after.top < height }).toEqual({ width, focus: "types", inView: true });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] V12 a curtain script that stalls (never answers) does not leave the page closed: within the watchdog's bound it opens and scrolls, and a late script leaves it open", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await page.route("**/theatre.js", async (route) => { await gate; await route.continue(); });
    const start = Date.now();
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "commit" });
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 6000 });
    expect(Date.now() - start).toBeLessThan(6000);
    expect(await page.evaluate(() => document.documentElement.classList.contains("overture-play"))).toBe(false);
    expect(await shownCurtains(page)).toBe(0);
    await page.evaluate(() => { window.scrollTo({ top: 300, behavior: "instant" }); });
    expect(await page.evaluate(() => scrollY)).toBe(300);
    release();
    // shows/office.js runs after theatre.js: its cards mean the late curtain script has run.
    await page.waitForFunction(() => document.querySelectorAll("#tkPosters .tk-poster").length > 0, undefined, { timeout: 5000 });
    expect({ state: (await curtain(page)).state, shown: await shownCurtains(page), y: await page.evaluate(() => scrollY) }).toEqual({ state: "open", shown: 0, y: 300 });
  } finally { release(); await page.close(); }
}, 20000);

test("[integration] V13 focus already outside the curtain when the curtain script runs opens it at once", async () => {
  await onHeld(390, 844, "no-preference", async ({ page, release, ready }) => {
    await page.waitForFunction(() => document.getElementById("officeOpen") !== null);
    await page.evaluate(() => { document.getElementById("officeOpen")?.focus({ preventScroll: true }); });
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("officeOpen");
    release();
    await ready();
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
    expect({ shown: await shownCurtains(page), focus: await page.evaluate(() => document.activeElement?.id) }).toEqual({ shown: 0, focus: "officeOpen" });
  });
}, 20000);

test("[integration] V14 a resize mid-reveal keeps the curtain's scroll in step with its progress: no dead scroll after it", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    await scrollToRunway(page, 0.635);
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising");
    const before = (await curtain(page)).reveal;
    await page.setViewportSize({ width: 1440, height: 500 });
    await page.waitForFunction(() => Number(document.documentElement.dataset.runway) === 350, undefined, { timeout: 3000 });
    await frames(page);
    const at = await page.evaluate(() => document.getElementById("overture")?.scrollTop ?? NaN);
    expect(Math.abs(at - before * 350)).toBeLessThan(3);
    expect(Math.abs((await curtain(page)).reveal - before)).toBeLessThan(0.005);
    await page.evaluate(() => { document.getElementById("overture")?.scrollBy({ top: 20, behavior: "instant" }); });
    await frames(page);
    expect((await curtain(page)).reveal).toBeGreaterThan(before + 0.04);
  } finally { await page.close(); }
}, 20000);

test("[integration] V15 once the playbill has faded the page in the gap takes the pointer: the pictures' section is what the pointer reaches (its tiles wait hidden, c03), and a click on it there opens the curtain", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    await scrollToRunway(page, 0.5);
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising" && document.getElementById("overture")?.classList.contains("faded") === true);
    expect(await gapHit(page)).toBe("pictures");
    // Where a picture control sits in the gap (hidden while the curtain parts, c03): a click there lands on the section,
    // which takes focus (tabindex -1), and focus on the page opens the curtain.
    const point = await page.evaluate(() => {
      const [cl, cr] = [...document.querySelectorAll(".overture .curtain")].map((node) => node.getBoundingClientRect());
      const left = cl ? cl.right : 0, right = cr ? cr.left : innerWidth;
      const control = [...document.querySelectorAll("#types .hit")].map((n) => n.getBoundingClientRect()).find((r) => r.right > left + 8 && r.left < right - 8 && r.bottom > 8 && r.top < innerHeight - 8);
      return control ? { x: (Math.max(left, control.left) + Math.min(right, control.right)) / 2, y: (Math.max(0, control.top) + Math.min(innerHeight, control.bottom)) / 2 } : null;
    });
    expect(point).not.toBeNull();
    if (point) await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
  } finally { await page.close(); }
}, 20000);

test("[integration] V17 a scroll that opens the curtain in one go with focus on a curtain poster moves focus to the results heading; the same scroll without focus on the curtain leaves the page at scrollY 0", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) for (const how of ["wheel", "scrollTop"]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      // The first Tab stop is the first curtain poster.
      await tabToCurtain(page);
      const distance = await runway(page);
      if (how === "wheel") {
        await page.mouse.move(width / 2, height / 2 + 50);
        await page.mouse.wheel(0, distance + 400);
      } else {
        await page.evaluate((top) => { document.getElementById("overture")?.scrollTo({ top, behavior: "instant" }); }, distance + 400);
      }
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ focus: document.activeElement?.id || document.activeElement?.tagName || "", top: document.getElementById("types")?.getBoundingClientRect().top ?? NaN }));
      expect({ width, how, focus: after.focus, inView: after.top >= -1 && after.top < height }).toEqual({ width, how, focus: "types", inView: true });
    } finally { await page.close(); }
  }
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      const distance = await runway(page);
      await page.mouse.move(width / 2, height / 2 + 50);
      await page.mouse.wheel(0, distance + 400);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ focus: document.activeElement?.id || document.activeElement?.tagName || "", y: scrollY }));
      expect({ width, unfocused: true, ...after }).toEqual({ width, unfocused: true, focus: "BODY", y: 0 });
    } finally { await page.close(); }
  }
}, 40000);

test("[integration] L23 scrolling parts the curtain in step with the scroll, and the four pictures show once it is open", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).reveal === 0).toBe(true);
      await scrollToRunway(page, 0.3);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising");
      const mid = await curtain(page);
      expect(Math.abs(mid.reveal - 0.3)).toBeLessThan(0.02);
      const view = await viewCurtains(page);
      expect(view).toHaveLength(2);
      for (const c of view) expect(c.onScreen > 0 && c.onScreen < width / 2).toBe(true);
      await scrollToRunway(page, 1);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
      expect(await shownCurtains(page)).toBe(0);
      expect(allShown(await pictureBoxes(page))).toBe(true);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] L24 the curtain follows the scroll both ways: partial progress goes back, and an opened page never scrolled away stays open at the top", async () => {
  const page = await pageAt(390, 844, "no-preference");
  try {
    await scrollToRunway(page, 0.45);
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising");
    expect(Math.abs((await curtain(page)).reveal - 0.45)).toBeLessThan(0.02);
    await scrollToRunway(page, 0.15);
    await frames(page);
    const back = await curtain(page);
    expect({ state: back.state, near: Math.abs(back.reveal - 0.15) < 0.02 }).toEqual({ state: "rising", near: true });
    await scrollToRunway(page, 1.2);
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
    // A page that was never scrolled away from its top stays open, a 1px bounce included.
    await scrollToVh(page, 1 / 844);
    await scrollToVh(page, 0);
    await frames(page);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect((await curtain(page)).state).toBe("open");
    expect(await shownCurtains(page)).toBe(0);
    expect(allShown(await pictureBoxes(page))).toBe(true);
    // The reverse scroll keys move the runway back, as the wheel does (the page is reloaded closed first).
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.evaluate(() => { try { window.sessionStorage.removeItem("jnj-overture"); } catch (e) { /* ignore */ } });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Number(document.documentElement.dataset.runway) > 0);
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
    await frames(page);
    const down = (await curtain(page)).reveal;
    expect(down).toBeGreaterThan(0.1);
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowUp");
    await frames(page);
    expect((await curtain(page)).reveal).toBeLessThan(down - 0.05);
  } finally { await page.close(); }
}, 15000);

test("[integration] L26 the Mad TokenMax poster is the first tab stop on the curtain with a visible focus ring; Tab goes Mad TokenMax, Little Shop, Raise the curtain (where shown), House lights with the curtain closed; focus anywhere else opens it", async () => {
  const page = await pageAt(1280, 900, "no-preference");
  try {
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() => {
      const a = document.activeElement;
      const s = a ? getComputedStyle(a) : null;
      return { madmax: Boolean(a?.matches('#overture a[href="tm/"]')), ring: Boolean(a?.matches(":focus-visible") && s && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2), state: document.documentElement.dataset.curtain };
    });
    expect(first).toEqual({ madmax: true, ring: true, state: "closed" });
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => ({
      poster: document.activeElement?.matches("#overture .poster button.p-cta") ?? false,
      state: document.documentElement.dataset.curtain,
    }))).toEqual({ poster: true, state: "closed" });
    const where = () => page.evaluate(() => ({ id: document.activeElement?.id ?? "", state: document.documentElement.dataset.curtain }));
    // Raise the curtain (c01) follows Little Shop where the curtain has room for it.
    const raise = await page.evaluate(() => getComputedStyle(document.getElementById("raise") ?? document.body).display !== "none");
    await page.keyboard.press("Tab");
    if (raise) {
      expect(await where()).toEqual({ id: "raise", state: "closed" });
      await page.keyboard.press("Tab");
    }
    expect(await where()).toEqual({ id: "lights", state: "closed" });
    await page.keyboard.press("Shift+Tab");
    if (raise) {
      expect(await where()).toEqual({ id: "raise", state: "closed" });
      await page.keyboard.press("Shift+Tab");
    }
    expect(await page.evaluate(() => document.activeElement?.matches("#overture .poster button.p-cta") ?? false)).toBe(true);
    await page.keyboard.press("Tab");
    if (raise) await page.keyboard.press("Tab");
    expect(await where()).toEqual({ id: "lights", state: "closed" });
    // The Program (guide) link rides the closed curtain beside the chip (#378): focus on it keeps the curtain closed.
    await page.keyboard.press("Tab");
    expect(await where()).toEqual({ id: "programLink", state: "closed" });
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => ({
      onCurtain: Boolean(document.getElementById("overture")?.contains(document.activeElement) || document.getElementById("sampleBadge")?.contains(document.activeElement) || document.getElementById("programLink")?.contains(document.activeElement)),
      state: document.documentElement.dataset.curtain,
    }))).toEqual({ onCurtain: false, state: "open" });
    expect(await shownCurtains(page)).toBe(0);
  } finally { await page.close(); }
  // House lights on the closed curtain switch the theme and leave the curtain closed.
  const lit = await pageAt(390, 844, "no-preference");
  try {
    const theme = () => lit.evaluate(() => ({ theme: document.documentElement.getAttribute("data-theme"), state: document.documentElement.dataset.curtain }));
    await lit.locator("#lights").click();
    const once = await theme();
    expect(once.state).toBe("closed");
    expect(["light", "dark"]).toContain(once.theme ?? "");
    await lit.locator("#lights").click();
    const twice = await theme();
    expect({ state: twice.state, flipped: twice.theme !== once.theme }).toEqual({ state: "closed", flipped: true });
    await lit.locator("#officeOpen").focus();
    expect((await curtain(lit)).state).toBe("open");
  } finally { await lit.close(); }
}, 15000);

test("[integration] L27 a #hash deep link loads open, and a hash change opens the curtain at once", async () => {
  const page = await pageAt(390, 844, "no-preference", "#tickets");
  try {
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
    expect(await shownCurtains(page)).toBe(0);
  } finally { await page.close(); }
  const later = await pageAt(390, 844, "no-preference");
  try {
    expect((await curtain(later)).state).toBe("closed");
    await later.evaluate(() => { window.location.hash = "#door"; });
    await later.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
    expect(await shownCurtains(later)).toBe(0);
  } finally { await later.close(); }
}, 15000);

test("[integration] L28 a page that loads already scrolled (a restored position) takes the curtain from there: open past the runway, part-way within it", async () => {
  // 1 screen (the page is shorter without the acts) is past any runway of 0.7 screens; 60px is inside the runway's floor of a quarter screen.
  const cases: [number, string][] = [[844, "open"], [60, "rising"]];
  // Scrolled before the curtain script runs: theatre.js is held at the network while the page above it is laid out.
  for (const [top, state] of cases) {
    await onHeld(390, 844, "no-preference", async ({ page, release, ready }) => {
      await page.waitForFunction(() => document.querySelectorAll("#types article.poster").length === 4 && document.getElementById("door") !== null);
      await page.evaluate((y) => { window.scrollTo({ top: y, behavior: "instant" }); }, top);
      expect(Math.abs(await page.evaluate(() => scrollY) - top)).toBeLessThan(2);
      release();
      await ready();
      await page.waitForFunction((s) => document.documentElement.dataset.curtain === s, state, { timeout: 3000 });
      expect(Math.abs((await curtain(page)).reveal - Math.min(1, top / await runway(page)))).toBeLessThan(0.02);
    });
  }
  // Restored after the curtain script ran, the way a browser restores scroll on reload: a scroll arriving at load.
  for (const [top, state] of cases) {
    const page = await pageAt(390, 844, "no-preference", "", false, undefined, async (p) => {
      await p.addInitScript((y) => {
        document.addEventListener("DOMContentLoaded", () => { window.scrollTo({ top: y, behavior: "instant" }); });
      }, top);
    });
    try {
      await page.waitForFunction((s) => document.documentElement.dataset.curtain === s, state, { timeout: 3000 });
      expect(await page.evaluate(() => document.documentElement.classList.contains("overture-play"))).toBe(true);
      expect(Math.abs((await curtain(page)).reveal - Math.min(1, top / await runway(page)))).toBeLessThan(0.02);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] L17 under reduced motion there is no curtain, even before the curtain script loads; the page is open with full bars and no curtain poster", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    await onHeld(width, height, "reduce", async ({ page, release, ready }) => {
      expect(await page.evaluate(() => document.documentElement.classList.contains("motion"))).toBe(false);
      expect(await shownCurtains(page)).toBe(0);
      expect(await page.locator(MADMAX).isVisible()).toBe(false);
      release();
      await ready();
      expect((await curtain(page)).state).toBe("open");
      expect(await shownCurtains(page)).toBe(0);
      expect(allShown(await pictureBoxes(page))).toBe(true);
      expect(await hitsItself(page, "#t1")).toBe(true);
    });
  }
}, 30000);

test("[integration] L19 turning on reduced motion stops the marquee and drapes, and drops a closed curtain at once", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    const running = () => page.evaluate(() => ({
      bulbs: getComputedStyle(document.querySelector("main .marquee") ?? document.body, "::before").animationName,
      drape: getComputedStyle(document.querySelector(".drape.l") ?? document.body).animationName,
    }));
    expect(await running()).toEqual({ bulbs: "chase", drape: "sway" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await running()).toEqual({ bulbs: "none", drape: "none" });
  } finally { await page.close(); }
  const mid = await pageAt(390, 844, "no-preference");
  try {
    expect(await coversViewport(mid)).toBe(true);
    await mid.emulateMedia({ reducedMotion: "reduce" });
    expect(await shownCurtains(mid)).toBe(0);
    expect(allShown(await pictureBoxes(mid))).toBe(true);
    await mid.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
  } finally { await mid.close(); }
}, 30000);

for (const motion of MOTIONS) {
  test(`[integration] L18 the theatre frame stays once open: valance, marquee and ADMIT ONE ticket, with the marquee above the four pictures (${motion})`, async () => {
    for (const [width, height] of ACTION_VIEWPORTS) {
      const page = await pageAt(width, height, motion);
      try {
        if (motion === "no-preference") await openOntoResults(page);
        await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
        for (const selector of [".valance", "main .marquee", ".house .ticket .admit", ".house .ticket .stub"]) expect(await page.locator(selector).isVisible()).toBe(true);
        expect(await page.locator(".valance").evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
        expect(await page.locator("main .marquee").innerText()).toMatch(/Jev!Jev presents[\s\S]*To Jev or not to Jev/i);
        expect(await page.locator(".house .ticket .admit").innerText()).toBe("ADMIT ONE");
        // The marquee bills the show above the four pictures.
        expect(await page.evaluate(() => {
          const marquee = document.querySelector("main .marquee")?.getBoundingClientRect(), first = document.querySelector("#types article.poster")?.getBoundingClientRect();
          return Boolean(marquee && first && marquee.bottom <= first.top);
        })).toBe(true);
      } finally { await page.close(); }
    }
  }, 30000);
}

test("[integration] L20 the curtain's Little Shop poster is a preview whose one control is a button named Open the curtain, distinct from Raise the curtain; no link on the curtain or the page reaches Little Shop's poster", async () => {
  const page = await pageAt(390, 844, "no-preference");
  try {
    expect(await page.locator("#overture .poster").getAttribute("aria-label")).toBeNull();
    expect(await page.locator('main a[href="little-shop/"], #overture a[href="little-shop/"]').count()).toBe(0);
    expect(await page.getByRole("button", { name: "Open the curtain", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Raise the curtain", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Take your seat", exact: true }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Take your seat", exact: true }).count()).toBe(0);
    const names = await page.locator("a[href]:visible").evaluateAll((links) => links.map((link) => link.getAttribute("aria-label") || link.textContent?.trim() || ""));
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  } finally { await page.close(); }
});

test("[integration] L21 the curtain plays once per tab session, and a page whose storage throws still plays it and renders", async () => {
  const page = await pageAt(390, 844, "no-preference");
  try {
    expect(await page.evaluate(() => document.documentElement.classList.contains("overture-play"))).toBe(true);
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
    const again = await page.evaluate(() => ({
      motion: document.documentElement.classList.contains("motion"),
      play: document.documentElement.classList.contains("overture-play"),
      curtain: document.documentElement.dataset.curtain,
    }));
    expect(again).toEqual({ motion: true, play: false, curtain: "open" });
    expect(await shownCurtains(page)).toBe(0);
    expect(allShown(await pictureBoxes(page))).toBe(true);
    expect(await page.locator(MADMAX).isVisible()).toBe(false);
  } finally { await page.close(); }

  const blocked = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });
  const errors: string[] = [];
  blocked.on("pageerror", (error) => errors.push(error.message));
  try {
    await blocked.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new DOMException("storage blocked", "SecurityError"); } });
    });
    await blocked.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await blocked.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await blocked.waitForFunction(() => document.querySelectorAll("#tkPosters .tk-poster").length > 0);
    expect(await blocked.evaluate(() => {
      try { window.sessionStorage.getItem("x"); return "storage readable"; } catch { return "storage throws"; }
    })).toBe("storage throws");
    // Unknown whether it was seen: play it, and never break the page.
    expect(await blocked.evaluate(() => document.documentElement.classList.contains("overture-play"))).toBe(true);
    expect((await curtain(blocked)).state).toBe("closed");
    expect(await blocked.locator("#t1").isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally { await blocked.close(); }
}, 30000);

test("[integration] L29 with JavaScript off the page is fully readable with no curtain", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    expect(await page.locator("html").getAttribute("class")).toBeNull();
    expect(await page.locator("#overture").isVisible()).toBe(false);
    expect(await page.locator(MADMAX).isVisible()).toBe(false);
    for (const selector of ["#t1", "#types", "#officeOpen"]) expect(await page.locator(selector).isVisible()).toBe(true);
    expect(await hitsItself(page, "#t1")).toBe(true);
  } finally { await context.close(); }
}, 15000);

test("[integration] L30 when the curtain script never loads, the head script's fallback opens the page after load", async () => {
  for (const blocked of ["**/theatre.js", "**/*.js"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });
    try {
      await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
      await page.route(blocked, (route) => route.fulfill({ status: 404, body: "Not found" }));
      await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      expect({ blocked, play: await page.evaluate(() => document.documentElement.classList.contains("overture-play")) }).toEqual({ blocked, play: false });
      expect(await shownCurtains(page)).toBe(0);
      expect(await page.locator(MADMAX).isVisible()).toBe(false);
      expect(await hitsItself(page, "#t1")).toBe(true);
    } finally { await page.close(); }
  }
}, 20000);

test("[integration] L32 the retired acts are gone, and the labels that name the play say four questions", async () => {
  const page = await pageAt(1440, 900);
  try {
    expect(await page.locator("section.act").count()).toBe(0);
    expect(await page.locator("main .marquee").innerText()).toMatch(/in four questions/i);
    expect(await page.locator("#overture .marquee").textContent()).toMatch(/in four questions/i);
  } finally { await page.close(); }
});

test("[integration] L33 with every disclosure closed a loaded file's verdict stays in view, undecided and decisive", async () => {
  const page = await pageAt(390, 844);
  try {
  } finally { await page.close(); }
  // A loaded file: its verdict (here not enough evidence) shows in the loaded result, outside any disclosure.
  const loaded = await pageAt(390, 844);
  try {
    await loaded.locator("#officeOpen").click();
    await loaded.locator("#csv").setInputFiles({ name: "uc13-records.csv", mimeType: "text/csv", buffer: Buffer.from(RECORDS) });
    await loaded.locator("#loadedResult").waitFor({ state: "visible" });
    const current = loaded.locator("#loadedResult");
    expect(await current.isVisible()).toBe(true);
    expect(await current.evaluate((node) => node.closest("details") === null)).toBe(true);
    expect(await current.innerText()).toMatch(/VERDICT PER QUESTION[\s\S]*not enough evidence/i);
  } finally { await loaded.close(); }
  // A loaded file with a decisive verdict: the recorded 100-message shop-bot run (the sample's own source records), whose
  // loader verdict is use Jev. The loaded result names the file and its run beside the verdict, outside any disclosure.
  const decisive = await pageAt(390, 844);
  try {
    await decisive.locator("#officeOpen").click();
    await decisive.locator("#csv").setInputFiles({ name: "shop-bot-100-records.csv", mimeType: "text/csv", buffer: Buffer.from(RECORDS_100) });
    await decisive.locator("#loadedResult").waitFor({ state: "visible" });
    const current = decisive.locator("#loadedResult");
    expect(await current.isVisible()).toBe(true);
    expect(await current.evaluate((node) => node.closest("details") === null)).toBe(true);
    const text = await current.innerText();
    expect(text).toMatch(/shop-bot-100-records\.csv: VALID/i);
    expect(text).toContain("run-shopbot-2026-10-11");
    expect(text).toMatch(/\buse Jev: Jev is within 10 points/);
    expect(text).not.toMatch(/not enough evidence/i);
  } finally { await decisive.close(); }
}, 30000);

test("[integration] L34 at 390x844 no horizontal scroll closed, mid-way or open; the Mad TokenMax poster and the whole marquee sit on the closed curtain's screen, unclipped", async () => {
  const page = await pageAt(390, 844, "no-preference");
  try {
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBe(0);
    expect(await coversViewport(page)).toBe(true);
    const fit = await page.evaluate(() => {
      const inside = (r: DOMRect) => r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      const marquee = document.querySelector("#overture .marquee"), billing = document.querySelector("#overture .marquee .billing"), skip = document.querySelector('#overture a[href="tm/"]');
      if (!marquee || !billing || !skip) return { whole: false, lines: false, clipped: true, skip: false };
      const range = document.createRange(); range.selectNodeContents(billing);
      const lines = [...range.getClientRects()].every((r) => inside(r));
      // Clipped: the marquee or an ancestor hides overflow and its box does not hold the whole marquee.
      const box = marquee.getBoundingClientRect();
      let clipped = false;
      for (let el: Element | null = marquee; el && el !== document.documentElement; el = el.parentElement) {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        if ((s.overflowX !== "visible" || s.overflowY !== "visible") && (r.left > box.left || r.right < box.right || r.top > box.top || r.bottom < box.bottom)) clipped = true;
      }
      return { whole: inside(box), lines, clipped, skip: inside(skip.getBoundingClientRect()) };
    });
    expect(fit).toEqual({ whole: true, lines: true, clipped: false, skip: true });
    await scrollToRunway(page, 0.3);
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising");
    expect(await overflow()).toBe(0);
    await openOntoResults(page);
    expect((await curtain(page)).state).toBe("open");
    expect(await overflow()).toBe(0);
  } finally { await page.close(); }
}, 15000);

test("[integration] L35 each poster shows only its stamp, title, one figure and its action outside the closed disclosure", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height);
    try {
      const cards = await page.locator("#tkPosters .tk-poster").evaluateAll((nodes) => nodes.map((card) => ({
        stage: card.className,
        outside: [...card.children].filter((child) => child.tagName !== "DETAILS").map((child) => child.className || child.tagName),
        closed: card.querySelector(":scope > details.tk-more")?.hasAttribute("open") === false,
      })));
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        const expected = card.stage.includes("tk-script-reading") ? ["tk-stamp", "H3", "tk-primary"] : ["tk-stamp", "H3", "tk-figure", "tk-primary"];
        expect({ width, stage: card.stage, outside: card.outside, closed: card.closed }).toEqual({ width, stage: card.stage, outside: expected, closed: true });
      }
    } finally { await page.close(); }
  }
}, 15000);

/* ---------- TM: the landing first screen above the curtain (issue #238) ---------- */
/** What the curtain, the sample chip and the valance do with no band above them, read off the page. */
async function noBandView(page: Page): Promise<Record<string, string | number | boolean>> {
  return page.evaluate(() => {
    const ov = document.getElementById("overture")?.getBoundingClientRect();
    const chip = document.getElementById("sampleBadge")?.getBoundingClientRect();
    const stage = document.querySelector(".overture-stage");
    return {
      bandPresent: document.getElementById("tmFirst") !== null,
      bandVar: document.documentElement.style.getPropertyValue("--tm-first-h"),
      ovTop: ov ? Math.round(ov.top) : NaN,
      ovHeight: ov ? Math.round(ov.height) : NaN,
      chipTop: chip ? Math.round(chip.top) : NaN,
      container: stage ? getComputedStyle(stage).containerType : "missing",
      shown: (document.body.innerText || "").includes("Hitting Claude limits") || (document.body.innerText || "").includes("Watch it run"),
    };
  });
}

test("[unit] TM0a the served landing HTML carries no TokenMax strip and no curl instruction", () => {
  const html = readFileSync(join(SITE, "index.html"), "utf8");
  expect({ tmFirst: html.includes("tmFirst"), tmCommand: html.includes("tmCommand"), curlFsSL: html.split("curl -fsSL").length - 1, curl: /\bcurl\b/i.test(html) }).toEqual({ tmFirst: false, tmCommand: false, curlFsSL: 0, curl: false });
});

for (const [width, height] of VIEWPORTS) test(`[integration] TM0 the landing has no TokenMax strip at ${width}x${height}: no element, no text, no tab stop, and the curtain, chip and valance start at the top`, async () => {
  const page = await pageAt(width, height, "no-preference");
  try {
    await page.waitForFunction(() => document.documentElement.dataset.curtain !== undefined, undefined, { timeout: 5000 });
    const view: Record<string, unknown> = { width, ...(await noBandView(page)) };
    expect(view)
      .toEqual({ width, bandPresent: false, bandVar: "0px", ovTop: 0, ovHeight: height, chipTop: width < 721 ? 34 : 14, container: "normal", shown: false });
    // The first heading is still the billing.
    expect(await page.locator(":is(h1,h2,h3)").first().getAttribute("id")).toBe("t1");
    expect(await page.locator("#tmFirst").count()).toBe(0);
  } finally { await page.close(); }
}, 30000);

/** The testimonial note is in the page only once TESTIMONIAL.approved is true (scripts/site-testimonial.ts); at the closed viewports it must then be shown. */
const NOTE_RENDERED = readFileSync(join(import.meta.dir, "..", "site", "index.html"), "utf8").includes('class="shop-say"');

/** Whether the testimonial note under the Little Shop poster is on screen (theatre.css hides it where the playbill is short). */
async function noteShown(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector("#overture .shop-say")?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ?? false);
}

/** Presses Tab `count` times and returns each focused stop (its id, or a short name) with the curtain's state and whether it shows a focus ring. */
async function tabStops(page: Page, count: number): Promise<{ stop: string; state: string; ring: boolean }[]> {
  const out: { stop: string; state: string; ring: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("Tab");
    out.push(await page.evaluate(() => {
      const a = document.activeElement;
      const s = a ? getComputedStyle(a) : null;
      const stop = !a ? "none" : a.id ? a.id : a.matches('#overture a[href="tm/"]') ? "madmax poster" : a.matches("#overture .shop-say a") ? "testimonial" : `${a.tagName}.${a.className}`;
      return { stop, state: document.documentElement.dataset.curtain ?? "unset", ring: Boolean(a?.matches(":focus-visible") && s && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2) };
    }));
  }
  return out;
}

/** Tabs from the top of the page to the curtain's first control (the Mad TokenMax poster) through the band's controls, checking the order on the way. */

/** Tabs from the top of the page to the curtain's first control (the Mad TokenMax poster), checking the first stop. */
async function tabToCurtain(page: Page): Promise<void> {
  const stops = await tabStops(page, 1);
  expect(stops.map((s) => s.stop)).toEqual(["madmax poster"]);
}

/*
 * The theatre restored on the landing page (fix/landing-restore-theatre): dark first whatever the OS says (L40), the
 * curtain closes again when the page is scrolled back to its top (L41), and the light scroll cues come back: the stage
 * door swishes in on a diagonal, the acts rise, the players slide in from the sides, the verdict word wipes in (L42).
 */
const DARK_BG = "rgb(18, 6, 10)";
const LIGHT_BG = "rgb(232, 229, 223)";
const OPEN_ON_LOAD = "try { window.sessionStorage.setItem('jnj-overture', 'seen'); } catch (e) { /* storage blocked */ }";

test("[integration] L40 the first load is dark in an OS-light and an OS-dark browser; House lights switches to light and back", async () => {
  for (const osScheme of ["light", "dark"] as const) {
    for (const [width, height] of VIEWPORTS) {
      const page = await pageAt(width, height, "no-preference", "", false, undefined, async (p) => { await p.emulateMedia({ colorScheme: osScheme }); });
      try {
        const read = () => page.evaluate(() => ({
          bg: getComputedStyle(document.body).backgroundColor,
          scheme: getComputedStyle(document.documentElement).colorScheme,
          label: (document.getElementById("lights")?.textContent ?? "").trim(),
        }));
        expect({ osScheme, width, ...await read() }).toEqual({ osScheme, width, bg: DARK_BG, scheme: "dark", label: "House lights up" });
        await page.locator("#lights").click();
        expect({ osScheme, width, ...await read() }).toEqual({ osScheme, width, bg: LIGHT_BG, scheme: "light", label: "House lights down" });
        await page.locator("#lights").click();
        expect({ osScheme, width, ...await read() }).toEqual({ osScheme, width, bg: DARK_BG, scheme: "dark", label: "House lights up" });
      } finally { await page.close(); }
    }
  }
}, 30000);

test("[integration] L41 scrolling back to the top closes the curtains again, on the first page of a session and on a later one, and the next scroll parts them again", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    for (const later of [false, true]) {
      const page = await pageAt(width, height, "no-preference", "", false, undefined, later ? async (p) => { await p.addInitScript({ content: OPEN_ON_LOAD }); } : undefined);
      try {
        const settled = () => page.waitForFunction(() => {
          const left = document.querySelector(".curtain.cl");
          return document.documentElement.dataset.curtain === "closed" && left !== null && getComputedStyle(left).transform === "matrix(1, 0, 0, 1, 0, 0)";
        }, undefined, { timeout: 4000 });
        if (later) expect((await curtain(page)).state).toBe("open");
        else { await scrollToRunway(page, 1.2); await page.waitForFunction(() => document.documentElement.dataset.curtain === "open"); }
        await scrollToVh(page, 1);
        expect({ later, width, state: (await curtain(page)).state, away: await page.evaluate(() => scrollY > 100) }).toEqual({ later, width, state: "open", away: true });
        await scrollToVh(page, 0);
        await settled();
        expect(await page.evaluate(() => getComputedStyle(document.getElementById("sampleBadge") ?? document.body).position)).toBe("fixed");
        const closed = await curtain(page);
        expect({ later, width, state: closed.state, reveal: closed.reveal, shown: await shownCurtains(page), covers: await coversViewport(page), locked: await page.evaluate(() => getComputedStyle(document.documentElement).overflowY) })
          .toEqual({ later, width, state: "closed", reveal: 0, shown: 2, covers: true, locked: "hidden" });
        expect((await curtain(page)).reveal === 0).toBe(true);
        await scrollToRunway(page, 1.2);
        await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
        expect(allShown(await pictureBoxes(page))).toBe(true);
      } finally { await page.close(); }
    }
  }
}, 60000);

const CUES = ["rise", "swish", "slide-l", "slide-r", "wipe"];

test("[integration] L42 the light animations run under motion (stage-door swish, marquee chase, drape sway) and stop under reduced motion", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference", "", false, undefined, async (p) => { await p.addInitScript({ content: OPEN_ON_LOAD }); });
    try {
      const names = (selector: string, pseudo?: string) => page.evaluate(([sel, ps]) => {
        const node = document.querySelector(sel ?? "");
        return node ? getComputedStyle(node, ps || null).animationName : "missing";
      }, [selector, pseudo ?? ""]);
      const into = async (selector: string) => {
        await page.evaluate((sel) => { document.querySelector(sel)?.scrollIntoView({ block: "center", behavior: "instant" }); }, selector);
        await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains("in") === true, selector, { timeout: 4000 });
      };
      // Nothing is lit before it is seen: the door waits hidden until .in lights it (the page is short without the acts,
      // so on some screens it is in view at load and lit at once; into() below checks it is lit once scrolled to).
      expect(await page.evaluate(() => {
        const door = document.getElementById("door");
        return door ? door.classList.contains("in") || getComputedStyle(door).opacity === "0" : null;
      })).toBe(true);
      expect(await page.evaluate((wanted) => {
        const found = new Set<string>();
        for (const sheet of document.styleSheets) {
          let rules: CSSRuleList;
          try { rules = sheet.cssRules; } catch (e) { continue; } // the blocked web-font sheet is cross-origin
          for (const rule of rules) if (rule instanceof CSSKeyframesRule) found.add(rule.name);
        }
        return wanted.filter((name) => !found.has(name));
      }, CUES)).toEqual([]);
      await into("#door");
      expect(await names("#door")).toBe("swish");
      expect(await names(".marquee-band .marquee", "::before")).toBe("chase");
      expect(await names(".drape.l")).toBe(width >= 1300 ? "sway" : "none");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect({ door: await names("#door"), chase: await names(".marquee-band .marquee", "::before"), sway: await names(".drape.l"), opacity: await page.evaluate(() => getComputedStyle(document.getElementById("door") ?? document.body).opacity) })
        .toEqual({ door: "none", chase: "none", sway: "none", opacity: "1" });
    } finally { await page.close(); }
  }
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "reduce");
    try {
      const shown = await page.evaluate(() => ({
        cues: document.documentElement.classList.contains("cues"),
        hidden: [...document.querySelectorAll("#door")].filter((n) => getComputedStyle(n).opacity !== "1" || getComputedStyle(n).animationName !== "none").length,
      }));
      expect({ width, ...shown }).toEqual({ width, cues: false, hidden: 0 });
    } finally { await page.close(); }
  }
}, 60000);

test("[integration] L43 keyboard: Shift+Tab to the header link after opening onto the results keeps the curtain open and the focus; after a click, scrolling to the top closes it and puts focus on the Mad TokenMax poster", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      await openOntoResults(page);
      await page.keyboard.press("Shift+Tab");
      await page.waitForTimeout(400);
      const link = await page.evaluate(() => ({ state: document.documentElement.dataset.curtain, focus: document.activeElement?.className ?? "" }));
      expect({ width, ...link }).toEqual({ width, state: "open", focus: "house-link" });
      // A clicked control is not keyboard focus: scrolling back to the top closes the curtain and moves focus to the curtain's first control.
      await page.evaluate(() => { window.scrollTo({ top: document.getElementById("types")?.offsetTop ?? 600, behavior: "instant" }); });
      await page.locator("#noul-hit").click();
      await page.evaluate(() => { window.scrollTo({ top: 0, behavior: "instant" }); });
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "closed", undefined, { timeout: 4000 });
      expect({ width, madmax: await page.evaluate(() => document.activeElement?.matches('#overture a[href="tm/"]') ?? false) }).toEqual({ width, madmax: true });
    } finally { await page.close(); }
  }
}, 30000);

/*
 * #248: the closed curtain bills the show and hangs two posters. The marquee leads (much bigger, its lights scaled with
 * it), the ticket is a small prop, the Mad TokenMax poster hangs in the centre slot between the playbill and the Little
 * Shop poster and opens tm/, and nothing of the page header shows through the curtain when it is pulled past its top.
 * BEFORE_248 is the build before #248 (d7d6ab2) measured by these tests' RED run in this harness (no web fonts).
 */
const BEFORE_248 = { ticketArea: 85854, marqueeWidth: 640, billing: 46 };
/** The three header parts that showed through the closed curtain in the #248 report. */
const HEADER_PARTS = ["header.house .brand", "header.house > .ticket", "header.house .house-link"];

/** The curtain's marquee width, billing font size and ticket area (its box on screen, turned as it is). */
async function playbillSizes(page: Page): Promise<{ ticketArea: number; marqueeWidth: number; billing: number }> {
  return page.evaluate(() => {
    const t = document.querySelector("#overture .ticket")?.getBoundingClientRect(), m = document.querySelector("#overture .marquee")?.getBoundingClientRect();
    const b = document.querySelector("#overture .marquee .billing");
    return { ticketArea: t ? t.width * t.height : NaN, marqueeWidth: m ? m.width : NaN, billing: b ? parseFloat(getComputedStyle(b).fontSize) : NaN };
  });
}

/** A part of the closed curtain by selector: its box, whether it lies wholly on screen, and whether the pointer at its centre reaches it. */
async function partOf(page: Page, selector: string): Promise<Part | null> {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node || getComputedStyle(node).display === "none") return null;
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const t = getComputedStyle(node).transform;
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, turned: t !== "none" && Math.abs(new DOMMatrix(t).b) > 0.005, hit: hit === node || node.contains(hit),
      inView: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  }, selector);
}

/**
 * The header parts that show through the closed curtain. At rest: those the pointer at their centre reaches, and those
 * whose box paints differently with the part hidden (visibility: hidden), which a curtain that hit-tests on top but
 * lets the header show through (translucent) would give. Pulled: those whose box shows anything but the resting
 * curtain while the curtain is pulled down past its top (an upward touch scroll at the curtain's scrollTop 0, the
 * overscroll a trackpad or a finger gives; each box is screenshotted every 100ms of a 2s pull with
 * the parts painted pure green, a colour the curtain never has, so a part counts only when its own green shows in its
 * box, not when the curtain merely moves over it).
 * `overscroll` replaces the curtain's overscroll-behavior: the control.
 */
async function headerThroughCurtain(width: number, height: number, overscroll?: string): Promise<{ atRest: number; painted: number; pulled: number }> {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  const elastic = await chromium.launch({ headless: true, executablePath: found.path, args: ["--enable-features=ElasticOverscroll"] });
  try {
    const page = await elastic.newPage({ viewport: { width, height }, reducedMotion: "no-preference", hasTouch: true });
    await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "closed");
    if (overscroll) await page.addStyleTag({ content: `.motion.overture-play .overture { overscroll-behavior: ${overscroll} !important; }` });
    await frames(page);
    const boxes = await page.evaluate((sels) => sels.map((sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(r.height) } : null;
    }), HEADER_PARTS);
    const atRest = await page.evaluate((sels) => sels.filter((sel) => {
      const node = document.querySelector(sel), r = node?.getBoundingClientRect();
      if (!node || !r || r.bottom <= 0 || r.top >= innerHeight) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === node || node.contains(hit);
    }).length, HEADER_PARTS);
    const resting = await Promise.all(boxes.map((clip) => clip ? page.screenshot({ clip }) : Promise.resolve(null)));
    await page.addStyleTag({ content: `${HEADER_PARTS.join(", ")} { visibility: hidden !important; }` });
    await frames(page);
    const hidden = await Promise.all(boxes.map((clip) => clip ? page.screenshot({ clip }) : Promise.resolve(null)));
    const painted = resting.filter((shot, i) => shot !== null && !shot.equals(hidden[i] ?? Buffer.alloc(0))).length;
    await page.evaluate(() => { document.head.lastElementChild?.remove(); });
    await frames(page);
    // For the pull the header parts paint pure green; the curtain is red and gold, so green in a part's box is the part.
    await page.addStyleTag({ content: `${HEADER_PARTS.join(", ")} { background: #00ff00 !important; color: #00ff00 !important; }` });
    await frames(page);
    const cdp = await page.context().newCDPSession(page);
    let pulling = true;
    const pull = cdp.send("Input.synthesizeScrollGesture", { x: width / 2, y: Math.round(height * 0.9), yDistance: 600, speed: 300, gestureSourceType: "touch", preventFling: true })
      .finally(() => { pulling = false; });
    const shots: { part: number; b64: string }[] = [];
    for (let frame = 0; frame < 24 && (pulling || frame < 4); frame++) {
      await page.waitForTimeout(100);
      for (const [i, clip] of boxes.entries()) if (clip) shots.push({ part: i, b64: (await page.screenshot({ clip })).toString("base64") });
    }
    await pull;
    const green = await page.evaluate(async (list) => {
      const seen = new Set<number>();
      for (const { part, b64 } of list) {
        if (seen.has(part)) continue;
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let k = 0; k < d.length; k += 4) if ((d[k + 1] ?? 0) > 200 && (d[k] ?? 255) < 90 && (d[k + 2] ?? 255) < 90) { seen.add(part); break; }
      }
      return seen.size;
    }, shots);
    return { atRest, painted, pulled: green };
  } finally { await elastic.close(); }
}

test("[integration] MM1 at 1440x900 the marquee leads and the ticket is a small prop: ticket area at most 0.4 of before #248, marquee width and billing at least 1.5 times", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    expect((await curtain(page)).state).toBe("closed");
    const now = await playbillSizes(page);
    // Asserted unrounded; rounded only for the log line.
    const ratio = { ticket: now.ticketArea / BEFORE_248.ticketArea, marquee: now.marqueeWidth / BEFORE_248.marqueeWidth, billing: now.billing / BEFORE_248.billing };
    console.log(`#248 MM1 1440x900 now ${JSON.stringify({ ticketArea: Math.round(now.ticketArea), marqueeWidth: Math.round(now.marqueeWidth), billing: now.billing })} before ${JSON.stringify(BEFORE_248)} ratio ticket ${ratio.ticket.toFixed(3)} marquee ${ratio.marquee.toFixed(3)} billing ${ratio.billing.toFixed(3)}`);
    expect({ ticket: ratio.ticket <= 0.4 ? "<=0.4" : ratio.ticket.toFixed(4), marquee: ratio.marquee >= 1.5 ? ">=1.5" : ratio.marquee.toFixed(4), billing: ratio.billing >= 1.5 ? ">=1.5" : ratio.billing.toFixed(4) })
      .toEqual({ ticket: "<=0.4", marquee: ">=1.5", billing: ">=1.5" });
  } finally { await page.close(); }
}, 15000);

test("[integration] MM2 wide screens (1716x910, 1440x900, 1100x700): the marquee spans the top centre; under it the Mad TokenMax poster, with the ADMIT ONE ticket tucked over its lower left corner, and the Little Shop poster stand in one row, centred; the poster is one link to tm/, at least 240px wide at 1440, with its image loaded, sized and named", async () => {
  for (const [width, height] of [[1716, 910], [1440, 900], [1100, 700]] satisfies [number, number][]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      expect({ width, links: await page.locator(MADMAX).count() }).toEqual({ width, links: 1 });
      await page.waitForFunction((sel) => { const i = document.querySelector(sel); return i instanceof HTMLImageElement && i.complete && i.naturalWidth > 0; }, `${MADMAX} img`, { timeout: 5000 }).catch(() => undefined);
      const img = await page.locator(`${MADMAX} img`).evaluate((node) => ({
        alt: node.getAttribute("alt") ?? "", sized: Number(node.getAttribute("width")) > 0 && Number(node.getAttribute("height")) > 0,
        loaded: node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0, src: node.getAttribute("src") ?? "",
      }));
      expect({ width, show: /mad tokenmax/i.test(img.alt), poster: /poster/i.test(img.alt), sized: img.sized, loaded: img.loaded, src: img.src })
        .toEqual({ width, show: true, poster: true, sized: true, loaded: true, src: "shows/madtokenmax-poster.webp" });
      const [marquee, ticket, madmax, poster] = await Promise.all(["#overture .marquee", "#overture .ticket", MADMAX, "#overture .poster"].map((s) => partOf(page, s)));
      if (!marquee || !ticket || !madmax || !poster) throw new Error(`a part of the curtain is missing at ${width}`);
      const mid = (a: Part): [number, number] => [(a.left + a.right) / 2, (a.top + a.bottom) / 2];
      const [tx, ty] = mid(ticket), [mx, my] = mid(madmax);
      expect({
        width,
        marqueeOnTop: [madmax, poster].every((p) => marquee.bottom <= p.top), centred: Math.abs((marquee.left + marquee.right) / 2 - width / 2) <= 24,
        rowCentred: Math.abs((Math.min(ticket.left, madmax.left) + poster.right) / 2 - width / 2) <= 24,
        order: madmax.right < poster.left, oneRow: madmax.top < poster.bottom && poster.top < madmax.bottom,
        tucked: ticket.left < madmax.left && ticket.right > madmax.left && tx < mx && ty > my && ticket.top < madmax.bottom,
        clearOfShop: ticket.right < poster.left,
        shown: [madmax, poster, ticket, marquee].every((p) => p.inView && p.hit), turned: madmax.turned && ticket.turned,
        wide: width === 1440 ? madmax.right - madmax.left >= 240 : true,
      }).toEqual({ width, marqueeOnTop: true, centred: true, rowCentred: true, order: true, oneRow: true, tucked: true, clearOfShop: true, shown: true, turned: true, wide: true });
      if (width === 1440) console.log(`#248 MM2 1440x900 Mad TokenMax poster link ${Math.round(madmax.right - madmax.left)}x${Math.round(madmax.bottom - madmax.top)}px, ticket ${Math.round(ticket.right - ticket.left)}x${Math.round(ticket.bottom - ticket.top)}px`);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] MM3 the Mad TokenMax poster and its ticket are one link: the first keyboard stop on the curtain with a visible focus ring and its own name, no link inside a link; a click on the ticket and a click on the poster both open tm/", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    await page.keyboard.press("Tab");
    expect(await page.evaluate((sel) => {
      const a = document.activeElement, s = a ? getComputedStyle(a) : null;
      return { madmax: Boolean(a?.matches(sel)), ring: Boolean(a?.matches(":focus-visible") && s && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2), state: document.documentElement.dataset.curtain };
    }, MADMAX)).toEqual({ madmax: true, ring: true, state: "closed" });
    expect(await page.evaluate(() => ({ nested: document.querySelectorAll("#overture a a").length, ticketInLink: document.querySelector("#overture .ticket")?.closest("a")?.getAttribute("href") ?? "" }))).toEqual({ nested: 0, ticketInLink: "tm/" });
    expect(await page.getByRole("link", { name: "Mad TokenMax, a token opera: admit one", exact: true }).count()).toBe(1);
    await Promise.all([page.waitForURL(/\/tm\/$/, { waitUntil: "commit" }), page.locator("#overture .ticket .admit").click()]);
    expect(new URL(page.url()).pathname).toBe("/tm/");
  } finally { await page.close(); }
  const poster = await pageAt(1440, 900, "no-preference");
  try {
    const box = await poster.locator(`${MADMAX} img`).boundingBox();
    if (!box) throw new Error("no poster image");
    // The top of the poster, clear of the ticket.
    await Promise.all([poster.waitForURL(/\/tm\/$/, { waitUntil: "commit" }), poster.mouse.click(box.x + box.width / 2, box.y + box.height * 0.2)]);
    expect(new URL(poster.url()).pathname).toBe("/tm/");
  } finally { await poster.close(); }
}, 15000);

test("[integration] MM4 narrow screens (390x844, 1024x768): the two posters sit side by side under the marquee as small cards, each at least 44px, no blurb, no horizontal scroll; the ticket stays on the Mad TokenMax poster, on screen and clear of the Little Shop card", async () => {
  for (const [width, height] of [[390, 844], [1024, 768]] satisfies [number, number][]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      const [marquee, ticket, madmax, poster] = await Promise.all(["#overture .marquee", "#overture .ticket", MADMAX, "#overture .poster"].map((s) => partOf(page, s)));
      if (!marquee || !ticket || !madmax || !poster) throw new Error(`a part of the curtain is missing at ${width}`);
      expect({
        width, underMarquee: madmax.top >= marquee.bottom && poster.top >= marquee.bottom, sideBySide: madmax.right <= poster.left && madmax.top < poster.bottom && poster.top < madmax.bottom,
        tap: [madmax, poster].every((p) => p.right - p.left >= 44 && p.bottom - p.top >= 44), shown: [ticket, madmax, poster].every((p) => p.inView && p.hit),
        attached: ticket.left < madmax.right && ticket.right > madmax.left && ticket.top < madmax.bottom && ticket.bottom > madmax.top, clearOfShop: ticket.right <= poster.left,
        blurb: await page.locator("#overture .p-blurb").isVisible(), overflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      }).toEqual({ width, underMarquee: true, sideBySide: true, tap: true, shown: true, attached: true, clearOfShop: true, blurb: false, overflow: 0 });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] MM5 no header bleed at 1716x910: pulled down past its top, the closed curtain still covers the header's brand, ticket and ticket-office link (the control, the curtain's old overscroll-behavior: contain, shows all three)", async () => {
  const control = await headerThroughCurtain(1716, 910, "contain");
  const now = await headerThroughCurtain(1716, 910);
  console.log(`#248 MM5 1716x910 header parts through the curtain: at rest ${now.atRest} (painted ${now.painted}), pulled ${now.pulled} (control pulled ${control.pulled})`);
  expect({ control: control.pulled, atRest: now.atRest, painted: now.painted, pulled: now.pulled }).toEqual({ control: 3, atRest: 0, painted: 0, pulled: 0 });
}, 30000);

test("[integration] MM6 no horizontal scroll on the closed curtain at 390x844 and 1100x700", async () => {
  for (const [width, height] of [[390, 844], [1100, 700]] satisfies [number, number][]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      expect({ width, overflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) }).toEqual({ width, overflow: 0 });
    } finally { await page.close(); }
  }
}, 15000);

test("[unit] MM7 the Mad TokenMax poster is a WebP file (RIFF....WEBP header) at or under 250,000 bytes", async () => {
  const bytes = new Uint8Array(await Bun.file(join(SITE, "shows", "madtokenmax-poster.webp")).arrayBuffer());
  const text = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  console.log(`#248 MM7 site/shows/madtokenmax-poster.webp ${bytes.length} bytes`);
  expect({ riff: text(0, 4), webp: text(8, 12), small: bytes.length > 0 && bytes.length <= 250_000 }).toEqual({ riff: "RIFF", webp: "WEBP", small: true });
});

test("[integration] MM8 a very short phone curtain shows no posters (390x500, 667x375): re-closing over focus left on the page moves focus to House lights on the curtain, never to a hidden poster", async () => {
  for (const [width, height] of [[390, 500], [667, 375]] satisfies [number, number][]) {
  const page = await pageAt(width, height, "no-preference");
  try {
    expect(await page.locator(MADMAX).isVisible()).toBe(false);
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, 1200);
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
    await page.evaluate(() => { window.scrollTo({ top: document.getElementById("types")?.offsetTop ?? 600, behavior: "instant" }); });
    await page.locator("#noul-hit").click();
    await page.evaluate(() => { window.scrollTo({ top: 0, behavior: "instant" }); });
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "closed", undefined, { timeout: 4000 });
    expect({ width, focus: await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || "") }).toEqual({ width, focus: "lights" });
  } finally { await page.close(); }
  }
}, 20000);

// Story and seat triage (#260): the picture story replaces the four acts; the 100-message evidence stays on /replay/.
test("[integration] TR1 the landing has no act sections and none of their content, in both motions and viewports", async () => {
  for (const motion of MOTIONS) for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, motion);
    try {
      expect({ width, motion, acts: await page.locator("section.act").count() }).toEqual({ width, motion, acts: 0 });
      for (const id of ["act2", "act3", "act4", "act5", "currentVerdict", "docket", "ledger", "cast", "spotlights"]) expect({ id, found: await page.locator(`#${id}`).count() }).toEqual({ id, found: 0 });
      expect(await page.locator("body").evaluate((node) => node.textContent ?? "")).not.toMatch(/The three players|The trial of 100 messages|What a kept answer cost/);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] TR2 one For developers link on the landing reaches the 100-message evidence page", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height);
    try {
      const link = page.getByRole("link", { name: "For developers", exact: true });
      expect({ width, links: await link.count() }).toEqual({ width, links: 1 });
      expect(await link.isVisible()).toBe(true);
      const url = new URL(await link.getAttribute("href") ?? "", page.url());
      expect(url.pathname + url.search).toBe("/replay/?run=uc13-100");
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] TR3 the evidence page still shows the 100 cases, each method's accepted count and cost, and a case the Jev arm missed", async () => {
  const page = await pageAt(1440, 900);
  try {
    await page.goto(`http://127.0.0.1:${server.port}/replay/?run=uc13-100`, { waitUntil: "load" });
    expect(await page.locator("#counter").innerText()).toMatch(/Case 01\s+of 100/);
    expect(await page.locator("#headline").innerText()).toMatch(/What you do now 86 of 100 .* A simple rule 49 of 100 .* Jev decides 88 of 100/);
    const totals = await page.locator("#totals").innerText();
    for (const figure of ["86 of 100", "49 of 100", "88 of 100", "$0.016255", "$0.003284"]) expect(totals).toContain(figure);
    // Case 44 (m44) is the miss the retired Act II spotlighted: Jev answered where the label says hand off.
    await page.locator("#strip button", { hasText: "41-50" }).click();
    expect(await page.locator("#pageList").innerText()).toMatch(/^44\t.*\t✕$/m);
  } finally { await page.close(); }
}, 30000);

test("[integration] TR4 without the acts or the Kept answers panel, a loaded file's own verdict stays readable (the sample's verdict is on /replay/, TR3)", async () => {
  const page = await pageAt(390, 844);
  try {
    expect(await page.locator("#aboutSample, #heroResult, #heroWhy").count()).toBe(0);
    await page.locator("#officeOpen").click();
    await page.locator("#csv").setInputFiles({ name: "shop-bot-100-records.csv", mimeType: "text/csv", buffer: Buffer.from(RECORDS_100) });
    await page.locator("#loadedResult").waitFor({ state: "visible" });
    const loaded = await page.locator("#loadedResult").innerText();
    expect(loaded).toContain("run-shopbot-2026-10-11");
    expect(loaded).toMatch(/VERDICT PER QUESTION[\s\S]*use Jev: Jev is within 10 points of the LLM \(lower bound -0\.04\)/i);
    expect(await measurePage(page)).toEqual({ overflow: 0, outside: [], small: [] });
  } finally { await page.close(); }
  const undecided = await pageAt(390, 844);
  try {
    await undecided.locator("#officeOpen").click();
    await undecided.locator("#csv").setInputFiles({ name: "uc13-records.csv", mimeType: "text/csv", buffer: Buffer.from(RECORDS) });
    await undecided.locator("#loadedResult").waitFor({ state: "visible" });
    expect(await undecided.locator("#loadedResult").innerText()).toMatch(/not enough evidence/i);
  } finally { await undecided.close(); }
}, 30000);

test("[integration] TR5 one call-to-action label, Open the curtain, on the curtain poster (a button, no link); the page's own way in is the footer's Little Shop link", async () => {
  for (const motion of MOTIONS) {
    const page = await pageAt(1440, 900, motion);
    try {
      const labels = await page.locator(".poster .p-cta").allTextContents();
      expect({ motion, labels }).toEqual({ motion, labels: ["Open the curtain"] });
      expect(await page.locator('footer.site-foot a[href="little-shop/"]').textContent()).toBe("Little Shop");
      const seats = page.locator("#overture .poster .p-seats");
      if (motion === "reduce") {
        expect(await seats.isVisible()).toBe(false);
      } else {
        expect(await seats.isVisible()).toBe(true);
        const box = await seats.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThan(1);
        expect(box?.height ?? 0).toBeGreaterThan(1);
        expect((await seats.innerText()).trim()).toBe("40 messages, three clerks each. You decide.");
      }
      expect(await page.locator("body").evaluate((node) => (node.textContent ?? "").toLowerCase())).not.toContain("pick a seat");
      // The poster's one control is a button whose visible text is its name (WCAG label in name); no aria-label overrides it.
      const names = await page.locator("#overture .poster button").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label") ?? n.textContent?.trim() ?? ""));
      expect(names).toEqual(["Open the curtain"]);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] TR6 the seat page's programme leads with a plain verdict line; the technical reasoning sits in a closed disclosure with every number unchanged", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height);
    try {
      await page.goto(`http://127.0.0.1:${server.port}/little-shop/`, { waitUntil: "load" });
      const og = await page.locator('meta[property="og:description"]').getAttribute("content");
      const counter = page.locator(".count");
      expect(await counter.isVisible()).toBe(true);
      expect((await counter.locator(".n").innerText()).replace(/\s+/g, " ").trim()).toBe("0 of 120");
      const caption = counter.locator(".cap");
      expect(await caption.isVisible()).toBe(true);
      expect((await caption.textContent() ?? "").trim()).toBe("clerks seated");
      expect(og).toBe("40 messages, three clerks each. You decide.");
      const run = page.locator(".recorded-run");
      const visible = await run.evaluate((node) => [...node.querySelectorAll("p, h3")].filter((n) => n.checkVisibility()).map((n) => n.textContent?.trim() ?? ""));
      expect({ width, visible }).toEqual({ width, visible: [
        "Recorded run, 1 October 2026: 40 cases",
        "Jev and the LLM: 38 of 40 each, Jev at about 1/79th of the LLM's cost. 40 messages were too few to prove Jev is as good.",
        "Verdict: not enough evidence",
        "The recorded run cannot yet show that Jev is as good as the LLM.",
      ] });
      for (const line of visible) expect(line).not.toMatch(/lower bound|margin|paired/i);
      const more = run.locator("details.recorded-more");
      expect(await more.count()).toBe(1);
      expect(await more.evaluate((node) => node instanceof HTMLDetailsElement && !node.open)).toBe(true);
      expect(await more.locator("summary").innerText()).toBe("Why is it not proven yet?");
      const why = (await more.locator(".recorded-why").textContent()) ?? "";
      for (const kept of ["-0.11", "-0.10 margin", "40 paired cases", "about 6 more paired cases"]) expect(why).toContain(kept);
      await more.locator("summary").click();
      expect(await more.locator(".recorded-why").isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    } finally { await page.close(); }
  }
}, 30000);

// #378: a persistent "Program (guide)" link to /guide/ sits top right in the first viewport, on the closed curtain and once it is open.
test("[unit] PG1 the landing HTML carries exactly one Program (guide) link, to /guide/", () => {
  const html = readFileSync(join(SITE, "index.html"), "utf8");
  expect([...html.matchAll(/<a [^>]*href="\/guide\/"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1])).toEqual(["Program (guide)"]);
});

for (const motion of MOTIONS) for (const [width, height] of VIEWPORTS) test(`[integration] PG2 at ${width}x${height} (${motion}) the first viewport shows a Program (guide) link to /guide/, top right, reachable by pointer, with no scroll`, async () => {
  const page = await pageAt(width, height, motion);
  try {
    const link = page.getByRole("link", { name: "Program (guide)" });
    expect(await link.count()).toBe(1);
    expect(await link.getAttribute("href")).toBe("/guide/");
    const view = await link.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, topFifth: r.top < innerHeight / 5, hit: hit === node || node.contains(hit), y: scrollY, shown: getComputedStyle(node).visibility === "visible" };
    });
    expect({ width, motion, ...view }).toEqual({ width, motion, inView: true, topFifth: true, hit: true, y: 0, shown: true });
    // Top right: its right edge is past 55% of the width on the closed curtain (beside the House lights chip) and in the house bar (next to Go to the ticket office).
    expect(await link.evaluate((node) => node.getBoundingClientRect().right > innerWidth * 0.55)).toBe(true);
  } finally { await page.close(); }
}, 30000);
