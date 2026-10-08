// The rule arm: keywords decide between two choice options. Local, free, no call. Any other question shape is unsupported.
import type { QuestionResult, QuestionSpec, RuleArm } from "./types.ts";

export const RULE_MODEL = "keyword-rule";

export function ruleAnswer(rule: RuleArm, text: string, q: QuestionSpec): QuestionResult {
  if (q.type !== "choice" || q.choices.length !== 2) {
    return { outcome: "unsupported", output: null, confidence: null, reason: "rule answers a 2-option choice only" };
  }
  const names = q.choices.map((c) => c.name);
  if (!names.includes(rule.match) || !names.includes(rule.otherwise) || rule.match === rule.otherwise) {
    return { outcome: "unsupported", output: null, confidence: null, reason: "rule match/otherwise are not this question's two options" };
  }
  const lower = text.toLowerCase();
  const hit = rule.keywords.some((k) => k !== "" && lower.includes(k.toLowerCase()));
  return { outcome: "answered", output: hit ? rule.match : rule.otherwise, confidence: null };
}
