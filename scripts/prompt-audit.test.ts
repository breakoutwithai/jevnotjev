import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditPrompt,
  buildTree,
  classifyPath,
  countChecklist,
  extractCandidates,
  extractPaths,
  flagsFor,
  isIsoDate,
  normalizeCreated,
  parseArgs,
  parsePrompt,
  renderTable,
  verdictFor,
  type Git,
  type Verdict,
} from "./prompt-audit";

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

const front = (body: string) => `---\n${body}\n---\nbody\n`;

describe("parsePrompt", () => {
  test("[unit] reads scalar keys and strips quotes", () => {
    const p = parsePrompt(FIXTURE);
    expect(p.promptId).toBe("jnj-fixture");
    expect(p.created).toBe("2026-10-01");
    expect(p.status).toBe("ready-not-run");
    expect(p.governingIssue).toBe(39);
    expect(p.errors).toEqual([]);
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
    expect(p.errors).toEqual([]);
  });
  test("[unit] text without front matter yields empty header fields and an error", () => {
    const p = parsePrompt("no front matter here\n");
    expect(p.promptId).toBeNull();
    expect(p.status).toBeNull();
    expect(p.errors.length).toBe(1);
  });
  test("[unit] R3-2 only a column-0 `---` line closes the front matter", () => {
    const p = parsePrompt("---\nprompt_id: a\ndeliverables:\n  - >-\n    text\n    ---\n    more\nstatus: draft\n---\nbody\n");
    expect(p.errors).toEqual([]);
    expect(p.status).toBe("draft");
    expect(p.deliverables).toEqual(["text --- more"]);
  });
  test("[unit] R3-3 prompt_id must be a non-empty single-line string, trimmed", () => {
    expect(parsePrompt(front('prompt_id: "  x  "')).promptId).toBe("x");
    for (const bad of ['prompt_id: "a\\nb"', 'prompt_id: ""', 'prompt_id: "  "']) {
      const p = parsePrompt(front(bad));
      expect(p.promptId).toBeNull();
      expect(p.errors[0]).toContain("prompt_id");
    }
  });
  test("[unit] Y1 YAML escapes, doubled apostrophes and folded scalars are decoded", () => {
    const p = parsePrompt(front('deliverables:\n  - "scripts/caf\\u00e9.ts: x"\n  - \'it\'\'s/a.ts\'\n  - >-\n    scripts/long.ts: first\n    second'));
    expect(p.errors).toEqual([]);
    expect(p.deliverables).toEqual(["scripts/café.ts: x", "it's/a.ts", "scripts/long.ts: first second"]);
  });
  test("[unit] Y2 quoted brackets in a flow list survive", () => {
    expect(parsePrompt(front("deliverables: [\"scripts/a[1].ts\", 'b[2].ts']")).deliverables).toEqual(["scripts/a[1].ts", "b[2].ts"]);
  });
  test("[unit] Y3 invalid YAML is a header error, not a silent empty parse", () => {
    const p = parsePrompt(front("deliverables: [a/b.ts\nstatus: draft"));
    expect(p.errors.length).toBe(1);
    expect(p.errors[0]).toContain("front matter");
    expect(p.deliverables).toEqual([]);
  });
  test("[unit] Y4 front matter that is not a mapping is a header error", () => {
    expect(parsePrompt(front("- a\n- b")).errors[0]).toContain("mapping");
    expect(parsePrompt(front("")).errors[0]).toContain("mapping");
  });
  test("[unit] Y5 deliverables present but not a list of strings is a header error", () => {
    for (const body of ["deliverables: 5", "deliverables: [1, a]", "deliverables:\n- #36: x\n- ok.ts", "deliverables: {a: b}"]) {
      const p = parsePrompt(front(body));
      expect(p.errors.some((e) => e.includes("deliverables"))).toBe(true);
      expect(p.deliverables).toEqual([]);
    }
  });
  test("[unit] Y6 governing_issue beyond the safe integer range is an error", () => {
    const p = parsePrompt(front("governing_issue: 99999999999999999999"));
    expect(p.governingIssue).toBeNull();
    expect(p.errors[0]).toContain("governing_issue");
  });
  test("[unit] Y7 created accepts a string or a Date and normalizes to YYYY-MM-DD UTC", () => {
    expect(normalizeCreated("2026-10-01")).toBe("2026-10-01");
    expect(normalizeCreated(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10-01");
    expect(normalizeCreated(new Date("2026-10-01T23:59:59Z"))).toBe("2026-10-01");
    expect(normalizeCreated(new Date("nope"))).toBeNull();
    expect(normalizeCreated(20261001)).toBeNull();
    expect(normalizeCreated("2026-02-30")).toBeNull();
  });
  test("[unit] Y8 a numeric created value is a header error", () => {
    expect(parsePrompt(front("created: 20261001")).errors[0]).toContain("created");
  });
  test("[unit] F4 inline comments are stripped outside quotes", () => {
    const p = parsePrompt(front('status: ready-not-run  # self-reported\ncreated: 2026-10-01 # the day\ngoverning_issue: 39 # the issue\ntitle: "a # b"'));
    expect(p.status).toBe("ready-not-run");
    expect(p.created).toBe("2026-10-01");
    expect(p.governingIssue).toBe(39);
    expect(p.errors).toEqual([]);
  });
  test("[unit] F4 a present governing_issue that is not a positive integer is an error, not null-and-silent", () => {
    for (const bad of ["abc", "0", "-3", "3.5", "39x"]) {
      const p = parsePrompt(front(`governing_issue: ${bad}`));
      expect(p.governingIssue).toBeNull();
      expect(p.errors.length).toBe(1);
      expect(p.errors[0]).toContain("governing_issue");
    }
  });
  test("[unit] F4 an empty or null governing_issue is simply absent", () => {
    expect(parsePrompt(front("governing_issue:")).errors).toEqual([]);
    expect(parsePrompt(front("governing_issue: null # none")).errors).toEqual([]);
  });
  test("[unit] F1 created must be a real YYYY-MM-DD date", () => {
    expect(parsePrompt(front("created: 2026-13-45")).errors[0]).toContain("created");
    expect(parsePrompt(front("created: 10/01/2026")).errors[0]).toContain("created");
    expect(isIsoDate("2026-10-01")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-1-1")).toBe(false);
  });
  test("[unit] F5 indentless block sequence is read", () => {
    const p = parsePrompt(front('deliverables:\n- a/b.ts\n- "c/d.ts: two"\nscope:\n- not.me'));
    expect(p.deliverables).toEqual(["a/b.ts", "c/d.ts: two"]);
    expect(p.errors).toEqual([]);
  });
  test("[unit] Y9 an unquoted `path: description` item is a YAML mapping and is reported, not guessed at", () => {
    const p = parsePrompt(front("deliverables:\n- a/b.ts: one"));
    expect(p.deliverables).toEqual([]);
    expect(p.errors[0]).toContain("deliverables");
  });
  test("[unit] F5 flow sequence is read, quote-aware, single and multi line", () => {
    expect(parsePrompt(front('deliverables: [a/b.ts, "c/d.ts: x, y", \'e/f.ts\']')).deliverables).toEqual(["a/b.ts", "c/d.ts: x, y", "e/f.ts"]);
    expect(parsePrompt(front("deliverables: [\n  a/b.ts,\n  c/d.ts\n]\nstatus: draft")).deliverables).toEqual(["a/b.ts", "c/d.ts"]);
    expect(parsePrompt(front("deliverables: []\nstatus: draft")).deliverables).toEqual([]);
    expect(parsePrompt(front("deliverables: []\nstatus: draft")).status).toBe("draft");
  });
});

describe("countChecklist", () => {
  test("[unit] counts checked and unchecked only inside the Definition of done section", () => {
    expect(countChecklist(FIXTURE)).toEqual({ checked: 2, unchecked: 1 });
  });
  test("[unit] no section means zero", () => {
    expect(countChecklist("# nothing\n- [ ] stray\n")).toEqual({ checked: 0, unchecked: 0 });
  });
  test("[unit] F17 fenced code blocks inside the section are ignored", () => {
    const text = "## Definition of done\n- [x] real\n```md\n## Fake heading\n- [ ] in a fence\n- [x] in a fence\n```\n- [ ] after the fence\n~~~\n- [ ] tilde fence\n~~~\n";
    expect(countChecklist(text)).toEqual({ checked: 1, unchecked: 1 });
  });
  test("[unit] F17 a Definition of done heading inside a fence does not open the section", () => {
    expect(countChecklist("```\n## Definition of done\n- [ ] x\n```\n")).toEqual({ checked: 0, unchecked: 0 });
  });
});

describe("countChecklist rendered markdown", () => {
  test("[unit] R3-9 plus bullets and ordered lists carry tasks", () => {
    expect(countChecklist("## Definition of done\n+ [x] plus\n1. [ ] ordered\n")).toEqual({ checked: 1, unchecked: 1 });
  });
  test("[unit] R3-10 `[x]word` with no space is not a task", () => {
    expect(countChecklist("## Definition of done\n- [x]word\n- [ ] real\n")).toEqual({ checked: 0, unchecked: 1 });
  });
  test("[unit] R3-11 an indented code block is not a task list", () => {
    expect(countChecklist("## Definition of done\n\nText.\n\n    - [ ] code\n\n- [x] real\n")).toEqual({ checked: 1, unchecked: 0 });
  });
  test("[unit] R3-12 inline code mentioning a checkbox is not a task", () => {
    expect(countChecklist("## Definition of done\nWrite `- [ ] x` in the file.\n\n- [x] real\n")).toEqual({ checked: 1, unchecked: 0 });
  });
  test("[unit] R3-13 a heading with inline markup is still the Definition of done heading", () => {
    expect(countChecklist("## Definition *of* **done**\n- [x] a\n## Next\n- [ ] b\n")).toEqual({ checked: 1, unchecked: 0 });
  });
  test("[unit] R3-13 setext headings end and open sections too", () => {
    expect(countChecklist("Definition of done\n------------------\n- [x] a\n\nNext\n----\n- [ ] b\n")).toEqual({ checked: 1, unchecked: 0 });
  });
  test("[unit] R3-13 front matter is not rendered as markdown", () => {
    expect(countChecklist("---\ntitle: x\nstatus: draft\n---\n## Definition of done\n- [ ] a\n")).toEqual({ checked: 0, unchecked: 1 });
  });
});

describe("countChecklist sections and fences", () => {
  test("[unit] S2-14 a fence closes only on the same character with at least the opening length", () => {
    const text = "## Definition of done\n````md\n```\n- [ ] inside\n```\n~~~\n- [ ] still inside\n````\n- [x] after\n";
    expect(countChecklist(text)).toEqual({ checked: 1, unchecked: 0 });
  });
  test("[unit] S2-15 the section ends at any heading of the same or higher level", () => {
    expect(countChecklist("## Definition of done\n- [x] a\n### Sub\n- [ ] b\n# Top\n- [ ] c\n")).toEqual({ checked: 1, unchecked: 1 });
    expect(countChecklist("### Definition of done\n- [x] a\n## Next\n- [ ] b\n")).toEqual({ checked: 1, unchecked: 0 });
  });
  test("[unit] S2-15 a level-1 Definition of done heading is recognized and runs through deeper headings", () => {
    expect(countChecklist("# Definition of done\n- [x] a\n## Sub\n- [ ] b\n# Next\n- [ ] c\n")).toEqual({ checked: 1, unchecked: 1 });
  });
});

describe("extractPaths", () => {
  test("[unit] S2-10 any short alphanumeric extension counts", () => {
    expect(extractPaths("src/a.c, src/b.h, scripts/x.R, schema/q.graphql, dist/p.mp4")).toEqual(["src/a.c", "src/b.h", "scripts/x.R", "schema/q.graphql", "dist/p.mp4"]);
  });
  test("[unit] S2-11 a traversal is judged before trailing punctuation is stripped", () => {
    expect(extractCandidates("src/../..")).toEqual({ paths: [], unresolved: ["src/../.."] });
    expect(extractCandidates("src/..")).toEqual({ paths: [], unresolved: ["src/.."] });
    expect(extractCandidates("`src/..`")).toEqual({ paths: [], unresolved: ["src/.."] });
  });
  test("[unit] R3-6 segments made only of non-ASCII letters are valid", () => {
    expect(extractPaths("документы/план.md and 文档/")).toEqual(["документы/план.md", "文档/"]);
  });
  test("[unit] R3-7 a traversal with no alphanumeric segment is still unresolved, trailing slash or not", () => {
    expect(extractCandidates("src/../ and ../.. and ./..")).toEqual({ paths: [], unresolved: ["src/../", "../..", "./.."] });
  });
  test("[unit] S2-11 trailing sentence dots are stripped from prose tokens but never from a backtick span", () => {
    expect(extractPaths("see docs/notes.md.")).toEqual(["docs/notes.md"]);
    expect(extractPaths("see `docs/notes.md.`")).toEqual([]);
  });
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
    expect(extractPaths("docs/product/runs/<date>-uc14/: docs/records.csv")).toEqual(["docs/records.csv"]);
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
  test("[unit] F2 a bare filename is unresolved, never a path", () => {
    expect(extractCandidates("records.csv: the table")).toEqual({ paths: [], unresolved: ["records.csv"] });
  });
  test("[unit] F2 a placeholder directory prefix leaves the bare filename unresolved", () => {
    expect(extractCandidates("docs/runs/<date>-target/: records.csv")).toEqual({ paths: [], unresolved: ["records.csv"] });
  });
  test("[unit] F3 separators and slash prose are not paths", () => {
    expect(extractPaths("see / and/or yes/no Python/branches // ~/ ./ a//")).toEqual([]);
  });
  test("[unit] F3 a plain directory token is still a path", () => {
    expect(extractPaths("src/core/ and a/")).toEqual(["src/core/", "a/"]);
  });
  test("[unit] F9 a backtick span is one candidate even with spaces", () => {
    expect(extractPaths("`docs/My Notes/plan v2.md` and site/")).toEqual(["docs/My Notes/plan v2.md", "site/"]);
  });
  test("[unit] F9 a backtick span listing several paths still splits", () => {
    expect(extractPaths("`a/b.ts, c/d.ts`")).toEqual(["a/b.ts", "c/d.ts"]);
  });
  test("[unit] F10 ./ and // are normalized", () => {
    expect(extractPaths("./src/x.ts and a//b.ts and ./docs/ and a/./b.ts")).toEqual(["src/x.ts", "a/b.ts", "docs/"]);
  });
  test("[unit] F10 a path escaping the repo is unresolved", () => {
    expect(extractCandidates("../x/y.ts and src/../../z.ts")).toEqual({ paths: [], unresolved: ["../x/y.ts", "src/../../z.ts"] });
  });
});

describe("verdictFor", () => {
  const base = { exists: 0, missing: 0, unchecked: 0, evidence: 0, issue: "none" as const };
  test("[unit] R3-1 any unchecked deliverable blocks DELIVERED", () => {
    expect(verdictFor({ ...base, exists: 2, unchecked: 1 })).toBe("PARTIAL");
    expect(verdictFor({ ...base, exists: 2, unchecked: 0 })).toBe("DELIVERED");
  });
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
  test("[unit] F12 zero checkable paths, no issue, but evidence commits is PARTIAL", () => {
    expect(verdictFor({ ...base, evidence: 2 })).toBe("PARTIAL");
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
  test("[unit] F13 NO-EVIDENCE-POSSIBLE does not make ready-not-run or draft stale", () => {
    expect(f("ready-not-run", "NO-EVIDENCE-POSSIBLE")).toEqual([]);
    expect(f("draft", "NO-EVIDENCE-POSSIBLE")).toEqual([]);
  });
});

describe("renderTable", () => {
  test("[unit] truncates a long stem and shows flags", () => {
    const out = renderTable([{ stem: "x".repeat(80), status: "ready-not-run", verdict: "PARTIAL", touched: 1, checkable: 2, evidence: 3, flags: ["STALE-STATUS"] }]);
    expect(out).toContain("PARTIAL");
    expect(out).toContain("1/2");
    expect(out).toContain("STALE-STATUS");
    expect(out.split("\n").every((l) => l.length < 120)).toBe(true);
  });
  test("[unit] two flags still fit the row width", () => {
    const out = renderTable([{ stem: "x".repeat(80), status: "in-progress", verdict: "PARTIAL", touched: 11, checkable: 13, evidence: 120, flags: ["INVALID-STATUS", "INVALID-HEADER"] }]);
    expect(out.split("\n").every((l) => l.length < 120)).toBe(true);
  });
});

// Records every git call; `logOut` is what `git log` prints.
function recorder(logOut: string): { calls: string[][]; git: Git } {
  const calls: string[][] = [];
  const git: Git = (args) => {
    calls.push(args);
    if (args[0] === "check-ignore") return { code: 1, out: "", err: "" };
    return { code: 0, out: logOut, err: "" };
  };
  return { calls, git };
}

describe("classifyPath", () => {
  const tree = buildTree("site/index.html\0src/core/calc.ts\0scripts/new.ts\0other/dir/calc.ts\0");
  const git: Git = (args) => {
    if (args[0] === "check-ignore") return { code: args.includes(".persona-swarm/") ? 0 : 1, out: "", err: "" };
    return { code: 0, out: args.some((a) => a.endsWith("scripts/new.ts")) ? "abc1234\n" : "", err: "" };
  };
  const none = () => false;
  test("[unit] exists with commits since created is TOUCHED", () => {
    expect(classifyPath("scripts/new.ts", tree, git, none, "origin/main", "2026-10-01")).toBe("TOUCHED");
  });
  test("[unit] exists with no commits since created is UNTOUCHED", () => {
    expect(classifyPath("src/core/calc.ts", tree, git, none, "origin/main", "2026-10-01")).toBe("UNTOUCHED");
    expect(classifyPath("site/", tree, git, none, "origin/main", "2026-10-01")).toBe("UNTOUCHED");
  });
  test("[unit] no created date falls back to plain existence", () => {
    expect(classifyPath("src/core/calc.ts", tree, git, none, "origin/main", null)).toBe("TOUCHED");
  });
  test("[unit] R3-4 absent from the pinned tree is MISSING and git check-ignore is never consulted", () => {
    const { calls, git: g } = recorder("");
    expect(classifyPath("nope/x.ts", tree, g, none, "origin/main", "2026-10-01")).toBe("MISSING");
    expect(classifyPath(".persona-swarm/", tree, g, none, "origin/main", "2026-10-01")).toBe("MISSING");
    expect(calls.some((c) => c[0] === "check-ignore")).toBe(false);
  });
  test("[unit] absolute paths are checked on the filesystem", () => {
    expect(classifyPath("/abs/there.ts", tree, git, (p) => p === "/abs/there.ts", "origin/main", "2026-10-01")).toBe("TOUCHED");
    expect(classifyPath("/abs/gone.ts", tree, git, none, "origin/main", "2026-10-01")).toBe("MISSING");
  });
  test("[unit] F1 the since filter is UTC midnight of the date and never the time-of-day --since", () => {
    const { calls, git: g } = recorder("abc1234\n");
    classifyPath("scripts/new.ts", tree, g, none, "origin/main", "2026-10-01");
    const log = calls.find((c) => c[0] === "log") ?? [];
    expect(log).toContain("--since-as-filter=2026-10-01T00:00:00Z");
    expect(log.some((a) => a.startsWith("--since="))).toBe(false);
  });
  test("[unit] F6 a failing git log throws with its stderr instead of reading as empty", () => {
    const failing: Git = (args) => (args[0] === "log" ? { code: 128, out: "", err: "fatal: bad object" } : { code: 1, out: "", err: "" });
    expect(() => classifyPath("scripts/new.ts", tree, failing, none, "origin/main", "2026-10-01")).toThrow("fatal: bad object");
  });
  test("[unit] S2-13 a trailing-slash path needs a tracked descendant, not a file of that name", () => {
    const t = buildTree("docs/notes\0docs/real/a.md\0");
    expect(classifyPath("docs/notes/", t, git, none, "origin/main", null)).toBe("MISSING");
    expect(classifyPath("docs/real/", t, git, none, "origin/main", null)).toBe("TOUCHED");
    expect(classifyPath("docs/notes", t, git, none, "origin/main", null)).toBe("TOUCHED");
  });
  test("[unit] F7 log pathspecs are literal", () => {
    const { calls, git: g } = recorder("abc1234\n");
    classifyPath("scripts/new.ts", tree, g, none, "origin/main", "2026-10-01");
    const log = calls.find((c) => c[0] === "log") ?? [];
    expect(log.slice(log.indexOf("--") + 1)).toEqual([":(literal)scripts/new.ts"]);
  });
});

describe("buildTree", () => {
  test("[unit] F8 NUL-separated names keep newlines and unicode intact", () => {
    const tree = buildTree("a\nb.ts\0café.ts\0plain.ts\0");
    expect([...tree.files]).toEqual(["a\nb.ts", "café.ts", "plain.ts"]);
  });
});

describe("auditPrompt", () => {
  const tree = buildTree("scripts/new.ts\0other/dir/calc.ts\0");
  const none = () => false;
  const prompt = (items: string[], extra = "created: 2026-10-01\nstatus: ready-not-run") => `---\nprompt_id: p\n${extra}\ndeliverables:\n${items.map((i) => `  - "${i}"`).join("\n")}\n---\n`;
  test("[unit] F2 a bare filename never matches an unrelated tracked file", () => {
    const { git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["calc.ts: the calculator"]), tree, git, "sha", null, none);
    expect(r.pathsTouched).toBe(0);
    expect(r.pathsMissing).toBe(0);
    expect(r.deliverables[0]?.unresolved).toEqual(["calc.ts"]);
    expect(r.deliverables[0]?.unchecked).toBe(true);
  });
  test("[unit] F11 evidence queries use the same normalized, literal path as classification", () => {
    const { calls, git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["./scripts/new.ts: x"]), tree, git, "sha", null, none);
    expect(r.deliverables[0]?.paths).toEqual([{ path: "scripts/new.ts", state: "TOUCHED" }]);
    const specs = calls.filter((c) => c[0] === "log" && c.includes("--")).map((c) => c.slice(c.indexOf("--") + 1));
    expect(specs.length).toBeGreaterThan(1);
    for (const spec of specs) expect(spec).toEqual([":(literal)scripts/new.ts"]);
  });
  test("[unit] F1 an invalid created date is reported and no path is classified against it", () => {
    const { calls, git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["scripts/new.ts: x"], "created: 2026-13-45\nstatus: ready-not-run"), tree, git, "sha", null, none);
    expect(r.errors[0]).toContain("created");
    expect(r.flags).toContain("INVALID-HEADER");
    expect(r.pathsTouched).toBe(0);
    expect(r.deliverables[0]?.unresolved).toEqual(["scripts/new.ts"]);
    expect(calls.some((c) => c.some((a) => a.startsWith("--since")))).toBe(false);
  });
  test("[unit] F4 a bad governing_issue raises INVALID-HEADER", () => {
    const { git } = recorder("");
    const r = auditPrompt("x.prompt.md", prompt(["scripts/new.ts: x"], "created: 2026-10-01\nstatus: ready-not-run\ngoverning_issue: soon"), tree, git, "sha", null, none);
    expect(r.flags).toContain("INVALID-HEADER");
    expect(r.errors[0]).toContain("governing_issue");
  });
  test("[unit] S2-1 R3-4 a git-excluded path is plain MISSING and never counts toward delivery", () => {
    const { calls, git } = recorder("");
    const r = auditPrompt("x.prompt.md", prompt([".persona-swarm/report.md: x"]), tree, git, "sha", null, none);
    expect(r.deliverables[0]?.paths).toEqual([{ path: ".persona-swarm/report.md", state: "MISSING" }]);
    expect(r.pathsTouched).toBe(0);
    expect(r.verdict).not.toBe("DELIVERED");
    expect(calls.some((c) => c[0] === "check-ignore")).toBe(false);
  });
  test("[unit] R3-1 a prose deliverable with no path blocks DELIVERED even when every path is touched", () => {
    const { git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["scripts/new.ts: x", "one PR with the gate evidence"]), tree, git, "sha", null, none);
    expect(r.pathsTouched).toBe(1);
    expect(r.deliverables[1]?.unchecked).toBe(true);
    expect(r.verdict).toBe("PARTIAL");
  });
  test("[unit] R3-8 a backtick filename containing a comma is split and stays conservative", () => {
    const commaTree = buildTree("docs/a, b.md\0");
    const { git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["`docs/a, b.md`: x"]), commaTree, git, "sha", null, none);
    expect(r.deliverables[0]?.unchecked).toBe(true);
    expect(r.verdict).not.toBe("DELIVERED");
  });
  test("[unit] R3-3 a prompt_id with a newline or no content never reaches a --grep argument", () => {
    for (const id of ['"a\\nb"', '""', '"   "']) {
      const { calls, git } = recorder("");
      const r = auditPrompt("x.prompt.md", `---\nprompt_id: ${id}\nstatus: draft\n---\n`, tree, git, "sha", null, none);
      expect(r.flags).toContain("INVALID-HEADER");
      expect(calls.flatMap((c) => c).some((a) => a.startsWith("--grep=") && (a.includes("\n") || a === "--grep="))).toBe(false);
    }
  });
  test("[unit] R3-3 a file stem with a newline is not used as a --grep needle", () => {
    const { calls, git } = recorder("");
    auditPrompt("a\nb.prompt.md", "---\nstatus: draft\n---\n", tree, git, "sha", null, none);
    expect(calls.some((c) => c[0] === "log")).toBe(false);
  });
  test("[unit] S2-12 a deliverable with any unresolved or ignored candidate is unchecked", () => {
    const { git } = recorder("");
    const r = auditPrompt("x.prompt.md", prompt(["scripts/new.ts and records.csv: x"]), tree, git, "sha", null, none);
    expect(r.deliverables[0]?.paths.length).toBe(1);
    expect(r.deliverables[0]?.unresolved).toEqual(["records.csv"]);
    expect(r.deliverables[0]?.unchecked).toBe(true);
    const ok = auditPrompt("x.prompt.md", prompt(["scripts/new.ts: x"]), tree, git, "sha", null, none);
    expect(ok.deliverables[0]?.unchecked).toBe(false);
  });
  test("[unit] S2-3 with no prompt id and no stem the message query is skipped, never an unfiltered log", () => {
    const { calls, git } = recorder("abc1234\n");
    const r = auditPrompt(".prompt.md", "---\nstatus: draft\n---\n", tree, git, "sha", null, none);
    expect(calls.some((c) => c[0] === "log")).toBe(false);
    expect(r.evidenceCommits).toEqual([]);
  });
  test("[unit] F6 a failing evidence grep throws", () => {
    const failing: Git = (args) => (args.some((a) => a.startsWith("--grep=")) ? { code: 128, out: "", err: "fatal: grep boom" } : { code: 1, out: "", err: "" });
    expect(() => auditPrompt("x.prompt.md", prompt(["site/: x"]), tree, failing, "sha", null, none)).toThrow("grep boom");
  });
});

describe("parseArgs", () => {
  test("[unit] defaults", () => {
    const r = parseArgs([]);
    expect(r).toEqual({ ok: true, options: { dir: "docs/prompts", ref: "origin/main", json: false, strict: false, noGh: false, help: false } });
  });
  test("[unit] F16 accepts every documented option", () => {
    const r = parseArgs(["--dir", "d", "--ref", "r", "--json", "--strict", "--no-gh"]);
    expect(r).toEqual({ ok: true, options: { dir: "d", ref: "r", json: true, strict: true, noGh: true, help: false } });
  });
  test("[unit] F16 an unknown option is an error", () => {
    const r = parseArgs(["--bogus"]);
    expect(r.ok).toBe(false);
  });
  test("[unit] F16 a missing option value is an error", () => {
    expect(parseArgs(["--dir"]).ok).toBe(false);
    expect(parseArgs(["--ref"]).ok).toBe(false);
    expect(parseArgs(["--dir", "--json"]).ok).toBe(false);
  });
  test("[unit] F16 a positional argument is an error", () => {
    expect(parseArgs(["docs/prompts"]).ok).toBe(false);
  });
});

const SCRIPT = join(import.meta.dir, "prompt-audit.ts");

function gitAt(cwd: string, env: Record<string, string>, ...args: string[]): void {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function git(cwd: string, ...args: string[]): void {
  gitAt(cwd, {}, ...args);
}

function commitAt(repo: string, date: string | null, message: string): void {
  git(repo, "add", "-A");
  gitAt(repo, date === null ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, "commit", "-q", "-m", message);
}

function withRepo(fn: (repo: string) => void, sub = ""): void {
  const base = mkdtempSync(join(tmpdir(), "jnj-prompt-audit-"));
  const repo = sub === "" ? base : join(base, sub);
  try {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    mkdirSync(join(repo, "docs/prompts"), { recursive: true });
    mkdirSync(join(repo, "scripts"), { recursive: true });
    fn(repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function cli(cwd: string, ...args: string[]): { code: number | null; out: string; err: string } {
  const run = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

function dig(value: unknown, ...keys: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const k of keys) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = Reflect.get(cur, k);
  }
  return cur;
}

function rowsOf(out: string): unknown[] {
  const parsed: unknown = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

const promptFile = (id: string, status: string, items: string[], created = "2020-01-01") =>
  `---\nprompt_id: ${id}\ncreated: ${created}\nstatus: ${status}\ndeliverables:\n${items.map((i) => `  - "${i}"`).join("\n")}\n---\n\n## Definition of done\n- [ ] one\n- [x] two\n`;

describe("prompt-audit CLI", () => {
  test("[integration] a directory with no prompts exits 2 and says so on stderr", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "README.md"), "x\n");
      commitAt(repo, null, "init");
      const run = cli(repo, "--no-gh", "--ref", "HEAD");
      expect(run.code).toBe(2);
      expect(run.err).toContain("no prompts in docs/prompts");
      expect(run.out).toBe("");
    });
  });

  test("[integration] R3-14 an unreadable directory reports the real error, not 'no prompts'", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "afile"), "x\n");
      commitAt(repo, null, "init");
      for (const dir of ["nowhere", "afile"]) {
        const run = cli(repo, "--no-gh", "--ref", "HEAD", "--dir", dir);
        expect(run.code).toBe(2);
        expect(run.err).toContain(`cannot read ${dir}`);
        expect(run.err).not.toContain("no prompts in");
      }
    });
  });

  test("[integration] R3-15 only the trailing newline is stripped from the repo root path", () => {
    withRepo(
      (repo) => {
        writeFileSync(join(repo, "scripts/thing.ts"), "export const thing = 1;\n");
        writeFileSync(join(repo, "docs/prompts/20200101-sp.prompt.md"), promptFile("fx-sp", "ready-not-run", ["scripts/thing.ts: x"]));
        commitAt(repo, null, "files");
        const run = cli(repo, "--json", "--no-gh", "--ref", "HEAD");
        expect(run.code).toBe(0);
        expect(dig(rowsOf(run.out)[0], "deliverables", 0, "paths", 0, "state")).toBe("TOUCHED");
      },
      "trailing-space ",
    );
  });

  test("[integration] --no-gh derives verdicts from a temp git repo", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "scripts/old.ts"), "export const old = 1;\n");
      commitAt(repo, "2019-01-01T00:00:00Z", "old file");
      writeFileSync(join(repo, "scripts/thing.ts"), "export const thing = 1;\n");
      writeFileSync(join(repo, "docs/prompts/20200101-delivered.prompt.md"), promptFile("fx-delivered", "ready-not-run", ["scripts/thing.ts: the thing"]));
      writeFileSync(join(repo, "docs/prompts/20200101-notrun.prompt.md"), promptFile("fx-notrun", "ready-not-run", ["scripts/absent.ts: never built"]));
      writeFileSync(join(repo, "docs/prompts/20200101-partial.prompt.md"), promptFile("fx-partial", "done", ["scripts/thing.ts: x", "scripts/absent.ts: y"]));
      writeFileSync(join(repo, "docs/prompts/20200101-untouched.prompt.md"), promptFile("fx-untouched", "ready-not-run", ["scripts/old.ts: pre-existing"]));
      commitAt(repo, null, "add fixtures");
      const run = cli(repo, "--json", "--no-gh", "--ref", "HEAD");
      expect(run.code).toBe(0);
      const rows = rowsOf(run.out);
      expect(rows.length).toBe(4);
      const verdictOf = (stem: string): unknown =>
        dig(
          rows.find((r) => dig(r, "stem") === stem),
          "verdict",
        );
      expect(verdictOf("20200101-delivered")).toBe("DELIVERED");
      expect(verdictOf("20200101-notrun")).toBe("NOT-RUN");
      expect(verdictOf("20200101-partial")).toBe("PARTIAL");
      expect(verdictOf("20200101-untouched")).toBe("NOT-RUN");
      expect(run.out).toContain("UNTOUCHED");
      const strict = cli(repo, "--no-gh", "--ref", "HEAD", "--strict");
      expect(strict.code).toBe(1);
      expect(strict.out).toContain("STALE-STATUS");
    });
  });

  test("[integration] F1 a commit just after UTC midnight of the created date is TOUCHED whatever the time of day", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "scripts/early.ts"), "export const early = 1;\n");
      commitAt(repo, "2020-01-01T00:00:30Z", "early file");
      writeFileSync(join(repo, "docs/prompts/20200101-early.prompt.md"), promptFile("fx-early", "ready-not-run", ["scripts/early.ts: x"]));
      commitAt(repo, null, "prompt");
      const rows = rowsOf(cli(repo, "--json", "--no-gh", "--ref", "HEAD").out);
      expect(dig(rows[0], "deliverables", 0, "paths", 0, "state")).toBe("TOUCHED");
    });
  });

  test("[integration] F7 F8 literal pathspecs and unicode names resolve exactly", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "scripts/a[1].ts"), "export const a = 1;\n");
      commitAt(repo, "2019-01-01T00:00:00Z", "old bracket file");
      writeFileSync(join(repo, "scripts/a1.ts"), "export const a1 = 1;\n");
      writeFileSync(join(repo, "scripts/café.ts"), "export const cafe = 1;\n");
      writeFileSync(join(repo, "docs/prompts/20200101-names.prompt.md"), promptFile("fx-names", "ready-not-run", ["scripts/a[1].ts: x", "scripts/café.ts: y"]));
      commitAt(repo, null, "new files and prompt");
      const rows = rowsOf(cli(repo, "--json", "--no-gh", "--ref", "HEAD").out);
      expect(dig(rows[0], "deliverables", 0, "paths", 0, "state")).toBe("UNTOUCHED");
      expect(dig(rows[0], "deliverables", 1, "paths", 0, "state")).toBe("TOUCHED");
    });
  });

  test("[integration] S2-2 git is bound to the repo root when run from a subdirectory", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "scripts/thing.ts"), "export const thing = 1;\n");
      writeFileSync(join(repo, "docs/prompts/20200101-sub.prompt.md"), promptFile("fx-sub", "ready-not-run", ["scripts/thing.ts: x"]));
      commitAt(repo, null, "files");
      const run = cli(join(repo, "scripts"), "--json", "--no-gh", "--ref", "HEAD", "--dir", "../docs/prompts");
      expect(run.code).toBe(0);
      expect(dig(rowsOf(run.out)[0], "deliverables", 0, "paths", 0, "state")).toBe("TOUCHED");
    });
  });

  test("[integration] F14 the report names the ref and the resolved commit", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "docs/prompts/20200101-a.prompt.md"), promptFile("fx-a", "ready-not-run", ["scripts/absent.ts: x"]));
      commitAt(repo, null, "prompt");
      const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout.toString().trim();
      const run = cli(repo, "--no-gh", "--ref", "HEAD");
      expect(run.out.split("\n")[0]).toBe(`ref: HEAD @ ${sha.slice(0, 12)}`);
    });
  });

  test("[integration] F6 an unresolvable ref exits 2 naming the ref", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "docs/prompts/20200101-a.prompt.md"), promptFile("fx-a", "ready-not-run", ["scripts/absent.ts: x"]));
      commitAt(repo, null, "prompt");
      const run = cli(repo, "--no-gh", "--ref", "nonesuch");
      expect(run.code).toBe(2);
      expect(run.err).toContain("nonesuch");
      expect(run.out).toBe("");
    });
  });

  test("[integration] F16 an unknown option or missing value exits 2 with usage on stderr", () => {
    withRepo((repo) => {
      const unknown = cli(repo, "--bogus");
      expect(unknown.code).toBe(2);
      expect(unknown.err).toContain("Usage");
      const missing = cli(repo, "--dir");
      expect(missing.code).toBe(2);
      expect(missing.err).toContain("--dir");
    });
  });
});
