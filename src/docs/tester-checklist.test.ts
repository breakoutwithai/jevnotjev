// docs/uat/tester-checklist.md: one complete Backstage run a tester can follow and we can confirm
// without their inputs. Every step says what the tester sees when it worked, every quoted label
// still exists at the file:line it cites, and the evidence we ask for never includes secrets or cases.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DOC = "docs/uat/tester-checklist.md";
const TEMPLATE = ".github/ISSUE_TEMPLATE/tester-blocker.md";

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Every "`label` (`path:line`)" pair in the doc. */
function citations(text: string): { label: string; path: string; line: number }[] {
  const out: { label: string; path: string; line: number }[] = [];
  for (const m of text.matchAll(/`([^`]+)` \(`([^`:]+):(\d+)`\)/g)) {
    out.push({ label: m[1] ?? "", path: m[2] ?? "", line: Number(m[3]) });
  }
  return out;
}

const doc = existsSync(join(ROOT, DOC)) ? read(DOC) : "";

describe("tester checklist", () => {
  test("has five steps in the order of the run", () => {
    const titles = [...doc.matchAll(/^## Step (\d): (.+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(titles).toHaveLength(5);
    const words = ["decision", "cases", "jev, an llm and a rule", "review", "verdict"];
    titles.forEach((title, i) => {
      expect(title.startsWith(String(i + 1))).toBe(true);
      expect(title.toLowerCase()).toContain(words[i] ?? "");
    });
  });

  test("every step says what the tester sees, with a cited label", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const body = section(doc, doc.match(new RegExp(`^## Step ${n}: .+$`, "m"))?.[0] ?? `## Step ${n}`);
      const seen = body.split("\n").filter((line) => line.startsWith("- **You see:**"));
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((line) => citations(line).length > 0)).toBe(true);
    }
  });

  test("every quoted label exists at the line it cites", () => {
    const cited = citations(doc);
    expect(cited.length).toBeGreaterThanOrEqual(15);
    for (const c of cited) {
      const lines = read(c.path).split("\n");
      expect({ cite: `${c.path}:${c.line}`, found: (lines[c.line - 1] ?? "").includes(c.label) }).toEqual({
        cite: `${c.path}:${c.line}`,
        found: true,
      });
    }
  });

  test("names exactly the verdicts the code can return", () => {
    const source = read("src/core/verdict.ts").split("\n").find((line) => line.startsWith("export type VerdictName")) ?? "";
    const names = [...source.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(names).toHaveLength(3);
    const verdicts = section(doc, "## Step 5: Reach a verdict");
    for (const name of names) expect(verdicts).toContain(`\`${name}\``);
  });

  test("asks only for the verdict line and cost figures, never secrets or cases", () => {
    const send = section(doc, "## What to send us");
    const never = section(doc, "## Never send");
    expect(send).toContain("Cost / kept");
    expect(send.toLowerCase()).toContain("verdict");
    expect(send).not.toMatch(/\bkeys?\b|password|case text|account/i);
    for (const word of ["key", "password", "case text", "account details", "records.csv", "run evidence"])
      expect(never.toLowerCase()).toContain(word);
  });

  test("blocker reports go to a labelled issue template or email, with no secrets", () => {
    const blocker = section(doc, "## Report a blocker");
    expect(blocker).toContain("tester-blocker");
    expect(blocker.toLowerCase()).toContain("step number");
    expect(blocker).toContain("jev@breakoutwithai.com");
    expect(blocker).toContain(TEMPLATE);
    const template = existsSync(join(ROOT, TEMPLATE)) ? read(TEMPLATE) : "";
    expect(template).toMatch(/^---\n(?:.*\n)*?labels: tester-blocker\n(?:.*\n)*?---\n/);
    expect(template.toLowerCase()).toContain("step number");
    expect(template.toLowerCase()).toContain("what you saw");
    expect(template).toContain("Do not paste");
  });
});
