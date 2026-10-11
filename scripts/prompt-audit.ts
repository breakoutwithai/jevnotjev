// Prompt audit: which prompts in docs/prompts/*.prompt.md have been run, and did they deliver?
// The `status:` header is self-reported and goes stale, so this derives evidence instead: it checks
// each deliverable path against the tracked tree of a git ref (TOUCHED = changed since the prompt
// was created, UNTOUCHED = predates it and is not evidence), counts the commits on that ref that
// touch a TOUCHED deliverable or mention the prompt, and (optionally) reads the governing issue.
//
//   bun scripts/prompt-audit.ts                  table + per-prompt detail; exit 0
//   bun scripts/prompt-audit.ts --json           full structured result (a JSON array)
//   bun scripts/prompt-audit.ts --strict         exit 1 when any prompt carries a flag
//   bun scripts/prompt-audit.ts --no-gh          skip the `gh issue view` lookup (issue: unknown)
//   bun scripts/prompt-audit.ts --dir <path>     prompt directory (default docs/prompts)
//   bun scripts/prompt-audit.ts --ref <ref>      git ref the evidence is read from (default origin/main)
//
// Exit 2: bad arguments, no prompts in the directory (docs/prompts/* is gitignored, so worktrees have
// none), an unresolvable ref, or any failing git command. A git failure is never read as "no commits".
//
// The ref is resolved once to a commit SHA; the report's first line names it (`ref: <ref> @ <sha12>`).
// `created` must be a YYYY-MM-DD date and means 00:00:00 UTC of that day (`--since-as-filter`, which
// scans every commit instead of stopping at the first old one). An invalid date or governing_issue
// raises INVALID-HEADER, and an invalid date leaves that prompt's paths unresolved.
//
// A deliverable token is a path only with a directory part: a trailing `/`, a `~/` or `./` prefix, or
// a file extension on the last segment. A bare filename (`records.csv`) or a path escaping the repo is
// UNRESOLVED, and any deliverable holding an UNRESOLVED or IGNORED candidate is unchecked; a bare
// filename is never matched by basename, and an IGNORED path never counts toward delivery.
// The front matter is parsed with Bun.YAML and every field is type-checked (INVALID-HEADER).
// The verdict says what the repo evidence supports; it never claims the Definition of done is met.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, posix } from "node:path";

export type Verdict = "NOT-RUN" | "PARTIAL" | "DELIVERED" | "NO-EVIDENCE-POSSIBLE";
export type IssueState = "OPEN" | "CLOSED" | "unknown" | "none";
export type PathState = "TOUCHED" | "UNTOUCHED" | "MISSING" | "IGNORED";
export type Flag = "STALE-STATUS" | "INVALID-STATUS" | "INVALID-HEADER";

export type ParsedPrompt = {
  promptId: string | null;
  created: string | null;
  createdInvalid: boolean;
  status: string | null;
  governingIssue: number | null;
  deliverables: string[];
  errors: string[];
};

const VALID_STATUS = ["draft", "ready-not-run", "running", "done", "superseded"];

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

// YAML parses an unquoted date as a string or a Date depending on the form; both normalize to YYYY-MM-DD (UTC).
export function normalizeCreated(v: unknown): string | null {
  if (typeof v === "string") return isIsoDate(v) ? v : null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function frontMatter(text: string): string | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return end === -1 ? null : lines.slice(1, end).join("\n");
}

function stringField(data: Record<string, unknown>, key: string, errors: string[]): string | null {
  const v = data[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  errors.push(`${key} is not a string`);
  return null;
}

// The front matter goes through Bun's built-in YAML parser, then each field is type-checked.
export function parsePrompt(text: string): ParsedPrompt {
  const out: ParsedPrompt = { promptId: null, created: null, createdInvalid: false, status: null, governingIssue: null, deliverables: [], errors: [] };
  const source = frontMatter(text);
  if (source === null) {
    out.errors.push("no front matter block");
    return out;
  }
  let data: unknown;
  try {
    data = Bun.YAML.parse(source);
  } catch (e) {
    out.errors.push(`front matter is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
  if (!isRecord(data)) {
    out.errors.push("front matter is not a mapping");
    return out;
  }
  out.promptId = stringField(data, "prompt_id", out.errors);
  out.status = stringField(data, "status", out.errors);
  const created = data["created"];
  if (created !== undefined && created !== null) {
    out.created = normalizeCreated(created);
    if (out.created === null) {
      out.createdInvalid = true;
      out.errors.push(`created "${String(created)}" is not a YYYY-MM-DD date`);
    }
  }
  const issue = data["governing_issue"];
  if (issue !== undefined && issue !== null) {
    const n = typeof issue === "string" && /^[1-9]\d*$/.test(issue) ? Number(issue) : issue;
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) out.governingIssue = n;
    else out.errors.push(`governing_issue "${String(issue)}" is not a positive integer`);
  }
  const list = data["deliverables"];
  if (list !== undefined && list !== null) {
    if (Array.isArray(list) && list.every((x): x is string => typeof x === "string")) out.deliverables = list;
    else out.errors.push("deliverables is not a list of strings");
  }
  return out;
}

// Checklist items under a "Definition of done" heading, until a heading of the same or higher level.
// Fenced code is skipped: a fence closes only on the same character with at least the opening length.
export function countChecklist(text: string): { checked: number; unchecked: number } {
  let level = 0;
  let fence: { ch: string; len: number } | null = null;
  let checked = 0;
  let unchecked = 0;
  for (const line of text.split("\n")) {
    if (fence !== null) {
      const close = line.match(/^\s*(`+|~+)\s*$/)?.[1];
      if (close !== undefined && close[0] === fence.ch && close.length >= fence.len) fence = null;
      continue;
    }
    const open = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (open !== undefined) {
      fence = { ch: open[0] ?? "`", len: open.length };
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading !== null) {
      const lv = heading[1]?.length ?? 0;
      if (/^definition of done\b/i.test(heading[2] ?? "")) level = lv;
      else if (level > 0 && lv <= level) level = 0;
      continue;
    }
    if (level === 0) continue;
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]/);
    if (m?.[1] === " ") unchecked += 1;
    else if (m !== null) checked += 1;
  }
  return { checked, unchecked };
}

// A bare filename needs 2+ letters/digits after the dot (so `e.g.` is prose); inside a path 1+ is enough (.c .h .R).
const EXTENSION = /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}$/;
const BARE_EXTENSION = /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{2,10}$/;

type Token = { kind: "path"; path: string } | { kind: "unresolved"; token: string } | { kind: "reject" };

// Prose punctuation is stripped from a token, never from a backtick span. Trailing dots go too,
// except the dots of a `.` or `..` segment, which must reach the traversal check.
function cleanToken(raw: string, span: boolean): string {
  if (span) return raw.trim();
  const base = raw.replace(/^[`"'([]+/, "").replace(/[`"')\],;:]+$/, "");
  return (/(^|\/)\.{1,2}$/.test(base) ? base : base.replace(/\.+$/, "")).trim();
}

function classifyToken(raw: string, span: boolean): Token {
  const candidate = cleanToken(raw, span);
  if (candidate === "" || /[<>*{}$=|,]/.test(candidate) || candidate.startsWith("#") || candidate.startsWith("--") || candidate.includes("://")) return { kind: "reject" };
  if (!candidate.includes("/")) return BARE_EXTENSION.test(candidate) ? { kind: "unresolved", token: candidate } : { kind: "reject" };
  const home = candidate.startsWith("~/");
  const abs = candidate.startsWith("/");
  const dotLead = candidate.startsWith("./");
  const dir = candidate.endsWith("/");
  const body = home || dotLead ? candidate.slice(2) : abs ? candidate.slice(1) : candidate;
  const trimmed = dir ? body.slice(0, -1) : body;
  const segments = trimmed.split("/");
  if (trimmed === "" || segments[0] === "" || segments.at(-1) === "") return { kind: "reject" };
  if (!segments.some((s) => /[A-Za-z0-9]/.test(s))) return { kind: "reject" };
  const normalized = posix.normalize(candidate);
  // Traversal is judged first: `src/..` has no extension but still names (and escapes) a directory.
  if (!home && !abs && (normalized === "." || normalized === ".." || normalized.startsWith("../"))) return { kind: "unresolved", token: candidate };
  if (!(dir || home || dotLead || EXTENSION.test(segments.at(-1) ?? ""))) return { kind: "reject" };
  if (home) return { kind: "path", path: posix.join(homedir(), body) };
  return { kind: "path", path: normalized };
}

export type Candidates = { paths: string[]; unresolved: string[] };

// Candidate paths in one deliverable string. A backtick span is one candidate (it may hold spaces);
// everything else splits on whitespace and commas. Placeholders (<x>) and globs (*) are skipped.
export function extractCandidates(deliverable: string): Candidates {
  const paths: string[] = [];
  const unresolved: string[] = [];
  const record = (t: Token): void => {
    if (t.kind === "path" && !paths.includes(t.path)) paths.push(t.path);
    if (t.kind === "unresolved" && !unresolved.includes(t.token)) unresolved.push(t.token);
  };
  for (const part of deliverable.split(/(`[^`]*`)/)) {
    if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
      const inner = part.slice(1, -1).trim();
      const whole = classifyToken(inner, true);
      if (whole.kind !== "reject" || !/[\s,]/.test(inner)) {
        record(whole);
        continue;
      }
    }
    for (const token of part.replaceAll("`", " ").split(/[\s,]+/)) record(classifyToken(token, false));
  }
  return { paths, unresolved };
}

export function extractPaths(deliverable: string): string[] {
  return extractCandidates(deliverable).paths;
}

export function verdictFor(input: { exists: number; missing: number; evidence: number; issue: IssueState }): Verdict {
  const checkable = input.exists + input.missing;
  if (checkable === 0 && input.issue === "none") return input.evidence > 0 ? "PARTIAL" : "NO-EVIDENCE-POSSIBLE";
  if (checkable > 0 && input.missing === 0 && (input.issue === "none" || input.issue === "CLOSED")) return "DELIVERED";
  if (input.exists === 0 && input.evidence === 0) return "NOT-RUN";
  return "PARTIAL";
}

export function flagsFor(status: string | null, verdict: Verdict): Flag[] {
  if (status === null || !VALID_STATUS.includes(status)) return ["INVALID-STATUS"];
  if ((status === "ready-not-run" || status === "draft") && verdict !== "NOT-RUN" && verdict !== "NO-EVIDENCE-POSSIBLE") return ["STALE-STATUS"];
  if (status === "done" && verdict !== "DELIVERED") return ["STALE-STATUS"];
  return [];
}

export type TableRow = { stem: string; status: string | null; verdict: Verdict; touched: number; checkable: number; evidence: number; flags: Flag[] };

export function renderTable(rows: TableRow[]): string {
  const cell = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 3)}...` : s.padEnd(w));
  const head = `${cell("prompt", 34)} ${cell("status", 13)} ${cell("verdict", 20)} ${cell("touched", 7)} ${cell("evid", 4)} flags`;
  const lines = rows.map((r) => `${cell(r.stem, 34)} ${cell(r.status ?? "(none)", 13)} ${cell(r.verdict, 20)} ${cell(`${r.touched}/${r.checkable}`, 7)} ${cell(String(r.evidence), 4)} ${r.flags.join(",")}`.trimEnd());
  return [head, ...lines].join("\n");
}

export type PathResult = { path: string; state: PathState };
export type DeliverableResult = { text: string; paths: PathResult[]; unresolved: string[]; unchecked: boolean };
export type PromptResult = {
  stem: string;
  file: string;
  promptId: string | null;
  created: string | null;
  status: string | null;
  governingIssue: number | null;
  issue: IssueState;
  errors: string[];
  deliverables: DeliverableResult[];
  pathsTouched: number;
  pathsUntouched: number;
  pathsMissing: number;
  pathsIgnored: number;
  evidenceCommits: string[];
  dod: { checked: number; unchecked: number };
  verdict: Verdict;
  flags: Flag[];
};

export type GitResult = { code: number; out: string; err: string };
export type Git = (args: string[]) => GitResult;
export type IssueLookup = (n: number) => "OPEN" | "CLOSED" | "unknown";

// stdout of a git command that must succeed; a failure throws with git's own stderr.
function must(git: Git, args: string[]): string {
  const r = git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.code}): ${r.err.trim()}`);
  return r.out;
}

const literal = (p: string): string => `:(literal)${p}`;
const sinceFilter = (created: string): string => `--since-as-filter=${created}T00:00:00Z`;

export type Tree = { files: Set<string> };

// Input is `git ls-tree -r -z --name-only`: NUL-separated, so names with newlines or non-ASCII survive.
export function buildTree(lsTreeZ: string): Tree {
  return { files: new Set(lsTreeZ.split("\0").filter((l) => l !== "")) };
}

// TOUCHED: on the ref and changed since `created`. UNTOUCHED: on the ref, no commit since `created`
// (it predates the prompt, so it is no evidence the prompt ran). No `created` falls back to
// existence. Absolute paths are outside git: existence on the filesystem is all that can be known.
export function classifyPath(path: string, tree: Tree, git: Git, fsExists: (p: string) => boolean, ref: string, created: string | null): PathState {
  if (path.startsWith("/")) return fsExists(path) ? "TOUCHED" : "MISSING";
  const bare = path.replace(/\/+$/, "");
  // A trailing slash names a directory: it needs a tracked descendant, a file of that name is not one.
  const inTree = (!path.endsWith("/") && tree.files.has(bare)) || [...tree.files].some((f) => f.startsWith(`${bare}/`));
  if (!inTree) {
    // check-ignore treats names literally (and rejects pathspec magic); exit 1 means "not ignored".
    const r = git(["check-ignore", "-q", "--", path]);
    if (r.code === 0) return "IGNORED";
    if (r.code === 1) return "MISSING";
    throw new Error(`git check-ignore ${path} failed (exit ${r.code}): ${r.err.trim()}`);
  }
  if (created === null) return "TOUCHED";
  const out = must(git, ["log", ref, sinceFilter(created), "--format=%h", "--", literal(bare)]);
  return out.trim() === "" ? "UNTOUCHED" : "TOUCHED";
}

export function auditPrompt(file: string, text: string, tree: Tree, git: Git, ref: string, lookup: IssueLookup | null, fsExists: (p: string) => boolean): PromptResult {
  const stem = basename(file).replace(/\.prompt\.md$/, "").replace(/\.md$/, "");
  const parsed = parsePrompt(text);
  const createdBad = parsed.createdInvalid;
  const created = parsed.created;
  const deliverables: DeliverableResult[] = parsed.deliverables.map((d) => {
    const c = extractCandidates(d);
    // An invalid created date means "touched since" cannot be computed: nothing is classified.
    if (createdBad) return { text: d, paths: [], unresolved: [...c.paths, ...c.unresolved], unchecked: true };
    const paths = c.paths.map((path) => ({ path, state: classifyPath(path, tree, git, fsExists, ref, created) }));
    // Checked only if every candidate was classified and none was ignored: an IGNORED or UNRESOLVED
    // path can never satisfy delivery.
    return { text: d, paths, unresolved: c.unresolved, unchecked: paths.length === 0 || c.unresolved.length > 0 || paths.some((p) => p.state === "IGNORED") };
  });
  const all = deliverables.flatMap((d) => d.paths);
  const pathsTouched = all.filter((p) => p.state === "TOUCHED").length;
  const pathsUntouched = all.filter((p) => p.state === "UNTOUCHED").length;
  const pathsMissing = all.filter((p) => p.state === "MISSING").length;
  const pathsIgnored = all.filter((p) => p.state === "IGNORED").length;
  const commits = new Set<string>();
  const repoPaths = all.filter((p) => p.state === "TOUCHED" && !p.path.startsWith("/")).map((p) => literal(p.path.replace(/\/+$/, "")));
  if (repoPaths.length > 0) {
    const since = created === null ? [] : [sinceFilter(created)];
    for (const h of must(git, ["log", ref, ...since, "--format=%h", "--", ...repoPaths]).split("\n")) if (h !== "") commits.add(h);
  }
  const needles = [parsed.promptId, stem].filter((n): n is string => n !== null && n !== "");
  // With no needle the query would be an unfiltered `git log`: skip it.
  if (needles.length > 0) for (const h of must(git, ["log", ref, "--fixed-strings", ...needles.map((n) => `--grep=${n}`), "--format=%h"]).split("\n")) if (h !== "") commits.add(h);
  let issue: IssueState = "none";
  if (parsed.governingIssue !== null) issue = lookup === null ? "unknown" : lookup(parsed.governingIssue);
  const verdict = verdictFor({ exists: pathsTouched, missing: pathsMissing + pathsUntouched, evidence: commits.size, issue });
  const flags = flagsFor(parsed.status, verdict);
  if (parsed.errors.length > 0) flags.push("INVALID-HEADER");
  return {
    stem,
    file,
    promptId: parsed.promptId,
    created: parsed.created,
    status: parsed.status,
    governingIssue: parsed.governingIssue,
    issue,
    errors: parsed.errors,
    deliverables,
    pathsTouched,
    pathsUntouched,
    pathsMissing,
    pathsIgnored,
    evidenceCommits: [...commits],
    dod: countChecklist(text),
    verdict,
    flags,
  };
}

export function renderReport(results: PromptResult[], refLine: string | null = null): string {
  const table = renderTable(
    results.map((r) => ({ stem: r.stem, status: r.status, verdict: r.verdict, touched: r.pathsTouched, checkable: r.pathsTouched + r.pathsUntouched + r.pathsMissing, evidence: r.evidenceCommits.length, flags: r.flags })),
  );
  const bullets = results.map((r) => {
    const paths = r.deliverables.flatMap((d) => d.paths);
    const list = (state: PathState): string => {
      const found = paths.filter((p) => p.state === state).map((p) => p.path);
      return found.length === 0 ? "none" : found.join(", ");
    };
    const unresolved = r.deliverables.flatMap((d) => d.unresolved);
    const parts = [
      `issue: ${r.governingIssue === null ? "none" : `#${r.governingIssue} ${r.issue}`}`,
      `DoD: ${r.dod.checked} checked, ${r.dod.unchecked} unchecked (unverified)`,
      `unchecked deliverables: ${r.deliverables.filter((d) => d.unchecked).length}`,
      `MISSING: ${list("MISSING")}`,
      `UNTOUCHED: ${list("UNTOUCHED")}`,
    ];
    if (unresolved.length > 0) parts.push(`UNRESOLVED: ${unresolved.join(", ")}`);
    if (r.pathsIgnored > 0) parts.push(`IGNORED: ${list("IGNORED")}`);
    if (r.errors.length > 0) parts.push(`ERRORS: ${r.errors.join("; ")}`);
    return `- ${r.stem}: ${parts.join(" | ")}`;
  });
  return `${refLine === null ? "" : `${refLine}\n`}${table}\n\n${bullets.join("\n")}`;
}

export type Options = { dir: string; ref: string; json: boolean; strict: boolean; noGh: boolean; help: boolean };
export type ParsedArgs = { ok: true; options: Options } | { ok: false; error: string };

export const USAGE = "Usage: bun scripts/prompt-audit.ts [--dir <path>] [--ref <ref>] [--json] [--strict] [--no-gh] [--help]";

export function parseArgs(args: string[]): ParsedArgs {
  const options: Options = { dir: "docs/prompts", ref: "origin/main", json: false, strict: false, noGh: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") options.json = true;
    else if (a === "--strict") options.strict = true;
    else if (a === "--no-gh") options.noGh = true;
    else if (a === "--help" || a === "-h") options.help = true;
    else if (a === "--dir" || a === "--ref") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return { ok: false, error: `missing value for ${a}` };
      if (a === "--dir") options.dir = v;
      else options.ref = v;
      i += 1;
    } else return { ok: false, error: a.startsWith("-") ? `unknown option ${a}` : `unexpected argument ${a}` };
  }
  return { ok: true, options };
}

// Every git call is bound to the repository root, whatever directory the script runs from.
function gitAt(root: string | null): Git {
  return (args) => {
    const run = Bun.spawnSync(["git", ...(root === null ? [] : ["-C", root]), ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
  };
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

function run(o: Options): number {
  let files: string[] = [];
  try {
    files = readdirSync(o.dir).filter((f) => f.endsWith(".prompt.md")).sort();
  } catch {
    files = [];
  }
  if (files.length === 0) {
    console.error(`no prompts in ${o.dir}`);
    return 2;
  }
  const git = gitAt(gitAt(null)(["rev-parse", "--show-toplevel"]).out.trim() || null);
  const sha = must(git, ["rev-parse", "--verify", `${o.ref}^{commit}`]).trim();
  const tree = buildTree(must(git, ["ls-tree", "-r", "-z", "--name-only", sha]));
  const lookup = o.noGh ? null : realIssueLookup;
  const results = files.map((f) => auditPrompt(join(o.dir, f), readFileSync(join(o.dir, f), "utf8"), tree, git, sha, lookup, existsSync));
  console.log(o.json ? JSON.stringify(results, null, 2) : renderReport(results, `ref: ${o.ref} @ ${sha.slice(0, 12)}`));
  return o.strict && results.some((r) => r.flags.length > 0) ? 1 : 0;
}

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`prompt-audit: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  if (parsed.options.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    return run(parsed.options);
  } catch (e) {
    console.error(`prompt-audit: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
