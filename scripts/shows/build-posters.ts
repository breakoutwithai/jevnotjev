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
import { truthLabel, validate } from "../../src/format/validate.ts";
import { armsInFile, groupCohorts, metricsOfCohortRows } from "../../src/core/metrics.ts";
import { fileSeed } from "../../src/core/calc.ts";
import { verdict } from "../../src/core/verdict.ts";
import { RUN_SOURCES } from "../../src/evidence/replay.ts";
import { headlineOf, latestFirst, parseUseCase, stageOf, verdictWordShown, whyNotYetOf, type MethodLine, type Poster, type RunSummary } from "../../src/shows/posters.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const USE_CASES_REL = "docs/product/use-cases";
export const RUNS_REL = "docs/product/runs";
export const POSTERS_OUT = join(ROOT, "site", "shows", "posters.json");

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Date the file was first committed. A shallow clone cannot know it, so generation stops; a file not yet committed
 * counts as added today (rerun after committing). Any git failure stops generation.
 */
function addedDate(root: string, rel: string): string {
  const shallow = execFileSync("git", ["-C", root, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim();
  if (shallow !== "false") throw new Error("poster dates need full git history: run git fetch --unshallow");
  const out = execFileSync("git", ["-C", root, "log", "--diff-filter=A", "--format=%cs", "--", rel], { encoding: "utf8" }).trim();
  return out.split("\n").filter(Boolean).pop() ?? new Date().toISOString().slice(0, 10);
}

type Rows = ReturnType<typeof validate>["rows"];

function methodLines(rows: Rows): MethodLine[] {
  const arms = new Map<string, { rows: number; labelled: number; accepted: number; spend: number | null }>();
  for (const { values } of rows) {
    const arm = text(values.get("answerer"));
    const line = arms.get(arm) ?? { rows: 0, labelled: 0, accepted: 0, spend: 0 };
    line.rows++;
    const label = truthLabel(values);
    if (label !== null) line.labelled++;
    if (label === "accept") line.accepted++;
    const cost = values.get("cost_usd");
    line.spend = line.spend === null || typeof cost !== "number" ? null : line.spend + cost;
    arms.set(arm, line);
  }
  return ["llm", "rule", "jev"].filter((arm) => arms.has(arm)).map((arm) => {
    const line = arms.get(arm) ?? { rows: 0, labelled: 0, accepted: 0, spend: null };
    return { arm, rows: line.rows, labelled: line.labelled, accepted: line.accepted, spendUsd: line.spend === null ? null : Math.round(line.spend * 1e6) / 1e6 };
  });
}

/**
 * One run folder's poster facts. Counts are per cohort (run, prompt version, question), as src/core/metrics.ts
 * groups them; the poster describes the cohort with the most paired labelled cases. Only labels truthLabel()
 * accepts count (an unreviewed agent label does not). An invalid records.csv stops generation.
 */
export async function summariseRun(root: string, folder: string): Promise<RunSummary | null> {
  const file = join(root, RUNS_REL, folder, "records.csv");
  if (!existsSync(file)) return null;
  const csv = readFileSync(file, "utf8");
  const checked = validate(csv);
  if (checked.errors.length > 0) throw new Error(`${RUNS_REL}/${folder}/records.csv is invalid: ${checked.errors.slice(0, 3).join("; ")}`);
  const groups = groupCohorts(checked.rows);
  const cohortOf = (values: Rows[number]["values"]): string =>
    JSON.stringify([text(values.get("run_id")), text(values.get("prompt_version")), text(values.get("question_id"))]);
  const paired = groups.map(({ key }) => {
    const id = JSON.stringify([key.runId, key.promptVersion, key.questionId]);
    const rows = checked.rows.filter(({ values }) => cohortOf(values) === id);
    const byCase = new Map<string, Set<string>>();
    for (const { values } of rows) {
      if (truthLabel(values) === null) continue;
      const arms = byCase.get(text(values.get("case_id"))) ?? new Set<string>();
      arms.add(text(values.get("answerer")));
      byCase.set(text(values.get("case_id")), arms);
    }
    return { key, rows, n: [...byCase.values()].filter((arms) => arms.has("jev") && arms.has("llm")).length };
  });
  const best = paired.reduce<(typeof paired)[number] | null>((a, b) => (a === null || b.n > a.n ? b : a), null);
  const labelledPaired = best?.n ?? 0;
  const judgedRows = best && labelledPaired > 0 ? best.rows : checked.rows;
  const sources = new Set<string>();
  for (const { values } of judgedRows) {
    if (truthLabel(values) === null) continue;
    const blind = text(values.get("label_blind"));
    sources.add(`${text(values.get("label_source")) || "source not recorded"}${blind ? `, blind: ${blind === "true" ? "yes" : "no"}` : ""}`);
  }
  const result = await evaluateText(`${folder}/records.csv`, csv);
  const question = best ? result.questions.find((q) => q.runId === best.key.runId && q.promptVersion === best.key.promptVersion && q.questionId === best.key.questionId) : undefined;
  const judged = verdictWordShown(labelledPaired) && question?.verdict ? question : null;
  const metrics = best && judged ? metricsOfCohortRows(best.rows.map((row) => row.values), best.key) : null;
  const decision = metrics === null ? null : verdict(metrics, await fileSeed(csv), armsInFile(checked.rows));
  const pair = metrics?.jevVsLlm;
  const summary: RunSummary = {
    folder,
    rows: checked.rows.length,
    cohorts: groups.length,
    question: labelledPaired > 0 && question ? question.question : null,
    labelledPaired,
    verdict: judged?.verdict ?? null,
    reason: judged?.reason ?? null,
    headline: null,
    whyNotYet: whyNotYetOf(decision?.verdict ?? null, decision?.unmet ?? [], pair === null || pair === undefined ? null : { a: pair.a, b: pair.b, c: pair.c, d: pair.d }),
    labels: sources.size === 0 ? null : [...sources].sort().join("; "),
    methods: methodLines(judgedRows),
  };
  return { ...summary, headline: headlineOf(pair ?? null, decision?.numbers.jevVsLlm?.n ?? 0) };
}

/**
 * The first site/<dir>/ whose index.html names the run folder, as a page-relative link. When no page names it, the
 * data-driven replay page (site/replay/, fed by src/evidence/replay.ts RUN_SOURCES) shows the run whose records file
 * lives in that folder: `replay/?run=<key>`.
 */
export function watchPage(root: string, folder: string): string | null {
  const site = join(root, "site");
  for (const dir of readdirSync(site, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const page = join(site, dir, "index.html");
    if (existsSync(page) && readFileSync(page, "utf8").includes(folder)) return `${dir}/`;
  }
  const replay = RUN_SOURCES.find((source) => source.file.startsWith(`${RUNS_REL}/${folder}/`));
  return replay ? `replay/?run=${encodeURIComponent(replay.key)}` : null;
}

export async function buildPosters(root: string = ROOT): Promise<Poster[]> {
  const dir = join(root, USE_CASES_REL);
  const files = readdirSync(dir).filter((f) => /^uc\d+-.+\.md$/.test(f)).sort();
  const posters: Poster[] = [];
  for (const file of files) {
    const source = `${USE_CASES_REL}/${file}`;
    const parsed = parseUseCase(file, readFileSync(join(dir, file), "utf8"));
    if (parsed.fit.length === 0) throw new Error(`${source}: no fit check found (a bold verdict under "## Jev or not")`);
    const run = parsed.runFolder ? await summariseRun(root, parsed.runFolder) : null;
    const date = run ? run.folder.slice(0, 10) : addedDate(root, source);
    posters.push({ id: parsed.id, title: parsed.title, story: parsed.story, fit: parsed.fit, stage: stageOf(run), date, source, run, watch: run ? watchPage(root, run.folder) : null });
  }
  // Every use case is kept: the ten-poster limit applies after ranking with ticket counts (server and page).
  return latestFirst(posters);
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
