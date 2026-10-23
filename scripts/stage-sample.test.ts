// F2: the public Stage's sample is the recorded shop-bot run, not the dropped prompt-router premise (Haiku, Sonnet,
// Opus, dropped 2026-09-28; FLOW.md). site/data.js is generated from the run's records.csv, and the page's own script
// renders Acts II to V from it without a router word or a made-up number.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { evaluateText } from "../src/browser/results-loader.ts";
import { validate } from "../src/format/validate.ts";
import { armTotal, build, buildSample, sampleScript, SAMPLE_OUT, SAMPLE_RECORDS, type StageSample, type StageCase } from "./stage-sample.ts";

const ROOT = join(import.meta.dir, "..");
const SITE = join(ROOT, "site");

/** Only model names in the recorded data and the exact explained-copy model labels may mention Haiku. */
const ROUTER = /haiku|sonnet|opus|\brouter\b/i;
const EXPLAINED_HAIKU = /Claude Haiku 5\.5|Haiku 5\.5|Claude Haiku 4\.5|Haiku 4\.5/g;
const RUN_MODELS = /claude-haiku-5-5|claude-haiku-4-5-20251001/g;
function routerPremise(text: string, data: boolean): boolean {
  // The tokenmax-map skill block (operator request 2026-10-23) shows the TokenMax report's Opus share, a usage field,
  // not a router premise; the rest of the page is still checked.
  if (!data) return ROUTER.test(text.replace(/<section class="skillbill" id="skill"[\s\S]*?<\/section>/, ""));
  const json = text.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "").replace(/^window\.JNJ\s*=\s*/, "").replace(/;\s*$/, "");
  const sample: StageSample = JSON.parse(json);
  const copy = sample.explained;
  const words = [copy.verdict, copy.why, copy.cases, copy.next, copy.rephrase, copy.earlier];
  if (words.some((word) => word !== null && ROUTER.test(word.replace(EXPLAINED_HAIKU, "")))) return true;
  const figures = JSON.stringify(copy.figures).replace(EXPLAINED_HAIKU, "").replace(RUN_MODELS, "");
  if (ROUTER.test(figures)) return true;
  const rest = JSON.stringify({ ...sample, explained: null }).replace(RUN_MODELS, "");
  return ROUTER.test(rest);
}
/** The same, as whole words, for prose that may name OpenRouter. */
const DOC_ROUTER = /haiku|sonnet|opus|\brouter\b/i;

interface FakeElement {
  textContent: string;
  innerHTML: string;
  className: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  readonly dataset: Record<string, string>;
  readonly children: FakeElement[];
  readonly classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string): void };
  readonly style: { setProperty(k: string, v: string): void };
  addEventListener(): void;
  appendChild(child: FakeElement): FakeElement;
  setAttribute(): void;
  getAttribute(): null;
  querySelectorAll(): FakeElement[];
  scrollIntoView(): void;
}

function fakeElement(): FakeElement {
  const children: FakeElement[] = [];
  return {
    textContent: "", innerHTML: "", className: "", value: "", disabled: false, hidden: false, dataset: {}, children,
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
    style: { setProperty: () => {} },
    addEventListener: () => {},
    appendChild: (child) => { children.push(child); return child; },
    setAttribute: () => {},
    getAttribute: () => null,
    querySelectorAll: () => [],
    scrollIntoView: () => {},
  };
}

/** Run data.js and the page's inline script against a fake document and return the elements it filled in. */
async function renderPage(dataJs?: string): Promise<Map<string, FakeElement>> {
  const html = await readFile(join(SITE, "index.html"), "utf8");
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").filter((s) => s.includes("window.JNJ"));
  expect(inline.length).toBe(1);
  const els = new Map<string, FakeElement>();
  const document = {
    getElementById: (id: string): FakeElement => {
      const e = els.get(id) ?? fakeElement();
      els.set(id, e);
      return e;
    },
    createElement: fakeElement,
    documentElement: fakeElement(),
    querySelectorAll: (): FakeElement[] => [],
    addEventListener: () => {},
  };
  const sandbox: Record<string, unknown> = { document, matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 0, Math, Array, String, parseFloat, Object };
  sandbox.window = sandbox;
  const context = createContext(sandbox);
  runInContext(dataJs ?? (await readFile(join(SITE, "data.js"), "utf8")), context);
  runInContext(inline[0] ?? "", context);
  return els;
}

describe("Stage sample: the recorded shop-bot run (F2)", () => {
  test("[integration] F2-D1 site/data.js is the current build from the run's records.csv", async () => {
    expect(await readFile(SAMPLE_OUT, "utf8")).toBe(await build());
  });

  test("[unit] F2-D2 no router premise survives on the page or in its data; Haiku names the recorded LLM", async () => {
    for (const file of ["data.js", "index.html"]) expect(routerPremise(await readFile(join(SITE, file), "utf8"), file === "data.js")).toBe(false);
    expect(await readFile(join(SITE, "data.js"), "utf8")).toContain("Claude Haiku 5.5");
    expect(routerPremise((await readFile(join(SITE, "index.html"), "utf8")) + " Haiku", false)).toBe(true);
    expect(routerPremise((await readFile(join(SITE, "data.js"), "utf8")).replace("on these 100 shop messages", "on these 100 shop messages Haiku routed"), true)).toBe(true);
  });

  test("[unit] F2-D3 the sample holds the 100 labelled messages with the llm, rule and Jev answers of the run", async () => {
    const csv = await readFile(SAMPLE_RECORDS, "utf8");
    const sample = await buildSample(csv);
    expect(sample.cases.length).toBe(100);
    expect(sample.meta.run_id).toBe("run-shopbot-2026-10-11");
    const rows = validate(csv).rows.map((r) => r.values);
    for (const c of sample.cases) {
      for (const [letter, arm] of [["A", "llm"], ["B", "rule"], ["C", "jev"]] as const) {
        const row = rows.find((r) => r.get("case_id") === c.id && r.get("answerer") === arm);
        expect(row?.get("output")).toBe(c.arms[letter].picked);
        expect(row?.get("label")).toBe(c.arms[letter].label);
        expect(row?.get("case_input")).toBe(c.prompt);
      }
    }
    expect([sample.summary.A.kept, sample.summary.B.kept, sample.summary.C.kept]).toEqual([86, 49, 88]);
  });

  test("[unit] F2-D4 the sample's verdict is the one the loader gives the same file", async () => {
    const csv = await readFile(SAMPLE_RECORDS, "utf8");
    const sample = await buildSample(csv);
    const loaded = await evaluateText("records.csv", csv);
    expect(sample.verdict.result).toBe(loaded.questions[0]?.verdict ?? "none");
    expect(sample.verdict.reason).toBe(loaded.questions[0]?.reason ?? "none");
  });

  test("[unit] F2-D5 the note says this is a recorded run on a made-up shop, not an invented one", async () => {
    const sample = await buildSample(await readFile(SAMPLE_RECORDS, "utf8"));
    expect(sample.meta.note).toContain("recorded");
    expect(sample.meta.note).toContain("made-up shop");
    expect(sample.meta.note).toContain(sample.meta.run_id);
  });

  test("[unit] F2-D6 the page's script draws only the repertoire and the run note from it; the retired result panel and acts are not drawn (#260)", async () => {
    const els = await renderPage();
    for (const id of ["t5", "docket", "ledger", "cast", "verdictWhy", "verdictCases", "verdictNext", "verdictEarlier", "caveat", "resultsTitle", "heroResult", "heroWhy", "resultBars"]) expect({ id, drawn: els.has(id) }).toEqual({ id, drawn: false });
    expect(els.get("repertoire")?.innerHTML).toContain('<span class="uc">');
    expect(els.get("fin")?.textContent).toContain("recorded");
  });

  test("[unit] F2-D7 the sample's verdict and copy agree on rule 3", async () => {
    const sample = await buildSample(await readFile(SAMPLE_RECORDS, "utf8"));
    expect(sample.explained.verdict).toBe("Use Jev (rule 3)");
  });

  test("[unit] F2-D10 a method with no accepted answer has an undefined cost per kept answer in the data, and the page still renders", async () => {
    const csv = (await readFile(SAMPLE_RECORDS, "utf8")).split("\n").map((l) => (l.includes(",jev,") ? l.replace(",accept,", ",reject,") : l)).join("\n");
    await expect(buildSample(csv)).rejects.toThrow("Stage copy disagrees with computed verdict and rule");
    const original = await buildSample(await readFile(SAMPLE_RECORDS, "utf8"));
    const rejected: StageCase[] = [{ id: "zero", prompt: "A message", truth: "answer", arms: {
      A: { picked: "answer", cost: 0.02, label: "accept" },
      B: { picked: "hand_off", cost: 0, label: "reject" },
      C: { picked: "hand_off", cost: 0.01, label: "reject" },
    } }];
    expect(armTotal(rejected, "C")).toEqual({ spend: 0.01, kept: 0, cpk: null });
    const sample = { ...original, summary: { ...original.summary, C: armTotal(rejected, "C") } };
    expect(sample.summary.C.cpk).toBeNull();
    expect(sample.summary.A.cpk).not.toBeNull();
    // The ledger and the result bars that drew this are retired (#260); the page still renders with a method that kept nothing.
    const els = await renderPage(sampleScript(sample));
    expect(els.get("fin")?.textContent).not.toContain("NaN");
  });

  test("[unit] F2-D8 the user story for the verdict links the written rules and restates none of them", async () => {
    const stories = await readFile(join(ROOT, "docs", "product", "user-stories.md"), "utf8");
    const us06 = /### US-06[\s\S]*?(?=\n### US-07)/.exec(stories)?.[0] ?? "";
    expect(us06).toContain("docs/decision/verdict-rules.md");
    expect(us06).not.toMatch(/lowest cost per accepted|clear margin|simple baseline has/i);
  });

  test("[unit] F2-D9 every router, Haiku, Sonnet or Opus mention in docs/product prose is marked historical or superseded, or is the UC13 run's own model", async () => {
    const files = ["user-stories.md", "jev-in-jevnotjev.md", join("use-cases", "README.md")];
    for (const f of files) {
      const text = await readFile(join(ROOT, "docs", "product", f), "utf8");
      for (const line of text.split("\n").filter((l) => DOC_ROUTER.test(l))) {
        expect(line).toMatch(/historical|superseded|dropped|Sonnet acting as review hats/i);
      }
    }
  });
});

describe("Stage sample: agent labels (M1)", () => {
  test("[unit] M1 a sample whose labels are unreviewed agent labels is refused, not shown as kept answers", async () => {
    const csv = (await readFile(SAMPLE_RECORDS, "utf8")).replace(/,human_reviewed,/g, ",agent,");
    expect(validate(csv).errors).toEqual([]);
    await expect(buildSample(csv)).rejects.toThrow(/no reviewed label/);
  });
});
