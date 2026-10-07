// Optional label column on the Backstage case CSV import (labelling loop M3, D11 path). An imported label keeps the
// label_source the file supplies; with none it is agent, never human, until a person picks the case in the UI.
import { describe, expect, test } from "bun:test";
import { BACKSTAGE_BLIND_PICK, BackstageRun, inputFingerprint, parseCaseImport, parseCases } from "./run.ts";
import type { AnswerRequest, Scene } from "./contracts.ts";
import { getModelEntry } from "./catalog.ts";
import { validate } from "../format/validate.ts";

const AT = new Date("2026-10-07T10:00:00.000Z");

function scene(cases: Scene["cases"]): Scene {
  return {
    question: "Qualified?",
    choices: [
      { name: "yes", definition: "Qualified" },
      { name: "no", definition: "Not qualified" },
    ],
    acceptance: "Correct decision",
    exclusions: "",
    keywords: ["typescript"],
    matchChoice: "yes",
    otherwiseChoice: "no",
    cases,
  };
}

async function answerYes(r: AnswerRequest) {
  return {
    ok: true, runId: r.runId, revision: r.revision, caseId: r.caseId, provider: r.provider,
    attemptId: crypto.randomUUID(), fingerprint: await inputFingerprint(r),
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), latencyMs: 10,
    model: r.modelId, armId: r.armId, catalogVersion: r.catalogVersion, promptVersion: r.promptVersion,
    requestedModel: r.modelId, returnedModel: r.modelId, parameters: getModelEntry(r.armId)?.parameters,
    tokensIn: 20, tokensOut: 1, costUsd: 0.001, priceVersion: "2026-10-03", output: "yes", confidence: null,
  };
}

async function ranRun(csv: string): Promise<BackstageRun> {
  const imported = parseCaseImport(csv, AT);
  const run = new BackstageRun(scene(imported.cases), "test", { arms: ["jev"] }, imported.labels);
  await run.start({ jev: "test-secret-jev" }, answerYes);
  return run;
}

function cells(run: BackstageRun) {
  const parsed = validate(run.csv());
  expect(parsed.errors).toEqual([]);
  return parsed.rows.map(({ values }) =>
    ["case_id", "output", "label", "label_source", "labelled_by", "labelled_at", "label_blind"].map((k) => values.get(k)),
  );
}

describe("case CSV import with an optional label column", () => {
  test("[unit] M3 without a label column the import is the D11 import: same cases, no labels", () => {
    const csv = "case_id,case_input\nc1,TypeScript builder\nc2,other\n";
    const imported = parseCaseImport(csv);
    expect(imported.cases).toEqual(parseCases(csv));
    expect(imported.labels).toEqual([]);
  });

  test("[unit] M3 a label without a label_source is stored as agent, labelled by csv-import, never human", () => {
    const imported = parseCaseImport("case_id,case_input,label\nc1,TypeScript builder,yes\nc2,other,\n", AT);
    expect(imported.cases.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(imported.labels).toEqual([{ caseId: "c1", choice: "yes", source: "agent", by: "csv-import", at: "2026-10-07" }]);
  });

  test("[unit] M3 a supplied label_source, labelled_by and labelled_at are kept", () => {
    const imported = parseCaseImport(
      "case_id,case_input,label,label_source,labelled_by,labelled_at\n" +
        "c1,TypeScript builder,yes,human_reviewed,operator,2026-10-03\n" +
        "c2,other,no,human,tester-7,2026-10-05T09:30:00Z\n" +
        "c3,third,no,,,\n",
      AT,
    );
    expect(imported.labels).toEqual([
      { caseId: "c1", choice: "yes", source: "human_reviewed", by: "operator", at: "2026-10-03" },
      { caseId: "c2", choice: "no", source: "human", by: "tester-7", at: "2026-10-05T09:30:00Z" },
      { caseId: "c3", choice: "no", source: "agent", by: "csv-import", at: "2026-10-07" },
    ]);
  });

  test("[unit] M3 bad label provenance names the line and the rule", () => {
    expect(() => parseCaseImport("case_id,case_input,label,label_source\nc1,x,yes,person\n")).toThrow(
      "Line 2: label_source \"person\"",
    );
    expect(() => parseCaseImport("case_id,case_input,label,label_source\nc1,x,,human\n")).toThrow(
      "Line 2: label_source is set but label is empty",
    );
    expect(() => parseCaseImport("case_id,case_input,label,labelled_by\nc1,x,yes,ann@example.com\n")).toThrow(
      "Line 2: labelled_by",
    );
    expect(() => parseCaseImport("case_id,case_input,label,labelled_at\nc1,x,yes,2026-02-31\n")).toThrow(
      "Line 2: labelled_at",
    );
    expect(() => parseCaseImport("case_id,case_input,label_source\nc1,x,human\n")).toThrow("label column");
    expect(() => parseCaseImport("case_id,case_input,label,colour\nc1,x,yes,red\n")).toThrow("colour");
  });

  test("[unit] M3 an imported label must be one of the scene's choices", () => {
    const imported = parseCaseImport("case_id,case_input,label\nc1,x,maybe\n");
    expect(() => new BackstageRun(scene(imported.cases), "test", { arms: ["jev"] }, imported.labels)).toThrow("maybe");
  });

  test("[unit] M3 export: an imported agent label is written agent and the validator does not count it as truth", async () => {
    const run = await ranRun("case_id,case_input,label\nc1,TypeScript builder,yes\nc2,other,no\n");
    expect(cells(run)).toEqual([
      ["c1", "yes", "accept", "agent", "csv-import", "2026-10-07", "false"],
      ["c2", "yes", "reject", "agent", "csv-import", "2026-10-07", "false"],
    ]);
    const parsed = validate(run.csv());
    expect(parsed.gaps.filter((g) => g.includes("agent label not reviewed")).length).toBe(2);
  });

  test("[unit] M3 export: a supplied human_reviewed label keeps its source and is not blind", async () => {
    const run = await ranRun(
      "case_id,case_input,label,label_source,labelled_by,labelled_at\nc1,TypeScript builder,no,human_reviewed,operator,2026-10-03\n",
    );
    expect(cells(run)).toEqual([["c1", "yes", "reject", "human_reviewed", "operator", "2026-10-03", "false"]]);
  });

  test("[unit] M3 a person's blind pick in the UI replaces an imported label; only then is the case human", async () => {
    const run = await ranRun("case_id,case_input,label\nc1,TypeScript builder,no\nc2,other,no\n");
    run.beginLabeling();
    run.pickBlind("c1", "yes", BACKSTAGE_BLIND_PICK, AT);
    expect(cells(run)).toEqual([
      ["c1", "yes", "accept", "human", "backstage-operator", "2026-10-07T10:00:00.000Z", "true"],
      ["c2", "yes", "reject", "agent", "csv-import", "2026-10-07", "false"],
    ]);
  });

  test("[unit] M3 the evidence JSON carries the same imported labels as the CSV", async () => {
    const run = await ranRun(
      "case_id,case_input,label,label_source,labelled_by,labelled_at\nc1,a,yes,human_reviewed,operator,2026-10-03\nc2,b,no,,,\n",
    );
    run.beginLabeling();
    run.reveal();
    expect(run.evidence().labels.map((l) => [l.caseId, l.label, l.labelSource, l.labelledBy, l.labelBlind])).toEqual([
      ["c1", "accept", "human_reviewed", "operator", false],
      ["c2", "reject", "agent", "csv-import", false],
    ]);
  });

  test("[unit] M3 a file may not claim the Backstage UI handle as its labeller", () => {
    expect(() =>
      parseCaseImport("case_id,case_input,label,label_source,labelled_by\nc1,x,yes,human,backstage-operator\n"),
    ).toThrow("Line 2: labelled_by \"backstage-operator\" is reserved");
  });

  test("[unit] M3 a person's call on one answer replaces the imported label for the whole case; unsure leaves it unlabelled", async () => {
    const imported = parseCaseImport("case_id,case_input,label\nc1,TypeScript builder,no\nc2,other,no\nc3,third,yes\n", AT);
    const run = new BackstageRun(scene(imported.cases), "test", { arms: ["jev", "rule"] }, imported.labels);
    await run.start({ jev: "test-secret-jev" }, async (request) => ({
      ...(await answerYes(request)),
      output: request.caseId === "c1" ? "no" : "yes",
    }));
    run.beginLabeling();
    // c1: the rule answers yes (keyword "typescript"), Jev answers no. A person labels only the rule's answer.
    const ruleOnC1 = run.cards().find((c) => c.caseId === "c1" && c.output === "yes");
    if (ruleOnC1 === undefined) throw new Error("no rule answer card for c1");
    run.label(ruleOnC1.id, "accept", { source: "human", by: "backstage-operator", blind: false }, AT);
    run.pickBlind("c2", null, BACKSTAGE_BLIND_PICK, AT);
    const byCase = (caseId: string) =>
      cells(run).filter((row) => row[0] === caseId).map((row) => [row[1], row[2], row[3]]);
    expect(byCase("c1").sort()).toEqual([["no", null, null], ["yes", "accept", "human"]]);
    expect(byCase("c2").sort()).toEqual([["no", null, null], ["yes", null, null]]);
    expect(byCase("c3").every((row) => row[2] === "agent")).toBe(true);
  });

  test("[unit] M3 no code path writes human for an imported label without a supplied human source", async () => {
    const run = await ranRun("case_id,case_input,label,label_source\nc1,a,yes,\nc2,b,no,agent\nc3,c,yes,human_reviewed\n");
    const sources = cells(run).map((row) => row[3]);
    expect(sources).toEqual(["agent", "agent", "human_reviewed"]);
  });
});
