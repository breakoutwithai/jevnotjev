/**
 * Jev's options for one case, ranked for a labeller who has already made a blind pick (labelling loop M2).
 * Pure: no DOM, no network. The browser pages import it by path.
 *
 * Order: by Jev's per-option probability, highest first; equal probabilities keep answer-set order.
 * When the probabilities are missing (or do not cover exactly the answer set with values in [0, 1]), Jev's choice
 * comes first and the rest follow unranked in answer-set order, so a page can label them "unranked".
 */

/** The part of a checked Jev answer a suggestion needs (src/jev-answer.ts JevChecked). */
export interface JevSuggestion {
  readonly choice: string;
  readonly confidence: number | null;
  readonly probabilities: Readonly<Record<string, number>> | null;
}

export interface RankedOption {
  readonly option: string;
  /** 1 for the top option; null when Jev gave no probabilities and the option is not its choice. */
  readonly rank: number | null;
  readonly probability: number | null;
  readonly jevChoice: boolean;
}

export interface Ranking {
  /** False when the order is Jev's choice first and the rest unranked. */
  readonly ranked: boolean;
  readonly confidence: number | null;
  readonly options: readonly RankedOption[];
}

function usableProbabilities(
  answerSet: readonly string[],
  probabilities: Readonly<Record<string, number>> | null,
): Readonly<Record<string, number>> | null {
  if (probabilities === null) return null;
  const keys = Object.keys(probabilities);
  if (keys.length !== answerSet.length || !answerSet.every((option) => Object.hasOwn(probabilities, option))) return null;
  const valid = answerSet.every((option) => {
    const p = probabilities[option];
    return typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;
  });
  return valid ? probabilities : null;
}

export function rankJevOptions(answerSet: readonly string[], answer: JevSuggestion): Ranking {
  if (new Set(answerSet).size !== answerSet.length) throw new Error("answer set repeats an option");
  if (!answerSet.includes(answer.choice)) throw new Error(`Jev's choice ${JSON.stringify(answer.choice)} is not in the answer set`);
  const probabilities = usableProbabilities(answerSet, answer.probabilities);
  if (probabilities === null) {
    const rest = answerSet.filter((option) => option !== answer.choice);
    return {
      ranked: false,
      confidence: answer.confidence,
      options: [
        { option: answer.choice, rank: 1, probability: null, jevChoice: true },
        ...rest.map((option) => ({ option, rank: null, probability: null, jevChoice: false })),
      ],
    };
  }
  const ordered = answerSet
    .map((option, index) => ({ option, index, probability: probabilities[option] ?? 0 }))
    .sort((a, b) => b.probability - a.probability || a.index - b.index);
  return {
    ranked: true,
    confidence: answer.confidence,
    options: ordered.map((entry, position) => ({
      option: entry.option,
      rank: position + 1,
      probability: entry.probability,
      jevChoice: entry.option === answer.choice,
    })),
  };
}

/** The option a "follow" is measured against: the first in the ranking. */
export function topSuggestion(ranking: Ranking): string | null {
  return ranking.options[0]?.option ?? null;
}
