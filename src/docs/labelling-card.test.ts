// The tester label card (labelling loop M3): one page, every answer a tester can pick in calibration or a starter pack,
// each in one row with two examples, and no example that gives away a practice or pack case.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { UC13_CALIBRATION } from "../labels/calibration-set.ts";
import { STARTER_PACKS } from "../labels/starter-packs.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CARD = join(ROOT, "docs/product/labelling-card.md");

describe("labelling card", () => {
  test("[unit] M3 the card states the session: 10 cases, 10 minutes, unsure, synthetic or redacted, calibration first", async () => {
    const card = await Bun.file(CARD).text();
    for (const phrase of ["10 cases", "10 minutes", "Unsure", "Synthetic or redacted", "5 practice cases", "Pick blind"])
      expect(card).toContain(phrase);
    expect(card.split("\n").length).toBeLessThanOrEqual(60);
  });

  test("[unit] M3 every calibration and starter-pack answer has one row with a sentence and two examples", async () => {
    const card = await Bun.file(CARD).text();
    const names = new Set([
      ...UC13_CALIBRATION.choices.map((c) => c.name),
      ...STARTER_PACKS.flatMap((p) => p.choices.map((c) => c.name)),
    ]);
    for (const name of names) {
      const row = card.split("\n").find((line) => line.includes(`| \`${name}\` |`));
      expect([name, row !== undefined]).toEqual([name, true]);
      const examples = row?.split("|").at(-2) ?? "";
      expect([name, examples.split(";").length]).toEqual([name, 2]);
    }
  });

  test("[unit] M3 no card example is a calibration or starter-pack case", async () => {
    const card = (await Bun.file(CARD).text()).toLowerCase();
    const inputs = [...UC13_CALIBRATION.cases.map((c) => c.input), ...STARTER_PACKS.flatMap((p) => p.cases.map((c) => c.input))];
    for (const input of inputs) expect([input, card.includes(input.toLowerCase())]).toEqual([input, false]);
  });

  test("[unit] M3 Backstage links the card from the New Scene and Rehearsals rooms", async () => {
    const page = await Bun.file(join(ROOT, "site/backstage/index.html")).text();
    const href = "https://github.com/breakoutwithai/jevnotjev/blob/main/docs/product/labelling-card.md";
    expect(page.split(href).length - 1).toBeGreaterThanOrEqual(2);
  });
});
