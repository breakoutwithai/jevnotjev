// F2: the public Stage's sample is the recorded shop-bot run, not the dropped prompt-router premise (Haiku, Sonnet,
// Opus, dropped 2026-09-28; FLOW.md). site/data.js is generated from the run's records.csv, and the page's own script
// renders Acts II to V from it without a router word or a made-up number.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { evaluateText } from "../src/browser/results-loader.ts";
import { validate } from "../src/format/validate.ts";
import { build, buildSample, SAMPLE_OUT, SAMPLE_RECORDS } from "./stage-sample.ts";

const ROOT = join(import.meta.dir, "..");
const SITE = join(ROOT, "site");

/** The router premise: model names and the word router. */
const ROUTER = /haiku|sonnet|opus|router/i;
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
async function renderPage(): Promise<Map<string, FakeElement>> {
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
  runInContext(await readFile(join(SITE, "data.js"), "utf8"), context);
  runInContext(inline[0] ?? "", context);
  return els;
}

describe("Stage sample: the recorded shop-bot run (F2)", () => {
  test("[integration] F2-D1 site/data.js is the current build from the run's records.csv", async () => {
    expect(await readFile(SAMPLE_OUT, "utf8")).toBe(await build());
  });

  test("[unit] F2-D2 no router premise survives on the page or in its data: no Haiku, Sonnet, Opus or router", async () => {
    for (const file of ["data.js", "index.html"]) expect(await readFile(join(SITE, file), "utf8")).not.toMatch(ROUTER);
  });

  test("[unit] F2-D3 the sample holds the 40 labelled messages with the llm, rule and Jev answers of the run", async () => {
    const csv = await readFile(SAMPLE_RECORDS, "utf8");
    const sample = await buildSample(csv);
    expect(sample.cases.length).toBe(40);
    expect(sample.meta.run_id).toBe("run-shopbot-2026-10-01");
    const rows = validate(csv).rows.map((r) => r.values);
    for (const c of sample.cases) {
      for (const [letter, arm] of [["A", "llm"], ["B", "rule"], ["C", "jev"]] as const) {
        const row = rows.find((r) => r.get("case_id") === c.id && r.get("answerer") === arm);
        expect(row?.get("output")).toBe(c.arms[letter].picked);
        expect(row?.get("label")).toBe(c.arms[letter].label);
        expect(row?.get("case_input")).toBe(c.prompt);
      }
    }
    expect([sample.summary.A.kept, sample.summary.B.kept, sample.summary.C.kept]).toEqual([38, 29, 38]);
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

  test("[unit] F2-D6 the page's script draws Acts II to V from it: 40 cases, the run's verdict and the run's costs", async () => {
    const els = await renderPage();
    const sample = await buildSample(await readFile(SAMPLE_RECORDS, "utf8"));
    expect(els.get("docket")?.children.filter((c) => c.className.includes("row")).length).toBe(40);
    expect(els.get("t3")?.textContent).toBe("The trial of 40 messages");
    expect(els.get("t5")?.textContent).toBe("Not enough evidence");
    expect(els.get("ruleLine")?.textContent).toBe(`Rule ${sample.verdict.rule} fired`);
    expect(els.get("caveat")?.textContent).toContain("lower bound of Jev minus LLM");
    const ledger = els.get("ledger")?.innerHTML ?? "";
    expect(ledger).toContain('data-to="0.103167"');
    expect(ledger).toContain('data-to="0.00130176"');
    expect(ledger).toContain(">$0.1032<");
    expect(ledger).toContain(">$0.000034<");
    expect(ledger).toContain("38/40");
    expect(els.get("cast")?.children.length).toBe(3);
    expect(els.get("cast")?.children[0]?.innerHTML).toContain("Answer 18");
    expect(els.get("cast")?.children[0]?.innerHTML).toContain("Hand off 22");
  });

  test("[unit] F2-D7 the sample's verdict is not use Jev, so the page cannot show a rule-3 win the run did not earn", async () => {
    const els = await renderPage();
    expect(els.get("t5")?.textContent).not.toBe("Use Jev");
    expect(els.get("ruleLine")?.textContent).not.toBe("Rule 3 fired");
  });

  test("[unit] F2-D8 the user story for the verdict links the written rules and restates none of them", async () => {
    const stories = await readFile(join(ROOT, "docs", "product", "user-stories.md"), "utf8");
    const us06 = /### US-06[\s\S]*?(?=\n### US-07)/.exec(stories)?.[0] ?? "";
    expect(us06).toContain("docs/decision/verdict-rules.md");
    expect(us06).not.toMatch(/lowest cost per accepted|clear margin|simple baseline has/i);
  });

  test("[unit] F2-D9 every router, Haiku, Sonnet or Opus mention in docs/product prose is marked historical or superseded, or is the UC13 run's own model", async () => {
    const files = ["user-stories.md", "user-journeys.md", "jev-in-jevnotjev.md", join("use-cases", "README.md")];
    for (const f of files) {
      const text = await readFile(join(ROOT, "docs", "product", f), "utf8");
      for (const line of text.split("\n").filter((l) => DOC_ROUTER.test(l))) {
        expect(line).toMatch(/historical|superseded|dropped|Sonnet acting as review hats/i);
      }
    }
  });
});
