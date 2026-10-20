import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { resolveChromium } from "./happy-path-lib.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const JARGON_PATH = resolve(ROOT, "prototype", "tm-journey", "jargon.txt");
const SIZES = [{ width: 390, height: 844 }, { width: 1440, height: 900 }];

export interface ViewportReport {
  readonly size: string;
  readonly words: number;
  readonly text: string;
  readonly jargon: readonly string[];
  /** With --scroll: the visible text after scrolling down by one viewport height (rubric Q5 input). */
  readonly scrollText?: string;
}

export interface ShotReport {
  readonly dir: string;
  readonly viewports: readonly ViewportReport[];
  readonly stages: readonly string[];
  readonly blocked: readonly string[];
  readonly errors: readonly string[];
  readonly fullText?: string;
}

/** Report matching entries in file order, once each. */
export function findJargon(text: string, words: readonly string[]): string[] {
  return words.filter((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}s?(?![\\p{L}\\p{N}_])`, "iu").test(text);
  });
}

export function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/u).length;
}

/** Browser-side measurement. The same node rules apply to viewport and full-page text. */
export function visibleText(firstViewport: boolean): string {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const pieces: string[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.textContent?.trim();
    if (!value) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    let hidden = false;
    for (let element: Element | null = parent; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility !== "visible" || Number.parseFloat(style.opacity) <= 0) { hidden = true; break; }
      const box = element.getBoundingClientRect();
      const clipped = (style.clip !== "auto" && style.clip !== "") || (style.clipPath !== "none" && style.clipPath !== "");
      if (clipped && box.width <= 1 && box.height <= 1) { hidden = true; break; }
    }
    if (hidden) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    const visible = rects.some((rect) => rect.width >= 2 && rect.height >= 2 && (!firstViewport ||
      (rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight)));
    if (visible) pieces.push(value);
  }
  return pieces.join(" ").replace(/\s+/gu, " ").trim();
}

function usage(): string {
  return "Usage: bun scripts/uat/prototype-shots.ts <prototype-dir> [--no-write] [--json] [--full] [--scroll]";
}

function readJargon(): string[] {
  if (!existsSync(JARGON_PATH)) {
    console.error(`Jargon file missing: ${JARGON_PATH}; treating list as empty.`);
    return [];
  }
  return readFileSync(JARGON_PATH, "utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export async function main(args: readonly string[]): Promise<number> {
  const dirArg = args[0];
  const flags = args.slice(1);
  if (!dirArg || dirArg.startsWith("--") || flags.some((flag) => !["--no-write", "--json", "--full", "--scroll"].includes(flag)) || new Set(flags).size !== flags.length) {
    console.error(usage());
    return 2;
  }
  const dir = resolve(dirArg);
  if (!existsSync(resolve(dir, "index.html"))) {
    console.error(`Missing index.html in ${dir}`);
    return 2;
  }
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) { console.error(found.error); return 2; }

  const jargon = readJargon();
  const blocked: string[] = [];
  const errors: string[] = [];
  const viewports: ViewportReport[] = [];
  let stages: string[] = [];
  let fullText: string | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const path = resolve(dir, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
    if (!path.startsWith(`${dir}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ headless: true, executablePath: found.path });
    try {
      for (const size of SIZES) {
        const context = await browser.newContext({ viewport: size, reducedMotion: "no-preference", serviceWorkers: "block" });
        try {
          const page = await context.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("**/*", (route) => {
            const url = route.request().url();
            if (new URL(url).origin === origin) return route.continue();
            blocked.push(url);
            return route.abort();
          });
          await page.goto(`${origin}/index.html`, { waitUntil: "load" });
          await page.waitForTimeout(500);
          if (!flags.includes("--no-write")) await page.screenshot({ path: resolve(dir, `shot-${size.width}x${size.height}.png`), fullPage: false });
          const text = await page.evaluate(visibleText, true);
          let scrollText: string | undefined;
          if (flags.includes("--scroll")) {
            await page.evaluate(() => window.scrollTo(0, window.innerHeight));
            await page.waitForTimeout(500);
            if (!flags.includes("--no-write")) await page.screenshot({ path: resolve(dir, `shot-${size.width}x${size.height}-scroll1.png`), fullPage: false });
            scrollText = await page.evaluate(visibleText, true);
            await page.evaluate(() => window.scrollTo(0, 0));
          }
          viewports.push({ size: `${size.width}x${size.height}`, words: countWords(text), text, jargon: findJargon(text, jargon), ...(scrollText === undefined ? {} : { scrollText }) });
          if (stages.length === 0) stages = await page.locator("[data-stage]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-stage") ?? ""));
          if (flags.includes("--full") && fullText === undefined) fullText = await page.evaluate(visibleText, false);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally { server.stop(); }

  const report: ShotReport = { dir, viewports, stages, blocked, errors, ...(fullText === undefined ? {} : { fullText }) };
  if (flags.includes("--json")) console.log(JSON.stringify(report));
  else {
    console.log(`Directory: ${dir}`);
    for (const viewport of viewports) {
      console.log(`${viewport.size}: ${viewport.words} words`);
      console.log(viewport.text);
      console.log(`Jargon: ${viewport.jargon.length ? viewport.jargon.join(", ") : "none"}`);
      if (viewport.scrollText !== undefined) console.log(`After one scroll: ${viewport.scrollText}`);
    }
    console.log(`Stages (${stages.length}): ${stages.join(", ")}`);
    if (fullText !== undefined) console.log(`Full-page visible text: ${fullText}`);
    if (blocked.length) console.log(`Blocked: ${blocked.join(", ")}`);
    if (errors.length) console.log(`Errors: ${errors.join("; ")}`);
  }
  return blocked.length || errors.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
