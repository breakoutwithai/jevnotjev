import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { fileSeed } from "../core/calc.ts";
import { armsInFile, groupCohorts, metricsOfCohortRows } from "../core/metrics.ts";
import { MARGIN, MIN_PAIRED, verdict } from "../core/verdict.ts";
import { truthLabel, validate } from "../format/validate.ts";
import { resolveChromium } from "../../scripts/uat/happy-path-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SITE = resolve(process.env.LANDING_TEST_SITE ?? join(ROOT, "site"));
const IDS = ["uc9", "uc10", "uc11", "uc12", "uc13"];
const NOT_FIT = ["uc9", "uc10", "uc11"];
const RECORDS = "docs/product/runs/2026-10-11-uc13-shop-bot-100/records.csv";
// A number starts at a word boundary: digits glued to letters ("P2", "m40") are identifiers, not figures.
const NUMBERS = /\b\d+(?:\.\d+)?/g;
// Fraction words are figures too ("about a fifth"), so they must be declared like digits.
const FRACTION_WORDS = /\ba (?:half|third|quarter|fifth|sixth|seventh|eighth|ninth|tenth)\b/g;
const BARE = /^(?:Verdict:\s*)?(?:use Jev|don't use Jev|not enough evidence|not proven yet|not enough proof yet|Jev probably not|Jev could help|not Jev|!Jev|split two ways|needs a test)(?:\s*\([^)]*\))?\.?$/i;

/*
 * Every figure on the page is a structured value: the text it shows (display), where it shows (part, in order), what it
 * measures (metric, and arm when the metric is per arm), how it is written (format, one named rounding rule each) and the
 * value. The test computes the value itself from the cited source and fails unless value and display both follow from
 * it. There are no prose quotes: a figure with no computable source cannot appear.
 */
type FigureArm = "jev" | "llm" | "rule";
const ARMS: readonly FigureArm[] = ["jev", "llm", "rule"];
const PARTS = ["verdict", "why", "cases", "next", "rephrase", "earlier"] as const;
type Part = (typeof PARTS)[number];
// Per arm, from a run's records.csv (labelled rows of one cohort).
const ARM_METRICS = ["accepted", "labelled", "spend", "model"] as const;
// Per run, from records.csv through src/core/metrics.ts and src/core/verdict.ts.
const RUN_METRICS = ["paired", "acceptedEach", "toMinimum", "rule", "lowerBound", "costRatio", "spendRatio"] as const;
// Constants of src/core/verdict.ts.
const CONSTANT_METRICS = ["minPaired", "margin"] as const;
// Fields of a use-case doc: "- Cases: N or more" and the answer column of its decision table.
const DOC_METRICS = ["docCases", "docAnswers"] as const;
type Metric = (typeof ARM_METRICS)[number] | (typeof RUN_METRICS)[number] | (typeof CONSTANT_METRICS)[number] | (typeof DOC_METRICS)[number];
const METRICS: readonly string[] = [...ARM_METRICS, ...RUN_METRICS, ...CONSTANT_METRICS, ...DOC_METRICS];
type Format = "int" | "usd4" | "usd5" | "rule" | "aboutPoints" | "pointLimit" | "aboutFraction" | "ordinalFraction" | "each" | "tie" | "messageRun" | "modelShort" | "answers";
// The only formats a metric may use: a cost ratio cannot be written as points, a count cannot be written as money.
const FORMATS: Readonly<Record<Metric, readonly Format[]>> = {
  accepted: ["int"], labelled: ["int"], spend: ["usd4", "usd5"], model: ["modelShort"],
  paired: ["int", "messageRun"], acceptedEach: ["each", "tie"], toMinimum: ["int"], rule: ["rule"],
  lowerBound: ["aboutPoints"], costRatio: ["aboutFraction"], spendRatio: ["ordinalFraction"],
  minPaired: ["int"], margin: ["pointLimit"], docCases: ["int"], docAnswers: ["answers"],
};
interface Figure {
  part: Part;
  display: string;
  metric: Metric;
  format: Format;
  value: number | string;
  source: string;
  arm?: FigureArm;
  question?: string;
}
interface Explained {
  why: string | null;
  cases: string | null;
  next: string | null;
  rephrase: string | null;
  earlier: string | null;
  figures: Figure[] | null;
}
interface Sample {
  id: string;
  fit: string[];
  runBacked: boolean;
  verdictLine: string | null;
  explained: Explained | null;
}
interface Loaded { samples: Sample[]; problems: string[] }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringOrNull(value: unknown): string | null { return typeof value === "string" ? value : null; }
function isPart(value: unknown): value is Part { return PARTS.some((part) => part === value); }
function isMetric(value: unknown): value is Metric { return typeof value === "string" && METRICS.includes(value); }
function isArm(value: unknown): value is FigureArm { return ARMS.some((arm) => arm === value); }
function isFormat(value: unknown): value is Format {
  return Object.values(FORMATS).some((formats) => formats.some((format) => format === value));
}
function figure(value: unknown): value is Figure {
  return record(value) && isPart(value.part) && typeof value.display === "string" && isMetric(value.metric) && isFormat(value.format) &&
    (typeof value.value === "number" || typeof value.value === "string") && typeof value.source === "string" &&
    (value.arm === undefined || isArm(value.arm)) && (value.question === undefined || typeof value.question === "string");
}
function explained(value: unknown): Explained | null {
  if (!record(value)) return null;
  return {
    why: stringOrNull(value.why), cases: stringOrNull(value.cases), next: stringOrNull(value.next),
    rephrase: stringOrNull(value.rephrase), earlier: stringOrNull(value.earlier),
    figures: Array.isArray(value.figures) && value.figures.every(figure) ? value.figures : null,
  };
}
function loadSamples(): Loaded {
  const problems: string[] = [];
  let posters: unknown;
  let stage: unknown;
  try { posters = JSON.parse(readFileSync(join(SITE, "shows", "posters.json"), "utf8")); }
  catch (error) { problems.push(`posters.json: cannot read or parse: ${String(error)}`); }
  try {
    const script = readFileSync(join(SITE, "data.js"), "utf8");
    const json = script.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "").replace(/^window\.JNJ\s*=\s*/, "").replace(/;\s*$/, "");
    stage = JSON.parse(json);
  } catch (error) { problems.push(`data.js: cannot read or parse Stage: ${String(error)}`); }
  const samples: Sample[] = [];
  if (record(posters) && Array.isArray(posters.posters)) {
    for (const raw of posters.posters) {
      if (!record(raw) || typeof raw.id !== "string") { problems.push("posters.json: poster has no id"); continue; }
      samples.push({
        id: raw.id,
        fit: Array.isArray(raw.fit) ? raw.fit.filter((part): part is string => typeof part === "string") : [],
        runBacked: raw.run !== null && raw.run !== undefined,
        verdictLine: stringOrNull(raw.verdictLine),
        explained: explained(raw.explained),
      });
    }
  } else problems.push("posters.json: posters list missing");
  if (record(stage)) {
    const copy = record(stage.explained) ? stage.explained : null;
    samples.push({ id: "Stage", fit: [], runBacked: true, verdictLine: stringOrNull(copy?.verdict), explained: explained(copy) });
  } else problems.push("Stage: sample missing");
  return { samples, problems };
}
function copyParts(sample: Sample): string[] {
  const e = sample.explained;
  return [sample.verdictLine, e?.why, e?.cases, e?.next, e?.rephrase, e?.earlier]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
}
function checkParts(samples: Sample[]): string[] {
  const problems: string[] = [];
  for (const id of [...IDS, "Stage"]) if (!samples.some((sample) => sample.id === id)) problems.push(`${id}: sample missing`);
  if (samples.length !== IDS.length + 1) problems.push(`samples: expected ${IDS.length + 1}, found ${samples.length}`);
  for (const sample of samples) {
    if (!sample.explained) problems.push(`${sample.id}: no explained copy`);
    if (!sample.verdictLine?.trim()) problems.push(`${sample.id}: verdict line missing`);
    for (const part of ["why", "cases", "next"] satisfies (keyof Explained)[]) if (!sample.explained?.[part]?.trim()) problems.push(`${sample.id}: ${part} missing`);
  }
  return problems;
}
function checkRephrases(samples: Sample[]): string[] {
  const problems: string[] = [];
  const selected = samples.filter((sample) => sample.fit.includes("Jev probably not"));
  const selectedIds = selected.map((sample) => sample.id).sort();
  if (selectedIds.join(",") !== [...NOT_FIT].sort().join(",")) problems.push(`Jev probably not posters: expected ${NOT_FIT.join(", ")}, found ${selectedIds.join(", ") || "none"}`);
  for (const sample of selected) {
    const rephrase = sample.explained?.rephrase?.trim();
    if (!rephrase) { problems.push(`${sample.id}: no rephrase`); continue; }
    // The quoted question must be new: the original question, quoted in the why, does not count as a rephrase.
    const why = sample.explained?.why ?? "";
    const question = [...rephrase.matchAll(/["“]([^"”]*\?[^"”]*)["”]/g)].some((match) => !why.includes(match[1] ?? ""));
    const none = /no (Jev )?rephras|none exists/i.test(rephrase) && /\b(?:because|since|as)\b/i.test(rephrase);
    if (!question && !none) problems.push(`${sample.id}: rephrase has no quoted question or stated reason none exists`);
  }
  return problems;
}
// ---------- figures: computed from the source, rendered by one named rule each ----------

interface RunFacts {
  accepted: Record<FigureArm, number>;
  labelled: Record<FigureArm, number>;
  spend: Record<FigureArm, number | null>;
  model: Record<FigureArm, string | null>;
  paired: number;
  rule: number;
  lowerBound: number | null;
  costRatio: number | null;
}
const runCache = new Map<string, Promise<RunFacts | string>>();
/** One cohort of a records.csv: the named question, or the only cohort with labelled rows. A string is the error. */
function runFacts(file: string, question: string | undefined): Promise<RunFacts | string> {
  const key = `${file}#${question ?? ""}`;
  const known = runCache.get(key);
  if (known) return known;
  const made = (async (): Promise<RunFacts | string> => {
    const csv = readFileSync(join(ROOT, file), "utf8");
    const parsed = validate(csv);
    if (parsed.errors.length) return `invalid records.csv: ${parsed.errors[0]}`;
    const labelledCohorts = groupCohorts(parsed.rows).filter((group) => group.rows.some((row) => truthLabel(row) !== null));
    const chosen = question === undefined ? labelledCohorts : labelledCohorts.filter((group) => group.key.questionId === question);
    const group = chosen[0];
    if (!group || chosen.length !== 1) return `${file}: ${chosen.length} labelled cohorts${question ? ` for question ${question}` : ""}; name one question`;
    const rows = group.rows.filter((row) => truthLabel(row) !== null);
    const of = (arm: FigureArm) => rows.filter((row) => row.get("answerer") === arm);
    const accepted = { jev: 0, llm: 0, rule: 0 }, labelled = { jev: 0, llm: 0, rule: 0 };
    const spend: Record<FigureArm, number | null> = { jev: 0, llm: 0, rule: 0 };
    const model: Record<FigureArm, string | null> = { jev: null, llm: null, rule: null };
    for (const arm of ARMS) {
      const mine = of(arm);
      labelled[arm] = mine.length;
      accepted[arm] = mine.filter((row) => truthLabel(row) === "accept").length;
      spend[arm] = mine.every((row) => typeof row.get("cost_usd") === "number") ? mine.reduce((sum, row) => sum + Number(row.get("cost_usd")), 0) : null;
      const models = [...new Set(mine.map((row) => String(row.get("answerer_model") ?? "")))];
      model[arm] = models.length === 1 ? models[0] ?? null : null;
    }
    const byCase = new Map<string, Set<string>>();
    for (const row of rows) {
      const id = String(row.get("case_id") ?? "");
      byCase.set(id, (byCase.get(id) ?? new Set<string>()).add(String(row.get("answerer") ?? "")));
    }
    const decision = verdict(metricsOfCohortRows(group.rows, group.key), await fileSeed(csv), armsInFile(parsed.rows));
    return {
      accepted, labelled, spend, model, paired: [...byCase.values()].filter((arms) => arms.has("jev") && arms.has("llm")).length,
      rule: decision.rule, lowerBound: decision.numbers.jevVsLlm?.lower ?? null, costRatio: decision.numbers.costRatio?.ratio ?? null,
    };
  })();
  runCache.set(key, made);
  return made;
}
/** The value a figure's metric has in its source, or why it has none. */
type Computed = { value: number | string } | { error: string };
const no = (error: string): Computed => ({ error });
async function computed(entry: Figure): Promise<Computed> {
  const kind = (ARM_METRICS as readonly string[]).includes(entry.metric) ? "arm" : (RUN_METRICS as readonly string[]).includes(entry.metric) ? "run"
    : (CONSTANT_METRICS as readonly string[]).includes(entry.metric) ? "constant" : "doc";
  if (kind === "constant") {
    if (entry.source !== "src/core/verdict.ts") return no(`${entry.metric} comes from src/core/verdict.ts, not ${entry.source}`);
    return { value: entry.metric === "minPaired" ? MIN_PAIRED : MARGIN };
  }
  if (!existsSync(join(ROOT, entry.source))) return no(`source missing ${entry.source}`);
  if (kind === "doc") {
    if (!/^docs\/product\/use-cases\/uc\d+-[^/]+\.md$/.test(entry.source)) return no(`${entry.metric} comes from a use-case doc, not ${entry.source}`);
    const doc = readFileSync(join(ROOT, entry.source), "utf8");
    if (entry.metric === "docCases") {
      const cases = /^- Cases: (\d+) or more\b/m.exec(doc)?.[1];
      return cases === undefined ? no(`${entry.source} has no "- Cases: N or more" line`) : { value: Number(cases) };
    }
    const answers = [...doc.matchAll(/^\|[^|\n]*\|[^|\n]*\|([^|\n]+)\|/gm)].map((match) => (match[1] ?? "").trim());
    const answer = answers.find((cell) => cell === entry.value);
    return answer === undefined ? no(`${entry.source} has no decision-table answer ${JSON.stringify(entry.value)}`) : { value: answer };
  }
  if (!/^docs\/product\/runs\/[^/]+\/records\.csv$/.test(entry.source)) return no(`${entry.metric} comes from a run's records.csv, not ${entry.source}`);
  const facts = await runFacts(entry.source, entry.question);
  if (typeof facts === "string") return no(facts);
  if (kind === "arm") {
    if (!entry.arm) return no(`${entry.metric} is per arm and names none`);
    const value = entry.metric === "accepted" ? facts.accepted[entry.arm] : entry.metric === "labelled" ? facts.labelled[entry.arm]
      : entry.metric === "spend" ? facts.spend[entry.arm] : facts.model[entry.arm];
    return value === null ? no(`${entry.metric} of ${entry.arm} is not recorded`) : { value };
  }
  if (entry.arm) return no(`${entry.metric} is not per arm, yet names ${entry.arm}`);
  switch (entry.metric) {
    case "paired": return { value: facts.paired };
    case "toMinimum": return { value: MIN_PAIRED - facts.paired };
    case "rule": return { value: facts.rule };
    case "acceptedEach": return facts.accepted.jev === facts.accepted.llm ? { value: facts.accepted.jev } : no("Jev and the LLM did not tie");
    case "lowerBound": return facts.lowerBound === null ? no("no Jev minus LLM lower bound") : { value: facts.lowerBound };
    case "costRatio": return facts.costRatio === null ? no("no cost ratio") : { value: facts.costRatio };
    case "spendRatio": return facts.spend.jev && facts.spend.llm !== null ? { value: facts.spend.llm / facts.spend.jev } : no("no spend ratio");
    default: return no(`unknown metric ${entry.metric}`);
  }
}
const UNIT_FRACTIONS: Readonly<Record<number, string>> = { 2: "a half", 3: "a third", 4: "a quarter", 5: "a fifth", 6: "a sixth", 7: "a seventh", 8: "an eighth", 9: "a ninth", 10: "a tenth" };
function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}
/**
 * The named rounding rules. int: the whole number. usd4/usd5: dollars to 4 or 5 decimals. rule: "rule N".
 * aboutPoints: "about N points", N = the share x100 rounded (a lower bound of -0.043 is "about 4 points").
 * pointLimit: "N-point", N = the share x100. aboutFraction: "about a fifth", the unit fraction 1/n nearest the ratio
 * (n = round(1 / ratio)). ordinalFraction: "1/79th", n = round(ratio). each: "N each". tie: "N to N".
 * messageRun: "N-message". modelShort: "claude-haiku-5-5" is "Haiku 5.5". answers: the answer set as written.
 */
function render(format: Format, value: number | string): string | null {
  if (format === "modelShort" || format === "answers") {
    if (typeof value !== "string") return null;
    if (format === "answers") return value;
    const match = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(value);
    return match ? `${(match[1] ?? "").charAt(0).toUpperCase()}${(match[1] ?? "").slice(1)} ${match[2]}.${match[3]}` : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  switch (format) {
    case "int": return Number.isInteger(value) ? String(value) : null;
    case "usd4": return `$${value.toFixed(4)}`;
    case "usd5": return `$${value.toFixed(5)}`;
    case "rule": return `rule ${value}`;
    case "aboutPoints": return Math.abs(value) < 1 ? `about ${Math.round(Math.abs(value) * 100)} points` : null;
    case "pointLimit": return Math.abs(value) < 1 ? `${Math.round(value * 100)}-point` : null;
    case "aboutFraction": { const word = value > 0 ? UNIT_FRACTIONS[Math.round(1 / value)] : undefined; return word ? `about ${word}` : null; }
    case "ordinalFraction": return value > 1 ? `1/${ordinal(Math.round(value))}` : null;
    case "each": return Number.isInteger(value) ? `${value} each` : null;
    case "tie": return Number.isInteger(value) ? `${value} to ${value}` : null;
    case "messageRun": return Number.isInteger(value) ? `${value}-message` : null;
  }
}
function sameValue(a: number | string, b: number | string): boolean {
  return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)) : a === b;
}
const ARM_WORDS: [FigureArm, RegExp][] = [["jev", /\bJev\b/g], ["llm", /\bLLM\b/g], ["rule", /\bsimple rule\b/gi]];
function armWords(text: string): { arm: FigureArm; at: number }[] {
  return ARM_WORDS.flatMap(([arm, pattern]) => [...text.matchAll(pattern)].map((match) => ({ arm, at: match.index ?? 0 }))).sort((a, b) => a.at - b.at);
}
/**
 * The arm the page attributes a figure to. In "(X against Y)" X is Jev (the subject of every comparison on these
 * pages) and Y the arm named just before the parenthesis. Otherwise the nearest arm word before the figure in its
 * sentence, or, when none comes before, the nearest after it.
 */
function armAt(text: string, start: number): FigureArm | null {
  const sentenceStart = Math.max(0, text.lastIndexOf(". ", start) + 1);
  const nextStop = text.indexOf(". ", start);
  const sentenceEnd = nextStop < 0 ? text.length : nextStop;
  const open = text.lastIndexOf("(", start), close = text.indexOf(")", start);
  if (open >= sentenceStart && close >= 0 && text.lastIndexOf(")", start) < open) {
    const inside = text.slice(open, close);
    const against = inside.indexOf(" against ");
    if (against >= 0) {
      if (start < open + against) return "jev";
      return armWords(text.slice(sentenceStart, open)).at(-1)?.arm ?? null;
    }
  }
  const words = armWords(text.slice(sentenceStart, sentenceEnd)).map((word) => ({ ...word, at: word.at + sentenceStart }));
  return words.filter((word) => word.at < start).at(-1)?.arm ?? words.find((word) => word.at > start)?.arm ?? null;
}
function partText(sample: Sample, part: Part): string | null {
  return part === "verdict" ? sample.verdictLine : sample.explained?.[part] ?? null;
}
async function checkFigures(samples: Sample[]): Promise<string[]> {
  const problems: string[] = [];
  for (const sample of samples) {
    const figures = sample.explained?.figures;
    if (copyParts(sample).length === 0) problems.push(`${sample.id}: no sample copy`);
    if ((sample.runBacked || copyParts(sample).some((part) => /\d/.test(part))) && (!figures || figures.length === 0)) problems.push(`${sample.id}: no figures for run or numbered copy`);
    if (!figures) continue;
    const covered: Record<Part, { start: number; end: number }[]> = { verdict: [], why: [], cases: [], next: [], rephrase: [], earlier: [] };
    const cursor: Record<Part, number> = { verdict: 0, why: 0, cases: 0, next: 0, rephrase: 0, earlier: 0 };
    for (const entry of figures) {
      const label = `${sample.id} ${entry.part} ${JSON.stringify(entry.display)}`;
      const text = partText(sample, entry.part);
      const at = text === null ? -1 : text.indexOf(entry.display, cursor[entry.part]);
      if (text === null || at < 0) { problems.push(`${label}: not on the page (in order)`); continue; }
      cursor[entry.part] = at + entry.display.length;
      covered[entry.part].push({ start: at, end: at + entry.display.length });
      if (!FORMATS[entry.metric].includes(entry.format)) { problems.push(`${label}: format ${entry.format} is not allowed for ${entry.metric}`); continue; }
      const result = await computed(entry);
      if ("error" in result) { problems.push(`${label}: ${result.error}`); continue; }
      const expected = result.value;
      if (!sameValue(entry.value, expected)) { problems.push(`${label}: value ${entry.value} but ${entry.source} gives ${expected}`); continue; }
      const shown = render(entry.format, expected);
      if (shown !== entry.display) problems.push(`${label}: ${entry.source} gives ${expected}, which ${entry.format} writes as ${JSON.stringify(shown)}`);
      if (entry.arm) {
        const pageArm = armAt(text, at);
        if (pageArm !== entry.arm) problems.push(`${label}: the page attributes it to ${pageArm ?? "no arm"}, the figure to ${entry.arm}`);
      }
    }
    for (const part of PARTS) {
      const text = partText(sample, part);
      if (!text) continue;
      for (const match of [...text.matchAll(NUMBERS), ...text.matchAll(FRACTION_WORDS)]) {
        const start = match.index ?? 0;
        if (!covered[part].some((span) => span.start <= start && span.end >= start + match[0].length)) problems.push(`${sample.id} ${part}: undeclared figure ${JSON.stringify(match[0])}`);
      }
    }
  }
  return problems;
}
function checkEnds(samples: Sample[]): string[] {
  const problems: string[] = [];
  for (const sample of samples) {
    if (!sample.explained) { problems.push(`${sample.id}: no explained copy`); continue; }
    const why = sample.explained.why?.trim();
    const last = copyParts(sample).at(-1);
    if (!last) problems.push(`${sample.id}: no sample copy`);
    else if (BARE.test(last)) problems.push(`${sample.id}: ends on bare verdict ${JSON.stringify(last)}`);
    if (why && BARE.test(why)) problems.push(`${sample.id}: why is bare verdict ${JSON.stringify(why)}`);
    if (why && why === sample.verdictLine?.trim()) problems.push(`${sample.id}: why repeats verdict line`);
  }
  return problems;
}
function fixture(): Sample[] {
  const posters = IDS.map((id): Sample => ({
    id, fit: NOT_FIT.includes(id) ? ["Jev probably not"] : [], runBacked: false,
    verdictLine: "Needs a test", explained: { why: "The question needs a fixed answer.", cases: "No recorded cases yet.", next: "Write a measurable question.",
      rephrase: NOT_FIT.includes(id) ? 'Ask "Does this case need review?"' : null, earlier: null, figures: [] },
  }));
  return [...posters, { id: "Stage", fit: [], runBacked: false, verdictLine: "Needs a test", explained: {
    why: "The result needs checking.", cases: "The cases show a tie.", next: "Check more cases.", rephrase: null, earlier: null, figures: [],
  } }];
}
function requireClean(problems: string[]): void { if (problems.length) throw new Error(problems.join("\n")); }

test("[unit] #201-1 each landing sample shows rule, why, what the cases show, next step", () => {
  const loaded = loadSamples();
  requireClean([...loaded.problems, ...checkParts(loaded.samples)]);
});
test("[unit] #201-1 mutation: blank uc12 next and delete Stage why", () => {
  const samples = structuredClone(fixture());
  const uc12 = samples.find((sample) => sample.id === "uc12");
  const stage = samples.find((sample) => sample.id === "Stage");
  if (!uc12?.explained || !stage?.explained) throw new Error("fixture incomplete");
  expect(checkParts(samples)).toEqual([]);
  uc12.explained.next = "";
  stage.explained.why = null;
  expect(checkParts(samples).some((problem) => problem.includes("uc12: next missing"))).toBe(true);
  expect(checkParts(samples).some((problem) => problem.includes("Stage: why missing"))).toBe(true);
});
test("[unit] #201-2 every \"Jev probably not\" sample has a rephrased question or a stated reason", () => {
  const loaded = loadSamples();
  requireClean([...loaded.problems, ...checkRephrases(loaded.samples)]);
});
test("[unit] #201-2 mutation: uc10 has no rephrase and uc9 has no question", () => {
  const samples = structuredClone(fixture());
  const uc10 = samples.find((sample) => sample.id === "uc10");
  const uc9 = samples.find((sample) => sample.id === "uc9");
  if (!uc10?.explained || !uc9?.explained) throw new Error("fixture incomplete");
  expect(checkRephrases(samples)).toEqual([]);
  uc10.explained.rephrase = null;
  uc9.explained.rephrase = "Try a different task.";
  expect(checkRephrases(samples).some((problem) => problem.includes("uc10: no rephrase"))).toBe(true);
  expect(checkRephrases(samples).some((problem) => problem.includes("uc9: rephrase has no quoted question"))).toBe(true);
});
test("[unit] #201-3 every figure in the sample copy follows from the source it cites", async () => {
  const loaded = loadSamples();
  requireClean([...loaded.problems, ...await checkFigures(loaded.samples)]);
});

/** The shipped Stage sample, cloned, so each mutation starts from copy and figures that pass. */
function stageSample(): Sample {
  const stage = loadSamples().samples.find((sample) => sample.id === "Stage");
  if (!stage?.explained?.figures) throw new Error("Stage sample with figures missing");
  return structuredClone(stage);
}
/** Change the copy and the figure together, as an author who wanted the wrong number to pass would. */
function rewrite(sample: Sample, part: Part, from: string, to: string, index: number, patch: Partial<Figure>, drop: (keyof Figure)[] = []): void {
  const e = sample.explained;
  if (!e?.figures) throw new Error("no figures");
  const text = partText(sample, part);
  if (text === null || !text.includes(from)) throw new Error(`${part} has no ${from}`);
  const changed = text.replace(from, to);
  if (part === "verdict") sample.verdictLine = changed; else e[part] = changed;
  const target = e.figures.filter((entry) => entry.part === part)[index];
  if (!target) throw new Error(`no figure ${index} in ${part}`);
  Object.assign(target, patch);
  for (const key of drop) delete target[key];
}
test("[unit] #201-3 mutation: the gate's wrong figures all go RED, the correct ones pass", async () => {
  // Correct figures whose source holds many other numbers (the 100-message run) pass: the control.
  expect(await checkFigures([stageSample()])).toEqual([]);
  const cases: [string, (stage: Sample) => void, string][] = [
    ["arm swap with arm-less figures", (stage) => {
      rewrite(stage, "cases", "Jev 88 of 100, the LLM (Claude Haiku 5.5) 86", "Jev 86 of 100, the LLM (Claude Haiku 5.5) 88", 0, { display: "86", value: 86 }, ["arm"]);
      const llm = stage.explained?.figures?.filter((entry) => entry.part === "cases")[3];
      if (llm) { llm.display = "88"; llm.value = 88; delete llm.arm; }
    }, "accepted is per arm and names none"],
    ["arm swap with the arms swapped too", (stage) => {
      rewrite(stage, "cases", "Jev 88 of 100, the LLM (Claude Haiku 5.5) 86", "Jev 86 of 100, the LLM (Claude Haiku 5.5) 88", 0, { display: "86", value: 86, arm: "llm" });
      const llm = stage.explained?.figures?.filter((entry) => entry.part === "cases")[3];
      if (llm) { llm.display = "88"; llm.value = 88; llm.arm = "jev"; }
    }, "the page attributes it to jev, the figure to llm"],
    ["88 against 83", (stage) => rewrite(stage, "why", "(88 against 86)", "(88 against 83)", 2, { display: "83", value: 83 }), "value 83 but"],
    ["88 against 9", (stage) => rewrite(stage, "why", "(88 against 86)", "(88 against 9)", 2, { display: "9", value: 9 }), "value 9 but"],
    ["20 points from the cost ratio 0.197", (stage) => rewrite(stage, "why", "about 4 points", "about 20 points", 3, { display: "about 20 points", metric: "costRatio", value: 0.197 }), "format aboutPoints is not allowed for costRatio"],
    ["2 points from the point estimate +0.02", (stage) => rewrite(stage, "why", "about 4 points", "about 2 points", 3, { display: "about 2 points", value: 0.02 }), "value 0.02 but"],
    ["49 of 300", (stage) => rewrite(stage, "cases", "49 of 100", "49 of 300", 6, { display: "300", value: 300 }), "value 300 but"],
    ["a quarter for a fifth", (stage) => rewrite(stage, "why", "about a fifth", "about a quarter", 5, { display: "about a quarter", value: 0.25 }), "value 0.25 but"],
    ["the right value written with the wrong rule", (stage) => rewrite(stage, "cases", "$0.0033", "$0.0032", 7, { display: "$0.0032" }), "which usd4 writes as \"$0.0033\""],
    ["38 each from the 40-message run changed to 37", (stage) => rewrite(stage, "earlier", "38 each", "37 each", 1, { display: "37 each", value: 37 }), "value 37 but"],
    ["an undeclared number", (stage) => { if (stage.explained) stage.explained.next += " About 7 more would settle it."; }, "undeclared figure \"7\""],
    ["an undeclared fraction word", (stage) => { if (stage.explained) stage.explained.next += " Or a third of them."; }, "undeclared figure \"a third\""],
    ["a figure cited to a page instead of a source", (stage) => rewrite(stage, "earlier", "1/79th", "1/79th", 4, { source: "site/little-shop/index.html" }), "comes from a run's records.csv"],
  ];
  for (const [name, apply, expected] of cases) {
    const stage = stageSample();
    apply(stage);
    const problems = await checkFigures([stage]);
    if (!problems.some((problem) => problem.includes(expected))) throw new Error(`${name}: expected a problem containing ${JSON.stringify(expected)}, got ${JSON.stringify(problems)}`);
  }
});
test("[unit] #201-3 each named rounding rule writes its source value one way", () => {
  const written: [Format, number | string, string | null][] = [
    ["aboutPoints", -0.04266031343755382, "about 4 points"], ["aboutPoints", 0.02, "about 2 points"], ["aboutPoints", 9, null],
    ["pointLimit", 0.1, "10-point"], ["aboutFraction", 0.19745918526106973, "about a fifth"], ["aboutFraction", 0.25, "about a quarter"],
    ["ordinalFraction", 79.25193584070799, "1/79th"], ["ordinalFraction", 0.5, null], ["usd4", 0.00328442, "$0.0033"], ["usd5", 0.000080682, "$0.00008"],
    ["int", 88, "88"], ["int", 88.5, null], ["each", 38, "38 each"], ["tie", 38, "38 to 38"], ["messageRun", 100, "100-message"], ["rule", 3, "rule 3"],
    ["modelShort", "claude-haiku-5-5", "Haiku 5.5"], ["modelShort", "claude-haiku-4-5-20251001", "Haiku 4.5"], ["modelShort", "gpt-6-sol", null],
  ];
  for (const [format, value, expected] of written) expect([format, value, render(format, value)]).toEqual([format, value, expected]);
});
test("[unit] #201-3 mutation: a count from the wrong question or from every question", async () => {
  const tokenmax = "docs/product/runs/2026-10-03-tokenmax/records.csv";
  const sample = (question: string | undefined): Sample[] => [{ id: "uc11", fit: [], runBacked: true, verdictLine: "Needs a test", explained: {
    why: "The rule is unmet.", cases: "the simple rule 2 of 5", next: "Label more cases.", rephrase: null, earlier: null,
    figures: [{ part: "cases", display: "2", metric: "accepted", format: "int", value: 2, source: tokenmax, arm: "rule", ...(question === undefined ? {} : { question }) },
      { part: "cases", display: "5", metric: "labelled", format: "int", value: 5, source: tokenmax, arm: "rule", question: "q1" }],
  } }];
  expect(await checkFigures(sample("q1"))).toEqual([]);
  expect((await checkFigures(sample("q2"))).some((problem) => problem.includes("value 2 but") && problem.includes("gives 4"))).toBe(true);
  expect((await checkFigures(sample(undefined))).some((problem) => problem.includes("2 labelled cohorts"))).toBe(true);
});
test("[unit] #201-2 mutation: quoting the original question is not a rephrase", () => {
  const samples = structuredClone(fixture());
  const uc9 = samples.find((sample) => sample.id === "uc9");
  if (!uc9?.explained) throw new Error("fixture incomplete");
  uc9.explained.why = '"Is this AI slop?" is an open question.';
  expect(checkRephrases(samples)).toEqual([]);
  uc9.explained.rephrase = 'The original "Is this AI slop?" stays as asked.';
  expect(checkRephrases(samples).some((problem) => problem.includes("uc9: rephrase has no quoted question"))).toBe(true);
});
test("[unit] #201-4 no sample ends on a bare verdict word", () => {
  const loaded = loadSamples();
  requireClean([...loaded.problems, ...checkEnds(loaded.samples)]);
});
test("[unit] #201-4 mutation: uc13 why is bare and Stage ends on verdict", () => {
  const samples = structuredClone(fixture());
  const uc13 = samples.find((sample) => sample.id === "uc13");
  const stage = samples.find((sample) => sample.id === "Stage");
  if (!uc13?.explained || !stage?.explained) throw new Error("fixture incomplete");
  expect(checkEnds(samples)).toEqual([]);
  uc13.explained.why = "Use Jev.";
  stage.explained.why = null;
  stage.explained.cases = null;
  stage.explained.next = null;
  expect(checkEnds(samples).some((problem) => problem.includes("uc13: why is bare verdict"))).toBe(true);
  expect(checkEnds(samples).some((problem) => problem.includes("Stage: ends on bare verdict"))).toBe(true);
});

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(`${found.error} Run bunx playwright-core install chromium.`);
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      if (pathname === "/api/tickets/ranking") return Response.json({ ids: [], counts: {} });
      const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
      if (!path.startsWith(`${SITE}${sep}`)) return new Response("Not found", { status: 404 });
      const file = Bun.file(path);
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
    },
  });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });
async function pageAt(width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
  return page;
}
async function visiblePart(scope: Locator, selector: string, expected: string | null, name: string, problems: string[]): Promise<void> {
  const element = scope.locator(selector);
  const count = await element.count();
  if (count !== 1) { problems.push(`${selector} missing in ${name} (found ${count})`); return; }
  if (!await element.isVisible()) problems.push(`${selector} hidden in ${name}`);
  if (await element.evaluate((node) => Boolean(node.closest("details")))) problems.push(`${selector} inside details in ${name}`);
  if (expected !== null && !((await element.innerText()).includes(expected))) problems.push(`${selector} text does not contain explained copy in ${name}`);
}
test("[integration] #201-5 the page shows each explained part visibly at 1440 and 390", async () => {
  const loaded = loadSamples();
  const problems = [...loaded.problems];
  const posters = loaded.samples.filter((sample) => sample.id !== "Stage");
  const stage = loaded.samples.find((sample) => sample.id === "Stage");
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const page = await pageAt(width ?? 0, height ?? 0);
    try {
      const cardCount = await page.locator(".tk-poster").count();
      if (cardCount !== posters.length || cardCount === 0) problems.push(`${width}: .tk-poster count ${cardCount}, expected ${posters.length}`);
      for (const poster of posters) {
        const card = page.locator(`.tk-poster[data-id="${poster.id}"]`);
        if (await card.count() !== 1) { problems.push(`${width}: ${poster.id} card missing or duplicated`); continue; }
        const e = poster.explained;
        const parts: [string, string | null][] = [[".tk-verdict", poster.verdictLine], [".tk-why", e?.why ?? null], [".tk-cases", e?.cases ?? null], [".tk-next", e?.next ?? null]];
        if (e?.rephrase) parts.push([".tk-rephrase", e.rephrase]);
        if (e?.earlier) parts.push([".tk-earlier", e.earlier]);
        for (const [selector, value] of parts) await visiblePart(card, selector, value, poster.id, problems);
        const order = await card.locator(parts.map(([selector]) => selector).join(", ")).evaluateAll((nodes) => nodes.map((node) => [...node.classList].find((name) => name.startsWith("tk-")) ?? ""));
        const expected = parts.map(([selector]) => selector.slice(1));
        if (order.join(",") !== expected.join(",")) problems.push(`${width}: ${poster.id} explained parts out of DOM order`);
        if (poster.verdictLine && await card.locator(".tk-verdict").count() === 1 && (await card.locator(".tk-verdict").innerText()).trim() !== poster.verdictLine) problems.push(`${width}: ${poster.id} .tk-verdict differs from verdictLine`);
      }
      if (!stage?.explained) problems.push(`${width}: Stage has no explained copy`);
      await visiblePart(page.locator("body"), "#heroWhy", stage?.explained?.why ?? null, "Stage", problems);
      const t5 = page.locator("#t5");
      if (await t5.count() !== 1) problems.push(`${width}: #t5 missing`);
      else if (stage?.verdictLine && (await t5.innerText()).trim() !== stage.verdictLine) problems.push(`${width}: #t5 differs from Stage verdict`);
      const stageParts: [string, string | null][] = [["#verdictWhy", stage?.explained?.why ?? null], ["#verdictCases", stage?.explained?.cases ?? null], ["#verdictNext", stage?.explained?.next ?? null], ["#verdictEarlier", stage?.explained?.earlier ?? null]];
      for (const [selector, value] of stageParts) await visiblePart(page.locator("body"), selector, value, "Stage", problems);
      const stageOrder = await page.locator(["#t5", ...stageParts.map(([selector]) => selector)].join(", ")).evaluateAll((nodes) => nodes.map((node) => node.id));
      if (stageOrder.join(",") !== ["t5", "verdictWhy", "verdictCases", "verdictNext", "verdictEarlier"].join(",")) problems.push(`${width}: Stage explained parts out of DOM order after #t5`);
    } finally { await page.close(); }
  }
  requireClean(problems);
}, 30000);
