// Prompt audit: which prompts in docs/prompts/*.prompt.md have been run, and did they deliver?
// The `status:` header is self-reported and goes stale, so this derives evidence instead: it checks
// each deliverable path against the tracked tree of a git ref, counts the commits on that ref that
// touch an existing deliverable or mention the prompt, and (optionally) reads the governing issue.
//
//   bun scripts/prompt-audit.ts                  table + MISSING paths per prompt; exit 0
//   bun scripts/prompt-audit.ts --json           full structured result
//   bun scripts/prompt-audit.ts --strict         exit 1 when any STALE-STATUS or INVALID-STATUS flag is present
//   bun scripts/prompt-audit.ts --no-gh          skip the `gh issue view` lookup (issue: unknown)
//   bun scripts/prompt-audit.ts --dir <path>     prompt directory (default docs/prompts)
//   bun scripts/prompt-audit.ts --ref <ref>      git ref the evidence is read from (default origin/main)
//
// Git commands run in the current directory. The verdict says what the repo evidence supports; it
// never claims the Definition of done is met, only how many checklist items still need verifying.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type Verdict = "NOT-RUN" | "PARTIAL" | "DELIVERED" | "NO-EVIDENCE-POSSIBLE";
export type IssueState = "OPEN" | "CLOSED" | "unknown" | "none";
export type PathState = "EXISTS" | "MISSING" | "IGNORED";
export type Flag = "STALE-STATUS" | "INVALID-STATUS";

export type ParsedPrompt = {
  promptId: string | null;
  created: string | null;
  status: string | null;
  governingIssue: number | null;
  deliverables: string[];
};

const VALID_STATUS = ["draft", "ready-not-run", "running", "done", "superseded"];

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1).replaceAll('\\"', '"');
  return v;
}

function frontMatterLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return [];
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return end === -1 ? [] : lines.slice(1, end);
}

// Only the keys the audit needs: top-level scalars and the deliverables list. No YAML dependency.
export function parsePrompt(text: string): ParsedPrompt {
  const scalars = new Map<string, string>();
  const deliverables: string[] = [];
  let inDeliverables = false;
  for (const line of frontMatterLines(text)) {
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (top !== null) {
      inDeliverables = top[1] === "deliverables";
      if (top[2] !== undefined && top[1] !== undefined && top[2].trim() !== "") scalars.set(top[1], unquote(top[2]));
      continue;
    }
    if (!inDeliverables) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item?.[1] !== undefined) deliverables.push(unquote(item[1]));
  }
  const issue = scalars.get("governing_issue");
  return {
    promptId: scalars.get("prompt_id") ?? null,
    created: scalars.get("created") ?? null,
    status: scalars.get("status") ?? null,
    governingIssue: issue !== undefined && /^\d+$/.test(issue) ? Number(issue) : null,
    deliverables,
  };
}

// Checklist items under "## Definition of done", up to the next "## " heading.
export function countChecklist(text: string): { checked: number; unchecked: number } {
  let inSection = false;
  let checked = 0;
  let unchecked = 0;
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) inSection = /^##\s+definition of done\b/i.test(line);
    else if (inSection) {
      const m = line.match(/^\s*[-*]\s+\[([ xX])\]/);
      if (m?.[1] === " ") unchecked += 1;
      else if (m !== null) checked += 1;
    }
  }
  return { checked, unchecked };
}

const EXTENSION = /\.[a-z][a-z0-9]{1,4}$/;

// Candidate paths in one deliverable string: whitespace/comma separated tokens with a trailing
// slash, a file extension, or a ~/ prefix. Placeholders (<x>) and globs (*) are skipped; ~/ expands.
export function extractPaths(deliverable: string): string[] {
  const out: string[] = [];
  for (const raw of deliverable.split(/[\s,]+/)) {
    const candidate = raw.replace(/^[`"'([]+/, "").replace(/[`"')\],;:]+$/, "").replace(/\.+$/, "");
    if (candidate === "" || /[<>*{}$=]/.test(candidate) || candidate.startsWith("#") || candidate.startsWith("--") || candidate.includes("://")) continue;
    const dir = candidate.endsWith("/");
    const home = candidate.startsWith("~/");
    const ok = home || dir || EXTENSION.test(candidate);
    if (!ok) continue;
    const resolved = home ? join(homedir(), candidate.slice(2)) : candidate;
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

export function verdictFor(input: { exists: number; missing: number; evidence: number; issue: IssueState }): Verdict {
  const checkable = input.exists + input.missing;
  if (checkable === 0 && input.issue === "none") return "NO-EVIDENCE-POSSIBLE";
  if (checkable > 0 && input.missing === 0 && (input.issue === "none" || input.issue === "CLOSED")) return "DELIVERED";
  if (input.exists === 0 && input.evidence === 0) return "NOT-RUN";
  return "PARTIAL";
}

export function flagsFor(status: string | null, verdict: Verdict): Flag[] {
  if (status === null || !VALID_STATUS.includes(status)) return ["INVALID-STATUS"];
  if ((status === "ready-not-run" || status === "draft") && verdict !== "NOT-RUN") return ["STALE-STATUS"];
  if (status === "done" && verdict !== "DELIVERED") return ["STALE-STATUS"];
  return [];
}

export type TableRow = { stem: string; status: string | null; verdict: Verdict; exists: number; checkable: number; evidence: number; flags: Flag[] };

export function renderTable(rows: TableRow[]): string {
  const cell = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 3)}...` : s.padEnd(w));
  const head = `${cell("prompt", 34)} ${cell("status", 13)} ${cell("verdict", 20)} ${cell("paths", 5)} ${cell("evid", 4)} flags`;
  const lines = rows.map((r) => `${cell(r.stem, 34)} ${cell(r.status ?? "(none)", 13)} ${cell(r.verdict, 20)} ${cell(`${r.exists}/${r.checkable}`, 5)} ${cell(String(r.evidence), 4)} ${r.flags.join(",")}`.trimEnd());
  return [head, ...lines].join("\n");
}

export type PathResult = { path: string; state: PathState };
export type DeliverableResult = { text: string; paths: PathResult[]; unchecked: boolean };
export type PromptResult = {
  stem: string;
  file: string;
  promptId: string | null;
  created: string | null;
  status: string | null;
  governingIssue: number | null;
  issue: IssueState;
  deliverables: DeliverableResult[];
  pathsExist: number;
  pathsMissing: number;
  pathsIgnored: number;
  evidenceCommits: string[];
  dod: { checked: number; unchecked: number };
  verdict: Verdict;
  flags: Flag[];
};

export type Git = (args: string[]) => { ok: boolean; out: string };
export type IssueLookup = (n: number) => "OPEN" | "CLOSED" | "unknown";

export type Tree = { files: Set<string>; basenames: Set<string> };

export function buildTree(lsTreeOutput: string): Tree {
  const files = new Set(lsTreeOutput.split("\n").filter((l) => l !== ""));
  return { files, basenames: new Set([...files].map((f) => basename(f))) };
}

export function classifyPath(path: string, tree: Tree, git: Git, fsExists: (p: string) => boolean): PathState {
  if (path.startsWith("/")) return fsExists(path) ? "EXISTS" : "MISSING";
  const bare = path.replace(/\/+$/, "");
  const found = tree.files.has(bare) || [...tree.files].some((f) => f.startsWith(`${bare}/`)) || (!bare.includes("/") && tree.basenames.has(bare));
  if (found) return "EXISTS";
  return git(["check-ignore", "-q", "--", path]).ok ? "IGNORED" : "MISSING";
}

export function auditPrompt(file: string, text: string, tree: Tree, git: Git, ref: string, lookup: IssueLookup | null, fsExists: (p: string) => boolean): PromptResult {
  const stem = basename(file).replace(/\.prompt\.md$/, "").replace(/\.md$/, "");
  const parsed = parsePrompt(text);
  const deliverables: DeliverableResult[] = parsed.deliverables.map((d) => {
    const paths = extractPaths(d).map((path) => ({ path, state: classifyPath(path, tree, git, fsExists) }));
    return { text: d, paths, unchecked: paths.length === 0 };
  });
  const all = deliverables.flatMap((d) => d.paths);
  const pathsExist = all.filter((p) => p.state === "EXISTS").length;
  const pathsMissing = all.filter((p) => p.state === "MISSING").length;
  const pathsIgnored = all.filter((p) => p.state === "IGNORED").length;
  const commits = new Set<string>();
  const since = parsed.created === null ? [] : [`--since=${parsed.created}`];
  const repoPaths = all.filter((p) => p.state === "EXISTS" && !p.path.startsWith("/")).map((p) => p.path);
  if (repoPaths.length > 0) for (const h of git(["log", ref, ...since, "--format=%h", "--", ...repoPaths]).out.split("\n")) if (h !== "") commits.add(h);
  const needles = [parsed.promptId, stem].filter((n): n is string => n !== null && n !== "");
  if (needles.length > 0) for (const h of git(["log", ref, "--fixed-strings", ...needles.map((n) => `--grep=${n}`), "--format=%h"]).out.split("\n")) if (h !== "") commits.add(h);
  let issue: IssueState = "none";
  if (parsed.governingIssue !== null) issue = lookup === null ? "unknown" : lookup(parsed.governingIssue);
  const verdict = verdictFor({ exists: pathsExist, missing: pathsMissing, evidence: commits.size, issue });
  return {
    stem,
    file,
    promptId: parsed.promptId,
    created: parsed.created,
    status: parsed.status,
    governingIssue: parsed.governingIssue,
    issue,
    deliverables,
    pathsExist,
    pathsMissing,
    pathsIgnored,
    evidenceCommits: [...commits],
    dod: countChecklist(text),
    verdict,
    flags: flagsFor(parsed.status, verdict),
  };
}

export function renderReport(results: PromptResult[]): string {
  const table = renderTable(
    results.map((r) => ({ stem: r.stem, status: r.status, verdict: r.verdict, exists: r.pathsExist, checkable: r.pathsExist + r.pathsMissing, evidence: r.evidenceCommits.length, flags: r.flags })),
  );
  const bullets = results.map((r) => {
    const missing = r.deliverables.flatMap((d) => d.paths).filter((p) => p.state === "MISSING").map((p) => p.path);
    const ignored = r.deliverables.flatMap((d) => d.paths).filter((p) => p.state === "IGNORED").map((p) => p.path);
    const unchecked = r.deliverables.filter((d) => d.unchecked).length;
    const parts = [
      `issue: ${r.governingIssue === null ? "none" : `#${r.governingIssue} ${r.issue}`}`,
      `DoD: ${r.dod.checked} checked, ${r.dod.unchecked} unchecked (unverified)`,
      `unchecked deliverables: ${unchecked}`,
      `MISSING: ${missing.length === 0 ? "none" : missing.join(", ")}`,
    ];
    if (ignored.length > 0) parts.push(`IGNORED: ${ignored.join(", ")}`);
    return `- ${r.stem}: ${parts.join(" | ")}`;
  });
  return `${table}\n\n${bullets.join("\n")}`;
}

function realGit(args: string[]): { ok: boolean; out: string } {
  const run = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.exitCode === 0, out: run.stdout.toString() };
}

// A failed or unparseable lookup is `unknown`, never closed.
function realIssueLookup(n: number): "OPEN" | "CLOSED" | "unknown" {
  try {
    const run = Bun.spawnSync(["gh", "issue", "view", String(n), "--json", "state"], { stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) return "unknown";
    const parsed: unknown = JSON.parse(run.stdout.toString());
    const state = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "state") : undefined;
    return state === "OPEN" || state === "CLOSED" ? state : "unknown";
  } catch {
    return "unknown";
  }
}

function option(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  const v = i === -1 ? undefined : args[i + 1];
  return v === undefined ? fallback : v;
}

function main(args: string[]): number {
  const dir = option(args, "--dir", "docs/prompts");
  const ref = option(args, "--ref", "origin/main");
  const lsTree = realGit(["ls-tree", "-r", "--name-only", ref]);
  if (!lsTree.ok) {
    console.error(`prompt-audit: git ls-tree ${ref} failed (run from a git checkout that has ${ref})`);
    return 2;
  }
  const tree = buildTree(lsTree.out);
  const lookup = args.includes("--no-gh") ? null : realIssueLookup;
  const files = readdirSync(dir).filter((f) => f.endsWith(".prompt.md")).sort();
  const results = files.map((f) => auditPrompt(join(dir, f), readFileSync(join(dir, f), "utf8"), tree, realGit, ref, lookup, existsSync));
  console.log(args.includes("--json") ? JSON.stringify(results, null, 2) : renderReport(results));
  return args.includes("--strict") && results.some((r) => r.flags.length > 0) ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
