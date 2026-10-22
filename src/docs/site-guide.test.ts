// The in-product first-use guide (D18): site/guide/index.html, served at /guide/.
// Done when a new tester can follow it through the sample run without asking what a field means, so:
// - every field label and column header the sample run (site/index.html) and Backstage (site/backstage/index.html,
//   src/backstage/main.ts, src/backstage/run-gate.ts, site/backstage/sample-cases.csv) show has a glossary entry;
// - the six sections are present in order;
// - every marked figure in the whole guide equals the code constant or the sample-run value it names, and any number
//   outside a validated mark must be one of a short, explicit list of unrelated phrases.
// HTML is read with Bun's HTMLRewriter, so text is the rendered text of an element, nested markup included. The
// sample run's table headers live in HTML strings inside the page script: those strings are joined and parsed the
// same way. Each check has a negative test that applies a known mutation and must go RED.
// Dash glyphs in site/ are already gated by scripts/site-content.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { CATALOG_CHECKED_DATE, MODEL_CATALOG } from "../backstage/catalog.ts";
import { KEY_FIELD_NAMES } from "../backstage/run-gate.ts";
import { MAX_FILE_BYTES } from "../browser/results-loader.ts";
import { RESAMPLES } from "../core/calc.ts";
import { CHEAPER, MARGIN, MIN_PAIRED } from "../core/verdict.ts";
import { COLUMNS_V1_2, SUGGESTION_COLUMNS } from "../format/validate.ts";
import { JEV_PIN } from "../jev-answer.ts";
import { parseArgs, RANGES } from "../../skills/tokenmax-map/scripts/map.ts";

const ROOT = join(import.meta.dir, "..", "..");
const GUIDE = "site/guide/index.html";
const STAGE = "site/index.html";
const OFFICE = "site/shows/office.js";
const POSTERS = "site/shows/posters.json";
const BACKSTAGE = "site/backstage/index.html";
const SAMPLE_RECORDS = "docs/product/runs/2026-10-11-uc13-shop-bot-100/records.csv";

test("[unit] TokenMax guide states the default and selectable map window", async () => {
  const paragraphs = await texts(read(GUIDE), "#tokenmax p");
  expect(paragraphs.some((text) => text.includes("7 days by default") && text.includes("--days N for a longer window (up to 90 days for a shared map)"))).toBe(true);
  expect(parseArgs(["--claude", "none", "--codex", "none"], { home: "/missing", now: Date.parse("2026-10-20T12:00:00Z"), cwd: "/tmp" }).days).toBe(7);
  expect(parseArgs(["--claude", "none", "--codex", "none", "--days", "91"], { home: "/missing", now: Date.parse("2026-10-20T12:00:00Z"), cwd: "/tmp" }).days).toBe(91);
  expect(RANGES.find(([name]) => name === "days")).toEqual(["days", 1, 90]);
});

test("[unit] TokenMax guide lists the /tm/ steps with labels the page and script really show", async () => {
  const steps = await texts(read(GUIDE), "#tokenmax ol.tokenmax-steps > li");
  expect(steps).toHaveLength(6);
  const tm = clean(read("site/tm/index.html"));
  const run = read("src/browser/tm-run.ts");
  const labels = ["Show Sample", "Play my week", "Copy for Claude Code or Codex", "Paste the result here", "Show my week", "Nickname for the public board", "Submit", "See the shared maps", "Replay", "Skip to the end"];
  for (const label of labels) {
    expect(tm).toContain(label);
    expect(steps.some((step) => step.includes(label))).toBe(true);
  }
  expect(tm).toContain("3 to 24 lowercase letters, digits or hyphens");
  expect(steps[4]).toContain("3 to 24 lowercase letters, digits or hyphens");
  expect(tm).toContain("TOKENMAX WEEK");
  expect(run).toContain('"Board: /maps/"');
  expect(run).toContain("Your map id:");
  expect(run).toContain("Your key:");
  expect(run).toContain('"remove my entry"');
  expect(steps[4]).toContain("remove my entry");
  expect(steps[5]).toContain("newest first");
  expect(read("site/maps/index.html")).toContain("Newest first, self-reported, not verified");
  expect(await texts(read(GUIDE), "#tokenmax a[href='/replay/?run=uc13-100']")).toHaveLength(1);
  expect((await texts(read(GUIDE), "#tokenmax p")).some((text) => text.includes("you review the fields before pressing Share"))).toBe(true);
});

function read(path: string): string {
  if (path === GUIDE && process.env.SITE_GUIDE_TEST_GUIDE) return readFileSync(process.env.SITE_GUIDE_TEST_GUIDE, "utf8");
  if (path.startsWith("site/") && process.env.LANDING_TEST_SITE) return readFileSync(join(process.env.LANDING_TEST_SITE, path.slice(5)), "utf8");
  return readFileSync(join(ROOT, path), "utf8");
}

/** Rendered text: the entities this site uses decoded, whitespace collapsed. */
function clean(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- HTML reading (HTMLRewriter) ----------

interface Grabbed {
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly text: string;
}

/**
 * Every element matching each selector, in document order, with its rendered text (all descendant text, so
 * `<span><b>x</b></span>` reads "x"). One document-level text handler feeds every open element, so nested matches
 * never double-count.
 */
async function grab(html: string, selectors: readonly string[]): Promise<Map<string, Grabbed[]>> {
  const found = new Map<string, Grabbed[]>();
  const open: string[][] = [];
  let rewriter = new HTMLRewriter();
  for (const selector of selectors) {
    const list: Grabbed[] = [];
    found.set(selector, list);
    rewriter = rewriter.on(selector, {
      element(el) {
        const at = list.length;
        const tag = el.tagName;
        const attrs = new Map<string, string>([...el.attributes]);
        list.push({ tag, attrs, text: "" });
        if (!el.canHaveContent || el.selfClosing) return;
        const buffer: string[] = [];
        open.push(buffer);
        el.onEndTag(() => {
          open.splice(open.indexOf(buffer), 1);
          list[at] = { tag, attrs, text: clean(buffer.join("")) };
        });
      },
    });
  }
  rewriter = rewriter.onDocument({
    text(chunk) {
      for (const buffer of open) buffer.push(chunk.text);
    },
  });
  await rewriter.transform(new Response(html)).text();
  return found;
}

async function texts(html: string, selector: string): Promise<string[]> {
  return ((await grab(html, [selector])).get(selector) ?? []).map((g) => g.text);
}

/** The HTML the page script builds: its single-quoted string literals joined, expressions dropped. */
function scriptMarkup(html: string, marker: string): string {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").find((s) => s.includes(marker));
  if (script === undefined) throw new Error(`no inline script with ${marker}`);
  const code = script.replace(/\/\*[\s\S]*?\*\//g, " ");
  return [...code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => (m[1] ?? "").replace(/\\(.)/g, "$1")).join("");
}

function capture(pattern: RegExp, text: string): string {
  const found = pattern.exec(text)?.[1];
  if (found === undefined) throw new Error(`not found: ${pattern}`);
  return found;
}

/** The string values of a `var NAME = { k: "v", ... }` object in the page script (JS values, not markup). */
function objectValues(html: string, name: string): string[] {
  return [...capture(new RegExp(`var ${name} = \\{([^}]*)\\}`), html).matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
}

interface Field {
  readonly term: string;
  readonly source: string;
}

/** Every extractor must find something, so a refactor of the page cannot empty the check and still pass. */
function fields(source: string, name: string, terms: readonly string[]): Field[] {
  const kept = terms.filter((term) => term !== "");
  if (kept.length === 0) throw new Error(`${name}: no fields extracted from ${source}`);
  return kept.map((term) => ({ term, source }));
}

/** Labels and headers the sample run shows, from site/index.html's markup. The four acts are retired: their table headers, ledger and timing labels are no longer on the page. */
async function sampleRunFields(html: string): Promise<Field[]> {
  const src = STAGE;
  const page = await grab(html, ["#t6", "section.samples h2", "#officeOpen"]);
  const stamps = [...read(OFFICE).matchAll(/\bname: "([^"]+)"/g)].map((match) => match[1] ?? "");
  const list = (map: Map<string, Grabbed[]>, selector: string): string[] => (map.get(selector) ?? []).map((x) => x.text);
  return [
    ...fields(src, "sample cards", list(page, "section.samples h2")),
    ...fields(OFFICE, "poster stamps", stamps),
    ...fields(src, "landing actions", list(page, "#officeOpen")),
    ...fields(src, "own file", list(page, "#t6")),
    ...fields(OFFICE, "card and ticket controls", ["Why this verdict", "Why:", "What the cases show:", "Next step:", "Rephrased for Jev:", "Earlier run:", "Get another ticket"]),
  ];
}

/** Labels, rooms, buttons and table headers a tester sees in Backstage. */
async function backstageFields(html: string): Promise<Field[]> {
  const page = BACKSTAGE;
  const g = await grab(html, ["nav#rooms button", "main label", "#pick-actions button", "#download-csv", "#download-evidence", "#label-column-note"]);
  const list = (selector: string): string[] => (g.get(selector) ?? []).map((x) => x.text);
  const names = list("nav#rooms button").map((name) => name.replace(/^\d+\s*/, ""));
  const note = list("#label-column-note")[0] ?? "";
  const labelColumns = [capture(/add a (\w+) column/, note), ...capture(/then ([\w, ]+?)\./, note).split(/, | and /)];
  const script = "src/backstage/main.ts";
  const ts = read(script);
  const csv = "site/backstage/sample-cases.csv";
  return [
    ...fields(page, "rooms", names),
    ...fields(page, "form labels", list("main label").map((label) => label.replace(/\(optional\)/, "").trim())),
    ...fields(page, "pick buttons", list("#pick-actions button")),
    ...fields(page, "downloads", [...list("#download-csv"), ...list("#download-evidence")]),
    ...fields(page, "label columns", labelColumns),
    ...fields(csv, "cases file header", (read(csv).split("\n")[0] ?? "").split(",")),
    // TypeScript arrays and string literals, not markup: read as source.
    ...fields(script, "tables", [...ts.matchAll(/table\(\s*\[([^\]]*)\]/g)].flatMap((m) => [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((s) => s[1] ?? ""))),
    // Casting renders one key field per provider at runtime (main.ts appends KEY_FIELD_NAMES[provider] as its label).
    ...fields("src/backstage/run-gate.ts", "provider key fields", Object.values(KEY_FIELD_NAMES)),
    ...fields(script, "results lines", [
      capture(/"(Total actual attempts):/, ts),
      capture(/" (paired labelled cases);/, ts),
      ...[...ts.matchAll(/"[^"]*?((?:Jev|other)-only wins) "/g)].map((m) => m[1] ?? ""),
      capture(/"(Per-pair, uncorrected comparison)\./, ts),
    ]),
  ];
}

async function glossary(html: string): Promise<Map<string, string>> {
  const g = await grab(html, ["#glossary > dt", "#glossary > dd"]);
  const terms = (g.get("#glossary > dt") ?? []).map((x) => x.text);
  const meanings = (g.get("#glossary > dd") ?? []).map((x) => x.text);
  if (terms.length !== meanings.length) throw new Error(`glossary has ${terms.length} terms and ${meanings.length} meanings`);
  return new Map(terms.map((term, i) => [term, meanings[i] ?? ""]));
}

async function glossaryMissing(guideHtml: string, stageHtml: string, backstageHtml: string): Promise<string[]> {
  const entries = await glossary(guideHtml);
  const posters: unknown = JSON.parse(read(POSTERS));
  const cards = list(posters, "posters");
  const verdicts = cards.map((card) => str(card, "verdictLine"));
  const patterns = [...new Set([...JSON.stringify(cards).matchAll(/pattern P\d+/g)].map((match) => match[0]))];
  const wanted = [...(await sampleRunFields(stageHtml)), ...(await backstageFields(backstageHtml)),
    ...fields(POSTERS, "card verdict lines", verdicts), ...fields(POSTERS, "card rephrase patterns", patterns)];
  return wanted.filter((field) => !entries.has(field.term)).map((field) => `${field.term} (${field.source})`);
}

// ---------- Known values: code constants and the sample run ----------

function constants(): Map<string, string> {
  const backstageJev = MODEL_CATALOG.find((entry) => entry.provider === "jev");
  if (backstageJev?.pricing == null) throw new Error("no Jev price");
  return new Map([
    ["MIN_PAIRED", String(MIN_PAIRED)],
    ["MARGIN_POINTS", String(Math.round(MARGIN * 100))],
    ["MARGIN_BOUND", (-MARGIN).toFixed(2)],
    ["CHEAPER", String(CHEAPER)],
    ["CHEAPER_PERCENT", String(Math.round((1 - CHEAPER) * 100))],
    ["RESAMPLES", RESAMPLES.toLocaleString("en-US")],
    ["MAX_FILE_MB", String(MAX_FILE_BYTES / 1024 / 1024)],
    ["BACKSTAGE_CATALOG_CHECKED_DATE", CATALOG_CHECKED_DATE],
    ["BACKSTAGE_JEV_INPUT_USD_PER_MTOK", String(backstageJev.pricing.inputUsdPerMillion)],
    ["JEV_PIN", JEV_PIN],
  ]);
}

function at(value: unknown, ...path: readonly string[]): unknown {
  let here: unknown = value;
  for (const key of path) {
    if (typeof here !== "object" || here === null || !(key in here)) throw new Error(`missing ${path.join(".")}`);
    const next: unknown = Reflect.get(here, key);
    here = next;
  }
  return here;
}

function num(value: unknown, ...path: readonly string[]): number {
  const found = at(value, ...path);
  if (typeof found !== "number") throw new Error(`${path.join(".")} is not a number`);
  return found;
}

function str(value: unknown, ...path: readonly string[]): string {
  const found = at(value, ...path);
  if (typeof found !== "string") throw new Error(`${path.join(".")} is not a string`);
  return found;
}

function list(value: unknown, ...path: readonly string[]): unknown[] {
  const found = at(value, ...path);
  if (!Array.isArray(found)) throw new Error(`${path.join(".")} is not a list`);
  return found;
}

/** The same money format as site/index.html usd(): four decimals, six under a tenth of a cent. */
function usd(v: number): string {
  return "$" + v.toFixed(v > 0 && v < 0.001 ? 6 : 4);
}

const RULE_WORDS = ["one", "two", "three", "four"];

function computeSampleValues(): Map<string, string> {
  const dataJs = read("site/data.js");
  const sample: unknown = JSON.parse(capture(/window\.JNJ = (\{[\s\S]*\});\s*$/, dataJs));
  const cases = list(sample, "cases");
  const mistakes = cases
    .filter((c) => str(c, "arms", "C", "picked") !== str(c, "truth"))
    .sort((a, b) => num(b, "arms", "C", "confidence") - num(a, "arms", "C", "confidence"));
  const spot = mistakes[0];
  if (spot === undefined) throw new Error("the sample has no Jev mistake to spotlight");
  const cpkA = num(sample, "summary", "A", "cpk");
  const cpkC = num(sample, "summary", "C", "cpk");
  const cli = Bun.spawnSync(["bun", "src/decide/cli.ts", "verdict", SAMPLE_RECORDS, "--question", "q1"], { cwd: ROOT });
  const report: unknown = JSON.parse(cli.stdout.toString());
  const v = list(report, "verdicts")[0];
  const verdictName = str(v, "verdict");
  const rule = num(v, "rule");
  if (str(sample, "verdict", "result") !== verdictName || num(sample, "verdict", "rule") !== rule || str(sample, "verdict", "reason") !== str(v, "reason")) {
    throw new Error("the page's sample verdict and the CLI verdict on its records differ");
  }
  const verdictLine = str(sample, "explained", "verdict");
  if (verdictLine.toLowerCase() !== `${verdictName.toLowerCase()} (rule ${rule})`) throw new Error("the Stage verdict line differs from the computed verdict and rule");
  const out = new Map<string, string>([
    ["cases", String(cases.length)],
    ["truth-answer", String(cases.filter((c) => str(c, "truth") === "answer").length)],
    ["truth-hand_off", String(cases.filter((c) => str(c, "truth") === "hand_off").length)],
    ["spot-id", str(spot, "id")],
    ["spot-confidence", num(spot, "arms", "C", "confidence").toFixed(2)],
    ["save-vs-a", ((1 - cpkC / cpkA) * 100).toFixed(0)],
    ["verdict-word", verdictLine],
    ["verdict-name", verdictName],
    ["verdict-rule", String(rule)],
    ["verdict-rule-word", RULE_WORDS[rule - 1] ?? "none"],
    ["reason", str(v, "reason").slice(verdictName.length + 2)],
    ["paired", String(num(v, "numbers", "jevVsLlm", "n"))],
    ["jev-lower", num(v, "numbers", "jevVsLlm", "lower").toFixed(2)],
    ["jev-upper", num(v, "numbers", "jevVsLlm", "upper").toFixed(2)],
    ["cost-ratio", num(v, "numbers", "costRatio", "ratio").toFixed(3)],
    ["cost-upper", num(v, "numbers", "costRatio", "upper").toFixed(3)],
    ["rule-lower", num(v, "ruleComparison", "lower").toFixed(2)],
  ]);
  for (const arm of ["A", "B", "C"]) {
    out.set(`kept-${arm}`, String(num(sample, "summary", arm, "kept")));
    out.set(`spend-${arm}`, usd(num(sample, "summary", arm, "spend")));
    out.set(`cpk-${arm}`, usd(num(sample, "summary", arm, "cpk")));
  }
  for (const arm of ["A", "B"]) {
    out.set(`wins-${arm}`, String(num(sample, "jev_vs", arm, "wins")));
    out.set(`losses-${arm}`, String(num(sample, "jev_vs", arm, "losses")));
  }
  return out;
}

let sampleCache: Map<string, string> | null = null;
function sampleValues(): Map<string, string> {
  sampleCache ??= computeSampleValues();
  return sampleCache;
}

interface Known {
  readonly const: ReadonlyMap<string, string>;
  readonly sample: ReadonlyMap<string, string>;
}

function known(): Known {
  return { const: constants(), sample: sampleValues() };
}

// ---------- Marked figures, over the whole guide ----------

const MARK = "[data-const], [data-sample]";

interface Marked {
  readonly kind: "const" | "sample";
  readonly name: string;
  readonly shown: string;
  readonly error: string | null;
}

/** Every marked element in the guide, in order, each validated: it must be a span with one mark naming a known value. */
async function marked(html: string, values: Known): Promise<Marked[]> {
  return ((await grab(html, [MARK])).get(MARK) ?? []).map((g): Marked => {
    const c = g.attrs.get("data-const");
    const s = g.attrs.get("data-sample");
    const kind = c === undefined ? "sample" : "const";
    const name = c ?? s ?? "";
    const want = (kind === "const" ? values.const : values.sample).get(name);
    const error =
      g.tag !== "span" || (c !== undefined && s !== undefined)
        ? `mark on <${g.tag}> ${name}: use one data-const or data-sample on a span`
        : want === undefined
          ? `unknown ${kind} ${name}`
          : want !== g.text
            ? `${kind} ${name} shows ${g.text}, code says ${want}`
            : null;
    return { kind, name, shown: g.text, error };
  });
}

/**
 * Numbers that may appear unmarked anywhere in the guide, each as the exact phrase it sits in. The map window
 * is checked against the mapper below; other thresholds and sample figures need validated marks.
 */
const UNRELATED_NUMBERS: readonly (readonly [string, string])[] = [
  ["7 days by default; use --days N for a longer window (up to 90 days for a shared map)", "mapper default and shared-map range"],
  ["sections 1 to 4", "reading order"],
  ["with section 5 open", "reading order"],
  ["1. Prepare test cases", "section heading"],
  ["2. Label acceptance", "section heading"],
  ["3. Enter costs", "section heading"],
  ["4. Read the verdict", "section heading"],
  ["5. Worked example: the sample run", "section heading"],
  ["6. Limitations", "section heading"],
  ["takes 1 to 100 cases of up to 8,000 characters each", "Backstage case limits, quoted from its page"],
  ["(section 4)", "cross-reference"],
  ["(section 4, rule three)", "cross-reference"],
  ["P1 to P4 come with 10 labelled cases and P5 to P10 with 30 cases", "starter packs, quoted from New Scene"],
  ["ready packs P1 to P4", "different from the card rephrase patterns"],
  ["pattern P1", "card rephrase pattern"],
  ["pattern P2", "card rephrase pattern"],
  ["pattern P3", "card rephrase pattern"],
  ["Use Jev (rule 3)", "sample verdict glossary term"],
  ["Use Jev (100 messages)", "shop-bot card verdict glossary term"],
  ["Not enough evidence (rule 1)", "CV card verdict glossary term"],
  ["5 separate practice cases", "optional calibration count from calibration-view"],
  ["one kept and one rejected answer at $1 each cost $2 per kept answer", "arithmetic example"],
  ["about 1 to 4 bytes of your text", "estimate basis, quoted from Learning Lines"],
  ["A simple rule costs $0.", "a rule makes no call"],
  ["jnj-record/1.1", "format name"],
  ["jnj-record/1.2", "format name"],
  ["jnj-record/1", "format name"],
  ["(0.00003242, not", "cost_usd format example"],
  ["Use 0 for a rule", "cost_usd format example"],
  ["both cost $0 per kept answer", "cost guard"],
  ["(m01, m02 and so on", "case ids"],
  ["confidence from 0 to 1", "confidence scale"],
  ["\"undefined (0 kept)\"", "Stage text, quoted"],
  ["such as c1.", "sample cases file id"],
  ["Rule 1:", "verdict rule number, from src/core/verdict.ts"],
  ["Rule 2:", "verdict rule number, from src/core/verdict.ts"],
  ["Rule 3:", "verdict rule number, from src/core/verdict.ts"],
  ["Rule 4:", "verdict rule number, from src/core/verdict.ts"],
  ["UC1 to UC10", "use-case ids, from site/data.js"],
  ["3 to 24 lowercase letters, digits or hyphens", "nickname limits, quoted from site/tm/index.html"],
];

/** Digits left in the guide's main text after removing validated marks, the allowed phrases and case ids (m33). */
async function uncheckedNumbers(html: string, values: Known): Promise<string[]> {
  const marks = await marked(html, values);
  let index = 0;
  const stripped = await new HTMLRewriter()
    .on(MARK, {
      element(el) {
        if (marks[index]?.error === null) el.remove();
        index += 1;
      },
    })
    .transform(new Response(html))
    .text();
  let text = (await texts(stripped, "main"))[0] ?? "";
  for (const [phrase] of UNRELATED_NUMBERS) text = text.split(phrase).join(" ");
  return text.replace(/\bm\d{2}\b/g, " ").match(/\d[\d.,]*/g) ?? [];
}

/** Allowed phrases no longer in the guide: a stale allowance would hide a future number. */
async function unusedAllowances(html: string): Promise<string[]> {
  const text = (await texts(html, "main"))[0] ?? "";
  return UNRELATED_NUMBERS.map(([phrase]) => phrase).filter((phrase) => !text.includes(phrase));
}

const SECTION_HEADINGS = [
  "1. Prepare test cases",
  "2. Label acceptance",
  "3. Enter costs",
  "4. Read the verdict",
  "5. Worked example: the sample run",
  "6. Limitations",
  "Field glossary",
];

/** Apply a text mutation that must change the file, so a negative test can never pass on a no-op. */
function mutate(text: string, from: string, to: string): string {
  const out = text.replace(from, to);
  if (out === text) throw new Error(`mutation target not found: ${from}`);
  return out;
}

describe("in-product first-use guide (D18)", () => {
  test("[unit] D18-SITE-GUIDE-GLOSSARY every field the sample run and Backstage show has a glossary entry", async () => {
    expect(await glossaryMissing(read(GUIDE), read(STAGE), read(BACKSTAGE))).toEqual([]);
    for (const [term, meaning] of await glossary(read(GUIDE))) expect(`${term}: ${meaning.length}`).not.toBe(`${term}: 0`);
  });

  test("[unit] D18-SITE-GUIDE-EXTRACT the extractors read the real pages, so the glossary check is not vacuous", async () => {
    const sample = (await sampleRunFields(read(STAGE))).map((field) => field.term);
    const backstage = (await backstageFields(read(BACKSTAGE))).map((field) => field.term);
    for (const term of ["Sample questions", "Tested", "Small test", "Coming", "Why this verdict", "Why:", "What the cases show:", "Next step:", "Rephrased for Jev:", "Earlier run:", "Get another ticket", "Open the ticket office", "Load your own script (CSV)"]) {
      expect(sample).toContain(term);
    }
    for (const term of ["Judging rule (required)", "Leave out...", "Choose optional comparisons", "Results and downloads", "First choice", "Download run evidence", "Kept / labelled", "Returned confidence", "case_input", "label_source", "Jev-only wins", "Anthropic API key", "xAI API key"]) {
      expect(backstage).toContain(term);
    }
  });

  test("[unit] D18-SITE-GUIDE-NESTED a header with nested markup is a field, so a new one without an entry fails", async () => {
    const stage = mutate(read(STAGE), "<section class=\"samples\" aria-label=\"Sample questions\"><h2>Sample questions</h2>", "<section class=\"samples\" aria-label=\"Sample questions\"><h2>Sample questions</h2><h2><b>New unexplained field</b></h2>");
    expect(await glossaryMissing(read(GUIDE), stage, read(BACKSTAGE))).toEqual(["New unexplained field (site/index.html)"]);
  });

  test("[unit] #201 card verdict lines and rephrase patterns need glossary entries", async () => {
    expect(await glossaryMissing(read(GUIDE), read(STAGE), read(BACKSTAGE))).toEqual([]);
    const guide = mutate(read(GUIDE),
      "<dt>pattern P2</dt><dd>Card rephrase pattern: ask one yes or no statement Jev can check on one text, then let code combine the answers.</dd>", "");
    expect(await glossaryMissing(guide, read(STAGE), read(BACKSTAGE))).toContain(`pattern P2 (${POSTERS})`);
  });

  test("[unit] D18-SITE-GUIDE-SECTIONS the six sections and the glossary come in order", async () => {
    expect(await texts(read(GUIDE), "#reference h2")).toEqual(SECTION_HEADINGS);
  });

  test("[integration] D18-SITE-GUIDE-MARKS every marked figure in the guide is the code constant or sample value it names", async () => {
    const marks = await marked(read(GUIDE), known());
    const names = new Set(marks.map((m) => `${m.kind}:${m.name}`));
    for (const required of ["MIN_PAIRED", "MARGIN_POINTS", "MARGIN_BOUND", "CHEAPER", "CHEAPER_PERCENT", "RESAMPLES"]) expect(names).toContain(`const:${required}`);
    for (const required of ["verdict-word", "verdict-rule", "verdict-rule-word", "verdict-name", "reason", "jev-lower", "cost-ratio"]) expect(names).toContain(`sample:${required}`);
    expect(marks.length).toBeGreaterThan(30);
    expect(marks.map((m) => m.error).filter((e) => e !== null)).toEqual([]);
  }, 30000);

  test("[integration] D18-SITE-GUIDE-NUMBERS no number in the whole guide sits outside a validated mark or an allowed phrase", async () => {
    const html = read(GUIDE);
    expect(await uncheckedNumbers(html, known())).toEqual([]);
    expect(await unusedAllowances(html)).toEqual([]);
  }, 30000);

  test("[integration] D18-SITE-GUIDE-NEGATIVE each known false-pass mutation now goes RED", async () => {
    const guide = read(GUIDE);
    const values = known();
    const errors = async (html: string) => (await marked(html, values)).map((m) => m.error).filter((e) => e !== null);
    // Round 1 #6: an unknown mark name with a wrong number.
    const unknownName = mutate(guide, '<span data-const="RESAMPLES">2,000</span>', '<span data-const="MIN_PAIRED2">999</span>');
    expect(await errors(unknownName)).toEqual(["unknown const MIN_PAIRED2"]);
    expect(await uncheckedNumbers(unknownName, values)).toEqual(["999"]);
    // Round 2 #2: section 1's first marked minimum replaced by a plain number.
    const plain = mutate(guide, '<span data-const="MIN_PAIRED">30</span>', "999");
    expect(await uncheckedNumbers(plain, values)).toEqual(["999"]);
    // Round 2 #4: the displayed verdict changed to another verdict.
    const wrongVerdict = mutate(guide, '<span data-sample="verdict-word">Use Jev (rule 3)</span>', '<span data-sample="verdict-word">Not enough evidence</span>');
    expect(await errors(wrongVerdict)).toEqual(["sample verdict-word shows Not enough evidence, code says Use Jev (rule 3)"]);
    // A marked value wrapped in nested markup is still read and checked.
    const nested = mutate(guide, '<span data-const="CHEAPER">0.8</span>', '<span data-const="CHEAPER"><b>0.9</b></span>');
    expect(await errors(nested)).toEqual(["const CHEAPER shows 0.9, code says 0.8"]);
    // A mark on anything but a span is refused.
    const notSpan = mutate(guide, '<span data-sample="cases">100</span>', '<b data-sample="cases">100</b>');
    expect(await errors(notSpan)).toEqual(["mark on <b> cases: use one data-const or data-sample on a span"]);
  }, 30000);

  // D18 persona-swarm gaps (c01 to c07): each check reads the guide and the source it explains.

  test("[unit] D18-SWARM-C01 every Backstage control the swarm could not read has a glossary entry and is still on the page", async () => {
    const page = clean(`${read(BACKSTAGE)} ${read("src/backstage/main.ts")}`);
    const glossaryEntries = await glossary(read(GUIDE));
    const entries = [...glossaryEntries.keys()];
    for (const label of ["Edit the question", "Theme", "Send feedback", "Try first case", "Try one small Jev query", "Prefer the Playground?", "Catalog checked"]) {
      expect(page).toContain(label);
      expect(entries).toContain(label);
    }
    expect(glossaryEntries.get("Send feedback")).toContain("in Backstage it opens a new issue on the project's GitHub");
    expect(glossaryEntries.get("Send feedback")).toContain("on the home page and this guide it opens an email to the Jev!Jev team");
  });

  // l02 (persona swarm 2026-10-12): Backstage controls and captions a tester met with no glossary entry.
  describe("Backstage labels from swarm gap l02", () => {
    /** [element in site/backstage/index.html, its rendered text, the glossary term] */
    const L02_ELEMENTS: readonly (readonly [string, string, string])[] = [
      [".ticket span", "Jev!Jev / Backstage Pass", "Jev!Jev / Backstage Pass"],
      ["button#clear-keys", "Clear keys", "Clear keys"],
      ["button#copy-case", "Copy first case for Playground", "Copy first case for Playground"],
      ["button#stop", "Stop", "Stop"],
      ["h3#calibration-title", "Calibrate first: 5 practice cases", "Calibrate first"],
    ];
    /** The catalog note is set by main.ts, so its phrase is read from the text("catalog-note", ...) call. */
    const CATALOG_NOTE = /text\(\s*"catalog-note",([\s\S]*?)\);/;
    const UNMAPPED = ["unmapped usage stays unknown", "Unmapped usage stays unknown"];

    /** Labels whose element no longer renders them, or with no non-empty glossary entry. */
    async function l02Problems(guideHtml: string, backstageHtml: string, mainTs: string): Promise<string[]> {
      const entries = await glossary(guideHtml);
      const found = await grab(backstageHtml, L02_ELEMENTS.map(([selector]) => selector));
      const out: string[] = [];
      for (const [selector, shown, term] of L02_ELEMENTS) {
        const rendered = (found.get(selector) ?? []).map((g) => g.text);
        if (rendered.length !== 1 || rendered[0] !== shown) out.push(`${selector} does not render: ${shown}`);
        if ((entries.get(term) ?? "") === "") out.push(`no glossary entry: ${term}`);
      }
      const [phrase, term] = UNMAPPED;
      if (!(CATALOG_NOTE.exec(mainTs)?.[1] ?? "").includes(phrase ?? "")) out.push(`catalog note does not say: ${phrase}`);
      if ((entries.get(term ?? "") ?? "") === "") out.push(`no glossary entry: ${term}`);
      return out;
    }

    const MAIN_TS = "src/backstage/main.ts";

    test("[unit] D18-SWARM-L02 each l02 Backstage label still renders and has a glossary entry", async () => {
      expect(await l02Problems(read(GUIDE), read(BACKSTAGE), read(MAIN_TS))).toEqual([]);
      // Attribute order and markup inside the button do not change its rendered label.
      const reordered = mutate(read(BACKSTAGE), '<button id="stop" class="secondary" disabled>Stop</button', '<button class="secondary" disabled id="stop"><b>Stop</b></button');
      expect(await l02Problems(read(GUIDE), reordered, read(MAIN_TS))).toEqual([]);
    });

    test("[unit] D18-SWARM-L02-NEGATIVE a dropped entry, an emptied meaning and a renamed control each go RED", async () => {
      const dropped = mutate(read(GUIDE), "<dt>Clear keys</dt>", "<dt>Wipe keys</dt>");
      expect(await l02Problems(dropped, read(BACKSTAGE), read(MAIN_TS))).toEqual(["no glossary entry: Clear keys"]);
      const emptied = read(GUIDE).replace(/(<dt>Stop<\/dt><dd>)[\s\S]*?(<\/dd>)/, "$1$2");
      expect(emptied).not.toBe(read(GUIDE));
      expect(await l02Problems(emptied, read(BACKSTAGE), read(MAIN_TS))).toEqual(["no glossary entry: Stop"]);
      // The button is renamed while "Clear keys" stays in the prose above it.
      const wipe = read(BACKSTAGE).replace(/(<button id="clear-keys"[^>]*>)\s*Clear keys\s*</, "$1Wipe keys<");
      expect(wipe).not.toBe(read(BACKSTAGE));
      expect(wipe).toContain("Clear keys stops further calls");
      expect(await l02Problems(read(GUIDE), wipe, read(MAIN_TS))).toEqual(["button#clear-keys does not render: Clear keys"]);
      const calibration = mutate(read(BACKSTAGE), "Calibrate first: 5 practice cases", "Practice first");
      expect(await l02Problems(read(GUIDE), calibration, read(MAIN_TS))).toEqual(["h3#calibration-title does not render: Calibrate first: 5 practice cases"]);
      const note = mutate(read(MAIN_TS), "unmapped usage stays unknown", "usage is estimated");
      expect(await l02Problems(read(GUIDE), read(BACKSTAGE), note)).toEqual(["catalog note does not say: unmapped usage stays unknown"]);
    });
  });

  const ACCESS_STATEMENTS = [
    'its title on screen is "Backstage Pass"',
    "The workspace and its sample cases file need you to sign in.",
    'press "Open the ticket office", then fill in "Bring your own decision"',
    "A person reads each request and replies by email",
    "the reply explains how to sign in",
    "The request alone does not open the workspace.",
  ];

  /** What the access note before section 1 fails to say; empty when it says all of it. */
  async function accessProblems(html: string): Promise<string[]> {
    const at = html.indexOf('id="access"');
    if (at < 0 || at > html.indexOf('id="prepare"')) return ["no access note before section 1"];
    const g = await grab(html, ["#access", "#access a"]);
    const text = g.get("#access")?.[0]?.text ?? "";
    const links = (g.get("#access a") ?? []).map((a) => a.attrs.get("href") ?? "");
    const out = ACCESS_STATEMENTS.filter((s) => !text.includes(s)).map((s) => `missing: ${s}`);
    if (!links.includes("../#tkForm")) out.push("no form-opening link");
    return out;
  }

  test("[unit] D18-SWARM-C02 before section 1 the guide says Backstage and its sample cases file need sign-in, and how to get access", async () => {
    expect(await accessProblems(read(GUIDE))).toEqual([]);
    // The access path the guide describes is the one the ticket office states.
    expect(read("site/shows/office.js")).toContain("the reply explains how to sign in to Backstage; the request alone does not open it");
    const reversed = mutate(read(GUIDE), "The request alone does not open the workspace.", "The request alone opens the workspace.");
    expect(await accessProblems(reversed)).toEqual(["missing: The request alone does not open the workspace."]);
    const open = mutate(read(GUIDE), "need you to sign in.", "are open without signing in.");
    expect(await accessProblems(open)).toEqual(["missing: The workspace and its sample cases file need you to sign in."]);
  });

  // c03: the operator named the TypeSafe Playground as where testers get a key; Backstage already links it.
  const KEY_PAGE = "https://console.typesafe.ai/playground";

  /** Where the guide fails to link the key page: the access note before section 1, and section 1 beside the Jev price. */
  async function keyPageProblems(html: string): Promise<string[]> {
    const out: string[] = [];
    const access = ((await grab(html, ["#access a"])).get("#access a") ?? []).map((a) => a.attrs.get("href") ?? "");
    if (!access.includes(KEY_PAGE)) out.push("access note: no key page link");
    const section1 = html.slice(html.indexOf('id="prepare"'), html.indexOf('id="label"'));
    const keyItem = /<li><strong>Get a TypeSafe API key\.<\/strong>([\s\S]*?)<\/li>/.exec(section1)?.[1] ?? "";
    if (!keyItem.includes(`href="${KEY_PAGE}"`)) out.push("section 1: no key page link");
    if (!keyItem.includes('data-const="BACKSTAGE_JEV_INPUT_USD_PER_MTOK"')) out.push("section 1: no Jev price beside the key");
    return out;
  }

  test("[unit] D18-SWARM-C03 the guide links the TypeSafe key page near the top and in section 1, beside the Jev price", async () => {
    expect(await keyPageProblems(read(GUIDE))).toEqual([]);
    expect(read(BACKSTAGE)).toContain(`href="${KEY_PAGE}"`);
    const unlinked = read(GUIDE).split(`href="${KEY_PAGE}"`).join('href="https://example.invalid/"');
    expect(await keyPageProblems(unlinked)).toEqual(["access note: no key page link", "section 1: no key page link"]);
  });

  /** The Stage's visible text: markup, scripts and styles removed. */
  function stageText(html: string): string {
    return clean(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " "));
  }

  /** [as the Stage shows it, as the guide quotes it] */
  const STAGE_CAPTIONS: readonly (readonly [string, string])[] = [
    ["ADMIT ONE", "ADMIT ONE"],
    ["Row J", "ROW J"],
    ["Seat J-EV", "SEAT J-EV"],
    ["Go to the ticket office", "GO TO THE TICKET OFFICE"],
    ["In repertoire: other questions Jev could play", "IN REPERTOIRE"],
  ];

  /** Captions missing from the Stage or undecoded in the guide, and a wrong account of the question box. */
  async function captionProblems(stageHtml: string, guideHtml: string): Promise<string[]> {
    const stage = stageText(stageHtml);
    const guide = (await texts(guideHtml, "main"))[0] ?? "";
    const out: string[] = [];
    for (const [onStage, inGuide] of STAGE_CAPTIONS) {
      if (!stage.includes(onStage)) out.push(`not on the Stage: ${onStage}`);
      if (!guide.includes(inGuide)) out.push(`not in the guide: ${inGuide}`);
    }
    const ids = [...read("site/data.js").matchAll(/"(UC\d+)"/g)].map((m) => m[1] ?? "");
    if (ids.length < 2 || !guide.includes(`${ids[0] ?? ""} to ${ids[ids.length - 1] ?? ""}`)) out.push("use-case span not in the guide");
    // #203 removed the question box until the live check ships: the Stage has none, and the guide must say so.
    if (/id="askInput"|id="askForm"/.test(stageHtml)) out.push("the Stage has a question box again");
    for (const phrase of ["no box for typing your own question", "until the live check ships"]) if (!guide.includes(phrase)) out.push(`question box: missing ${phrase}`);
    return out;
  }

  test("[unit] D18-SWARM-C04 the Stage's theatre captions are decoded, and each is still on the Stage", async () => {
    expect(await captionProblems(read(STAGE), read(GUIDE))).toEqual([]);
    // Markup around a caption does not change what the Stage shows.
    const bold = mutate(read(STAGE), '<p class="admit">ADMIT ONE</p>', '<p class="admit"><b>ADMIT</b> ONE</p>');
    expect(await captionProblems(bold, read(GUIDE))).toEqual([]);
    const live = mutate(read(GUIDE), "The page has no box for typing your own question until the live check ships.", "Type a question to call Jev live.");
    expect(await captionProblems(read(STAGE), live)).toEqual(["question box: missing no box for typing your own question", "question box: missing until the live check ships"]);
    const boxBack = mutate(read(STAGE), "<main>", '<main><form id="askForm"></form>');
    expect(await captionProblems(boxBack, read(GUIDE))).toEqual(["the Stage has a question box again"]);
  });

  test("[unit] D18-SWARM-C04-LOADER the guide names the control that opens the file loader", async () => {
    const stage = read(STAGE);
    const guide = read(GUIDE);
    expect(stage).toMatch(/<button id="officeOpen"[^>]*>Open the ticket office<\/button>/);
    expect(guide).toContain('press "Open the ticket office" at the foot of the sample run page, then <strong>Load your own script (CSV)</strong>');
  });

  test("[unit] D18-SWARM-C04-ACCESS the access path opens the form with the named heading", async () => {
    const stage = read(STAGE);
    expect(await accessProblems(read(GUIDE))).toEqual([]);
    expect(stage).toMatch(/<button id="officeOpen"[^>]*>Open the ticket office<\/button>/);
    const formHeading = "Bring your own decision";
    expect(stage).toContain(`<h3 id="tkTitle">${formHeading}</h3>`);
    expect(read(OFFICE)).toContain('window.location.hash === "#tkForm"');
    expect(await accessProblems(mutate(read(GUIDE), 'href="../#tkForm"', 'href="../#tickets"'))).toContain("no form-opening link");
  });

  test("[unit] D18-SWARM-C04-CARDS every plain card stage and fixed landing label has a glossary entry", async () => {
    const office = read(OFFICE);
    const names = [...office.matchAll(/\bname: "([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(names).toEqual(["Tested", "Small test", "Coming"]);
    const stage = read(STAGE);
    const cardLabels = (await sampleRunFields(stage)).map((field) => field.term);
    const fixed = ["Sample questions", "Why this verdict", "Why:", "What the cases show:", "Next step:", "Rephrased for Jev:", "Earlier run:", "Get another ticket", "Open the ticket office"];
    for (const term of [...names, ...fixed]) expect(cardLabels).toContain(term);
    expect(stage).toContain('<h2>Sample questions</h2>');
    for (const label of ["Why: ", "What the cases show: ", "Next step: ", "Rephrased for Jev: ", "Earlier run: "]) expect(office).toContain(`"${label}"`);
    expect(office).toContain('"Get another ticket"');
    expect(await glossaryMissing(read(GUIDE), stage, read(BACKSTAGE))).toEqual([]);
    const guide = read(GUIDE);
    expect(guide).toContain("Below the sample cards, the shop-bot sections show a recorded run");
    expect(guide).toContain('The "Sample questions" are a row of posters. Each poster carries a ticket stamp');
    expect((await glossary(guide)).get("Sample run")).toContain("below the sample cards");
    const missing = mutate(read(GUIDE), "<dt>Why:</dt>", "<dt>Unexplained check</dt>");
    expect(await glossaryMissing(missing, stage, read(BACKSTAGE))).toContain("Why: (site/shows/office.js)");
  });

  test("[unit] D18-SWARM-C05 section 4 numbers every rule the verdict code can emit, in order", async () => {
    const emitted = capture(/readonly rule: ([\d |]+);/, read("src/core/verdict.ts")).split("|").map((n) => `Rule ${n.trim()}`);
    expect(emitted.length).toBeGreaterThan(1);
    const items = await texts(read(GUIDE), "#verdict-rules > li");
    expect(items.map((item) => capture(/^(Rule \d+):/, item))).toEqual(emitted);
  });

  /** The results-file column list in document order: each term with its own following meaning, and what is malformed. */
  function columnEntries(html: string): { readonly names: string[]; readonly problems: string[] } {
    // Comments are not rendered, so a commented-out list or entry is not in the guide.
    const block = capture(/<dl id="record-columns"[^>]*>([\s\S]*?)<\/dl>/, html.replace(/<!--[\s\S]*?-->/g, " "));
    const items = [...block.matchAll(/<(dt|dd)>([\s\S]*?)<\/\1>/g)].map((m) => ({ tag: m[1] ?? "", text: clean((m[2] ?? "").replace(/<[^>]*>/g, " ")) }));
    const names: string[] = [];
    const problems: string[] = [];
    let last = "(start)";
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item === undefined) continue;
      if (item.tag !== "dt") {
        problems.push(`orphan meaning after ${last}`);
        continue;
      }
      last = item.text;
      names.push(item.text);
      const meaning = items[i + 1];
      if (meaning?.tag !== "dd") problems.push(`${item.text}: no meaning`);
      else {
        if (meaning.text === "") problems.push(`${item.text}: empty meaning`);
        i++;
      }
    }
    return { names, problems };
  }

  test("[unit] D18-SWARM-C06 the guide lists every jnj-record column the validator reads, each with a meaning", () => {
    const { names, problems } = columnEntries(read(GUIDE));
    expect(names).toEqual([...COLUMNS_V1_2, ...SUGGESTION_COLUMNS]);
    expect(names).toContain("run_id");
    expect(names).toContain("cost_usd");
    expect(problems).toEqual([]);
    const broken = mutate(read(GUIDE), "<dt>run_id</dt><dd>", "<dt>run_id</dt><dd></dd><dd>");
    expect(columnEntries(broken).problems).toEqual(["run_id: empty meaning", "orphan meaning after run_id"]);
    const list = capture(/(<dl id="record-columns"[\s\S]*?<\/dl>)/, read(GUIDE));
    const commentedList = mutate(read(GUIDE), list, `<!-- ${list} -->`);
    expect(() => columnEntries(commentedList)).toThrow();
    const commentedEntry = mutate(mutate(read(GUIDE), "<dt>run_id</dt>", "<!-- <dt>run_id</dt>"), "own run_id.</dd>", "own run_id.</dd> -->");
    expect(columnEntries(commentedEntry).names).not.toContain("run_id");
  });

  const INTRO = /(<p id="jev-intro">[\s\S]*?<\/p>\n)/;

  /** Technical provenance stays at the start of the optional reference, outside the visitor walkthrough. */
  async function introProblems(html: string): Promise<string[]> {
    const out: string[] = [];
    if (!/<div class="reference-body">\s*<p id="jev-intro">/.test(html)) out.push("intro is not at the start of the reference");
    const intro = (await texts(html, "p#jev-intro"))[0] ?? "";
    for (const needed of [JEV_PIN, "TypeSafe", "one decision", "not a cross-task benchmark"]) if (!intro.includes(needed)) out.push(`intro: missing ${needed}`);
    return out;
  }

  test("[unit] D18-SWARM-C07 reference preserves what Jev is, who makes it, its pinned model, and that this tests one decision", async () => {
    expect(await introProblems(read(GUIDE))).toEqual([]);
    expect(MODEL_CATALOG.find((entry) => entry.provider === "jev")?.modelId).toBe(JEV_PIN);
    const para = capture(INTRO, read(GUIDE));
    const moved = mutate(mutate(read(GUIDE), para, ""), "</main>", `${para}</main>`);
    expect(await introProblems(moved)).toEqual(["intro is not at the start of the reference"]);
  });

  test("[unit] D18-SWARM-WORDING section 3's title and opening agree, and the answer name hand_off is explained", async () => {
    const html = read(GUIDE);
    const costs = html.slice(html.indexOf('id="costs"'), html.indexOf('id="verdict"'));
    expect(costs).not.toContain("do not type costs");
    expect(costs).toContain("costs are entered for you");
    const text = (await texts(html, "main"))[0] ?? "";
    expect(text).toContain("hand_off");
    expect(text).toContain('the sample run page prints it as "hand off"');
  });

  test("[unit] D18-SITE-GUIDE-LINKS the sample run, Backstage and the CLI guide link to /guide/", () => {
    expect(read(STAGE)).toContain('href="guide/"');
    expect(read(BACKSTAGE)).toContain('href="/guide/"');
    expect(read("docs/GUIDE.md")).toContain("](../site/guide/index.html)");
  });
});

describe("guide reads the verdict statistics in plain words (D18 swarm l01)", () => {
  /** Problems with the plain-words reading of the sample run's verdict line, section 5. */
  async function verdictPlainProblems(html: string): Promise<string[]> {
    const para = (await texts(html, "p#verdict-plain"))[0] ?? "";
    if (para === "") return ["no plain-words reading of the verdict line"];
    const sample = sampleValues();
    const lower = sample.get("jev-lower") ?? "";
    const out: string[] = [];
    if (!para.includes(`Lower bound of Jev minus LLM ${lower}`)) out.push(`does not quote the sample lower bound ${lower}`);
    const bound = (-MARGIN).toFixed(2);
    const reasons = [
      "the worst gap this evidence cannot rule out",
      `The use-Jev rule needs the bottom above ${bound}`,
      `${lower} is above it, so that condition of rule three is met; the cost condition is met too, and rule ${sample.get("verdict-rule-word") ?? ""} fires`,
      "does not say Jev is worse",
    ];
    for (const needed of reasons) {
      if (!para.includes(needed)) out.push(`missing: ${needed}`);
    }
    return out;
  }

  /** The two sentences after "Newcombe's paired method:" in section 4. */
  async function newcombeDefinition(html: string): Promise<string> {
    const para = (await texts(html, "p#verdict-terms"))[0] ?? "";
    return /Newcombe's paired method: ([^.]*\.[^.]*\.)/.exec(para)?.[1] ?? "";
  }

  test("[unit] D18-SWARM-L01 section 5 reads the sample's lower bound and both rule three conditions", async () => {
    expect(await verdictPlainProblems(read(GUIDE))).toEqual([]);
    const removed = mutate(read(GUIDE), "the worst gap this evidence cannot rule out", "the lower bound");
    expect(await verdictPlainProblems(removed)).toEqual(["missing: the worst gap this evidence cannot rule out"]);
    const para = capture(/(<p id="verdict-plain">[\s\S]*?<\/p>)/, read(GUIDE));
    expect(await verdictPlainProblems(mutate(read(GUIDE), para, ""))).toEqual(["no plain-words reading of the verdict line"]);
    const why = capture(/(The use-Jev rule needs[\s\S]*? fires\.)/, para);
    const lost = await verdictPlainProblems(mutate(read(GUIDE), why, "Therefore."));
    expect(lost.length).toBe(2);
    expect(lost[0]).toStartWith("missing: The use-Jev rule needs the bottom above");
    expect(lost[1]).toContain("so that condition of rule three is met");
  });

  test("[unit] D18-SWARM-L01 Newcombe's paired method is followed by a plain definition, and uncorrected is defined", async () => {
    const definition = await newcombeDefinition(read(GUIDE));
    expect(definition.split(" ").length).toBeGreaterThan(20);
    expect(definition).toContain("same cases");
    expect(definition).toContain("what paired means");
    const uncorrected = async (html: string): Promise<boolean> => {
      const terms = (await texts(html, "p#verdict-terms"))[0] ?? "";
      return terms.includes("Each verdict is uncorrected: it compares Jev with one other answerer on its own, and nothing widens the ranges when several comparisons run at once");
    };
    expect(await uncorrected(read(GUIDE))).toBe(true);
    expect(await uncorrected(mutate(read(GUIDE), "and nothing widens the ranges when several comparisons run at once", "and the ranges are widened to correct for several comparisons"))).toBe(false);
    const terms = (await texts(read(GUIDE), "p#verdict-terms"))[0] ?? "";
    expect(terms).toContain("The upper bound is the largest value in the range");
    expect(terms).toContain("a higher cost ratio means Jev is dearer");
    const emptied = mutate(read(GUIDE), "<strong>Newcombe's paired method</strong>: a standard way", "<strong>Newcombe's paired method</strong>. A standard way");
    expect(await newcombeDefinition(emptied)).toBe("");
  });

  test("[unit] D18-SWARM-L01 jnj-record/1 is explained as a format name with a version, as format/README.md states", async () => {
    expect(read("format/README.md").split("\n")[0]).toBe("# Eval record format `jnj-record/1` with its minor versions 1.1 and 1.2");
    const explains = async (html: string): Promise<boolean> => {
      const para = (await texts(html, "p#format-name"))[0] ?? "";
      return para.startsWith("jnj-record/1 is a format name") && para.includes("the number after the slash is its version");
    };
    expect(await explains(read(GUIDE))).toBe(true);
    expect(await explains(mutate(read(GUIDE), "is its version", "is a counter"))).toBe(false);
  });
});

/** Run the shipped navigation script against a small DOM surface; no network or browser dependency. */
function guideNavigation(initialHash: string) {
  const details = { open: false };
  const scrolled: string[] = [];
  const hashListeners: (() => void)[] = [];
  const clickListeners: ((event: { target: unknown }) => void)[] = [];
  const window = {
    location: { hash: initialHash },
    addEventListener(name: string, handler: () => void) {
      if (name === "hashchange") hashListeners.push(handler);
    },
  };
  class Link {
    constructor(readonly hash: string) {}
    closest(selector: string) { return selector === 'a[href^="#"]' ? this : null; }
    getAttribute(name: string) { return name === "href" ? this.hash : null; }
  }
  const document = {
    getElementById(id: string) {
      if (!["fields", "verdict", "choose"].includes(id)) return null;
      return {
        closest(selector: string) { return selector === "details" && id !== "choose" ? details : null; },
        scrollIntoView() { scrolled.push(id); },
      };
    },
    addEventListener(name: string, handler: (event: { target: unknown }) => void) {
      if (name === "click") clickListeners.push(handler);
    },
  };
  runInNewContext(read("site/guide/guide.js"), { window, document, Element: Link });
  return {
    details, scrolled,
    navigate(hash: string) {
      window.location.hash = hash;
      hashListeners.forEach(handler => handler());
    },
    clickSameAnchor() {
      clickListeners.forEach(handler => handler({ target: new Link(window.location.hash) }));
    },
  };
}

// #247 supersedes the old request for a plain, image-free guide. Source-truth tests above remain.
describe("visual site guide (#247)", () => {
  test("[unit] #261 two entry paths: a public replay and the TokenMax journey, no Backstage invite or key", async () => {
    const html = read(GUIDE);
    const entries = await texts(html, ".entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("No account. No API key. No calls to pay for.");
    expect(entries[1]).toContain("TokenMax");
    expect(entries[1]).toContain("No account. No API key.");
    for (const entry of entries) expect(entry).not.toMatch(/backstage|invited|TypeSafe key|billed/i);
    const links = (await grab(html, [".entry a"])).get(".entry a") ?? [];
    expect(links.map(link => link.attrs.get("href"))).toEqual(["/replay/?run=uc13-100", "#tokenmax", "/tm/"]);
  });

  test("[unit] #261 the primary guide has no Backstage act walkthrough or Backstage description", async () => {
    const html = read(GUIDE);
    expect(await texts(html, ".walkthrough, .acts, .miniature")).toEqual([]);
    const meta = (await grab(html, ["meta[name='description']"])).get("meta[name='description']")?.[0]?.attrs.get("content") ?? "";
    expect(meta).not.toMatch(/backstage/i);
    const primary = html.slice(0, html.indexOf('<details id="reference"'));
    expect(primary).not.toMatch(/backstage/i);
  });

  test("[unit] #247 reference stays collapsed while every existing anchor remains addressable", async () => {
    const html = read(GUIDE);
    const disclosure = (await grab(html, ["details#reference"])).get("details#reference")?.[0];
    expect(disclosure?.attrs.has("open")).toBe(false);
    for (const id of ["jev-intro", "prepare", "label", "costs", "verdict", "example", "limits", "fields", "record-columns", "glossary", "access", "format-name", "verdict-terms", "verdict-plain"]) {
      expect((await grab(html, [`#reference #${id}`])).get(`#reference #${id}`)).toHaveLength(1);
    }
    expect(read("site/guide/guide.js")).toContain("hashchange");
    expect(read("site/guide/guide.js")).toContain("details.open = true");
    expect(read("site/guide/guide.js")).toContain("decodeURIComponent");
  });

  test("[unit] #247 direct and encoded reference deep links reveal and scroll their target", () => {
    const direct = guideNavigation("#fields");
    expect(direct.details.open).toBe(true);
    expect(direct.scrolled).toEqual(["fields"]);
    const encoded = guideNavigation("#%66ields");
    expect(encoded.details.open).toBe(true);
    expect(encoded.scrolled).toEqual(["fields"]);
  });

  test("[unit] #247 hash history and a repeated same-anchor click reopen a closed reference", () => {
    const nav = guideNavigation("");
    expect(nav.details.open).toBe(false);
    nav.navigate("#fields");
    expect(nav.details.open).toBe(true);
    nav.details.open = false;
    nav.navigate("#verdict");
    expect(nav.details.open).toBe(true);
    nav.details.open = false;
    nav.navigate("#fields");
    expect(nav.details.open).toBe(true);
    nav.details.open = false;
    nav.clickSameAnchor();
    expect(nav.details.open).toBe(true);
    expect(nav.scrolled).toEqual(["fields", "verdict", "fields", "fields"]);
  });

  test("[unit] #247 malformed, absent and primary-content anchors do not open reference or throw", () => {
    const nav = guideNavigation("#%zz");
    nav.navigate("#does-not-exist");
    nav.navigate("#choose");
    nav.navigate("");
    expect(nav.details.open).toBe(false);
    expect(nav.scrolled).toEqual([]);
  });

  test("[unit] #247 primary reading stays short and sends API questions to TypeSafe", async () => {
    const html = read(GUIDE);
    const primary = html.slice(html.indexOf("<main>"), html.indexOf('<details id="reference"'));
    const words = ((await texts(primary + "</main>", "main"))[0] ?? "").split(/\s+/);
    // 500 words before the TokenMax step-by-step list (about 230 words) was added to the primary reading.
    expect(words.length).toBeLessThanOrEqual(730);
    expect(primary).toContain('href="https://docs.typesafe.ai/introduction"');
    expect(primary).not.toContain('id="jev-intro"');
    expect(await texts(html, ".welcome .lede")).toEqual(["Your guide to using this site: watch a recorded test, or map your own Claude Code and Codex usage."]);
    for (const path of ["/little-shop/", "/replay/", "/tm/", "/maps/"]) expect(primary).toContain(`href="${path}"`);
    expect(primary).toContain("if unavailable, return later");
    expect(html).toContain("optional collapsed disclosure");
  });

  test("[unit] #247 visitor guide stays browser-only, including its collapsed reference", async () => {
    const html = read(GUIDE);
    expect(html).not.toMatch(/\bbun\b|command[- ]line|\bterminal\b|\bCLI\b|TYPESAFE_API_KEY|environment variables?|docs\/GUIDE\.md/i);
    const values = await marked(html, known());
    const catalogDate = values.filter(value => value.name === "BACKSTAGE_CATALOG_CHECKED_DATE");
    expect(catalogDate).toHaveLength(1);
    expect(catalogDate[0]?.error).toBeNull();
    expect(values.some(value => value.name === "BACKSTAGE_JEV_INPUT_USD_PER_MTOK")).toBe(true);
  });

  test("[unit] #247 playbill has responsive columns, keyboard focus and no motion requirement", () => {
    const css = read("site/guide/guide.css");
    expect(read(GUIDE)).toContain('name="viewport"');
    expect(read(GUIDE)).toContain('class="skip-link" href="#choose"');
    expect(css).toContain("#7b1424");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).not.toMatch(/animation\s*:/);
  });
});

test("[unit] CF146-B2 notice follows the room line before every step panel", async () => {
  const html = read(BACKSTAGE);
  const order = await texts(html, "main > #room-line, main > #notice, main > section[data-panel]");
  const expected = await texts(html, "#room-line, #notice");
  expect(order.slice(0, 2)).toEqual(expected);
  expect(order.length).toBe(5);
  expect(html.indexOf('id="notice"')).toBeLessThan(html.indexOf('data-panel="0"'));
});

test("[unit] CF146-B3 actionable labels use plain language alongside theatre names", async () => {
  const html = read(BACKSTAGE);
  const labels = await texts(html, "button, legend, h1, h2, h3, .confirm-title");
  const theatre = /\b(scene|casting|learning lines|rehearsals?|dress rehearsal|opening night|act|cast|players|stage note)\b/i;
  const plain = /Your question|Who answers|Your cases|Judge the answers|Cost and downloads|Verdict/;
  expect(labels.filter(label => theatre.test(label) && !plain.test(label))).toEqual([]);
  expect(html).toContain("Who answers is locked when the run starts.");
  expect((await texts(html, ".colophon a"))[0]).toBe("Send feedback");
  expect(await texts(html, "#new-scene")).toEqual(["Edit the question"]);
  expect((await texts(html, "#confirm-new-scene-title"))[0]).toBe("Start a new question?");
  expect((await texts(html, "#mode-fields legend"))[0]).toBe("Choose who answers");
  expect((await texts(html, "#confirm-reveal-title"))[0]).toBe("Show who answered and lock your labels?");
});

test("[unit] CF146-O1-O3 tutorial appears once across the whole first step and uses clear copy", async () => {
  const html = read(BACKSTAGE);
  const tutorial = "Jev answers your question with one of your two choices and how sure it is so you can test which answers to keep.";
  const first = (await texts(html, "main > .topic-entry, section[data-panel='0']")).join(" ");
  expect(first.split(tutorial).length - 1).toBe(1);
  expect((await texts(html, "#question-hint"))[0]).toBe("Not sure how to word it? Use the Question coach below.");
  expect(html).toContain('href="#question-coach"');
  expect(html).toContain("Pick the right answer for each case first. Jev's answer appears after you pick.");
  expect(html).toContain("Jev compares its answers with your labels and says whether to use it.");
  expect(html).not.toContain("kept answers");
});

test("[unit] CF146-O4 empty notice remains available to assistive technology", () => {
  const css = read("site/backstage/backstage.css");
  const rule = css.match(/#notice:empty\s*\{([^}]+)\}/)?.[1] ?? "";
  expect(rule).not.toMatch(/display\s*:\s*none/);
  expect(rule).toContain("clip-path");
});

// #222: these are actual current controls, not the historical six-room captions.
test("[integration] #222 guide explains recoverable setup, explicit case changes and remaining calls", async () => {
  const entries = await glossary(read(GUIDE));
  for (const term of ["Setup and run", "Review answers", "Results and downloads", "Judging rule (required)", "Try first case", "Run remaining cases", "Replace cases"]) {
    expect(entries.get(term)?.trim().length ?? 0).toBeGreaterThan(0);
  }
  expect(entries.get("Run remaining cases")).toContain("never attempted");
  expect(entries.get("Replace cases")).toContain("confirm");
  expect(read(GUIDE)).not.toContain("Keep an answer when...");
  expect(read(GUIDE)).not.toContain("Use these cases");
  expect(entries.get("In the workspace")).not.toContain("Six steps");
  expect(entries.get("Draft starter cases")).toContain("choose");
});
