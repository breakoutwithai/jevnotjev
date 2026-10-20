import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const REQUIRED = ["index.html", "README.md", "claims.md", "shot-390x844.png", "shot-1440x900.png"];
const STAGES = ["1", "2", "3", "4", "5", "6"];
const PROMPT_URL = "https://jevnotjev.breakoutwithai.com/tm/map.ts";
const MAX_ASSET_BYTES = 200 * 1024;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

interface Frame { tag: string; stage: string | null; prompt: boolean; buttonIndex: number | null }

function attribute(token: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(token);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#39|#124|#x7c|#8211|#8212|ndash|mdash);/giu, (entity) => {
    const key = entity.toLowerCase();
    if (key === "&amp;") return "&";
    if (key === "&lt;") return "<";
    if (key === "&gt;") return ">";
    if (key === "&quot;") return '"';
    if (key === "&apos;" || key === "&#39;") return "'";
    if (key === "&#8211;" || key === "&ndash;") return "\u2013";
    if (key === "&#8212;" || key === "&mdash;") return "\u2014";
    return "|";
  });
}

function stagesAndText(html: string): { stages: string[]; text: Map<string, string>; outside: string; prompt: string; buttons: string[] } {
  const stages: string[] = [];
  const text = new Map<string, string>();
  let outside = "";
  let prompt = "";
  const buttons: string[] = [];
  const stack: Frame[] = [];
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/gu) ?? []) {
    const rawTag = stack[stack.length - 1]?.tag;
    if ((rawTag === "script" || rawTag === "style") && !token.toLowerCase().startsWith(`</${rawTag}`)) continue;
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      const tag = /^<\/\s*([\w-]+)/u.exec(token)?.[1]?.toLowerCase();
      if (tag) {
        let index = stack.length - 1;
        while (index >= 0 && stack[index]?.tag !== tag) index--;
        if (index >= 0) stack.splice(index);
      }
      continue;
    }
    if (token.startsWith("<")) {
      const tag = /^<\s*([\w-]+)/u.exec(token)?.[1]?.toLowerCase();
      if (!tag) continue;
      const value = attribute(token, "data-stage");
      if (value !== null) stages.push(value);
      if (!VOID.has(tag) && !/\/\s*>$/u.test(token)) {
        const buttonIndex = tag === "button" && (value === "4" || stack.some((frame) => frame.stage === "4")) ? buttons.push("") - 1 : null;
        stack.push({ tag, stage: value, prompt: /\bdata-prompt(?:\s|=|>)/iu.test(token), buttonIndex });
      }
      continue;
    }
    const value = decodeEntities(token);
    if (stack.some((frame) => frame.prompt)) {
      if (stack.some((frame) => frame.stage === "4")) prompt += ` ${value}`;
      continue;
    }
    outside += ` ${value}`;
    const button = [...stack].reverse().find((frame) => frame.buttonIndex !== null);
    if (button?.buttonIndex !== null && button?.buttonIndex !== undefined) buttons[button.buttonIndex] += value;
    for (const frame of stack) {
      if (frame.stage === null) continue;
      if (["1", "2", "3"].includes(frame.stage) && stack.some((nested) => nested !== frame && nested.stage !== null && Number(nested.stage) >= 4)) continue;
      text.set(frame.stage, `${text.get(frame.stage) ?? ""} ${value}`);
    }
  }
  return { stages, text, outside, prompt, buttons };
}

function claimsViolations(markdown: string): string[] {
  const violations: string[] = [];
  let inTable = false;
  let rows = 0;
  const missingStatus: number[] = [];
  const unsafeDesign: number[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const cells = line.trim().split(/(?<!\\)\|/u).slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) { inTable = false; continue; }
    if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) { inTable = true; continue; }
    if (!inTable) continue;
    rows++;
    if (!/\b(?:BUILT|DESIGN)\b/u.test(line)) missingStatus.push(rows);
    // Labels are not numbers about the design: an issue reference (issue 236, #236), "User 2", "stage 6".
    const onScreen = (cells[0] ?? "").replace(/(?:\b(?:issue|user|stage)\s+|#)\d+/giu, "");
    if (/\bDESIGN\b/u.test(line) && (/\d/u.test(onScreen) || /sav(?:es|ing)/iu.test(onScreen))) {
      unsafeDesign.push(rows);
    }
  }
  if (rows === 0) violations.push("claims: no table rows");
  if (missingStatus.length) violations.push(`claims rows ${rowNumbers(missingStatus)}: missing BUILT or DESIGN`);
  if (unsafeDesign.length) violations.push(`claims rows ${rowNumbers(unsafeDesign)}: DESIGN on-screen text has a digit or savings claim`);
  return violations;
}

function rowNumbers(rows: readonly number[]): string {
  const groups: string[] = [];
  for (let start = 0; start < rows.length;) {
    let end = start;
    while (end + 1 < rows.length && rows[end + 1] === (rows[end] ?? -2) + 1) end++;
    groups.push(start === end ? String(rows[start]) : `${rows[start]}-${rows[end]}`);
    start = end + 1;
  }
  return groups.join(",");
}

export function listPrototypes(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^p[1-5]-/u.test(entry.name))
    .map((entry) => join(root, entry.name)).sort();
}

export function checkPrototype(dir: string): string[] {
  const violations: string[] = [];
  for (const name of REQUIRED) if (!existsSync(join(dir, name))) violations.push(`missing ${name}`);
  const indexPath = join(dir, "index.html");
  const claimsPath = join(dir, "claims.md");
  const html = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const { stages, text, outside, prompt, buttons } = stagesAndText(html);
  if (JSON.stringify(stages) !== JSON.stringify(STAGES)) violations.push(`stages: expected 1..6, got ${JSON.stringify(stages)}`);
  if (/\brank(ed|ing)?\b|leaderboard|efficien/iu.test(html)) violations.push("I2: ranking language");

  for (const match of html.matchAll(/https?:\/\/[^\s"'<>`)}]+/giu)) {
    const url = match[0].replace(/[.,;]+$/u, "");
    try {
      if (!["jevnotjev.breakoutwithai.com", "bun.sh"].includes(new URL(url).hostname)) violations.push(`I3: disallowed URL ${url}`);
    } catch { violations.push(`I3: invalid URL ${url}`); }
  }
  if (/<(?:script|link|img|iframe|source)\b[^>]*\b(?:src|href|srcset)\s*=\s*(?:["']\s*)?https?:\/\//iu.test(html)
    || /\bsrcset\s*=\s*["'][^"']*https?:\/\//iu.test(html)
    || /@import\s+(?:url\(\s*)?["']?https?:\/\//iu.test(html)
    || /url\(\s*["']?https?:\/\//iu.test(html)) violations.push("I3: external resource");

  const commandWords = /\bcurl\b|\bbun\s+run\b|\bopen\s+a\s+terminal\b|\bpaste\s+this\s+line\b|--(?:share|days)\b/iu;
  const early = ["1", "2", "3"].map((stage) => text.get(stage) ?? "").join(" ");
  if (commandWords.test(outside) || /\b(?:terminal|bun)\b/iu.test(early)) violations.push("native prompt: command language outside prompt");
  if (!prompt.includes(PROMPT_URL)) violations.push("native prompt: map URL missing from stage 4 data-prompt");
  if (!buttons.some((button) => button.replace(/\s+/gu, " ").trim() === "Copy the prompt")) violations.push("native prompt: Copy the prompt button missing from stage 4");

  for (const match of html.matchAll(/<img\b[^>]*>/giu)) {
    const tag = match[0];
    if (!attribute(tag, "alt")?.trim()) violations.push("I8: img missing alt");
    const src = attribute(tag, "src")?.trim() ?? "";
    if (!/^(?:\.\.\/)?assets\/[^?#\s]+(?:[?#][^\s]*)?$/u.test(src)) violations.push(`I8: img src must use assets path: ${src}`);
  }
  const assets = new Set([...html.matchAll(/(?:\.\.\/)?assets\/[^\s"'()<>]+/gu)].map((match) => decodeEntities(match[0]).split(/[?#]/u, 1)[0] ?? ""));
  for (const asset of assets) {
    const path = resolve(dir, asset);
    const assetRoot = resolve(dir, asset.startsWith("../") ? "../assets" : "assets");
    if (!path.startsWith(`${assetRoot}${sep}`) || !existsSync(path) || !statSync(path).isFile()) violations.push(`I8: missing asset ${asset}`);
    else if (statSync(path).size >= MAX_ASSET_BYTES) violations.push(`I8: oversized asset ${asset}`);
  }

  if (existsSync(claimsPath)) violations.push(...claimsViolations(readFileSync(claimsPath, "utf8")));
  for (const name of ["index.html", "README.md", "claims.md"]) {
    const path = join(dir, name);
    if (existsSync(path) && /[\u2013\u2014]/u.test(decodeEntities(readFileSync(path, "utf8")))) violations.push(`dash: ${name}`);
  }
  return violations;
}
