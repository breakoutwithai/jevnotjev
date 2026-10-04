import type { AnswerRequest, ModelEntry } from "./contracts.ts";
import { getModelEntry } from "./catalog.ts";
import { PROMPT_TEMPLATE_VERSION } from "./prompt.ts";
export async function requestFingerprint(
  request: Pick<
    AnswerRequest,
    | "question"
    | "choices"
    | "input"
    | "provider"
    | "modelId"
    | "armId"
    | "promptVersion"
    | "catalogVersion"
  >,
  entry: ModelEntry | undefined = getModelEntry(request.armId),
): Promise<string> {
  if (!entry) throw new Error("Unknown catalog arm.");
  const value = {
    templateVersion: PROMPT_TEMPLATE_VERSION,
    promptVersion: request.promptVersion,
    catalogVersion: request.catalogVersion,
    armId: request.armId,
    provider: request.provider,
    model: request.modelId,
    parameters: {
      maxOutputTokens: entry.parameters.maxOutputTokens,
      reasoningEffort: entry.parameters.reasoningEffort,
      thinking: entry.parameters.thinking,
    },
    question: request.question,
    choices: request.choices.map((c) => ({
      name: c.name,
      definition: c.definition,
    })),
    input: request.input,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
