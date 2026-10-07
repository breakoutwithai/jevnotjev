import { getModelEntry } from "./catalog.ts";
import { copyPrompt } from "./prompt.ts";
import type { Provider, ProviderKeys, Scene } from "./contracts.ts";

/** Field labels on Casting, so a reason names the exact field to fill. */
export const KEY_FIELD_NAMES: Record<Provider, string> = {
  jev: "TypeSafe API key",
  anthropic: "Anthropic API key",
  openai: "OpenAI API key",
  google: "Google API key",
  xai: "xAI API key",
};

export interface RunGateInput {
  readonly caseCount: number;
  readonly armIds: readonly string[];
  readonly keys: ProviderKeys;
}

function armProviders(armIds: readonly string[]): Provider[] {
  const seen: Provider[] = [];
  for (const id of armIds) {
    const provider = getModelEntry(id)?.provider;
    if (provider && !seen.includes(provider)) seen.push(provider);
  }
  return seen;
}

/** Why a run cannot start yet, one sentence per missing input; empty when it can. */
export function runBlockers(input: RunGateInput): string[] {
  const reasons: string[] = [];
  if (input.caseCount < 1) reasons.push("Add at least one case.");
  for (const provider of armProviders(input.armIds)) {
    if ((input.keys[provider] ?? "").trim()) continue;
    reasons.push(
      provider === "jev"
        ? `Add your ${KEY_FIELD_NAMES.jev} on Casting.`
        : `Add your ${KEY_FIELD_NAMES[provider]} on Casting, or untick its models.`,
    );
  }
  return reasons;
}

export interface SpendEstimate {
  readonly calls: number;
  readonly lowUsd: number;
  readonly highUsd: number;
  /** Labels of selected models with no catalog price; their calls are counted but not priced. */
  readonly unpriced: readonly string[];
}

/**
 * A money range from catalog list prices. Input tokens are taken as 1 to 4
 * UTF-8 bytes of the prompt each; output as 1 token up to the model's output
 * cap. The local rule makes no paid call.
 */
export function estimateSpend(
  scene: Pick<Scene, "question" | "choices" | "cases">,
  armIds: readonly string[],
): SpendEstimate {
  const encoder = new TextEncoder();
  const bytes = scene.cases.map(
    (item) => encoder.encode(copyPrompt(scene, item.input)).length,
  );
  let calls = 0;
  let lowUsd = 0;
  let highUsd = 0;
  const unpriced: string[] = [];
  for (const id of armIds) {
    const entry = getModelEntry(id);
    if (!entry) continue;
    calls += bytes.length;
    const price = entry.pricing;
    if (!price) {
      unpriced.push(entry.label);
      continue;
    }
    for (const size of bytes) {
      lowUsd +=
        ((size / 4) * price.inputUsdPerMillion + price.outputUsdPerMillion) /
        1e6;
      highUsd +=
        (size * price.inputUsdPerMillion +
          entry.parameters.maxOutputTokens * price.outputUsdPerMillion) /
        1e6;
    }
  }
  return { calls, lowUsd, highUsd, unpriced };
}

/** Dollars in plain decimals, at least two significant figures, never exponent form. */
export function formatUsd(value: number): string {
  if (value <= 0) return "$0";
  const decimals = Math.max(0, 1 - Math.floor(Math.log10(value)));
  return `$${value.toFixed(decimals)}`;
}

/** "estimated $a to $b", or one figure when both ends round the same. */
export function estimateRange(estimate: SpendEstimate): string {
  const low = formatUsd(estimate.lowUsd);
  const high = formatUsd(estimate.highUsd);
  return low === high ? `estimated ${low}` : `estimated ${low} to ${high}`;
}
