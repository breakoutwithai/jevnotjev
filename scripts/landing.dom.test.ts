import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import posters from "../site/shows/posters.json";
import { stripIsHidden, withStripShown } from "./tm-strip.ts";

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
// The TokenMax strip ships hidden. A test that is about the strip (or about the curtain under it) serves the page with
// that one `hidden` removed by calling stripOn() first; every other test sees the page as shipped.
let stripShown = false;
const stripOn = (): void => { stripShown = true; };
afterEach(() => { stripShown = false; });

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
    if (stripShown && path === join(SITE, "index.html")) return new Response(withStripShown(await file.text()), { headers: { "content-type": "text/html; charset=utf-8" } });
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

for (const motion of MOTIONS) {
  test(`[integration] L1-L5 the title comes first, then the result bars, the cards and the acts; hero copy sits behind one disclosure (${motion})`, async () => {
    for (const [width, height] of ACTION_VIEWPORTS) {
      const page = await pageAt(width, height, motion);
      try {
        expect(await page.locator(":is(h1,h2,h3)").first().getAttribute("id")).toBe("t1");
        // The page h1 is the billing in the marquee band, in the page and never on the curtain.
        expect(await page.locator("#t1").innerText()).toBe("To Jev or not to Jev in four acts");
        if (width >= 1280) expect(await page.locator("#t1").evaluate((node) => {
          // Lines, not inline fragments: the billing's em is its own box on the same line.
          return Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight));
        })).toBeLessThanOrEqual(2);
        // The hero paragraphs keep their words, moved behind the one "About this sample" disclosure.
        const about = page.locator("#aboutSample");
        expect(await about.evaluate((node) => node.tagName === "DETAILS" && !node.hasAttribute("open"))).toBe(true);
        for (const id of ["heroResult", "heroWhy", "primaryAction"]) expect(await page.locator(`#aboutSample #${id}`).count()).toBe(1);
        expect(await page.locator("#aboutSample .hero-note, #aboutSample .hero-guide").count()).toBe(2);
        const result = await page.locator("#heroResult").evaluate((node) => node.textContent ?? "");
        for (const word of ["100", "Jev", "LLM", "simple rule", "Verdict: Use Jev (rule 3)."] ) expect(result).toContain(word);
        expect(await page.locator("#heroWhy").evaluate((node) => node.textContent ?? "")).toContain("Why: Jev kept 88 right answers and the LLM 86 on these 100 shop messages");
        expect(await page.locator("#primaryAction").evaluate((node) => node.textContent ?? "")).toBe("Try it: pick a seat");
        expect(new URL(await page.locator("#primaryAction").getAttribute("href") ?? "", page.url()).pathname).toBe("/little-shop/");
        for (const id of ["heroResult", "heroWhy", "primaryAction"]) expect(await page.locator(`#${id}`).isVisible()).toBe(false);
        if (motion === "reduce") {
          // No curtain: the result bars are on the first screen.
          expect(await page.locator("#resultBars").evaluate((node) => node.getBoundingClientRect().top < innerHeight)).toBe(true);
        } else {
          const seat = await page.locator("#skipOverture").evaluate((node) => {
            const box = node.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return { top: box.top, covered: hit === node || node.contains(hit) };
          });
          expect(seat.top >= 0 && seat.top < height && seat.covered).toBe(true);
        }
        expect(await page.evaluate(() => {
          const ids = ["results", "tkPosters", "tkForm", "act2"].map((id) => document.getElementById(id));
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

test("[integration] L9 one spotlight comparison shows; the next miss and the cases sit behind clicks, ordered by confidence", async () => {
  const page = await pageAt(1440, 900);
  try {
    expect(await page.locator("#allCases").getAttribute("open")).toBeNull();
    expect(await page.locator("#allCases summary").innerText()).toBe("See all 100 cases");
    expect(await page.locator("#allCases .case.row").count()).toBe(100);
    const spots = page.locator("#act3 .spotlight");
    expect(await spots.count()).toBe(2);
    expect(await spots.nth(0).isVisible()).toBe(true);
    expect(await spots.nth(1).evaluate((node) => node.closest("details")?.id ?? "")).toBe("moreSpot");
    expect(await page.locator("#moreSpot").getAttribute("open")).toBeNull();
    expect(await spots.nth(1).isVisible()).toBe(false);
    // The visible comparison: the question, the three players' answers each marked kept or rejected, and the label.
    const first = spots.nth(0);
    expect(await first.locator(".spot-arm").allInnerTexts()).toHaveLength(3);
    const arms = (await first.locator(".spot-arm").allInnerTexts()).join(" | ");
    for (const name of ["LLM", "Simple rule", "Jev"]) expect(arms).toContain(name);
    expect(arms).toMatch(/kept|rejected/);
    expect(await first.locator(".truth").innerText()).toMatch(/^label: /);
    const expected = await page.evaluate(() => window.JNJ.cases.filter((c) => c.arms.C.picked !== c.truth)
      .sort((a, b) => (b.arms.C.confidence ?? 0) - (a.arms.C.confidence ?? 0)).slice(0, 2)
      .map((c) => ({ id: c.id, prompt: c.prompt })));
    await page.locator("#moreSpot").evaluate((node) => { if (node instanceof HTMLDetailsElement) node.open = true; });
    for (let i = 0; i < expected.length; i++) {
      expect(await spots.nth(i).innerText()).toContain(expected[i]?.id ?? "");
      expect(await spots.nth(i).innerText()).toContain(expected[i]?.prompt ?? "");
      expect(await spots.nth(i).locator(".monologue b").textContent()).toBe(i === 0 ? "Spotlight" : "Next miss");
    }
    expect(await page.locator("#allCases .monologue").count()).toBe(0);
    await page.locator("#allCases").evaluate((node) => { if (node instanceof HTMLDetailsElement) node.open = true; });
    expect(await page.locator(".case.row .conf").first().evaluate((node) => getComputedStyle(node).height)).toBe("4px");
    expect(await page.locator(".case.wrong .conf i").first().evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(240, 132, 112)"); // --cut in the default dark theme
    expect(await page.locator("#tally").innerText()).not.toContain("heard");
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
    expect(await page.locator(".tk-stages").isVisible()).toBe(false);
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

test("[integration] T-figures Acts III and IV name an arm in every numbered sentence", async () => {
  const page = await pageAt(390, 844);
  try {
    for (const selector of ["#versus", "#versusWins", "#because li"]) {
      // Text content, not rendered text: #versusWins sits in a closed disclosure, which renders no text.
      for (const text of await page.locator(selector).allTextContents()) {
        const sentences = text.split(/\.(?!\d)\s*/).filter((sentence) => /\d/.test(sentence));
        expect(sentences.length).toBeGreaterThan(0);
        for (const sentence of sentences) expect(sentence).toMatch(/\b(?:LLM|simple rule|Jev)\b/i);
      }
    }
  } finally { await page.close(); }
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

test("[integration] T-csv loaded file shows current verdict and all sample flags without overflow", async () => {
  const page = await pageAt(390, 844);
  try {
    await page.locator("#officeOpen").click();
    await page.locator("#csv").setInputFiles({ name: "uc13-records.csv", mimeType: "text/csv", buffer: Buffer.from(RECORDS) });
    await page.locator("#loadedResult").waitFor({ state: "visible" });
    expect(await page.locator("#currentVerdict").isVisible()).toBe(true);
    for (const n of [2, 3, 4, 5]) expect(await page.locator(`#sampleFlag${n}`).isVisible()).toBe(true);
    expect(await measurePage(page)).toEqual({ overflow: 0, outside: [], small: [] });
  } finally { await page.close(); }
}, 30000);

test("[integration] T-csv flag names only act numerals present on the page", async () => {
  const page = await pageAt(390, 844);
  try {
    await page.locator("#officeOpen").click();
    await page.locator("#csv").setInputFiles({ name: "uc13-records.csv", mimeType: "text/csv", buffer: Buffer.from(RECORDS) });
    await page.locator("#loadedResult").waitFor({ state: "visible" });
    const { flag, slates } = await page.evaluate(() => ({
      flag: document.querySelector("#sampleFlag2")?.textContent ?? "",
      slates: [...document.querySelectorAll(".roman")].map((node) => node.textContent?.trim() ?? ""),
    }));
    expect(flag).toContain("verdict section");
    for (const match of flag.matchAll(/\bAct\s+([IVX]+)\b/g)) expect(slates).toContain(match[1] ?? "");
    expect(flag).not.toMatch(/\bAct\s+[IVX]+\b/);
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
      const failures = await page.locator("a[href]:visible, button:visible, .tk-badge:visible").evaluateAll((links) => {
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

test("[integration] L15 cards use plain stage labels first", async () => {
  const page = await pageAt(1440, 900);
  try {
    for (const [stage, label] of [["show", "Tested"], ["rehearsal", "Small test (under 30 cases)"], ["script-reading", "Idea only, not tested"]]) {
      const badge = await page.locator(`.tk-${stage} .tk-badge`).first().innerText();
      expect(badge.startsWith(label ?? "")).toBe(true);
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

const PARTS: Record<string, string> = {
  marquee: "#overture .marquee", ticket: "#overture .ticket", cue: "#overture .cue-scroll", skip: "#skipOverture",
  poster: "#overture a.poster", madmax: '#overture a[href="tm/"]', chip: "#sampleBadge", lights: "#lights",
};

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
 * Each result bar's painted fill (`.rbars .bar i`) against the gap between the parting curtains: its final share of the
 * track (--w, %), the px of fill inside the gap, whether the fill lies wholly inside the viewport's height, whether
 * nothing stacked over the middle of that in-gap stretch paints there, the fill's effective opacity, whether its
 * computed background colour is opaque, and whether the screenshot at that point is the fill's colour (it paints).
 */
interface FillInGap { name: string; share: number; inGap: number; inView: boolean; onTop: boolean; opacity: number; opaqueColour: boolean; paints: boolean }

async function fillsInGap(page: Page): Promise<FillInGap[]> {
  const found = await page.evaluate(() => {
    const [cl, cr] = [...document.querySelectorAll(".overture .curtain")].map((node) => node.getBoundingClientRect());
    const gapLeft = Math.max(0, cl ? cl.right : 0), gapRight = Math.min(innerWidth, cr ? cr.left : innerWidth);
    return [...document.querySelectorAll(".rbars .rbar")].map((row) => {
      const fill = row.querySelector(".bar i"), r = fill ? fill.getBoundingClientRect() : new DOMRect();
      const left = Math.max(r.left, gapLeft), right = Math.min(r.right, gapRight);
      const mid: [number, number] = [(left + right) / 2, r.top + r.height / 2];
      // Everything stacked over the fill at that point paints nothing there: no background and no text of its own.
      const stack = right > left && fill ? document.elementsFromPoint(mid[0], mid[1]) : [];
      const over = stack.slice(0, stack.indexOf(fill ?? document.body));
      const clear = (el: Element): boolean => {
        const s = getComputedStyle(el);
        const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
        return s.backgroundImage === "none" && /^(transparent|rgba\(.*,\s*0\))$/.test(s.backgroundColor) && !ownText;
      };
      let opacity = 1;
      for (let el: Element | null = fill; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
      const bg = fill ? getComputedStyle(fill).backgroundColor : "";
      const rgb = (bg.match(/\d+(\.\d+)?/g) ?? []).map(Number);
      return {
        name: row.querySelector(".rb-name")?.textContent ?? "", share: fill instanceof HTMLElement ? parseFloat(fill.style.getPropertyValue("--w")) : NaN,
        inGap: Math.round(Math.max(0, right - left)), inView: r.height > 0 && r.top >= 0 && r.bottom <= innerHeight,
        onTop: fill !== null && stack.includes(fill) && over.every(clear), opacity, opaqueColour: /^rgb\(/.test(bg), colour: rgb.slice(0, 3), mid, drawn: right > left,
      };
    });
  });
  const shot = await pixelsAt(page, found.map((f) => f.mid));
  return found.map((f, i) => {
    const px = shot[i] ?? [0, 0, 0];
    const near = f.drawn && f.colour.length === 3 && f.colour.every((c, k) => Math.abs(c - (px[k] ?? 0)) <= 24);
    return { name: f.name, share: f.share, inGap: f.inGap, inView: f.inView, onTop: f.onTop, opacity: f.opacity, opaqueColour: f.opaqueColour, paints: near };
  });
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
/** For inline text that wraps (the band's trust line): the pointer at the middle of each of its line boxes reaches it. */
async function hitsEveryLine(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).evaluate((node) => {
    const rects = [...node.getClientRects()].filter((q) => q.width > 0 && q.height > 0);
    return rects.length > 0 && rects.every((q) => {
      const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
      return hit === node || node.contains(hit);
    });
  });
}

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

/** Each result bar's target width (its --w, in %) and drawn width (in % of its track). */
async function bars(page: Page): Promise<{ target: number; drawn: number }[]> {
  return page.locator("#resultBars .bar").evaluateAll((nodes) => nodes.map((bar) => {
    const fill = bar.querySelector("i");
    const track = bar.getBoundingClientRect().width;
    return { target: parseFloat(fill instanceof HTMLElement ? fill.style.getPropertyValue("--w") : "NaN"), drawn: fill && track > 0 ? fill.getBoundingClientRect().width / track * 100 : NaN };
  }));
}

function fullBars(list: { target: number; drawn: number }[]): boolean {
  return list.length === 3 && list.every((b) => b.target > 0 ? Math.abs(b.drawn - b.target) < 1 : b.drawn < 1);
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
    await page.waitForFunction(() => document.getElementById("skipOverture") !== null && document.getElementById("results") !== null && document.querySelectorAll(".overture .curtain").length === 2);
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
      expect(await hitsItself(page, "#skipOverture")).toBe(true);
      // The curtain is a named region; its painted drapes are hidden from assistive technology, its controls are not.
      const named = await page.evaluate(() => {
        const ov = document.getElementById("overture");
        return {
          role: ov?.getAttribute("role") ?? "", label: ov?.getAttribute("aria-label") ?? "", hidden: ov?.getAttribute("aria-hidden") ?? null,
          drapes: [...document.querySelectorAll(".overture .curtain")].map((node) => node.getAttribute("aria-hidden")),
          controlsHidden: [...document.querySelectorAll("#skipOverture, #overture a.poster")].some((node) => node.closest("[aria-hidden=true]") !== null),
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

test("[integration] V1 the closed curtain carries the October 6 composition: marquee, ticket, scroll cue, Skip, the Little Shop poster and the sample chip (a short phone curtain sets the ticket and cue aside, never clips them)", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      expect(await page.locator("#overture .marquee").innerText()).toMatch(/Jev!Jev presents[\s\S]*To Jev or not to Jev in four acts/i);
      expect(await page.locator("#overture .marquee").getAttribute("aria-hidden")).toBe("true");
      const ticket = await page.locator("#overture .ticket").textContent() ?? "";
      for (const word of ["ADMIT ONE", "J-EV", "No. 0042"]) expect(ticket).toContain(word);
      expect(await page.locator("#overture a.poster .p-title").innerText()).toBe("Little Shop of Horrors");
      expect(await page.locator("#overture a.poster").getAttribute("href")).toMatch(/little-shop\/$/);
      expect(await page.locator("#overture a.poster .p-cta").innerText()).toMatch(/^take your seat$/i);
      expect(await page.locator("#overture .cue-scroll").innerText()).toMatch(/^scroll to raise the curtain$/i);
      expect(await page.locator("#skipOverture").innerText()).toMatch(/^skip the overture$/i);
      expect(await page.locator("#sampleBadge").innerText()).toMatch(/^sample run/i);
      const parts = await curtainParts(page);
      // #238 pass 2: with the band's notes and trust line, a phone curtain of 520px of stage or less (390x844 now) is
      // theatre.css's short phone curtain: the ticket and the scroll cue step out (display none, never clipped).
      const edge = (await bandBox(page)).bottom;
      const roomy = width > 720 || height - edge > 520;
      const stepsOut = roomy ? [] : ["ticket", "cue"];
      for (const [name, part] of Object.entries(parts)) {
        if (stepsOut.includes(name)) continue;
        expect({ width, name, inView: part?.inView, hit: part?.hit }).toEqual({ width, name, inView: true, hit: true });
      }
      expect({ width, out: await page.evaluate((names) => names.map((n) => getComputedStyle(document.querySelector(n === "ticket" ? "#overture .ticket" : "#overture .cue-scroll") ?? document.body).display), stepsOut) })
        .toEqual({ width, out: stepsOut.map(() => "none") });
      const { marquee, ticket: tk, skip, poster, chip } = parts;
      if (!marquee || !tk || !skip || !poster || !chip) throw new Error("a part of the curtain is missing");
      // The chip sits top right of the curtain, as in the references: just under the first-screen band.
      expect({ width, right: chip.right >= width - 24, top: chip.top >= edge && chip.top <= edge + 40, side: (chip.left + chip.right) / 2 > width / 2 }).toEqual({ width, right: true, top: true, side: true });
      if (width >= 1100) {
        expect({ posterRight: poster.left > tk.right, marqueeAbove: marquee.bottom <= tk.top }).toEqual({ posterRight: true, marqueeAbove: true });
        expect(await page.locator("#overture .p-blurb").isVisible()).toBe(true);
      } else {
        expect({ order: roomy ? marquee.top < tk.top && tk.top < skip.top && skip.top < poster.top : marquee.top < skip.top && skip.top < poster.top }).toEqual({ order: true });
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

test("[integration] V2 no generic opening: no #opening or #takeSeat, nothing named exactly Take your seat, and the one h1 is in the page, not on the curtain", async () => {
  const roles: ("button" | "link" | "heading")[] = ["button", "link", "heading"];
  for (const motion of MOTIONS) for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, motion);
    try {
      expect(await page.locator("#opening, #takeSeat, .opening, .take-seat").count()).toBe(0);
      for (const role of roles) expect({ motion, role, count: await page.getByRole(role, { name: "Take your seat", exact: true }).count() }).toEqual({ motion, role, count: 0 });
      expect(await page.locator("h1").count()).toBe(1);
      expect(await page.locator("h1").evaluate((node) => node.id === "t1" && node.closest("#overture") === null && node.closest("main .marquee-band") !== null)).toBe(true);
      expect(await page.locator("#overture a.poster").getAttribute("aria-label")).toBe("Little Shop of Horrors: take your seat");
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] V3 Skip the overture opens the curtain at once, hides it, scrolls to the result bars and moves focus to the results heading", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      await page.locator("#skipOverture").click();
      const after = await page.evaluate(() => {
        const ov = document.getElementById("overture"), head = document.getElementById("resultsTitle");
        return {
          state: document.documentElement.dataset.curtain, active: document.activeElement?.id, overture: ov ? getComputedStyle(ov).display : "missing",
          top: document.getElementById("results")?.getBoundingClientRect().top ?? NaN, headTop: head?.getBoundingClientRect().top ?? NaN, y: scrollY,
        };
      });
      expect({ width, state: after.state, active: after.active, overture: after.overture }).toEqual({ width, state: "open", active: "resultsTitle", overture: "none" });
      expect(after.y).toBeGreaterThan(0);
      expect(Math.abs(after.top)).toBeLessThan(2);
      expect(after.headTop >= 0 && after.headTop < height).toBe(true);
      expect(await shownCurtains(page)).toBe(0);
      expect(fullBars(await bars(page))).toBe(true);
      expect(await page.locator("#resultBars").isVisible()).toBe(true);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] V4 the curtain poster opens Little Shop", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      await Promise.all([page.waitForURL(/\/little-shop\/$/, { waitUntil: "commit" }), page.locator("#overture a.poster").click()]);
      expect(new URL(page.url()).pathname).toBe("/little-shop/");
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] V5 mid-reveal every result bar's coloured fill shows in the gap between the parting curtains: by reveal 0.4 at least 24px at 1280 and 1440 and 16px at 390; at 0.7 40px at 1440 and 16px at 390; the fill paints its own opaque colour there, in both themes", async () => {
  // Bars whose final value is at least 30% of the track; the sample run has three bars. The last case runs dark.
  const checks: [number, number, number, number, string][] = [[1280, 900, 0.4, 24, "light"], [1440, 900, 0.4, 24, "light"], [390, 844, 0.4, 16, "light"], [1440, 900, 0.7, 40, "light"], [390, 844, 0.7, 16, "light"], [1440, 900, 0.7, 40, "dark"]];
  for (const [width, height, fraction, need, theme] of checks) {
    const page = await pageAt(width, height, "no-preference");
    try {
      await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); }, theme);
      await scrollToRunway(page, fraction);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising");
      expect(Math.abs((await curtain(page)).reveal - fraction)).toBeLessThan(0.02);
      const fills = await fillsInGap(page);
      expect(fills.length).toBe(3);
      const counted = fills.filter((f) => f.share >= 30);
      expect(counted.length).toBeGreaterThan(0);
      for (const f of counted) {
        expect({ width, fraction, theme, bar: f.name, inView: f.inView, onTop: f.onTop, inGap: f.inGap >= need ? `>=${need}` : `${f.inGap}px`, opacity: f.opacity, opaqueColour: f.opaqueColour, paints: f.paints })
          .toEqual({ width, fraction, theme, bar: f.name, inView: true, onTop: true, inGap: `>=${need}`, opacity: 1, opaqueColour: true, paints: true });
      }
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] V6 once open nothing of the opening is left: back at the top the house bar, marquee and results show, with no screen-high block", async () => {
  for (const [width, height] of CLOSED_VIEWPORTS) for (const how of ["skip", "scroll"]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      if (how === "skip") await page.locator("#skipOverture").click();
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
        return { blocks, overture: ov ? getComputedStyle(ov).display : "missing", house: top(".house"), band: document.getElementById("tmFirst")?.getBoundingClientRect().bottom ?? NaN, marquee: top("main .marquee"), results: top("#resultsTitle"), y: scrollY };
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
    const r = document.getElementById("resultsTitle")?.getBoundingClientRect();
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

test("[integration] V9 short screens (390x600, 390x560, 740x600, 844x390) and 390x844 fit the closed curtain: the whole marquee on screen and clear of the chip, Skip, the Mad TokenMax poster and the Little Shop poster's Take your seat on screen and reachable, no horizontal scroll", async () => {
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
          skip: inside(box("#skipOverture")) && reach("#skipOverture", "#skipOverture"), seat: inside(box("#overture a.poster .p-cta")) && reach("#overture a.poster .p-cta", "#overture a.poster"),
          madmax: inside(box('#overture a[href="tm/"]')) && reach('#overture a[href="tm/"]', '#overture a[href="tm/"]'),
          poster: inside(box("#overture a.poster")), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect({ width, height, ...fit, marqueeTop: fit.marqueeTop >= 0 }).toEqual({ width, height, marqueeTop: true, marquee: true, chipClear: true, skip: true, seat: true, madmax: true, poster: true, overflow: 0 });
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
  return page.evaluate(() => ({ y: scrollY, state: document.documentElement.dataset.curtain ?? "unset", top: document.getElementById("resultsTitle")?.getBoundingClientRect().top ?? NaN }));
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
      root.dataset.testOpen = `${scrollY} ${document.getElementById("resultsTitle")?.getBoundingClientRect().top ?? NaN}`;
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

test("[integration] V10 every way of scrolling drives the curtain's runway and the page stays at scrollY 0 until it opens: PageDown, Space and End on the page, ArrowDown from Skip, a wheel and a swipe over the sample chip, a real wheel and a real swipe over the curtain", async () => {
  stripOn();
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
    // ArrowDown with focus on Skip scrolls the curtain natively; when the playbill fades it opens onto the results.
    const arrows = await pageAt(width, height, "no-preference");
    try {
      // Tab passes the first-screen band (Copy, the script note, Watch it run) to reach Skip.
      await tabToSkip(arrows);
      const run = await stepToOpen(arrows, async () => { await arrows.keyboard.press("ArrowDown"); await arrows.waitForTimeout(40); await frames(arrows); }, 40);
      expect({ width, key: "ArrowDown", yBefore: run.yBefore, moved: run.moved, state: run.open.state, inView: run.open.top >= -1 && run.open.top < height, focus: await arrows.evaluate(() => document.activeElement?.id) })
        .toEqual({ width, key: "ArrowDown", yBefore: 0, moved: 0, state: "open", inView: true, focus: "resultsTitle" });
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

test("[integration] V11 when the playbill fades with focus on Skip, focus is not dropped: the curtain opens onto the results and the results heading has focus", async () => {
  stripOn();
  for (const [width, height] of CLOSED_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      // Tab passes the first-screen band (Copy, the script note, Watch it run) to reach Skip.
      await tabToSkip(page);
      await scrollToRunway(page, 0.5);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      const after = await page.evaluate(() => ({ focus: document.activeElement?.id ?? "BODY", top: document.getElementById("resultsTitle")?.getBoundingClientRect().top ?? NaN }));
      expect({ width, focus: after.focus, inView: after.top >= -1 && after.top < height }).toEqual({ width, focus: "resultsTitle", inView: true });
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

test("[integration] V15 once the playbill has faded the page in the gap takes the pointer: a result bar is what the pointer reaches, and About this sample opens on a click", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    await scrollToRunway(page, 0.5);
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising" && document.getElementById("overture")?.classList.contains("faded") === true);
    const hit = await page.evaluate(() => {
      const fill = document.querySelector("#resultBars .bar i")?.getBoundingClientRect();
      if (!fill) return "none";
      const node = document.elementFromPoint(fill.left + 4, fill.top + fill.height / 2);
      return node?.closest("#resultBars") ? "result bars" : node ? `${node.tagName}.${node.className}` : "none";
    });
    expect(hit).toBe("result bars");
    await page.locator("#aboutSample > summary").click();
    expect(await page.evaluate(() => ({ open: document.getElementById("aboutSample")?.hasAttribute("open"), state: document.documentElement.dataset.curtain }))).toEqual({ open: true, state: "open" });
  } finally { await page.close(); }
}, 20000);

test("[integration] V16 a case label is escaped where it becomes a class name: a label carrying a quote adds no attribute", async () => {
  const page = await pageAt(1440, 900, "reduce", "", false, undefined, async (p) => {
    await p.route("**/data.js", async (route) => {
      const response = await route.fetch();
      const patch = "\nwindow.JNJ.cases.forEach(function (c) { Object.keys(c.arms).forEach(function (k) { var a = c.arms[k]; if (a.label === \"reject\") a.label = 'reject\" data-injected=\"1'; }); });\n";
      await route.fulfill({ response, body: `${await response.text()}${patch}` });
    });
  });
  try {
    expect(await page.locator("#docket .cell, #spotlights .spot-arm").count()).toBeGreaterThan(0);
    expect(await page.locator("[data-injected]").count()).toBe(0);
  } finally { await page.close(); }
}, 20000);

test("[integration] V17 a scroll that opens the curtain in one go with focus on Skip moves focus to the results heading; the same scroll without focus on the curtain leaves the page at scrollY 0", async () => {
  stripOn();
  for (const [width, height] of CLOSED_VIEWPORTS) for (const how of ["wheel", "scrollTop"]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      // Tab passes the first-screen band (Copy, the script note, Watch it run) to reach Skip.
      await tabToSkip(page);
      const distance = await runway(page);
      if (how === "wheel") {
        await page.mouse.move(width / 2, height / 2 + 50);
        await page.mouse.wheel(0, distance + 400);
      } else {
        await page.evaluate((top) => { document.getElementById("overture")?.scrollTo({ top, behavior: "instant" }); }, distance + 400);
      }
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ focus: document.activeElement?.id || document.activeElement?.tagName || "", top: document.getElementById("resultsTitle")?.getBoundingClientRect().top ?? NaN }));
      expect({ width, how, focus: after.focus, inView: after.top >= -1 && after.top < height }).toEqual({ width, how, focus: "resultsTitle", inView: true });
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

test("[integration] L23 scrolling parts the curtain in step with the scroll, and the result bars grow with it", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await bars(page)).every((b) => b.drawn < 1)).toBe(true);
      await scrollToRunway(page, 0.3);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "rising");
      const mid = await curtain(page);
      expect(Math.abs(mid.reveal - 0.3)).toBeLessThan(0.02);
      const view = await viewCurtains(page);
      expect(view).toHaveLength(2);
      for (const c of view) expect(c.onScreen > 0 && c.onScreen < width / 2).toBe(true);
      for (const b of await bars(page)) expect(Math.abs(b.drawn - b.target * mid.reveal)).toBeLessThan(1.5);
      await scrollToRunway(page, 1);
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
      expect(await shownCurtains(page)).toBe(0);
      expect(fullBars(await bars(page))).toBe(true);
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
    expect(fullBars(await bars(page))).toBe(true);
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

test("[integration] L26 Skip is the first tab stop on the curtain (after the first-screen band's three) with a visible focus ring; Tab goes Skip, the Mad TokenMax poster, the Little Shop poster, House lights with the curtain closed; focus anywhere else opens it", async () => {
  stripOn();
  const page = await pageAt(1280, 900, "no-preference");
  try {
    // The band above the curtain comes first and keeps it closed: Copy, the script note's link, Watch it run.
    expect(await tabStops(page, TM_BAND_STOPS.length)).toEqual(TM_BAND_STOPS.map((stop) => ({ stop, state: "closed", ring: true })));
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() => {
      const a = document.activeElement;
      const s = a ? getComputedStyle(a) : null;
      return { id: a?.id ?? "", ring: Boolean(a?.matches(":focus-visible") && s && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2), state: document.documentElement.dataset.curtain };
    });
    expect(first).toEqual({ id: "skipOverture", ring: true, state: "closed" });
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => ({
      madmax: document.activeElement?.matches('#overture a[href="tm/"]') ?? false,
      state: document.documentElement.dataset.curtain,
    }))).toEqual({ madmax: true, state: "closed" });
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => ({
      poster: document.activeElement?.matches("#overture a.poster") ?? false,
      state: document.documentElement.dataset.curtain,
    }))).toEqual({ poster: true, state: "closed" });
    const where = () => page.evaluate(() => ({ id: document.activeElement?.id ?? "", state: document.documentElement.dataset.curtain }));
    await page.keyboard.press("Tab");
    expect(await where()).toEqual({ id: "lights", state: "closed" });
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.matches("#overture a.poster") ?? false)).toBe(true);
    await page.keyboard.press("Tab");
    expect(await where()).toEqual({ id: "lights", state: "closed" });
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => ({
      onCurtain: Boolean(document.getElementById("overture")?.contains(document.activeElement) || document.getElementById("sampleBadge")?.contains(document.activeElement)),
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
  const page = await pageAt(390, 844, "no-preference", "#act3");
  try {
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
    expect(await shownCurtains(page)).toBe(0);
  } finally { await page.close(); }
  const later = await pageAt(390, 844, "no-preference");
  try {
    expect((await curtain(later)).state).toBe("closed");
    await later.evaluate(() => { window.location.hash = "#act2"; });
    await later.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
    expect(await shownCurtains(later)).toBe(0);
  } finally { await later.close(); }
}, 15000);

test("[integration] L28 a page that loads already scrolled (a restored position) takes the curtain from there: open past the runway, part-way within it", async () => {
  // 2 screens is past any runway; 60px is inside the runway's floor of a quarter screen.
  const cases: [number, string][] = [[2 * 844, "open"], [60, "rising"]];
  // Scrolled before the curtain script runs: theatre.js is held at the network while the page above it is laid out.
  for (const [top, state] of cases) {
    await onHeld(390, 844, "no-preference", async ({ page, release, ready }) => {
      await page.waitForFunction(() => document.querySelectorAll("#resultBars li").length === 3 && document.getElementById("act5") !== null);
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

test("[integration] L17 under reduced motion there is no curtain, even before the curtain script loads; the page is open with full bars and no Skip", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    await onHeld(width, height, "reduce", async ({ page, release, ready }) => {
      expect(await page.evaluate(() => document.documentElement.classList.contains("motion"))).toBe(false);
      expect(await shownCurtains(page)).toBe(0);
      expect(await page.locator("#skipOverture").isVisible()).toBe(false);
      release();
      await ready();
      expect((await curtain(page)).state).toBe("open");
      expect(await shownCurtains(page)).toBe(0);
      expect(fullBars(await bars(page))).toBe(true);
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
    expect(fullBars(await bars(mid))).toBe(true);
    await mid.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
  } finally { await mid.close(); }
}, 30000);

for (const motion of MOTIONS) {
  test(`[integration] L18 the theatre frame stays once open: valance, marquee, ADMIT ONE ticket and the Little Shop poster (${motion})`, async () => {
    for (const [width, height] of ACTION_VIEWPORTS) {
      const page = await pageAt(width, height, motion);
      try {
        if (motion === "no-preference") await page.locator("#skipOverture").click();
        await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
        for (const selector of [".valance", "main .marquee", ".house .ticket .admit", ".house .ticket .stub", ".results a.poster"]) expect(await page.locator(selector).isVisible()).toBe(true);
        expect(await page.locator(".valance").evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
        expect(await page.locator("main .marquee").innerText()).toMatch(/Jev!Jev presents[\s\S]*To Jev or not to Jev/i);
        expect(await page.locator(".house .ticket .admit").innerText()).toBe("ADMIT ONE");
        const poster = page.locator(".results a.poster");
        expect(await poster.innerText()).toContain("Little Shop of Horrors");
        expect(new URL(await poster.getAttribute("href") ?? "", page.url()).pathname).toBe("/little-shop/");
        // The marquee bills the show above the results; on a phone the poster never sits above the result bars.
        const order = await page.evaluate(() => {
          const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
          const marquee = box("main .marquee"), head = box("#resultsTitle"), barsBox = box("#resultBars"), poster = box(".results a.poster");
          return { marqueeAbove: Boolean(marquee && head && marquee.bottom <= head.top), posterBelow: Boolean(poster && barsBox && (innerWidth >= 900 || poster.top >= barsBox.bottom)) };
        });
        expect(order).toEqual({ marqueeAbove: true, posterBelow: true });
      } finally { await page.close(); }
    }
  }, 30000);
}

test("[integration] L20 each Little Shop poster has its own short accessible name, shared by no other link: take your seat on the curtain, pick a seat in the page", async () => {
  const page = await pageAt(390, 844, "no-preference");
  try {
    const inPage = "Little Shop of Horrors: pick a seat", onCurtain = "Little Shop of Horrors: take your seat";
    expect(await page.locator(".results a.poster").getAttribute("aria-label")).toBe(inPage);
    expect(await page.locator("#overture a.poster").getAttribute("aria-label")).toBe(onCurtain);
    expect(await page.getByRole("link", { name: inPage, exact: true }).count()).toBe(1);
    expect(await page.getByRole("link", { name: onCurtain, exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Take your seat", exact: true }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Take your seat", exact: true }).count()).toBe(0);
    expect(await page.locator(".results a.poster .p-cta").innerText()).not.toMatch(/take your seat/i);
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
    expect(fullBars(await bars(page))).toBe(true);
    expect(await page.locator("#skipOverture").isVisible()).toBe(false);
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
    expect(await page.locator("#skipOverture").isVisible()).toBe(false);
    for (const selector of ["#t1", "#resultsTitle", "#t2", "#t3", "#t4", "#officeOpen"]) expect(await page.locator(selector).isVisible()).toBe(true);
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
      expect(await page.locator("#skipOverture").isVisible()).toBe(false);
      expect(await hitsItself(page, "#t1")).toBe(true);
      expect(await page.locator("#t2").isVisible()).toBe(true);
    } finally { await page.close(); }
  }
}, 20000);

/** Per act: its main visual, the ids of the prose it may show with every disclosure closed, and its secondary blocks. */
const ACTS: { id: string; visual: string; prose: string[]; behind: string[] }[] = [
  { id: "act2", visual: "#cast", prose: ["workflowDir"], behind: ["#castMethods", "#understudies"] },
  { id: "act3", visual: "#spotlights .spotlight", prose: [], behind: ["#moreSpot .spotlight", "#docket"] },
  { id: "act4", visual: "#ledger", prose: ["versus"], behind: ["#versusWins", "#bench"] },
  // Act IV keeps the verdict's reason, its one next action and its limitation line in view (decided for #231).
  { id: "act5", visual: "#t5", prose: ["verdictWhy", "verdictNext", "caveat"], behind: ["#verdictMiss", "#verdictCases", "#verdictEarlier", "#because", "#verdictMore a[href='guide/']"] },
];

test("[integration] L31 each act shows one plain heading, one main visual and at most one short sentence; its detail opens from the keyboard", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height);
    try {
      for (const act of ACTS) {
        expect({ act: act.id, h2: await page.locator(`#${act.id} h2:visible`).count() }).toEqual({ act: act.id, h2: 1 });
        expect(await page.locator(`#${act.id} ${act.visual}`).first().isVisible()).toBe(true);
        const prose = await page.evaluate((id) => {
          const section = document.getElementById(id);
          const skip = ".sample-flag, #currentVerdict, .spotlight, .player, .acct, .tally, details";
          return [...(section?.querySelectorAll("p, li") ?? [])]
            .filter((node) => node.getClientRects().length > 0 && !node.closest(skip) && (node.textContent ?? "").trim() !== "")
            .map((node) => ({ id: node.id, sentences: (node.textContent ?? "").trim().split(/(?<=[.?!])\s+(?=[A-Z])/).length }));
        }, act.id);
        expect({ act: act.id, prose: prose.map((p) => p.id) }).toEqual({ act: act.id, prose: act.prose });
        // One sentence each; Act IV's reason, next action and limitation at most two each.
        for (const p of prose) expect({ act: act.id, id: p.id, short: p.sentences <= (act.id === "act5" ? 2 : 1) ? "yes" : `${p.sentences} sentences` }).toEqual({ act: act.id, id: p.id, short: "yes" });
        for (const selector of act.behind) {
          const block = page.locator(`#${act.id} ${selector}`).first();
          expect({ selector, visible: await block.isVisible() }).toEqual({ selector, visible: false });
          const holder = await block.evaluate((node) => {
            const details = node.closest("details");
            return details && !details.open ? details.id : "";
          });
          expect({ selector, inClosedDetails: holder !== "" }).toEqual({ selector, inClosedDetails: true });
          const summary = page.locator(`#${holder} > summary`);
          await summary.focus();
          const ring = await summary.evaluate((node) => {
            const s = getComputedStyle(node);
            return node.matches(":focus-visible") && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2;
          });
          expect({ selector, ring }).toEqual({ selector, ring: true });
          await page.keyboard.press("Enter");
          expect({ selector, visible: await block.isVisible() }).toEqual({ selector, visible: true });
          await page.keyboard.press("Enter");
        }
      }
      // Each player card and each account card shows only its default parts; nothing else is visible in it.
      const cards = await page.evaluate(() => ({
        player: [...document.querySelectorAll("#cast .player")].map((card) => [...card.children].filter((c) => c.getClientRects().length > 0).map((c) => c.className || c.tagName)),
        acct: [...document.querySelectorAll("#ledger .acct")].map((card) => [...card.children].filter((c) => c.getClientRects().length > 0).map((c) => c.className || c.tagName)),
      }));
      expect({ width, players: cards.player.length, accts: cards.acct.length }).toEqual({ width, players: 3, accts: 3 });
      for (const card of cards.player) expect({ width, card }).toEqual({ width, card: ["letter", "H3", "player-sub", "picks", "picks-legend num"] });
      for (const card of cards.acct) expect({ width, card }).toEqual({ width, card: ["who", "fig", "fig", "fig", "bar"] });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] L32 four numbered acts in order, and every label that counts the acts says four", async () => {
  const page = await pageAt(1440, 900);
  try {
    expect(await page.locator("section.act .slate .roman").allInnerTexts()).toEqual(["I", "II", "III", "IV"]);
    expect(await page.locator("section.act").count()).toBe(4);
    expect(await page.locator("main .marquee").innerText()).toMatch(/in four acts/i);
    expect(await page.locator("#overture .marquee").textContent()).toMatch(/in four acts/i);
    const text = await page.evaluate(() => `${document.body.textContent ?? ""} ${document.querySelector('meta[name="description"]')?.getAttribute("content") ?? ""}`);
    expect(text).not.toMatch(/\b(?:one|two|three|five|six|[12356])[ -]acts?\b/i);
  } finally { await page.close(); }
});

test("[integration] L33 with every disclosure closed the essential context stays in view: units, sample provenance, missing cost, limitation and a loaded file's verdict, undecided and decisive", async () => {
  const page = await pageAt(390, 844);
  try {
    expect(await page.locator("#results .results-source").textContent()).toContain("Sample run");
    expect(await page.locator("#results .results-source").isVisible()).toBe(true);
    expect(await page.locator("#resultBars .rb-name").allInnerTexts()).toEqual(["LLM", "Simple rule", "Jev"]);
    const values = await page.locator("#resultBars .rb-val").allInnerTexts();
    expect(values).toHaveLength(3);
    for (const v of values) expect(v).toMatch(/^\d+ of 100 kept$/);
    expect(await page.locator("#ledger dt:visible", { hasText: "Cost per kept answer" }).count()).toBe(3);
    const cpks = await page.locator("#ledger dd.cpk:visible").allInnerTexts();
    expect(cpks).toHaveLength(3);
    for (const cpk of cpks) expect(cpk).toMatch(/^\$\d/);
    expect(await page.locator("#ledger dd:visible", { hasText: "88/100" }).count()).toBe(1);
    expect(await page.locator("#ledger .bar").first().isVisible()).toBe(true);
    expect(await page.locator("#caveat").isVisible()).toBe(true);
    expect(await page.locator("#caveat").innerText()).toContain("not production");
  } finally { await page.close(); }
  // A method that kept nothing: its cost per kept answer reads undefined, in view, never zero.
  const missing = await pageAt(390, 844, "reduce", "", false, undefined, async (p) => {
    await p.route("**/data.js", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}\nwindow.JNJ.summary.B.kept = 0; window.JNJ.summary.B.cpk = null;\n` });
    });
  });
  try {
    const undef = missing.locator("#ledger .cpk.undef");
    expect(await missing.locator("#ledger dd.cpk:visible").count()).toBe(3);
    expect(await undef.count()).toBe(1);
    expect(await undef.innerText()).toBe("undefined (0 kept)");
    expect(await undef.isVisible()).toBe(true);
    expect(await missing.locator("#resultBars .rb-val").nth(1).innerText()).toBe("0 of 100 kept");
  } finally { await missing.close(); }
  // A loaded file: its verdict (here not enough evidence) shows in Act IV, and every act says it replays the sample.
  const loaded = await pageAt(390, 844);
  try {
    await loaded.locator("#officeOpen").click();
    await loaded.locator("#csv").setInputFiles({ name: "uc13-records.csv", mimeType: "text/csv", buffer: Buffer.from(RECORDS) });
    await loaded.locator("#loadedResult").waitFor({ state: "visible" });
    const current = loaded.locator("#currentVerdict");
    expect(await current.isVisible()).toBe(true);
    expect(await current.evaluate((node) => node.closest("details") === null && node.closest("#act5") !== null)).toBe(true);
    expect(await current.innerText()).toMatch(/not enough evidence/i);
    for (const n of [2, 3, 4, 5]) expect(await loaded.locator(`#sampleFlag${n}`).isVisible()).toBe(true);
  } finally { await loaded.close(); }
  // A loaded file with a decisive verdict: the recorded 100-message shop-bot run (the sample's own source records), whose
  // loader verdict is use Jev. Act IV names the file and its run beside the verdict, outside any disclosure.
  const decisive = await pageAt(390, 844);
  try {
    await decisive.locator("#officeOpen").click();
    await decisive.locator("#csv").setInputFiles({ name: "shop-bot-100-records.csv", mimeType: "text/csv", buffer: Buffer.from(RECORDS_100) });
    await decisive.locator("#loadedResult").waitFor({ state: "visible" });
    const current = decisive.locator("#currentVerdict");
    expect(await current.isVisible()).toBe(true);
    expect(await current.evaluate((node) => node.closest("details") === null && node.closest("#act5") !== null)).toBe(true);
    const text = await current.innerText();
    expect(text).toMatch(/your file shop-bot-100-records\.csv/i);
    expect(text).toContain("run-shopbot-2026-10-11");
    expect(text).toMatch(/: use Jev \(/);
    expect(text).not.toMatch(/not enough evidence/i);
  } finally { await decisive.close(); }
}, 30000);

test("[integration] L34 at 390x844 no horizontal scroll closed, mid-way or open; Skip and the whole marquee sit on the closed curtain's screen, unclipped", async () => {
  const page = await pageAt(390, 844, "no-preference");
  try {
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBe(0);
    expect(await coversViewport(page)).toBe(true);
    const fit = await page.evaluate(() => {
      const inside = (r: DOMRect) => r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      const marquee = document.querySelector("#overture .marquee"), billing = document.querySelector("#overture .marquee .billing"), skip = document.getElementById("skipOverture");
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
    await page.locator("#skipOverture").click();
    expect((await curtain(page)).state).toBe("open");
    expect(await overflow()).toBe(0);
  } finally { await page.close(); }
}, 15000);

test("[integration] L35 each card shows only its badge, title, one figure and its action outside the closed disclosure", async () => {
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
        const expected = card.stage.includes("tk-script-reading") ? ["tk-badge", "H3", "tk-primary"] : ["tk-badge", "H3", "tk-figure", "tk-primary"];
        expect({ width, stage: card.stage, outside: card.outside, closed: card.closed }).toEqual({ width, stage: card.stage, outside: expected, closed: true });
      }
    } finally { await page.close(); }
  }
}, 15000);

/* ---------- TM: the landing first screen above the curtain (issue #238) ---------- */
const TM_COMMAND = "curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts | bun run - --share";
const TM_PROMISE = "Hitting Claude limits? See your last 7 days in 10 seconds, on your own machine";
const TM_BUN = "curl -fsSL https://bun.sh/install | bash";
/** What the polite live region says after Copy: the next step, the trust sentence and the Bun install line, none of it in the band before. */
const TM_TRUST = "It reads your local Claude Code and Codex logs and sends nothing.";
const TM_BUN_LINE = `No Bun? Run ${TM_BUN} first.`;
const TM_COPIED = `Copied. Paste it into a terminal. ${TM_TRUST} ${TM_BUN_LINE}`;
/** #238 pass 2: the trust line in the band at every width, the same sentence as the /maps/ share card. */
const TM_TRUST_LINE = "Runs on your machine. Nothing sent until you press Share.";
/** The command's three underlined parts, each with its note (the first links to the script itself). */
const TM_NOTES: { part: string; key: string; note: string; href: string | null }[] = [
  { part: "curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts", key: "curl", note: "the script, readable", href: "/tm/map.ts" },
  { part: "bun run -", key: "bun run -", note: "runs on your machine", href: null },
  { part: "--share", key: "--share", note: "a link you choose to press", href: null },
];
/** The band's tab stops in order: Copy, the script note's link, Watch it run. */
const TM_BAND_STOPS = ["tmCopy", "tmScript", "tmWatch"];
const TM_HINT = `Press Ctrl+C or Cmd+C to copy. ${TM_TRUST} ${TM_BUN_LINE}`;

/** What the curtain, the sample chip and the valance do with no band above them (the page before #241), read off the page. */
async function noBandView(page: Page): Promise<Record<string, string | number | boolean>> {
  return page.evaluate(() => {
    const ov = document.getElementById("overture")?.getBoundingClientRect();
    const chip = document.getElementById("sampleBadge")?.getBoundingClientRect();
    const stage = document.querySelector(".overture-stage");
    const band = document.getElementById("tmFirst");
    return {
      bandHidden: band?.hasAttribute("hidden") ?? false,
      bandDisplay: band ? getComputedStyle(band).display : "missing",
      bandHeight: band ? band.getBoundingClientRect().height : -1,
      bandVar: document.documentElement.style.getPropertyValue("--tm-first-h"),
      ovTop: ov ? Math.round(ov.top) : NaN,
      ovHeight: ov ? Math.round(ov.height) : NaN,
      chipTop: chip ? Math.round(chip.top) : NaN,
      container: stage ? getComputedStyle(stage).containerType : "missing",
      shown: (document.body.innerText || "").includes("Hitting Claude limits") || (document.body.innerText || "").includes("Watch it run"),
    };
  });
}

for (const [width, height] of VIEWPORTS) test(`[integration] TM0 the TokenMax strip is off at ${width}x${height}: it takes no room, shows no text, has no tab stop, and the curtain, chip and valance start where they did before #241`, async () => {
  const page = await pageAt(width, height, "no-preference");
  try {
    await page.waitForFunction(() => document.documentElement.dataset.curtain !== undefined, undefined, { timeout: 5000 });
    const view: Record<string, unknown> = { width, ...(await noBandView(page)) };
    expect(view)
      .toEqual({ width, bandHidden: true, bandDisplay: "none", bandHeight: 0, bandVar: "0px", ovTop: 0, ovHeight: height, chipTop: width < 721 ? 34 : 14, container: "normal", shown: false });
    // Nothing in it takes a tab stop: Tab from the top of the page never lands inside the strip.
    const stops: string[] = [];
    for (let i = 0; i < 4; i += 1) { await page.keyboard.press("Tab"); stops.push(await page.evaluate(() => document.activeElement?.closest("#tmFirst") ? "tmFirst" : document.activeElement?.id ?? "")); }
    expect(stops.includes("tmFirst")).toBe(false);
    // The first heading is still the billing, and the page was not asked for the strip's text anywhere visible.
    expect(await page.locator(":is(h1,h2,h3)").first().getAttribute("id")).toBe("t1");
    expect(await page.locator("#tmFirst").isVisible()).toBe(false);
  } finally { await page.close(); }
}, 30000);

test("[integration] TM0b the strip comes back with one change: removing the one `hidden` word from its tag in index.html shows it, with the curtain, chip and valance under it", async () => {
  const html = readFileSync(join(SITE, "index.html"), "utf8");
  expect(stripIsHidden(html)).toBe(true);
  expect([...html.matchAll(/<section[^>]*id="tmFirst"[^>]*>/g)].map((m) => (m[0].match(/\shidden\b/g) ?? []).length)).toEqual([1]);
  // The re-enabled page differs from the shipped one by exactly that word.
  expect(html.length - withStripShown(html).length).toBe(" hidden".length);
  expect(stripIsHidden(withStripShown(html))).toBe(false);
  stripOn();
  const page = await pageAt(1440, 900, "no-preference");
  try {
    await page.waitForFunction(() => document.documentElement.dataset.curtain !== undefined, undefined, { timeout: 5000 });
    const view = await noBandView(page);
    const band = await bandBox(page);
    expect({ hidden: view.bandHidden, display: view.bandDisplay, tall: band.height > 100, curtainUnderBand: view.ovTop === Math.round(band.bottom), container: view.container, copyShown: await page.locator("#tmCopy").isVisible(), text: view.shown })
      .toEqual({ hidden: false, display: "block", tall: true, curtainUnderBand: true, container: "size", copyShown: true, text: true });
  } finally { await page.close(); }
}, 30000);

/** The band's box on screen. */
async function bandBox(page: Page): Promise<{ top: number; bottom: number; height: number }> {
  return page.evaluate(() => {
    const r = document.getElementById("tmFirst")?.getBoundingClientRect();
    return r ? { top: r.top, bottom: r.bottom, height: r.height } : { top: NaN, bottom: NaN, height: NaN };
  });
}

/** Presses Tab `count` times and returns each focused stop (its id, or a short name) with the curtain's state and whether it shows a focus ring. */
async function tabStops(page: Page, count: number): Promise<{ stop: string; state: string; ring: boolean }[]> {
  const out: { stop: string; state: string; ring: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("Tab");
    out.push(await page.evaluate(() => {
      const a = document.activeElement;
      const s = a ? getComputedStyle(a) : null;
      const stop = !a ? "none" : a.id ? a.id : a.matches("#overture a.poster") ? "curtain poster" : a.matches('#overture a[href="tm/"]') ? "madmax poster" : `${a.tagName}.${a.className}`;
      return { stop, state: document.documentElement.dataset.curtain ?? "unset", ring: Boolean(a?.matches(":focus-visible") && s && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2) };
    }));
  }
  return out;
}

/** Tabs from the top of the page to Skip the overture through the band's two controls, checking the order on the way. */
async function tabToSkip(page: Page): Promise<void> {
  const stops = await tabStops(page, TM_BAND_STOPS.length + 1);
  expect(stops.map((s) => s.stop)).toEqual([...TM_BAND_STOPS, "skipOverture"]);
}

for (const motion of MOTIONS) {
  test(`[integration] TM1 the first screen leads with the band: body's first child, the promise, the exact command, its notes, the trust line and Watch it run; the Bun line waits for Copy; no heading in it, no animation under reduced motion (${motion})`, async () => {
    stripOn();
    for (const [width, height] of VIEWPORTS) {
      const page = await pageAt(width, height, motion);
      try {
        const band = await page.evaluate(() => {
          const node = document.body.firstElementChild;
          const section = document.getElementById("tmFirst");
          const copy = document.getElementById("tmCopy"), watch = document.getElementById("tmWatch");
          const ticket = document.getElementById("tmCommand")?.parentElement;
          const stub = ticket?.querySelector(".tm-stub");
          return {
            first: node?.id || node?.tagName || "none", tag: section?.tagName ?? "", cls: section?.className ?? "", label: section?.getAttribute("aria-label") ?? "",
            headings: section ? section.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]").length : -1,
            promiseTag: document.getElementById("tmPromise")?.tagName ?? "",
            promise: document.getElementById("tmPromise")?.textContent ?? "",
            command: document.getElementById("tmCommand")?.textContent ?? "",
            commandTag: document.getElementById("tmCommand")?.tagName ?? "",
            copy: { tag: copy?.tagName ?? "", type: copy?.getAttribute("type") ?? "", text: copy?.textContent ?? "" },
            live: document.getElementById("tmCopied")?.getAttribute("aria-live") ?? "",
            watch: watch?.textContent ?? "", watchTag: watch?.tagName ?? "", href: watch?.getAttribute("href") ?? "",
            // v3's ticket: Copy sits on the same ticket as the command, after a dashed tear line, with a notch each side.
            ticket: {
              holdsCopy: Boolean(ticket && copy && ticket.contains(copy)),
              tear: stub ? getComputedStyle(stub).borderLeftStyle : "none",
              notches: ticket ? ["::before", "::after"].map((p) => getComputedStyle(ticket, p).borderRadius).join(",") : "",
            },
            sends: section ? [...section.querySelectorAll("p")].filter((p) => (p.textContent ?? "").includes("sends nothing")).map((p) => (p.textContent ?? "").trim()) : [],
            trust: document.getElementById("tmTrust")?.textContent ?? "",
          };
        });
        expect(new URL(band.href, page.url()).pathname).toBe("/tm/");
        expect({ width, motion, ...band, href: "" }).toEqual({
          width, motion, first: "tmFirst", tag: "SECTION", cls: "tm-first", label: "Map your Claude week", headings: 0, promiseTag: "P", promise: TM_PROMISE,
          command: TM_COMMAND, commandTag: "CODE", copy: { tag: "BUTTON", type: "button", text: "Copy" }, live: "polite", watch: "Watch it run", watchTag: "A", href: "", sends: [],
          ticket: { holdsCopy: true, tear: "dashed", notches: "50%,50%" }, trust: TM_TRUST_LINE,
        });
        // The promise, the command, Copy, its notes, the trust line and Watch it run are on the first screen and nothing covers them.
        for (const id of ["tmPromise", "tmCommand", "tmCopy", "tmNotes", "tmScript", "tmTrust", "tmWatch"]) {
          const inView = await page.locator(`#${id}`).evaluate((node) => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
          const hit = id === "tmTrust" ? await hitsEveryLine(page, "#tmTrust") : await hitsItself(page, `#${id}`);
          expect({ width, motion, id, inView, hit }).toEqual({ width, motion, id, inView: true, hit: true });
        }
        if (motion === "reduce") {
          expect(await page.evaluate(() => [document.getElementById("tmFirst"), ...document.querySelectorAll("#tmFirst *")].flatMap((node) => {
            if (!node) return ["missing"];
            const s = getComputedStyle(node);
            return s.animationName !== "none" || s.transitionDuration.split(",").some((d) => parseFloat(d) > 0) ? [`${node.tagName}#${node.id}`] : [];
          }))).toEqual([]);
        }
      } finally { await page.close(); }
    }
  }, 30000);
}

test("[integration] TM2 Copy puts exactly the command on the clipboard and says Copied, the next step, the trust sentence and the Bun line in a polite live region", async () => {
  stripOn();
  for (const [width, height] of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    try {
      await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
      await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
      expect(await page.locator("#tmCopied").evaluate((node) => node.textContent ?? "")).toBe("");
      await page.locator("#tmCopy").click();
      await page.waitForFunction(() => (document.getElementById("tmCopied")?.textContent ?? "") !== "", undefined, { timeout: 3000 });
      expect({ width, said: await page.locator("#tmCopied").innerText(), live: await page.locator("#tmCopied").getAttribute("aria-live"), clip: await page.evaluate(() => navigator.clipboard.readText()) })
        .toEqual({ width, said: TM_COPIED, live: "polite", clip: TM_COMMAND });
    } finally { await context.close(); }
  }
}, 20000);

test("[integration] TM3 a clipboard that refuses or is missing selects the command and gives the keyboard hint with the trust sentence and the Bun line", async () => {
  stripOn();
  const stubs: [string, string][] = [
    ["refused", "Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: function () { return Promise.reject(new Error('denied')); } });"],
    ["missing", "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });"],
  ];
  for (const [how, stub] of stubs) for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "reduce", "", false, undefined, async (p) => { await p.addInitScript({ content: stub }); });
    try {
      await page.locator("#tmCopy").click();
      await page.waitForFunction(() => (document.getElementById("tmCopied")?.textContent ?? "") !== "", undefined, { timeout: 3000 });
      expect({ how, width, said: await page.locator("#tmCopied").innerText(), selected: await page.evaluate(() => window.getSelection()?.toString() ?? "") })
        .toEqual({ how, width, said: TM_HINT, selected: TM_COMMAND });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] TM4 while the curtain plays the band sits above it: the pointer at its centre reaches the band, the curtain starts at its bottom, and every playbill control is on screen and reachable", async () => {
  stripOn();
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      const band = await bandBox(page);
      const view = await page.evaluate(() => {
        const r = document.getElementById("tmFirst")?.getBoundingClientRect();
        const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
        const ov = document.getElementById("overture")?.getBoundingClientRect();
        const drapes = [...document.querySelectorAll(".overture .curtain")].map((node) => node.getBoundingClientRect().top);
        return { inBand: Boolean(hit && document.getElementById("tmFirst")?.contains(hit)), ovTop: ov ? ov.top : NaN, ovBottom: ov ? ov.bottom : NaN, drapes };
      });
      expect({ width, top: band.top, tall: band.height > 0, inBand: view.inBand, ovTop: Math.abs(view.ovTop - band.bottom) < 1, ovBottom: Math.abs(view.ovBottom - height) < 1, drapes: view.drapes.length === 2 && view.drapes.every((t) => Math.abs(t - band.bottom) < 1) })
        .toEqual({ width, top: 0, tall: true, inBand: true, ovTop: true, ovBottom: true, drapes: true });
      const parts = await curtainParts(page);
      // #238 pass 2 made the band taller (the command's notes and the trust line). A phone curtain with 520px of stage
      // or less is theatre.css's "short phone curtain": the decorative ticket steps out (display none, never clipped)
      // and every playbill control stays. At 390x844 the band now leaves less than 520px.
      const roomy = width > 720 || height - band.bottom > 520;
      for (const name of roomy ? ["marquee", "ticket", "skip", "madmax", "poster", "chip", "lights"] : ["marquee", "skip", "madmax", "poster", "chip", "lights"]) {
        const part = parts[name];
        expect({ width, name, inView: part?.inView, hit: part?.hit, belowBand: part ? part.top >= band.bottom : false }).toEqual({ width, name, inView: true, hit: true, belowBand: true });
      }
      if (!roomy) expect({ width, ticket: await page.evaluate(() => getComputedStyle(document.querySelector("#overture .ticket") ?? document.body).display) }).toEqual({ width, ticket: "none" });
      expect(await page.evaluate(() => {
        const t = document.querySelector("#overture .poster .p-cta")?.getBoundingClientRect();
        return Boolean(t && t.top >= 0 && t.bottom <= innerHeight);
      })).toBe(true);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] TM5 with the curtain closed the band's controls keep it closed: focus or a click on Copy; Tab goes Copy, the script note, Watch it run, Skip, the two posters, House lights, each with a visible focus ring", async () => {
  stripOn();
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference", "", false, undefined, async (p) => {
      await p.addInitScript({ content: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function () { return Promise.resolve(); } } });" });
    });
    try {
      await page.locator("#tmCopy").focus();
      expect((await curtain(page)).state).toBe("closed");
      await page.locator("#tmCopy").click();
      await page.waitForFunction(() => (document.getElementById("tmCopied")?.textContent ?? "") !== "", undefined, { timeout: 3000 });
      expect({ width, state: (await curtain(page)).state, y: await page.evaluate(() => scrollY) }).toEqual({ width, state: "closed", y: 0 });
      await page.locator("#tmWatch").focus();
      expect((await curtain(page)).state).toBe("closed");
    } finally { await page.close(); }
    const keys = await pageAt(width, height, "no-preference");
    try {
      expect({ width, stops: await tabStops(keys, TM_BAND_STOPS.length + 4) })
        .toEqual({ width, stops: [...TM_BAND_STOPS, "skipOverture", "madmax poster", "curtain poster", "lights"].map((stop) => ({ stop, state: "closed", ring: true })) });
    } finally { await keys.close(); }
  }
}, 30000);

test("[integration] TM6 the curtain still opens every way with the band above it: a scroll, Skip (focus to the results heading) and a #hash", async () => {
  stripOn();
  for (const [width, height] of VIEWPORTS) {
    const scrolled = await pageAt(width, height, "no-preference");
    try {
      await scrollToRunway(scrolled, 1.2);
      await scrolled.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      expect(await shownCurtains(scrolled)).toBe(0);
    } finally { await scrolled.close(); }
    const skipped = await pageAt(width, height, "no-preference");
    try {
      await skipped.locator("#skipOverture").click();
      const after = await skipped.evaluate(() => ({ state: document.documentElement.dataset.curtain, active: document.activeElement?.id, top: document.getElementById("results")?.getBoundingClientRect().top ?? NaN }));
      expect({ width, state: after.state, active: after.active, top: Math.abs(after.top) < 2 }).toEqual({ width, state: "open", active: "resultsTitle", top: true });
    } finally { await skipped.close(); }
    const hashed = await pageAt(width, height, "no-preference", "#act3");
    try {
      await hashed.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
      expect(await shownCurtains(hashed)).toBe(0);
    } finally { await hashed.close(); }
  }
}, 30000);

for (const [width, height] of VIEWPORTS) test(`[integration] TM7 at ${width}x${height} the command wraps inside its box, never inside "--share": no horizontal scroll with the curtain closed or open`, async () => {
  stripOn();
  const page = await pageAt(width, height, "no-preference");
  try {
    const measure = () => page.evaluate(() => {
      const code = document.getElementById("tmCommand"), band = document.getElementById("tmFirst");
      const r = code?.getBoundingClientRect(), b = band?.getBoundingClientRect();
      // "--share" never breaks across lines: a range over it has one line box.
      let share = -1;
      const walk = code ? document.createTreeWalker(code, NodeFilter.SHOW_TEXT) : null;
      for (let t = walk ? walk.nextNode() : null; t; t = walk ? walk.nextNode() : null) {
        const at = (t.textContent ?? "").indexOf("--share");
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(t, at);
        range.setEnd(t, at + 7);
        share = new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size;
      }
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        code: code ? code.scrollWidth - code.clientWidth : -1,
        inside: Boolean(r && b && r.width > 0 && r.left >= b.left && r.right <= b.right && r.right <= innerWidth),
        share,
      };
    });
    expect(await measure()).toEqual({ page: 0, code: 0, inside: true, share: 1 });
    await page.locator("#skipOverture").click();
    expect((await curtain(page)).state).toBe("open");
    await page.evaluate(() => { window.scrollTo({ top: 0, behavior: "instant" }); });
    await frames(page);
    expect(await measure()).toEqual({ page: 0, code: 0, inside: true, share: 1 });
  } finally { await page.close(); }
}, 15000);

test("[integration] TM8 the after-copy message carries the trust sentence and the exact Bun install line; the curtain follows the taller band and every playbill control stays on screen", async () => {
  stripOn();
  for (const motion of MOTIONS) for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, motion, "", false, undefined, async (p) => {
      await p.addInitScript({ content: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function () { return Promise.resolve(); } } });" });
    });
    try {
      expect(await page.locator("#tmFirst").evaluate((node) => (node.textContent ?? "").includes("sends nothing") || (node.textContent ?? "").includes("bun.sh"))).toBe(false);
      await page.locator("#tmCopy").click();
      await page.waitForFunction(() => (document.getElementById("tmCopied")?.textContent ?? "") !== "", undefined, { timeout: 3000 });
      const said = await page.locator("#tmCopied").evaluate((node) => ({ text: node.textContent ?? "", codes: [...node.querySelectorAll("code")].map((c) => c.textContent ?? ""), live: node.getAttribute("aria-live") }));
      expect({ motion, width, ...said }).toEqual({ motion, width, text: TM_COPIED, codes: [TM_BUN], live: "polite" });
      expect({ motion, width, inView: await page.locator("#tmCopied").evaluate((node) => { const r = node.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; }) })
        .toEqual({ motion, width, inView: true });
      if (motion === "no-preference") {
        expect((await curtain(page)).state).toBe("closed");
        // The curtain moves down with the taller band and still starts at its bottom; the playbill still fits.
        await page.waitForTimeout(100);
        await frames(page);
        const band = await bandBox(page);
        expect(Math.abs(await page.evaluate(() => document.getElementById("overture")?.getBoundingClientRect().top ?? NaN) - band.bottom)).toBeLessThan(1);
        const parts = await curtainParts(page);
        for (const name of ["marquee", "skip", "poster", "chip", "lights"]) {
          const part = parts[name];
          expect({ width, name, inView: part?.inView, hit: part?.hit, belowBand: part ? part.top >= band.bottom : false }).toEqual({ width, name, inView: true, hit: true, belowBand: true });
        }
      }
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] TM9 L1 holds with the band: the first heading on the page is still #t1, in both motions and viewports", async () => {
  stripOn();
  for (const motion of MOTIONS) for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, motion);
    try {
      expect({ motion, width, first: await page.locator(":is(h1,h2,h3,h4,h5,h6)").first().getAttribute("id") }).toEqual({ motion, width, first: "t1" });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] TM10 the band holds exactly four parts (the promise, the command with Copy, the command's notes, the trust line with Watch it run) and no other visible text, in one accent colour with the promise as the focal point", async () => {
  stripOn();
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "reduce");
    try {
      const band = await page.evaluate(() => {
        const section = document.getElementById("tmFirst");
        if (!section) return null;
        const shown = (node: Element) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden"; };
        const named = ["tmPromise", "tmCommand", "tmCopy", "tmNotes", "tmScript", "tmTrust", "tmWatch"];
        const parts = [...section.children].filter(shown).map((node) => [node, ...node.querySelectorAll("[id]")].map((c) => c.id).filter((id) => named.includes(id)).sort().join("+"));
        const owners = new Set<string>();
        let stray = 0;
        const walk = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
        for (let t = walk.nextNode(); t; t = walk.nextNode()) {
          const parent = t.parentElement;
          if (!parent || !(t.textContent ?? "").trim() || !shown(parent)) continue;
          const owner = parent.closest("#tmPromise, #tmCommand, #tmCopy, #tmNotes, #tmTrust, #tmWatch");
          if (owner) owners.add(owner.id); else stray++;
        }
        const focusable = [...section.querySelectorAll("a[href], button, summary, input, select, textarea, details, [tabindex]")].map((node) => node.id || node.tagName);
        const copy = document.getElementById("tmCopy"), promise = document.getElementById("tmPromise");
        const probe = document.createElement("i");
        probe.style.color = "var(--curtain)";
        section.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const everything = [section, ...section.querySelectorAll("*")];
        const ps = promise ? getComputedStyle(promise) : null;
        return {
          parts, owners: [...owners].sort(), stray, focusable,
          copyFill: copy ? getComputedStyle(copy).backgroundColor === accent : false,
          otherAccentFills: everything.filter((node) => node !== copy && getComputedStyle(node).backgroundColor === accent).length,
          gradients: everything.filter((node) => getComputedStyle(node).backgroundImage !== "none").length,
          promiseSize: ps ? parseFloat(ps.fontSize) : NaN, promiseFont: ps ? ps.fontFamily : "", promiseWeight: ps ? Number(ps.fontWeight) : NaN,
        };
      });
      if (!band) throw new Error("no #tmFirst");
      const [lo, hi] = width >= 1024 ? [40, 48] : [28, 32];
      expect({ width, parts: band.parts, owners: band.owners, stray: band.stray, focusable: band.focusable, copyFill: band.copyFill, otherAccentFills: band.otherAccentFills, gradients: band.gradients, size: band.promiseSize >= lo && band.promiseSize <= hi, serif: band.promiseFont.includes("Alegreya"), bold: band.promiseWeight >= 700 })
        .toEqual({ width, parts: ["tmPromise", "tmCommand+tmCopy", "tmNotes+tmScript", "tmTrust+tmWatch"], owners: ["tmCommand", "tmCopy", "tmNotes", "tmPromise", "tmTrust", "tmWatch"], stray: 0, focusable: TM_BAND_STOPS, copyFill: true, otherAccentFills: 0, gradients: 0, size: true, serif: true, bold: true });
    } finally { await page.close(); }
  }
}, 20000);

for (const motion of MOTIONS) test(`[integration] TM11 the trust line shows in the band at 390 and 1440, never hidden on phones, uncovered, with the curtain closed and open (${motion})`, async () => {
  stripOn();
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, motion);
    try {
      const look = () => page.locator("#tmTrust").evaluate((node) => {
        const r = node.getBoundingClientRect(), s = getComputedStyle(node), band = document.getElementById("tmFirst");
        return { text: node.textContent ?? "", inBand: Boolean(band?.contains(node)), shown: s.display !== "none" && s.visibility === "visible" && Number(s.opacity) > 0.9 && r.width > 0 && r.height > 0,
          inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, size: parseFloat(s.fontSize) >= 13 };
      });
      expect({ width, motion, ...(await look()), hit: await hitsEveryLine(page, "#tmTrust") }).toEqual({ width, motion, text: TM_TRUST_LINE, inBand: true, shown: true, inView: true, size: true, hit: true });
      if (motion === "no-preference") {
        await page.locator("#skipOverture").click();
        await page.evaluate(() => { window.scrollTo({ top: 0, behavior: "instant" }); });
        await frames(page);
        expect({ width, open: await look() }).toEqual({ width, open: { text: TM_TRUST_LINE, inBand: true, shown: true, inView: true, size: true } });
      }
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] TM12 before Copy the command's three parts are underlined, each tied to its note; the script note links to /tm/map.ts; the full command shows at 390 and 1440, wrapped, never clipped", async () => {
  stripOn();
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect(await page.locator("#tmCopied").evaluate((node) => node.textContent ?? "")).toBe("");
      const seen = await page.evaluate(() => {
        const code = document.getElementById("tmCommand");
        const box = code?.getBoundingClientRect();
        const toks = [...document.querySelectorAll("#tmCommand .tm-tok")].map((tok) => {
          const note = document.getElementById(tok.getAttribute("data-note") ?? "");
          const r = note?.getBoundingClientRect();
          const link = note?.querySelector("a[href]");
          const key = note?.querySelector(".tm-key");
          return {
            part: tok.textContent ?? "", underlined: getComputedStyle(tok).textDecorationLine.includes("underline"),
            key: key?.textContent ?? "", keyUnderlined: key ? getComputedStyle(key).textDecorationLine.includes("underline") : false,
            note: [...(note?.childNodes ?? [])].filter((c) => c !== key).map((c) => c.textContent ?? "").join("").trim(),
            href: link ? link.getAttribute("href") : null,
            inNotes: Boolean(note && document.getElementById("tmNotes")?.contains(note)),
            noteInView: Boolean(r && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth),
            // The part is rendered and seen (at least one line box with area, not hidden or transparent), and every line box
            // sits inside the command's box and on screen: nothing clipped or cut off. An empty rect list never passes.
            whole: Boolean(box) && tok.checkVisibility({ visibilityProperty: true, opacityProperty: true })
              && [...tok.getClientRects()].some((q) => q.width > 0 && q.height > 0)
              && [...tok.getClientRects()].every((q) => box !== undefined && q.left >= box.left - 0.5 && q.right <= box.right + 0.5 && q.top >= box.top - 0.5 && q.bottom <= box.bottom + 0.5 && q.right <= innerWidth && q.bottom <= innerHeight && q.top >= 0),
          };
        });
        const s = code ? getComputedStyle(code) : null;
        const copy = document.getElementById("tmCopy"), notes = document.getElementById("tmNotes");
        return {
          toks, text: code?.innerText ?? "", lines: code && s ? Math.round((code.getBoundingClientRect().height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / parseFloat(s.lineHeight)) : 0,
          clipped: code ? code.scrollWidth > code.clientWidth || code.scrollHeight > code.clientHeight + 1 : true,
          ellipsis: s ? s.textOverflow === "ellipsis" : true, wraps: s ? s.whiteSpace !== "nowrap" && s.whiteSpace !== "pre" : false,
          notesFollowTicket: Boolean(copy && notes && copy.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      });
      expect({ width, text: seen.text, clipped: seen.clipped, ellipsis: seen.ellipsis, wraps: seen.wraps, notesFollowTicket: seen.notesFollowTicket })
        .toEqual({ width, text: TM_COMMAND, clipped: false, ellipsis: false, wraps: true, notesFollowTicket: true });
      // At 390 the command needs more than one line to show in full; at 1440 it fits on one.
      expect({ width, wrapped: seen.lines > 1 }).toEqual({ width, wrapped: width < 720 });
      expect(seen.toks).toEqual(TM_NOTES.map((n) => ({ part: n.part, underlined: true, key: n.key, keyUnderlined: true, note: n.note, href: n.href, inNotes: true, noteInView: true, whole: true })));
      // The parts are the command: the notes annotate the copied text, they never change it.
      expect(`${TM_NOTES[0]?.part} | ${TM_NOTES[1]?.part} ${TM_NOTES[2]?.part}`).toBe(TM_COMMAND);
      const script = await page.request.get(new URL("/tm/map.ts", page.url()).toString());
      expect({ status: script.status(), same: (await script.text()) === readFileSync(join(SITE, "tm", "map.ts"), "utf8") }).toEqual({ status: 200, same: true });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] TM13 every link and button in the band is at least 24x24 px with text at least 13 px, at 390 and 1440, before and after Copy", async () => {
  stripOn();
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference", "", false, undefined, async (p) => {
      await p.addInitScript({ content: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function () { return Promise.resolve(); } } });" });
    });
    try {
      const measure = () => page.evaluate(() => [...document.querySelectorAll("#tmFirst a, #tmFirst button")].map((node) => {
        const r = node.getBoundingClientRect();
        return { id: node.id, ok: r.width >= 24 && r.height >= 24 && parseFloat(getComputedStyle(node).fontSize) >= 13 };
      }));
      const before = await measure();
      expect({ width, ids: before.map((c) => c.id), bad: before.filter((c) => !c.ok).map((c) => c.id) }).toEqual({ width, ids: TM_BAND_STOPS, bad: [] });
      await page.locator("#tmCopy").click();
      await page.waitForFunction(() => (document.getElementById("tmCopied")?.textContent ?? "") !== "", undefined, { timeout: 3000 });
      expect({ width, bad: (await measure()).filter((c) => !c.ok).map((c) => c.id) }).toEqual({ width, bad: [] });
    } finally { await page.close(); }
  }
}, 30000);


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
        expect((await bars(page)).every((b) => b.drawn < 1)).toBe(true);
        await scrollToRunway(page, 1.2);
        await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
        expect(fullBars(await bars(page))).toBe(true);
      } finally { await page.close(); }
    }
  }
}, 60000);

const CUES = ["rise", "swish", "slide-l", "slide-r", "wipe"];

test("[integration] L42 the light animations run under motion (stage-door swish, rising acts, sliding players, verdict wipe, marquee chase, drape sway) and stop under reduced motion", async () => {
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
      // Nothing is lit before it is seen: the door, off screen at load, waits hidden, without .in.
      expect(await page.evaluate(() => { const door = document.getElementById("door"); return door ? { lit: door.classList.contains("in"), opacity: getComputedStyle(door).opacity } : null; })).toEqual({ lit: false, opacity: "0" });
      expect(await page.evaluate((wanted) => {
        const found = new Set<string>();
        for (const sheet of document.styleSheets) {
          let rules: CSSRuleList;
          try { rules = sheet.cssRules; } catch (e) { continue; } // the blocked web-font sheet is cross-origin
          for (const rule of rules) if (rule instanceof CSSKeyframesRule) found.add(rule.name);
        }
        return wanted.filter((name) => !found.has(name));
      }, CUES)).toEqual([]);
      await into("#act2 > .stage");
      expect(await names("#act2 > .stage")).toBe("rise");
      await into("#cast");
      expect(await page.locator("#cast .player").evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).animationName))).toEqual(["slide-l", "slide-l", "slide-r"]);
      await into("#act5 > .stage");
      expect(await names("#act5 .verdict-word")).toBe("wipe");
      await into("#door");
      expect(await names("#door")).toBe("swish");
      expect(await names(".marquee-band .marquee", "::before")).toBe("chase");
      expect(await names(".drape.l")).toBe(width >= 1300 ? "sway" : "none");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect({ door: await names("#door"), stage: await names("#act2 > .stage"), chase: await names(".marquee-band .marquee", "::before"), sway: await names(".drape.l"), opacity: await page.evaluate(() => getComputedStyle(document.getElementById("door") ?? document.body).opacity) })
        .toEqual({ door: "none", stage: "none", chase: "none", sway: "none", opacity: "1" });
    } finally { await page.close(); }
  }
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "reduce");
    try {
      const shown = await page.evaluate(() => ({
        cues: document.documentElement.classList.contains("cues"),
        hidden: [...document.querySelectorAll("#door, #act2 > .stage, #act5 .verdict-word, #cast .player")].filter((n) => getComputedStyle(n).opacity !== "1" || getComputedStyle(n).animationName !== "none").length,
      }));
      expect({ width, ...shown }).toEqual({ width, cues: false, hidden: 0 });
    } finally { await page.close(); }
  }
}, 60000);

test("[integration] L43 keyboard: Shift+Tab to the header link after Skip keeps the curtain open and the focus; after a click, scrolling to the top closes it and puts focus on Skip", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    try {
      await page.locator("#skipOverture").click();
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
      await page.keyboard.press("Shift+Tab");
      await page.waitForTimeout(400);
      const link = await page.evaluate(() => ({ state: document.documentElement.dataset.curtain, focus: document.activeElement?.className ?? "" }));
      expect({ width, ...link }).toEqual({ width, state: "open", focus: "house-link" });
      // A clicked control is not keyboard focus: scrolling back to the top closes the curtain and moves focus to Skip.
      await page.evaluate(() => { window.scrollTo({ top: document.getElementById("results")?.offsetTop ?? 600, behavior: "instant" }); });
      await page.locator("#aboutSample > summary").click();
      await page.evaluate(() => { window.scrollTo({ top: 0, behavior: "instant" }); });
      await page.waitForFunction(() => document.documentElement.dataset.curtain === "closed", undefined, { timeout: 4000 });
      expect({ width, focus: await page.evaluate(() => document.activeElement?.id ?? "") }).toEqual({ width, focus: "skipOverture" });
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
const MADMAX = '#overture a[href="tm/"]';
/** The three header parts that showed through the closed curtain in the #248 report. */
const HEADER_PARTS = ["header.house .brand", "header.house > .ticket", "header.house .house-link"];

/** The curtain's marquee width, billing font size and ticket area (its box on screen, turned as it is). */
async function playbillSizes(page: Page): Promise<{ ticketArea: number; marqueeWidth: number; billing: number }> {
  return page.evaluate(() => {
    const t = document.querySelector("#overture .ticket")?.getBoundingClientRect(), m = document.querySelector("#overture .marquee")?.getBoundingClientRect();
    const b = document.querySelector("#overture .marquee .billing");
    return { ticketArea: t ? Math.round(t.width * t.height) : NaN, marqueeWidth: m ? Math.round(m.width) : NaN, billing: b ? parseFloat(getComputedStyle(b).fontSize) : NaN };
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
 * overscroll a trackpad or a finger gives; each box is screenshotted at rest and every 100ms of a 2s pull). The curtain
 * does not move while closed, so any change in a header part's box during the pull is the page showing.
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
    const cdp = await page.context().newCDPSession(page);
    let pulling = true;
    const pull = cdp.send("Input.synthesizeScrollGesture", { x: width / 2, y: Math.round(height * 0.9), yDistance: 600, speed: 300, gestureSourceType: "touch", preventFling: true })
      .finally(() => { pulling = false; });
    const shown = new Set<number>();
    for (let frame = 0; frame < 24 && (pulling || frame < 4); frame++) {
      await page.waitForTimeout(100);
      for (const [i, clip] of boxes.entries()) {
        const before = resting[i];
        if (!clip || !before || shown.has(i)) continue;
        if (!(await page.screenshot({ clip })).equals(before)) shown.add(i);
      }
    }
    await pull;
    return { atRest, painted, pulled: shown.size };
  } finally { await elastic.close(); }
}

test("[integration] MM1 at 1440x900 the marquee leads and the ticket is a small prop: ticket area at most 0.4 of before #248, marquee width and billing at least 1.5 times", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    expect((await curtain(page)).state).toBe("closed");
    const now = await playbillSizes(page);
    // Asserted unrounded; rounded only for the log line.
    const ratio = { ticket: now.ticketArea / BEFORE_248.ticketArea, marquee: now.marqueeWidth / BEFORE_248.marqueeWidth, billing: now.billing / BEFORE_248.billing };
    console.log(`#248 MM1 1440x900 now ${JSON.stringify(now)} before ${JSON.stringify(BEFORE_248)} ratio ticket ${ratio.ticket.toFixed(3)} marquee ${ratio.marquee.toFixed(3)} billing ${ratio.billing.toFixed(3)}`);
    expect({ ticket: ratio.ticket <= 0.4 ? "<=0.4" : ratio.ticket.toFixed(4), marquee: ratio.marquee >= 1.5 ? ">=1.5" : ratio.marquee.toFixed(4), billing: ratio.billing >= 1.5 ? ">=1.5" : ratio.billing.toFixed(4) })
      .toEqual({ ticket: "<=0.4", marquee: ">=1.5", billing: ">=1.5" });
  } finally { await page.close(); }
}, 15000);

test("[integration] MM2 wide screens (1716x910, 1440x900, 1100x700): the marquee spans the top centre, and under it the playbill, the Mad TokenMax poster and the Little Shop poster stand in one row; the poster is one link to tm/, at least 240px wide at 1440, with its image loaded, sized and named", async () => {
  for (const [width, height] of [[1716, 910], [1440, 900], [1100, 700]] satisfies [number, number][]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      expect({ width, links: await page.locator(MADMAX).count() }).toEqual({ width, links: 1 });
      await page.locator(`${MADMAX} img`).evaluate((img) => img instanceof HTMLImageElement ? img.decode().catch(() => undefined) : undefined);
      const img = await page.locator(`${MADMAX} img`).evaluate((node) => ({
        alt: node.getAttribute("alt") ?? "", sized: Number(node.getAttribute("width")) > 0 && Number(node.getAttribute("height")) > 0,
        loaded: node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0, src: node.getAttribute("src") ?? "",
      }));
      expect({ width, show: /mad tokenmax/i.test(img.alt), poster: /poster/i.test(img.alt), sized: img.sized, loaded: img.loaded, src: img.src })
        .toEqual({ width, show: true, poster: true, sized: true, loaded: true, src: "shows/madtokenmax-poster.webp" });
      const [marquee, ticket, skip, madmax, poster] = await Promise.all(["#overture .marquee", "#overture .ticket", "#skipOverture", MADMAX, "#overture a.poster"].map((s) => partOf(page, s)));
      if (!marquee || !ticket || !skip || !madmax || !poster) throw new Error(`a part of the curtain is missing at ${width}`);
      const row = [ticket, madmax, poster];
      expect({
        width,
        marqueeOnTop: row.every((p) => marquee.bottom <= p.top), centred: Math.abs((marquee.left + marquee.right) / 2 - width / 2) <= 24,
        order: ticket.right < madmax.left && madmax.right < poster.left && skip.right < madmax.left,
        oneRow: madmax.top < poster.bottom && poster.top < madmax.bottom && madmax.top < skip.bottom && ticket.top < madmax.bottom,
        shown: [madmax, poster, skip, ticket, marquee].every((p) => p.inView && p.hit), turned: madmax.turned,
        wide: width === 1440 ? madmax.right - madmax.left >= 240 : true,
      }).toEqual({ width, marqueeOnTop: true, centred: true, order: true, oneRow: true, shown: true, turned: true, wide: true });
      if (width === 1440) console.log(`#248 MM2 1440x900 Mad TokenMax poster link ${Math.round(madmax.right - madmax.left)}x${Math.round(madmax.bottom - madmax.top)}px`);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] MM3 the Mad TokenMax poster is a keyboard stop after Skip with a visible focus ring, keeps the curtain closed, and opens tm/", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    await page.locator("#skipOverture").focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate((sel) => {
      const a = document.activeElement, s = a ? getComputedStyle(a) : null;
      return { madmax: Boolean(a?.matches(sel)), ring: Boolean(a?.matches(":focus-visible") && s && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2), state: document.documentElement.dataset.curtain };
    }, MADMAX)).toEqual({ madmax: true, ring: true, state: "closed" });
    await Promise.all([page.waitForURL(/\/tm\/$/, { waitUntil: "commit" }), page.locator(MADMAX).click()]);
    expect(new URL(page.url()).pathname).toBe("/tm/");
  } finally { await page.close(); }
}, 15000);

test("[integration] MM4 narrow screens (390x844, 1024x768): the two posters sit side by side under Skip as small cards, each at least 44px, no blurb, no horizontal scroll", async () => {
  for (const [width, height] of [[390, 844], [1024, 768]] satisfies [number, number][]) {
    const page = await pageAt(width, height, "no-preference");
    try {
      expect((await curtain(page)).state).toBe("closed");
      const [skip, madmax, poster] = await Promise.all(["#skipOverture", MADMAX, "#overture a.poster"].map((s) => partOf(page, s)));
      if (!skip || !madmax || !poster) throw new Error(`a part of the curtain is missing at ${width}`);
      expect({
        width, underSkip: madmax.top >= skip.bottom && poster.top >= skip.bottom, sideBySide: madmax.right <= poster.left && madmax.top < poster.bottom && poster.top < madmax.bottom,
        tap: [madmax, poster].every((p) => p.right - p.left >= 44 && p.bottom - p.top >= 44), shown: [skip, madmax, poster].every((p) => p.inView && p.hit),
        blurb: await page.locator("#overture .p-blurb").isVisible(), overflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      }).toEqual({ width, underSkip: true, sideBySide: true, tap: true, shown: true, blurb: false, overflow: 0 });
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
