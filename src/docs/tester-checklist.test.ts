// Screen labels remain traceable without tying prose to source line positions.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STARTER_PACKS } from "../labels/starter-packs.ts";

const ROOT = join(import.meta.dir, "..", "..");
const TEMPLATE = ".github/ISSUE_TEMPLATE/tester-blocker.md";
function read(path: string): string { return readFileSync(join(ROOT, path), "utf8"); }
const doc = read("docs/uat/tester-checklist.md");
function visible(text: string): string { return text.replace(/<!--[\s\S]*?-->/g, ""); }
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}
function stepBody(n: number): string {
  return section(doc, doc.match(new RegExp(`^## Step ${n}: .+$`, "m"))?.[0] ?? `## Step ${n}`);
}
function safeEvidence(text: string): boolean {
  return !/\b(?:API key|keys?|passwords?|credentials|account details|case text|question text|models?.? answers|raw exports?|records\.csv|run evidence)\b/i.test(visible(text));
}
function citations(text: string): { label: string; path: string }[] {
  return [...text.matchAll(/`([^`]+)` <!-- source: ([^\s]+) -->/g)].map(m => ({ label: m[1] ?? "", path: m[2] ?? "" }));
}
function provenanceValid(text: string, source: (path: string) => string): boolean {
  const quoted = [...text.matchAll(/`([^`]+)`/g)].map(m => m[1] ?? "");
  const cited = citations(text);
  return cited.length > 0 && quoted.length === cited.length && cited.every(c => source(c.path).replace(/\s+/g, " ").includes(c.label));
}

describe("tester checklist", () => {
  test("[unit] D20 has five steps in the order of the run", () => {
    const titles = [...doc.matchAll(/^## Step (\d): (.+)$/gm)].map(m => `${m[1]} ${m[2]}`);
    expect(titles).toHaveLength(5);
    const words = ["decision", "cases", "jev, an llm and a rule", "review", "verdict"];
    titles.forEach((title, i) => {
      expect(title.startsWith(String(i + 1))).toBe(true);
      expect(title.toLowerCase()).toContain(words[i] ?? "");
      for (const prefix of ["- Where:", "- **You see:**"])
        expect(stepBody(i + 1).split("\n").filter(line => line.startsWith(prefix)).some(line => citations(line).length > 0)).toBe(true);
    });
  });
  test("[unit] D20 screen labels have hidden provenance and exist independently of source lines", () => {
    expect(citations(doc).length).toBeGreaterThanOrEqual(15);
    expect(provenanceValid(doc, read)).toBe(true);
    expect(provenanceValid(doc, path => `\n\n${read(path)}`)).toBe(true);
    expect(visible(doc)).not.toMatch(/\b(?:src|site)\/|ISSUE_TEMPLATE|choices\[|verdict\.verdict|card\?\./);
  });
  test("[unit] D20 provenance checks reject missing citations and changed source labels", () => {
    expect(provenanceValid(doc.replace(/ <!-- source: [^\s]+ -->/, ""), read)).toBe(false);
    const first = citations(doc)[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("Missing label citation");
    expect(provenanceValid(doc, path => path === first.path ? read(path).split(first.label).join("removed-label") : read(path))).toBe(false);
  });
  test("[unit] D20 practice timing, pack sizes and paired labels match the implementation", () => {
    const before = section(doc, "## Before you start");
    expect(before).toContain("P1 to P4 contain 10");
    expect(before).toContain("P5 to P8 contain 30");
    expect(STARTER_PACKS.map(p => p.cases.length)).toEqual([10, 10, 10, 10, 30, 30, 30, 30]);
    const review = stepBody(4);
    for (const words of ["shop", "optional", "do not count", "appears only after", "Unsure", "does not count", "accepted or rejected", "both Jev and the comparison", "Unreviewed agent labels do not count"])
      expect(review).toContain(words);
    expect(read("src/backstage/main.ts")).toContain("!current.running &&");
    expect(read("src/backstage/main.ts")).toContain("current.cards().length > 0 &&");
    expect(read("src/backstage/run.ts")).toContain("this.#picks.has(a.caseId)");
  });
  test("[unit] D20 names exactly the verdicts the code can return", () => {
    const source = read("src/core/verdict.ts").split("\n").find(line => line.startsWith("export type VerdictName")) ?? "";
    const names = [...source.matchAll(/"([^"]+)"/g)].map(m => m[1] ?? "").sort();
    const listed = stepBody(5).split("\n").find(line => line.startsWith("- Verdict words:")) ?? "";
    expect([...listed.matchAll(/`([^`]+)`/g)].map(m => m[1] ?? "").sort()).toEqual(names);
    expect(names).toHaveLength(3);
    expect(stepBody(5)).toContain("Jev-only test");
    expect(stepBody(5)).toContain("not a completed three-method run");
  });
  test("[unit] D20 completion evidence names steps counts comparisons verdict and optional known spend", () => {
    const send = section(doc, "## What to send us");
    for (const words of ["jev@breakoutwithai.com", "step number", "Kept / labelled", "Unlabelled", "paired labelled cases", "Cost / kept", "comparison", "verdict", "Total actual attempts", "known", "unknown", "optional", "Jev-only test"])
      expect(send).toContain(words);
    expect(safeEvidence(send)).toBe(true);
    for (const unsafe of ["Send your API key", "Include case text", "Copy question text", "Attach raw exports", "Send models answers"])
      expect(safeEvidence(`${send}\n${unsafe}`)).toBe(false);
  });
  test("[unit] D20 forbids secret inputs answers exports and unsafe screenshots", () => {
    const never = section(doc, "## Never send");
    for (const word of ["key", "password", "case text", "question", "account details", "answers", "records.csv", "run evidence", "screenshots"])
      expect(never.toLowerCase()).toContain(word);
    expect(never).toContain("Crop screenshots");
    expect(never).toContain("question, case text and key fields");
  });
  test("[unit] D20 blocker email comes before public redacted issue and template exists", () => {
    const blocker = section(doc, "## Report a blocker");
    expect(blocker.indexOf("jev@breakoutwithai.com")).toBeGreaterThanOrEqual(0);
    expect(blocker.indexOf("jev@breakoutwithai.com")).toBeLessThan(blocker.indexOf("github.com"));
    for (const word of ["tester-blocker", "step number", "public", "redacted"])
      expect(blocker).toContain(word);
    expect(existsSync(join(ROOT, TEMPLATE))).toBe(true);
    const template = read(TEMPLATE);
    expect(template).toMatch(/^---\n(?:.*\n)*?labels: tester-blocker\n(?:.*\n)*?---\n/);
    expect(template.toLowerCase()).toContain("step number");
    expect(template.toLowerCase()).toContain("what you saw");
    expect(template).toContain("Do not paste");
  });
});
