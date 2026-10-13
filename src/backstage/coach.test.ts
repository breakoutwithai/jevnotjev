import { expect, test } from "bun:test";
import { applicableDraft, coachPrompt, parseCoachReply } from "./coach.ts";

const draft = {
  type: "choice", question: "Should I refund this order?",
  answers: [{ name: "Refund", meaning: "When the order qualifies for a refund." }, { name: "Decline", meaning: "When it does not qualify." }],
  keepRule: "Keep when I would make the same refund call.",
  ruleToBeat: ["refund", "damaged"], exclusions: "Orders without enough information.",
};

test("[unit] #132 C1 coach prompt asks for a bounded JSON decision draft", () => {
  const prompt = coachPrompt("Should I refund this order?");
  expect(prompt).toContain("coach.1");
  expect(prompt).toContain("Should I refund this order?");
  expect(prompt).toContain("no-match");
  expect(prompt).toContain("JSON only");
  expect(prompt).toContain("ruleToBeat: literal keywords that, if found in a case, select the FIRST answer; otherwise the second");
});

test("[unit] #132 coach accepts no exclusions", () => {
  expect(parseCoachReply(JSON.stringify({ drafts: [{ ...draft, exclusions: "" }] })).ok).toBe(true);
  expect(coachPrompt("Refund?")).toContain("Use an empty string for exclusions when nothing is left out.");
});

test("[unit] #132 C1 two questions yield distinct complete drafts", () => {
  const other = { ...draft, question: "Should I replace this order?", keepRule: "Keep when I would replace it." };
  const first = parseCoachReply(JSON.stringify({ drafts: [draft] }));
  const second = parseCoachReply(JSON.stringify({ drafts: [other] }));
  expect(first.ok && second.ok).toBe(true);
  if (first.ok && second.ok) {
    expect(first.drafts[0]?.question).not.toBe(second.drafts[0]?.question);
    for (const item of [...first.drafts, ...second.drafts]) {
      expect(item.keepRule.length).toBeGreaterThan(0);
      if (item.type === "choice") for (const answer of item.answers) expect(answer.meaning.length).toBeGreaterThan(0);
    }
  }
});

test("[unit] #132 C5 unsupported shapes cannot be applied", () => {
  const score = { ...draft, type: "score", levels: draft.answers };
  const noul = { ...draft, type: "noul", statement: "The order is refundable.", answers: [{ name: "True", meaning: "When a refund is warranted." }, { name: "False", meaning: "When it is not." }] };
  const three = { ...draft, answers: [...draft.answers, { name: "Escalate", meaning: "When a manager must decide." }] };
  for (const value of [score, noul, three]) {
    const parsed = parseCoachReply(JSON.stringify({ drafts: [value] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.drafts[0]) expect(applicableDraft(parsed.drafts[0])).toBeNull();
  }
});

test("[unit] #132 C6 whole reply is rejected for malformed, empty, too many and oversized drafts", () => {
  const bad = ["oops", JSON.stringify({ drafts: [] }), JSON.stringify({ drafts: Array(4).fill(draft) }),
    JSON.stringify({ drafts: [draft, { ...draft, keepRule: "" }] }),
    JSON.stringify({ drafts: [{ ...draft, question: "x".repeat(1001) }] }),
    JSON.stringify({ drafts: [{ ...draft, answers: [{ ...draft.answers[0], meaning: "" }, draft.answers[1]] }] }),
    JSON.stringify({ drafts: [{ ...draft, ruleToBeat: Array(21).fill("x") }] })];
  for (const value of bad) expect(parseCoachReply(value).ok).toBe(false);
  expect(parseCoachReply(`\`\`\`json\n${JSON.stringify({ drafts: [draft] })}\n\`\`\``).ok).toBe(true);
  expect(parseCoachReply(`before ${JSON.stringify({ drafts: [draft] })}`).ok).toBe(false);
});

test("[unit] #132 C1 valid reply has an answer meaning and keep rule", () => {
  const parsed = parseCoachReply(JSON.stringify({ drafts: [draft] }));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.drafts).toHaveLength(1);
    expect(parsed.drafts[0]?.keepRule).toBe(draft.keepRule);
  }
});
