// The outside-run record template is public and holds no tester data. These tests lock its safety contract:
// consent comes first, no field asks for keys or case text, nothing is pre-ticked.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const doc = readFileSync(join(ROOT, "docs/uat/run-record-template.md"), "utf8");
const checklist = readFileSync(join(ROOT, "docs/uat/tester-checklist.md"), "utf8");

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}
// The allowlist is the exact set of fillable fields the template is meant to hold. Anything else that looks fillable fails.
const ALLOWED_FIELDS: string[] = [
  "Date consent was given",
  "Build SHA served",
  "Date of run",
  "Variant (guided, unguided or hybrid)",
  "Browser and device type",
  "Minutes to signed in (N, or not reached)",
  "Elapsed minutes (N)",
  "Furthest step reached (0 to 5, 0 means stopped before step 1)",
  "Stuck points by step (N per step 1 to 5)",
  "Assists (N, each with step number and reason)",
  "Questions about a field (N)",
  "Cases entered (N)",
  "Paired labelled cases per comparison (N)",
  "Labels set (N of N)",
  "Verdict, Jev versus LLM (use Jev, don't use Jev, not enough evidence, or none)",
  "Verdict, Jev versus rule (use Jev, don't use Jev, not enough evidence, or none)",
  "Jev-only rehearsal shown (yes or no)",
  "Errors seen (screen text, with anything the tester typed replaced by [value])",
  "Exports downloaded (0 to 2, the files stay with the tester)",
  "Expected (step number, count)",
  "Hesitated (step number, count)",
  "Would act on the verdict (yes, no or unsure)",
  "Advice for another builder (step number, count)",
  "Their words, only if a cite or quote box is ticked (step number and words)",
  "Test status (pending, declined, no-show or stopped partway)",
  "Date of status",
  "One alternative invite sent (yes or no)",
  "Date of alternative invite",
  "What the alternative invite offered (date and slot only)",
];
// Guard on the allowlist itself: no allowed label may ask for keys, contact details, case text or answers.
const FORBIDDEN =
  /\bkeys?\b|password|secret|token|account|e-?mail|phone|contact|full name|\bname\b|case text|their cases?|their question|question text|verbatim|paste|model answers?|records\.csv|run evidence|evidence file|credential|prompt|input|login|alias|handle|\banswers?\b/i;
function fieldLabels(text: string): string[] {
  return [...text.matchAll(/^- ([^:\n]+): _{3,}\s*$/gm)].map(m => m[1] ?? "");
}
const CANONICAL = /^- ([^:\n]+): _{3,}$/;
// A field-like line: two or more consecutive underscores, a list item ending in a colon with nothing after, or a table row.
function isFieldLike(line: string): boolean {
  return /__/.test(line) || /^\s*(?:[-*+]|\d+[.)])\s.*:\s*$/.test(line) || line.startsWith("|");
}
// Every field-like line must be canonical AND its label must be on the allowlist.
function fieldViolations(text: string): string[] {
  return text.split("\n").filter(line => {
    if (!isFieldLike(line)) return false;
    const m = CANONICAL.exec(line);
    return m === null || !ALLOWED_FIELDS.includes(m[1] ?? "");
  });
}
// Each allowed label must appear exactly once as a canonical field.
function coverageProblems(text: string): string[] {
  const labels = fieldLabels(text);
  return ALLOWED_FIELDS.filter(label => labels.filter(l => l === label).length !== 1);
}
// A checkbox in any list marker (including N. and N)) must hold exactly one space.
function badCheckboxes(text: string): string[] {
  return text.split("\n").filter(line => {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+\[([^\]]*)\]/.exec(line);
    return m !== null && m[1] !== " ";
  });
}
// Any blank or checkbox that appears before the Consent heading.
function beforeConsent(text: string): string[] {
  const at = text.indexOf("\n## Consent\n");
  const head = at < 0 ? text : text.slice(0, at);
  return head.split("\n").filter(line => line.includes("___") || /^\s*(?:[-*+]|\d+[.)])\s+\[/.test(line));
}
function consentTicks(text: string): string[] {
  return section(text, "## Consent").split("\n").filter(line => line.startsWith("- [ ] "));
}
function hasSessionAgreed(text: string): boolean {
  return consentTicks(text).some(line => line.startsWith("- [ ] Session agreed:"));
}
const consent = section(doc, "## Consent");
const ticks = consentTicks(doc);

describe("outside-run record template", () => {
  test("[unit] consent is the first section", () => {
    expect(consent.length).toBeGreaterThan(0);
    expect(doc.match(/^## .+$/m)?.[0]).toBe("## Consent");
  });
  test("[unit] no canonical field and no checkbox appears before the Consent heading", () => {
    expect(beforeConsent(doc)).toEqual([]);
    expect(beforeConsent(doc.replace("\n## Consent\n", "\n- Build SHA served: ___\n\n## Consent\n"))).toEqual(["- Build SHA served: ___"]);
    expect(beforeConsent(doc.replace("\n## Consent\n", "\n- [ ] Session agreed\n\n## Consent\n"))).toEqual(["- [ ] Session agreed"]);
    expect(beforeConsent(doc.replace("\n## Consent\n", "\n1) [ ] Session agreed\n\n## Consent\n"))).toEqual(["1) [ ] Session agreed"]);
  });
  test("[unit] consent lists every item as an unticked box and nothing is pre-ticked", () => {
    const lower = ticks.map(t => t.toLowerCase());
    for (const words of ["redacted", "private", "cite what they found without their name", "quote them by name", "link their own post", "screen recording", "withdraw"])
      expect(lower.some(t => t.includes(words))).toBe(true);
    const optional = lower.filter(t => /cite what they found without their name|quote them by name|link their own post|screen recording/.test(t));
    expect(new Set(optional).size).toBe(4);
    expect(badCheckboxes(doc)).toEqual([]);
    expect(consent).toMatch(/^- Date consent was given: _{3,}$/m);
  });
  test("[unit] the Session agreed tick is required, and removing it fails", () => {
    expect(hasSessionAgreed(doc)).toBe(true);
    const without = doc.replace(/^- \[ \] Session agreed.*\n/m, "");
    expect(without).not.toBe(doc);
    expect(hasSessionAgreed(without)).toBe(false);
  });
  test("[unit] the checkbox check rejects every pre-ticked form in every list marker", () => {
    const planted = [
      "- [x] Session agreed", "* [x] Session agreed", "+ [x] Session agreed", "1. [x] Session agreed", "1) [x] Permission granted",
      "-  [x] Session agreed", "- [✓] Session agreed", "- [ x] Session agreed", "- [X] Session agreed",
    ];
    for (const line of planted) expect(badCheckboxes(`${doc}\n${line}\n`)).toEqual([line]);
  });
  test("[unit] every fillable-looking line is canonical and on the allowlist, and every allowed field appears once", () => {
    expect(fieldViolations(doc)).toEqual([]);
    expect(coverageProblems(doc)).toEqual([]);
    expect(fieldLabels(doc).length).toBe(ALLOWED_FIELDS.length);
  });
  test("[unit] the allowlist check rejects every planted evasion", () => {
    const planted = [
      "- API key: __",
      "- Cases entered (verbatim): ___",
      "- Case text: ___ (optional)",
      "- **Case text:** ___",
      "* Case text: ___",
      "- Case text:",
      "| Case text | ___ |",
      "- Case text - ___",
      "- Case: text: ___",
      "1) Case text: ___",
      "- Notes: ___",
    ];
    for (const line of planted) expect(fieldViolations(`${doc}\n${line}\n`)).toEqual([line]);
  });
  test("[unit] a duplicated or missing allowed field fails coverage", () => {
    expect(coverageProblems(`${doc}\n- Date of run: ___\n`)).toEqual(["Date of run"]);
    expect(coverageProblems(doc.replace("- Date of run: ___\n", ""))).toEqual(["Date of run"]);
  });
  test("[unit] no allowed field asks for keys, contact details, case text or answers", () => {
    expect(ALLOWED_FIELDS.filter(label => FORBIDDEN.test(label))).toEqual([]);
  });
  test("[unit] the forbidden-field guard flags every planted label", () => {
    const planted = [
      "API key", "TypeSafe key", "Jev key", "Provider key", "Password", "Secret", "Token", "Account details", "Tester email", "Phone", "Contact", "Full name",
      "Their question text", "Case text", "Cases (paste here)", "Cases entered (verbatim)", "Model answers", "records.csv", "Run evidence file",
      "Their question", "Their cases", "Credentials", "Prompt used", "Inputs", "Login", "Tester alias / handle", "Answers",
    ];
    for (const label of planted) expect(FORBIDDEN.test(label)).toBe(true);
  });
  test("[unit] run section records progress, device, both verdicts and the variant definition", () => {
    const run = section(doc, "## Run");
    const labels = fieldLabels(run);
    for (const label of [
      "Furthest step reached (0 to 5, 0 means stopped before step 1)",
      "Minutes to signed in (N, or not reached)",
      "Elapsed minutes (N)",
      "Browser and device type",
      "Paired labelled cases per comparison (N)",
      "Jev-only rehearsal shown (yes or no)",
    ])
      expect(labels).toContain(label);
    expect(labels).toContain("Errors seen (screen text, with anything the tester typed replaced by [value])");
    expect(labels.some(l => l.startsWith("Verdict shown"))).toBe(false);
    for (const arm of ["LLM", "rule"]) {
      const label = labels.find(l => l.startsWith(`Verdict, Jev versus ${arm} (`)) ?? "";
      expect(label).not.toBe("");
      for (const word of ["use Jev", "don't use Jev", "not enough evidence", "none"]) expect(label).toContain(word);
    }
    const lower = run.toLowerCase();
    expect(lower).toContain("guided means the host may type");
    expect(lower).toContain("unguided means the tester only has the link and the checklist");
    expect(lower).toContain("hybrid switches to guided after 10 minutes stuck");
  });
  test("[unit] the sections are fixed and every list item in a fill-in section is a canonical field", () => {
    const HEADINGS = ["## Consent", "## Run", "## Friction", "## Status if no run", "## Never record", "## Delete on withdrawal"];
    const headings = (text: string): string[] => text.match(/^#{2,} .+$/gm) ?? [];
    const loose = (text: string): string[] =>
      ["## Run", "## Friction", "## Status if no run"].flatMap(h =>
        section(text, h).split("\n").filter(line => /^\s*(?:[-*+]|\d+[.)])\s/.test(line) && !CANONICAL.test(line) && !/^- [^:\n]+\?$/.test(line)));
    const boxesOutsideConsent = (text: string): string[] =>
      text.replace(section(text, "## Consent"), "").split("\n").filter(line => /\[[^\]]?\]/.test(line));
    expect(headings(doc)).toEqual(HEADINGS);
    expect(loose(doc)).toEqual([]);
    expect(boxesOutsideConsent(doc)).toEqual([]);
    expect(boxesOutsideConsent(`${doc}\n- Case text: [ ]\n`)).toEqual(["- Case text: [ ]"]);
    expect(headings(`${doc}\n## Notes\n\nWrite the tester question here.\n`)).not.toEqual(HEADINGS);
    for (const line of ["- Case text: [ ]", "- Case text: (fill in)", "* Their cases"])
      expect(loose(doc.replace("\n## Friction\n", `\n${line}\n\n## Friction\n`))).toEqual([line]);
  });
  test("[unit] verdict words match the tester checklist", () => {
    for (const word of ["use Jev", "don't use Jev", "not enough evidence"]) expect(checklist).toContain(word);
  });
  test("[unit] friction has the four questions and one words field for consented words only", () => {
    const friction = section(doc, "## Friction");
    const lower = friction.toLowerCase();
    for (const q of ["what did you expect jev to do", "where did you hesitate", "would you act on this verdict", "what would you tell another builder"])
      expect(lower).toContain(q);
    expect(lower).toContain("only if");
    expect(lower).toContain("quote them by name");
    expect(lower).toContain("cite what they found without their name");
    expect(lower).toContain("step number");
    expect(lower).toContain("not copied into this record");
    const words = fieldLabels(friction).filter(l => /\bwords\b/i.test(l));
    expect(words.length).toBe(1);
    expect((words[0] ?? "").toLowerCase()).toContain("only if");
  });
  test("[unit] no-run status names pending, partway stops and one alternative invite", () => {
    const status = section(doc, "## Status if no run");
    const lower = status.toLowerCase();
    expect(lower).toContain("pending, declined, no-show or stopped partway");
    expect(lower).toContain("alternative invite");
    expect(lower).toContain("one");
    expect(fieldLabels(status)).toContain("What the alternative invite offered (date and slot only)");
  });
  test("[unit] never-record names what must stay out", () => {
    const never = section(doc, "## Never record").toLowerCase();
    for (const word of ["key", "password", "account details", "contact", "question", "case text", "model answers", "records.csv", "run evidence", "screenshots"])
      expect(never).toContain(word);
  });
  test("[unit] delete on withdrawal follows consent, covers email and recordings, and keeps only date and count", () => {
    expect(doc.indexOf("\n## Delete on withdrawal\n")).toBeGreaterThan(doc.indexOf("\n## Consent\n"));
    const del = section(doc, "## Delete on withdrawal");
    expect(del.split("\n").filter(l => /^\d+\. /.test(l)).length).toBeGreaterThanOrEqual(4);
    const lower = del.toLowerCase();
    for (const word of ["notes", "exports", "screens", "recording", "emails", "messages", "completion evidence", "quote", "claim"]) expect(lower).toContain(word);
    expect(lower).toContain("only the date and the count of files deleted");
  });
});
