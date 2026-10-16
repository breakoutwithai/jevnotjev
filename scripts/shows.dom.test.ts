// #237: one player for every show, and one "Bring your own decision" button. Reads posters.json and replay-data.js from
// SITE (LANDING_TEST_SITE overrides it) so the same checks can run against another site tree.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import type { Poster } from "../src/shows/posters.ts";

const SITE = resolve(process.env.LANDING_TEST_SITE ?? join(import.meta.dir, "..", "site"));
const POSTERS: { posters: Poster[] } = JSON.parse(readFileSync(join(SITE, "shows", "posters.json"), "utf8"));
const CAPTURE = process.env.UAT_SCREENSHOT_DIR;
const PREFIX = "window.JNJ_REPLAY = ";
const IDEA = "Assess my use case: ";

function replayRuns(): { key: string; file: string }[] {
  const js = readFileSync(join(SITE, "replay", "replay-data.js"), "utf8");
  const at = js.lastIndexOf(`\n${PREFIX}`) + 1;
  if (at === 0) throw new Error("no window.JNJ_REPLAY assignment");
  const data: unknown = JSON.parse(js.slice(at + PREFIX.length).trim().replace(/;$/, ""));
  if (typeof data !== "object" || data === null || !("runs" in data) || !Array.isArray(data.runs)) throw new Error("replay-data.js has no runs");
  const runs: { key: string; file: string }[] = [];
  for (const run of data.runs) {
    if (typeof run === "object" && run !== null && "key" in run && "file" in run && typeof run.key === "string" && typeof run.file === "string") runs.push({ key: run.key, file: run.file });
  }
  return runs;
}

/** The replay run whose records live in the card's own run folder, or undefined when the player has none. */
function runFor(poster: Poster): string | undefined {
  if (!poster.run) return undefined;
  const prefix = `docs/product/runs/${poster.run.folder}/`;
  return replayRuns().find((run) => run.file.startsWith(prefix))?.key;
}

function origin(): string {
  return `http://127.0.0.1:${server.port}`;
}

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let posts = 0;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(`${found.error} Run bunx playwright-core install chromium.`);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      if (pathname === "/api/tickets/ranking") return Response.json({ ids: [], counts: {} });
      if (pathname === "/api/tickets" && request.method === "POST") { posts++; return Response.json({ code: "tickets-unavailable" }, { status: 503 }); }
      const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
      if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
      const file = Bun.file(path);
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
    },
  });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});

afterAll(async () => {
  await browser?.close();
  server?.stop();
});

async function pageAt(path: string, width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}

async function landing(width = 390, height = 844): Promise<Page> {
  const page = await pageAt("/", width, height);
  await page.waitForSelector("#tkPosters .tk-poster");
  return page;
}

async function shoot(page: Page, name: string, selector: string): Promise<void> {
  if (!CAPTURE) return;
  mkdirSync(CAPTURE, { recursive: true });
  await page.locator(selector).first().screenshot({ path: join(CAPTURE, name) });
}

test("[integration] #237 every card's Watch now plays its own run in the one player, and a card without a run has none", async () => {
  const page = await landing();
  try {
    let wrong = 0;
    let watched = 0;
    for (const poster of POSTERS.posters) {
      const card = page.locator(`#tkPosters .tk-poster[data-id="${poster.id}"]`);
      expect(await card.count()).toBe(1);
      const watch = card.getByRole("link", { name: /^Watch now/ });
      const key = runFor(poster);
      if (key !== undefined) {
        expect(await watch.count()).toBe(1);
        const url = new URL((await watch.getAttribute("href")) ?? "", `${origin()}/`);
        expect(url.origin).toBe(origin());
        expect(url.pathname).toBe("/replay/");
        expect(url.searchParams.get("run")).toBe(key);
        watched++;
      } else {
        expect(await watch.count()).toBe(0);
        if (poster.run) expect(await card.getByRole("link", { name: /^Open the evidence/ }).count()).toBeGreaterThan(0);
        else expect(await card.getByRole("link", { name: /^Read the idea/ }).count()).toBe(1);
      }
    }
    // M8: Watch links whose target is not /replay/?run=<key> playing the card's own folder.
    for (const link of await page.locator("#tkPosters a", { hasText: "Watch now" }).all()) {
      const card = link.locator("xpath=ancestor::article[1]");
      const id = await card.getAttribute("data-id");
      const owner = POSTERS.posters.find((p) => p.id === id);
      const url = new URL((await link.getAttribute("href")) ?? "", `${origin()}/`);
      if (!owner || url.origin !== origin() || url.pathname !== "/replay/" || url.searchParams.get("run") !== runFor(owner)) wrong++;
    }
    console.log(`M8=${wrong}`);
    expect(wrong).toBe(0);
    expect(watched).toBeGreaterThan(0);
    await page.locator("#tkPosters").scrollIntoViewIfNeeded();
    await shoot(page, "shows-390x844.png", ".samples");
  } finally { await page.close(); }
}, 20000);

test("[integration] #237 uc13 Watch now lands on the 100-message run; the 40-case run stays reachable", async () => {
  const page = await landing();
  try {
    await page.locator('#tkPosters .tk-poster[data-id="uc13"]').getByRole("link", { name: /^Watch now/ }).click();
    await page.waitForSelector("[data-run]");
    const url = new URL(page.url());
    expect(url.pathname).toBe("/replay/");
    expect(url.searchParams.get("run")).toBe("uc13-100");
    const pressed = page.locator('[data-run][aria-pressed="true"]');
    expect(await pressed.getAttribute("data-run")).toBe("uc13-100");
    expect(await pressed.innerText()).toContain("100");
  } finally { await page.close(); }
  const old = await pageAt("/replay/?run=uc13", 390, 844);
  try {
    await old.waitForSelector("[data-run]");
    expect(await old.locator('[data-run][aria-pressed="true"]').getAttribute("data-run")).toBe("uc13");
  } finally { await old.close(); }
}, 20000);

test("[integration] #237 one Bring your own decision button opens the office with the idea prefilled, never doubled, never overwritten", async () => {
  const page = await landing();
  try {
    expect(await page.locator("#tkBring").count()).toBe(1);
    expect(await page.locator("#tkBring").evaluate((node) => node.tagName)).toBe("BUTTON");
    expect(await page.locator("#tkPosters #tkBring").count()).toBe(0);
    expect(await page.locator("#tkBring").isVisible()).toBe(true);
    expect(await page.locator("#officePanel").isVisible()).toBe(false);

    await page.locator("#tkBring").click();
    expect(await page.locator("#officePanel").isVisible()).toBe(true);
    expect(await page.locator("#officeOpen").getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator("#tkIdea").inputValue()).toBe(IDEA);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("tkIdea");
    expect(await page.locator("#tkIdea").evaluate((node) => node instanceof HTMLTextAreaElement && node.selectionStart === node.value.length && node.selectionEnd === node.value.length)).toBe(true);
    await shoot(page, "bring-390x844.png", "#officePanel");

    await page.locator("#tkBring").click();
    expect(await page.locator("#officePanel").isVisible()).toBe(true);
    expect(await page.locator("#tkIdea").inputValue()).toBe(IDEA);

    await page.locator("#tkIdea").fill("my text");
    await page.locator("#tkBring").click();
    expect(await page.locator("#tkIdea").inputValue()).toBe("my text");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("tkIdea");
    expect(posts).toBe(0);
  } finally { await page.close(); }
}, 20000);

test("[integration] #237 pressing Bring your own decision after a request was issued shows the form again, prefilled", async () => {
  const page = await landing();
  try {
    await page.locator("#officeOpen").click();
    await page.evaluate(() => {
      const form = document.getElementById("tkForm");
      const box = document.getElementById("tkIssued");
      if (form === null || box === null) throw new Error("no ticket form");
      form.hidden = true;
      box.hidden = false;
    });
    await page.locator("#tkBring").click();
    expect(await page.locator("#tkForm").isVisible()).toBe(true);
    expect(await page.locator("#tkIssued").isVisible()).toBe(false);
    expect(await page.locator("#tkIdea").inputValue()).toBe(IDEA);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("tkIdea");
  } finally { await page.close(); }
}, 20000);

test("[integration] #237 the button is keyboard reachable and the page has no horizontal scroll at 390x844 and 1440x900", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]] as const) {
    const page = await landing(width, height);
    try {
      await page.locator("#tkBring").scrollIntoViewIfNeeded();
      expect(await page.locator("#tkBring").isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await page.locator("#tkBring").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      await page.locator("#tkPosters summary").last().focus();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("tkBring");
      await page.keyboard.press("Enter");
      expect(await page.locator("#tkIdea").inputValue()).toBe(IDEA);
      if (width === 1440) await shoot(page, "shows-1440x900.png", ".samples");
    } finally { await page.close(); }
  }
  expect(posts).toBe(0);
}, 20000);

test("[integration] #237 clicking every card's Watch now opens the replay with that card's own run pressed", async () => {
  let clicked = 0;
  for (const poster of POSTERS.posters) {
    const key = runFor(poster);
    if (key === undefined) continue;
    const page = await landing();
    try {
      await page.locator(`#tkPosters .tk-poster[data-id="${poster.id}"]`).getByRole("link", { name: /^Watch now/ }).click();
      await page.waitForSelector('[data-run][aria-pressed="true"]');
      const url = new URL(page.url());
      expect(url.origin).toBe(origin());
      expect(url.pathname).toBe("/replay/");
      expect(await page.locator('[data-run][aria-pressed="true"]').getAttribute("data-run")).toBe(key);
      clicked++;
    } finally { await page.close(); }
  }
  expect(clicked).toBeGreaterThan(0);
}, 60000);

test("[integration] the Little Shop's replay the run link opens the 40-message run it plays", async () => {
  const page = await pageAt("/little-shop/", 390, 844);
  try {
    await page.getByRole("link", { name: "replay the run" }).click();
    await page.waitForSelector('[data-run][aria-pressed="true"]');
    expect(new URL(page.url()).searchParams.get("run")).toBe("uc13");
    expect(await page.locator('[data-run][aria-pressed="true"]').getAttribute("data-run")).toBe("uc13");
  } finally { await page.close(); }
}, 20000);

test("[integration] the paged step table of the 100-message run heads its input column Case", async () => {
  const page = await pageAt("/replay/?run=uc13-100", 1440, 900);
  try {
    await page.waitForSelector('[data-run][aria-pressed="true"]');
    let presses = 0;
    while (!(await page.locator("#pageList").isVisible()) && presses < 15) {
      await page.locator("#next").click();
      presses++;
    }
    expect(await page.locator("#pageList").isVisible()).toBe(true);
    expect((await page.locator("#pageList th.pi").innerText()).trim()).toBe("Case");
  } finally { await page.close(); }
}, 20000);
