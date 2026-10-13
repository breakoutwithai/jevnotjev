import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditPrompt, buildTree, DEFAULT_ATTRIBUTIONS, deliveringCommits, loadAttributions, parseArgs, parseAttributions, parsePrompt, parseRemoteRepo, renderReport, renderTable, validateOutput, type Flag, type Git, type OutputResult, type PromptResult } from "./prompt-audit";

const emptyResult: PromptResult = {
  stem: "x",
  file: "x",
  promptId: "p1",
  created: "2026-10-05",
  status: "ready-not-run",
  governingIssue: null,
  issue: "none",
  errors: [],
  deliverables: [],
  outputs: null,
  pathsTouched: 0,
  pathsUntouched: 0,
  pathsMissing: 0,
  evidenceCommits: [],
  dod: { checked: 0, unchecked: 0 },
  uncheckedDeliverables: 0,
  flags: [],
};

const SCRIPT = join(import.meta.dir, "prompt-audit.ts");
const CORPUS = join(import.meta.dir, "fixtures/prompt-audit/corpus");
const REPO = "acme/corpus";

function dig(value: unknown, ...keys: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const k of keys) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = Reflect.get(cur, k);
  }
  return cur;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new Error(`${what} is not a string`);
  return v;
};
const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`${what} is not a list`);
  return v;
};

function sh(repo: string, env: Record<string, string>, ...args: string[]): string {
  const base = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const run = Bun.spawnSync(["git", "-C", repo, "-c", "commit.gpgsign=false", ...args], { env: { ...process.env, ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

function commitFiles(repo: string, date: string, message: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(repo, path);
    if (content === null) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  sh(repo, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, "add", "-A");
  sh(repo, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, "commit", "-q", "--cleanup=verbatim", "-m", message);
}

function withTemp(fn: (repo: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "jnj-prompt-outputs-"));
  try {
    sh(base, {}, "init", "-q", "-b", "main");
    fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const gitFor =
  (repo: string): Git =>
  (args) => {
    const run = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
  };

const treeOf = (repo: string) => buildTree(sh(repo, {}, "ls-tree", "-r", "-z", "--name-only", "HEAD"));

function promptWith(id: string | null, created: string, outputs: unknown, status = "ready-not-run"): string {
  return `---\n${id === null ? "" : `prompt_id: ${JSON.stringify(id)}\n`}created: ${created}\nstatus: ${status}\ngoverning_issue: 191\noutputs: ${JSON.stringify(outputs)}\n---\n\n## Definition of done\n- [ ] one\n`;
}

type Step = { kind: "commit"; date: string; message: string; files: Record<string, string | null> } | { kind: "git"; args: string[]; date: string | null };
type CorpusCase = { name: string; id: string | null; created: string; outputs: { key: string }[]; rawOutputs: unknown[]; steps: Step[]; expected: Record<string, string>; shared: Record<string, string[]> };

function loadCase(file: string): CorpusCase {
  const raw: unknown = JSON.parse(readFileSync(join(CORPUS, file), "utf8"));
  const rawOutputs = list(dig(raw, "prompt", "outputs"), `${file} outputs`);
  const steps = list(dig(raw, "steps"), `${file} steps`).map((s): Step => {
    const c = dig(s, "commit");
    if (c !== undefined) {
      const files: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(dig(c, "files") ?? {})) files[k] = v === null ? null : str(v, `${file} file ${k}`);
      return { kind: "commit", date: str(dig(c, "date"), "date"), message: str(dig(c, "message"), "message"), files };
    }
    const d = dig(s, "date");
    return { kind: "git", args: list(dig(s, "git"), "git args").map((a) => str(a, "git arg")), date: d === null ? null : str(d, "date") };
  });
  const expected: Record<string, string> = {};
  for (const [k, v] of Object.entries(dig(raw, "expected") ?? {})) expected[k] = str(v, `${file} expected ${k}`);
  const shared: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(dig(raw, "expectedShared") ?? {})) shared[k] = list(v, `${file} expectedShared ${k}`).map((x) => str(x, "shared id"));
  return {
    name: str(dig(raw, "name"), "name"),
    id: dig(raw, "prompt", "id") === null ? null : str(dig(raw, "prompt", "id"), "id"),
    created: str(dig(raw, "prompt", "created"), "created"),
    outputs: rawOutputs.map((o) => ({ key: `${str(dig(o, "repo"), "repo")} ${str(dig(o, "path"), "path")}` })),
    rawOutputs,
    steps,
    expected,
    shared,
  };
}

const caseResults = (prefix: string): OutputResult[] => {
  const file = readdirSync(CORPUS).find((f) => f.startsWith(prefix));
  if (file === undefined) throw new Error(`no corpus case ${prefix}`);
  return runCase(loadCase(file));
};

function runCase(c: CorpusCase): OutputResult[] {
  let results: OutputResult[] = [];
  withTemp((repo) => {
    for (const s of c.steps) {
      if (s.kind === "commit") commitFiles(repo, s.date, s.message, s.files);
      else sh(repo, s.date === null ? {} : { GIT_AUTHOR_DATE: s.date, GIT_COMMITTER_DATE: s.date }, ...s.args);
    }
    const r = auditPrompt(`${c.name}.prompt.md`, promptWith(c.id, c.created, c.rawOutputs), treeOf(repo), gitFor(repo), "HEAD", null, REPO);
    results = r.outputs ?? [];
    // The prompt is flagged exactly when some output is INVALID-HEADER.
    expect(r.flags.includes("INVALID-HEADER"), c.name).toBe(Object.values(c.expected).includes("INVALID-HEADER"));
    expect(r.deliverables, c.name).toEqual([]);
  });
  return results;
}

describe("parsePrompt outputs", () => {
  const front = (body: string) => `---\ncreated: 2026-10-01\nprompt_id: p\n${body}\n---\nbody\n`;
  test("[unit] M1 a prompt without outputs has outputs null (legacy)", () => {
    expect(parsePrompt(front("status: draft")).outputs).toBeNull();
  });
  test("[unit] M1 reads declared outputs with repo, path and kind", () => {
    const p = parsePrompt(front("outputs:\n  - repo: acme/x\n    path: scripts/a.ts\n    kind: file\n  - repo: acme/x\n    path: src/\n    kind: dir"));
    expect(p.errors).toEqual([]);
    expect(p.outputs).toEqual([
      { repo: "acme/x", path: "scripts/a.ts", kind: "file", error: null },
      { repo: "acme/x", path: "src/", kind: "dir", error: null },
    ]);
  });
  test("[unit] M1 an empty or non-list outputs is an error", () => {
    for (const body of ["outputs: []", "outputs:", "outputs: scripts/a.ts"]) expect(parsePrompt(front(body)).errors.join("|"), body).toContain("outputs must be a non-empty list");
  });
  test("[unit] M1 an invalid entry is kept, marked, and reported under its index", () => {
    const p = parsePrompt(front("outputs:\n  - repo: acme/x\n    path: ../a.ts\n    kind: file\n  - just a string"));
    expect(p.outputs?.length).toBe(2);
    expect(p.errors.join("|")).toContain("outputs[0]: path contains ..");
    expect(p.errors.join("|")).toContain("outputs[1]: entry 1 is not a mapping");
  });
  test("[unit] M1 governing_issue none needs a governing_issue_reason", () => {
    expect(parsePrompt(front("governing_issue: none\ngoverning_issue_reason: standalone tool")).errors).toEqual([]);
    expect(parsePrompt(front("governing_issue: none")).errors.join("|")).toContain("governing_issue_reason");
  });
});

describe("validateOutput", () => {
  const good = { repo: "acme/x", path: "scripts/a.ts", kind: "file" };
  const bad: [string, unknown, string][] = [
    ["repo without owner", { ...good, repo: "x" }, "repo must be owner/name"],
    ["repo with extra segment", { ...good, repo: "a/b/c" }, "repo must be owner/name"],
    ["missing path", { ...good, path: undefined }, "path is missing"],
    ["absolute path", { ...good, path: "/etc/x" }, "not repo-relative"],
    ["home path", { ...good, path: "~/x.ts" }, "not repo-relative"],
    ["traversal", { ...good, path: "a/../b.ts" }, "contains .."],
    ["dot segment", { ...good, path: "a/./b.ts" }, "contains a . segment"],
    ["glob", { ...good, path: "scripts/*.ts" }, "glob or placeholder"],
    ["placeholder", { ...good, path: "scripts/<n>.ts" }, "glob or placeholder"],
    ["unknown kind", { ...good, kind: "pr" }, "kind must be file or dir"],
    ["dir without slash", { ...good, path: "scripts", kind: "dir" }, "must end with /"],
    ["file with slash", { ...good, path: "scripts/", kind: "file" }, "must not end with /"],
    ["empty segment", { ...good, path: "a//b.ts" }, "empty segment"],
  ];
  for (const [title, entry, message] of bad) {
    test(`[unit] M1 rejects ${title}`, () => {
      expect(validateOutput(entry, 0).error ?? "").toContain(message);
    });
  }
  test("[unit] M1 accepts a file and a dir", () => {
    expect(validateOutput(good, 0).error).toBeNull();
    expect(validateOutput({ repo: "acme/x", path: "src/mod/", kind: "dir" }, 0).error).toBeNull();
  });
});

describe("parseRemoteRepo and --repo", () => {
  test("[unit] M1 owner/name from https, ssh and ssh:// remotes", () => {
    for (const url of ["https://github.com/acme/corpus", "https://github.com/acme/corpus.git\n", "git@github.com:acme/corpus.git", "ssh://git@github.com/acme/corpus.git"]) expect(parseRemoteRepo(url), url).toBe("acme/corpus");
    expect(parseRemoteRepo("not a url")).toBeNull();
  });
  test("[unit] M1-F3 anything but the three anchored remote forms derives no repo", () => {
    for (const url of ["/Users/me/projects/corpus.git", "https://github.com/acme", "https://github.com/acme/corpus/extra", "file:///srv/acme/corpus.git", "git@github.com:corpus.git", "git@github.com:a/b/c.git", "ftp://github.com/acme/corpus", "../acme/corpus", "https://github.com/acme/corpus/"]) expect(parseRemoteRepo(url), url).toBeNull();
  });
  test("[unit] M1-F2 declared outputs without a prompt_id is an error, legacy without one is not", () => {
    const head = "---\ncreated: 2026-10-01\n";
    expect(parsePrompt(`${head}outputs:\n  - repo: acme/x\n    path: a.ts\n    kind: file\n---\n`).errors.join("|")).toContain("prompt_id is required when outputs are declared");
    expect(parsePrompt(`${head}status: draft\n---\n`).errors).toEqual([]);
  });
  test("[unit] M1-F4 the out column widens to its widest cell and rows stay under 100 characters", () => {
    const row = { stem: "y".repeat(80), status: "ready-not-run", touched: 1, checkable: 2, missing: 1, evidence: 3, flags: ["INVALID-STATUS" as const, "INVALID-HEADER" as const] };
    const out = renderTable([{ ...row, out: "100/100" }, { ...row, out: "-" }]);
    const lines = out.split("\n");
    expect(lines.every((l) => l.length < 100)).toBe(true);
    expect(lines[1]?.split(/\s+/)).toContain("100/100");
    expect(lines[0]?.split(/\s+/)).toContain("out");
  });
  test("[integration] M1-F1 deliveringCommits honours kind: file is an exact path, dir is a prefix", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "a\n\nPrompt-Id: p1", { plain: "1\n" });
      commitFiles(repo, "2026-10-06T13:00:00Z", "b\n\nPrompt-Id: p1", { "folder/child": "1\n" });
      const g = gitFor(repo);
      expect(deliveringCommits(g, "HEAD", "2026-10-05", "p1", "plain/", "dir")).toEqual([]);
      expect(deliveringCommits(g, "HEAD", "2026-10-05", "p1", "folder", "file")).toEqual([]);
      expect(deliveringCommits(g, "HEAD", "2026-10-05", "p1", "plain", "file").length).toBe(1);
      expect(deliveringCommits(g, "HEAD", "2026-10-05", "p1", "folder/", "dir").length).toBe(1);
    });
  });
  test("[unit] M1 --repo takes owner/name and rejects anything else", () => {
    const ok = parseArgs(["--repo", "acme/corpus"]);
    expect(ok.ok && ok.options.repo).toBe("acme/corpus");
    const bad = parseArgs(["--repo", "corpus"]);
    expect(bad.ok).toBe(false);
  });
});

describe("renderTable out column", () => {
  const row = { stem: "x", status: "ready-not-run", touched: 1, checkable: 2, missing: 1, evidence: 3, out: "-", flags: [] };
  test("[unit] M1 header gains out and a legacy row shows -", () => {
    const [head = "", line = ""] = renderTable([row]).split("\n");
    expect(head.split(/\s+/)).toEqual(["prompt", "status", "touched", "missing", "evid", "out", "flags"]);
    expect(line.split(/\s+/)).toEqual(["x", "ready-not-run", "1/2", "1", "3", "-"]);
  });
  test("[unit] M1 a declared row shows delivered/declared and - for the legacy columns", () => {
    const line = renderTable([{ ...row, out: "2/3" }]).split("\n")[1] ?? "";
    expect(line.split(/\s+/)).toEqual(["x", "ready-not-run", "-", "-", "3", "2/3"]);
  });
  test("[unit] M1 every row stays under 100 characters with the longest flags", () => {
    const out = renderTable([{ ...row, stem: "y".repeat(80), out: "12/12", flags: ["INVALID-STATUS", "INVALID-HEADER"] }]);
    expect(out.split("\n").every((l) => l.length < 100)).toBe(true);
  });
});

describe("corpus", () => {
  test("[integration] M1 corpus: every planted output result matches and none is silently skipped", () => {
    const files = readdirSync(CORPUS).filter((f) => f.endsWith(".json")).sort();
    expect(files.length).toBeGreaterThanOrEqual(12);
    let declared = 0;
    let compared = 0;
    const mismatches: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const c = loadCase(file);
      declared += c.outputs.length;
      const results = runCase(c);
      expect(results.length, `${c.name} result count`).toBe(c.outputs.length);
      c.outputs.forEach((o, i) => {
        const want = c.expected[o.key];
        const got = results[i];
        compared += 1;
        if (want === undefined || got === undefined || got.result !== want) mismatches.push(`${c.name}: ${o.key} expected ${want ?? "(none)"} got ${got?.result ?? "(none)"}`);
        else {
          seen.add(want);
          // Commits are listed exactly for DELIVERED outputs.
          if ((got.commits.length > 0) !== (want === "DELIVERED")) mismatches.push(`${c.name}: ${o.key} commits ${got.commits.length} for ${want}`);
          // sharedWith lists the other prompt ids on the delivering commits: only where a case plants one.
          const wantShared = c.shared[o.key] ?? [];
          if (JSON.stringify(got.sharedWith) !== JSON.stringify(wantShared)) mismatches.push(`${c.name}: ${o.key} sharedWith ${JSON.stringify(got.sharedWith)} expected ${JSON.stringify(wantShared)}`);
        }
      });
      expect(Object.keys(c.expected).length, `${c.name} expected map covers every output`).toBe(c.outputs.length);
    }
    console.log(`corpus: ${files.length} cases, compared ${compared} of ${declared} declared outputs, ${mismatches.length} mismatches`);
    expect(mismatches).toEqual([]);
    expect(compared).toBe(declared);
    expect(compared).toBeGreaterThan(0);
    expect([...seen].sort()).toEqual(["DELIVERED", "INVALID-HEADER", "NOT-DELIVERED", "OTHER-REPO"]);
  });
});

describe("deliveringCommits", () => {
  test("[integration] M1-H1 a trailer merge commit does not credit what the other side of the merge brought in", () => {
    const merged = caseResults("20-").map((r) => [r.path, r.result]);
    expect(merged).toEqual([["scripts/a.ts", "DELIVERED"], ["scripts/other.ts", "NOT-DELIVERED"]]);
    const back = caseResults("21-").map((r) => [r.path, r.result]);
    expect(back).toEqual([["scripts/a.ts", "DELIVERED"], ["scripts/other.ts", "NOT-DELIVERED"]]);
  });
  test("[unit] M1-H1 the delivering-commit log excludes merges and the changed-path read neither follows merges nor lists deletions", () => {
    const seen: string[][] = [];
    const recording: Git = (args) => {
      seen.push(args);
      return { code: 0, out: args[0] === "log" ? "deadbeef\n" : "", err: "" };
    };
    deliveringCommits(recording, "HEAD", "2026-10-05", "p1", "a.ts");
    const log = seen.find((a) => a[0] === "log") ?? [];
    const tree = seen.find((a) => a[0] === "diff-tree") ?? [];
    expect(log).toContain("--no-merges");
    expect(tree).not.toContain("-m");
    expect(tree).toContain("--diff-filter=d");
    expect(tree).toContain("--no-renames");
  });
  test("[integration] M1-H2 a trailer commit that only deletes or renames away is not delivery of the old path", () => {
    expect(caseResults("22-").map((r) => [r.path, r.result])).toEqual([["scripts/d.ts", "NOT-DELIVERED"], ["scripts/r.ts", "NOT-DELIVERED"], ["scripts/r2.ts", "DELIVERED"], ["old/", "NOT-DELIVERED"]]);
    expect(caseResults("10-").map((r) => r.result)).toEqual(["DELIVERED"]);
  });
  test("[integration] M1-H3 two prompts on one commit both deliver and each lists the other as shared", () => {
    const r = caseResults("23-");
    expect(r.map((o) => [o.result, o.sharedWith])).toEqual([["DELIVERED", ["p2"]]]);
  });
  test("[integration] M1-H4 key case and spacing are flexible, the id is exact", () => {
    expect(caseResults("24-").map((r) => [r.path, r.result])).toEqual([["scripts/a.ts", "DELIVERED"], ["scripts/b.ts", "DELIVERED"], ["scripts/c.ts", "DELIVERED"], ["scripts/d.ts", "NOT-DELIVERED"]]);
  });
  test("[unit] M1-H3 the detail line shows shared ids", () => {
    const text = renderReport([{ ...emptyResult, outputs: [{ repo: REPO, path: "a.ts", kind: "file", result: "DELIVERED", commits: ["abc"], sharedWith: ["p2", "p3"] }] }]);
    expect(text).toContain("shared: a.ts with p2, p3");
  });

  test("[integration] M1-G3 M1-G4 returns the exact full ids, newest first, only for trailer commits that touch the path", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "one\n\nPrompt-Id: p1", { "scripts/a.ts": "1\n" });
      const older = sh(repo, {}, "rev-parse", "HEAD").trim();
      commitFiles(repo, "2026-10-07T12:00:00Z", "two\n\nPrompt-Id: p1", { "scripts/a.ts": "2\n" });
      const newer = sh(repo, {}, "rev-parse", "HEAD").trim();
      commitFiles(repo, "2026-10-08T12:00:00Z", "three", { "scripts/a.ts": "3\n" });
      expect(deliveringCommits(gitFor(repo), "HEAD", "2026-10-05", "p1", "scripts/a.ts")).toEqual([newer, older]);
      expect(deliveringCommits(gitFor(repo), "HEAD", "2026-10-05", "p1", "scripts/")).toEqual([newer, older]);
    });
  });

  test("[unit] M1-G1 every git log that is parsed passes --no-show-signature", () => {
    const seen: string[][] = [];
    const recording: Git = (args) => {
      seen.push(args);
      return { code: 0, out: "", err: "" };
    };
    deliveringCommits(recording, "HEAD", "2026-10-05", "p1", "a.ts");
    const parsed = parsePrompt("---\ncreated: 2026-10-01\nprompt_id: p1\ndeliverables:\n  - scripts/a.ts\n---\n");
    expect(parsed.errors).toEqual([]);
    const tree = buildTree("scripts/a.ts\0");
    auditPrompt("x.prompt.md", "---\ncreated: 2026-10-01\nprompt_id: p1\ndeliverables:\n  - scripts/a.ts\n---\n", tree, recording, "HEAD", null);
    const logs = seen.filter((a) => a[0] === "log");
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const a of logs) expect(a, a.join(" ")).toContain("--no-show-signature");
  });

  test("[integration] M1-G1 log.showSignature=true with a signed commit does not abort or pollute the ids", () => {
    withTemp((repo) => {
      const key = join(repo, ".git", "signing-key");
      sh(repo, {}, "config", "gpg.format", "ssh");
      const gen = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key], { stdout: "pipe", stderr: "pipe" });
      expect(gen.exitCode).toBe(0);
      sh(repo, {}, "config", "user.signingkey", `${key}.pub`);
      sh(repo, {}, "config", "log.showSignature", "true");
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      writeFileSync(join(repo, "scripts-a.ts"), "1\n");
      sh(repo, { GIT_AUTHOR_DATE: "2026-10-06T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-06T12:00:00Z" }, "add", "-A");
      sh(repo, { GIT_AUTHOR_DATE: "2026-10-06T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-06T12:00:00Z" }, "-c", "commit.gpgsign=true", "commit", "-q", "-S", "-m", "signed\n\nPrompt-Id: p1");
      const head = sh(repo, {}, "rev-parse", "HEAD").trim();
      // The precondition: plain `git log` really is polluted in this setup.
      expect(sh(repo, {}, "log", "-1", "--format=%H")).not.toBe(`${head}\n`);
      expect(deliveringCommits(gitFor(repo), "HEAD", "2026-10-05", "p1", "scripts-a.ts")).toEqual([head]);
    });
  });
});

describe("prompt-audit CLI with declared outputs", () => {
  function cli(cwd: string, ...args: string[]): { code: number | null; out: string; err: string } {
    const run = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
  }
  function seed(repo: string): void {
    commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
    commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a\n\nPrompt-Id: declared", { "scripts/a.ts": "a\n", "scripts/prose.ts": "p\n" });
    mkdirSync(join(repo, "docs/prompts"), { recursive: true });
    const outputs = [
      { repo: REPO, path: "scripts/a.ts", kind: "file" },
      { repo: REPO, path: "scripts/missing.ts", kind: "file" },
      { repo: "acme/elsewhere", path: "x.ts", kind: "file" },
    ];
    // The deliverables list names scripts/prose.ts, which was touched: it must NOT be audited.
    writeFileSync(join(repo, "docs/prompts/20261005-declared.prompt.md"), promptWith("declared", "2026-10-05", outputs).replace("---\n\n", '---\n\n(deliverables: "scripts/prose.ts")\n\n'));
    writeFileSync(join(repo, "docs/prompts/20261005-legacy.prompt.md"), `---\nprompt_id: legacy\ncreated: 2026-10-05\nstatus: ready-not-run\ndeliverables:\n  - "scripts/prose.ts: legacy path"\n---\n\n## Definition of done\n- [ ] one\n`);
  }

  test("[integration] M1 table: declared prompt shows delivered/declared, legacy shows -, details list NOT-DELIVERED and OTHER-REPO", () => {
    withTemp((repo) => {
      seed(repo);
      sh(repo, {}, "remote", "add", "origin", "git@github.com:acme/corpus.git");
      const run = cli(repo, "--no-gh", "--ref", "HEAD");
      expect(run.code).toBe(0);
      expect(run.err).toBe("");
      const lines = run.out.split("\n");
      expect(lines.every((l) => l.length < 100 || l.startsWith("- "))).toBe(true);
      const row = (stem: string): string[] => (lines.find((l) => l.startsWith(stem)) ?? "").split(/\s+/);
      expect(row("20261005-declared")).toEqual(["20261005-declared", "ready-not-run", "-", "-", "1", "1/2", "STALE-STATUS"]);
      expect(row("20261005-legacy").slice(0, 6)).toEqual(["20261005-legacy", "ready-not-run", "1/1", "0", "1", "-"]);
      const detail = lines.find((l) => l.startsWith("- 20261005-declared:")) ?? "";
      expect(detail).toContain("NOT-DELIVERED: scripts/missing.ts");
      expect(detail).toContain("OTHER-REPO: acme/elsewhere:x.ts");
      expect(detail).not.toContain("TOUCHED");
      expect(detail).not.toContain("scripts/prose.ts");
    });
  });

  test("[integration] M1 --json: outputs array on a declared prompt, null on a legacy one", () => {
    withTemp((repo) => {
      seed(repo);
      const run = cli(repo, "--json", "--no-gh", "--ref", "HEAD", "--repo", REPO);
      expect(run.code).toBe(0);
      const rows: unknown = JSON.parse(run.out);
      const by = (stem: string): unknown => (Array.isArray(rows) ? rows.find((r) => dig(r, "stem") === stem) : undefined);
      expect(dig(by("20261005-legacy"), "outputs")).toBeNull();
      const outs = dig(by("20261005-declared"), "outputs");
      expect(Array.isArray(outs) && outs.map((o) => [dig(o, "path"), dig(o, "kind"), dig(o, "result"), dig(o, "commits", "length")])).toEqual([
        ["scripts/a.ts", "file", "DELIVERED", 1],
        ["scripts/missing.ts", "file", "NOT-DELIVERED", 0],
        ["x.ts", "file", "OTHER-REPO", 0],
      ]);
      expect(dig(by("20261005-declared"), "outputs", 0, "repo")).toBe(REPO);
    });
  });

  test("[integration] M1 declared outputs with no derivable repo exit 2 and name --repo", () => {
    withTemp((repo) => {
      seed(repo);
      const run = cli(repo, "--no-gh", "--ref", "HEAD");
      expect(run.code).toBe(2);
      expect(run.err).toContain("--repo owner/name");
    });
  });

  test("[integration] M1 --repo differing in case from the declared repo still matches", () => {
    withTemp((repo) => {
      seed(repo);
      const run = cli(repo, "--json", "--no-gh", "--ref", "HEAD", "--repo", "ACME/Corpus");
      expect(run.code).toBe(0);
      const rows: unknown = JSON.parse(run.out);
      const declared = Array.isArray(rows) ? rows.find((r) => dig(r, "stem") === "20261005-declared") : undefined;
      expect(dig(declared, "outputs", 0, "result")).toBe("DELIVERED");
    });
  });

  test("[unit] M1 renderReport prints no done/not-done verdict word for a declared prompt", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      const r = auditPrompt("a.prompt.md", promptWith("p", "2026-10-05", [{ repo: REPO, path: "a.ts", kind: "file" }]), treeOf(repo), gitFor(repo), "HEAD", null, REPO);
      const text = renderReport([r]);
      for (const word of ["verdict", "PARTIAL", "PATHS-DONE", "NOT-RUN"]) expect(text).not.toContain(word);
      expect(text).toContain("NOT-DELIVERED: a.ts");
    });
  });
});

describe("attribution ledger", () => {
  const OUT = [
    { repo: REPO, path: "scripts/a.ts", kind: "file" },
    { repo: REPO, path: "src/mod/", kind: "dir" },
  ];
  const head = (repo: string): string => sh(repo, {}, "rev-parse", "HEAD").trim();
  const audit = (repo: string, id: string, attributions: Record<string, string[]>, outputs: unknown[] = OUT): PromptResult => auditPrompt("a.prompt.md", promptWith(id, "2026-10-05", outputs), treeOf(repo), gitFor(repo), "HEAD", null, REPO, attributions);
  const results = (r: PromptResult): string[] => (r.outputs ?? []).map((o) => `${o.path}=${o.result}`);

  test("[unit] AT1 an attributed SHA touching a present path is DELIVERED-ATTRIBUTED, a dir via a file under it", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a, no trailer", { "scripts/a.ts": "a\n" });
      const a = head(repo);
      commitFiles(repo, "2026-10-07T12:00:00Z", "feat: mod, no trailer", { "src/mod/m.ts": "m\n" });
      const m = head(repo);
      const r = audit(repo, "old", { old: [a, m] });
      expect(results(r)).toEqual(["scripts/a.ts=DELIVERED-ATTRIBUTED", "src/mod/=DELIVERED-ATTRIBUTED"]);
      expect(r.outputs?.map((o) => o.commits)).toEqual([[a], [m]]);
      expect(r.errors).toEqual([]);
      expect(r.flags).not.toContain("INVALID-ATTRIBUTION");
    });
  });

  test("[unit] AT2 an attributed SHA touching a path later deleted is REMOVED", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a", { "scripts/a.ts": "a\n" });
      const a = head(repo);
      commitFiles(repo, "2026-10-07T12:00:00Z", "chore: drop a", { "scripts/a.ts": null });
      const r = audit(repo, "old", { old: [a] }, [OUT[0]]);
      expect(results(r)).toEqual(["scripts/a.ts=REMOVED"]);
      expect(r.outputs?.[0]?.commits).toEqual([a]);
      expect(r.errors).toEqual([]);
    });
  });

  test("[unit] AT3 a trailer commit wins: DELIVERED and the trailer commit alone, even when the ledger lists a SHA", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a", { "scripts/a.ts": "a\n" });
      const plain = head(repo);
      commitFiles(repo, "2026-10-07T12:00:00Z", "feat: a2\n\nPrompt-Id: old", { "scripts/a.ts": "a2\n" });
      const trailer = head(repo);
      const r = audit(repo, "old", { old: [plain] }, [OUT[0]]);
      expect(results(r)).toEqual(["scripts/a.ts=DELIVERED"]);
      expect(r.outputs?.[0]?.commits).toEqual([trailer]);
      expect(r.errors).toEqual([]);
    });
  });

  test("[unit] AT4 a prompt not in the ledger is audited exactly as without one", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a", { "scripts/a.ts": "a\n" });
      const a = head(repo);
      const r = audit(repo, "other", { old: [a] }, [OUT[0]]);
      expect(results(r)).toEqual(["scripts/a.ts=NOT-DELIVERED"]);
      expect(r.errors).toEqual([]);
    });
  });

  test("[unit] AT5 a ledger SHA that is a merge, predates created, or touches no declared output is not credited and is an error", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-01T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-02T12:00:00Z", "feat: early a", { "scripts/a.ts": "early\n" });
      const early = head(repo);
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: elsewhere", { "other/x.ts": "x\n" });
      const elsewhere = head(repo);
      sh(repo, {}, "switch", "-q", "-c", "side");
      commitFiles(repo, "2026-10-07T12:00:00Z", "feat: side", { "unrelated.txt": "u\n" });
      sh(repo, {}, "switch", "-q", "main");
      sh(repo, { GIT_AUTHOR_DATE: "2026-10-08T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-08T12:00:00Z" }, "merge", "-q", "--no-ff", "-m", "merge side", "side");
      const merge = head(repo);
      const r = audit(repo, "old", { old: [early, elsewhere, merge] }, [OUT[0]]);
      expect(results(r)).toEqual(["scripts/a.ts=NOT-DELIVERED"]);
      expect(r.errors).toEqual([early, elsewhere, merge].map((s) => `attribution ${s} touches no declared output on HEAD after created`));
      expect(r.flags).toContain("INVALID-ATTRIBUTION");
    });
  });

  test("[unit] AT6 one bad SHA among good ones is reported while the good ones still credit", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a", { "scripts/a.ts": "a\n" });
      const a = head(repo);
      const bogus = "0".repeat(40);
      const r = audit(repo, "old", { old: [a, bogus] }, [OUT[0]]);
      expect(results(r)).toEqual(["scripts/a.ts=DELIVERED-ATTRIBUTED"]);
      expect(r.errors).toEqual([`attribution ${bogus} touches no declared output on HEAD after created`]);
    });
  });

  test("[unit] AT7 renderReport keeps DELIVERED-ATTRIBUTED and REMOVED distinct from DELIVERED in the table and the detail", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a", { "scripts/a.ts": "a\n" });
      const a = head(repo);
      commitFiles(repo, "2026-10-07T12:00:00Z", "feat: mod\n\nPrompt-Id: old", { "src/mod/m.ts": "m\n" });
      commitFiles(repo, "2026-10-08T12:00:00Z", "feat: b", { "scripts/b.ts": "b\n" });
      const b = head(repo);
      commitFiles(repo, "2026-10-09T12:00:00Z", "chore: drop b", { "scripts/b.ts": null });
      const outs = [...OUT, { repo: REPO, path: "scripts/b.ts", kind: "file" }];
      const r = audit(repo, "old", { old: [a, b] }, outs);
      expect(results(r)).toEqual(["scripts/a.ts=DELIVERED-ATTRIBUTED", "src/mod/=DELIVERED", "scripts/b.ts=REMOVED"]);
      const text = renderReport([r]);
      expect(text).toContain("DELIVERED-ATTRIBUTED: scripts/a.ts");
      expect(text).toContain("REMOVED: scripts/b.ts");
      const row = (text.split("\n").find((l) => l.startsWith("a")) ?? "").split(/\s+/);
      expect(row).toContain("1+1/3");
    });
  });

  test("[unit] AT13 attribution respects kind: a child change does not credit a file output, a file change does not credit a dir", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: child", { "src/mod/child.ts": "c\n" });
      const child = head(repo);
      commitFiles(repo, "2026-10-07T12:00:00Z", "feat: file a", { "a.ts": "a\n" });
      const a = head(repo);
      const asFile = audit(repo, "old", { old: [child] }, [{ repo: REPO, path: "src/mod", kind: "file" }]);
      expect(results(asFile)).toEqual(["src/mod=NOT-DELIVERED"]);
      expect(asFile.errors).toEqual([`attribution ${child} touches no declared output on HEAD after created`]);
      const asDir = audit(repo, "old", { old: [a] }, [{ repo: REPO, path: "a.ts/", kind: "dir" }]);
      expect(results(asDir)).toEqual(["a.ts/=NOT-DELIVERED"]);
      expect(asDir.errors).toEqual([`attribution ${a} touches no declared output on HEAD after created`]);
    });
  });

  test("[unit] AT14 a file output replaced by a directory of that name is REMOVED, not DELIVERED-ATTRIBUTED", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a", { "a.ts": "a\n" });
      const a = head(repo);
      commitFiles(repo, "2026-10-07T12:00:00Z", "refactor: a becomes a dir", { "a.ts": null, "a.ts/child.ts": "c\n" });
      const r = audit(repo, "old", { old: [a] }, [{ repo: REPO, path: "a.ts", kind: "file" }]);
      expect(results(r)).toEqual(["a.ts=REMOVED"]);
    });
  });

  test("[unit] AT15 prompt ids named like Object.prototype members do not crash, and a __proto__ ledger key stays an own key", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a", { "a.ts": "a\n" });
      const a = head(repo);
      for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        expect(results(audit(repo, id, {}, [{ repo: REPO, path: "a.ts", kind: "file" }])), id).toEqual(["a.ts=NOT-DELIVERED"]);
      }
      const ledger = parseAttributions(`{"__proto__": ["${a}"], "constructor": ["${a}"]}`);
      expect(Object.keys(ledger).sort()).toEqual(["__proto__", "constructor"]);
      expect(results(audit(repo, "__proto__", ledger, [{ repo: REPO, path: "a.ts", kind: "file" }]))).toEqual(["a.ts=DELIVERED-ATTRIBUTED"]);
      expect(results(audit(repo, "constructor", ledger, [{ repo: REPO, path: "a.ts", kind: "file" }]))).toEqual(["a.ts=DELIVERED-ATTRIBUTED"]);
    });
  });

  test("[unit] AT16 an OTHER-REPO output suppresses the unmatched-SHA error", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a", { "a.ts": "a\n" });
      const a = head(repo);
      commitFiles(repo, "2026-10-07T12:00:00Z", "feat: other repo's file", { "x.ts": "x\n" });
      const x = head(repo);
      const r = audit(repo, "old", { old: [a, x] }, [{ repo: REPO, path: "a.ts", kind: "file" }, { repo: "acme/elsewhere", path: "x.ts", kind: "file" }]);
      expect(results(r)).toEqual(["a.ts=DELIVERED-ATTRIBUTED", "x.ts=OTHER-REPO"]);
      expect(r.errors).toEqual([]);
      expect(r.flags).not.toContain("INVALID-ATTRIBUTION");
    });
  });

  test("[unit] AT17 a long stem with INVALID-STATUS,INVALID-ATTRIBUTION keeps every table row under 100 characters", () => {
    const flags: Flag[] = ["INVALID-STATUS", "INVALID-ATTRIBUTION"];
    const rows = ["0+1/1", "-"].map((out) => ({ stem: "20261001-a-very-long-prompt-stem-name", status: "in-progress", touched: 0, checkable: 0, missing: 0, evidence: 3, out, flags }));
    for (const line of renderTable(rows).split("\n")) expect(line.length, line).toBeLessThan(100);
    expect(renderTable(rows)).toContain("INVALID-STATUS,INVALID-ATTRIBUTION");
  });

  test("[integration] AT18 a shallow clone exits 2 naming the shallow history instead of crediting its boundary commit", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a", { "a.ts": "a\n" });
      commitFiles(repo, "2026-10-07T12:00:00Z", "chore: other only", { "other.txt": "o\n" });
      const other = head(repo);
      const base = mkdtempSync(join(tmpdir(), "jnj-prompt-shallow-"));
      try {
        const clone = join(base, "clone");
        const made = Bun.spawnSync(["git", "clone", "-q", "--depth", "1", `file://${repo}`, clone], { stdout: "pipe", stderr: "pipe" });
        expect(made.exitCode).toBe(0);
        mkdirSync(join(clone, "docs/prompts"), { recursive: true });
        writeFileSync(join(clone, "docs/prompts/20261005-old.prompt.md"), promptWith("old", "2026-10-05", [{ repo: REPO, path: "a.ts", kind: "file" }]));
        writeFileSync(join(base, "ledger.json"), JSON.stringify({ old: [other] }));
        const run = Bun.spawnSync(["bun", SCRIPT, "--no-gh", "--ref", "HEAD", "--repo", REPO, "--attributions", join(base, "ledger.json")], { cwd: clone, stdout: "pipe", stderr: "pipe" });
        expect(run.stdout.toString()).not.toContain("DELIVERED-ATTRIBUTED");
        expect(run.stderr.toString()).toContain("shallow");
        expect(run.exitCode).toBe(2);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  test("[unit] AT8 parseAttributions rejects every malformed shape loudly", () => {
    const sha = "a".repeat(40);
    expect(parseAttributions(JSON.stringify({ p: [sha] }))).toEqual({ p: [sha] });
    for (const bad of ["not json", "[]", "null", '{"p": []}', '{"p": "x"}', `{"p": ["${"a".repeat(39)}"]}`, `{"p": ["${"A".repeat(40)}"]}`, `{"p": ["${sha}", 3]}`, `{"": ["${sha}"]}`]) {
      expect(() => parseAttributions(bad), bad).toThrow(/attributions/);
    }
  });

  test("[unit] AT9 loadAttributions names the file when it is missing", () => {
    expect(() => loadAttributions(join(tmpdir(), "jnj-no-such-attributions.json"))).toThrow(/attributions/);
  });

  test("[unit] AT10 the real scripts/prompt-attributions.json parses and every SHA is 40-hex", () => {
    const ledger = loadAttributions(DEFAULT_ATTRIBUTIONS);
    expect(Object.keys(ledger).sort()).toEqual(["jevnotjev-scripted-deploy-all-modules", "jnj-eliminate-python-residue", "jnj-stage-theatre-uc13-demo", "jnj-ticket-office"]);
    for (const shas of Object.values(ledger)) for (const s of shas) expect(s).toMatch(/^[0-9a-f]{40}$/);
  });

  test("[unit] AT11 parseArgs accepts --attributions <file> and rejects a missing value", () => {
    const ok = parseArgs(["--attributions", "x.json"]);
    expect(ok.ok && ok.options.attributions).toBe("x.json");
    const def = parseArgs([]);
    expect(def.ok && def.options.attributions).toBe(DEFAULT_ATTRIBUTIONS);
    expect(parseArgs(["--attributions"]).ok).toBe(false);
  });

  test("[integration] AT12 CLI: --attributions credits, --json carries the outcome, --strict exits 1 on a bad SHA, a malformed ledger exits 2", () => {
    withTemp((repo) => {
      commitFiles(repo, "2026-10-04T12:00:00Z", "init", { "README.md": "x\n" });
      commitFiles(repo, "2026-10-06T12:00:00Z", "feat: a", { "scripts/a.ts": "a\n" });
      const a = head(repo);
      mkdirSync(join(repo, "docs/prompts"), { recursive: true });
      writeFileSync(join(repo, "docs/prompts/20261005-old.prompt.md"), promptWith("old", "2026-10-05", [OUT[0]]));
      const ledger = join(repo, "ledger.json");
      const cli = (...args: string[]) => {
        const run = Bun.spawnSync(["bun", SCRIPT, "--no-gh", "--ref", "HEAD", "--repo", REPO, ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
        return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
      };
      writeFileSync(ledger, JSON.stringify({ old: [a] }));
      const good = cli("--json", "--attributions", ledger);
      expect(good.code).toBe(0);
      expect(dig(JSON.parse(good.out), 0, "outputs", 0, "result")).toBe("DELIVERED-ATTRIBUTED");
      writeFileSync(ledger, JSON.stringify({ old: [a, "f".repeat(40)] }));
      const bad = cli("--strict", "--attributions", ledger);
      expect(bad.code).toBe(1);
      expect(bad.out).toContain("INVALID-ATTRIBUTION");
      writeFileSync(ledger, "{broken");
      const broken = cli("--attributions", ledger);
      expect(broken.code).toBe(2);
      expect(broken.err).toContain("attributions");
    });
  });
});
