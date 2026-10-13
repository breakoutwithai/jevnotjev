// Approved landing sample words and the source of each displayed figure.
export type FigureFact = "accepted:jev" | "accepted:llm" | "accepted:rule" | "labelled:jev" | "labelled:llm" | "labelled:rule" | "spend:jev" | "spend:llm" | "spend:rule" | "toMinimum";
export type LandingFigure = { readonly text: string; readonly file: string; readonly quote: string } | { readonly text: string; readonly file: string; readonly fact: FigureFact; readonly question?: string };
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
const hundredLabels = "docs/product/runs/2026-10-11-uc13-shop-bot-100/LABELS.md";
const hundredReadme = "docs/product/runs/2026-10-11-uc13-shop-bot-100/README.md";
const hundredRecords = "docs/product/runs/2026-10-11-uc13-shop-bot-100/records.csv";
const fortyRecords = "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv";
const cvRecords = "docs/product/runs/2026-10-03-tokenmax/records.csv";
const approved = "`bun src/decide/cli.ts verdict records.csv`: use Jev (rule 3). Jev accepted 88 of 100, the LLM 86 of 100 (paired a 83, b 5, c 3, d 9); Jev minus LLM +0.02, lower bound -0.043; Jev costs 0.197 of the LLM per accepted answer (upper bound 0.218).";
const minimum = "on at least 30 paired Jev and rule cases";
const fig = (text: string, file: string, quote: string): LandingFigure => ({ text, file, quote });
const fact = (text: string, file: string, kind: FigureFact, question?: string): LandingFigure => ({ text, file, fact: kind, ...(question === undefined ? {} : { question }) });
export const LANDING_COPY: Readonly<Record<LandingSampleId, ExplainedCopy>> = {
  stage: {
    verdict: "Use Jev (rule 3)",
    why: "On 100 shop messages Jev kept as many right answers as the LLM (88 against 86), and even at the cautious end of the range it is no more than about 4 points behind, inside the 10-point limit. Each kept answer cost Jev about a fifth of what it cost the LLM.",
    cases: "Jev 88 of 100, the LLM (Claude Haiku 5.5) 86 of 100, the simple rule 49 of 100. Jev spent $0.0033 against the LLM's $0.0163.",
    next: "Try it on your own decision: write 30 or more cases, label them, and load the results.",
    earlier: "On the first 40 of these messages Jev and the LLM tied, 38 each, and 40 was too few to prove it: the verdict was Not proven yet. That run used Claude Haiku 4.5 as the LLM, which is why its cost gap (Jev about 1/79th of the LLM) differs from this run.",
    rephrase: null,
    figures: [
      fig("rule 3", hundredLabels, approved), fig("100 shop messages", hundredLabels, approved),
      fig("(88 against 86)", hundredLabels, approved), fig("4 points", hundredLabels, "lower bound -0.043"),
      fig("10-point", "docs/decision/verdict-rules.md", "lower bound of (Jev minus LLM) above -0.10"),
      fig("Jev 88 of 100", hundredLabels, "Jev accepted 88 of 100"), fig("Haiku 5.5", hundredReadme, "claude-haiku-5-5"),
      fig("86 of 100", hundredLabels, "the LLM 86 of 100"), fact("simple rule 49", hundredRecords, "accepted:rule"),
      fig("of 100.", hundredLabels, "of 100"), fact("Jev spent $0.0033", hundredRecords, "spend:jev"),
      fact("LLM's $0.0163", hundredRecords, "spend:llm"), fig("30 or more", "docs/decision/verdict-rules.md", minimum),
      fig("first 40", hundredReadme, "the 40 of `run-shopbot-2026-10-01`"),
      fig("38 each", "site/little-shop/index.html", "Same accuracy as the LLM (38/40 each) at 1/79th of the cost"),
      fig("and 40 was too few", "docs/product/runs/2026-10-01-uc13-shop-bot/LABELS.md", "all 40 messages"),
      fig("Haiku 4.5", hundredReadme, "claude-haiku-4-5-20251001"),
      fig("1/79th", "site/little-shop/index.html", "Same accuracy as the LLM (38/40 each) at 1/79th of the cost"),
    ],
  },
  uc13: {
    verdict: "Use Jev (100 messages)",
    why: "Same accuracy as the LLM (88 against 86 of 100) at about a fifth of the cost per kept answer.",
    cases: "Jev 88, LLM (Haiku 5.5) 86, simple rule 49, of 100.",
    next: "Open the 100-message run, or try your own decision.",
    earlier: "40 messages: tied 38 to 38, Not proven yet (LLM was Haiku 4.5).",
    rephrase: null,
    figures: [fig("100 messages", hundredLabels, approved), fig("(88 against 86 of 100)", hundredLabels, approved),
      fact("Jev 88", hundredRecords, "accepted:jev"), fig("Haiku 5.5", hundredReadme, "claude-haiku-5-5"),
      fact("LLM (Haiku 5.5) 86", hundredRecords, "accepted:llm"), fact("simple rule 49", hundredRecords, "accepted:rule"),
      fig("of 100.", hundredLabels, approved), fig("100-message run", hundredLabels, approved),
      fig("40 messages", "docs/product/runs/2026-10-01-uc13-shop-bot/LABELS.md", "all 40 messages"),
      fig("38 to", "site/little-shop/index.html", "Same accuracy as the LLM (38/40 each) at 1/79th of the cost"),
      fig("to 38", "site/little-shop/index.html", "Same accuracy as the LLM (38/40 each) at 1/79th of the cost"),
      fig("Haiku 4.5", hundredReadme, "claude-haiku-4-5-20251001")],
  },
  uc11: {
    verdict: "Not enough evidence (rule 1)",
    why: "Only 5 CVs are labelled. The rules need at least 30 before they compare Jev with the LLM.",
    cases: "Jev 5 of 5, the LLM 5 of 5, the simple rule 2 of 5. Jev spent $0.00008 against the LLM's $0.0109.",
    next: "Label 25 more CVs against the same ad line.",
    rephrase: '"Rank these CVs" is a written judgement, so Jev probably not. Ask one yes/no per ad line instead: "Does the CV show the person has built or run a product that pools AI subscriptions or tokens?" Code adds up the lines to rank (pattern P2).',
    earlier: null,
    figures: [fig("rule 1", "docs/decision/verdict-rules.md", "1. **Not enough evidence**"),
      fig("Only 5 CVs", "docs/product/runs/2026-10-03-tokenmax/README.md", "5 CVs x 2 questions"),
      fig("at least 30", "docs/decision/verdict-rules.md", minimum),
      fact("Jev 5", cvRecords, "accepted:jev", "q1"), fact("Jev 5 of 5", cvRecords, "labelled:jev", "q1"),
      fact("the LLM 5", cvRecords, "accepted:llm", "q1"), fact("the LLM 5 of 5", cvRecords, "labelled:llm", "q1"),
      fact("the simple rule 2", cvRecords, "accepted:rule", "q1"), fact("the simple rule 2 of 5", cvRecords, "labelled:rule", "q1"),
      fact("Jev spent $0.00008", cvRecords, "spend:jev", "q1"), fact("LLM's $0.0109", cvRecords, "spend:llm", "q1"),
      fact("25 more", cvRecords, "toMinimum", "q1")],
  },
  uc12: {
    verdict: "Split two ways",
    why: "No cases have been run yet, so there is nothing to compare.",
    cases: "nothing yet.",
    next: "20 or more requirement and evidence pairs, each labelled met, partly met or not met by hand.",
    rephrase: 'Where a test or check script exists, its exit code decides "met", and Jev adds nothing. Where the evidence is prose, ask: "Does this evidence excerpt support this requirement? met / partly met / not met" (pattern P1).',
    earlier: null,
    figures: [fig("20 or more", "docs/product/use-cases/uc12-requirement-evidence-check.md", "20 or more requirement and evidence pairs")],
  },
  uc10: {
    verdict: "Jev probably not",
    why: 'No cases have been run. "Decide my tech stack" is open design work that needs reasoning and a written answer, which Jev does not do.',
    cases: "nothing yet.",
    next: "20 or more project descriptions, each labelled by hand with the properties it needs.",
    rephrase: 'Ask yes/no per property instead: "Does this project need realtime updates?" (and the same for relational joins, row-level access, self-hosting, offline-first, file storage). A written mapping table, not Jev, turns the answers into the stack (pattern P2).',
    earlier: null,
    figures: [fig("20 or more", "docs/product/use-cases/uc10-tech-stack-choice.md", "20 or more real project descriptions")],
  },
  uc9: {
    verdict: "Jev probably not",
    why: 'No cases have been run. "Is this AI slop?" is an open question with no fixed answer set.',
    cases: "nothing yet.",
    next: "a labelled set of real sites, each check marked by hand, before any score is published.",
    rephrase: 'Ask one check at a time with a fixed answer, for example "Is the headline generic marketing filler? 0 / 1 / 2" or "Does the hero use a purple-to-blue gradient? yes / no". Code weights the answers into the score (pattern P3). Jev reads text only, so visual checks need the page text or CSS.',
    earlier: null,
    figures: [fig("0 / 1 / 2", "docs/product/use-cases/uc9-website-slop-roast.md", "0 / 1 / 2 score")],
  },
};
