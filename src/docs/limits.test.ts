// docs/LIMITS.md is rendered whole from CLAIMS; any edit to the doc, or to a quoted source, fails here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { CHEAPER, MARGIN, MIN_PAIRED, TEST_SET_ONLY } from "../core/verdict.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DOC_PATH = "docs/LIMITS.md";

interface Quote { readonly source: string; readonly text: string }
interface Claim { readonly id: string; readonly section: 1 | 2 | 3 | 4; readonly text: string; readonly quotes: readonly Quote[] }
type Reader = (path: string) => string | null;

const POINTS = Math.round(MARGIN * 100);
const VR = "docs/decision/verdict-rules.md";
const FMT = "format/README.md";
const REL = "docs/RELEASE-v0.1.0.md";
const PRIV = "site/privacy/index.html";
const STORED = "docs/product/what-is-stored.md";

const TITLE = "# Known limits (v0)";
const INTRO = "What a Jev!Jev verdict covers, what it needs, and what is not supported or tested. Each bullet states one limit and links the file it comes from. `src/docs/limits.test.ts` fails if a bullet changes or its source no longer contains the quoted text.";
const HEADINGS = [
  "## 1. What the verdict establishes and what it does not",
  "## 2. Evidence required",
  "## 3. Unsupported or untested",
  "## 4. Data and trust",
];

const CLAIMS: readonly Claim[] = [
  { id: "test-set-only", section: 1, text: TEST_SET_ONLY, quotes: [{ source: VR, text: "The verdict describes the builder's test set, not production." }] },
  { id: "use-jev-accuracy", section: 1, text: `Use Jev means the 95% interval puts Jev's accept rate less than ${POINTS} points below the LLM's; it does not mean Jev is as accurate.`, quotes: [{ source: VR, text: `lower bound of (Jev minus LLM) above -${MARGIN.toFixed(2)}` }, { source: VR, text: "Confidence level | 95%" }] },
  { id: "use-jev-cost", section: 1, text: `Use Jev also needs Jev's cost per accepted answer to be ${CHEAPER} or less of the LLM's, with the 95% upper bound of that ratio below 1.`, quotes: [{ source: VR, text: `cost ratio ${CHEAPER} or less, and its upper bound below 1` }] },
  { id: "use-jev-rule", section: 1, text: `When the rule is compared, a 95% interval that puts the rule's accept rate less than ${POINTS} points below Jev's gives don't use Jev; a free rule that does the job wins.`, quotes: [{ source: VR, text: `lower bound of (rule minus Jev) above -${MARGIN.toFixed(2)}` }, { source: VR, text: "A free rule that does the job wins." }, { source: VR, text: "**Don't use Jev** when any of these holds" }] },
  { id: "simulation", section: 1, text: `In the simulation behind the settings, which assumes an outcome correlation of 0.5 and an LLM accept rate of 0.8 or 0.9, a Jev exactly ${POINTS} points worse than the LLM most often gets not enough evidence at ${MIN_PAIRED} paired cases.`, quotes: [{ source: VR, text: "Outcome correlation between Jev and the LLM 0.5, an assumption." }, { source: VR, text: `When Jev is exactly ${POINTS} points worse, it wrongly reaches "use Jev" in 3% of test sets or fewer at every n. The rule leans towards "not enough evidence"; at ${MIN_PAIRED} cases that is the most common result.` }, { source: VR, text: "low accept rates (p_llm below 0.8)" }] },
  { id: "no-case-count", section: 1, text: `Beyond the ${MIN_PAIRED}-case minimum, the verdict does not say how many more cases would settle it.`, quotes: [{ source: VR, text: `The only count the screen gives is rule 1's: ${MIN_PAIRED} minus the paired cases.` }] },
  { id: "dropped-rows", section: 1, text: "A refused, failed or unsupported answer has no label and drops out of the pairing, so the verdict's accept rates and cost per accepted answer leave it out; the answerer's row count and total cost still include it.", quotes: [{ source: FMT, text: "there is no answer to judge, so it is never counted as right or wrong" }, { source: VR, text: "Unlabelled rows are left out of every count." }, { source: FMT, text: "It still counts in `rows` and in cost" }, { source: VR, text: "For one answerer X on the paired cases" }] },
  { id: "agent-labels", section: 1, text: "An agent label that nobody reviewed is never counted as truth.", quotes: [{ source: FMT, text: "An `agent` label was never reviewed by a person, so it is never counted as truth" }] },
  { id: "labels-as-recorded", section: 1, text: "The results page shows labels and costs as recorded in the file and does not check how they were produced.", quotes: [{ source: "scripts/result-view.ts", text: "Labels and costs are shown as recorded in the file; this page does not check how they were produced." }] },
  { id: "decisions-arm", section: 1, text: "Decisions API answers are recorded, but the verdict reads Jev, the LLM and the rule only.", quotes: [{ source: FMT, text: "The verdict and metrics (`src/core/`) read llm, rule and jev only." }] },

  { id: "labelled-record", section: 2, text: "A labelled test file in the jnj-record format.", quotes: [{ source: VR, text: "labelled test file (`jnj-record/1`" }] },
  { id: "min-paired", section: 2, text: `At least ${MIN_PAIRED} paired labelled Jev and LLM cases; fewer gives not enough evidence.`, quotes: [{ source: VR, text: `fewer than ${MIN_PAIRED} paired labelled cases between Jev and the LLM` }] },
  { id: "cost-required", section: 2, text: "A cost_usd on every paired Jev and LLM row; a missing one gives not enough evidence.", quotes: [{ source: VR, text: "any `cost_usd` missing on a paired Jev or LLM row" }] },
  { id: "rule-skipped", section: 2, text: `With no rule rows or fewer than ${MIN_PAIRED} paired rule cases, the rule comparison is skipped and the verdict comes from Jev against the LLM only.`, quotes: [{ source: VR, text: "The rule comparison is skipped and the screen says so; the verdict comes from Jev against the LLM." }, { source: VR, text: `Skipped when there are fewer than ${MIN_PAIRED} paired rule cases or no rule rows.` }] },

  { id: "sim-untested", section: 3, text: `The simulation does not cover true drops above ${POINTS} points, LLM accept rates below 0.8 or missing labels.`, quotes: [{ source: VR, text: `The sim does not cover true drops above ${MARGIN.toFixed(2)}, low accept rates (p_llm below 0.8), or missing labels.` }] },
  { id: "two-answer-choice", section: 3, text: "Backstage tests only a Choice question with exactly two answers (issue #122).", quotes: [{ source: "src/backstage/contracts.ts", text: "readonly choices: readonly [Choice, Choice];" }] },
  { id: "text-inputs", section: 3, text: "Inputs are text cases.", quotes: [{ source: REL, text: "Version 1 inputs are text cases." }] },
  { id: "release-recorded", section: 3, text: "The release check (`bun scripts/release-check.ts`) uses a recorded Jev response for `run` and makes no paid provider call.", quotes: [{ source: REL, text: "It uses a recorded Jev response for `run` and makes no paid provider call." }] },
  { id: "release-no-http", section: 3, text: "The release check does not exercise the HTTP surface. With `--url` it compares only the static site's `/DEPLOYED_SHA` to the candidate commit and does not check the backend or any other module.", quotes: [{ source: REL, text: "The check does not exercise the HTTP surface" }, { source: "docs/RELEASE-CHECKLIST.md", text: "`served sha` checks the static site's `/DEPLOYED_SHA` only." }, { source: "docs/RELEASE-CHECKLIST.md", text: "It does not check the backend or any other module of the stack." }] },

  { id: "made-up-cases", section: 4, text: "Use made-up or redacted cases: a case you run goes to each provider you select.", quotes: [{ source: PRIV, text: "Use made-up or redacted cases." }, { source: PRIV, text: "A case you run goes to each provider you select." }] },
  { id: "no-server-save", section: 4, text: "Backstage does not save cases, runs or keys to a file or database on the server.", quotes: [{ source: PRIV, text: "Backstage does not save your cases, runs or keys to a file or database on our server." }] },
  { id: "relay-buffer", section: 4, text: "Requests pass through the server and its web server may hold requests briefly while relaying.", quotes: [{ source: PRIV, text: "its web server may hold them briefly while relaying" }] },
  { id: "draft-in-tab", section: 4, text: "An unfinished scene draft is saved in the browser tab's storage.", quotes: [{ source: PRIV, text: "Your unfinished scene draft, including cases and question text, is saved in this browser tab's storage." }] },
  { id: "server-keeps", section: 4, text: "Among other records, the server keeps ticket-form details including your email, an operators file of sign-in emails and password hashes, and event logs with sign-in email and IP address; the privacy page section What we keep has the rest.", quotes: [{ source: PRIV, text: "What we keep" }, { source: PRIV, text: "the form puts your ticket number, submission time, ticket type, email" }, { source: PRIV, text: "an operators file on our server holds approved email addresses" }, { source: PRIV, text: "They contain sign-in email and IP address" }] },
  { id: "deletion", section: 4, text: "The ticket office has no automatic or self-service deletion: an operator deletes a ticket row on request.", quotes: [{ source: PRIV, text: "An operator must handle the request because the code has no self-service deletion route." }, { source: PRIV, text: "The ticket office has no automatic deletion." }] },
  { id: "scan-shapes", section: 4, text: "The evidence export check matches listed key shapes and exact supplied key values; a key in another shape that was not supplied, such as a Jev key, is not caught.", quotes: [{ source: STORED, text: "A key in a shape not listed is not caught. That includes the Jev key" }, { source: STORED, text: "Optional `knownKeys` are also searched for exact values" }, { source: STORED, text: "`evidence()` refuses a run once `containsKey()` has found a supplied key value" }] },
  { id: "export-check", section: 4, text: "The evidence export check tests reproducibility and looks for leaked credentials; it does not prove an export is authentic.", quotes: [{ source: STORED, text: "It is a reproducibility and no-credentials check, not an authenticity check." }] },
  { id: "provider-retention", section: 4, text: "Retention and deletion policies of model providers and other infrastructure are unknown beyond the application code.", quotes: [{ source: PRIV, text: "We do not know the retention and deletion policies of model providers or other infrastructure beyond the application code." }] },
];

function norm(text: string): string { return text.replace(/\s+/g, " ").trim(); }
// A quote holds only as whole words: "below 1" must not match "below 1.5", and "30 paired" must not match "130 paired".
function holds(source: string, quote: string): boolean {
  const s = norm(source);
  const q = norm(quote);
  for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + 1)) {
    const before = s.slice(Math.max(0, i - 1), i);
    const after = s.slice(i + q.length, i + q.length + 2);
    if (!/\w/.test(before) && !/^(?:\w|\.\d)/.test(after)) return true;
  }
  return false;
}
function unsafe(path: string): boolean {
  return path.length === 0 || isAbsolute(path) || path.startsWith("~") || path.includes("\\") || path.split("/").includes("..");
}

function render(claims: readonly Claim[]): string {
  const lines: string[] = [TITLE, "", INTRO];
  HEADINGS.forEach((heading, i) => {
    lines.push("", heading, "");
    for (const c of claims.filter((x) => x.section === i + 1)) {
      const first = c.quotes[0];
      const link = first === undefined ? "" : posix.relative(posix.dirname(DOC_PATH), first.source);
      lines.push(`- ${c.text} [Source](${link}) <!-- claim: ${c.id} -->`);
    }
  });
  return `${lines.join("\n")}\n`;
}

/** Every problem found; empty means the doc equals the rendered claims and every quote is in its source. */
function check(docText: string, read: Reader, claims: readonly Claim[] = CLAIMS): string[] {
  const problems: string[] = [];
  const want = render(claims).split("\n");
  const got = docText.split("\n");
  if (want.length !== got.length) problems.push("line count differs");
  for (let i = 0; i < Math.min(want.length, got.length); i++) {
    if (want[i] !== got[i]) { problems.push(`line ${i + 1} differs`); break; }
  }
  const seen = new Set<string>();
  for (const c of claims) {
    if (seen.has(c.id)) problems.push(`duplicate id: ${c.id}`);
    seen.add(c.id);
    for (const q of c.quotes) {
      if (unsafe(q.source)) { problems.push(`unsafe path: ${c.id}`); continue; }
      const src = read(q.source);
      if (src === null) { problems.push(`missing source: ${c.id} ${q.source}`); continue; }
      if (!holds(src, q.text)) problems.push(`quote missing: ${c.id}`);
    }
  }
  return problems;
}

function realRead(path: string): string | null {
  if (unsafe(path)) return null;
  try { return readFileSync(join(ROOT, path), "utf8"); } catch { return null; }
}
const doc = readFileSync(join(ROOT, DOC_PATH), "utf8");

/** Replace the first occurrence; the needle must exist so a control cannot pass by changing nothing. */
function edit(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}
function lineNo(text: string, needle: string): number {
  return text.split("\n").findIndex((l) => l.includes(needle)) + 1;
}

describe("known limits (v0)", () => {
  test("[unit] the real doc equals the rendered claims and every quote is in its source", () => {
    expect(check(doc, realRead)).toEqual([]);
  });
  test("[unit] every claim has at least one quote", () => {
    for (const c of CLAIMS) expect(c.quotes.length).toBeGreaterThan(0);
  });
  test("[unit] public hygiene: no session links, challenge talk or dashes in visible text (paths: public-scan before push)", () => {
    const visible = doc.replace(/<!--[\s\S]*?-->/g, "");
    expect(visible).not.toMatch(/claude\.ai|winning|leaderboard|\brank|portal|skool|challenge/i);
    expect(visible.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(visible.includes(String.fromCharCode(0x2013))).toBe(false);
  });

  test("[unit] control: a removed claim comment is reported", () => {
    const mutated = edit(doc, " <!-- claim: min-paired -->", "");
    expect(check(mutated, realRead)).toContain(`line ${lineNo(doc, "claim: min-paired")} differs`);
  });
  test("[unit] control: an extra uncited bullet is reported", () => {
    const mutated = edit(doc, "## 2. Evidence required\n\n", "## 2. Evidence required\n\n- A new limit with no source.\n");
    const problems = check(mutated, realRead);
    expect(problems).toContain("line count differs");
    expect(problems).toContain(`line ${lineNo(doc, "## 2. Evidence required") + 2} differs`);
  });
  test("[unit] control: a bullet's 30 changed to 20 is reported", () => {
    const n = lineNo(doc, "claim: min-paired");
    const mutated = doc.split("\n").map((l, i) => (i + 1 === n ? l.replace("30", "20") : l)).join("\n");
    expect(mutated).not.toBe(doc);
    expect(check(mutated, realRead)).toContain(`line ${n} differs`);
  });
  test("[unit] control: a word changed in a bullet with no number is reported", () => {
    const n = lineNo(doc, "claim: agent-labels");
    const mutated = edit(doc, "nobody reviewed", "somebody reviewed");
    expect(check(mutated, realRead)).toContain(`line ${n} differs`);
  });
  test("[unit] control: an edited intro is reported", () => {
    const mutated = edit(doc, "what is not supported or tested", "what is supported");
    expect(check(mutated, realRead)).toContain(`line ${lineNo(doc, "What a Jev!Jev verdict covers")} differs`);
  });
  test("[unit] control: an edited heading is reported", () => {
    const mutated = edit(doc, "## 3. Unsupported or untested", "## 3. Unsupported");
    expect(check(mutated, realRead)).toContain(`line ${lineNo(doc, "## 3. ")} differs`);
  });
  test("[unit] control: a changed link target is reported", () => {
    const n = lineNo(doc, "claim: min-paired");
    const mutated = edit(doc, "[Source](decision/verdict-rules.md) <!-- claim: min-paired", "[Source](decision/other.md) <!-- claim: min-paired");
    expect(check(mutated, realRead)).toContain(`line ${n} differs`);
  });
  test("[unit] control: a quote removed from its source is reported", () => {
    const victim = CLAIMS.find((c) => c.id === "cost-required");
    const quote = victim?.quotes[0];
    expect(quote).toBeDefined();
    const fake: Reader = (p) => {
      const real = realRead(p);
      return real === null || p !== quote?.source ? real : norm(real).split(norm(quote.text)).join("");
    };
    expect(check(doc, fake)).toContain("quote missing: cost-required");
  });
  test("[unit] control: a quote that survives only as part of a longer number is reported", () => {
    const fake: Reader = (p) => {
      const real = realRead(p);
      return real === null || p !== VR ? real : real.split("and its upper bound below 1").join("and its upper bound below 1.5");
    };
    expect(check(doc, fake)).toContain("quote missing: use-jev-cost");
  });
  test("[unit] control: a reader returning null for a source is reported", () => {
    const fake: Reader = (p) => (p === STORED ? null : realRead(p));
    expect(check(doc, fake)).toContain(`missing source: export-check ${STORED}`);
  });
  test("[unit] control: a duplicated id is reported", () => {
    const first = CLAIMS[0];
    expect(first).toBeDefined();
    const claims = first === undefined ? CLAIMS : [...CLAIMS, first];
    expect(check(doc, realRead, claims)).toContain(`duplicate id: ${first?.id}`);
  });
  test("[unit] control: an absolute or climbing source path is reported", () => {
    for (const bad of ["/etc/hosts", "../outside.md"]) {
      const claims = CLAIMS.map((c) => (c.id === "cost-required" ? { ...c, quotes: [{ source: bad, text: "x" }] } : c));
      expect(check(doc, realRead, claims)).toContain("unsafe path: cost-required");
    }
  });
});
