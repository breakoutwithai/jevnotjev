// The in-product first-use guide (D18): site/guide/index.html, served at /guide/.
// Done when a new tester can follow it through the sample run without asking what a field means, so:
// - every field label and column header the sample run (site/index.html) and Backstage (site/backstage/index.html,
//   src/backstage/main.ts, site/backstage/sample-cases.csv) show has a glossary entry, extracted from the source that
//   renders it, so a new field without an entry fails here;
// - the six sections are present in order;
// - every threshold the guide states is a marked span checked against the verdict code's constants, and every sample
//   figure is a marked span checked against what the sample run shows (site/data.js) and the CLI verdict on its records.
// Dash glyphs in site/ are already gated by scripts/site-content.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_FILE_BYTES } from "../browser/results-loader.ts";
import { RESAMPLES } from "../core/calc.ts";
import { CHEAPER, MARGIN, MIN_PAIRED } from "../core/verdict.ts";
import { PRICE_TABLE, PRICE_TABLE_DATE } from "../decide/prices.ts";

const ROOT = join(import.meta.dir, "..", "..");
const GUIDE = "site/guide/index.html";
const SAMPLE_RECORDS = "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv";
// "\x3c" is "<": written escaped where a pattern opens a heading tag.
const OWN_FILE_TITLE = /\x3ch3 id="t6">([^<]+)<\/h3>/;
const SECTION_OPEN = /\x3ch2\b[^>]*>/;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Visible text of an HTML fragment: tags dropped, the entities this site uses decoded, whitespace collapsed. */
function flat(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function capture(pattern: RegExp, text: string): string {
  const found = pattern.exec(text)?.[1];
  if (found === undefined) throw new Error(`not found: ${pattern}`);
  return found;
}

function all(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((match) => flat(match[1] ?? ""));
}

interface Field {
  readonly term: string;
  readonly source: string;
}

/** Every extractor must find something, so a refactor of the page cannot empty the check and still pass. */
function fields(source: string, name: string, terms: readonly string[]): Field[] {
  if (terms.length === 0) throw new Error(`${name}: no fields extracted from ${source}`);
  return terms.map((term) => ({ term, source }));
}

/** Labels and headers the sample run shows on site/index.html, read from the markup and the script that renders it. */
function sampleRunFields(): Field[] {
  const src = "site/index.html";
  const html = read(src);
  const ledger = capture(/\$\("ledger"\)\.innerHTML = ([\s\S]*?)\$\("versus"\)/, html);
  const ruleLine = /\$\("ruleLine"\)\.textContent = "(\w+) " \+ [^+]+\+ " (\w+)"/.exec(html);
  if (ruleLine === null) throw new Error("rule line not found");
  return [
    ...fields(src, "sample badge", [capture(/<div class="sample"[^>]*><span>([^<]+)<\/span>/, html)]),
    ...fields(src, "players", all(/:\s*"([^"]+)"/g, capture(/var ARM_NAME = \{([^}]*)\}/, html))),
    ...fields(src, "docket header", all(/<span[^>]*>([^<]+)<\/span>/g, capture(/<li class="case head"[^>]*>([\s\S]*?)<\/li>/, html))),
    ...fields(src, "answer marks", [...(/\? "(\w+)" : "(\w+)"\) \+ '<\/span><\/span>'/.exec(html) ?? []).slice(1)]),
    ...fields(src, "label tag", [capture(/title="The label\\'s answer">(\w+):/, html)]),
    ...fields(src, "spotlight", [capture(/class="monologue"><b>([^<]+)<\/b>/, html)]),
    ...fields(src, "tally", [capture(/<span class="t-label">([^<]+)<\/span>/, html)]),
    ...fields(src, "ledger", all(/<dt>([^<]+)<\/dt>/g, ledger)),
    ...fields(src, "timing table", all(/<th>([^<]+)<\/th>/g, capture(/var bh = ([^\n]*)/, html))),
    ...fields(src, "verdict words", all(/:\s*"([^"]+)"/g, capture(/var VWORD = \{([^}]*)\}/, html))),
    ...fields(src, "rule line", [`${ruleLine[1] ?? ""} N ${ruleLine[2] ?? ""}`]),
    ...fields(src, "own file", [capture(OWN_FILE_TITLE, html)]),
  ];
}

/** Labels, rooms, buttons and table headers a tester sees in Backstage. */
function backstageFields(): Field[] {
  const page = "site/backstage/index.html";
  const html = read(page);
  const main = capture(/<main>([\s\S]*?)<\/main>/, html);
  const rooms = capture(/<nav aria-label="Backstage rooms" id="rooms">([\s\S]*?)<\/nav>/, html);
  const note = flat(capture(/id="label-column-note">([\s\S]*?)<\/p>/, html));
  const labelColumns = [capture(/add a (\w+) column/, note), ...capture(/then ([\w, ]+?)\./, note).split(/, | and /)];
  const script = "src/backstage/main.ts";
  const ts = read(script);
  const csv = "site/backstage/sample-cases.csv";
  return [
    ...fields(page, "rooms", [...rooms.matchAll(/<span>([^<]+)<\/span>\s*<small class="job">([^<]+)<\/small>/g)].map((m) => `${m[1] ?? ""}: ${m[2] ?? ""}`)),
    ...fields(page, "form labels", all(/<label\b[^>]*>([\s\S]*?)<\/label\s*>/g, main).map((label) => label.replace(/\(optional\)/, "").trim())),
    ...fields(page, "pick buttons", all(/<button[^>]*>([\s\S]*?)<\/button\s*>/g, capture(/<div class="actions" id="pick-actions"[^>]*>([\s\S]*?)<\/div>/, html))),
    ...fields(page, "downloads", [flat(capture(/<button id="download-csv"[^>]*>([\s\S]*?)<\/button\s*>/, html)), flat(capture(/<button id="download-evidence"[^>]*>([\s\S]*?)<\/button\s*>/, html))]),
    ...fields(page, "label columns", labelColumns),
    ...fields(csv, "cases file header", (read(csv).split("\n")[0] ?? "").split(",").filter((name) => name !== "")),
    ...fields(script, "tables", [...ts.matchAll(/table\(\s*\[([^\]]*)\]/g)].flatMap((m) => all(/"([^"]+)"/g, m[1] ?? ""))),
    ...fields(script, "results lines", [
      capture(/"(Total actual attempts):/, ts),
      capture(/" (paired labelled cases);/, ts),
      ...all(/"[^"]*?((?:Jev|other)-only wins) "/g, ts),
      capture(/"(Per-pair, uncorrected comparison)\./, ts),
    ]),
  ];
}

function glossary(html: string): Map<string, string> {
  const list = capture(/<dl id="glossary"[^>]*>([\s\S]*?)<\/dl>/, html);
  const out = new Map<string, string>();
  for (const match of list.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) out.set(flat(match[1] ?? ""), flat(match[2] ?? ""));
  return out;
}

/** The constants a guide span may name, each with the text the guide must show for it. */
function constants(): Map<string, string> {
  const jev = PRICE_TABLE.find((entry) => entry.arm === "jev");
  if (jev === undefined) throw new Error("no Jev price");
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
  ]);
}

// ---------- The sample run, as the page shows it ----------

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

function sampleValues(): Map<string, string> {
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
  const out = new Map<string, string>([
    ["cases", String(cases.length)],
    ["truth-answer", String(cases.filter((c) => str(c, "truth") === "answer").length)],
    ["truth-hand_off", String(cases.filter((c) => str(c, "truth") === "hand_off").length)],
    ["spot-id", str(spot, "id")],
    ["spot-confidence", num(spot, "arms", "C", "confidence").toFixed(2)],
    ["save-vs-a", ((1 - cpkC / cpkA) * 100).toFixed(0)],
    ["verdict-rule", String(num(sample, "verdict", "rule"))],
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
  if (str(sample, "verdict", "result") !== str(v, "verdict") || num(sample, "verdict", "rule") !== num(v, "rule")) {
    throw new Error("the page's sample verdict and the CLI verdict on its records differ");
  }
  return out;
}

/** The guide's sections, split at each level-two heading. */
function sections(html: string): { readonly heading: string; readonly body: string }[] {
  return html
    .split(SECTION_OPEN)
    .slice(1)
    .map((part) => {
      const end = part.indexOf("</h2>");
      return { heading: flat(part.slice(0, end)), body: part.slice(end + 5) };
    });
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

describe("in-product first-use guide (D18)", () => {
  test("[unit] D18-SITE-GUIDE-GLOSSARY every field the sample run and Backstage show has a glossary entry", () => {
    const entries = glossary(read(GUIDE));
    const wanted = [...sampleRunFields(), ...backstageFields()];
    const missing = wanted.filter((field) => !entries.has(field.term)).map((field) => `${field.term} (${field.source})`);
    expect(missing).toEqual([]);
    for (const [term, meaning] of entries) expect(`${term}: ${meaning.length}`).not.toBe(`${term}: 0`);
  });

  test("[unit] D18-SITE-GUIDE-EXTRACT the extractors read the real pages, so the glossary check is not vacuous", () => {
    const sample = sampleRunFields().map((field) => field.term);
    const backstage = backstageFields().map((field) => field.term);
    for (const term of ["What you do now", "Jev said", "Cost per kept answer", "Median seconds per call", "Not enough evidence", "Rule N fired", "kept", "rejected"]) {
      expect(sample).toContain(term);
    }
    for (const term of ["Keep an answer when...", "Dress Rehearsal: Cost and downloads", "Kept / labelled", "Returned confidence", "case_input", "label_source", "Jev-only wins"]) {
      expect(backstage).toContain(term);
    }
  });

  test("[unit] D18-SITE-GUIDE-SECTIONS the six sections and the glossary come in order", () => {
    expect(sections(read(GUIDE)).map((section) => section.heading)).toEqual(SECTION_HEADINGS);
  });

  test("[unit] D18-SITE-GUIDE-CONSTANTS every threshold the guide states is the verdict code's constant", () => {
    const html = read(GUIDE);
    const known = constants();
    const spans = [...html.matchAll(/<span data-const="([A-Z_]+)">([^<]*)<\/span>/g)];
    const named = new Set(spans.map((span) => span[1] ?? ""));
    for (const required of ["MIN_PAIRED", "MARGIN_POINTS", "MARGIN_BOUND", "CHEAPER", "CHEAPER_PERCENT", "RESAMPLES"]) expect(named).toContain(required);
    for (const span of spans) expect(`${span[1]}=${span[2]}`).toBe(`${span[1]}=${known.get(span[1] ?? "") ?? "unknown constant"}`);
  });

  test("[integration] D18-SITE-GUIDE-SAMPLE every sample figure in the guide is what the sample run shows", () => {
    const html = read(GUIDE);
    const known = sampleValues();
    const spans = [...html.matchAll(/<span data-sample="([\w-]+)">([^<]*)<\/span>/g)];
    expect(spans.length).toBeGreaterThan(10);
    for (const span of spans) expect(`${span[1]}=${span[2]}`).toBe(`${span[1]}=${known.get(span[1] ?? "") ?? "unknown sample value"}`);
  }, 30000);

  test("[unit] D18-SITE-GUIDE-NUMBERS the verdict and worked-example sections state no number outside a checked span", () => {
    const html = read(GUIDE);
    const checked = sections(html).filter((s) => s.heading.startsWith("4.") || s.heading.startsWith("5."));
    expect(checked.length).toBe(2);
    for (const section of checked) {
      const unchecked = flat(section.body.replace(/<span data-(?:const|sample)="[\w-]+">[^<]*<\/span>/g, " "))
        .replace(/\bm\d{2}\b/g, " ")
        .match(/\d[\d.,]*/g);
      expect(`${section.heading}: ${unchecked?.join(" ") ?? ""}`).toBe(`${section.heading}: `);
    }
  });

  test("[unit] D18-SITE-GUIDE-LINKS the sample run, Backstage and the CLI guide link to /guide/", () => {
    expect(read("site/index.html")).toContain('href="guide/"');
    expect(read("site/backstage/index.html")).toContain('href="/guide/"');
    expect(read("docs/GUIDE.md")).toContain("](../site/guide/index.html)");
  });
});
