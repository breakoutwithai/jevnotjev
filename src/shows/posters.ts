// Ticket office posters: one per use case, staged by what its run folder holds. Every value is read from a
// use-case doc or a run's records.csv by scripts/shows/build-posters.ts; nothing here is typed by hand.
import { MIN_PAIRED } from "../core/verdict.ts";

export const MAX_POSTERS = 10;

/** Script reading: an idea with its fit check, no run. Rehearsal: a run with fewer than 30 paired labels. Show: a judged run. */
export type Stage = "script-reading" | "rehearsal" | "show";

export interface RunSummary {
  readonly folder: string;
  readonly rows: number;
  /** Cases where both Jev and the LLM have a labelled row for the same question. */
  readonly labelledPaired: number;
  /** The verdict name from src/core/verdict.ts; null under 30 paired labelled cases (verdict-rules.md rule 1). */
  readonly verdict: string | null;
  readonly reason: string | null;
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
export function rankPosters(posters: readonly Poster[], tickets: Readonly<Record<string, number>>): Poster[] {
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
    .slice(0, MAX_POSTERS);
}
