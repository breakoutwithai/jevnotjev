// Content gate for site/: leaderboard person names and em or en dash glyphs.
//
//   bun scripts/site-content.ts [dir] [--leaderboard <path>]
//
// Reads the Builder column of the private leaderboard (from --leaderboard <path> or the JNJ_LEADERBOARD environment variable; one of them is required), scans every file under
// dir (default site/), prints counts and exits 0 only when names were checked, files were checked, and there are no
// name hits, no dash hits and no unclassified files. An unset or unreadable leaderboard exits 2. Names are never printed.

import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

/** U+2014 em dash and U+2013 en dash. */
export const DASHES: readonly number[] = [0x2014, 0x2013];
/** Scanned as text. */
export const TEXT_EXT: ReadonlySet<string> = new Set([
  ".html", ".htm", ".js", ".mjs", ".cjs", ".css", ".json", ".webmanifest", ".map", ".txt", ".svg", ".md", ".csv", ".xml",
]);
/** Publishable binaries that carry no text to scan. Anything outside both sets fails the gate. */
export const BINARY_EXT: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2"]);

export interface NameHit { readonly file: string; readonly line: number }
export interface DashHit { readonly file: string; readonly line: number; readonly code: number }
export interface ScanResult {
  readonly filesChecked: number;
  readonly namesChecked: number;
  readonly nameHits: readonly NameHit[];
  readonly dashHits: readonly DashHit[];
  readonly unclassified: readonly string[];
}

/** The private name list outside this repo, from JNJ_LEADERBOARD. There is no default: undefined when unset or empty. */
export function leaderboardPath(): string | undefined {
  const value = process.env.JNJ_LEADERBOARD;
  return value === undefined || value === "" ? undefined : value;
}

/** A Markdown table cell as plain text: links to their text, emphasis and code marks removed, parentheticals dropped. */
function plainCell(cell: string): string {
  return cell
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The Builder column of every Markdown table with that header. */
export function leaderboardNames(markdown: string): string[] {
  const out: string[] = [];
  let col = -1;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) { col = -1; continue; }
    const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim());
    const at = cells.findIndex((c) => plainCell(c) === "Builder");
    if (at >= 0) { col = at; continue; }
    if (col < 0 || cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const name = plainCell(cells[col] ?? "");
    if (name !== "") out.push(name);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NAMED: Readonly<Record<string, string>> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ensp: " ", emsp: " ", thinsp: " " };

function decodeEntity(body: string): string | null {
  if (/^#x[0-9a-f]+$/i.test(body)) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
  if (/^#[0-9]+$/.test(body)) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
  return NAMED[body.toLowerCase()] ?? null;
}

/**
 * Rendered-ish text of a file: tags removed (as nothing, or as a space), character references decoded, whitespace
 * collapsed across lines. `at[i]` is the source offset of output character i, so a hit maps back to a line.
 */
function rendered(src: string, tagAs: "" | " "): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  const push = (s: string, offset: number): void => {
    for (const ch of s) {
      const space = /\s/u.test(ch);
      if (space && text.endsWith(" ")) continue;
      text += space ? " " : ch;
      at.push(offset);
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === "<") {
      const end = src.indexOf(">", i);
      if (end > i) { push(tagAs, i); i = end + 1; continue; }
    }
    if (ch === "&") {
      const end = src.indexOf(";", i);
      if (end > i && end - i <= 10) {
        const decoded = decodeEntity(src.slice(i + 1, end));
        if (decoded !== null) { push(decoded, i); i = end + 1; continue; }
      }
    }
    push(ch, i);
    i++;
  }
  return { text, at };
}

/** A tag removed as nothing joins `Ex<em>am</em>ple`; removed as a space separates `<p>Ann</p><p>Ex</p>`. Both are scanned. */
const TAG_FORMS: readonly ("" | " ")[] = ["", " "];

function lineOf(src: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
}

export async function scanSite(dir: string, names: readonly string[]): Promise<ScanResult> {
  const patterns = names.map((n) => new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(n).replace(/ /g, "\\s+")})(?![\\p{L}\\p{N}])`, "giu"));
  const nameHits: NameHit[] = [];
  const dashHits: DashHit[] = [];
  const unclassified: string[] = [];
  let filesChecked = 0;
  for (const path of await listFiles(dir)) {
    const file = relative(dir, path);
    const ext = extname(path).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    if (!TEXT_EXT.has(ext)) { unclassified.push(file); continue; }
    filesChecked++;
    const src = await readFile(path, "utf8");
    const seen = new Set<string>();
    const hit = (nameIdx: number, line: number): void => {
      const key = `${nameIdx}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      nameHits.push({ file, line });
    };
    src.split("\n").forEach((text, i) => {
      patterns.forEach((re, n) => { re.lastIndex = 0; if (re.test(text)) hit(n, i + 1); });
      for (const code of DASHES) if (text.includes(String.fromCharCode(code))) dashHits.push({ file, line: i + 1, code });
    });
    for (const tagAs of TAG_FORMS) {
      const r = rendered(src, tagAs);
      patterns.forEach((re, n) => {
        re.lastIndex = 0;
        for (const m of r.text.matchAll(re)) {
          const start = (m.index ?? 0) + (m[1]?.length ?? 0);
          hit(n, lineOf(src, r.at[start] ?? 0));
        }
      });
    }
  }
  return { filesChecked, namesChecked: names.length, nameHits, dashHits, unclassified };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--leaderboard");
  const boardPath = flag >= 0 ? args[flag + 1] : leaderboardPath();
  if (boardPath === undefined || boardPath === "") {
    console.error("leaderboard path not set; pass --leaderboard <path> or set JNJ_LEADERBOARD");
    process.exit(2);
  }
  const positional = args.filter((_, i) => flag < 0 || (i !== flag && i !== flag + 1));
  const dir = positional[0] ?? join(import.meta.dir, "..", "site");
  const board = await readFile(boardPath, "utf8").catch(() => null);
  if (board === null) {
    console.error(`leaderboard not readable at ${boardPath}; pass --leaderboard <path> or set JNJ_LEADERBOARD`);
    process.exit(2);
  }
  const names = leaderboardNames(board);
  const r = await scanSite(dir, names);
  console.log(`files ${r.filesChecked}, names checked ${r.namesChecked}, name hits ${r.nameHits.length}, dash hits ${r.dashHits.length}, unclassified ${r.unclassified.length}`);
  for (const h of r.nameHits) console.log(`  name at ${h.file}:${h.line}`);
  for (const h of r.dashHits) console.log(`  U+${h.code.toString(16).toUpperCase()} at ${h.file}:${h.line}`);
  for (const f of r.unclassified) console.log(`  unclassified file ${f}: add its extension to TEXT_EXT or BINARY_EXT`);
  const pass = names.length > 0 && r.filesChecked > 0 && r.nameHits.length === 0 && r.dashHits.length === 0 && r.unclassified.length === 0;
  process.exit(pass ? 0 : 1);
}
