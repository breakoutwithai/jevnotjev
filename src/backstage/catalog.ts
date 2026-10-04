import type {
  ModelEntry,
  Provider,
  GenerationParameters,
  ModelPricing,
} from "./contracts.ts";
/** Product allowlist for #67. Documentation checked, account availability unverified. */
export const CATALOG_VERSION = "2026-10-04.1";
export const CATALOG_CHECKED_DATE = "2026-10-04";
export const JEV_ARM_ID = "jev";
export const MAX_SELECTED_ARMS = 12;
export const MAX_RUN_REQUESTS = 400;
const sources: Record<Provider, string> = {
  jev: "https://docs.typesafe.ai/models",
  anthropic: "https://platform.claude.com/docs/en/models/overview",
  openai: "https://developers.openai.com/api/docs/models",
  google: "https://ai.google.dev/gemini-api/docs/models",
  xai: "https://docs.x.ai/developers/models/grok-4.7",
};
function entry(
  provider: Provider,
  modelId: string,
  label: string,
  parameters: GenerationParameters,
  rates: readonly [number, number] | null,
  preview = false,
): ModelEntry {
  const pricing: ModelPricing | null = rates
    ? Object.freeze({
        inputUsdPerMillion: rates[0],
        outputUsdPerMillion: rates[1],
        version: CATALOG_VERSION,
        sourceUrl: sources[provider],
      })
    : null;
  return Object.freeze({
    id: provider === "jev" ? JEV_ARM_ID : modelId,
    label,
    provider,
    modelId,
    acceptedResponseModelIds: Object.freeze([modelId]),
    parameters: Object.freeze(parameters),
    catalogVersion: CATALOG_VERSION,
    checkedDate: CATALOG_CHECKED_DATE,
    sourceUrl: sources[provider],
    enabled: true,
    preview,
    pricing,
  });
}
const bounded: GenerationParameters = {
  maxOutputTokens: 1024,
  reasoningEffort: "low",
  thinking: null,
};
export const MODEL_CATALOG: readonly ModelEntry[] = Object.freeze([
  entry(
    "jev",
    "jev-1.13.0",
    "Jev 1.13",
    { maxOutputTokens: 0, reasoningEffort: null, thinking: null },
    [0.042, 0],
  ),
  entry(
    "anthropic",
    "claude-haiku-4-5-20251001",
    "Claude Haiku 4.5",
    { maxOutputTokens: 128, reasoningEffort: null, thinking: "disabled" },
    [1, 5],
  ),
  entry(
    "anthropic",
    "claude-sonnet-5-5",
    "Claude Sonnet 5.5",
    { ...bounded, thinking: "adaptive" },
    [2, 10],
  ),
  entry(
    "anthropic",
    "claude-opus-5-5",
    "Claude Opus 5.5",
    { ...bounded, thinking: "adaptive" },
    [4, 20],
  ),
  entry(
    "anthropic",
    "claude-fable-5-1",
    "Claude Fable 5.1",
    { ...bounded, thinking: "adaptive" },
    [10, 50],
  ),
  entry("openai", "gpt-6.1-sol", "GPT-6.1 Sol", bounded, [2, 10]),
  entry("openai", "gpt-6-astra", "GPT-6 Astra", bounded, [10, 50]),
  entry(
    "openai",
    "gpt-6-luna",
    "GPT-6 Luna",
    { ...bounded, reasoningEffort: "none" },
    [0.1, 0.5],
  ),
  // Google billing includes thinking/cache dimensions; pricing remains unverified here.
  entry("google", "gemini-3.8-flash", "Gemini 3.8 Flash", bounded, null),
  entry(
    "google",
    "gemini-3.5-flash-lite",
    "Gemini 3.5 Flash-Lite",
    bounded,
    null,
  ),
  entry(
    "google",
    "gemini-3.1-pro-preview",
    "Gemini 3.1 Pro (preview)",
    bounded,
    null,
    true,
  ),
  entry("xai", "grok-4.7", "Grok 4.7", bounded, [2, 6]),
]);
export function getModelEntry(id: string): ModelEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === id);
}
