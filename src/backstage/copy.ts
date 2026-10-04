import type { Scene, ProviderKeys } from "./contracts.ts";
import { JEV_ARM_ID, getModelEntry } from "./catalog.ts";
import { copyPrompt } from "./prompt.ts";
function contains(value: unknown, key: string): boolean {
  if (typeof value === "string") return value.includes(key);
  if (Array.isArray(value)) return value.some((v) => contains(v, key));
  if (value && typeof value === "object")
    return Object.values(value).some((v) => contains(v, key));
  return false;
}
export function copyDecision(
  scene: Scene,
  keys: ProviderKeys,
  kind: "playground" | "cli",
): string {
  const input = scene.cases[0]?.input;
  if (!input) throw new Error("Add a case before copying.");
  for (const key of Object.values(keys))
    if (key && contains(scene, key))
      throw new Error("Remove provider keys from the scene before copying.");
  if (kind === "playground") return copyPrompt(scene, input);
  const entry = getModelEntry(JEV_ARM_ID);
  if (!entry) throw new Error("Jev unavailable in catalog.");
  const payload = {
    model: entry.modelId,
    state: input,
    questions: {
      q1: {
        type: "choice",
        instructions: { question: scene.question },
        criteria: Object.fromEntries(
          scene.choices.map((choice) => [choice.name, choice.definition]),
        ),
      },
    },
  };
  return (
    "curl https://api.typesafe.ai/v1/systemone -H 'Content-Type: application/json' -H \"Authorization: Bearer $TYPESAFE_API_KEY\" --data-binary @- <<'BACKSTAGE_CASE'\n" +
    JSON.stringify(payload, null, 2) +
    "\nBACKSTAGE_CASE"
  );
}
