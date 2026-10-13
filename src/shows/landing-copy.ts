// Approved landing sample words, and every figure they show as a structured value. src/docs/landing-samples.test.ts
// computes each value from its source (a run's records.csv through src/core, a src/core/verdict.ts constant, or a
// use-case doc field) and checks each whole claim fragment follows from it by the named format and declared arms.
export type FigureArm = "jev" | "llm" | "rule";
export type FigurePart = "verdict" | "why" | "cases" | "next" | "rephrase" | "earlier";
export type FigureMetric = "accepted" | "labelled" | "spend" | "model" | "paired" | "acceptedEach" | "toMinimum" | "rule" | "lowerBound"
  | "costRatio" | "spendRatio" | "minPaired" | "margin" | "docCases" | "docAnswers";
export type FigureFormat = "int" | "rule" | "pointLimit" | "messageRun" | "pointsBehind" | "tiedTo" | "armCount" | "armScore"
  | "armModelCount" | "armModelScore" | "armSpent4" | "armSpent5" | "armSpendOf4" | "armSpendOf5" | "modelWas" | "modelAs"
  | "keptAsMany" | "sameAccuracy" | "costShareOf" | "costShare" | "tiedEach" | "spendShareOf" | "answers";
export interface LandingFigure {
  readonly part: FigurePart;
  readonly display: string;
  readonly format: FigureFormat;
  readonly source: string;
  readonly metric?: FigureMetric;
  readonly arm?: FigureArm;
  readonly arms?: readonly [FigureArm, FigureArm];
  readonly values: readonly (number | string)[];
  readonly question?: string;
  readonly row?: string;
}
export interface ExplainedCopy {
  readonly verdict: string;
  readonly why: string;
  readonly cases: string;
  readonly next: string;
  readonly rephrase: string | null;
  readonly earlier: string | null;
  readonly figures: readonly LandingFigure[];
}
export type LandingSampleId = "stage" | "uc9" | "uc10" | "uc11" | "uc12" | "uc13";
const R100 = "docs/product/runs/2026-10-11-uc13-shop-bot-100/records.csv";
const R40 = "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv";
const RCV = "docs/product/runs/2026-10-03-tokenmax/records.csv";
const VERDICT_TS = "src/core/verdict.ts";
type Opt = Pick<LandingFigure, "metric" | "arm" | "arms" | "question" | "row">;
const f = (part: FigurePart, display: string, format: FigureFormat, values: readonly (number | string)[], source: string, opt: Opt = {}): LandingFigure =>
  ({ part, display, format, values, source, ...opt });
const jev: Opt = { arm: "jev" }, llm: Opt = { arm: "llm" }, rule: Opt = { arm: "rule" };
const jL: Opt = { arms: ["jev", "llm"] };
const q1 = (opt: Opt = {}): Opt => ({ ...opt, question: "q1" });
export const LANDING_COPY: Readonly<Record<LandingSampleId, ExplainedCopy>> = {
  stage: {
    verdict: "Use Jev (rule 3)",
    why: "On 100 shop messages Jev kept as many right answers as the LLM (88 against 86), and even at the cautious end of the range it is no more than about 4 points behind, inside the 10-point limit. Each kept answer cost Jev about a fifth of what it cost the LLM.",
    cases: "Jev 88 of 100, the LLM (Claude Haiku 5.5) 86 of 100, the simple rule 49 of 100. Jev spent $0.0033 against the LLM's $0.0163.",
    next: "Try it on your own decision: write 30 or more cases, label them, and load the results.",
    earlier: "On the first 40 of these messages Jev and the LLM tied, 38 each, and 40 was too few to prove it: the verdict was Not proven yet. That run used Claude Haiku 4.5 as the LLM, which is why its cost gap (Jev about 1/79th of the LLM) differs from this run.",
    rephrase: null,
    figures: [
      f("verdict", "rule 3", "rule", [3], R100),
      f("why", "100", "int", [100], R100, { metric: "paired" }),
      f("why", "Jev kept as many right answers as the LLM (88 against 86)", "keptAsMany", [88, 86], R100, jL),
      f("why", "no more than about 4 points behind", "pointsBehind", [-0.04266031343755382], R100),
      f("why", "inside the 10-point limit", "pointLimit", [-0.04266031343755382, 0.1], R100),
      f("why", "cost Jev about a fifth of what it cost the LLM", "costShareOf", [0.19745918526106973], R100, jL),
      f("cases", "Jev 88 of 100", "armScore", [88, 100], R100, jev),
      f("cases", "the LLM (Claude Haiku 5.5) 86 of 100", "armModelScore", ["claude-haiku-5-5", 86, 100], R100, llm),
      f("cases", "the simple rule 49 of 100", "armScore", [49, 100], R100, rule),
      f("cases", "Jev spent $0.0033", "armSpent4", [0.00328442], R100, jev),
      f("cases", "the LLM's $0.0163", "armSpendOf4", [0.01625538], R100, llm),
      f("next", "30 or more", "int", [30], VERDICT_TS, { metric: "minPaired" }),
      f("earlier", "40", "int", [40], R40, { metric: "paired" }),
      f("earlier", "Jev and the LLM tied, 38 each", "tiedEach", [38], R40, jL),
      f("earlier", "40", "int", [40], R40, { metric: "paired" }),
      f("earlier", "Claude Haiku 4.5 as the LLM", "modelAs", ["claude-haiku-4-5-20251001"], R40, llm),
      f("earlier", "Jev about 1/79th of the LLM", "spendShareOf", [79.25193584070799], R40, jL),
    ],
  },
  uc13: {
    verdict: "Use Jev (100 messages)",
    why: "Same accuracy as the LLM (88 against 86 of 100) at about a fifth of the cost per kept answer.",
    cases: "Jev 88, LLM (Haiku 5.5) 86, simple rule 49, of 100.",
    next: "Open the 100-message run, or try your own decision.",
    earlier: "40 messages: tied 38 to 38, Not proven yet (LLM was Haiku 4.5).",
    rephrase: null,
    figures: [
      f("verdict", "100", "int", [100], R100, { metric: "paired" }),
      f("why", "Same accuracy as the LLM (88 against 86 of 100)", "sameAccuracy", [88, 86, 100], R100, jL),
      f("why", "at about a fifth of the cost per kept answer", "costShare", [0.19745918526106973], R100, jL),
      f("cases", "Jev 88", "armCount", [88], R100, jev),
      f("cases", "LLM (Haiku 5.5) 86", "armModelCount", ["claude-haiku-5-5", 86], R100, llm),
      f("cases", "simple rule 49", "armCount", [49], R100, rule),
      f("cases", "100", "int", [100], R100, { metric: "paired" }),
      f("next", "100-message", "messageRun", [100], R100),
      f("earlier", "40", "int", [40], R40, { metric: "paired" }),
      f("earlier", "tied 38 to 38", "tiedTo", [38], R40),
      f("earlier", "LLM was Haiku 4.5", "modelWas", ["claude-haiku-4-5-20251001"], R40, llm),
    ],
  },
  uc11: {
    verdict: "Not enough evidence (rule 1)",
    why: "Only 5 CVs are labelled. The rules need at least 30 before they compare Jev with the LLM.",
    cases: "Jev 5 of 5, the LLM 5 of 5, the simple rule 2 of 5. Jev spent $0.00008 against the LLM's $0.0109.",
    next: "Label 25 more CVs against the same ad line.",
    rephrase: '"Rank these CVs" is a written judgement, so Jev probably not. Ask one yes/no per ad line instead: "Does the CV show the person has built or run a product that pools AI subscriptions or tokens?" Code adds up the lines to rank (pattern P2).',
    earlier: null,
    figures: [
      f("verdict", "rule 1", "rule", [1], RCV, q1()),
      f("why", "5", "int", [5], RCV, q1({ metric: "paired" })),
      f("why", "at least 30", "int", [30], VERDICT_TS, { metric: "minPaired" }),
      f("cases", "Jev 5 of 5", "armScore", [5, 5], RCV, q1(jev)),
      f("cases", "the LLM 5 of 5", "armScore", [5, 5], RCV, q1(llm)),
      f("cases", "the simple rule 2 of 5", "armScore", [2, 5], RCV, q1(rule)),
      f("cases", "Jev spent $0.00008", "armSpent5", [0.000080682], RCV, q1(jev)),
      f("cases", "the LLM's $0.0109", "armSpendOf4", [0.010851], RCV, q1(llm)),
      f("next", "25 more", "int", [25], RCV, q1({ metric: "toMinimum" })),
    ],
  },
  uc12: {
    verdict: "Split two ways",
    why: "No cases have been run yet, so there is nothing to compare.",
    cases: "nothing yet.",
    next: "20 or more requirement and evidence pairs, each labelled met, partly met or not met by hand.",
    rephrase: 'Where a test or check script exists, its exit code decides "met", and Jev adds nothing. Where the evidence is prose, ask: "Does this evidence excerpt support this requirement? met / partly met / not met" (pattern P1).',
    earlier: null,
    figures: [f("next", "20 or more", "int", [20], "docs/product/use-cases/uc12-requirement-evidence-check.md", { metric: "docCases" })],
  },
  uc10: {
    verdict: "Jev probably not",
    why: 'No cases have been run. "Decide my tech stack" is open design work that needs reasoning and a written answer, which Jev does not do.',
    cases: "nothing yet.",
    next: "20 or more project descriptions, each labelled by hand with the properties it needs.",
    rephrase: 'Ask yes/no per property instead: "Does this project need realtime updates?" (and the same for relational joins, row-level access, self-hosting, offline-first, file storage). A written mapping table, not Jev, turns the answers into the stack (pattern P2).',
    earlier: null,
    figures: [f("next", "20 or more", "int", [20], "docs/product/use-cases/uc10-tech-stack-choice.md", { metric: "docCases" })],
  },
  uc9: {
    verdict: "Jev probably not",
    why: 'No cases have been run. "Is this AI slop?" is an open question with no fixed answer set.',
    cases: "nothing yet.",
    next: "a labelled set of real sites, each check marked by hand, before any score is published.",
    rephrase: 'Ask one check at a time with a fixed answer, for example "Is the headline generic marketing filler? 0 / 1 / 2" or "Does the hero use a purple-to-blue gradient? yes / no". Code weights the answers into the score (pattern P3). Jev reads text only, so visual checks need the page text or CSS.',
    earlier: null,
    figures: [f("rephrase", "0 / 1 / 2", "answers", ["0 / 1 / 2"], "docs/product/use-cases/uc9-website-slop-roast.md", { row: "S6" })],
  },
};
