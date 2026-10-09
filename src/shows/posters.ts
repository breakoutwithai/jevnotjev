// Ticket office posters: one per use case, staged by what its run folder holds. Every value is read from a
// use-case doc or a run's records.csv by scripts/shows/build-posters.ts; nothing here is typed by hand.
import { MARGIN, MIN_PAIRED } from "../core/verdict.ts";
import { newcombePaired, type PairedCounts } from "../core/calc.ts";
import type { Spend } from "../core/metrics.ts";
import type { Condition } from "../core/verdict.ts";

export const MAX_POSTERS = 10;

/** Script reading: an idea with its fit check, no run. Rehearsal: a run with fewer than 30 paired labels. Show: a judged run. */
export type Stage = "script-reading" | "rehearsal" | "show";

export interface RunSummary {
  readonly folder: string;
  readonly rows: number;
  /** Cohorts (run, prompt version, question) in the file. */
  readonly cohorts: number;
  /** The question the poster's counts describe: the cohort with the most paired labelled cases; null when none. */
  readonly question: string | null;
  /** In that cohort: cases where both Jev and the LLM have a counted label. */
  readonly labelledPaired: number;
  /** The verdict name from src/core/verdict.ts; null under 30 paired labelled cases (verdict-rules.md rule 1). */
  readonly verdict: string | null;
  readonly reason: string | null;
  readonly headline: string | null;
  readonly whyNotYet: string | null;
  /** How the labels were made, from label_source and label_blind; null when nothing is labelled. */
  readonly labels: string | null;
  /** Per method (llm, rule, jev): accepted rows of the labelled ones, and spend in USD (null when any cost is blank). */
  readonly methods: readonly MethodLine[];
}

export interface MethodLine {
  readonly arm: string;
  readonly rows: number;
  readonly labelled: number;
  readonly accepted: number;
  readonly spendUsd: number | null;
}

export interface Poster {
  readonly id: string;
  readonly title: string;
  readonly story: string;
  readonly fit: readonly string[];
  readonly stage: Stage;
  /** YYYY-MM-DD: the run folder's date, else the date the use-case doc was added. */
  readonly date: string;
  readonly source: string;
  readonly run: RunSummary | null;
  /** A page under site/ that plays this run (its index.html names the run folder); null when none does. */
  readonly watch: string | null;
}

export interface ParsedUseCase {
  readonly id: string;
  readonly title: string;
  readonly story: string;
  readonly fit: readonly string[];
  readonly runFolder: string | null;
}

export function parseUseCase(fileName: string, text: string): ParsedUseCase {
  const id = fileName.match(/^(uc\d+)/)?.[1] ?? fileName.replace(/\.md$/, "");
  const heading = text.match(/^# (.+)$/m)?.[1] ?? id;
  const title = heading.replace(/^UC\d+:\s*/, "").trim();
  const story = text.match(/^\*\*User story:\*\*\s*(.+)$/m)?.[1]?.trim() ?? "";
  const section = text.match(/^## Jev or not[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? "";
  const firstParagraph = section.trim().split(/\n\s*\n/)[0] ?? "";
  const fit = [...new Set([...firstParagraph.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1] ?? "").filter(Boolean))];
  const runFolder = text.match(/runs\/(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)\//)?.[1] ?? null;
  return { id, title, story, fit, runFolder };
}

export function verdictWordShown(labelledPaired: number): boolean {
  return labelledPaired >= MIN_PAIRED;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

export interface HeadlinePair {
  readonly n: number;
  readonly jev: { readonly accepted: number; readonly spend: Spend };
  readonly otherArm: { readonly accepted: number; readonly spend: Spend };
}

export function headlineOf(pair: HeadlinePair | null, labelledPaired: number): string | null {
  if (!pair || !verdictWordShown(pair.n) || pair.n !== labelledPaired) return null;
  const { jev, otherArm: llm } = pair;
  if (jev.accepted === 0 || llm.accepted === 0 || jev.accepted < llm.accepted || jev.spend.kind !== "complete" || llm.spend.kind !== "complete" || jev.spend.usd <= 0) return null;
  // Below a twofold spend ratio, flooring would turn a cheaper run into the misleading "1/1st" claim.
  const ratio = Math.floor(llm.spend.usd / jev.spend.usd);
  if (!Number.isFinite(ratio) || ratio < 2) return null;
  const counts = jev.accepted === llm.accepted
    ? `${jev.accepted}/${pair.n} each`
    : `${jev.accepted}/${pair.n} vs ${llm.accepted}/${pair.n}`;
  return `${jev.accepted === llm.accepted ? "Same accuracy as the LLM" : "At least as accurate as the LLM"} (${counts}) at 1/${ordinal(ratio)} of the cost`;
}

function scaledCounts(counts: PairedCounts, total: number): PairedCounts {
  const n = counts.a + counts.b + counts.c + counts.d;
  if (counts.b === counts.c) {
    // Allocate discordant cases together, so a tied b/c pair stays tied after rounding.
    const side = Math.min(Math.round(total * counts.b / n), Math.floor(total / 2));
    const rest = total - 2 * side;
    const a = counts.a + counts.d === 0 ? 0 : Math.round(rest * counts.a / (counts.a + counts.d));
    return { a, b: side, c: side, d: rest - a };
  }
  // Largest remainders preserve the requested total when four independent rounded quotas would not.
  const keys: (keyof PairedCounts)[] = ["a", "b", "c", "d"];
  const quotas = keys.map((key) => ({ key, quota: total * counts[key] / n }));
  const out: { a: number; b: number; c: number; d: number } = {
    a: Math.floor(quotas[0]?.quota ?? 0), b: Math.floor(quotas[1]?.quota ?? 0),
    c: Math.floor(quotas[2]?.quota ?? 0), d: Math.floor(quotas[3]?.quota ?? 0),
  };
  const left = total - out.a - out.b - out.c - out.d;
  for (const item of [...quotas].sort((x, y) => (y.quota % 1) - (x.quota % 1)).slice(0, left)) out[item.key]++;
  return out;
}

export function casesToClear(counts: PairedCounts): number | null {
  const n = counts.a + counts.b + counts.c + counts.d;
  // If the observed difference already misses the margin, more cases at that difference cannot clear it.
  if (n === 0 || n > 2000 || newcombePaired(counts).diff <= -MARGIN) return null;
  for (let total = n; total <= 2000; total++) {
    if (newcombePaired(scaledCounts(counts, total)).lower > -MARGIN) return total - n;
  }
  return null;
}

export function whyNotYetOf(verdict: string | null, unmet: readonly Condition[], counts: PairedCounts | null): string | null {
  if (verdict !== "not enough evidence" || unmet.length !== 1 || unmet[0] !== "accept-rate-not-shown" || counts === null) return null;
  const comparison = newcombePaired(counts);
  if (comparison.diff <= -MARGIN) return null;
  const k = casesToClear(counts);
  if (k === null) return "More cases settle it.";
  const n = counts.a + counts.b + counts.c + counts.d;
  const lower = comparison.lower.toFixed(2);
  const relation = lower === (-MARGIN).toFixed(2) ? "not above" : "below";
  return `Not proven yet: the lower bound of Jev minus the LLM is ${lower}, ${relation} the ${(-MARGIN).toFixed(2)} margin, on ${n} paired cases. If the next cases split the same way, about ${k} more paired cases would bring it inside the margin.`;
}

export function stageOf(run: RunSummary | null): Stage {
  if (!run) return "script-reading";
  return run.verdict !== null && verdictWordShown(run.labelledPaired) ? "show" : "rehearsal";
}

const DAY_MS = 86_400_000;
/** Days for an item's recency to halve, counted back from the newest item. */
export const HALF_LIFE_DAYS = 14;

/**
 * Mix of latest and tickets issued, weighted equally:
 *   recency    = 0.5 ^ ((newest date - date) in days / HALF_LIFE_DAYS), 1 for the newest item
 *   popularity = tickets / most tickets on any item, 0 when no item has a ticket
 *   score      = 0.5 * recency + 0.5 * popularity
 * Ties go to the newer item, then the lower id. At most MAX_POSTERS are kept.
 */
export function rankPosters(posters: readonly Poster[], tickets: Readonly<Record<string, number>>, limit: number = MAX_POSTERS): Poster[] {
  const days = (p: Poster): number => Date.parse(`${p.date}T00:00:00Z`) / DAY_MS;
  const newest = Math.max(...posters.map(days));
  const most = Math.max(0, ...posters.map((p) => tickets[p.id] ?? 0));
  const score = (p: Poster): number => {
    const recency = 0.5 ** ((newest - days(p)) / HALF_LIFE_DAYS);
    const popularity = most === 0 ? 0 : (tickets[p.id] ?? 0) / most;
    return 0.5 * recency + 0.5 * popularity;
  };
  return [...posters]
    .sort((a, b) => score(b) - score(a) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** The full catalogue, newest first (the ranking with no tickets), never truncated. */
export function latestFirst(posters: readonly Poster[]): Poster[] {
  return rankPosters(posters, {}, Number.POSITIVE_INFINITY);
}
