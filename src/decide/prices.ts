// The dated list-price table for the decide arms. One table date for every row (format/README.md price_table_date).
// Ids are pinned: an unknown or floating id ("claude-haiku-latest", "haiku") is rejected with the accepted list.
import { JEV_PIN } from "../jev-answer.ts";
import type { ArmName } from "./types.ts";

/** The day every price below was read. */
export const PRICE_TABLE_DATE = "2026-10-08";

export interface PriceEntry {
  readonly arm: Exclude<ArmName, "rule">;
  readonly model: string;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  /** Above this many input tokens the long-prompt prices apply. */
  readonly longPromptTokens?: number;
  readonly longInputUsdPerMTok?: number;
  readonly longOutputUsdPerMTok?: number;
  readonly readDate: string;
  readonly source: string;
}

export const PRICE_TABLE: readonly PriceEntry[] = [
  {
    arm: "jev",
    model: JEV_PIN,
    inputUsdPerMTok: 0.042,
    outputUsdPerMTok: 0,
    readDate: PRICE_TABLE_DATE,
    source: "FLOW.md Metrics, Spend per case: input tokens x $0.042 per million, output free",
  },
  {
    arm: "decisions",
    model: "gpt-6-luna",
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0,
    readDate: PRICE_TABLE_DATE,
    source: "https://developers.openai.com/api/docs/guides/decisions: $0.10 per 1M input tokens",
  },
  {
    arm: "llm",
    model: "claude-haiku-5-5",
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    longPromptTokens: 100_000,
    longInputUsdPerMTok: 0.5,
    longOutputUsdPerMTok: 2.5,
    readDate: PRICE_TABLE_DATE,
    source: "https://platform.claude.com/docs/en/models/haiku-5-5/overview: $0.10 / $0.50 per MTok up to 100,000 input tokens; $0.50 / $2.50 above",
  },
];

export const ACCEPTED_LLM_MODELS: readonly string[] = PRICE_TABLE.filter((p) => p.arm === "llm").map((p) => p.model);

/** A caller error: bad input, rejected before any provider call. Its message never holds a key. */
export class DecideError extends Error {
  override readonly name = "DecideError";
}

export function priceFor(arm: Exclude<ArmName, "rule">, model: string): PriceEntry {
  const entry = PRICE_TABLE.find((p) => p.arm === arm && p.model === model);
  if (entry === undefined) {
    const accepted = PRICE_TABLE.filter((p) => p.arm === arm).map((p) => p.model);
    throw new DecideError(`unknown or floating ${arm} model id ${JSON.stringify(model)}; accepted: ${accepted.join(", ")}`);
  }
  return entry;
}

/** The llm arm's model, pinned: only an exact id in the price table. */
export function resolveLlmModel(id: string): PriceEntry {
  return priceFor("llm", id);
}

/** Cost of one call in USD from its usage and the table. */
export function callCost(entry: PriceEntry, tokensIn: number, tokensOut: number): number {
  const long = entry.longPromptTokens !== undefined && tokensIn > entry.longPromptTokens;
  const inRate = long ? (entry.longInputUsdPerMTok ?? entry.inputUsdPerMTok) : entry.inputUsdPerMTok;
  const outRate = long ? (entry.longOutputUsdPerMTok ?? entry.outputUsdPerMTok) : entry.outputUsdPerMTok;
  return (tokensIn * inRate + tokensOut * outRate) / 1_000_000;
}
