// Packs P9 (booking claim) and P10 (reply swap): 30 synthetic, unlabelled cases each, opened by /backstage/?pack=p9
// and ?pack=p10, ready to run on the house Jev key with no key from the tester.
import { describe, expect, test } from "bun:test";
import { sanitizeNextPath } from "../backstage/auth.ts";
import { parseCaseImport, validateSceneKeys } from "../backstage/run.ts";
import { packFromSearch } from "./pack-link.ts";
import { STARTER_PACKS, starterPackCsv, starterPackScene } from "./starter-packs.ts";

const IDS = ["p9", "p10"];
const PACKS = STARTER_PACKS.filter((p) => IDS.includes(p.id));
const BANNED_HALVES: readonly (readonly [string, string])[] = [
  ["ol", "ly"], ["lutf", "iya"], ["switch", " check"], ["bur", "ton"], ["chall", "enge"], ["golden", " ticket"], ["_ref", "erence"], ["/Us", "ers/"], ["30", "-day"],
];
const HYGIENE = new RegExp(BANNED_HALVES.map(([a, b]) => (a + b).replace(/[/\\^$.*+?()[\]{}|]/g, "\\$&")).join("|"), "i");

describe("packs P9 and P10", () => {
  test("[unit] BS1 both packs exist with 30 unique, unlabelled cases prefixed by the pack id", () => {
    expect(PACKS.map((p) => p.id)).toEqual(IDS);
    for (const pack of PACKS) {
      expect(pack.cases.length).toBe(30);
      expect(new Set(pack.cases.map((c) => c.id)).size).toBe(30);
      for (const c of pack.cases) {
        expect(c.id.startsWith(`${pack.id}-`)).toBe(true);
        expect("label" in c).toBe(false);
      }
    }
  });

  test("[unit] BS2 P9 asks the booking-claim question with not_confirmed as the keep-unknown answer; P10 asks as_good or worse", () => {
    const [p9, p10] = PACKS;
    expect(p9?.choices.map((c) => c.name)).toEqual(["confirmed", "not_confirmed"]);
    expect(p9?.choices[1].definition).toContain("Unknown availability stays unknown");
    expect(p10?.choices.map((c) => c.name)).toEqual(["worse", "as_good"]);
  });

  test("[unit] BS3 public hygiene: no person, product, private path or contact detail", () => {
    for (const pack of PACKS) {
      expect([pack.id, JSON.stringify(pack).match(HYGIENE)?.[0] ?? null]).toEqual([pack.id, null]);
      for (const c of pack.cases) expect(c.input).not.toMatch(/@|https?:|www\.|\b\d{3}[-. ]\d{4}\b/);
    }
  });

  test("[unit] BS4 the CSV imports through the real importer as 30 cases with no labels", () => {
    for (const pack of PACKS) {
      const imported = parseCaseImport(starterPackCsv(pack), new Date("2026-10-15T12:00:00Z"));
      expect(imported.cases.map((c) => [c.id, c.input])).toEqual(pack.cases.map((c) => [c.id, c.input]));
      expect(imported.labels).toEqual([]);
    }
  });

  test("[unit] BS5 /backstage/?pack=p9 and ?pack=p10 select the packs and survive the sign-in round trip", () => {
    for (const id of IDS) {
      expect(packFromSearch(`?pack=${id}`)?.id).toBe(id);
      expect(sanitizeNextPath(`/backstage/?pack=${id}`)).toBe(`/backstage/?pack=${id}`);
    }
  });

  test("[unit] BS6 a Jev-and-rule scene from either pack needs no tester key when the house key is on", () => {
    for (const pack of PACKS) {
      const scene = starterPackScene(pack, pack.cases.map((c) => ({ id: c.id, input: c.input })));
      expect(scene.matchChoice).toBe(pack.choices[0].name);
      expect(() => validateSceneKeys(scene, {}, "jev-only", true, true)).not.toThrow();
      expect(() => validateSceneKeys(scene, {}, "jev-only", false, true)).toThrow();
    }
  });
});
