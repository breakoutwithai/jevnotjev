import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditPrompt,
  buildTree,
  classifyPath,
  countChecklist,
  extractCandidates,
  flagsFor,
  isIsoDate,
  normalizeCreated,
  parseArgs,
  parsePrompt,
  renderTable,
  type Git,
} from "./prompt-audit";

const extractPaths = (s: string): string[] => extractCandidates(s).paths;

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
// `created` is required, so tests about other fields start from a valid one.
const ok = (body: string) => front(`created: 2026-10-01\n${body}`);

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
    const p = parsePrompt("---\nprompt_id: a\ncreated: 2026-10-01\ndeliverables:\n  - >-\n    text\n    ---\n    more\nstatus: draft\n---\nbody\n");
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
    const p = parsePrompt(ok('deliverables:\n  - "scripts/caf\\u00e9.ts: x"\n  - \'it\'\'s/a.ts\'\n  - >-\n    scripts/long.ts: first\n    second'));
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
    const p = parsePrompt(ok("governing_issue: 99999999999999999999"));
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
      const p = parsePrompt(ok(`governing_issue: ${bad}`));
      expect(p.governingIssue).toBeNull();
      expect(p.errors.length).toBe(1);
      expect(p.errors[0]).toContain("governing_issue");
    }
  });
  test("[unit] F4 an empty or null governing_issue is simply absent", () => {
    expect(parsePrompt(ok("governing_issue:")).errors).toEqual([]);
    expect(parsePrompt(ok("governing_issue: null # none")).errors).toEqual([]);
  });
  test("[unit] G3 created is required: absent or null is an error", () => {
    expect(parsePrompt(front("status: draft")).errors[0]).toContain("created");
    expect(parsePrompt(front("created:\nstatus: draft")).errors[0]).toContain("created");
    expect(parsePrompt(front("status: draft")).created).toBeNull();
  });
  test("[unit] F1 created must be a real YYYY-MM-DD date", () => {
    expect(parsePrompt(front("created: 2026-13-45")).errors[0]).toContain("created");
    expect(parsePrompt(front("created: 10/01/2026")).errors[0]).toContain("created");
    expect(isIsoDate("2026-10-01")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-1-1")).toBe(false);
  });
  test("[unit] F5 indentless block sequence is read", () => {
    const p = parsePrompt(ok('deliverables:\n- a/b.ts\n- "c/d.ts: two"\nscope:\n- not.me'));
    expect(p.deliverables).toEqual(["a/b.ts", "c/d.ts: two"]);
    expect(p.errors).toEqual([]);
  });
  test("[unit] Y9 an unquoted `path: description` item is a YAML mapping and is reported, not guessed at", () => {
    const p = parsePrompt(ok("deliverables:\n- a/b.ts: one"));
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
  test("[unit] G1 globs and placeholders stay as unresolved candidates instead of vanishing", () => {
    expect(extractCandidates("scripts/new.ts + scripts/missing/*.ts")).toEqual({ paths: ["scripts/new.ts"], unresolved: ["scripts/missing/*.ts"] });
    expect(extractCandidates("scripts/new.ts docs/runs/<date>/report.md")).toEqual({ paths: ["scripts/new.ts"], unresolved: ["docs/runs/<date>/report.md"] });
    expect(extractCandidates("scripts/a?.ts and docs/[id]/page.tsx")).toEqual({ paths: [], unresolved: ["scripts/a?.ts", "docs/[id]/page.tsx"] });
    expect(extractCandidates("docs/product/runs/<date>-uc14/: docs/records.csv")).toEqual({ paths: ["docs/records.csv"], unresolved: ["docs/product/runs/<date>-uc14/"] });
  });
  test("[unit] G1 a trailing question mark is prose, not a glob", () => {
    expect(extractCandidates("is it in scripts/new.ts?")).toEqual({ paths: ["scripts/new.ts"], unresolved: [] });
  });
  test("[unit] G2 absolute and ~/ paths are unresolved, never expanded or checked", () => {
    expect(extractCandidates("~/.agents/skills/pr-status/SKILL.md (revised)")).toEqual({ paths: [], unresolved: ["~/.agents/skills/pr-status/SKILL.md"] });
    expect(extractCandidates("/etc/hosts.conf and ~/.agents/skills/pr-status/scripts/*.test.ts")).toEqual({
      paths: [],
      unresolved: ["/etc/hosts.conf", "~/.agents/skills/pr-status/scripts/*.test.ts"],
    });
  });
  test("[unit] G9 extensionless absolute and ~ paths are unresolved, decided before the extension filter", () => {
    expect(extractCandidates("/etc/hosts and ~/bin and ~/.config/x")).toEqual({ paths: [], unresolved: ["/etc/hosts", "~/bin", "~/.config/x"] });
    expect(extractCandidates("see / and ~/ and //")).toEqual({ paths: [], unresolved: [] });
  });
  // Changed by G10: a slash word used to be dropped as prose; it is now an UNRESOLVED candidate.
  test("[unit] G10 org/repo names and abbreviations are never paths, and no longer vanish", () => {
    expect(extractCandidates("one PR on breakoutwithai/jevnotjev, e.g. with the rule 10 gate evidence")).toEqual({ paths: [], unresolved: ["breakoutwithai/jevnotjev"] });
  });
  test("[unit] G10 and/or is UNRESOLVED, not dropped", () => {
    expect(extractCandidates("and/or")).toEqual({ paths: [], unresolved: ["and/or"] });
  });
  test("[unit] G10 an extensionless backtick path next to a touched path is UNRESOLVED", () => {
    expect(extractCandidates("scripts/new.ts + `scripts/run`")).toEqual({ paths: ["scripts/new.ts"], unresolved: ["scripts/run"] });
    // Changed by S2: `bun test` was split into "bun" and "test"; a span with whitespace is one candidate now.
    expect(extractCandidates("scripts/new.ts and `bun test` and `x`")).toEqual({ paths: ["scripts/new.ts"], unresolved: ["bun test", "x"] });
  });
  test("[unit] G10 property: no token containing a slash is ever dropped", () => {
    const tokens = [
      "and/or", "yes/no", "Python/branches", "scripts/bin", "docs/README", "src/core", "a/b", "(see/this)", "docs/notes;", "v1.2/x",
      "a.b/c.d", "документы/план", "文档/说明", "café/menu", "x/y!", "x/y?", "TODO/FIXME:", "foo/bar,",
      "[a/b]", "'quoted/path'", '"dq/path"', ".hidden/dir", "..hidden/x", "a/b/c/d/e", "node_modules/foo", "bin/run.sh", "Makefile/x",
      "a-b/c_d", "r&d/budget", "50/50", "w/o", "I/O", "24/7", "a//b", "a/", "/usr", "~/x",
      // G11: punctuation-only tokens are not separators, so they are UNRESOLVED too.
      "**/*", "-/-", "@/", "*/", "?/", "[]/", "<>/", "{}/", "$/", "+/+", "#/",
    ];
    for (const t of tokens) {
      const c = extractCandidates(`scripts/new.ts ${t}`);
      expect(c.paths.length + c.unresolved.length, t).toBe(2);
    }
  });
  // Changed by G11: `-/-` was in this list; only tokens made of `/`, `~` and `.` are dropped now.
  test("[unit] G10 a token of only slashes, tildes and dots is still dropped", () => {
    for (const t of ["/", "//", "~/", "./", "/.", "///"]) expect(extractCandidates(`see ${t}`), t).toEqual({ paths: [], unresolved: [] });
  });
  test("[unit] G11 glob and punctuation-only tokens are UNRESOLVED, backticked or not", () => {
    expect(extractCandidates("scripts/new.ts + `**/*`")).toEqual({ paths: ["scripts/new.ts"], unresolved: ["**/*"] });
    expect(extractCandidates("scripts/new.ts + **/*")).toEqual({ paths: ["scripts/new.ts"], unresolved: ["**/*"] });
    expect(extractCandidates("scripts/new.ts `-/-`")).toEqual({ paths: ["scripts/new.ts"], unresolved: ["-/-"] });
    expect(extractCandidates("scripts/new.ts -/-")).toEqual({ paths: ["scripts/new.ts"], unresolved: ["-/-"] });
    expect(extractCandidates("scripts/new.ts `*`")).toEqual({ paths: ["scripts/new.ts"], unresolved: ["*"] });
    for (const t of ["?", "[]", "<>", "{}", "$x", "#", "@/"]) expect(extractCandidates(`scripts/new.ts \`${t}\``), t).toEqual({ paths: ["scripts/new.ts"], unresolved: [t] });
    // Changed by S2: a span without whitespace is never split, so `{a,b}/` stays whole.
    expect(extractCandidates("scripts/new.ts `{a,b}/`")).toEqual({ paths: ["scripts/new.ts"], unresolved: ["{a,b}/"] });
    expect(extractCandidates("scripts/new.ts {a,b}/").unresolved.length).toBeGreaterThan(0);
  });
  test("[unit] duplicates collapse", () => {
    expect(extractPaths("a/b.ts and a/b.ts")).toEqual(["a/b.ts"]);
  });
  test("[unit] F2 a bare filename is unresolved, never a path", () => {
    expect(extractCandidates("records.csv: the table")).toEqual({ paths: [], unresolved: ["records.csv"] });
  });
  test("[unit] F2 a placeholder directory prefix leaves the bare filename unresolved", () => {
    expect(extractCandidates("docs/runs/<date>-target/: records.csv")).toEqual({ paths: [], unresolved: ["docs/runs/<date>-target/", "records.csv"] });
  });
  // Changed by G10: slash prose is UNRESOLVED (reported unchecked); bare separators are still dropped.
  test("[unit] F3 separators are dropped and slash prose is unresolved, never a path", () => {
    expect(extractCandidates("see / and/or yes/no Python/branches // ~/ ./ a//")).toEqual({ paths: [], unresolved: ["and/or", "yes/no", "Python/branches", "a//"] });
  });
  test("[unit] F3 a plain directory token is still a path", () => {
    expect(extractPaths("src/core/ and a/")).toEqual(["src/core/", "a/"]);
  });
  // Changed by S2: a span with whitespace used to be one path (F9); it is now one UNRESOLVED candidate.
  test("[unit] F9 S2 a backtick span with spaces is one UNRESOLVED candidate, never a path", () => {
    expect(extractCandidates("`docs/My Notes/plan v2.md` and site/")).toEqual({ paths: ["site/"], unresolved: ["docs/My Notes/plan v2.md"] });
  });
  // Changed by S2: this span used to be split into two paths; it is now one UNRESOLVED candidate.
  test("[unit] F9 S2 a backtick span listing several paths is not split into checkable paths", () => {
    expect(extractCandidates("`a/b.ts, c/d.ts`")).toEqual({ paths: [], unresolved: ["a/b.ts, c/d.ts"] });
  });
  test("[unit] S2 a backtick span joining two paths is one UNRESOLVED candidate", () => {
    expect(extractCandidates("`scripts/a.ts + scripts/b.ts`")).toEqual({ paths: [], unresolved: ["scripts/a.ts + scripts/b.ts"] });
    expect(extractCandidates("`scripts/a.ts scripts/b.ts`")).toEqual({ paths: [], unresolved: ["scripts/a.ts scripts/b.ts"] });
    expect(extractCandidates("`scripts/a.ts,scripts/b.ts`").paths).toEqual([]);
  });
  test("[unit] F10 ./ and // are normalized", () => {
    expect(extractPaths("./src/x.ts and a//b.ts and ./docs/ and a/./b.ts")).toEqual(["src/x.ts", "a/b.ts", "docs/"]);
  });
  test("[unit] F10 a path escaping the repo is unresolved", () => {
    expect(extractCandidates("../x/y.ts and src/../../z.ts")).toEqual({ paths: [], unresolved: ["../x/y.ts", "src/../../z.ts"] });
  });
});

// Changed by V1: the verdict concept is gone. STALE-STATUS is one rule: a draft or ready-not-run
// prompt with evidence commits or a TOUCHED path. `done` and `running` are never flagged.
describe("flagsFor", () => {
  test("[unit] V1 draft or ready-not-run with an evidence commit or a TOUCHED path is STALE-STATUS", () => {
    for (const status of ["draft", "ready-not-run"]) {
      expect(flagsFor(status, 1, 0), status).toEqual(["STALE-STATUS"]);
      expect(flagsFor(status, 0, 1), status).toEqual(["STALE-STATUS"]);
      expect(flagsFor(status, 5, 3), status).toEqual(["STALE-STATUS"]);
    }
  });
  test("[unit] V1 draft or ready-not-run with no evidence and no TOUCHED path is not flagged, whatever is MISSING", () => {
    for (const status of ["draft", "ready-not-run"]) expect(flagsFor(status, 0, 0), status).toEqual([]);
  });
  test("[unit] V1 done and running are never flagged, with or without evidence", () => {
    for (const status of ["done", "running", "superseded"]) for (const [e, t] of [[0, 0], [3, 0], [0, 2], [4, 4]] as const) expect(flagsFor(status, e, t), `${status} ${e} ${t}`).toEqual([]);
  });
  test("[unit] a status outside the allowed set is INVALID-STATUS", () => {
    expect(flagsFor("in-progress", 3, 3)).toEqual(["INVALID-STATUS"]);
    expect(flagsFor(null, 0, 0)).toEqual(["INVALID-STATUS"]);
  });
});

describe("renderTable", () => {
  const row = { stem: "x".repeat(80), status: "ready-not-run", touched: 1, checkable: 2, missing: 1, evidence: 3, flags: ["STALE-STATUS" as const] };
  test("[unit] V1 columns are prompt, status, touched, missing, evid, flags and there is no verdict column", () => {
    const [head = "", line = ""] = renderTable([row]).split("\n");
    expect(head.split(/\s+/)).toEqual(["prompt", "status", "touched", "missing", "evid", "flags"]);
    expect(line).toContain("1/2");
    expect(line).toContain("STALE-STATUS");
  });
  test("[unit] truncates a long stem and every row stays under 100 characters", () => {
    const out = renderTable([row, { ...row, status: "in-progress", touched: 11, checkable: 13, missing: 12, evidence: 120, flags: ["INVALID-STATUS", "INVALID-HEADER"] }]);
    expect(out.split("\n").every((l) => l.length < 100)).toBe(true);
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
  test("[unit] exists with commits since created is TOUCHED", () => {
    expect(classifyPath("scripts/new.ts", tree, git, "origin/main", "2026-10-01")).toBe("TOUCHED");
  });
  test("[unit] exists with no commits since created is UNTOUCHED", () => {
    expect(classifyPath("src/core/calc.ts", tree, git, "origin/main", "2026-10-01")).toBe("UNTOUCHED");
    expect(classifyPath("site/", tree, git, "origin/main", "2026-10-01")).toBe("UNTOUCHED");
  });
  // Changed by S6: R3-4 asserted `git check-ignore` was never consulted. It is now, for paths absent
  // from the tree, because a path in a gitignored folder must not read as "never created".
  test("[unit] S6 an absent path is MISSING on check-ignore exit 1, IGNORED on 0, UNKNOWN (no throw) otherwise", () => {
    const calls: string[][] = [];
    const by = (code: number): Git => (args) => {
      calls.push(args);
      return { code: args[0] === "check-ignore" ? code : 0, out: "", err: code === 128 ? "fatal: pathspec is beyond a symbolic link" : "" };
    };
    expect(classifyPath("nope/x.ts", tree, by(1), "origin/main", "2026-10-01")).toBe("MISSING");
    expect(classifyPath("_reference/run/", tree, by(0), "origin/main", "2026-10-01")).toBe("IGNORED");
    expect(classifyPath("link/x.ts", tree, by(128), "origin/main", "2026-10-01")).toBe("UNKNOWN");
    expect(calls[0]).toEqual(["check-ignore", "-q", "--no-index", "--", "nope/x.ts"]);
  });
  test("[unit] S6 a path present in the tree never asks check-ignore", () => {
    const { calls, git: g } = recorder("");
    classifyPath("scripts/new.ts", tree, g, "origin/main", "2026-10-01");
    expect(calls.some((c) => c[0] === "check-ignore")).toBe(false);
  });
  test("[unit] F1 the since filter is UTC midnight of the date and never the time-of-day --since", () => {
    const { calls, git: g } = recorder("abc1234\n");
    classifyPath("scripts/new.ts", tree, g, "origin/main", "2026-10-01");
    const log = calls.find((c) => c[0] === "log") ?? [];
    expect(log).toContain("--since-as-filter=2026-10-01T00:00:00Z");
    expect(log.some((a) => a.startsWith("--since="))).toBe(false);
  });
  test("[unit] F6 a failing git log throws with its stderr instead of reading as empty", () => {
    const failing: Git = (args) => (args[0] === "log" ? { code: 128, out: "", err: "fatal: bad object" } : { code: 1, out: "", err: "" });
    expect(() => classifyPath("scripts/new.ts", tree, failing, "origin/main", "2026-10-01")).toThrow("fatal: bad object");
  });
  test("[unit] S2-13 a trailing-slash path needs a tracked descendant, not a file of that name", () => {
    const t = buildTree("docs/notes\0docs/real/a.md\0");
    // Changed by S6: this mock answered every call with exit 0, which is now "ignored" for check-ignore.
    const always: Git = (args) => ({ code: args[0] === "check-ignore" ? 1 : 0, out: "abc1234\n", err: "" });
    expect(classifyPath("docs/notes/", t, always, "origin/main", "2026-10-01")).toBe("MISSING");
    expect(classifyPath("docs/real/", t, always, "origin/main", "2026-10-01")).toBe("TOUCHED");
    expect(classifyPath("docs/notes", t, always, "origin/main", "2026-10-01")).toBe("TOUCHED");
  });
  // Changed by S3: G4 made a directory TOUCHED only by an ADDED file (--diff-filter=A). That reported
  // a false absence for a run that only edited existing files under it, so any change under it counts now.
  test("[unit] S3 any change under a directory since created makes it TOUCHED, not only an added file", () => {
    const t = buildTree("docs/real/a.md\0scripts/new.ts\0");
    const calls: string[][] = [];
    const changed: Git = (args) => {
      calls.push(args);
      return { code: 0, out: "abc1234\n", err: "" };
    };
    expect(classifyPath("docs/real/", t, changed, "origin/main", "2026-10-01")).toBe("TOUCHED");
    expect(calls[0]).toContain("--since-as-filter=2026-10-01T00:00:00Z");
    expect(calls.flat().some((a) => a.startsWith("--diff-filter"))).toBe(false);
    const unchanged: Git = () => ({ code: 0, out: "", err: "" });
    expect(classifyPath("docs/real/", t, unchanged, "origin/main", "2026-10-01")).toBe("UNTOUCHED");
    expect(classifyPath("scripts/new.ts", t, changed, "origin/main", "2026-10-01")).toBe("TOUCHED");
  });
  test("[unit] S7 every path-history query is run with --full-history", () => {
    const { calls, git: g } = recorder("abc1234\n");
    classifyPath("scripts/new.ts", tree, g, "origin/main", "2026-10-01");
    auditPrompt("x.prompt.md", `---\nprompt_id: p\ncreated: 2026-10-01\nstatus: draft\ndeliverables:\n  - "scripts/new.ts: x"\n---\n`, buildTree("scripts/new.ts\0"), g, "sha", null);
    const pathLogs = calls.filter((c) => c[0] === "log" && c.includes("--"));
    expect(pathLogs.length).toBeGreaterThanOrEqual(2);
    for (const c of pathLogs) expect(c).toContain("--full-history");
  });
  test("[unit] F7 log pathspecs are literal", () => {
    const { calls, git: g } = recorder("abc1234\n");
    classifyPath("scripts/new.ts", tree, g, "origin/main", "2026-10-01");
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
  const prompt = (items: string[], extra = "created: 2026-10-01\nstatus: ready-not-run") => `---\nprompt_id: p\n${extra}\ndeliverables:\n${items.map((i) => `  - "${i}"`).join("\n")}\n---\n`;
  test("[unit] F2 a bare filename never matches an unrelated tracked file", () => {
    const { git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["calc.ts: the calculator"]), tree, git, "sha", null);
    expect(r.pathsTouched).toBe(0);
    expect(r.pathsMissing).toBe(0);
    expect(r.deliverables[0]?.unresolved).toEqual(["calc.ts"]);
    expect(r.deliverables[0]?.unchecked).toBe(true);
  });
  test("[unit] F11 evidence queries use the same normalized, literal path as classification", () => {
    const { calls, git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["./scripts/new.ts: x"]), tree, git, "sha", null);
    expect(r.deliverables[0]?.paths).toEqual([{ path: "scripts/new.ts", state: "TOUCHED" }]);
    const specs = calls.filter((c) => c[0] === "log" && c.includes("--")).map((c) => c.slice(c.indexOf("--") + 1));
    expect(specs.length).toBeGreaterThan(1);
    for (const spec of specs) expect(spec).toEqual([":(literal)scripts/new.ts"]);
  });
  test("[unit] F1 an invalid created date is reported and no path is classified against it", () => {
    const { calls, git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["scripts/new.ts: x"], "created: 2026-13-45\nstatus: ready-not-run"), tree, git, "sha", null);
    expect(r.errors[0]).toContain("created");
    expect(r.flags).toContain("INVALID-HEADER");
    expect(r.pathsTouched).toBe(0);
    expect(r.deliverables[0]?.unresolved).toEqual(["scripts/new.ts"]);
    expect(calls.some((c) => c.some((a) => a.startsWith("--since")))).toBe(false);
  });
  test("[unit] F4 a bad governing_issue raises INVALID-HEADER", () => {
    const { git } = recorder("");
    const r = auditPrompt("x.prompt.md", prompt(["scripts/new.ts: x"], "created: 2026-10-01\nstatus: ready-not-run\ngoverning_issue: soon"), tree, git, "sha", null);
    expect(r.flags).toContain("INVALID-HEADER");
    expect(r.errors[0]).toContain("governing_issue");
  });
  test("[unit] G10 an extensionless path, backticked or not, next to a touched path is reported unchecked", () => {
    const { git } = recorder("abc1234\n");
    for (const [item, extra] of [["scripts/new.ts + `scripts/run`", "scripts/run"], ["scripts/new.ts and scripts/bin", "scripts/bin"]] as const) {
      const r = auditPrompt("x.prompt.md", prompt([item]), tree, git, "sha", null);
      expect(r.pathsTouched).toBe(1);
      expect(r.deliverables[0]?.unresolved).toEqual([extra]);
      expect(r.deliverables[0]?.unchecked).toBe(true);
    }
  });
  test("[unit] G11 a glob-only backtick token next to a touched path is reported unchecked", () => {
    const { git } = recorder("abc1234\n");
    for (const item of ["scripts/new.ts + `**/*`", "scripts/new.ts + `*`", "scripts/new.ts and -/-"]) {
      const r = auditPrompt("x.prompt.md", prompt([item]), tree, git, "sha", null);
      expect(r.pathsTouched, item).toBe(1);
      expect(r.deliverables[0]?.unchecked, item).toBe(true);
    }
  });
  // Changed by S6: this S2-1/R3-4 test expected a git-excluded path to be plain MISSING with no
  // check-ignore call. check-ignore now runs, and exit 0 gives IGNORED (unchecked).
  test("[unit] S6 an ignored path is IGNORED and unchecked", () => {
    const git: Git = (args) => ({ code: 0, out: "", err: args[0] === "check-ignore" ? "" : "" });
    const r = auditPrompt("x.prompt.md", prompt([".persona-swarm/report.md: x"]), tree, git, "sha", null);
    expect(r.deliverables[0]?.paths).toEqual([{ path: ".persona-swarm/report.md", state: "IGNORED" }]);
    expect(r.pathsTouched).toBe(0);
    expect(r.pathsMissing).toBe(0);
    expect(r.deliverables[0]?.unchecked).toBe(true);
  });
  test("[unit] S6 a check-ignore failure lists the path as UNRESOLVED and does not abort", () => {
    const git: Git = (args) => (args[0] === "check-ignore" ? { code: 128, out: "", err: "fatal: beyond a symbolic link" } : { code: 0, out: "", err: "" });
    const r = auditPrompt("x.prompt.md", prompt(["link/x.ts: x"]), tree, git, "sha", null);
    expect(r.deliverables[0]?.paths).toEqual([]);
    expect(r.deliverables[0]?.unresolved).toEqual(["link/x.ts"]);
  });
  test("[unit] S2-1 a path in neither the tree nor an ignore rule is plain MISSING", () => {
    const { git } = recorder("");
    const r = auditPrompt("x.prompt.md", prompt([".persona-swarm/report.md: x"]), tree, git, "sha", null);
    expect(r.deliverables[0]?.paths).toEqual([{ path: ".persona-swarm/report.md", state: "MISSING" }]);
    expect(r.pathsTouched).toBe(0);
  });
  test("[unit] R3-1 a prose deliverable with no path is reported unchecked even when every path is touched", () => {
    const { git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["scripts/new.ts: x", "one PR with the gate evidence"]), tree, git, "sha", null);
    expect(r.pathsTouched).toBe(1);
    expect(r.deliverables[1]?.unchecked).toBe(true);
  });
  test("[unit] R3-8 a backtick filename containing a comma is split and stays conservative", () => {
    const commaTree = buildTree("docs/a, b.md\0");
    const { git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["`docs/a, b.md`: x"]), commaTree, git, "sha", null);
    expect(r.deliverables[0]?.unchecked).toBe(true);
  });
  test("[unit] R3-3 a prompt_id with a newline or no content never reaches a --grep argument", () => {
    for (const id of ['"a\\nb"', '""', '"   "']) {
      const { calls, git } = recorder("");
      const r = auditPrompt("x.prompt.md", `---\nprompt_id: ${id}\nstatus: draft\n---\n`, tree, git, "sha", null);
      expect(r.flags).toContain("INVALID-HEADER");
      expect(calls.flatMap((c) => c).some((a) => a.startsWith("--grep=") && (a.includes("\n") || a === "--grep="))).toBe(false);
    }
  });
  test("[unit] R3-3 a file stem with a newline is not used as a --grep needle", () => {
    const { calls, git } = recorder("");
    auditPrompt("a\nb.prompt.md", "---\nstatus: draft\n---\n", tree, git, "sha", null);
    expect(calls.some((c) => c[0] === "log")).toBe(false);
  });
  test("[unit] S2-12 a deliverable with any unresolved or ignored candidate is unchecked", () => {
    const { git } = recorder("");
    const r = auditPrompt("x.prompt.md", prompt(["scripts/new.ts and records.csv: x"]), tree, git, "sha", null);
    expect(r.deliverables[0]?.paths.length).toBe(1);
    expect(r.deliverables[0]?.unresolved).toEqual(["records.csv"]);
    expect(r.deliverables[0]?.unchecked).toBe(true);
    const ok = auditPrompt("x.prompt.md", prompt(["scripts/new.ts: x"]), tree, git, "sha", null);
    expect(ok.deliverables[0]?.unchecked).toBe(false);
  });
  test("[unit] S2-3 with no prompt id and no stem the message query is skipped, never an unfiltered log", () => {
    const { calls, git } = recorder("abc1234\n");
    const r = auditPrompt(".prompt.md", "---\nstatus: draft\n---\n", tree, git, "sha", null);
    expect(calls.some((c) => c[0] === "log")).toBe(false);
    expect(r.evidenceCommits).toEqual([]);
  });
  test("[unit] G1 a glob next to a touched path is reported unchecked", () => {
    const { git } = recorder("abc1234\n");
    for (const item of ["scripts/new.ts + scripts/missing/*.ts", "scripts/new.ts docs/runs/<date>/report.md"]) {
      const r = auditPrompt("x.prompt.md", prompt([item]), tree, git, "sha", null);
      expect(r.pathsTouched).toBe(1);
      expect(r.deliverables[0]?.unchecked).toBe(true);
    }
  });
  test("[unit] G2 absolute and home paths are never classified or read from the filesystem", () => {
    const { calls, git } = recorder("abc1234\n");
    const r = auditPrompt("x.prompt.md", prompt(["~/.agents/skills/x/SKILL.md: y", "/etc/hosts.conf: z"]), tree, git, "sha", null);
    expect(r.pathsTouched).toBe(0);
    expect(r.deliverables.map((d) => d.unresolved)).toEqual([["~/.agents/skills/x/SKILL.md"], ["/etc/hosts.conf"]]);
    expect(calls.some((c) => c.includes("--") && c.some((a) => a.includes("SKILL.md") || a.includes("hosts.conf")))).toBe(false);
  });
  test("[unit] G9 an extensionless absolute or ~ path next to a touched repo path is reported unchecked", () => {
    const { git } = recorder("abc1234\n");
    for (const extra of ["/etc/hosts", "~/bin", "~/.config/x"]) {
      const r = auditPrompt("x.prompt.md", prompt([`scripts/new.ts + ${extra}`]), tree, git, "sha", null);
      expect(r.pathsTouched).toBe(1);
      expect(r.deliverables[0]?.unresolved).toEqual([extra]);
      expect(r.deliverables[0]?.unchecked).toBe(true);
    }
  });
  test("[unit] G3 a missing created date leaves every path unresolved and raises INVALID-HEADER", () => {
    const { calls, git } = recorder("abc1234\n");
    const text = '---\nprompt_id: p\nstatus: draft\ndeliverables:\n  - "scripts/new.ts: x"\n---\n';
    const r = auditPrompt("x.prompt.md", text, tree, git, "sha", null);
    expect(r.errors[0]).toContain("created");
    expect(r.flags).toContain("INVALID-HEADER");
    expect(r.pathsTouched).toBe(0);
    expect(r.deliverables[0]?.unresolved).toEqual(["scripts/new.ts"]);
    expect(calls.some((c) => c[0] === "log")).toBe(false);
  });
  test("[unit] G7 the message-evidence query is bounded by created too", () => {
    const { calls, git } = recorder("abc1234\n");
    auditPrompt("x.prompt.md", prompt(["site/: x"]), tree, git, "sha", null);
    const grep = calls.find((c) => c.some((a) => a.startsWith("--grep=")));
    expect(grep).toContain("--since-as-filter=2026-10-01T00:00:00Z");
  });
  test("[unit] F6 a failing evidence grep throws", () => {
    // Changed by S5: the other calls used to return code 1; a MISSING path now also runs `git log`,
    // which would have thrown first, so only the grep fails here.
    const failing: Git = (args) => (args.some((a) => a.startsWith("--grep=")) ? { code: 128, out: "", err: "fatal: grep boom" } : { code: args[0] === "check-ignore" ? 1 : 0, out: "", err: "" });
    expect(() => auditPrompt("x.prompt.md", prompt(["site/: x"]), tree, failing, "sha", null)).toThrow("grep boom");
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

  function evidenceRepo(repo: string): void {
    writeFileSync(join(repo, "scripts/old.ts"), "export const old = 1;\n");
    commitAt(repo, "2019-01-01T00:00:00Z", "old file");
    writeFileSync(join(repo, "scripts/thing.ts"), "export const thing = 1;\n");
    const put = (stem: string, status: string, items: string[]) => writeFileSync(join(repo, `docs/prompts/${stem}.prompt.md`), promptFile(`fx-${stem}`, status, items));
    put("20200101-worked", "ready-not-run", ["scripts/thing.ts: the thing"]);
    put("20200101-absent", "ready-not-run", ["scripts/absent.ts: never built"]);
    put("20200101-donemixed", "done", ["scripts/thing.ts: x", "scripts/absent.ts: y"]);
    put("20200101-donemissing", "done", ["scripts/absent.ts: only a missing path"]);
    put("20200101-untouched", "ready-not-run", ["scripts/old.ts: pre-existing"]);
    put("20200101-donetouched", "done", ["scripts/thing.ts: the thing"]);
    commitAt(repo, null, "add fixtures");
  }

  test("[integration] V1 --no-gh reports evidence per prompt and flags only a stale draft or ready-not-run", () => {
    withRepo((repo) => {
      evidenceRepo(repo);
      const run = cli(repo, "--json", "--no-gh", "--ref", "HEAD");
      expect(run.code).toBe(0);
      const rows = rowsOf(run.out);
      expect(rows.length).toBe(6);
      const by = (stem: string): unknown => rows.find((r) => dig(r, "stem") === stem);
      const evidenceOf = (stem: string): number => {
        const e = dig(by(stem), "evidenceCommits");
        return Array.isArray(e) ? e.length : -1;
      };
      expect(dig(by("20200101-worked"), "pathsTouched")).toBe(1);
      expect(evidenceOf("20200101-worked")).toBeGreaterThanOrEqual(1);
      expect(dig(by("20200101-worked"), "flags")).toEqual(["STALE-STATUS"]);
      // (c) ready-not-run, zero evidence, a MISSING path: no flag.
      expect(dig(by("20200101-absent"), "pathsMissing")).toBe(1);
      expect(evidenceOf("20200101-absent")).toBe(0);
      expect(dig(by("20200101-absent"), "flags")).toEqual([]);
      // (b) done is never flagged: with a MISSING path and zero evidence, or with touched paths.
      expect(dig(by("20200101-donemissing"), "pathsMissing")).toBe(1);
      expect(evidenceOf("20200101-donemissing")).toBe(0);
      for (const stem of ["20200101-donemissing", "20200101-donemixed", "20200101-donetouched"]) expect(dig(by(stem), "flags"), stem).toEqual([]);
      expect(dig(by("20200101-untouched"), "pathsUntouched")).toBe(1);
      expect(dig(by("20200101-untouched"), "flags")).toEqual([]);
      const strict = cli(repo, "--no-gh", "--ref", "HEAD", "--strict");
      expect(strict.code).toBe(1);
      expect(strict.out).toContain("STALE-STATUS");
    });
  });

  test("[integration] V1 a MISSING path is listed for a human, not turned into a flag", () => {
    withRepo((repo) => {
      evidenceRepo(repo);
      const text = cli(repo, "--no-gh", "--ref", "HEAD").out;
      const line = text.split("\n").find((l) => l.startsWith("- 20200101-absent:")) ?? "";
      expect(line).toContain("MISSING: scripts/absent.ts");
      expect(text).toContain("UNTOUCHED: scripts/old.ts");
    });
  });

  test("[integration] V1 no output, table or JSON, contains a verdict word", () => {
    withRepo((repo) => {
      evidenceRepo(repo);
      for (const args of [[], ["--json"]]) {
        const out = cli(repo, "--no-gh", "--ref", "HEAD", ...args).out;
        for (const word of ["NOT-RUN", "PARTIAL", "PATHS-DONE", "DELIVERED", "NO-EVIDENCE-POSSIBLE"]) expect(out, `${word} ${args.join("")}`).not.toContain(word);
        expect(out).not.toContain("verdict");
      }
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
      // A backslash is an escape in a non-literal pathspec: `a\b.ts` would match the file `ab.ts`.
      writeFileSync(join(repo, "scripts/a\\b.ts"), "export const a = 1;\n");
      commitAt(repo, "2019-01-01T00:00:00Z", "old backslash file");
      writeFileSync(join(repo, "scripts/ab.ts"), "export const ab = 1;\n");
      writeFileSync(join(repo, "scripts/café.ts"), "export const cafe = 1;\n");
      writeFileSync(join(repo, "docs/prompts/20200101-names.prompt.md"), promptFile("fx-names", "ready-not-run", ["scripts/a\\\\b.ts: x", "scripts/café.ts: y"]));
      commitAt(repo, null, "new files and prompt");
      const rows = rowsOf(cli(repo, "--json", "--no-gh", "--ref", "HEAD").out);
      expect(dig(rows[0], "deliverables", 0, "paths", 0, "state")).toBe("UNTOUCHED");
      expect(dig(rows[0], "deliverables", 1, "paths", 0, "state")).toBe("TOUCHED");
    });
  });

  test("[integration] S7 a deliverable added and deleted on a merged branch is not hidden by history simplification", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "README.md"), "base\n");
      commitAt(repo, null, "base");
      git(repo, "checkout", "-q", "-b", "feat");
      writeFileSync(join(repo, "scripts/ghost.ts"), "export const ghost = 1;\n");
      commitAt(repo, null, "branch adds the deliverable");
      git(repo, "rm", "-q", "scripts/ghost.ts");
      commitAt(repo, null, "branch deletes it again");
      git(repo, "checkout", "-q", "main");
      writeFileSync(join(repo, "other.txt"), "unrelated\n");
      commitAt(repo, null, "unrelated main commit");
      git(repo, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
      writeFileSync(join(repo, "docs/prompts/20200101-ghost.prompt.md"), promptFile("fx-ghost", "ready-not-run", ["scripts/ghost.ts: x"]));
      commitAt(repo, null, "prompt");
      const row = rowsOf(cli(repo, "--json", "--no-gh", "--ref", "HEAD").out)[0];
      expect(dig(row, "deliverables", 0, "paths", 0, "state")).toBe("MISSING");
      const evidence = dig(row, "evidenceCommits");
      expect(Array.isArray(evidence) ? evidence.length : 0).toBeGreaterThanOrEqual(2);
    });
  });

  test("[integration] S5 a file added after created and later deleted or renamed is MISSING but its history counts as evidence", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "scripts/gone.ts"), "export const gone = 1;\n");
      writeFileSync(join(repo, "scripts/old-name.ts"), "export const moved = 1;\n");
      commitAt(repo, null, "add both after created");
      git(repo, "rm", "-q", "scripts/gone.ts");
      git(repo, "mv", "scripts/old-name.ts", "scripts/new-name.ts");
      writeFileSync(join(repo, "docs/prompts/20200101-deleted.prompt.md"), promptFile("fx-deleted", "done", ["scripts/gone.ts: x"]));
      writeFileSync(join(repo, "docs/prompts/20200101-renamed.prompt.md"), promptFile("fx-renamed", "ready-not-run", ["scripts/old-name.ts: y"]));
      writeFileSync(join(repo, "docs/prompts/20200101-never.prompt.md"), promptFile("fx-never", "ready-not-run", ["scripts/never-existed.ts: z"]));
      commitAt(repo, null, "delete one, rename the other");
      const rows = rowsOf(cli(repo, "--json", "--no-gh", "--ref", "HEAD").out);
      const row = (stem: string): unknown => rows.find((r) => dig(r, "stem") === stem);
      for (const stem of ["20200101-deleted", "20200101-renamed"]) {
        expect(dig(row(stem), "deliverables", 0, "paths", 0, "state"), stem).toBe("MISSING");
        const evidence = dig(row(stem), "evidenceCommits");
        expect(Array.isArray(evidence) ? evidence.length : 0, stem).toBeGreaterThanOrEqual(2);
      }
      // `done` on a deleted deliverable is not contradicted: the work happened.
      expect(dig(row("20200101-deleted"), "flags")).toEqual([]);
      expect(dig(row("20200101-never"), "evidenceCommits")).toEqual([]);
    });
  });

  test("[integration] S6 a deliverable in a gitignored folder is IGNORED and unchecked", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, ".gitignore"), "_reference/\n");
      mkdirSync(join(repo, "_reference/run"), { recursive: true });
      writeFileSync(join(repo, "_reference/run/out.json"), "{}\n");
      writeFileSync(join(repo, "docs/prompts/20200101-ign.prompt.md"), promptFile("fx-ign", "ready-not-run", ["_reference/run/: outputs", "scripts/nothing-here.ts: y"]));
      commitAt(repo, null, "gitignore and prompt");
      const run = cli(repo, "--json", "--no-gh", "--ref", "HEAD");
      expect(run.code).toBe(0);
      const row = rowsOf(run.out)[0];
      expect(dig(row, "deliverables", 0, "paths", 0, "state")).toBe("IGNORED");
      expect(dig(row, "deliverables", 0, "unchecked")).toBe(true);
      expect(dig(row, "deliverables", 1, "paths", 0, "state")).toBe("MISSING");
      expect(cli(repo, "--no-gh", "--ref", "HEAD").out).toContain("IGNORED: _reference/run/");
    });
  });

  test("[integration] S6 a path beyond a symlink makes check-ignore fail, which is reported and does not abort", () => {
    withRepo((repo) => {
      mkdirSync(join(repo, "real"), { recursive: true });
      writeFileSync(join(repo, "real/a.ts"), "export const a = 1;\n");
      symlinkSync("real", join(repo, "link"));
      writeFileSync(join(repo, "docs/prompts/20200101-sym.prompt.md"), promptFile("fx-sym", "ready-not-run", ["link/x.ts: via symlink"]));
      commitAt(repo, null, "symlink and prompt");
      const run = cli(repo, "--json", "--no-gh", "--ref", "HEAD");
      expect(run.code).toBe(0);
      const row = rowsOf(run.out)[0];
      expect(dig(row, "deliverables", 0, "unresolved")).toEqual(["link/x.ts"]);
    });
  });

  test("[integration] S2 one backtick span naming two committed files is unchecked", () => {
    withRepo((repo) => {
      writeFileSync(join(repo, "scripts/a.ts"), "export const a = 1;\n");
      writeFileSync(join(repo, "scripts/b.ts"), "export const b = 1;\n");
      writeFileSync(join(repo, "docs/prompts/20200101-span.prompt.md"), promptFile("fx-span", "ready-not-run", ["`scripts/a.ts + scripts/b.ts`: both"]));
      commitAt(repo, null, "both files after created");
      const row = rowsOf(cli(repo, "--json", "--no-gh", "--ref", "HEAD").out)[0];
      expect(dig(row, "deliverables", 0, "unchecked")).toBe(true);
      expect(dig(row, "deliverables", 0, "paths")).toEqual([]);
      expect(dig(row, "deliverables", 0, "unresolved")).toEqual(["scripts/a.ts + scripts/b.ts"]);
    });
  });

  // Changed by S3: the G4 integration test expected an edit to an old file to leave the directory
  // UNTOUCHED; an edit now counts, and only a directory nobody changed stays UNTOUCHED.
  test("[integration] S3 a directory is TOUCHED by an edit or an addition, UNTOUCHED only when unchanged", () => {
    withRepo((repo) => {
      mkdirSync(join(repo, "area1"), { recursive: true });
      mkdirSync(join(repo, "area3"), { recursive: true });
      writeFileSync(join(repo, "area1/old.md"), "old\n");
      writeFileSync(join(repo, "area3/old.md"), "old\n");
      commitAt(repo, "2019-01-01T00:00:00Z", "old dirs");
      writeFileSync(join(repo, "area1/old.md"), "edited\n");
      mkdirSync(join(repo, "area2"), { recursive: true });
      writeFileSync(join(repo, "area2/new.md"), "new\n");
      writeFileSync(join(repo, "docs/prompts/20200101-dirs.prompt.md"), promptFile("fx-dirs", "ready-not-run", ["area1/: x", "area2/: y", "area3/: z"]));
      commitAt(repo, null, "edit one dir, add to another, leave a third");
      const rows = rowsOf(cli(repo, "--json", "--no-gh", "--ref", "HEAD").out);
      expect(dig(rows[0], "deliverables", 0, "paths", 0, "state")).toBe("TOUCHED");
      expect(dig(rows[0], "deliverables", 1, "paths", 0, "state")).toBe("TOUCHED");
      expect(dig(rows[0], "deliverables", 2, "paths", 0, "state")).toBe("UNTOUCHED");
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
