// #261 "guide is text only": every TokenMax guide step on site/guide/index.html carries a screenshot captured by
// scripts/guide/capture-guide-shots.ts. The image file exists, its alt is non-empty and descriptive, width and height
// match the file, it loads lazily, each file is under MAX_IMAGE_BYTES and all of them under TOTAL_IMAGE_BUDGET. At
// 390 px the guide has no horizontal overflow and every image fits the column. The capture script stays read-only.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { resolveChromium } from "../uat/happy-path-lib.ts";
import { parseWeek } from "../../src/browser/tm-week.ts";
import { allowRequest, GUIDE_SHOTS, IMG_DIR, MAX_IMAGE_BYTES, parseOptions, SAMPLE_NICKNAME, setImageSize, SITE_DIR, SYNTHETIC_BLOCK, TOTAL_IMAGE_BUDGET } from "./capture-guide-shots.ts";

const GUIDE = join(SITE_DIR, "guide", "index.html");
const SCRIPT = join(import.meta.dir, "capture-guide-shots.ts");

type Img = { readonly src: string; readonly alt: string | null; readonly width: string | null; readonly height: string | null; readonly loading: string | null; readonly where: string };

/** Every img in the TokenMax section: "intro" before the step list, or "step-<n>" for the n-th list item (1-based). */
async function guideImages(html: string): Promise<Img[]> {
  const found: Img[] = [];
  let inSection = false, inList = false, item = 0;
  await new HTMLRewriter()
    .on("section", { element(el) { inSection = el.getAttribute("id") === "tokenmax"; } })
    .on("section#tokenmax ol.tokenmax-steps", { element(el) { inList = true; el.onEndTag(() => { inList = false; }); } })
    .on("section#tokenmax ol.tokenmax-steps > li", { element() { item += 1; } })
    .on("img", {
      element(el) {
        if (!inSection) return;
        found.push({ src: el.getAttribute("src") ?? "", alt: el.getAttribute("alt"), width: el.getAttribute("width"), height: el.getAttribute("height"), loading: el.getAttribute("loading"), where: inList ? `step-${item}` : "intro" });
      },
    })
    .transform(new Response(html))
    .text();
  return found;
}

/** Pixel size from a WebP file header (VP8, VP8L or VP8X). */
function webpSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") throw new Error("not a WebP file");
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") { const b = bytes.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
  if (chunk === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  throw new Error(`unknown WebP chunk ${chunk}`);
}

test("[unit] #261 the guide shows one image for step 0 and one inside each of the six TokenMax steps, in order", async () => {
  const images = await guideImages(readFileSync(GUIDE, "utf8"));
  expect(images.map((image) => `${image.where} ${image.src}`)).toEqual(GUIDE_SHOTS.map((shot) => `${shot.step === 0 ? "intro" : `step-${shot.step}`} img/${shot.file}`));
});

test("[unit] #261 every step image exists, has descriptive alt text, lazy loading and width/height equal to the file", async () => {
  const images = await guideImages(readFileSync(GUIDE, "utf8"));
  for (const shot of GUIDE_SHOTS) {
    const image = images.find((candidate) => candidate.src === `img/${shot.file}`);
    expect(image).toBeDefined();
    if (image === undefined) continue;
    const path = join(IMG_DIR, shot.file);
    expect({ file: shot.file, exists: existsSync(path) }).toEqual({ file: shot.file, exists: true });
    expect((image.alt ?? "").trim().length).toBeGreaterThan(30);
    expect(image.alt).toBe(shot.alt);
    expect(image.loading).toBe("lazy");
    expect(webpSize(readFileSync(path))).toEqual({ width: Number(image.width), height: Number(image.height) });
    expect(Number(image.width)).toBe(1440);
  }
});

test("[unit] #261 each step image is under 80 KB and all of them are under the 500 KB budget", () => {
  expect(MAX_IMAGE_BYTES).toBe(80_000);
  expect(TOTAL_IMAGE_BUDGET).toBe(500_000);
  const sizes = GUIDE_SHOTS.map((shot) => statSync(join(IMG_DIR, shot.file)).size);
  for (const size of sizes) expect(size).toBeLessThan(MAX_IMAGE_BYTES);
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(TOTAL_IMAGE_BUDGET);
});

test("[unit] #261 the capture script is read-only: only GET and HEAD, never /ask/ or /feedback/", () => {
  expect(allowRequest("GET", "http://127.0.0.1:1/tm/")).toBe(true);
  expect(allowRequest("HEAD", "https://example.test/maps/")).toBe(true);
  expect(allowRequest("GET", "https://example.test/api/maps")).toBe(true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(allowRequest(method, "https://example.test/api/maps")).toBe(false);
  for (const path of ["/ask/", "/ask", "/feedback/", "/api/ask", "/api/feedback/x"]) expect(allowRequest("GET", `https://example.test${path}`)).toBe(false);
  const source = readFileSync(SCRIPT, "utf8");
  expect(source).not.toMatch(/#submitWeek"\)\.(click|press|dispatchEvent)|\.press\("Enter"\)/);
  expect(SAMPLE_NICKNAME).toBe("Sample Visitor");
});

test("[unit] #261 the only typed text is the synthetic TOKENMAX WEEK block, which parses as a week, and the sample nickname", () => {
  const week = parseWeek(SYNTHETIC_BLOCK);
  expect(week).not.toBeNull();
  expect(SYNTHETIC_BLOCK.split("\n")[0]).toBe("TOKENMAX WEEK");
  const source = readFileSync(SCRIPT, "utf8");
  expect([...source.matchAll(/\.fill\(([^)]*)\)/g)].map((match) => match[1])).toEqual(["SYNTHETIC_BLOCK", "SAMPLE_NICKNAME"]);
});

test("[unit] #261 the capture script takes --base, --out and --chromium and rejects anything else", () => {
  expect(parseOptions([])).toEqual({ base: null, out: IMG_DIR, chromium: null });
  expect(parseOptions(["--base", "https://example.test/guide/"]).base).toBe("https://example.test");
  expect(() => parseOptions(["--submit"])).toThrow("Unknown argument");
  expect(() => parseOptions(["--base"])).toThrow("needs a value");
});

test("[unit] #261 a recapture rewrites only the matching image's width and height in the guide", () => {
  const html = '<img src="img/step-3-paste.webp" width="1440" height="900" alt="a"><img src="img/step-3-pasteXwebp" width="1" height="1" alt="b">';
  expect(setImageSize(html, "step-3-paste.webp", 1440, 1121)).toBe('<img src="img/step-3-paste.webp" width="1440" height="1121" alt="a"><img src="img/step-3-pasteXwebp" width="1" height="1" alt="b">');
  expect(() => setImageSize(html, "step-9.webp", 1, 1)).toThrow("has no");
});

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const path = join(SITE_DIR, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE_DIR}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

test("[integration] #261 at 390 px the guide has no horizontal overflow and every step image fits the column", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.port}/guide/`, { waitUntil: "load" });
    const images = page.locator("#tokenmax img");
    expect(await images.count()).toBe(GUIDE_SHOTS.length);
    for (let i = 0; i < GUIDE_SHOTS.length; i += 1) {
      await images.nth(i).scrollIntoViewIfNeeded();
      await images.nth(i).evaluate((el) => el instanceof HTMLImageElement ? el.decode() : null);
    }
    const layout = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
      images: [...document.querySelectorAll("#tokenmax img")].map((el) => { const box = el.getBoundingClientRect(); return { left: box.left, right: box.right, height: box.height }; }),
    }));
    expect(layout.scroll).toBeLessThanOrEqual(layout.view);
    for (const box of layout.images) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(layout.view);
      expect(box.height).toBeGreaterThan(0);
    }
  } finally { await context.close(); }
}, 30000);
