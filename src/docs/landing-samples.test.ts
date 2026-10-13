import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { MIN_PAIRED } from "../core/verdict.ts";
import { truthLabel, validate } from "../format/validate.ts";
import { resolveChromium } from "../../scripts/uat/happy-path-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SITE = resolve(process.env.LANDING_TEST_SITE ?? join(ROOT, "site"));
const IDS = ["uc9", "uc10", "uc11", "uc12", "uc13"];
const NOT_FIT = ["uc9", "uc10", "uc11"];
const LABELS = "docs/product/runs/2026-10-11-uc13-shop-bot-100/LABELS.md";
const RECORDS = "docs/product/runs/2026-10-11-uc13-shop-bot-100/records.csv";
// A number starts at a word boundary: digits glued to letters ("P2", "m40") are identifiers, not figures.
const NUMBERS = /\b\d+(?:\.\d+)?/g;
const FACTS = ["accepted:jev", "accepted:llm", "accepted:rule", "labelled:jev", "labelled:llm", "labelled:rule", "spend:jev", "spend:llm", "spend:rule", "toMinimum"];
const BARE = /^(?:Verdict:\s*)?(?:use Jev|don't use Jev|not enough evidence|not proven yet|not enough proof yet|Jev probably not|Jev could help|not Jev|!Jev|split two ways|needs a test)(?:\s*\([^)]*\))?\.?$/i;

type Fact = "accepted:jev" | "accepted:llm" | "accepted:rule" | "labelled:jev" | "labelled:llm" | "labelled:rule" | "spend:jev" | "spend:llm" | "spend:rule" | "toMinimum";
// A fact may name one question_id: a run file can hold several questions, and a card describes one of them.
type Figure = { text: string; file: string; quote: string } | { text: string; file: string; fact: Fact; question?: string };
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
function figure(value: unknown): value is Figure {
  return record(value) && typeof value.text === "string" && typeof value.file === "string" &&
    ((typeof value.quote === "string" && value.fact === undefined) ||
      (typeof value.fact === "string" && FACTS.includes(value.fact) && value.quote === undefined &&
        (value.question === undefined || typeof value.question === "string")));
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
function collapsed(text: string): string { return text.replace(/\s+/g, " ").trim(); }
function decimalPlaces(text: string): number { return text.split(".")[1]?.length ?? 0; }
function roundedMatch(display: string, actual: number): boolean {
  const shown = Math.abs(Number(display));
  const abs = Math.abs(actual);
  const factor = 10 ** decimalPlaces(display);
  return Number.isFinite(shown) && (Math.abs(shown - abs) < 1e-10 || Math.round((abs + Number.EPSILON) * factor) / factor === shown);
}
function numberMatches(display: string, actual: number, points: boolean): boolean {
  // A figure in points ("4 points", "10-point limit") is backed only by a share under 1 read x100 (0.043 as 4), never
  // by a whole number that happens to be equal ("d 9" for "9 points").
  if (points) return Math.abs(actual) < 1 && Math.round(Math.abs(actual) * 100) === Math.abs(Number(display));
  return roundedMatch(display, actual);
}
/**
 * The figure's numbers match the quote's numbers in order, so "86 against 88" cannot cite "88 ... 86". When the figure
 * names an arm (Jev, the LLM, the simple rule) the quote must be exactly its evidence: the numbers pair one to one, so
 * a long line cannot lend the LLM's "86" to a figure that says "Jev 86". A version in the figure ("5.5") reads "5-5" in
 * the quote as one number. Points need "point" in the figure text, and then only a decimal under 1 counts as points.
 */
function quoteSupports(text: string, quote: string, exact: boolean): string[] {
  const shown = [...text.matchAll(NUMBERS)].map((match) => match[0]);
  let evidence = quote;
  for (const display of shown) if (/^\d+\.\d+$/.test(display)) evidence = evidence.replace(new RegExp(`\\b${display.replace(".", "-")}\\b`, "g"), display);
  const quoted = [...evidence.matchAll(NUMBERS)].map((match) => Number(match[0]));
  const points = /\bpoints?\b/i.test(text);
  if (exact && quoted.length !== shown.length) return [`${shown.join(" ") || "none"} (an arm figure needs a quote with exactly its ${shown.length} numbers, this one has ${quoted.length})`];
  const unsupported: string[] = [];
  let next = 0;
  for (const display of shown) {
    const at = quoted.findIndex((actual, index) => index >= next && numberMatches(display, actual, points));
    if (at < 0) unsupported.push(display);
    else next = at + 1;
  }
  return unsupported;
}
const ARM_WORDS: [string, RegExp][] = [["jev", /\bJev\b/], ["llm", /\bLLM\b/], ["rule", /\bsimple rule\b/i]];
function armsNamed(text: string): string[] {
  return ARM_WORDS.filter(([, pattern]) => pattern.test(text)).map(([arm]) => arm);
}
function factValue(fact: Fact, csv: string, question: string | undefined): { value: number | null; error: string | null } {
  const parsed = validate(csv);
  if (parsed.errors.length) return { value: null, error: `invalid records.csv: ${parsed.errors[0]}` };
  const labelled = parsed.rows.map((row) => row.values)
    .filter((values) => truthLabel(values) !== null && (question === undefined || values.get("question_id") === question));
  if (question !== undefined && labelled.length === 0) return { value: null, error: `no labelled rows for question ${question}` };
  if (fact === "toMinimum") {
    const paired = new Map<string, Set<string>>();
    for (const values of labelled) {
      const id = values.get("case_id"), arm = values.get("answerer");
      if (typeof id === "string" && typeof arm === "string") {
        const arms = paired.get(id) ?? new Set<string>();
        arms.add(arm);
        paired.set(id, arms);
      }
    }
    return { value: MIN_PAIRED - [...paired.values()].filter((arms) => arms.has("jev") && arms.has("llm")).length, error: null };
  }
  const [kind, arm] = fact.split(":");
  const rows = labelled.filter((values) => values.get("answerer") === arm);
  if (kind === "labelled") return { value: rows.length, error: null };
  if (kind === "accepted") return { value: rows.filter((values) => truthLabel(values) === "accept").length, error: null };
  if (rows.some((values) => typeof values.get("cost_usd") !== "number")) return { value: null, error: "labelled row has no numeric cost_usd" };
  return { value: rows.reduce((sum, values) => sum + Number(values.get("cost_usd")), 0), error: null };
}
function checkFigures(samples: Sample[]): string[] {
  const problems: string[] = [];
  for (const sample of samples) {
    const copy = copyParts(sample).join(" ");
    const figures = sample.explained?.figures;
    if (!copy) problems.push(`${sample.id}: no sample copy`);
    if ((sample.runBacked || /\d/.test(copy)) && (!figures || figures.length === 0)) problems.push(`${sample.id}: no figures for run or numbered copy`);
    if (!figures) continue;
    // Each number position in the copy must be verified by a figure: a quote figure verifies every number in its text,
    // a fact figure only its last number. A figure's text must occur exactly once, so it binds one place in the copy.
    const verified = new Set<number>();
    for (const entry of figures) {
      if (!entry.text.trim()) { problems.push(`${sample.id}: figure text empty`); continue; }
      const at = copy.indexOf(entry.text);
      if (at < 0) { problems.push(`${sample.id}: figure text ${JSON.stringify(entry.text)} absent from copy`); continue; }
      if (copy.indexOf(entry.text, at + 1) >= 0) { problems.push(`${sample.id}: figure text ${JSON.stringify(entry.text)} occurs more than once`); continue; }
      const numbers = [...entry.text.matchAll(NUMBERS)];
      const full = resolve(ROOT, entry.file);
      const rel = relative(ROOT, full);
      if (isAbsolute(entry.file) || rel === ".." || rel.startsWith(`..${sep}`) || rel === "site/shows/posters.json" || rel === "site/data.js") {
        problems.push(`${sample.id}: invalid figure source ${entry.file}`); continue;
      }
      if (!existsSync(full)) { problems.push(`${sample.id}: figure source missing ${entry.file}`); continue; }
      const source = readFileSync(full, "utf8");
      if ("quote" in entry) {
        if (!entry.quote.trim() || !collapsed(source).includes(collapsed(entry.quote))) { problems.push(`${sample.id}: quote absent from ${entry.file}`); continue; }
        const unsupported = quoteSupports(entry.text, entry.quote, armsNamed(entry.text).length > 0);
        for (const number of unsupported) problems.push(`${sample.id}: figure number ${number} unsupported by quote in ${entry.file}`);
        const foreign = armsNamed(entry.text).filter((arm) => !armsNamed(entry.quote).includes(arm));
        if (foreign.length) problems.push(`${sample.id}: figure ${JSON.stringify(entry.text)} names ${foreign.join(", ")}, its quote does not`);
        if (unsupported.length === 0 && foreign.length === 0) for (const number of numbers) if (number.index !== undefined) verified.add(at + number.index);
      } else {
        if (!entry.file.endsWith("/records.csv")) { problems.push(`${sample.id}: fact source is not records.csv: ${entry.file}`); continue; }
        const last = numbers.at(-1);
        if (!last || last.index === undefined) { problems.push(`${sample.id}: fact figure holds no number: ${entry.text}`); continue; }
        const arm = entry.fact.includes(":") ? entry.fact.split(":")[1] ?? "" : "";
        const named = armsNamed(entry.text);
        if (named.join(",") !== arm) { problems.push(`${sample.id}: fact ${entry.fact} figure ${JSON.stringify(entry.text)} names ${named.join(", ") || "no arm"}`); continue; }
        const measured = factValue(entry.fact, source, entry.question);
        if (measured.error) problems.push(`${sample.id}: ${measured.error}`);
        else if (measured.value === null || !roundedMatch(last[0], measured.value)) problems.push(`${sample.id}: fact ${entry.fact} does not support ${entry.text}`);
        else verified.add(at + last.index);
      }
    }
    for (const match of copy.matchAll(NUMBERS)) {
      if (match.index === undefined || !verified.has(match.index)) problems.push(`${sample.id}: undeclared number ${match[0]}`);
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
function figureFixture(): Sample[] {
  return [
    { id: "uc13", fit: [], runBacked: true, verdictLine: "Use Jev", explained: {
      why: "The rule is met.", cases: "Jev accepted 88", next: "Review the result.", rephrase: null, earlier: null,
      figures: [{ text: "Jev accepted 88", file: LABELS, quote: "Jev accepted 88" }],
    } },
    { id: "uc11", fit: ["Jev probably not"], runBacked: true, verdictLine: "Jev probably not", explained: {
      why: "The present question needs review.", cases: "Jev accepted 88", next: "Rewrite the question.", rephrase: null, earlier: null,
      figures: [{ text: "Jev accepted 88", file: RECORDS, fact: "accepted:jev" }],
    } },
  ];
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
test("[unit] #201-3 every number in the sample copy appears in the file it cites", () => {
  const loaded = loadSamples();
  requireClean([...loaded.problems, ...checkFigures(loaded.samples)]);
});
test("[unit] #201-3 mutation: invented uc13 and uc11 numbers and unsupported quote", () => {
  const samples = structuredClone(figureFixture());
  const uc13 = samples.find((sample) => sample.id === "uc13");
  const uc11 = samples.find((sample) => sample.id === "uc11");
  if (!uc13?.explained || !uc11?.explained) throw new Error("fixture incomplete");
  expect(checkFigures(samples)).toEqual([]);
  uc13.explained.cases = "Jev accepted 89";
  uc11.explained.next = "Rewrite the question; about 7 more cases.";
  const problems = checkFigures(samples);
  expect(problems.some((problem) => problem.includes("uc13: undeclared number 89"))).toBe(true);
  expect(problems.some((problem) => problem.includes("uc11: undeclared number 7"))).toBe(true);
  const unquoted = structuredClone(figureFixture());
  const quote = unquoted[0]?.explained?.figures?.[0];
  if (!quote || !("quote" in quote)) throw new Error("quote fixture incomplete");
  quote.quote = "This sentence does not occur in the source.";
  expect(checkFigures(unquoted).some((problem) => problem.includes("uc13: quote absent"))).toBe(true);
});
test("[unit] #201-3 mutation: a fact counted over the wrong question or every question", () => {
  const tokenmax = "docs/product/runs/2026-10-03-tokenmax/records.csv";
  const samples: Sample[] = [{ id: "uc11", fit: [], runBacked: true, verdictLine: "Needs a test", explained: {
    why: "The rule is unmet.", cases: "the simple rule 2 of 5", next: "Label more cases.", rephrase: null, earlier: null,
    figures: [{ text: "simple rule 2", file: tokenmax, fact: "accepted:rule", question: "q1" }, { text: "simple rule 2 of 5", file: tokenmax, fact: "labelled:rule", question: "q1" }],
  } }];
  expect(checkFigures(samples)).toEqual([]);
  const wrong = structuredClone(samples);
  const wrongFigure = wrong[0]?.explained?.figures?.[0];
  if (!wrongFigure || !("fact" in wrongFigure)) throw new Error("fact fixture incomplete");
  wrongFigure.question = "q2";
  expect(checkFigures(wrong).some((problem) => problem.includes("fact accepted:rule does not support simple rule 2"))).toBe(true);
  const every = structuredClone(samples);
  const everyFigure = every[0]?.explained?.figures?.[0];
  if (!everyFigure || !("fact" in everyFigure)) throw new Error("fact fixture incomplete");
  delete everyFigure.question;
  expect(checkFigures(every).some((problem) => problem.includes("fact accepted:rule does not support simple rule 2"))).toBe(true);
});
test("[unit] #201-3 mutation: swapped arms, swapped order, lent numbers and points", () => {
  const sample = (cases: string, figures: Figure[]): Sample[] => [{ id: "uc13", fit: [], runBacked: true, verdictLine: "Needs a test", explained: {
    why: "The rule is met.", cases, next: "Review the result.", rephrase: null, earlier: null, figures } }];
  const pair = "Jev accepted 88 of 100, the LLM 86 of 100";
  const good = sample("Jev 88, LLM 86 (88 against 86), cost 0.197", [
    { text: "Jev 88", file: RECORDS, fact: "accepted:jev" }, { text: "LLM 86", file: RECORDS, fact: "accepted:llm" },
    { text: "(88 against 86)", file: LABELS, quote: pair }, { text: "cost 0.197", file: LABELS, quote: "Jev costs 0.197 of the LLM" },
  ]);
  expect(checkFigures(good)).toEqual([]);
  const swapped = sample("Jev 86, LLM 88", [{ text: "Jev 86", file: RECORDS, fact: "accepted:jev" }, { text: "LLM 88", file: RECORDS, fact: "accepted:llm" }]);
  expect(checkFigures(swapped).some((problem) => problem.includes("fact accepted:jev does not support Jev 86"))).toBe(true);
  const relabelled = sample("Jev 86", [{ text: "Jev 86", file: RECORDS, fact: "accepted:llm" }]);
  expect(checkFigures(relabelled).some((problem) => problem.includes("fact accepted:llm figure \"Jev 86\" names jev"))).toBe(true);
  const reversed = sample("(86 against 88)", [{ text: "(86 against 88)", file: LABELS, quote: pair }]);
  expect(checkFigures(reversed).some((problem) => problem.includes("figure number 88 unsupported"))).toBe(true);
  const wrongQuoteArm = sample("Jev 86", [{ text: "Jev 86", file: LABELS, quote: "the LLM 86 of 100" }]);
  expect(checkFigures(wrongQuoteArm).some((problem) => problem.includes("names jev, its quote does not"))).toBe(true);
  const asPoints = sample("about 20 percent", [{ text: "about 20 percent", file: LABELS, quote: "Jev costs 0.197 of the LLM" }]);
  expect(checkFigures(asPoints).some((problem) => problem.includes("figure number 20 unsupported"))).toBe(true);
  const lentNumber = sample("Jev 86 of 100", [{ text: "Jev 86 of 100", file: LABELS, quote: pair }]);
  expect(checkFigures(lentNumber).some((problem) => problem.includes("an arm figure needs a quote with exactly its 2 numbers"))).toBe(true);
  const ownQuote = sample("Jev 88 of 100", [{ text: "Jev 88 of 100", file: LABELS, quote: "Jev accepted 88 of 100" }]);
  expect(checkFigures(ownQuote)).toEqual([]);
  const wholeAsPoints = sample("about 9 points behind", [{ text: "9 points", file: LABELS, quote: "a 83, b 5, c 3, d 9" }]);
  expect(checkFigures(wholeAsPoints).some((problem) => problem.includes("figure number 9 unsupported"))).toBe(true);
  const decimalAsPoints = sample("about 4 points behind", [{ text: "4 points", file: LABELS, quote: "lower bound -0.043" }]);
  expect(checkFigures(decimalAsPoints)).toEqual([]);
  const twice = sample("Jev 88 and Jev 88", [{ text: "Jev 88", file: RECORDS, fact: "accepted:jev" }]);
  expect(checkFigures(twice).some((problem) => problem.includes("occurs more than once"))).toBe(true);
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
