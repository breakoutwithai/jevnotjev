import { describe, expect, test } from "bun:test";
import { MAX_POSTERS, casesToClear, headlineOf, parseUseCase, rankPosters, verdictWordShown, whyNotYetOf, type HeadlinePair, type Poster } from "./posters.ts";
import { newcombePaired } from "../core/calc.ts";
import { MARGIN } from "../core/verdict.ts";

const paired: HeadlinePair = {
  n: 40,
  jev: { accepted: 38, spend: { kind: "complete", usd: 0.00130176 } },
  otherArm: { accepted: 38, spend: { kind: "complete", usd: 0.103167 } },
};

test("[unit] S6 equal accuracy and 79x lower spend yield the measured headline", () => {
  expect(headlineOf(paired, 40)).toBe("Same accuracy as the LLM (38/40 each) at 1/79th of the cost");
});

test("[unit] S6 UC13 projection first clears the margin after six extra paired cases", () => {
  const counts = { a: 37, b: 1, c: 1, d: 1 };
  expect(casesToClear(counts)).toBe(6);
  expect(newcombePaired({ a: 43, b: 1, c: 1, d: 1 }).lower).toBeGreaterThan(-MARGIN);
  expect(newcombePaired({ a: 42, b: 1, c: 1, d: 1 }).lower).toBeLessThanOrEqual(-MARGIN);
  expect(whyNotYetOf("not enough evidence", ["accept-rate-not-shown"], counts)).toBe("Not proven yet: the lower bound of Jev minus the LLM is -0.11, below the -0.10 margin, on 40 paired cases. If the next cases split the same way, about 6 more paired cases would bring it inside the margin.");
});

test("[unit] S6 a more accurate and cheaper Jev gets its own measured form", () => {
  expect(headlineOf({ ...paired, otherArm: { ...paired.otherArm, accepted: 37 } }, 40)).toBe("At least as accurate as the LLM (38/40 vs 37/40) at 1/79th of the cost");
});

test("[unit] S6 a less accurate Jev never gets a cost headline", () => {
  expect(headlineOf({ ...paired, jev: { ...paired.jev, accepted: 37 } }, 40)).toBeNull();
});

test("[unit] S6 equal or higher Jev spend suppresses the headline", () => {
  for (const spendUsd of [0.103167, 0.2]) {
    expect(headlineOf({ ...paired, jev: { ...paired.jev, spend: { kind: "complete", usd: spendUsd } } }, 40)).toBeNull();
  }
});

test("[unit] S6 missing spend in either arm suppresses the headline", () => {
  for (const arm of ["jev", "llm"]) {
    const incomplete: HeadlinePair["jev"]["spend"] = { kind: "incomplete", knownUsd: 0, missing: 1 };
    const changed = arm === "jev" ? { ...paired, jev: { ...paired.jev, spend: incomplete } } : { ...paired, otherArm: { ...paired.otherArm, spend: incomplete } };
    expect(headlineOf(changed, 40)).toBeNull();
  }
});

test("[unit] S6 a ratio below two suppresses a misleading onefold headline", () => {
  expect(headlineOf({ ...paired, jev: { ...paired.jev, spend: { kind: "complete", usd: 0.06 } } }, 40)).toBeNull();
});

test("[unit] S6 fewer than 30 paired labels suppresses the headline", () => {
  expect(headlineOf({ ...paired, n: 29 }, 29)).toBeNull();
});

test("[unit] S6 both zero accepted suppresses the headline", () => {
  expect(headlineOf({ ...paired, jev: { ...paired.jev, accepted: 0 }, otherArm: { ...paired.otherArm, accepted: 0 } }, 40)).toBeNull();
});

test("[unit] S6 cost ordinal suffixes follow English number endings", () => {
  const cases: readonly (readonly [number, string])[] = [[2, "2nd"], [3, "3rd"], [11, "11th"], [21, "21st"], [79, "79th"]];
  for (const [ratio, suffix] of cases) {
    // Keep the LLM spend at 1, so the cost ratio is the listed integer.
    const exact = headlineOf({ ...paired, jev: { ...paired.jev, spend: { kind: "complete", usd: 1 / ratio } }, otherArm: { ...paired.otherArm, spend: { kind: "complete", usd: 1 } } }, 40);
    expect(exact).toContain(`1/${suffix} of the cost`);
  }
});

test("[unit] S6 projection appears only for the unchanged rule-four condition", () => {
  const counts = { a: 37, b: 1, c: 1, d: 1 };
  expect(whyNotYetOf("use Jev", ["accept-rate-not-shown"], counts)).toBeNull();
  expect(whyNotYetOf("not enough evidence", ["cost-upper-bound-not-below-1"], counts)).toBeNull();
  expect(whyNotYetOf("not enough evidence", ["accept-rate-not-shown", "cost-upper-bound-not-below-1"], counts)).toBeNull();
  expect(whyNotYetOf("not enough evidence", ["accept-rate-not-shown"], { a: 1, b: 0, c: 39, d: 0 })).toBeNull();
});

test("[unit] S6 a bound just below the margin never says zero points", () => {
  const line = whyNotYetOf("not enough evidence", ["accept-rate-not-shown"], { a: 26, b: 0, c: 0, d: 4 });
  expect(line).toContain("lower bound of Jev minus the LLM is -0.10");
  expect(line).not.toContain("0 points");
});

test("[unit] S6 a projection beyond the 2000-case search cap uses the plain fallback", () => {
  expect(casesToClear({ a: 1000, b: 180, c: 360, d: 460 })).toBeNull();
  expect(whyNotYetOf("not enough evidence", ["accept-rate-not-shown"], { a: 1000, b: 180, c: 360, d: 460 })).toBe("More cases settle it.");
});

const doc = [
  "# UC13: Shop bot, answer or hand off",
  "",
  "**User story:** As a small shop owner I want the bot to answer what its facts cover.",
  "",
  "## Jev or not",
  "Split. Looking up a price is code: **!Jev**. Deciding one message is a fixed choice: **Jev could help**.",
  "",
  "Files: the run in [docs/product/runs/2026-10-01-uc13-shop-bot/](../runs/2026-10-01-uc13-shop-bot/).",
].join("\n");

const poster = (id: string, date: string): Poster =>
  ({ id: id, title: id, story: "", fit: [], stage: "script-reading", date: date, source: `docs/product/use-cases/${id}.md`, run: null, watch: null });

describe("parseUseCase", () => {
  test("[unit] T2 title, story, fit check and run folder come from the doc text", () => {
    expect(parseUseCase("uc13-shop-bot-answer-or-handoff.md", doc)).toEqual({
      id: "uc13",
      title: "Shop bot, answer or hand off",
      story: "As a small shop owner I want the bot to answer what its facts cover.",
      fit: ["!Jev", "Jev could help"],
      runFolder: "2026-10-01-uc13-shop-bot",
    });
  });

  test("[unit] T2 a doc with no run link has no run folder", () => {
    expect(parseUseCase("uc9-x.md", "# UC9: Roast\n\n**User story:** As a builder.\n").runFolder).toBeNull();
  });
});

describe("verdictWordShown", () => {
  test("[unit] T2 poster under 30 paired labels shows no verdict word", () => {
    expect(verdictWordShown(29)).toBe(false);
    expect(verdictWordShown(0)).toBe(false);
    expect(verdictWordShown(30)).toBe(true);
  });
});

describe("rankPosters", () => {
  test("[unit] ranking: newer item outranks older at equal tickets", () => {
    const ids = rankPosters([poster("old", "2026-09-01"), poster("new", "2026-10-01")], {}).map((p) => p.id);
    expect(ids).toEqual(["new", "old"]);
  });

  test("[unit] ranking: tickets lift an older item", () => {
    const ids = rankPosters([poster("old", "2026-09-28"), poster("new", "2026-10-01")], { old: 5 }).map((p) => p.id);
    expect(ids).toEqual(["old", "new"]);
  });

  test("[unit] T2 at most 10 posters", () => {
    const many = Array.from({ length: 14 }, (_, i) => poster(`uc${i}`, `2026-09-${String(10 + i).padStart(2, "0")}`));
    expect(rankPosters(many, {}).length).toBe(MAX_POSTERS);
    expect(MAX_POSTERS).toBe(10);
  });
});
