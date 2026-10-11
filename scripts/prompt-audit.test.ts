import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { countChecklist, extractPaths, flagsFor, parsePrompt, renderTable, verdictFor, type Verdict } from "./prompt-audit";

const FIXTURE = `---
prompt_id: jnj-fixture
title: A fixture
created: 2026-10-01
status: ready-not-run
governing_issue: 39
executor:
  model: claude-opus-5-5
deliverables:
  - "#36: src/core/calc.ts + src/core/calc.test.ts (Wilson)"
  - "scripts/shows/build-posters.ts: generates the list"
  - bare item without path
scope:
  in:
    - "not a deliverable.ts"
---

# Body

## Definition of done
- [ ] first
- [x] second
  - [X] nested third

## Other
- [ ] not counted
`;

describe("parsePrompt", () => {
  test("[unit] reads scalar keys and strips quotes", () => {
    const p = parsePrompt(FIXTURE);
    expect(p.promptId).toBe("jnj-fixture");
    expect(p.created).toBe("2026-10-01");
    expect(p.status).toBe("ready-not-run");
    expect(p.governingIssue).toBe(39);
  });
  test("[unit] reads only the deliverables list, quoted and bare", () => {
    expect(parsePrompt(FIXTURE).deliverables).toEqual([
      "#36: src/core/calc.ts + src/core/calc.test.ts (Wilson)",
      "scripts/shows/build-posters.ts: generates the list",
      "bare item without path",
    ]);
  });
  test("[unit] governing_issue is optional", () => {
    const p = parsePrompt("---\nprompt_id: x\nstatus: draft\ncreated: 2026-01-01\n---\nbody\n");
    expect(p.governingIssue).toBeNull();
    expect(p.deliverables).toEqual([]);
  });
  test("[unit] text without front matter yields empty header fields", () => {
    const p = parsePrompt("no front matter here\n");
    expect(p.promptId).toBeNull();
    expect(p.status).toBeNull();
  });
});

describe("countChecklist", () => {
  test("[unit] counts checked and unchecked only inside the Definition of done section", () => {
    expect(countChecklist(FIXTURE)).toEqual({ checked: 2, unchecked: 1 });
  });
  test("[unit] no section means zero", () => {
    expect(countChecklist("# nothing\n- [ ] stray\n")).toEqual({ checked: 0, unchecked: 0 });
  });
});

describe("extractPaths", () => {
  test("[unit] path-first shape with a description after the colon", () => {
    expect(extractPaths("scripts/shows/build-posters.ts: generates the poster list")).toEqual(["scripts/shows/build-posters.ts"]);
  });
  test("[unit] issue-prefixed shape with several paths", () => {
    expect(extractPaths("#36: src/core/calc.ts + src/core/calc.test.ts (Wilson, Newcombe)")).toEqual(["src/core/calc.ts", "src/core/calc.test.ts"]);
  });
  test("[unit] directory token and prose yield the directory only", () => {
    expect(extractPaths("site/ ticket office section on the main page")).toEqual(["site/"]);
  });
  test("[unit] backticks and trailing commas are stripped", () => {
    expect(extractPaths("`site/theatre.js`, site/theatre.css, and more")).toEqual(["site/theatre.js", "site/theatre.css"]);
  });
  test("[unit] placeholders and globs are ignored", () => {
    expect(extractPaths("docs/product/runs/<date>-uc14/: records.csv")).toEqual(["records.csv"]);
    expect(extractPaths("~/.agents/skills/pr-status/scripts/*.test.ts (one per script)")).toEqual([]);
  });
  test("[unit] ~/ expands to the home directory", () => {
    expect(extractPaths("~/.agents/skills/pr-status/SKILL.md (revised)")).toEqual([join(homedir(), ".agents/skills/pr-status/SKILL.md")]);
  });
  test("[unit] prose, org/repo names and abbreviations are not paths", () => {
    expect(extractPaths("one PR on breakoutwithai/jevnotjev, e.g. with the rule 10 gate evidence")).toEqual([]);
  });
  test("[unit] duplicates collapse", () => {
    expect(extractPaths("a/b.ts and a/b.ts")).toEqual(["a/b.ts"]);
  });
});

describe("verdictFor", () => {
  const base = { exists: 0, missing: 0, evidence: 0, issue: "none" as const };
  test("[unit] NOT-RUN when nothing exists and no evidence", () => {
    expect(verdictFor({ ...base, missing: 3 })).toBe("NOT-RUN");
  });
  test("[unit] DELIVERED when all exist and no issue", () => {
    expect(verdictFor({ ...base, exists: 3 })).toBe("DELIVERED");
  });
  test("[unit] DELIVERED when all exist and the issue is CLOSED", () => {
    expect(verdictFor({ ...base, exists: 2, issue: "CLOSED" })).toBe("DELIVERED");
  });
  test("[unit] PARTIAL when some exist", () => {
    expect(verdictFor({ ...base, exists: 1, missing: 1 })).toBe("PARTIAL");
  });
  test("[unit] PARTIAL when all exist but the issue is OPEN", () => {
    expect(verdictFor({ ...base, exists: 2, issue: "OPEN" })).toBe("PARTIAL");
  });
  test("[unit] an unknown issue is never treated as closed", () => {
    expect(verdictFor({ ...base, exists: 2, issue: "unknown" })).toBe("PARTIAL");
  });
  test("[unit] PARTIAL when evidence commits exist but no deliverable does", () => {
    expect(verdictFor({ ...base, missing: 2, evidence: 4 })).toBe("PARTIAL");
  });
  test("[unit] NO-EVIDENCE-POSSIBLE with zero checkable paths and no issue", () => {
    expect(verdictFor(base)).toBe("NO-EVIDENCE-POSSIBLE");
  });
  test("[unit] zero checkable paths with an issue and no evidence is NOT-RUN", () => {
    expect(verdictFor({ ...base, issue: "OPEN" })).toBe("NOT-RUN");
  });
});

describe("flagsFor", () => {
  const f = (status: string | null, verdict: Verdict) => flagsFor(status, verdict);
  test("[unit] ready-not-run or draft with a non-NOT-RUN verdict is STALE-STATUS", () => {
    expect(f("ready-not-run", "PARTIAL")).toEqual(["STALE-STATUS"]);
    expect(f("draft", "DELIVERED")).toEqual(["STALE-STATUS"]);
  });
  test("[unit] ready-not-run with NOT-RUN is consistent", () => {
    expect(f("ready-not-run", "NOT-RUN")).toEqual([]);
  });
  test("[unit] done must be DELIVERED", () => {
    expect(f("done", "PARTIAL")).toEqual(["STALE-STATUS"]);
    expect(f("done", "DELIVERED")).toEqual([]);
  });
  test("[unit] a status outside the allowed set is INVALID-STATUS", () => {
    expect(f("in-progress", "PARTIAL")).toEqual(["INVALID-STATUS"]);
    expect(f(null, "NOT-RUN")).toEqual(["INVALID-STATUS"]);
  });
  test("[unit] running and superseded carry no stale flag", () => {
    expect(f("running", "PARTIAL")).toEqual([]);
    expect(f("superseded", "NOT-RUN")).toEqual([]);
  });
});

describe("renderTable", () => {
  test("[unit] truncates a long stem and shows flags", () => {
    const out = renderTable([{ stem: "x".repeat(80), status: "ready-not-run", verdict: "PARTIAL", exists: 1, checkable: 2, evidence: 3, flags: ["STALE-STATUS"] }]);
    expect(out).toContain("PARTIAL");
    expect(out).toContain("1/2");
    expect(out).toContain("STALE-STATUS");
    expect(out.split("\n").every((l) => l.length < 120)).toBe(true);
  });
});

const SCRIPT = join(import.meta.dir, "prompt-audit.ts");

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

describe("prompt-audit CLI", () => {
  test("[integration] --no-gh derives verdicts from a temp git repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "jnj-prompt-audit-"));
    try {
      git(repo, "init", "-q", "-b", "main");
      mkdirSync(join(repo, "docs/prompts"), { recursive: true });
      mkdirSync(join(repo, "scripts"), { recursive: true });
      writeFileSync(join(repo, "scripts/thing.ts"), "export const thing = 1;\n");
      const prompt = (id: string, status: string, items: string[]) =>
        `---\nprompt_id: ${id}\ncreated: 2020-01-01\nstatus: ${status}\ndeliverables:\n${items.map((i) => `  - "${i}"`).join("\n")}\n---\n\n## Definition of done\n- [ ] one\n- [x] two\n`;
      writeFileSync(join(repo, "docs/prompts/20200101-delivered.prompt.md"), prompt("fx-delivered", "ready-not-run", ["scripts/thing.ts: the thing"]));
      writeFileSync(join(repo, "docs/prompts/20200101-notrun.prompt.md"), prompt("fx-notrun", "ready-not-run", ["scripts/absent.ts: never built"]));
      writeFileSync(join(repo, "docs/prompts/20200101-partial.prompt.md"), prompt("fx-partial", "done", ["scripts/thing.ts: x", "scripts/absent.ts: y"]));
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "add fixtures");
      const run = Bun.spawnSync(["bun", SCRIPT, "--json", "--no-gh", "--ref", "HEAD"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(0);
      const parsed: unknown = JSON.parse(run.stdout.toString());
      const rows: unknown[] = Array.isArray(parsed) ? parsed : [];
      expect(rows.length).toBe(3);
      const verdictOf = (stem: string): unknown => {
        const row = rows.find((r) => typeof r === "object" && r !== null && Reflect.get(r, "stem") === stem);
        return typeof row === "object" && row !== null ? Reflect.get(row, "verdict") : undefined;
      };
      expect(verdictOf("20200101-delivered")).toBe("DELIVERED");
      expect(verdictOf("20200101-notrun")).toBe("NOT-RUN");
      expect(verdictOf("20200101-partial")).toBe("PARTIAL");
      const strict = Bun.spawnSync(["bun", SCRIPT, "--no-gh", "--ref", "HEAD", "--strict"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      expect(strict.exitCode).toBe(1);
      expect(strict.stdout.toString()).toContain("STALE-STATUS");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
