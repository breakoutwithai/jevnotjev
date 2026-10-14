import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import posters from "../site/shows/posters.json";

declare global {
  interface Window {
    JNJ: { cases: { id: string; prompt: string; truth: string; arms: { C: { picked: string; confidence?: number } } }[] };
    /** Test-only accessor for the overture's animations, installed by held()'s init script. */
    jnjCurtain?: () => (CSSAnimation | null)[];
  }
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
    expect(await page.locator("#askForm, #askInput, #runway").count()).toBe(0);
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
    await page.locator("#allCases").evaluate((node) => { if (node instanceof HTMLDetailsElement) node.open = true; });
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
      if (hash === "#tkForm") await deep.waitForFunction(() => document.activeElement?.getAttribute("name") === "kind");
    } finally { await deep.close(); }
  }
}, 15000);

test("[integration] T-reopen issued ticket can be followed by a fresh form", async () => {
  const page = await pageAt(390, 844);
  try {
    await page.locator("#officeOpen").click();
    await page.locator("#tkShow").selectOption(FIRST_SHOW ?? "");
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
    expect(await page.locator("#tkShow").inputValue()).toBe("");
    expect(await page.locator("#tkConsent").isChecked()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("kind");
  } finally { await page.close(); }
}, 15000);

test("[integration] T-reopen-backstage after a backstage request the reopened form is a working show form", async () => {
  const page = await pageAt(390, 844);
  try {
    await page.locator("#officeOpen").click();
    await page.locator('input[name="kind"][value="backstage"]').check();
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
    expect(await page.locator('input[name="kind"][value="show"]').isChecked()).toBe(true);
    expect(await page.locator("#tkShowField").isVisible()).toBe(true);
    expect(await page.locator("#tkWebsiteField").isVisible()).toBe(false);
    expect(await page.locator("#tkForm .tk-submit").innerText()).toBe("Get my ticket");
  } finally { await page.close(); }
}, 15000);

test("[integration] T-catalogue failed catalogue offers backstage", async () => {
  const errors: string[] = [];
  const page = await pageAt(390, 844, "reduce", "", true, errors);
  try {
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[value="show"]')?.disabled);
    expect(await page.locator('input[value="backstage"]').isChecked()).toBe(true);
    expect(await page.locator('input[value="show"]').isDisabled()).toBe(true);
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

/** Centre of the primary action, and whether the topmost element there is the action itself. */
async function actionHit(page: Page): Promise<{ covered: boolean; hit: string }> {
  return page.locator("#primaryAction").evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { covered: hit === node || node.contains(hit), hit: hit ? hit.tagName : "none" };
  });
}

/*
 * One control of the curtain timeline, shared by every curtain test. No curtain test waits on the wall clock:
 * - held() freezes the page's timers with a paused fake clock (theatre.js's fallback fires only on clock.runFor) and
 *   holds theatre.js at the network (no cleanup runs until release()).
 * - seize() proves the CSS animations advance on their own, then pauses them and rewinds to the start, so a slow load
 *   cannot let the overture finish before a test reads it.
 * - seek() moves the paused timeline to a fraction of its end and reads what a viewer would see.
 * - finishCurtain() ends the animations, so with the clock paused only the animationend listener can open the curtain.
 */
const CURTAIN_ANIMATIONS = ["overture-out", "part-l", "part-r"];

/** Installed before any page script: the overture's own animations in CURTAIN_ANIMATIONS order, null for a missing one. */
function installCurtainAccessor(names: string[]): void {
  window.jnjCurtain = () => {
    const overture = document.querySelector(".overture");
    const all = overture ? overture.getAnimations({ subtree: true }) : [];
    return names.map((name) => all.find((a): a is CSSAnimation => a instanceof CSSAnimation && a.animationName === name) ?? null);
  };
}

const FAKE_START = Date.UTC(2026, 0, 1);

async function held(width: number, height: number, motion: "no-preference" | "reduce"): Promise<{ page: Page; release: () => Promise<void> }> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion });
  // A fixed fake start, then pause one second after it: pauseAt only moves forward, so neither may depend on today's date.
  await page.clock.install({ time: FAKE_START });
  await page.clock.pauseAt(FAKE_START + 1000);
  await page.addInitScript(installCurtainAccessor, CURTAIN_ANIMATIONS);
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  await page.route("**/theatre.js", async (route) => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "commit" });
  await page.waitForFunction(() => document.getElementById("primaryAction") !== null && document.querySelectorAll(".overture .curtain").length === 2);
  const release = async (): Promise<void> => {
    open();
    await page.waitForFunction(() => document.documentElement.dataset.curtain !== undefined);
  };
  return { page, release };
}

/** Proves the curtain animations run by themselves (none paused, the part clock moving), then pauses and rewinds them. */
async function seize(page: Page): Promise<{ states: string[]; delays: number[]; advanced: boolean; endMs: number }> {
  const first = await page.evaluate(() => {
    const anims = window.jnjCurtain?.() ?? [];
    return {
      states: anims.map((a) => a ? a.playState : "missing"),
      delays: anims.slice(1).map((a) => Number(a?.effect?.getTiming().delay ?? -1)),
      t: Number(anims[1]?.currentTime ?? -1),
    };
  });
  // The part animation either moves on from where it was, or has already played through: never stuck.
  const advanced = await page.waitForFunction((t) => {
    const part = window.jnjCurtain?.()[1];
    return Boolean(part) && (part?.playState === "finished" || Number(part?.currentTime ?? -1) > t);
  }, first.t, { timeout: 1000 }).then(() => true, () => false);
  const endMs = await page.evaluate(() => {
    const anims = window.jnjCurtain?.() ?? [];
    anims.forEach((a) => a?.pause());
    return Math.max(0, ...anims.slice(1).map((a) => Number(a?.effect?.getComputedTiming().endTime ?? 0)));
  });
  await seek(page, 0, endMs);
  return { states: first.states, delays: first.delays, advanced, endMs };
}

/**
 * What a viewer sees of one curtain: on-screen width, whether it spans the full viewport height, effective opacity
 * (all ancestors), visibility and pointer.
 */
interface CurtainView { left: number; right: number; onScreen: number; fullHeight: boolean; opacity: number; visible: boolean; pointer: string }

/** Reads both curtains without moving the timeline. */
async function viewCurtains(page: Page): Promise<CurtainView[]> {
  return page.evaluate(() => [...document.querySelectorAll(".overture .curtain")].map((node) => {
    let opacity = 1;
    for (let el: Element | null = node; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
    const box = node.getBoundingClientRect();
    const onScreen = node.getClientRects().length > 0 && box.height > 0 ? Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0)) : 0;
    const style = getComputedStyle(node);
    return { left: Math.round(box.left), right: Math.round(box.right), onScreen: Math.round(onScreen), fullHeight: box.top <= 0 && box.bottom >= innerHeight, opacity, visible: style.visibility === "visible", pointer: style.pointerEvents };
  }));
}

/** The painted RGBA of one viewport pixel, read from a 1x1 screenshot decoded in the page (no image file kept). */
async function paintedAt(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const ctx = new OffscreenCanvas(1, 1).getContext("2d");
    ctx?.drawImage(bitmap, 0, 0);
    return [...(ctx?.getImageData(0, 0, 1, 1).data ?? [])];
  }, png.toString("base64"));
}

/** Opaque curtain red (between --curtain-lo #3e0710 and --curtain-hi #a3263a), never the light page background. */
function isCurtainRed([r = 0, g = 255, b = 255, a = 0]: number[]): boolean {
  return a === 255 && r >= 50 && g < 60 && r > 2 * g && r > 1.4 * b;
}

/** Curtains a viewer could see: on screen, not hidden, not transparent. */
async function shownCurtains(page: Page): Promise<number> {
  return (await viewCurtains(page)).filter((c) => c.onScreen > 0 && c.visible && c.opacity > 0).length;
}

/**
 * Moves the paused curtain timeline to a fraction of its end and reads both curtains. A part animation never goes back
 * into its delay: seeking from the active phase to the before phase dispatches a real animationend (elapsedTime 0), which
 * theatre.js would take as the curtain having parted. Its first active frame looks the same as the delay (fill: both).
 */
async function seek(page: Page, fraction: number, endMs: number): Promise<CurtainView[]> {
  await page.evaluate((ms) => {
    (window.jnjCurtain?.() ?? []).forEach((a) => {
      if (a) a.currentTime = a.animationName === "overture-out" ? ms : Math.max(ms, Number(a.effect?.getTiming().delay ?? 0));
    });
  }, fraction * endMs);
  return viewCurtains(page);
}

/** Ends the curtain animations and reports whether the curtain then opened (the fake clock stays paused). */
async function finishCurtain(page: Page): Promise<boolean> {
  await page.evaluate(() => { (window.jnjCurtain?.() ?? []).forEach((a) => a?.finish()); });
  return page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 1000 }).then(() => true, () => false);
}

const CURTAIN_VIEWPORTS: [number, number][] = [[1280, 900], [390, 844]];
/** Every curtain animation found and playing by itself: running, or already played through on a slow load. */
function playsItself(states: string[]): boolean {
  return states.length === 3 && states.every((s) => s === "running" || s === "finished");
}

test("[integration] L16 the curtain plays by itself, already parting at the first frame, half open midway, parted at the end, opened by animationend", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    const { page, release } = await held(width, height, "no-preference");
    try {
      expect(await page.evaluate(() => document.documentElement.classList.contains("motion"))).toBe(true);
      const line = await seize(page);
      expect(playsItself(line.states)).toBe(true);
      expect(line.advanced).toBe(true);
      // No hold before parting: both parts start moving at 0 and are done in 1.0 to 1.5s.
      expect(line.delays).toEqual([0, 0]);
      expect(line.endMs >= 1000 && line.endMs <= 1500).toBe(true);
      const half = width / 2;
      // First frame: both curtains opaque, visible, full height, letting every pointer through, each covering most of
      // its half, with a gap between them so the page shows from the first frame.
      const start = await seek(page, 0, line.endMs);
      for (const c of start) {
        expect({ opacity: c.opacity, visible: c.visible, fullHeight: c.fullHeight, pointer: c.pointer }).toEqual({ opacity: 1, visible: true, fullHeight: true, pointer: "none" });
        expect(c.onScreen > half * 0.7 && c.onScreen < half).toBe(true);
      }
      expect(start[0]?.left).toBeLessThanOrEqual(0);
      expect(start[1]?.right).toBeGreaterThanOrEqual(width);
      expect((start[1]?.left ?? 0) - (start[0]?.right ?? 0)).toBeGreaterThan(0);
      // And it is painted: the centre of each curtain is opaque curtain red, not the page behind it.
      for (const x of [width / 4, (3 * width) / 4]) {
        const pixel = await paintedAt(page, x, height / 2);
        expect({ x, pixel, red: isCurtainRed(pixel) }).toEqual({ x, pixel, red: true });
      }
      expect((await actionHit(page)).covered).toBe(true);
      // Midway: each still visible, opaque and full height, partly on screen, each covering less than half.
      const mid = await seek(page, 0.6, line.endMs);
      for (const c of mid) {
        expect({ opacity: c.opacity, visible: c.visible, fullHeight: c.fullHeight }).toEqual({ opacity: 1, visible: true, fullHeight: true });
        expect(c.onScreen > 0 && c.onScreen < half).toBe(true);
      }
      // End: neither covers any of the screen. Read just short of the end: seeking onto it queues the real animationend,
      // which must stay unfired until finishCurtain() so the event path is what this test proves.
      const end = await seek(page, 0.999, line.endMs);
      expect(end.map((c) => c.onScreen)).toEqual([0, 0]);
      await seek(page, 0, line.endMs);
      await release();
      expect(await page.evaluate(() => document.documentElement.dataset.curtain)).toBe("parting");
      expect(await finishCurtain(page)).toBe(true);
      expect(await page.evaluate(() => document.getElementById("overture")?.classList.contains("gone"))).toBe(true);
      expect(await shownCurtains(page)).toBe(0);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      expect(await actionHit(page)).toEqual({ covered: true, hit: "A" });
    } finally { await release(); await page.close(); }
  }
}, 30000);

test("[integration] L16b a curtain whose animation never ends is taken off the page by the fallback timer", async () => {
  const { page, release } = await held(390, 844, "no-preference");
  try {
    const line = await seize(page);
    expect(playsItself(line.states)).toBe(true);
    expect(await shownCurtains(page)).toBe(2);
    await release();
    // The fallback waits 1.8s: past the 1.3s part, with margin.
    await page.clock.runFor(1700);
    expect(await page.evaluate(() => document.documentElement.dataset.curtain)).toBe("parting");
    await page.clock.runFor(200);
    expect(await page.evaluate(() => document.documentElement.dataset.curtain)).toBe("open");
    expect(await page.evaluate(() => document.getElementById("overture")?.classList.contains("gone"))).toBe(true);
    expect(await shownCurtains(page)).toBe(0);
    expect(await actionHit(page)).toEqual({ covered: true, hit: "A" });
  } finally { await release(); await page.close(); }
}, 15000);

test("[integration] L17 under reduced motion no closed curtain is shown, even before the curtain script loads", async () => {
  for (const [width, height] of CURTAIN_VIEWPORTS) {
    const { page, release } = await held(width, height, "reduce");
    try {
      const before = await page.evaluate(() => ({
        motion: document.documentElement.classList.contains("motion"),
        animations: (window.jnjCurtain?.() ?? []).filter(Boolean).length,
      }));
      expect(before).toEqual({ motion: false, animations: 0 });
      expect(await shownCurtains(page)).toBe(0);
      expect((await actionHit(page)).covered).toBe(true);
      await release();
      expect(await page.evaluate(() => document.documentElement.dataset.curtain)).toBe("open");
      expect(await shownCurtains(page)).toBe(0);
    } finally { await release(); await page.close(); }
  }
}, 30000);

test("[integration] L19 turning on reduced motion while the page is open stops the marquee and drapes and drops the curtain", async () => {
  const page = await pageAt(1440, 900, "no-preference");
  try {
    const running = () => page.evaluate(() => ({
      bulbs: getComputedStyle(document.querySelector(".marquee") ?? document.body, "::before").animationName,
      drape: getComputedStyle(document.querySelector(".drape.l") ?? document.body).animationName,
    }));
    expect(await running()).toEqual({ bulbs: "chase", drape: "sway" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await running()).toEqual({ bulbs: "none", drape: "none" });
  } finally { await page.close(); }
  const { page: mid, release } = await held(390, 844, "no-preference");
  try {
    const line = await seize(mid);
    expect(playsItself(line.states)).toBe(true);
    expect(await shownCurtains(mid)).toBe(2);
    await mid.emulateMedia({ reducedMotion: "reduce" });
    expect(await shownCurtains(mid)).toBe(0);
  } finally { await release(); await mid.close(); }
}, 30000);

for (const motion of MOTIONS) {
  test(`[integration] L18 the theatre frame stays: valance, marquee, ADMIT ONE ticket and the Little Shop poster (${motion})`, async () => {
    for (const [width, height] of ACTION_VIEWPORTS) {
      const page = await pageAt(width, height, motion);
      try {
        await page.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
        for (const selector of [".valance", ".marquee", ".ticket .admit", ".ticket .stub", "a.poster"]) expect(await page.locator(selector).first().isVisible()).toBe(true);
        expect(await page.locator(".valance").evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
        expect(await page.locator(".marquee").innerText()).toMatch(/Jev!Jev presents[\s\S]*To Jev or not to Jev/i);
        expect(await page.locator(".ticket .admit").innerText()).toBe("ADMIT ONE");
        const poster = page.locator("a.poster");
        expect(await poster.innerText()).toContain("Little Shop of Horrors");
        expect(new URL(await poster.getAttribute("href") ?? "", page.url()).pathname).toBe("/little-shop/");
        // The marquee bills the show above the hero; on a phone the poster never sits above the primary action.
        const order = await page.evaluate(() => {
          const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
          const marquee = box(".marquee"), t1 = box("#t1"), action = box("#primaryAction"), poster = box("a.poster");
          return { marqueeAbove: Boolean(marquee && t1 && marquee.bottom <= t1.top), posterBelow: Boolean(poster && action && (innerWidth >= 900 || poster.top >= action.bottom)) };
        });
        expect(order).toEqual({ marqueeAbove: true, posterBelow: true });
      } finally { await page.close(); }
    }
  }, 30000);
}

test("[integration] L20 the Little Shop poster has one short accessible name, shared by no other link", async () => {
  const page = await pageAt(390, 844);
  try {
    const name = "Little Shop of Horrors: take your seat";
    expect(await page.locator("a.poster").getAttribute("aria-label")).toBe(name);
    expect(await page.getByRole("link", { name, exact: true }).count()).toBe(1);
    const names = await page.locator("a[href]:visible").evaluateAll((links) => links.map((link) => link.getAttribute("aria-label") || link.textContent?.trim() || ""));
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  } finally { await page.close(); }
});

/** The same tab's first and second visit: the overture plays on the first only. */
test("[integration] L21 the overture plays once per tab session, and a page whose storage throws still renders", async () => {
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
    expect((await actionHit(page)).covered).toBe(true);
  } finally { await page.close(); }

  const blocked = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });
  const errors: string[] = [];
  blocked.on("pageerror", (error) => errors.push(error.message));
  try {
    await blocked.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new DOMException("storage blocked", "SecurityError"); } });
    });
    await blocked.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await blocked.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
    await blocked.waitForFunction(() => document.querySelectorAll("#tkPosters .tk-poster").length > 0);
    expect(await blocked.evaluate(() => {
      try { window.sessionStorage.getItem("x"); return "storage readable"; } catch { return "storage throws"; }
    })).toBe("storage throws");
    // Unknown whether it was seen: play it, once, and never break the page.
    expect(await blocked.evaluate(() => document.documentElement.classList.contains("overture-play"))).toBe(true);
    expect(await blocked.locator("#t1").isVisible()).toBe(true);
    await blocked.waitForFunction(() => document.documentElement.dataset.curtain === "open", undefined, { timeout: 3000 });
    expect(errors).toEqual([]);
  } finally { await blocked.close(); }
}, 30000);
