// The outside-run record template is public and holds no tester data. These tests lock its safety contract:
// consent comes first, no field asks for keys or case text, nothing is pre-ticked.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const doc = readFileSync(join(ROOT, "docs/uat/run-record-template.md"), "utf8");

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}
function fieldLabels(text: string): string[] {
  return [...text.matchAll(/^- ([^:\n]+): _{3,}\s*$/gm)].map(m => m[1] ?? "");
}
const FORBIDDEN =
  /\bkeys?\b|password|secret|token|account|e-?mail|phone|contact|full name|\bname\b|question(?!s about a field)|case text|\bcases?\b(?! entered| per comparison)|paste|model answers?|records\.csv|run evidence|evidence file|credential|prompt|input|login|alias|handle|\banswers?\b/i;
function forbiddenFields(text: string): string[] {
  return fieldLabels(text).filter(label => FORBIDDEN.test(label));
}
// A fillable-looking line is any line with a blank, a list item ending in a colon, or a table row.
// Each must be exactly `- <Label>: ___`.
const CANONICAL = /^- ([^:\n]+): _{3,}$/;
function fieldShapeViolations(text: string): string[] {
  return text.split("\n").filter(line => {
    const fillable = line.includes("___") || /^\s*(?:[-*+]|\d+\.)\s.*:\s*$/.test(line) || line.startsWith("|");
    return fillable && !CANONICAL.test(line);
  });
}
// A checkbox in any list marker must hold exactly one space.
function badCheckboxes(text: string): string[] {
  return text.split("\n").filter(line => {
    const m = /^\s*(?:[-*+]|\d+\.)\s+\[([^\]]*)\]/.exec(line);
    return m !== null && m[1] !== " ";
  });
}
// Any blank or checkbox that appears before the Consent heading.
function beforeConsent(text: string): string[] {
  const at = text.indexOf("\n## Consent\n");
  const head = at < 0 ? text : text.slice(0, at);
  return head.split("\n").filter(line => line.includes("___") || /^\s*(?:[-*+]|\d+\.)\s+\[/.test(line));
}
const consent = section(doc, "## Consent");
const ticks = consent.split("\n").filter(line => line.startsWith("- [ ] "));

describe("outside-run record template", () => {
  test("[unit] consent is the first section", () => {
    expect(consent.length).toBeGreaterThan(0);
    expect(doc.match(/^## .+$/m)?.[0]).toBe("## Consent");
  });
  test("[unit] no canonical field and no checkbox appears before the Consent heading", () => {
    expect(beforeConsent(doc)).toEqual([]);
    expect(beforeConsent(doc.replace("\n## Consent\n", "\n- Build SHA served: ___\n\n## Consent\n"))).toEqual(["- Build SHA served: ___"]);
    expect(beforeConsent(doc.replace("\n## Consent\n", "\n- [ ] Session agreed\n\n## Consent\n"))).toEqual(["- [ ] Session agreed"]);
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
  test("[unit] the checkbox check rejects every pre-ticked form in every list marker", () => {
    const planted = ["- [x] Session agreed", "* [x] Session agreed", "+ [x] Session agreed", "1. [x] Session agreed", "-  [x] Session agreed", "- [✓] Session agreed", "- [ x] Session agreed", "- [X] Session agreed"];
    for (const line of planted) expect(badCheckboxes(`${doc}\n${line}\n`)).toEqual([line]);
  });
  test("[unit] every fillable-looking line has the canonical shape", () => {
    expect(fieldShapeViolations(doc)).toEqual([]);
    expect(fieldLabels(doc).length).toBeGreaterThanOrEqual(10);
  });
  test("[unit] the field-shape check rejects every planted evasion", () => {
    const planted = ["- Case text: ___ (optional)", "- **Case text:** ___", "* Case text: ___", "- Case text:", "| Case text | ___ |", "- Case text - ___", "- Case: text: ___"];
    for (const line of planted) expect(fieldShapeViolations(`${doc}\n${line}\n`)).toEqual([line]);
  });
  test("[unit] no field asks for keys, contact details, case text or answers", () => {
    expect(fieldLabels(doc).length).toBeGreaterThanOrEqual(10);
    expect(forbiddenFields(doc)).toEqual([]);
  });
  test("[unit] the forbidden-field matcher flags every planted evasion", () => {
    const planted = [
      "API key", "TypeSafe key", "Jev key", "Provider key", "Password", "Secret", "Token", "Account details", "Tester email", "Phone", "Contact", "Full name",
      "Their question text", "Case text", "Cases (paste here)", "Model answers", "records.csv", "Run evidence file",
      "Their question", "Their cases", "Credentials", "Prompt used", "Inputs", "Login", "Tester alias / handle", "Answers",
    ];
    for (const label of planted) expect(forbiddenFields(`- ${label}: ___`)).toEqual([label]);
  });
  test("[unit] the template would fail if a case text field were added", () => {
    expect(forbiddenFields(`${doc}\n- Case text: ___\n`)).toEqual(["Case text"]);
  });
  test("[unit] the matcher does not flag the legitimate labels", () => {
    const labels = fieldLabels(doc);
    for (const label of [...labels, "Questions about a field (N)", "Cases entered (N)"])
      expect(forbiddenFields(`- ${label}: ___`)).toEqual([]);
    for (const start of ["Questions about a field", "Cases entered", "Exports downloaded", "Verdict shown", "Build SHA served"])
      expect(labels.some(l => l.startsWith(start))).toBe(true);
  });
  test("[unit] run section records progress, device and the variant definition", () => {
    const run = section(doc, "## Run");
    const labels = fieldLabels(run);
    for (const label of ["Furthest step reached (1 to 5)", "Elapsed minutes (N)", "Browser and device type", "Paired labelled cases per comparison (N)"])
      expect(labels).toContain(label);
    expect(labels).toContain("Errors seen (screen text, with anything the tester typed replaced by [value])");
    expect(labels.find(l => l.startsWith("Verdict shown"))).toContain("Jev-only rehearsal");
    const lower = run.toLowerCase();
    expect(lower).toContain("guided means the host may type");
    expect(lower).toContain("unguided means the tester only has the link and the checklist");
    expect(lower).toContain("hybrid switches to guided after 10 minutes stuck");
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
