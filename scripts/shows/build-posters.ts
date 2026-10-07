// Builds the ticket office posters (site/shows/posters.json) from the use-case docs and their run folders.
// Nothing is typed by hand: titles, stories and fit checks come from docs/product/use-cases/uc*.md, the stage and
// verdict from the linked run's records.csv (src/browser/results-loader.ts evaluateText, the page's own verdict code).
//
//   bun scripts/shows/build-posters.ts           write site/shows/posters.json
//   bun scripts/shows/build-posters.ts --check   exit 1 if the committed file differs from what the docs and runs give

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { evaluateText } from "../../src/browser/results-loader.ts";
import { validate } from "../../src/format/validate.ts";
import { parseUseCase, rankPosters, stageOf, verdictWordShown, type Poster, type RunSummary } from "../../src/shows/posters.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const USE_CASES_REL = "docs/product/use-cases";
export const RUNS_REL = "docs/product/runs";
export const POSTERS_OUT = join(ROOT, "site", "shows", "posters.json");

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Date the file was first committed; a file not yet committed counts as added today. */
function addedDate(root: string, rel: string): string {
  try {
    const out = execFileSync("git", ["-C", root, "log", "--diff-filter=A", "--format=%cs", "--", rel], { encoding: "utf8" }).trim();
    const first = out.split("\n").filter(Boolean).pop();
    if (first) return first;
  } catch { /* not a git checkout: fall through */ }
  return new Date().toISOString().slice(0, 10);
}

export async function summariseRun(root: string, folder: string): Promise<RunSummary | null> {
  const file = join(root, RUNS_REL, folder, "records.csv");
  if (!existsSync(file)) return null;
  const csv = readFileSync(file, "utf8");
  const { rows } = validate(csv);
  const labelled = new Map<string, Set<string>>();
  const sources = new Set<string>();
  for (const { values } of rows) {
    if (values.get("label") === null || values.get("label") === undefined) continue;
    const key = `${text(values.get("question_id"))}\u0000${text(values.get("case_id"))}`;
    const arms = labelled.get(key) ?? new Set<string>();
    arms.add(text(values.get("answerer")));
    labelled.set(key, arms);
    const blind = text(values.get("label_blind"));
    sources.add(`${text(values.get("label_source"))}${blind ? `, blind: ${blind === "true" ? "yes" : "no"}` : ""}`);
  }
  const arms = new Map<string, { rows: number; labelled: number; accepted: number; spend: number | null }>();
  for (const { values } of rows) {
    const arm = text(values.get("answerer"));
    const line = arms.get(arm) ?? { rows: 0, labelled: 0, accepted: 0, spend: 0 };
    line.rows++;
    const label = values.get("label");
    if (label !== null && label !== undefined) line.labelled++;
    if (label === "accept") line.accepted++;
    const cost = values.get("cost_usd");
    line.spend = line.spend === null || typeof cost !== "number" ? null : line.spend + cost;
    arms.set(arm, line);
  }
  const methods = ["llm", "rule", "jev"].filter((arm) => arms.has(arm)).map((arm) => {
    const line = arms.get(arm) ?? { rows: 0, labelled: 0, accepted: 0, spend: null };
    return { arm, rows: line.rows, labelled: line.labelled, accepted: line.accepted, spendUsd: line.spend === null ? null : Math.round(line.spend * 1e6) / 1e6 };
  });
  const labelledPaired = [...labelled.values()].filter((arms) => arms.has("jev") && arms.has("llm")).length;
  const result = await evaluateText(`${folder}/records.csv`, csv);
  const first = result.questions[0];
  const judged = verdictWordShown(labelledPaired) && first?.verdict ? first : null;
  return {
    folder,
    rows: rows.length,
    labelledPaired,
    verdict: judged?.verdict ?? null,
    reason: judged?.reason ?? null,
    labels: sources.size === 0 ? null : [...sources].sort().join("; "),
    methods,
  };
}

/** The first site/<dir>/ whose index.html names the run folder, as a page-relative link. */
export function watchPage(root: string, folder: string): string | null {
  const site = join(root, "site");
  for (const dir of readdirSync(site, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const page = join(site, dir, "index.html");
    if (existsSync(page) && readFileSync(page, "utf8").includes(folder)) return `${dir}/`;
  }
  return null;
}

export async function buildPosters(root: string = ROOT): Promise<Poster[]> {
  const dir = join(root, USE_CASES_REL);
  const files = readdirSync(dir).filter((f) => /^uc\d+-.+\.md$/.test(f)).sort();
  const posters: Poster[] = [];
  for (const file of files) {
    const source = `${USE_CASES_REL}/${file}`;
    const parsed = parseUseCase(file, readFileSync(join(dir, file), "utf8"));
    const run = parsed.runFolder ? await summariseRun(root, parsed.runFolder) : null;
    const date = run ? run.folder.slice(0, 10) : addedDate(root, source);
    posters.push({ id: parsed.id, title: parsed.title, story: parsed.story, fit: parsed.fit, stage: stageOf(run), date, source, run, watch: run ? watchPage(root, run.folder) : null });
  }
  return rankPosters(posters, {});
}

export function render(posters: readonly Poster[]): string {
  return `${JSON.stringify({ schema: "jnj-posters/1", generated_by: "scripts/shows/build-posters.ts", posters }, null, 2)}\n`;
}

export const USAGE = "usage: bun scripts/shows/build-posters.ts [--check]";

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error(USAGE);
    process.exit(2);
  }
  const out = render(await buildPosters());
  const count = JSON.parse(out).posters.length;
  if (args[0] === "--check") {
    const committed = existsSync(POSTERS_OUT) ? readFileSync(POSTERS_OUT, "utf8") : "";
    if (committed !== out) {
      console.error(`posters out of date: rerun bun scripts/shows/build-posters.ts (${count} posters)`);
      process.exit(1);
    }
    console.log(`posters up to date: ${count}`);
  } else {
    mkdirSync(dirname(POSTERS_OUT), { recursive: true });
    writeFileSync(POSTERS_OUT, out);
    console.log(`wrote site/shows/posters.json: ${count} posters`);
  }
}
