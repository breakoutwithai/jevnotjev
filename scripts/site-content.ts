// Content gate for site/: leaderboard person names (read at run time from the private leaderboard) and em or en
// dash glyphs. `bun scripts/site-content.ts [dir]` prints counts and exits 1 on any hit; the names are never printed.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative } from "node:path";

/** U+2014 em dash and U+2013 en dash. */
export const DASHES: readonly number[] = [0x2014, 0x2013];
const TEXT_EXT: ReadonlySet<string> = new Set([".html", ".js", ".css", ".json", ".txt", ".svg", ".md", ".csv", ".xml"]);

export interface NameHit { readonly file: string; readonly line: number }
export interface DashHit { readonly file: string; readonly line: number; readonly code: number }
export interface ScanResult {
  readonly filesChecked: number;
  readonly namesChecked: number;
  readonly nameHits: readonly NameHit[];
  readonly dashHits: readonly DashHit[];
}

/** The private leaderboard outside this repo; JNJ_LEADERBOARD overrides. */
export function leaderboardPath(): string {
  return process.env.JNJ_LEADERBOARD ?? join(homedir(), "projects", "30-day-challenge", "_reference", "community", "leaderboard-d07.md");
}

/** The Builder column of every markdown table with that header, parentheticals dropped. */
export function leaderboardNames(markdown: string): string[] {
  const out: string[] = [];
  let col = -1;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) { col = -1; continue; }
    const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim());
    const at = cells.indexOf("Builder");
    if (at >= 0) { col = at; continue; }
    if (col < 0 || cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const name = (cells[col] ?? "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
    if (name !== "") out.push(name);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function textFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && TEXT_EXT.has(extname(e.name).toLowerCase()))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

export async function scanSite(dir: string, names: readonly string[]): Promise<ScanResult> {
  const patterns = names.map((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu"));
  const files = await textFiles(dir);
  const nameHits: NameHit[] = [];
  const dashHits: DashHit[] = [];
  for (const path of files) {
    const file = relative(dir, path);
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((text, i) => {
      if (patterns.some((re) => re.test(text))) nameHits.push({ file, line: i + 1 });
      for (const code of DASHES) if (text.includes(String.fromCharCode(code))) dashHits.push({ file, line: i + 1, code });
    });
  }
  return { filesChecked: files.length, namesChecked: names.length, nameHits, dashHits };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, "..", "site");
  const names = leaderboardNames(await readFile(leaderboardPath(), "utf8"));
  const r = await scanSite(dir, names);
  console.log(`files ${r.filesChecked}, names checked ${r.namesChecked}, name hits ${r.nameHits.length}, dash hits ${r.dashHits.length}`);
  for (const h of r.nameHits) console.log(`  name at ${h.file}:${h.line}`);
  for (const h of r.dashHits) console.log(`  U+${h.code.toString(16).toUpperCase()} at ${h.file}:${h.line}`);
  if (names.length === 0 || r.filesChecked === 0 || r.nameHits.length > 0 || r.dashHits.length > 0) process.exit(1);
}
