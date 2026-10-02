// Behavioural check of site/stage-door.js: it renders only a well-formed window.UC13_DEMO and falls back otherwise.

import { describe, expect, test } from "bun:test";
import { FakeEl, siteScript } from "./dom-fakes.ts";

function sample(): Record<string, unknown> {
  const arms = [{ key: "a", name: "Arm A", model: "m" }, { key: "b", name: "Arm B", model: "m" }];
  const tallyRow = { answer: 1, hand_off: 0, cost_usd: 0.0012, labelled: 0, accept: null, answered_should_hand_off: null, handed_off_could_answer: null };
  return {
    schema: "jnj-uc13-demo/1",
    mode: "pending",
    note: "note",
    source: "src",
    cases_total: 1,
    fact_sheet: { title: "Sheet", lines: ["one line"] },
    arms,
    messages: [{ id: "x1", text: "A message", label: null, outputs: { a: { output: "answer", verdict: "pending" }, b: { output: "answer", verdict: "pending" } } }],
    tally: { a: { ...tallyRow }, b: { ...tallyRow } },
    label_page: null,
  };
}

async function openDemo(data: unknown): Promise<string> {
  const src = await siteScript("stage-door.js");
  const root = new FakeEl();
  const door = new FakeEl();
  const box = new FakeEl();
  const title = new FakeEl();
  const ids = new Map<string, FakeEl>([["door", door], ["doorDemo", box], ["doorTitle", title]]);
  const windowObj = { UC13_DEMO: data };
  const documentObj = { documentElement: root, getElementById: (id: string) => ids.get(id) ?? null };
  const run = new Function("window", "document", "Element", "setTimeout", "clearTimeout", src);
  run(windowObj, documentObj, FakeEl, () => 0, () => {});
  door.fire("click");
  return box.innerHTML;
}

describe("stage-door.js data guard", () => {
  test("[unit] SITE-6 a well-formed object renders the demo", async () => {
    const html = await openDemo(sample());
    expect(html).toContain("Stage door: answer, or hand off to staff?");
    expect(html).toContain("A message");
  });

  test("[unit] SITE-13 the demo badge says sample only for sample data; a recorded run says so, with its label state", async () => {
    expect(await openDemo({ ...sample(), mode: "sample" })).toContain('<span class="dd-badge">Sample data</span>');
    expect(await openDemo({ ...sample(), mode: "pending" })).toContain('<span class="dd-badge">Recorded run, labels pending</span>');
    const row = { answer: 1, hand_off: 0, cost_usd: 0, labelled: 1, accept: 1, answered_should_hand_off: 0, handed_off_could_answer: 0 };
    expect(await openDemo({ ...sample(), mode: "labelled", tally: { a: { ...row }, b: { ...row } } })).toContain('<span class="dd-badge">Recorded run, labelled</span>');
  });

  test("[unit] SITE-6 a malformed nested shape falls back to the loading message instead of throwing", async () => {
    const bad: Record<string, unknown>[] = [
      { ...sample(), fact_sheet: {} },
      { ...sample(), fact_sheet: { title: "t", lines: "not a list" } },
      { ...sample(), arms: [] },
      { ...sample(), arms: [{ key: "a" }] },
      { ...sample(), messages: [{ id: "x1" }] },
      { ...sample(), tally: { a: {} } },
      { ...sample(), cases_total: "40" },
      { ...sample(), schema: "other" },
      { ...sample(), mode: "constructor" },
      { ...sample(), mode: "unknown" },
      { ...sample(), label_page: "javascript:alert(1)" },
      { ...sample(), label_page: " javascript:alert(1)" },
      { ...sample(), label_page: "data:text/html,x" },
      { ...sample(), label_page: 42 },
      { ...sample(), tally: { a: { answer: 1, hand_off: 0, cost_usd: 0, labelled: 1, accept: 1 }, b: { answer: 1, hand_off: 0, cost_usd: 0, labelled: 1, accept: 1 } } },
      { ...sample(), tally: { a: { answer: 1, hand_off: 0, cost_usd: 0, labelled: "1", accept: 1, answered_should_hand_off: 0, handed_off_could_answer: 0 }, b: { answer: 1, hand_off: 0, cost_usd: 0, labelled: 1, accept: 1, answered_should_hand_off: 0, handed_off_could_answer: 0 } } },
    ];
    for (const d of bad) expect(await openDemo(d)).toContain("The demo data is loading soon.");
    expect(await openDemo(undefined)).toContain("The demo data is loading soon.");
  });

  test("[unit] SITE-6 safe label links render; a verdict that is an Object.prototype key reads pending", async () => {
    for (const link of ["label/", "/label/", "#label", "https://example.com/label"]) {
      expect(await openDemo({ ...sample(), label_page: link })).toContain(`<a href="${link}">Label these 1 yourself</a>`);
    }
    const d = sample();
    d.messages = [{ id: "x1", text: "A message", label: null, outputs: { a: { output: "answer", verdict: "constructor" }, b: { output: "answer", verdict: "toString" } } }];
    const html = await openDemo(d);
    expect(html).toContain("pending: not labelled yet");
    expect(html).not.toContain("function");
  });

  test("[unit] SITE-6 a labelled tally with every count renders the misses", async () => {
    const row = { answer: 1, hand_off: 0, cost_usd: 0, labelled: 1, accept: 1, answered_should_hand_off: 0, handed_off_could_answer: 0 };
    const html = await openDemo({ ...sample(), mode: "labelled", tally: { a: { ...row }, b: { ...row } } });
    expect(html).toContain("1 of 1");
    expect(html).toContain("Arm A 0, Arm B 0");
  });

  test("[unit] SITE-9 a missing, non-numeric or negative cost reads n/a, never $0.0000", async () => {
    // null is what stage-demo.ts emits for an arm with a blank cost
    for (const cost of [null, undefined, "abc", -1, Number.NaN]) {
      const d = sample();
      d.tally = { a: { answer: 1, hand_off: 0, cost_usd: cost, labelled: 0, accept: null, answered_should_hand_off: null, handed_off_could_answer: null }, b: { answer: 1, hand_off: 0, cost_usd: 0, labelled: 0, accept: null, answered_should_hand_off: null, handed_off_could_answer: null } };
      const html = await openDemo(d);
      expect(html).toContain("<td>Arm A</td><td>1 / 0</td><td>n/a</td>");
      expect(html).toContain("<td>Arm B</td><td>1 / 0</td><td>$0</td>");
    }
    expect(await openDemo(sample())).toContain("$0.001200");
    // under a dollar keeps 6 decimals, as recorded: $0.103167 is not rounded to $0.1032
    const d = sample();
    d.tally = { a: { answer: 1, hand_off: 0, cost_usd: 0.103167, labelled: 0, accept: null }, b: { answer: 1, hand_off: 0, cost_usd: 2.5, labelled: 0, accept: null } };
    const html = await openDemo(d);
    expect(html).toContain("<td>$0.103167</td>");
    expect(html).toContain("<td>$2.5000</td>");
  });
});
