// Screenshots for /guide/ (#261): one image per TokenMax guide step, 0 to 6, captured at 1440x900 and written as WebP
// to site/guide/img/. A TypeScript port of the d28 guide walk (walk.mjs): same steps, same element ids, same synthetic
// TOKENMAX WEEK block.
//
//   bun scripts/guide/capture-guide-shots.ts [--base <url>] [--out <dir>] [--chromium <path>]
//
// With no --base it serves this checkout's site/ on 127.0.0.1 and captures that. --base captures another origin, such as
// the live site. Read-only: every request other than GET or HEAD is aborted, and so is any request under /ask/ or
// /feedback/. It never presses Submit and never types a nickname; step 5 photographs the Submit area untouched. The only
// text it pastes is SYNTHETIC_BLOCK. Step 6 is cropped to the /maps/ header so no builder's row is in the picture. Each
// image is re-encoded at falling quality until it is under MAX_IMAGE_BYTES. Prints one line per image and its size.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "../uat/happy-path-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const SITE_DIR = join(ROOT, "site");
export const IMG_DIR = join(SITE_DIR, "guide", "img");
export const VIEWPORT = { width: 1440, height: 900 } as const;
/** Per-image ceiling, in bytes. */
export const MAX_IMAGE_BYTES = 80_000;
/** All guide step images together, in bytes. */
export const TOTAL_IMAGE_BUDGET = 500_000;

/** Synthetic week from the d28 guide walk: invented numbers, no real person's usage. */
export const SYNTHETIC_BLOCK = `TOKENMAX WEEK
Period: 2026-10-15 to 2026-10-21
Claude sessions: 48
Codex sessions: 41
Claude output tokens: 3,910,000
Codex output tokens: 4,460,000
Opus share of Claude output: 70%
Usage limit hits: 12
Sessions per day: 9, 14, 16, 13, 15, 12, 10
Limit hit days: 2026-10-16, 2026-10-17, 2026-10-18, 2026-10-19, 2026-10-20
Codex weekly window used: 88%
Pattern: running out`;

export type GuideShot = { readonly step: number; readonly file: string; readonly alt: string };

/** One image per guide step. Step 0 is the way in from the home page; steps 1 to 6 match the guide's numbered list. */
export const GUIDE_SHOTS: readonly GuideShot[] = [
  { step: 0, file: "step-0-home.webp", alt: "The Jev!Jev home page, with the Program (guide) link at the top right that opens this guide." },
  { step: 1, file: "step-1-sample.webp", alt: "The TokenMax page after Show Sample and Play my week: the sample week has played to its end, with a Replay button under the stage." },
  { step: 2, file: "step-2-copy.webp", alt: "The Map your real week section: the prompt shown in full, the Copy for Claude Code or Codex button and the message saying it was copied." },
  { step: 3, file: "step-3-paste.webp", alt: "A synthetic TOKENMAX WEEK block pasted into Paste the result here, and the Your week card showing those numbers on the page only." },
  { step: 4, file: "step-4-play.webp", alt: "After Play my week: the stage shows the pasted synthetic week, headed Your week, from your numbers, with five days marked limit hit." },
  { step: 5, file: "step-5-submit.webp", alt: "The empty Nickname for the public board box and the Submit button, with the list of what Submit sends. Nothing has been sent." },
  { step: 6, file: "step-6-maps.webp", alt: "The top of the TokenMax map board at /maps/: its title and the note that every number is self-reported and not verified." },
];

/** Read-only guard: only GET and HEAD, and never the question or feedback pages or their APIs. */
export function allowRequest(method: string, url: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const path = new URL(url).pathname;
  return !/^\/(api\/)?(ask|feedback)(\/|$)/.test(path);
}

export type Options = { readonly base: string | null; readonly out: string; readonly chromium: string | null };

export function parseOptions(argv: readonly string[]): Options {
  let base: string | null = null, out = IMG_DIR, chromiumPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i], value = argv[i + 1];
    if (flag !== "--base" && flag !== "--out" && flag !== "--chromium") throw new Error(`Unknown argument: ${flag}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--base") base = new URL(value).origin;
    else if (flag === "--out") out = resolve(value);
    else chromiumPath = value;
    i += 1;
  }
  return { base, out, chromium: chromiumPath };
}

function serveSite(): { readonly origin: string; readonly stop: () => void } {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const path = join(SITE_DIR, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE_DIR}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Wait until the visible text above the command section stops changing (a played week has reached its end). */
async function waitStable(page: Page, maxMs = 90_000, stableMs = 3_000): Promise<boolean> {
  const read = (): Promise<string> => page.evaluate(() => {
    const body = document.body.innerText, cut = body.indexOf("Map your real week");
    return cut > 0 ? body.slice(0, cut) : body.slice(0, 4000);
  });
  const start = Date.now();
  let last = await read(), since = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(250);
    const now = await read();
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= stableMs) return true;
  }
  return false;
}

async function centre(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  await sleep(400);
}

async function openTm(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/tm/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll("#run .poster").length === 7);
  await sleep(800);
}

/** Drive the walk and return one PNG per step, in GUIDE_SHOTS order. */
async function captureSteps(browser: Browser, origin: string): Promise<Buffer[]> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, permissions: ["clipboard-read", "clipboard-write"] });
  await context.route("**/*", (route) => {
    const request = route.request();
    if (allowRequest(request.method(), request.url())) return route.continue();
    console.log(`blocked ${request.method()} ${request.url()}`);
    return route.abort();
  });
  const page = await context.newPage();
  const shots: Buffer[] = [];
  const shoot = async (): Promise<void> => { shots.push(await page.screenshot({ type: "png" })); };

  // Step 0: the home page and its Program (guide) link.
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await sleep(1500);
  if (!(await page.locator("#programLink").isVisible())) throw new Error("step 0: #programLink is not visible on /");
  await page.evaluate(() => scrollTo(0, 0));
  await shoot();

  // Step 1: Show Sample, Play my week, Skip to the end.
  await openTm(page, origin);
  await page.locator("#showSample").click();
  await sleep(1500);
  await page.locator("#playMine").click();
  await sleep(1500);
  if (await page.locator("#skip").isVisible()) await page.locator("#skip").click();
  await sleep(1500);
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(400);
  await shoot();

  // Step 2: Copy for Claude Code or Codex, with the "Map your real week" heading in view.
  await page.locator("#hCmd").evaluate((el) => scrollTo(0, el.getBoundingClientRect().top + scrollY - 24));
  await sleep(400);
  await page.locator("#copy").click();
  await sleep(800);
  await shoot();

  // Step 3: paste the synthetic block on a fresh page, then Show my week.
  await openTm(page, origin);
  await page.evaluate((text) => navigator.clipboard.writeText(text), SYNTHETIC_BLOCK);
  const box = page.locator("#pasteBox");
  await box.scrollIntoViewIfNeeded();
  await box.click();
  await page.keyboard.press("ControlOrMeta+V");
  await sleep(1000);
  if ((await box.inputValue()) !== SYNTHETIC_BLOCK) await box.fill(SYNTHETIC_BLOCK);
  if ((await box.inputValue()) !== SYNTHETIC_BLOCK) throw new Error("step 3: the paste box does not hold the synthetic block");
  await page.locator("#showWeek").click();
  await sleep(2000);
  await box.evaluate((el) => { el.scrollTop = 0; });
  // From the paste label to the Play my week button under the Your week card: taller than one viewport.
  const span = await page.evaluate(() => {
    const top = document.querySelector("label[for='pasteBox']")?.getBoundingClientRect().top;
    const bottom = document.getElementById("playMine")?.getBoundingClientRect().bottom;
    return top === undefined || bottom === undefined ? null : { y: Math.floor(top + scrollY - 24), height: Math.ceil(bottom - top + 48) };
  });
  if (span === null) throw new Error("step 3: the paste label or Play my week is missing");
  shots.push(await page.screenshot({ type: "png", fullPage: true, clip: { x: 0, y: span.y, width: VIEWPORT.width, height: span.height } }));

  // Step 4: Play my week, to its end.
  await page.locator("#playMine").click();
  await waitStable(page);
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(400);
  await shoot();

  // Step 5: the nickname box and Submit, untouched.
  if ((await page.locator("#aliasBox").inputValue()) !== "") throw new Error("step 5: the nickname box is not empty");
  await centre(page, "#submitWeek");
  await shoot();

  // Step 6: /maps/ header only, never a row.
  await page.goto(`${origin}/maps/`, { waitUntil: "networkidle" });
  await sleep(1500);
  await page.evaluate(() => scrollTo(0, 0));
  const clip = await page.evaluate(() => {
    const lede = document.querySelector(".map-lede")?.getBoundingClientRect();
    const board = document.getElementById("mapBoard");
    const rowsTop = board && board.offsetParent !== null ? board.getBoundingClientRect().top : Infinity;
    return lede ? { bottom: Math.ceil(lede.bottom + 6), rowsTop } : null;
  });
  if (clip === null) throw new Error("step 6: .map-lede not found on /maps/");
  if (clip.bottom > clip.rowsTop) throw new Error("step 6: the header crop would include board rows");
  shots.push(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: VIEWPORT.width, height: clip.bottom } }));

  await context.close();
  return shots;
}

/** Re-encode a PNG as WebP in the browser's own encoder, lowering quality until it fits under the ceiling. */
async function toWebp(browser: Browser, png: Buffer): Promise<{ readonly bytes: Buffer; readonly quality: number }> {
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  try {
    for (let quality = 0.8; quality >= 0.3; quality = Math.round((quality - 0.1) * 10) / 10) {
      const dataUrl = await page.evaluate(async ({ b64, q }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${b64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d")?.drawImage(image, 0, 0);
        return canvas.toDataURL("image/webp", q);
      }, { b64: png.toString("base64"), q: quality });
      if (!dataUrl.startsWith("data:image/webp;base64,")) throw new Error("this Chromium cannot encode WebP");
      const bytes = Buffer.from(dataUrl.slice("data:image/webp;base64,".length), "base64");
      if (bytes.length < MAX_IMAGE_BYTES) return { bytes, quality };
    }
    throw new Error(`cannot fit an image under ${MAX_IMAGE_BYTES} bytes`);
  } finally { await context.close(); }
}

/** Keep the guide's width and height on an image equal to the file just written (PNG header: width at 16, height at 20). */
export function setImageSize(html: string, file: string, width: number, height: number): string {
  const pattern = new RegExp(`(<img src="img/${file.replace(/\./g, "\\.")}") width="\\d+" height="\\d+"`);
  if (!pattern.test(html)) throw new Error(`site/guide/index.html has no <img src="img/${file}" width=.. height=..>`);
  return html.replace(pattern, `$1 width="${width}" height="${height}"`);
}

function sizeInGuide(file: string, width: number, height: number): void {
  const path = join(SITE_DIR, "guide", "index.html");
  writeFileSync(path, setImageSize(readFileSync(path, "utf8"), file, width, height));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const found = resolveChromium(options.chromium, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  const local = options.base === null ? serveSite() : null;
  const origin = options.base ?? local?.origin ?? "";
  const browser = await chromium.launch({ headless: true, executablePath: found.path });
  try {
    console.log(`capturing ${origin}`);
    const pngs = await captureSteps(browser, origin);
    mkdirSync(options.out, { recursive: true });
    let total = 0;
    for (const [index, shot] of GUIDE_SHOTS.entries()) {
      const png = pngs[index];
      if (png === undefined) throw new Error(`no capture for step ${shot.step}`);
      const { bytes, quality } = await toWebp(browser, png);
      writeFileSync(join(options.out, shot.file), bytes);
      if (options.out === IMG_DIR) sizeInGuide(shot.file, png.readUInt32BE(16), png.readUInt32BE(20));
      total += bytes.length;
      console.log(`step ${shot.step} ${shot.file} ${bytes.length} bytes (quality ${quality})`);
    }
    console.log(`total ${total} bytes, budget ${TOTAL_IMAGE_BUDGET}`);
    if (total > TOTAL_IMAGE_BUDGET) throw new Error("over the total image budget");
  } finally {
    await browser.close();
    local?.stop();
  }
}

if (import.meta.main) await main();
