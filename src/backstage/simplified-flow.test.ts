import { expect, test } from "bun:test";
import { answerYes, mount, tick } from "./dom-fixture.ts";
import type { AnswerRequest } from "./contracts.ts";

function fill(
  page: Awaited<ReturnType<typeof mount>>,
  id: string,
  value: string,
) {
  page.get(id).value = value;
  page.get(id).dispatchEvent(new Event("input"));
}
function setup(page: Awaited<ReturnType<typeof mount>>) {
  for (const [id, value] of Object.entries({
    question: "Ask for refund?",
    "choice-a": "yes",
    "choice-b": "no",
    "definition-a": "Explicit refund request",
    "definition-b": "Anything else",
    acceptance: "Choose the meaning matching the request",
    cases: "Refund please\nDelivery question\nMoney back please",
    "jev-key": "synthetic-key-only",
  }))
    fill(page, id, value);
}

test("[integration] C1 missing judging rule focuses its visible field without any provider call and correction clears error", async () => {
  const page = await mount();
  setup(page);
  fill(page, "acceptance", "");
  page.get("run-one").click();
  await tick();
  expect(page.get("run-reason").textContent).toContain("Judging rule");
  expect(page.document.activeElement).toBe(page.get("acceptance"));
  expect(page.get("acceptance").getAttribute("aria-invalid")).toBe("true");
  expect(
    page.requests.filter((r) => r.input === "/api/backstage/answer"),
  ).toHaveLength(0);
  fill(page, "acceptance", "Choose yes for explicit refund requests.");
  expect(page.get("acceptance").getAttribute("aria-invalid")).toBeNull();
  expect(page.get("run-reason").textContent).toBe("");
});

test("[integration] C1 adding case JSON names scope, replacement waits for confirmation and cancellation preserves text", async () => {
  const page = await mount();
  setup(page);
  fill(
    page,
    "cases-reply",
    JSON.stringify({
      cases: [
        "Refund please",
        "No refund wanted",
        ...Array.from({ length: 8 }, (_, i) => "Synthetic case " + i),
      ],
    }),
  );
  expect(page.get("cases-use-reply").textContent).toContain("Add 10 cases");
  expect(page.get("cases-mutation-preview").textContent).toContain("13 total");
  page.get("cases-replace").click();
  expect(page.get("cases").value).toBe(
    "Refund please\nDelivery question\nMoney back please",
  );
  page.get("confirm-replace-no").click();
  expect(page.get("cases").value).toBe(
    "Refund please\nDelivery question\nMoney back please",
  );
  page.get("cases-use-reply").click();
  expect(page.get("cases").value.split("\n")).toHaveLength(13);
  expect(page.get("cases-status").textContent).toContain("duplicate");
  page.get("cases-replace").click();
  page.get("confirm-replace-yes").click();
  expect(page.get("cases").value).toBe(
    [
      "Refund please",
      "No refund wanted",
      ...Array.from({ length: 8 }, (_, i) => "Synthetic case " + i),
    ].join("\n"),
  );
});

test("[integration] C1 first trial retains full frozen scene and continuing calls only remaining cases with original evidence", async () => {
  const calls: AnswerRequest[] = [];
  const page = await mount(undefined, undefined, undefined, async (r) => {
    calls.push(r);
    return answerYes(r);
  });
  setup(page);
  page.get("run-one").click();
  expect(page.get("run-one-reason").textContent).toBe("Calls are in progress.");
  page.get("run-one").click();
  expect(page.get("notice").textContent).toBe("Calls are in progress.");
  for (let i = 0; i < 10; i++) await tick();
  expect(calls.map((r) => r.caseId)).toEqual(["case-1"]);
  expect(page.get("run-preview").textContent).toContain("1 completed calls");
  expect(page.get("run-all").textContent).toContain("remaining 2 cases");
  expect(page.get("run-one").getAttribute("aria-describedby")).toBe("run-one-reason");
  expect(page.get("run-one-reason").textContent).toContain("first case already ran");
  expect(page.get("notice").textContent).toContain("First case complete.");
  expect(page.get("notice").textContent).toContain("Run remaining cases");
  page.get("run-one").click();
  await tick();
  expect(calls).toHaveLength(1);
  expect(page.get("notice").textContent).not.toContain("retry failed");
  page.get("clear-keys").click();
  page.get("run-one").focus();
  page.get("run-one").click();
  await tick();
  expect(page.document.activeElement).toBe(page.get("run-one"));
  expect(page.get("notice").textContent).toBe("The first case already ran. Start a new question for another first-case trial.");
  expect(calls).toHaveLength(1);
  fill(page, "jev-key", "synthetic-key-only");
  const runId = calls[0]?.runId;
  page.get("run-all").click();
  for (let i = 0; i < 10; i++) await tick();
  expect(calls.map((r) => r.caseId)).toEqual(["case-1", "case-2", "case-3"]);
  expect(calls.every((r) => r.runId === runId)).toBe(true);
  expect(page.get("run-preview").textContent).toContain("3 completed calls");
  expect(page.get("question").disabled).toBe(true);
  expect(page.get("run-all").textContent).toBe("All cases attempted");
  expect(page.get("run-reason").textContent).toBe("All selected calls have answers. Review your answers.");
  page.get("run-all").click();
  await tick();
  expect(calls).toHaveLength(3);
  const trial = await mount(undefined, undefined, undefined, answerYes);
  setup(trial);
  trial.get("run-one").click();
  for (let i = 0; i < 10; i++) await tick();
  trial.get("open-judging").click();
  trial.get("confirm-judging-yes").click();
  expect(trial.get("run-reason").textContent).toContain("Judging has started");
  trial.get("clear-keys").click();
  expect(trial.get("fix-run").hidden).toBe(true);
  trial.get("run-one").focus();
  trial.get("run-one").click();
  expect(trial.document.activeElement).toBe(trial.get("run-one"));
  expect(trial.get("notice").textContent).toBe("The first case already ran. Start a new question for another first-case trial.");
  trial.get("run-all").click();
  await tick();
  expect(
    trial.requests.filter((r) => r.input === "/api/backstage/answer"),
  ).toHaveLength(1);
});

test("[integration] C1 multiarm continuation never retries failed trials; explicit retry preserves success and adds one attempt", async () => {
  const calls: AnswerRequest[] = [];
  let failed = false;
  const page = await mount(undefined, undefined, undefined, async (r) => {
    calls.push(r);
    if (r.provider === "openai" && r.caseId === "case-1" && !failed) {
      failed = true;
      throw new Error("synthetic transport failure");
    }
    return answerYes(r);
  });
  setup(page);
  page.get("compare").checked = true;
  page.get("compare").dispatchEvent(new Event("change"));
  page.get("arm-gpt-6-luna").checked = true;
  page.get("arm-gpt-6-luna").dispatchEvent(new Event("change"));
  fill(page, "openai-key", "synthetic-openai-key");
  page.get("run-one").click();
  for (let i = 0; i < 10; i++) await tick();
  expect(calls).toHaveLength(2);
  expect(page.get("retry").disabled).toBe(false);
  page.get("run-all").click();
  for (let i = 0; i < 10; i++) await tick();
  expect(calls).toHaveLength(6);
  expect(page.get("run-reason").textContent).toContain("Retry failed");
  expect(calls.filter((r) => r.caseId === "case-1")).toHaveLength(2);
  page.get("retry").click();
  for (let i = 0; i < 10; i++) await tick();
  expect(calls).toHaveLength(7);
  expect(calls.at(-1)?.caseId).toBe("case-1");
  expect(calls.at(-1)?.provider).toBe("openai");
  expect(
    calls.filter((r) => r.provider === "jev" && r.caseId === "case-1"),
  ).toHaveLength(1);
});

test("[integration] C1 malformed JSON cannot add or replace existing case text", async () => {
  const page = await mount();
  setup(page);
  const original = page.get("cases").value;
  fill(page, "cases-reply", '{"cases":"bad"}');
  page.get("cases-use-reply").click();
  expect(page.get("cases").value).toBe(original);
  page.get("cases-replace").click();
  expect(page.get("confirm-replace").hidden).toBe(true);
  expect(page.get("cases").value).toBe(original);
});

const replyJson = JSON.stringify({
  cases: Array.from({ length: 10 }, (_, i) => "Replacement case " + i),
});

test("[integration] #222 F4 editing the case reply cancels an open replacement so Confirm cannot apply a stale snapshot", async () => {
  const page = await mount();
  setup(page);
  const original = page.get("cases").value;
  fill(page, "cases-reply", replyJson);
  page.get("cases-replace").click();
  expect(page.get("confirm-replace").hidden).toBe(false);
  fill(page, "cases-reply", JSON.stringify({ cases: Array.from({ length: 10 }, (_, i) => "Newer case " + i) }));
  expect(page.get("confirm-replace").hidden).toBe(true);
  expect(page.document.activeElement).not.toBe(page.get("cases-replace"));
  page.get("confirm-replace-yes").click();
  expect(page.get("cases").value).toBe(original);
});

test("[integration] #222 F4 editing cases or importing while Replace is open cancels it and keeps cases and imported labels", async () => {
  const { FakeInput } = await import("./dom-fixture.ts");
  const edited = await mount();
  setup(edited);
  fill(edited, "cases-reply", replyJson);
  edited.get("cases-replace").click();
  fill(edited, "cases", "Edited case");
  expect(edited.get("confirm-replace").hidden).toBe(true);
  edited.get("confirm-replace-yes").click();
  expect(edited.get("cases").value).toBe("Edited case");

  const page = await mount();
  setup(page);
  fill(page, "cases-reply", replyJson);
  page.get("cases-replace").click();
  expect(page.get("confirm-replace").hidden).toBe(false);
  const input = page.get("import-cases");
  if (!(input instanceof FakeInput)) throw Error("Expected file input");
  input.files = [
    new File(
      [
        "case_id,case_input,label,label_source,labelled_by,labelled_at\noriginal,Refund please,yes,human_reviewed,operator,2026-10-14\n",
      ],
      "synthetic.csv",
    ),
  ];
  input.dispatchEvent(new Event("change"));
  expect(page.get("confirm-replace").hidden).toBe(true);
  for (let i = 0; i < 5; i++) await tick();
  page.get("confirm-replace-yes").click();
  expect(page.get("cases").value).toBe("Refund please");
  expect(page.get("cases-status").textContent).not.toContain("Cases replaced");
  fill(page, "cases", "Edited case");
  expect(page.get("notice").textContent).toContain("dropped 1 imported labels");
});

test("[integration] #222 F4 a confirmed replacement moves focus to the cases field", async () => {
  const page = await mount();
  setup(page);
  fill(page, "cases-reply", replyJson);
  page.get("cases-replace").click();
  page.get("confirm-replace-yes").click();
  expect(page.get("confirm-replace").hidden).toBe(true);
  expect(page.get("cases").value.split("\n")).toHaveLength(10);
  expect(page.document.activeElement).toBe(page.get("cases"));
});

test("[integration] C1 required question meanings keys and keywords recover at named fields without paid dispatch", async () => {
  for (const id of ["question", "definition-a", "definition-b", "jev-key"]) {
    const page = await mount();
    setup(page);
    fill(page, id, "");
    page.get("run-all").click();
    await tick();
    expect(page.document.activeElement).toBe(page.get(id));
    if (id === "jev-key") {
      expect(page.get(id).getAttribute("aria-describedby")).toBe("jev-key-source run-reason");
      fill(page, id, "synthetic-key-only");
      expect(page.get(id).getAttribute("aria-describedby")).toBe("jev-key-source");
    }
    expect(
      page.requests.filter((r) => r.input === "/api/backstage/answer"),
    ).toHaveLength(0);
  }
  const page = await mount();
  setup(page);
  page.get("compare").checked = true;
  page.get("compare").dispatchEvent(new Event("change"));
  page.get("include-rule").checked = true;
  page.get("include-rule").dispatchEvent(new Event("change"));
  page.get("run-all").click();
  await tick();
  expect(page.document.activeElement).toBe(page.get("keywords"));
  expect(
    page.requests.filter((r) => r.input === "/api/backstage/answer"),
  ).toHaveLength(0);
});

test("[integration] #222 F2 keyword and exclusion limits block Run at the named field without paid dispatch", async () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["keywords", Array.from({ length: 21 }, (_, i) => "keyword" + i).join("\n"), "Literal keywords"],
    ["keywords", "k".repeat(201), "Literal keywords"],
    ["exclusions", "x".repeat(2001), "Leave out"],
  ];
  for (const [id, value, label] of cases) {
    const page = await mount();
    setup(page);
    page.get("compare").checked = true;
    page.get("compare").dispatchEvent(new Event("change"));
    page.get("include-rule").checked = true;
    page.get("include-rule").dispatchEvent(new Event("change"));
    fill(page, "keywords", "refund");
    fill(page, id, value);
    expect(page.get("run-reason").textContent).toContain(label);
    expect(page.get("fix-run").hidden).toBe(false);
    page.get("run-all").click();
    await tick();
    expect(page.document.activeElement).toBe(page.get(id));
    expect(page.get(id).getAttribute("aria-invalid")).toBe("true");
    expect(
      page.requests.filter((r) => r.input === "/api/backstage/answer"),
    ).toHaveLength(0);
  }
});

test("[integration] #222 F3 an invalid second answer name recovers at the second name, not the valid first", async () => {
  for (const value of ["", "n|o", "yes"]) {
    const page = await mount();
    setup(page);
    fill(page, "choice-b", value);
    page.get("run-all").click();
    await tick();
    expect(page.document.activeElement).toBe(page.get("choice-b"));
    expect(page.get("choice-b").getAttribute("aria-invalid")).toBe("true");
    expect(page.get("choice-a").getAttribute("aria-invalid")).toBeNull();
    expect(
      page.requests.filter((r) => r.input === "/api/backstage/answer"),
    ).toHaveLength(0);
  }
  const page = await mount();
  setup(page);
  fill(page, "choice-a", "");
  page.get("run-all").click();
  await tick();
  expect(page.document.activeElement).toBe(page.get("choice-a"));
  expect(page.get("choice-b").getAttribute("aria-invalid")).toBeNull();
});

test("[integration] C1 cancel replacement preserves imported human labels while confirmed replacement clears them", async () => {
  const { spyOn } = await import("bun:test");
  const { validate } = await import("../format/validate.ts");
  const { FakeInput } = await import("./dom-fixture.ts");
  const blobs: Blob[] = [];
  const created = spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (blob instanceof Blob) blobs.push(blob);
    return "blob:synthetic";
  });
  const revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  try {
    const page = await mount(undefined, undefined, undefined, answerYes);
    setup(page);
    const input = page.get("import-cases");
    if (!(input instanceof FakeInput)) throw Error("Expected import input");
    input.files = [
      new File(
        [
          "case_id,case_input,label,label_source,labelled_by,labelled_at\noriginal,Refund please,yes,human_reviewed,operator,2026-10-14\n",
        ],
        "synthetic.csv",
      ),
    ];
    input.dispatchEvent(new Event("change"));
    for (let i = 0; i < 5; i++) await tick();
    fill(
      page,
      "cases-reply",
      JSON.stringify({
        cases: Array.from({ length: 10 }, (_, i) => "Synthetic input " + i),
      }),
    );
    page.get("cases-replace").click();
    page.get("confirm-replace-no").click();
    page.get("cases-use-reply").click();
    page.get("run-all").click();
    for (let i = 0; i < 20; i++) await tick();
    page.get("open-judging").click();
    page.get("confirm-judging-yes").click();
    page.get("reveal").click();
    page.get("confirm-reveal-yes").click();
    await tick();
    page.get("download-csv").click();
    const first = validate((await blobs.at(-1)?.text()) ?? "");
    expect(first.errors).toEqual([]);
    expect(
      first.rows.filter(
        (row) => row.values.get("label_source") === "human_reviewed",
      ),
    ).toHaveLength(1);
    expect(
      first.rows
        .find((row) => row.values.get("case_id") === "original")
        ?.values.get("label"),
    ).toBe("accept");
    page.get("new-scene").click();
    page.get("confirm-new-scene-yes").click();
    page.get("cases-replace").click();
    page.get("confirm-replace-yes").click();
    page.get("run-all").click();
    for (let i = 0; i < 20; i++) await tick();
    page.get("open-judging").click();
    page.get("confirm-judging-yes").click();
    page.get("reveal").click();
    page.get("confirm-reveal-yes").click();
    await tick();
    page.get("download-csv").click();
    const second = validate((await blobs.at(-1)?.text()) ?? "");
    expect(second.errors).toEqual([]);
    expect(second.rows).toHaveLength(10);
    expect(
      second.rows.filter(
        (row) => row.values.get("label_source") === "human_reviewed",
      ),
    ).toHaveLength(0);
  } finally {
    created.mockRestore();
    revoked.mockRestore();
  }
});

test("[integration] C1 blind picking and case navigation preserve a useful visible keyboard focus", async () => {
  const page = await mount(undefined, undefined, undefined, answerYes);
  setup(page);
  page.get("run-all").click();
  for (let i = 0; i < 10; i++) await tick();
  page.get("open-judging").click();
  page.get("confirm-judging-yes").click();
  page.get("pick-first").focus();
  page.get("pick-first").click();
  await tick();
  expect(page.document.activeElement).toBe(page.get("suggestion"));
  page.get("next-card").click();
  await tick();
  expect(page.document.activeElement).toBe(page.get("blind-card"));
  expect(page.get("pick-actions").hidden).toBe(false);
  page.get("pick-unsure").focus();
  page.get("pick-unsure").click();
  await tick();
  expect(page.document.activeElement).toBe(page.get("suggestion"));
  page.get("previous-card").click();
  await tick();
  expect(page.document.activeElement).toBe(page.get("blind-card"));
});

test("[integration] C1 late paid drafting cannot overwrite a newer pasted case reply", async () => {
  let deliver: ((cases: readonly string[]) => void) | undefined;
  const page = await mount(
    undefined,
    undefined,
    undefined,
    undefined,
    "",
    () =>
      new Promise<readonly string[]>((resolve) => {
        deliver = resolve;
      }),
  );
  setup(page);
  fill(page, "coach-key", "synthetic-coach-key");
  page.get("coach-provider").value = "openai";
  page.get("draft-cases").click();
  await tick();
  const pasted = JSON.stringify({
    cases: Array.from({ length: 10 }, (_, i) => "Operator pasted case " + i),
  });
  fill(page, "cases-reply", pasted);
  deliver?.(Array.from({ length: 10 }, (_, i) => "Late generated case " + i));
  await tick();
  await tick();
  expect(page.get("cases-reply").value).toBe(pasted);
  expect(page.get("cases-status").textContent).toContain("kept");
  expect(page.get("cases").value).toBe(
    "Refund please\nDelivery question\nMoney back please",
  );
});

test("[integration] C1 correcting run fields preserves the unrelated imported-label loss warning", async () => {
  const { FakeInput } = await import("./dom-fixture.ts");
  const page = await mount();
  setup(page);
  const input = page.get("import-cases");
  if (!(input instanceof FakeInput)) throw Error("Expected file input");
  input.files = [
    new File(
      [
        "case_id,case_input,label,label_source,labelled_by,labelled_at\noriginal,Refund please,yes,human_reviewed,operator,2026-10-14\n",
      ],
      "synthetic.csv",
    ),
  ];
  input.dispatchEvent(new Event("change"));
  for (let i = 0; i < 5; i++) await tick();
  expect(page.get("notice").textContent).toContain("Your pick in Review answers");
  expect(page.get("notice").textContent).not.toContain("Rehearsals");
  fill(page, "cases", "Edited case");
  expect(page.get("notice").textContent).toContain("dropped 1 imported labels");
  fill(page, "acceptance", "Updated judging rule");
  expect(page.get("notice").textContent).toContain("dropped 1 imported labels");
});


test("[integration] C1 unchanged blocker text is not rewritten while the operator types", async () => {
  const page = await mount();
  const reason = page.get("run-reason");
  let value = reason.textContent;
  let writes = 0;
  Object.defineProperty(reason, "textContent", { get: () => value, set: (next: string) => { writes++; value = next; }, configurable: true });
  fill(page, "definition-a", "Another meaning");
  expect(writes).toBe(0);
  fill(page, "question", "Refund request?");
  expect(writes).toBe(1);
});

test("[integration] C1 pending import keeps its operational reason and does not focus unrelated setup errors", async () => {
  const { FakeInput } = await import("./dom-fixture.ts");
  const page = await mount();
  setup(page);
  fill(page, "cases", "");
  let finish: ((bytes: ArrayBuffer) => void) | undefined;
  const file = new File(["synthetic"], "synthetic.csv");
  Object.defineProperty(file, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }) });
  const input = page.get("import-cases");
  if (!(input instanceof FakeInput)) throw Error("Expected file input");
  input.files = [file];
  input.dispatchEvent(new Event("change"));
  page.get("run-all").focus();
  page.get("run-all").click();
  expect(page.get("notice").textContent).toBe("Wait for the case import to finish.");
  expect(page.document.activeElement).toBe(page.get("run-all"));
  expect(page.requests.filter(r => r.input === "/api/backstage/answer")).toHaveLength(0);
  finish?.(new TextEncoder().encode("case_id,case_input\nexample,Refund please\n").buffer);
  for (let i = 0; i < 5; i++) await tick();
});
