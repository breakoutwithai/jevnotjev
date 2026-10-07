// Starter packs P1 to P4 (labelling loop M3): ten synthetic cases each, pre-labelled, every label honest about its
// source. P1's labels are the person-approved UC13 truths (human_reviewed); P2 to P4 were drafted by an agent and no
// person has reviewed them yet, so they are agent and never counted as truth.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readDictRows } from "../format/csv.ts";
import { validate } from "../format/validate.ts";
import { APPROVED_DRAFT_2026_10_03, CRITERIA, QUESTION, jevBody } from "../../scripts/uc13/arms.ts";
import type { AnswerRequest } from "../backstage/contracts.ts";
import { BackstageRun, parseCaseImport } from "../backstage/run.ts";
import { UC13_CALIBRATION, UC13_FACT_SHEET } from "./calibration-set.ts";
import { STARTER_PACKS, starterPackCsv, starterPackScene } from "./starter-packs.ts";

const ROOT = join(import.meta.dir, "..", "..");

describe("STARTER_PACKS", () => {
  test("[unit] M3 four packs, P1 to P4, ten cases each with unique ids and a label from the pack's two choices", () => {
    expect(STARTER_PACKS.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    for (const pack of STARTER_PACKS) {
      expect(pack.cases.length).toBe(10);
      expect(new Set(pack.cases.map((c) => c.id)).size).toBe(10);
      const names = pack.choices.map((c) => c.name);
      for (const c of pack.cases) expect(names).toContain(c.label);
      // Both answers appear, so a pack can show an arm getting one wrong either way.
      expect(new Set(pack.cases.map((c) => c.label)).size).toBe(2);
    }
  });

  test("[unit] M3 P1 labels are the approved UC13 truths, human_reviewed, and share no case with calibration", async () => {
    const labels = new Map(
      readDictRows(await Bun.file(join(ROOT, "docs/product/runs/2026-10-01-uc13-shop-bot/labels.csv")).text()).rows.map(
        (r) => [r.fields[0] ?? "", r.fields[1] ?? ""],
      ),
    );
    const p1 = STARTER_PACKS[0];
    if (p1 === undefined) throw new Error("no P1");
    expect(p1.question).toBe(QUESTION);
    expect(p1.choices.map((c) => [c.name, c.definition])).toEqual([
      ["hand_off", CRITERIA.hand_off],
      ["answer", CRITERIA.answer],
    ]);
    const inputs = new Map(
      (await Bun.file(join(ROOT, "examples/uc13-shop-bot/cases.jsonl")).text())
        .split("\n")
        .filter(Boolean)
        .map((line): [string, string] => {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null || !("case_id" in parsed) || !("case_input" in parsed))
            throw new Error("bad cases.jsonl line");
          return [String(parsed.case_id), String(parsed.case_input)];
        }),
    );
    const factSheet = (await Bun.file(join(ROOT, "examples/uc13-shop-bot/fact-sheet.md")).text()).trim();
    const calibration = new Set(UC13_CALIBRATION.cases.map((c) => c.id));
    for (const c of p1.cases) {
      // The labels were approved for a message read with the fact sheet: each case carries the UC13 Jev state verbatim.
      expect(c.input).toBe(jevBody(factSheet, { case_id: c.id, case_input: inputs.get(c.id) ?? "missing" }).state);
      expect(c.label).toBe(labels.get(c.id) ?? "missing");
      expect([c.source, c.labelledBy, c.labelledAt]).toEqual([
        APPROVED_DRAFT_2026_10_03.source,
        APPROVED_DRAFT_2026_10_03.by,
        APPROVED_DRAFT_2026_10_03.at,
      ]);
      expect(calibration.has(c.id)).toBe(false);
    }
  });

  test("[unit] M3 P2 to P4 are agent-labelled: no person reviewed them, so none is marked human", () => {
    for (const pack of STARTER_PACKS.slice(1))
      for (const c of pack.cases) {
        expect(c.source).toBe("agent");
        expect(c.labelledBy).not.toBe("operator");
      }
    for (const pack of STARTER_PACKS) for (const c of pack.cases) expect(c.source).not.toBe("human");
  });

  test("[unit] M3 P1's fact sheet reaches every model call: each request's case text holds it", async () => {
    const p1 = STARTER_PACKS[0];
    if (p1 === undefined) throw new Error("no P1");
    const imported = parseCaseImport(starterPackCsv(p1));
    const run = new BackstageRun(starterPackScene(p1, imported.cases), "test", { arms: ["jev"] }, imported.labels);
    const sent: AnswerRequest[] = [];
    await run.start({ jev: "test-secret-jev" }, async (request) => {
      sent.push(request);
      throw new Error("offline");
    });
    expect(sent.length).toBe(10);
    for (const request of sent) {
      expect(request.input).toContain(UC13_FACT_SHEET);
      expect(request.input).toContain("Customer message:\n");
    }
  });

  test("[unit] M3 cases are synthetic: no email address, phone number or web address in any case text", () => {
    for (const pack of STARTER_PACKS)
      for (const c of pack.cases) {
        // The UC13 fact sheet's 555-0142 is a fictional number; check what each case adds to it.
        expect(c.input.replace(UC13_FACT_SHEET, "")).not.toMatch(/@|https?:|www\.|\b\d{3}[-. ]\d{4}\b/);
        expect(c.input.length).toBeLessThanOrEqual(8000);
      }
  });

  test("[unit] M3 each pack's CSV goes through the case import with its labels and sources intact", () => {
    for (const pack of STARTER_PACKS) {
      const imported = parseCaseImport(starterPackCsv(pack), new Date("2026-10-07T12:00:00Z"));
      expect(imported.cases.map((c) => [c.id, c.input])).toEqual(pack.cases.map((c) => [c.id, c.input]));
      expect(imported.labels.map((l) => [l.caseId, l.choice, l.source, l.by, l.at])).toEqual(
        pack.cases.map((c) => [c.id, c.label, c.source, c.labelledBy, c.labelledAt]),
      );
    }
  });

  test("[unit] M3 a pack's keyword rule points the right way: on its own cases it agrees with the labels more often than not", async () => {
    for (const pack of STARTER_PACKS.filter((p) => p.keywords.length > 0)) {
      const imported = parseCaseImport(starterPackCsv(pack));
      const run = new BackstageRun(starterPackScene(pack, imported.cases), "test", { arms: ["jev", "rule"] }, imported.labels);
      await run.start({ jev: "test-secret-jev" }, async () => {
        throw new Error("offline");
      });
      const outputs = new Map(
        validate(run.csv())
          .rows.filter(({ values }) => values.get("answerer") === "rule")
          .map(({ values }) => [String(values.get("case_id")), String(values.get("output"))]),
      );
      const agree = pack.cases.filter((c) => outputs.get(c.id) === c.label).length;
      // An inverted rule (match answers the wrong choice) would agree on at most 4 of these 10.
      expect([pack.id, agree >= 6]).toEqual([pack.id, true]);
    }
  });

  test("[unit] M3 each pack loads as a Backstage scene with its imported labels", () => {
    for (const pack of STARTER_PACKS) {
      const imported = parseCaseImport(starterPackCsv(pack));
      const arms = pack.keywords.length > 0 ? ["jev", "rule"] : ["jev"];
      const run = new BackstageRun(starterPackScene(pack, imported.cases), "test", { arms }, imported.labels);
      expect(run.manifest.scene.cases.length).toBe(10);
      expect(run.manifest.scene.choices.map((c) => c.name)).toEqual(pack.choices.map((c) => c.name));
    }
  });
});
