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
const WORD_FIGURES = /\b(?:one(?:[ -]hundred)?|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|forty(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|fifty(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|sixty(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|seventy(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|eighty(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|ninety(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|hundred|half|twice|double|percent|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) times)\b/gi;
const PROSE_EXCEPTIONS: readonly { sample: string; part: Part; phrase: string }[] = [
  { sample: "uc12", part: "verdict", phrase: "Split two ways" },
  { sample: "uc11", part: "rephrase", phrase: "Ask one yes/no per ad line" },
  { sample: "uc9", part: "rephrase", phrase: "Ask one check at a time" },
];
const BARE = /^(?:Verdict:\s*)?(?:use Jev|don't use Jev|not enough evidence|not proven yet|not enough proof yet|Jev probably not|Jev could help|not Jev|!Jev|split two ways|needs a test)(?:\s*\([^)]*\))?\.?$/i;

/*
 * Every figure on the page is a whole claim fragment: its arm label, its number(s) and its direction word sit inside
 * the display. The format names the slots it holds (metric per declared arm), the test computes each slot from the
 * cited source and renders the fragment from those values and the declared arms; the display must equal a rendering.
 * No arm is inferred from nearby prose, and a digit or number word outside every display is an undeclared figure.
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
type Format = "int" | "rule" | "pointLimit" | "messageRun" | "pointsBehind" | "tiedTo" | "armCount" | "armScore" | "armModelCount" | "armModelScore"
  | "armSpent4" | "armSpent5" | "armSpendOf4" | "armSpendOf5" | "modelWas" | "modelAs" | "keptAsMany" | "sameAccuracy"
  | "costShareOf" | "costShare" | "tiedEach" | "spendShareOf" | "answers";
const FORMATS: readonly Format[] = ["int", "rule", "pointLimit", "messageRun", "pointsBehind", "tiedTo", "armCount", "armScore", "armModelCount", "armModelScore",
  "armSpent4", "armSpent5", "armSpendOf4", "armSpendOf5", "modelWas", "modelAs", "keptAsMany", "sameAccuracy", "costShareOf", "costShare", "tiedEach", "spendShareOf", "answers"];
interface Figure {
  part: Part;
  display: string;
  format: Format;
  source: string;
  metric?: Metric;
  arm?: FigureArm;
  arms?: [FigureArm, FigureArm];
  values: (number | string)[];
  question?: string;
  row?: string;
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
  return FORMATS.some((format) => format === value);
}
function figure(value: unknown): value is Figure {
  return record(value) && isPart(value.part) && typeof value.display === "string" && isFormat(value.format) &&
    Array.isArray(value.values) && value.values.every((item) => typeof item === "number" || typeof item === "string") && typeof value.source === "string" &&
    (value.metric === undefined || isMetric(value.metric)) && (value.arm === undefined || isArm(value.arm)) &&
    (value.arms === undefined || (Array.isArray(value.arms) && value.arms.length === 2 && value.arms.every(isArm))) &&
    (value.question === undefined || typeof value.question === "string") && (value.row === undefined || typeof value.row === "string");
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
/** One slot computed from the cited source. */
type Computed = { value: number | string } | { error: string };
const no = (error: string): Computed => ({ error });
async function computed(entry: Figure, metric: Metric, arm: FigureArm | undefined, sampleId: string): Promise<Computed> {
  const kind = (ARM_METRICS as readonly string[]).includes(metric) ? "arm" : (RUN_METRICS as readonly string[]).includes(metric) ? "run"
    : (CONSTANT_METRICS as readonly string[]).includes(metric) ? "constant" : "doc";
  if (kind === "constant") {
    if (entry.source !== "src/core/verdict.ts") return no(`${metric} comes from src/core/verdict.ts, not ${entry.source}`);
    return { value: metric === "minPaired" ? MIN_PAIRED : MARGIN };
  }
  if (!existsSync(join(ROOT, entry.source))) return no(`source missing ${entry.source}`);
  if (kind === "doc") {
    const docId = /^docs\/product\/use-cases\/(uc\d+)-[^/]+\.md$/.exec(entry.source)?.[1];
    if (!docId) return no(`${metric} comes from a use-case doc, not ${entry.source}`);
    if (docId !== sampleId) return no(`${metric} source ${docId} does not match sample ${sampleId}`);
    const doc = readFileSync(join(ROOT, entry.source), "utf8");
    if (metric === "docCases") {
      const cases = /^- Cases: (\d+) or more\b/m.exec(doc)?.[1];
      return cases === undefined ? no(`${entry.source} has no "- Cases: N or more" line`) : { value: Number(cases) };
    }
    if (!entry.row) return no("docAnswers requires a row check id");
    const lines = doc.split("\n");
    const header = lines.findIndex((line) => /^\|\s*#\s*\|\s*Check\s*\|\s*Answer\s*\|/.test(line));
    if (header < 0) return no(`${entry.source} has no decision-table header`);
    for (const line of lines.slice(header + 2)) {
      if (!line.startsWith("|")) break;
      const cells = line.split("|").slice(1).map((cell) => cell.trim());
      if (cells[0] === entry.row) return cells[2] ? { value: cells[2] } : no(`${entry.source} row ${entry.row} has no Answer`);
    }
    return no(`${entry.source} has no decision-table row ${entry.row}`);
  }
  if (!/^docs\/product\/runs\/[^/]+\/records\.csv$/.test(entry.source)) return no(`${metric} comes from a run's records.csv, not ${entry.source}`);
  const facts = await runFacts(entry.source, entry.question);
  if (typeof facts === "string") return no(facts);
  if (kind === "arm") {
    if (!arm) return no(`${metric} is per arm and names none`);
    const value = metric === "accepted" ? facts.accepted[arm] : metric === "labelled" ? facts.labelled[arm]
      : metric === "spend" ? facts.spend[arm] : facts.model[arm];
    return value === null ? no(`${metric} of ${arm} is not recorded`) : { value };
  }
  switch (metric) {
    case "paired": return { value: facts.paired };
    case "toMinimum": return { value: MIN_PAIRED - facts.paired };
    case "rule": return { value: facts.rule };
    case "acceptedEach": return facts.accepted.jev === facts.accepted.llm ? { value: facts.accepted.jev } : no("Jev and the LLM did not tie");
    case "lowerBound": return facts.lowerBound === null ? no("no Jev minus LLM lower bound") : { value: facts.lowerBound };
    case "costRatio": return facts.costRatio === null ? no("no cost ratio") : { value: facts.costRatio };
    case "spendRatio": return facts.spend.jev && facts.spend.llm !== null ? { value: facts.spend.llm / facts.spend.jev } : no("no spend ratio");
    default: return no(`unknown metric ${metric}`);
  }
}
const UNIT_FRACTIONS: Readonly<Record<number, string>> = { 2: "a half", 3: "a third", 4: "a quarter", 5: "a fifth", 6: "a sixth", 7: "a seventh", 8: "an eighth", 9: "a ninth", 10: "a tenth" };
function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}
type Slot = { metric: Metric; arm?: FigureArm };
const labels: Readonly<Record<FigureArm, readonly string[]>> = { jev: ["Jev"], llm: ["the LLM", "LLM"], rule: ["the simple rule", "simple rule"] };
const slot = (metric: Metric, arm?: FigureArm): Slot => arm ? { metric, arm } : { metric };
function slots(entry: Figure): Slot[] | string {
  const a = entry.arm, pair = entry.arms;
  if (entry.format === "int") return !a && !pair && entry.metric && ["paired", "minPaired", "toMinimum", "docCases"].includes(entry.metric) ? [slot(entry.metric)] : "int requires only its count metric";
  if (entry.metric) return `${entry.format} cannot name a metric`;
  if (["rule", "pointLimit", "messageRun", "pointsBehind", "tiedTo", "answers"].includes(entry.format)) {
    if (a || pair) return `${entry.format} names no arm`;
    const metric: Metric = entry.format === "rule" ? "rule" : entry.format === "pointLimit" ? "margin" : entry.format === "messageRun" ? "paired"
      : entry.format === "pointsBehind" ? "lowerBound" : entry.format === "tiedTo" ? "acceptedEach" : "docAnswers";
    return [slot(metric)];
  }
  if (["armCount", "armScore", "armModelCount", "armModelScore", "armSpent4", "armSpent5", "armSpendOf4", "armSpendOf5", "modelWas", "modelAs"].includes(entry.format)) {
    if (!a || pair) return `${entry.format} requires one declared arm`;
    if (entry.format === "armCount") return [slot("accepted", a)];
    if (entry.format === "armScore") return [slot("accepted", a), slot("labelled", a)];
    if (entry.format === "armModelCount") return [slot("model", a), slot("accepted", a)];
    if (entry.format === "armModelScore") return [slot("model", a), slot("accepted", a), slot("labelled", a)];
    return [slot(entry.format.startsWith("armSpent") || entry.format.startsWith("armSpendOf") ? "spend" : "model", a)];
  }
  if (a || !pair || pair[0] === pair[1]) return `${entry.format} requires two distinct declared arms`;
  const [first, second] = pair;
  if (["keptAsMany", "sameAccuracy"].includes(entry.format)) {
    if (entry.format === "sameAccuracy" && first !== "jev") return "sameAccuracy subject must be jev";
    return entry.format === "sameAccuracy" ? [slot("accepted", first), slot("accepted", second), slot("paired")]
      : [slot("accepted", first), slot("accepted", second)];
  }
  if (first === "rule" || second === "rule") return `${entry.format} requires Jev and LLM`;
  if (entry.format === "tiedEach") return [slot("acceptedEach")];
  if (entry.format === "costShare") return first === "jev" && second === "llm" ? [slot("costRatio")] : "costShare requires [jev,llm]";
  if (entry.format === "costShareOf" || entry.format === "spendShareOf") return [slot(entry.format === "costShareOf" ? "costRatio" : "spendRatio")];
  return `unknown format ${entry.format}`;
}
function model(value: number | string): string | null {
  if (typeof value !== "string") return null;
  const match = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(value);
  return match ? `${(match[1] ?? "").charAt(0).toUpperCase()}${(match[1] ?? "").slice(1)} ${match[2]}.${match[3]}` : null;
}
function render(entry: Figure, values: readonly (number | string)[]): string[] {
  const [v, w, x] = values;
  const a = entry.arm ? labels[entry.arm] : [];
  const pair = entry.arms;
  const pairs = pair ? labels[pair[0]].flatMap((left) => labels[pair[1]].map((right) => [left, right])) : [];
  const n = typeof v === "number" && Number.isFinite(v) ? v : null;
  const whole = n !== null && Number.isInteger(n);
  const frac = n !== null && n > 0 ? UNIT_FRACTIONS[Math.round(1 / n)] : undefined;
  const short = model(v ?? "");
  switch (entry.format) {
    case "int": return whole ? [String(v)] : [];
    case "rule": return whole ? [`rule ${v}`] : [];
    case "pointLimit": return n !== null && n >= 0 && n < 1 ? [`${Math.round(n * 100)}-point`] : [];
    case "messageRun": return whole ? [`${v}-message`] : [];
    case "pointsBehind": { const points = n === null ? 0 : Math.round(Math.abs(n) * 100); return n !== null && Math.abs(n) < 1 && points > 0 ? [n < 0 ? `no more than about ${points} points behind` : `at least about ${points} points ahead`] : []; }
    case "tiedTo": return whole ? [`tied ${v} to ${v}`] : [];
    case "armCount": return whole ? a.map((name) => `${name} ${v}`) : [];
    case "armScore": return whole && typeof w === "number" && Number.isInteger(w) ? a.map((name) => `${name} ${v} of ${w}`) : [];
    case "armModelCount": return model(v ?? "") && typeof w === "number" && Number.isInteger(w) ? a.map((name) => `${name} (${model(v ?? "")}) ${w}`) : [];
    case "armModelScore": return short && typeof w === "number" && Number.isInteger(w) && typeof x === "number" && Number.isInteger(x) ? a.map((name) => `${name} (Claude ${short}) ${w} of ${x}`) : [];
    case "armSpent4": case "armSpent5": return n !== null ? a.map((name) => `${name} spent $${n.toFixed(entry.format === "armSpent4" ? 4 : 5)}`) : [];
    case "armSpendOf4": case "armSpendOf5": return n !== null ? a.map((name) => `${name}'s $${n.toFixed(entry.format === "armSpendOf4" ? 4 : 5)}`) : [];
    case "modelWas": return short ? a.map((name) => `${name} was ${short}`) : [];
    case "modelAs": return short ? a.map((name) => `Claude ${short} as ${name}`) : [];
    case "keptAsMany": return typeof v === "number" && typeof w === "number" && Number.isInteger(v) && Number.isInteger(w) && v >= w
      ? pairs.map(([left, right]) => `${left} kept as many right answers as ${right} (${v} against ${w})`) : [];
    case "sameAccuracy": return typeof v === "number" && typeof w === "number" && typeof x === "number" && Number.isInteger(v) && Number.isInteger(w) && Number.isInteger(x) && v >= w && pair?.[0] === "jev"
      ? labels[pair[1]].map((name) => `Same accuracy as ${name} (${v} against ${w} of ${x})`) : [];
    case "costShareOf": { const word = n && n > 0 && n < 1 ? UNIT_FRACTIONS[Math.round(1 / n)] : undefined;
      return word ? pairs.map(([left, right]) => `cost ${left} about ${word} of what it cost ${right}`) : []; }
    case "costShare": return n !== null && n < 1 && frac ? [`at about ${frac} of the cost per kept answer`] : [];
    case "tiedEach": return whole ? pairs.map(([left, right]) => `${left} and ${right} tied, ${v} each`) : [];
    case "spendShareOf": return n !== null && n > 1 ? pairs.map(([left, right]) => `${left} about 1/${ordinal(Math.round(n))} of ${right}`) : [];
    case "answers": return typeof v === "string" ? [v] : [];
  }
}
const EXACT_METRICS: readonly Metric[] = ["accepted", "labelled", "paired", "toMinimum", "rule", "minPaired", "docCases", "acceptedEach", "docAnswers", "model"];
function sameValue(a: number | string, b: number | string, metric: Metric): boolean {
  if (EXACT_METRICS.includes(metric)) return a === b;
  return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
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
    for (const exception of PROSE_EXCEPTIONS.filter((item) => item.sample === sample.id)) {
      const page = partText(sample, exception.part) ?? "";
      const at = page.indexOf(exception.phrase);
      if (at < 0) problems.push(`${sample.id} ${exception.part}: prose exception not on page ${JSON.stringify(exception.phrase)}`);
      else covered[exception.part].push({ start: at, end: at + exception.phrase.length });
    }
    for (const entry of figures) {
      const label = `${sample.id} ${entry.part} ${JSON.stringify(entry.display)}`;
      const text = partText(sample, entry.part);
      const at = text === null ? -1 : text.indexOf(entry.display, cursor[entry.part]);
      if (text === null || at < 0) { problems.push(`${label}: not on the page (in order)`); continue; }
      cursor[entry.part] = at + entry.display.length;
      covered[entry.part].push({ start: at, end: at + entry.display.length });
      const spec = slots(entry);
      if (typeof spec === "string") { problems.push(`${label}: ${spec}`); continue; }
      if (entry.values.length !== spec.length) { problems.push(`${label}: ${entry.format} needs ${spec.length} values, got ${entry.values.length}`); continue; }
      const expected: (number | string)[] = [];
      for (const [index, item] of spec.entries()) {
        const result = await computed(entry, item.metric, item.arm, sample.id);
        if ("error" in result) { problems.push(`${label}: ${result.error}`); break; }
        let sourceValue = result.value;
        if ((entry.format === "costShareOf" || entry.format === "spendShareOf") && entry.arms?.[0] === "llm" && typeof sourceValue === "number") sourceValue = 1 / sourceValue;
        expected.push(sourceValue);
        if (!sameValue(entry.values[index] ?? NaN, sourceValue, item.metric)) problems.push(`${label}: value ${entry.values[index]} but ${entry.source} gives ${sourceValue}`);
      }
      if (expected.length !== spec.length) continue;
      const shown = render(entry, expected);
      if (!shown.includes(entry.display)) problems.push(`${label}: ${entry.source} gives ${expected.join(", ")}, which ${entry.format} writes as ${JSON.stringify(shown)}`);
    }
    for (const part of PARTS) {
      const text = partText(sample, part);
      if (!text) continue;
      for (const match of [...text.matchAll(NUMBERS), ...text.matchAll(FRACTION_WORDS), ...text.matchAll(WORD_FIGURES)]) {
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

function sampleBy(id: string): Sample {
  const sample = loadSamples().samples.find((item) => item.id === id);
  if (!sample?.explained?.figures) throw new Error(`${id} sample with figures missing`);
  return structuredClone(sample);
}
function change(sample: Sample, part: Part, from: string, to: string): void {
  const original = partText(sample, part);
  if (!original?.includes(from) || !sample.explained) throw new Error(`${sample.id} ${part} has no ${from}`);
  if (part === "verdict") sample.verdictLine = original.replace(from, to);
  else sample.explained[part] = original.replace(from, to);
}
function chosen(sample: Sample, part: Part, display: string): Figure {
  const item = sample.explained?.figures?.find((entry) => entry.part === part && entry.display === display);
  if (!item) throw new Error(`no ${sample.id} ${part} ${display}`);
  return item;
}
function remove(sample: Sample, part: Part, display: string): void {
  const e = sample.explained;
  if (!e?.figures) throw new Error("no figures");
  e.figures = e.figures.filter((entry) => entry.part !== part || entry.display !== display);
}
type Mutation = [string, string, string, (sample: Sample) => void];
const mutations: readonly Mutation[] = [
  ["R1 direction copy", "Stage", "not on the page", (s) => change(s, "why", "no more than about 4 points behind", "no more than about 4 points ahead")],
  ["R2 direction copy and display", "Stage", "pointsBehind writes as", (s) => { change(s, "why", "no more than about 4 points behind", "no more than about 4 points ahead"); chosen(s, "why", "no more than about 4 points behind").display = "no more than about 4 points ahead"; }],
  ["R1b gate's direction copy", "Stage", "not on the page", (s) => change(s, "why", "it is no more than about 4 points behind", "it is still about 4 points ahead")],
  ["R22 bound qualifier flipped", "Stage", "pointsBehind writes as", (s) => { const from = "no more than about 4 points behind"; const to = "at least about 4 points behind"; change(s, "why", from, to); chosen(s, "why", from).display = to; }],
  ["R3 reversed cost arms", "Stage", "costShareOf writes as", (s) => { const from = "cost Jev about a fifth of what it cost the LLM"; const to = "cost the LLM about a fifth of what it cost Jev"; change(s, "why", from, to); Object.assign(chosen(s, "why", from), { display: to, arms: ["llm", "jev"] }); }],
  ["R4 uc13 reversed cost copy", "uc13", "not on the page", (s) => change(s, "why", "at about a fifth of the cost per kept answer", "while the LLM costs about a fifth of Jev per kept answer")],
  ["R5 uc13 reversed cost display", "uc13", "costShare writes as", (s) => { const from = "at about a fifth of the cost per kept answer"; const to = "while the LLM costs about a fifth of Jev per kept answer"; change(s, "why", from, to); chosen(s, "why", from).display = to; }],
  ["R6 twelve points", "Stage", "undeclared figure \"twelve\"", (s) => { if (s.explained) s.explained.why += " and twelve points ahead at best"; }],
  ["R7 half cost", "uc13", "undeclared figure \"half\"", (s) => { change(s, "why", "about a fifth", "half"); remove(s, "why", "at about a fifth of the cost per kept answer"); }],
  ["R8 five times cheaper", "uc13", "undeclared figure \"five\"", (s) => { change(s, "why", "at about a fifth of the cost per kept answer", "five times cheaper"); remove(s, "why", "at about a fifth of the cost per kept answer"); }],
  ["R9 twice", "Stage", "undeclared figure \"twice\"", (s) => { if (s.explained) s.explained.next += " twice"; }],
  ["R10 double", "Stage", "undeclared figure \"double\"", (s) => { if (s.explained) s.explained.next += " double"; }],
  ["R11 fifty percent", "Stage", "undeclared figure \"fifty\"", (s) => { if (s.explained) s.explained.next += " fifty percent"; }],
  ["R12 one hundred", "Stage", "undeclared figure \"one hundred\"", (s) => { if (s.explained) s.explained.next += " one hundred"; }],
  ["R13 Stage backward arms", "Stage", "not on the page", (s) => { if (s.explained) s.explained.cases = "Jev beat it: 88 of 100 for the LLM (Claude Haiku 5.5), 86 of 100 for Jev, the simple rule 49 of 100."; }],
  ["R14 uc13 backward arms", "uc13", "not on the page", (s) => { if (s.explained) s.explained.cases = "Jev beat it: 88 for the LLM (Haiku 5.5), 86 for Jev; simple rule 49, of 100."; }],
  ["R15 reversed kept arms", "Stage", "value 88 but", (s) => { const from = "Jev kept as many right answers as the LLM (88 against 86)"; const to = "the LLM kept as many right answers as Jev (88 against 86)"; change(s, "why", from, to); Object.assign(chosen(s, "why", from), { display: to, arms: ["llm", "jev"] }); }],
  ["R16 backward single arm", "Stage", "armScore writes as", (s) => { const from = "Jev 88 of 100"; const to = "88 of 100 for the LLM"; change(s, "cases", from, to); Object.assign(chosen(s, "cases", from), { display: to, arm: "llm", values: [88, 100] }); }],
  ["R17 cross sample doc", "Stage", "does not match sample Stage", (s) => { if (!s.explained?.figures) return; s.explained.next += " Score it 0 / 1 / 2."; s.explained.figures.push({ part: "next", display: "0 / 1 / 2", format: "answers", values: ["0 / 1 / 2"], source: "docs/product/use-cases/uc9-website-slop-roast.md", row: "S6" }); }],
  ["R18 wrong answer row", "uc9", "value 0 / 1 / 2 but", (s) => { chosen(s, "rephrase", "0 / 1 / 2").row = "S1"; }],
  ["R19 fractional integer", "Stage", "value 88.00000001 but", (s) => { chosen(s, "cases", "Jev 88 of 100").values = [88.00000001, 100]; }],
  ["R20 stale exemption", "uc9", "prose exception not on page", (s) => change(s, "rephrase", "Ask one check", "Ask a check")],
  ["R21 word beside exemption", "uc9", "undeclared figure \"three\"", (s) => change(s, "rephrase", "Ask one check at a time", "Ask one check at a time, three times")],
  ["ported arm swap without arms", "Stage", "requires one declared arm", (s) => { const f = chosen(s, "cases", "Jev 88 of 100"); delete f.arm; }],
  ["ported arm swap with declared arms", "Stage", "value 88 but", (s) => { chosen(s, "cases", "Jev 88 of 100").arm = "llm"; }],
  ["ported 88 against 83", "Stage", "value 83 but", (s) => { const from = "Jev kept as many right answers as the LLM (88 against 86)"; const to = from.replace("86)", "83)"); change(s, "why", from, to); Object.assign(chosen(s, "why", from), { display: to, values: [88, 83] }); }],
  ["ported 88 against 9", "Stage", "value 9 but", (s) => { const from = "Jev kept as many right answers as the LLM (88 against 86)"; const to = from.replace("86)", "9)"); change(s, "why", from, to); Object.assign(chosen(s, "why", from), { display: to, values: [88, 9] }); }],
  ["ported cost ratio as points", "Stage", "cannot name a metric", (s) => { const f = chosen(s, "why", "no more than about 4 points behind"); f.metric = "costRatio"; }],
  ["ported positive point estimate", "Stage", "value 0.02 but", (s) => { const from = "no more than about 4 points behind"; const to = "at least about 2 points ahead"; change(s, "why", from, to); Object.assign(chosen(s, "why", from), { display: to, values: [0.02] }); }],
  ["ported 49 of 300", "Stage", "value 300 but", (s) => { const from = "the simple rule 49 of 100"; const to = "the simple rule 49 of 300"; change(s, "cases", from, to); Object.assign(chosen(s, "cases", from), { display: to, values: [49, 300] }); }],
  ["ported quarter for fifth", "Stage", "value 0.25 but", (s) => { const from = "cost Jev about a fifth of what it cost the LLM"; const to = "cost Jev about a quarter of what it cost the LLM"; change(s, "why", from, to); Object.assign(chosen(s, "why", from), { display: to, values: [0.25] }); }],
  ["ported wrong spend rounding", "Stage", "armSpent4 writes as", (s) => { const from = "Jev spent $0.0033"; const to = "Jev spent $0.0032"; change(s, "cases", from, to); chosen(s, "cases", from).display = to; }],
  ["ported tied 37", "Stage", "value 37 but", (s) => { const from = "Jev and the LLM tied, 38 each"; const to = "Jev and the LLM tied, 37 each"; change(s, "earlier", from, to); Object.assign(chosen(s, "earlier", from), { display: to, values: [37] }); }],
  ["ported undeclared digit", "Stage", "undeclared figure \"7\"", (s) => { if (s.explained) s.explained.next += " About 7 more would settle it."; }],
  ["ported undeclared fraction", "Stage", "undeclared figure \"a third\"", (s) => { if (s.explained) s.explained.next += " Or a third of them."; }],
  ["ported source is page", "Stage", "comes from a run's records.csv", (s) => { chosen(s, "earlier", "Jev about 1/79th of the LLM").source = "site/little-shop/index.html"; }],
];
for (const [name, id, expected, mutate] of mutations) test(`[unit] #201-3 mutation: ${name}`, async () => {
  const sample = sampleBy(id);
  expect(await checkFigures([sample])).toEqual([]);
  mutate(sample);
  const problems = await checkFigures([sample]);
  expect(problems.some((problem) => problem.includes(expected))).toBe(true);
});
test("[unit] #201-3 control: added valid arm score", async () => {
  const stage = sampleBy("Stage");
  if (!stage.explained?.figures) throw new Error("Stage figures missing");
  stage.explained.next += " Jev 88 of 100.";
  stage.explained.figures.push({ part: "next", display: "Jev 88 of 100", format: "armScore", arm: "jev", values: [88, 100], source: RECORDS });
  expect(await checkFigures([stage])).toEqual([]);
});
test("[unit] #201-3 each named format renders its whole claim", () => {
  const cases: { format: Format; values: (number | string)[]; expected: string[]; arm?: FigureArm; arms?: [FigureArm, FigureArm] }[] = [
    { format: "pointsBehind", values: [-0.04266031343755382], expected: ["no more than about 4 points behind"] },
    { format: "pointsBehind", values: [0.02], expected: ["at least about 2 points ahead"] },
    { format: "pointsBehind", values: [-0.0427], expected: ["no more than about 4 points behind"] },
    { format: "pointsBehind", values: [0.001], expected: [] },
    { format: "pointsBehind", values: [9], expected: [] },
    { format: "pointLimit", values: [0.1], expected: ["10-point"] },
    { format: "costShare", values: [0.19745918526106973], arms: ["jev", "llm"], expected: ["at about a fifth of the cost per kept answer"] },
    { format: "costShareOf", values: [0.19745918526106973], arms: ["jev", "llm"], expected: ["cost Jev about a fifth of what it cost the LLM", "cost Jev about a fifth of what it cost LLM"] },
    { format: "costShareOf", values: [1 / 0.19745918526106973], arms: ["llm", "jev"], expected: [] },
    { format: "spendShareOf", values: [79.25193584070799], arms: ["jev", "llm"], expected: ["Jev about 1/79th of the LLM", "Jev about 1/79th of LLM"] },
    { format: "spendShareOf", values: [0.5], arms: ["jev", "llm"], expected: [] },
    { format: "armSpent4", values: [0.00328442], arm: "jev", expected: ["Jev spent $0.0033"] },
    { format: "armSpent5", values: [0.000080682], arm: "jev", expected: ["Jev spent $0.00008"] },
    { format: "int", values: [88], expected: ["88"] },
    { format: "int", values: [88.5], expected: [] },
    { format: "tiedEach", values: [38], arms: ["jev", "llm"], expected: ["Jev and the LLM tied, 38 each", "Jev and LLM tied, 38 each"] },
    { format: "tiedTo", values: [38], expected: ["tied 38 to 38"] },
    { format: "messageRun", values: [100], expected: ["100-message"] },
    { format: "rule", values: [3], expected: ["rule 3"] },
    { format: "modelWas", values: ["claude-haiku-5-5"], arm: "llm", expected: ["the LLM was Haiku 5.5", "LLM was Haiku 5.5"] },
    { format: "modelWas", values: ["claude-haiku-4-5-20251001"], arm: "llm", expected: ["the LLM was Haiku 4.5", "LLM was Haiku 4.5"] },
    { format: "modelWas", values: ["gpt-6-sol"], arm: "llm", expected: [] },
  ];
  for (const item of cases) {
    const entry: Figure = { part: "why", display: "", format: item.format, values: item.values, source: RECORDS,
      ...(item.arm ? { arm: item.arm } : {}), ...(item.arms ? { arms: item.arms } : {}) };
    expect(render(entry, item.values)).toEqual(item.expected);
  }
});
test("[unit] #201-3 mutation: wrong question or unnamed cohort", async () => {
  const good = sampleBy("uc11");
  expect(await checkFigures([good])).toEqual([]);
  const wrong = sampleBy("uc11");
  chosen(wrong, "cases", "the simple rule 2 of 5").question = "q2";
  expect((await checkFigures([wrong])).some((problem) => problem.includes("value 2 but") && problem.includes("gives 4"))).toBe(true);
  const unnamed = sampleBy("uc11");
  delete chosen(unnamed, "cases", "the simple rule 2 of 5").question;
  expect((await checkFigures([unnamed])).some((problem) => problem.includes("2 labelled cohorts"))).toBe(true);
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
