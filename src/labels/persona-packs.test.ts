// Persona packs P5 to P8: 30 synthetic, unlabelled cases each, loaded by one click or one link. The tester labels them
// blind, so no label may ship with them; P1 to P4 stay byte-identical.
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { validate } from "../format/validate.ts";
import { BackstageRun, parseCaseImport } from "../backstage/run.ts";
import { STARTER_PACKS, starterPackCsv, starterPackScene } from "./starter-packs.ts";

const NEW_IDS = ["p5", "p6", "p7", "p8"];
const NEW_PACKS = STARTER_PACKS.filter((p) => NEW_IDS.includes(p.id));
const OLD_PACKS = STARTER_PACKS.filter((p) => !NEW_IDS.includes(p.id));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Captured from origin/main (aa73ae9) before P5 to P8 and the optional label were added.
const GOLDEN: Record<string, readonly [string, string]> = {
  p1: ["84898e0cd76da6e4e28891bbf03fb6999a68c77bd45abcc84349757a95c84957", "92c23869f1c5e244afe7925b3253fe0032358c5e7235fa8aa44ecd88da63651d"],
  p2: ["81e48031a2825b93c71a9f43acbacb5febee5ad8d20ec00e5dc98cef9c912cc0", "74c8aa2db5e811f3e3b5740ce2aff1b59a56b42ab82d7355ffd6e14987eab7d1"],
  p3: ["c63fadf835231b6cc9b9cd2fa45dfbe0d2d066a5ecf0a203daf27058bbdbaba3", "e9ebb17d81f6e1c2e6dd0e80d919c235b11c8beb11c70ad7c8793fc8c6384d22"],
  p4: ["8414f3eac790b2336b422073e313173d38bdec08fa900f98b43eed244d9be9c9", "e311830d92c367ed388f472648f0338c51f83f380e4c9d8f71b2daf912fdf93f"],
};

// Terms that must never reach this public repo: private names, third-party product names, private paths and
// competition wording. Each is stored in two halves so this file does not itself contain them.
const BANNED_HALVES: readonly (readonly [string, string])[] = [
  ["os", "car"], ["lutf", "iya"], ["eu", "gene"], ["chris", "tian"], ["chris", "-steven"], ["ste", "ven"],
  ["brain", " rot"], ["day", "light"], ["vanta", "ged"], ["hall", "mingle"], ["switch", " check"],
  ["chall", "enge"], ["leader", "board"], ["win", "ning"], ["_ref", "erence"], ["/Us", "ers/"], ["30", "-day"],
];
const HYGIENE = new RegExp(BANNED_HALVES.map(([a, b]) => (a + b).replace(/[/\\^$.*+?()[\]{}|]/g, "\\$&")).join("|"), "i");

describe("persona packs P5 to P8", () => {
  // The loops below are vacuous over an empty list: fail every test here unless the four packs exist.
  beforeEach(() => expect(NEW_PACKS.length).toBe(4));

  test("[unit] PP1 eight packs, P1 to P8 in order", () => {
    expect(STARTER_PACKS.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
    expect(NEW_PACKS.map((p) => p.title)).toEqual([
      "P5 Video check: keep watching or quiz",
      "P6 Morning headline: print it or spike it",
      "P7 Rubric check: passes or another lesson",
      "P8 Event host: seat them or step in",
    ]);
  });

  test("[unit] PP2 each new pack has 30 cases with unique ids prefixed by the pack id, and no label of any kind", () => {
    for (const pack of NEW_PACKS) {
      expect(pack.cases.length).toBe(30);
      expect(new Set(pack.cases.map((c) => c.id)).size).toBe(30);
      for (const c of pack.cases) {
        expect(c.id.startsWith(`${pack.id}-`)).toBe(true);
        expect(c.input.trim().length).toBeGreaterThan(0);
        expect("label" in c ? c.label : undefined).toBeUndefined();
        expect("source" in c ? c.source : undefined).toBeUndefined();
        expect("labelledBy" in c ? c.labelledBy : undefined).toBeUndefined();
        expect("labelledAt" in c ? c.labelledAt : undefined).toBeUndefined();
      }
      expect(pack.choices.length).toBe(2);
      expect(pack.question.length).toBeGreaterThan(0);
      expect(pack.persona.length).toBeGreaterThan(0);
    }
  });

  test("[unit] PP3 public hygiene: no person, third-party product, private path or challenge wording anywhere in a new pack", () => {
    for (const pack of NEW_PACKS) expect([pack.id, JSON.stringify(pack).match(HYGIENE)?.[0] ?? null]).toEqual([pack.id, null]);
    for (const pack of NEW_PACKS)
      // 555 01xx is the range reserved for fictional numbers; a P8 case uses one to show a shared contact detail.
      for (const c of pack.cases)
        expect(c.input.replace(/\b555[-. ]01\d\d\b/g, "")).not.toMatch(/@|https?:|www\.|\b\d{3}[-. ]\d{4}\b/);
  });

  test("[unit] PP4 an unlabelled pack's CSV has empty label columns and imports as 30 cases with no labels", () => {
    for (const pack of NEW_PACKS) {
      const csv = starterPackCsv(pack);
      const imported = parseCaseImport(csv, new Date("2026-10-07T12:00:00Z"));
      expect(imported.cases.map((c) => [c.id, c.input])).toEqual(pack.cases.map((c) => [c.id, c.input]));
      expect(imported.labels).toEqual([]);
      const lines = csv.trimEnd().split("\n");
      expect(lines[0]).toBe("case_id,case_input,label,label_source,labelled_by,labelled_at");
      // Every record ends with four empty label fields.
      expect(csv.match(/,,,,\r?\n/g)?.length).toBe(30);
    }
  });

  test("[unit] PP5 an unlabelled pack runs offline into jnj-record/1.1 rows that validate, with empty labels", async () => {
    for (const pack of NEW_PACKS) {
      const imported = parseCaseImport(starterPackCsv(pack));
      // The packs ship no keyword rule; a tester may add one, so the rule arm runs here with a placeholder keyword.
      const scene = { ...starterPackScene(pack, imported.cases), keywords: ["placeholder"] };
      const run = new BackstageRun(scene, "test", { arms: ["jev", "rule"] }, imported.labels);
      await run.start({ jev: "test-secret-jev" }, async () => {
        throw new Error("offline");
      });
      const parsed = validate(run.csv());
      expect(parsed.rows.length).toBeGreaterThan(0);
      for (const { values } of parsed.rows) {
        expect(values.get("format_version")).toBe("jnj-record/1.1");
        expect(values.get("label")).toBeNull();
      }
      expect(parsed.errors).toEqual([]);
    }
  });
});

describe("P1 to P4 are unchanged", () => {
  test("[unit] PP6 CSV and scene of P1 to P4 are byte-identical to origin/main", () => {
    expect(OLD_PACKS.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    for (const pack of OLD_PACKS) {
      const golden = GOLDEN[pack.id];
      expect(golden).toBeDefined();
      expect([pack.id, sha(starterPackCsv(pack)), sha(JSON.stringify(starterPackScene(pack, [])))]).toEqual([pack.id, ...(golden ?? [])]);
    }
  });
});
