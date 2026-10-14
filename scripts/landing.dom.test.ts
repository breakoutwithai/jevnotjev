import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import posters from "../site/shows/posters.json";

declare global {
  interface Window { JNJ: { cases: { id: string; prompt: string; truth: string; arms: { C: { picked: string; confidence?: number } } }[] } }
}

const SITE = process.env.LANDING_TEST_SITE ?? join(import.meta.dir, "..", "site");
const RECORDS = readFileSync(join(import.meta.dir, "..", "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv"), "utf8");
const FIRST_SHOW = posters.posters.find((p) => p.stage === "show")?.id;
const VIEWPORTS: [number, number][] = [[390, 844], [1440, 900]];
const ACTION_VIEWPORTS: [number, number][] = [[390, 844], [1280, 900], [1440, 900]];
const MOTIONS: ("no-preference" | "reduce")[] = ["no-preference", "reduce"];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === "/api/tickets/ranking") return Response.json({ ids: [], counts: {} });
    if (pathname === "/api/tickets" && request.method === "POST") {
      const body: unknown = await request.json();
      const kind = typeof body === "object" && body !== null && Reflect.get(body, "kind") === "backstage" ? "backstage" : "show";
      return Response.json({ ticket: "T1", kind, show: kind === "show" ? FIRST_SHOW : null });
    }
    const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

async function pageAt(width: number, height: number, motion: "no-preference" | "reduce" = "reduce", hash = "", catalogueFails = false, errors?: string[]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion });
  if (errors) page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  if (catalogueFails) await page.route("**/shows/posters.json", (route) => route.fulfill({ status: 500, body: "unavailable" }));
  await page.goto(`http://127.0.0.1:${server.port}/${hash}`, { waitUntil: "domcontentloaded" });
  if (!catalogueFails) await page.waitForFunction(() => document.querySelectorAll("#tkPosters .tk-poster").length > 0);
  return page;
}

for (const motion of MOTIONS) {
  test(`[integration] L1-L5 first screen and order (${motion})`, async () => {
    for (const [width, height] of ACTION_VIEWPORTS) {
      const page = await pageAt(width, height, motion);
      try {
        expect(await page.locator("main :is(h1,h2,h3)").first().getAttribute("id")).toBe("t1");
        expect(await page.locator("#t1").innerText()).toBe("Jev picks one answer from a fixed list. It does not write text.");
        if (width >= 1280) expect(await page.locator("#t1").evaluate((node) => {
          const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length;
        })).toBeLessThanOrEqual(2);
        const result = await page.locator("#heroResult").innerText();
        for (const word of ["100", "Jev", "LLM", "simple rule", "Verdict: Use Jev (rule 3)."] ) expect(result).toContain(word);
        expect(await page.locator("#heroWhy").innerText()).toContain("Why: On 100 shop messages");
        expect(await page.locator("#primaryAction").innerText()).toBe("Try it: pick a seat");
        expect(new URL(await page.locator("#primaryAction").getAttribute("href") ?? "", page.url()).pathname).toBe("/little-shop/");
        const actionProbe = await page.locator("#primaryAction").evaluate((node) => {
          const box = node.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { top: box.top, height: box.height, viewport: innerHeight, hit: hit?.tagName, covered: hit === node || node.contains(hit) };
        });
        expect(actionProbe.top >= 0 && actionProbe.top < height && actionProbe.covered).toBe(true);
        expect(await page.evaluate(() => {
          const ids = ["heroResult", "tkPosters", "tkForm", "act2"].map((id) => document.getElementById(id));
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
      expect(await card.locator(".tk-verdict").isVisible()).toBe(true);
      expect(await card.locator(".tk-figure, .tk-verdict").evaluateAll((nodes) => nodes.every((node) => !node.closest("details")))).toBe(true);
      expect(await card.locator(".tk-primary").count()).toBe(1);
      expect(await card.locator(".tk-figure").count()).toBe(await card.evaluate((node) => node.classList.contains("tk-script-reading") ? 0 : 1));
      const figure = await card.locator(".tk-figure").count() ? await card.locator(".tk-figure").innerText() : "";
      if (/\d+ of \d+/.test(figure)) expect(figure.match(/\b(Jev|LLM|simple rule)\b[^\d]*\d+ of \d+/gi)).toHaveLength(1);
    }
    expect(await page.locator("#tkPosters").innerText()).not.toMatch(/Fit check: .* \/ /);
    expect(await page.locator("#askForm, #askInput, .overture, #runway").count()).toBe(0);
  } finally { await page.close(); }
});

test("[integration] L9 cases disclosure and confidence ordered spotlights", async () => {
  const page = await pageAt(1440, 900);
  try {
    expect(await page.locator("#allCases").getAttribute("open")).toBeNull();
    expect(await page.locator("#allCases summary").innerText()).toBe("See all 100 cases");
    expect(await page.locator("#allCases .case.row").count()).toBe(100);
    const spots = page.locator("#act3 .spotlight");
    expect(await spots.count()).toBe(2);
    const expected = await page.evaluate(() => window.JNJ.cases.filter((c) => c.arms.C.picked !== c.truth)
      .sort((a, b) => (b.arms.C.confidence ?? 0) - (a.arms.C.confidence ?? 0)).slice(0, 2)
      .map((c) => ({ id: c.id, prompt: c.prompt })));
    for (let i = 0; i < expected.length; i++) {
      expect(await spots.nth(i).innerText()).toContain(expected[i]?.id ?? "");
      expect(await spots.nth(i).innerText()).toContain(expected[i]?.prompt ?? "");
      expect(await spots.nth(i).locator(".monologue b").textContent()).toBe(i === 0 ? "Spotlight" : "Next miss");
    }
    expect(await page.locator("#allCases .monologue").count()).toBe(0);
    await page.locator("#allCases").evaluate((node) => { (node as HTMLDetailsElement).open = true; });
    expect(await page.locator(".case.row .conf").first().evaluate((node) => getComputedStyle(node).height)).toBe("4px");
    expect(await page.locator(".case.wrong .conf i").first().evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(178, 56, 42)");
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
    const target = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await target.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
      const response = await target.goto(new URL(p.watch ?? "", `http://127.0.0.1:${server.port}/`).href, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      expect(await target.locator('input[type="email"]').evaluateAll((nodes) => nodes.filter((node) => !node.closest("#officePanel")).length)).toBe(0);
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
    for (const selector of ["#versus", "#because li"]) {
      for (const text of await page.locator(selector).allInnerTexts()) {
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
      // #201 adds the explained verdict to every card: measured 8085 at 390 and 4610 at 1440 on 2026-10-13.
      expect(measure.height).toBeLessThan(width === 390 ? 8500 : 5000);
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
