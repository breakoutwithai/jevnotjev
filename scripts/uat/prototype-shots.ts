import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  readonly stagesDetail: readonly StageDetail[];
  readonly pageWords: number;
  readonly budgets: readonly Budget[];
  readonly visualCaptions?: readonly { readonly stage: string; readonly text: string }[];
  readonly blocked: readonly string[];
  readonly errors: readonly string[];
  readonly fullText?: string;
}

export interface StageDetail {
  readonly stage: string;
  readonly words: number;
  readonly visuals: number;
  readonly visualLabelled: boolean;
}

export interface Budget {
  readonly name: string;
  readonly limit: number | boolean;
  readonly actual: number | boolean;
  readonly pass: boolean;
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
export function visibleText(options: boolean | { firstViewport: boolean; stageIndex?: number; visualStageIndex?: number; excludePrompt?: boolean }): string {
  const firstViewport = typeof options === "boolean" ? options : options.firstViewport;
  const root = typeof options === "boolean" ? document.body : options.visualStageIndex === undefined
    ? options.stageIndex === undefined ? document.body : document.querySelectorAll("[data-stage]")[options.stageIndex]
    : document.querySelectorAll("[data-stage]")[options.visualStageIndex]?.querySelector("[data-visual]");
  if (!root) return "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pieces: string[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.textContent?.trim();
    if (!value) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    if (typeof options !== "boolean" && options.excludePrompt && parent.closest("[data-prompt]")) continue;
    const closedDetails = parent.closest("details:not([open])");
    if (closedDetails && !parent.closest("summary")) continue;
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
  return "Usage: bun scripts/uat/prototype-shots.ts <prototype-dir> [--no-write] [--json] [--full] [--scroll] [--strict] [--visuals DIR]";
}

function budget(name: string, limit: number | boolean, actual: number | boolean, pass: boolean): Budget {
  return { name, limit, actual, pass };
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
  const visualsAt = flags.indexOf("--visuals");
  const visualsDirArg = visualsAt < 0 ? undefined : flags[visualsAt + 1];
  const simpleFlags = flags.filter((flag, index) => index !== visualsAt && index !== visualsAt + 1);
  if (!dirArg || dirArg.startsWith("--") || (visualsAt >= 0 && (!visualsDirArg || visualsDirArg.startsWith("--")))
    || simpleFlags.some((flag) => !["--no-write", "--json", "--full", "--scroll", "--strict"].includes(flag))
    || new Set(flags.filter((flag) => flag.startsWith("--"))).size !== flags.filter((flag) => flag.startsWith("--")).length) {
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
  let stagesDetail: StageDetail[] = [];
  let pageWords = 0;
  const visualCaptions: { stage: string; text: string }[] = [];
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
          if (size.width === 390) {
            const visuals = await page.locator("[data-stage]").evaluateAll((elements) => elements.map((element) => {
              const found = [...element.querySelectorAll("[data-visual]")];
              return { visuals: found.length, visualLabelled: found.every((visual) => Boolean(visual.getAttribute("aria-label")?.trim()
                || [...visual.querySelectorAll("img")].some((img) => Boolean(img.getAttribute("alt")?.trim()))
                || [...visual.querySelectorAll("svg")].some((svg) => svg.getAttribute("role") === "img" && Boolean(svg.getAttribute("aria-label")?.trim() || svg.querySelector("title")?.textContent?.trim())))) };
            }));
            stagesDetail = await Promise.all(stages.map(async (stage, index) => ({ stage,
              words: countWords(await page.evaluate(visibleText, { firstViewport: false, stageIndex: index, excludePrompt: true })),
              visuals: visuals[index]?.visuals ?? 0, visualLabelled: visuals[index]?.visualLabelled ?? true,
            })));
            pageWords = countWords(await page.evaluate(visibleText, { firstViewport: false, excludePrompt: true }));
            if (visualsDirArg) {
              const visualsDir = resolve(visualsDirArg);
              mkdirSync(visualsDir, { recursive: true });
              for (const [index, stage] of stages.entries()) {
                const visual = page.locator("[data-stage]").nth(index).locator("[data-visual]").first();
                if (await visual.count() === 0) continue;
                await visual.scrollIntoViewIfNeeded();
                await page.waitForTimeout(500);
                await visual.screenshot({ path: resolve(visualsDir, `stage-${stage}-390.png`) });
                visualCaptions.push({ stage, text: await page.evaluate(visibleText, { firstViewport: false, visualStageIndex: index }) });
              }
            }
          }
          if (flags.includes("--full") && fullText === undefined) fullText = await page.evaluate(visibleText, false);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally { server.stop(); }

  const budgets: Budget[] = [
    ...viewports.map((viewport) => budget(`first viewport ${viewport.size} words`, 25, viewport.words, viewport.words <= 25)),
    ...stagesDetail.flatMap((stage) => [
      budget(`stage ${stage.stage} words`, 18, stage.words, stage.words <= 18),
      budget(`stage ${stage.stage} visuals`, 1, stage.visuals, stage.visuals === 1),
      budget(`stage ${stage.stage} visualLabelled`, true, stage.visualLabelled, stage.visualLabelled),
    ]),
    budget("page words", 250, pageWords, pageWords <= 250),
  ];
  const report: ShotReport = { dir, viewports, stages, stagesDetail, pageWords, budgets, blocked, errors,
    ...(visualsDirArg ? { visualCaptions } : {}), ...(fullText === undefined ? {} : { fullText }) };
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
    console.log("Budget | Limit | Actual | Pass");
    for (const entry of budgets) console.log(`${entry.name} | ${entry.limit} | ${entry.actual} | ${entry.pass ? "yes" : "no"}`);
    for (const caption of visualCaptions) console.log(`Stage ${caption.stage} visual text: ${caption.text}`);
    if (fullText !== undefined) console.log(`Full-page visible text: ${fullText}`);
    if (blocked.length) console.log(`Blocked: ${blocked.join(", ")}`);
    if (errors.length) console.log(`Errors: ${errors.join("; ")}`);
  }
  return blocked.length || errors.length || (flags.includes("--strict") && budgets.some((entry) => !entry.pass)) ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
