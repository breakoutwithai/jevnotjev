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
import { MODEL_CATALOG } from "../backstage/catalog.ts";
import { KEY_FIELD_NAMES } from "../backstage/run-gate.ts";
import { MAX_FILE_BYTES } from "../browser/results-loader.ts";
import { RESAMPLES } from "../core/calc.ts";
import { CHEAPER, MARGIN, MIN_PAIRED } from "../core/verdict.ts";
import { PRICE_TABLE, PRICE_TABLE_DATE } from "../decide/prices.ts";

const ROOT = join(import.meta.dir, "..", "..");
const GUIDE = "site/guide/index.html";
const STAGE = "site/index.html";
const BACKSTAGE = "site/backstage/index.html";
const SAMPLE_RECORDS = "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv";

function read(path: string): string {
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

/** Labels and headers the sample run shows, from site/index.html's markup and the markup its script builds. */
async function sampleRunFields(html: string): Promise<Field[]> {
  const src = STAGE;
  const built = scriptMarkup(html, "ARM_NAME");
  const g = await grab(built, ["li.case.head span", "dl.fig dt", "thead th", "p.monologue b", "span.t-label", "span.truth"]);
  const page = await grab(html, ["div.sample > span", "#t6"]);
  const list = (map: Map<string, Grabbed[]>, selector: string): string[] => (map.get(selector) ?? []).map((x) => x.text);
  const marks = /\? "(\w+)" : "(\w+)"\) \+ '<\/span><\/span>'/.exec(html);
  const ruleLine = /\$\("ruleLine"\)\.textContent = "(\w+) " \+ [^+]+\+ " (\w+)"/.exec(html);
  if (marks === null || ruleLine === null) throw new Error("answer marks or rule line not found");
  return [
    ...fields(src, "sample badge", list(page, "div.sample > span")),
    ...fields(src, "players", objectValues(html, "ARM_NAME")),
    ...fields(src, "docket header", list(g, "li.case.head span")),
    ...fields(src, "answer marks", [marks[1] ?? "", marks[2] ?? ""]),
    ...fields(src, "label tag", list(g, "span.truth").map((t) => t.replace(/:.*$/, ""))),
    ...fields(src, "spotlight", list(g, "p.monologue b")),
    ...fields(src, "tally", list(g, "span.t-label")),
    ...fields(src, "ledger", list(g, "dl.fig dt")),
    ...fields(src, "timing table", list(g, "thead th")),
    ...fields(src, "verdict words", objectValues(html, "VWORD")),
    ...fields(src, "rule line", [`${ruleLine[1] ?? ""} N ${ruleLine[2] ?? ""}`]),
    ...fields(src, "own file", list(page, "#t6")),
  ];
}

/** Labels, rooms, buttons and table headers a tester sees in Backstage. */
async function backstageFields(html: string): Promise<Field[]> {
  const page = BACKSTAGE;
  const g = await grab(html, ["nav#rooms button > span", "nav#rooms button > small.job", "main label", "#pick-actions button", "#download-csv", "#download-evidence", "#label-column-note"]);
  const list = (selector: string): string[] => (g.get(selector) ?? []).map((x) => x.text);
  const names = list("nav#rooms button > span");
  const jobs = list("nav#rooms button > small.job");
  const note = list("#label-column-note")[0] ?? "";
  const labelColumns = [capture(/add a (\w+) column/, note), ...capture(/then ([\w, ]+?)\./, note).split(/, | and /)];
  const script = "src/backstage/main.ts";
  const ts = read(script);
  const csv = "site/backstage/sample-cases.csv";
  return [
    ...fields(page, "rooms", names.map((name, i) => `${name}: ${jobs[i] ?? ""}`)),
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
  const wanted = [...(await sampleRunFields(stageHtml)), ...(await backstageFields(backstageHtml))];
  return wanted.filter((field) => !entries.has(field.term)).map((field) => `${field.term} (${field.source})`);
}

// ---------- Known values: code constants and the sample run ----------

function constants(): Map<string, string> {
  const jev = PRICE_TABLE.find((entry) => entry.arm === "jev");
  const backstageJev = MODEL_CATALOG.find((entry) => entry.provider === "jev");
  if (jev === undefined || backstageJev?.pricing == null) throw new Error("no Jev price");
  return new Map([
    ["MIN_PAIRED", String(MIN_PAIRED)],
    ["MARGIN_POINTS", String(Math.round(MARGIN * 100))],
    ["MARGIN_BOUND", (-MARGIN).toFixed(2)],
    ["CHEAPER", String(CHEAPER)],
    ["CHEAPER_PERCENT", String(Math.round((1 - CHEAPER) * 100))],
    ["RESAMPLES", RESAMPLES.toLocaleString("en-US")],
    ["MAX_FILE_MB", String(MAX_FILE_BYTES / 1024 / 1024)],
    ["PRICE_TABLE_DATE", PRICE_TABLE_DATE],
    ["JEV_INPUT_USD_PER_MTOK", String(jev.inputUsdPerMTok)],
    ["BACKSTAGE_JEV_INPUT_USD_PER_MTOK", String(backstageJev.pricing.inputUsdPerMillion)],
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
  const vword = new Map(objectValues(read(STAGE), "VWORD").map((word) => [word.toLowerCase(), word]));
  const out = new Map<string, string>([
    ["cases", String(cases.length)],
    ["truth-answer", String(cases.filter((c) => str(c, "truth") === "answer").length)],
    ["truth-hand_off", String(cases.filter((c) => str(c, "truth") === "hand_off").length)],
    ["spot-id", str(spot, "id")],
    ["spot-confidence", num(spot, "arms", "C", "confidence").toFixed(2)],
    ["save-vs-a", ((1 - cpkC / cpkA) * 100).toFixed(0)],
    ["verdict-word", vword.get(verdictName) ?? `no VWORD for ${verdictName}`],
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
 * Numbers that may appear unmarked anywhere in the guide, each as the exact phrase it sits in. None is a threshold
 * or a sample figure; anything else with a digit must be a validated mark.
 */
const UNRELATED_NUMBERS: readonly (readonly [string, string])[] = [
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
  ["P1 to P4 come with 10 labelled cases and P5 to P8 with 30 cases", "starter packs, quoted from New Scene"],
  ["starts with 5 practice cases", "calibration, quoted from Rehearsals"],
  ["one kept and one rejected answer at $1 each cost $2 per kept answer", "arithmetic example"],
  ["about 1 to 4 bytes of your text", "estimate basis, quoted from Learning Lines"],
  ["A simple rule costs $0.", "a rule makes no call"],
  ["jnj-record/1", "format name"],
  ["(0.00003242, not", "cost_usd format example"],
  ["Use 0 for a rule", "cost_usd format example"],
  ["both cost $0 per kept answer", "cost guard"],
  ["(m01, m02 and so on", "case ids"],
  ["confidence from 0 to 1", "confidence scale"],
  ["\"undefined (0 kept)\"", "Stage text, quoted"],
  ["Room 1:", "room number"],
  ["Room 2:", "room number"],
  ["Room 3:", "room number"],
  ["Room 4:", "room number"],
  ["Room 5:", "room number"],
  ["Room 6:", "room number"],
  ["such as c1.", "sample cases file id"],
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
    for (const term of ["Sample run", "What you do now", "Case", "Jev said", "label", "Spotlight", "Kept so far", "Cost per kept answer", "Median seconds per call", "Not enough evidence", "Rule N fired", "kept", "rejected", "Load your own script (CSV)"]) {
      expect(sample).toContain(term);
    }
    for (const term of ["Keep an answer when...", "Leave out...", "Choose optional comparisons", "Dress Rehearsal: Cost and downloads", "First choice", "Download run evidence", "Kept / labelled", "Returned confidence", "case_input", "label_source", "Jev-only wins", "Anthropic API key", "xAI API key"]) {
      expect(backstage).toContain(term);
    }
  });

  test("[unit] D18-SITE-GUIDE-NESTED a header with nested markup is a field, so a new one without an entry fails", async () => {
    const stage = mutate(read(STAGE), "<span>Case</span>", "<span>Case</span><span><b>New unexplained field</b></span>");
    expect(await glossaryMissing(read(GUIDE), stage, read(BACKSTAGE))).toEqual(["New unexplained field (site/index.html)"]);
  });

  test("[unit] D18-SITE-GUIDE-SECTIONS the six sections and the glossary come in order", async () => {
    expect(await texts(read(GUIDE), "main h2")).toEqual(SECTION_HEADINGS);
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
    const wrongVerdict = mutate(guide, '<span data-sample="verdict-word">Not enough evidence</span>', '<span data-sample="verdict-word">Use Jev</span>');
    expect(await errors(wrongVerdict)).toEqual(["sample verdict-word shows Use Jev, code says Not enough evidence"]);
    // A marked value wrapped in nested markup is still read and checked.
    const nested = mutate(guide, '<span data-const="CHEAPER">0.8</span>', '<span data-const="CHEAPER"><b>0.9</b></span>');
    expect(await errors(nested)).toEqual(["const CHEAPER shows 0.9, code says 0.8"]);
    // A mark on anything but a span is refused.
    const notSpan = mutate(guide, '<span data-sample="cases">40</span>', '<b data-sample="cases">40</b>');
    expect(await errors(notSpan)).toEqual(["mark on <b> cases: use one data-const or data-sample on a span"]);
  }, 30000);

  test("[unit] D18-SITE-GUIDE-LINKS the sample run, Backstage and the CLI guide link to /guide/", () => {
    expect(read(STAGE)).toContain('href="guide/"');
    expect(read(BACKSTAGE)).toContain('href="/guide/"');
    expect(read("docs/GUIDE.md")).toContain("](../site/guide/index.html)");
  });
});
