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
// Path extraction never drops silently. A token containing a `/`, or inside a backtick span, is
// either a checkable repo path (a trailing `/`, a `./` prefix, or a file extension on the last
// segment) or an UNRESOLVED candidate: extensionless `scripts/bin`, `and/or`, a bare filename
// (`records.csv`), a path escaping the repo, globs, `<placeholders>`, and absolute or `~/` paths
// (outside the pinned repo there is no history to pin). Only a bare word, or a token made of
// `/`, `~` and `.` alone (`/`, `//`, `~/`, `./`), is dropped as prose; `**/*`, `-/-` and `*` are kept.
// A deliverable with no path or any UNRESOLVED candidate is unchecked, and one
// unchecked deliverable blocks PATHS-DONE. A path absent from the pinned tree is MISSING (no
// .gitignore lookup). A file is TOUCHED when any commit changed it since `created`; a directory only
// when a file under it was ADDED since then.
// The front matter is parsed with Bun.YAML and every field is type-checked (INVALID-HEADER);
// `created` is required. The Definition of done is counted from Bun.markdown's rendering of the body.
// Limitation: a backtick span naming a file with a comma in its name is split, so it stays UNRESOLVED.
//
// Verdicts:
//   PATHS-DONE  every extracted path is TOUCHED since `created`, no candidate is UNRESOLVED, and the
//               governing issue is CLOSED or absent. Prose deliverables and the Definition of done
//               are NOT verified: it is a floor on what the repo shows, not a claim the work is done.
//   NOT-RUN     at least one checkable path, none TOUCHED, no evidence commit, no unchecked
//               deliverable, and the issue not CLOSED.
//   PARTIAL     some evidence (a TOUCHED path, an evidence commit or a CLOSED issue), not PATHS-DONE.
//   NO-EVIDENCE-POSSIBLE  nothing touched and no evidence commit or CLOSED issue, but the audit
//               cannot say "not run": no checkable path, or an unchecked deliverable may hold the work.
// STALE-STATUS: ready-not-run/draft with evidence of work, or `done` without PATHS-DONE.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";

export type Verdict = "NOT-RUN" | "PARTIAL" | "PATHS-DONE" | "NO-EVIDENCE-POSSIBLE";
export type IssueState = "OPEN" | "CLOSED" | "unknown" | "none";
export type PathState = "TOUCHED" | "UNTOUCHED" | "MISSING";
export type Flag = "STALE-STATUS" | "INVALID-STATUS" | "INVALID-HEADER";

export type ParsedPrompt = {
  promptId: string | null;
  created: string | null;
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

// The block opens and closes only on a line that is exactly `---` at column 0.
function splitFrontMatter(text: string): { source: string | null; body: string } {
  const lines = text.split(/\r?\n/);
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  return end === -1 ? { source: null, body: text } : { source: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
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
  const out: ParsedPrompt = { promptId: null, created: null, status: null, governingIssue: null, deliverables: [], errors: [] };
  const { source } = splitFrontMatter(text);
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
  const id = stringField(data, "prompt_id", out.errors)?.trim();
  if (id !== undefined) {
    if (id === "" || /[\r\n]/.test(id)) out.errors.push("prompt_id must be a non-empty single-line string");
    else out.promptId = id;
  }
  out.status = stringField(data, "status", out.errors);
  const created = data["created"];
  if (created === undefined || created === null) out.errors.push("created is required (YYYY-MM-DD)");
  else {
    out.created = normalizeCreated(created);
    if (out.created === null) out.errors.push(`created "${String(created)}" is not a YYYY-MM-DD date`);
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

// Task-list checkboxes under the first "Definition of done" heading, until the next heading of the
// same or higher level. The body is rendered by Bun's markdown renderer, so fences, indented code,
// inline code, setext headings and list markers follow the GFM spec instead of a line scanner.
export function countChecklist(text: string): { checked: number; unchecked: number } {
  const html = Bun.markdown.html(splitFrontMatter(text).body);
  let level = 0;
  let finished = false;
  let checked = 0;
  let unchecked = 0;
  for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>|<input type="checkbox" class="task-list-item-checkbox" disabled( checked)?>/g)) {
    if (m[1] !== undefined) {
      const lv = Number(m[1]);
      if (level === 0 && !finished && /definition of done/i.test((m[2] ?? "").replace(/<[^>]*>/g, ""))) level = lv;
      else if (level > 0 && lv <= level) {
        level = 0;
        finished = true;
      }
    } else if (level > 0) {
      if (m[3] === undefined) unchecked += 1;
      else checked += 1;
    }
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
  const base = raw.replace(/^[`"'([]+/, "").replace(/[`"')\],;:!?]+$/, "");
  return (/(^|\/)\.{1,2}$/.test(base) ? base : base.replace(/\.+$/, "")).trim();
}

// The default is inverted: a token with a `/` in it, or inside a backtick span, is never dropped. It
// is either a checkable repo path or an UNRESOLVED candidate that blocks PATHS-DONE, so a shape the
// rules did not anticipate fails conservative instead of vanishing. Only a bare word, or a token made
// of `/`, `~` and `.` alone (`/`, `//`, `~/`, `./`), is dropped as prose; `**/*`, `-/-` and `*` are not.
function classifyToken(raw: string, span: boolean): Token {
  const candidate = cleanToken(raw, span);
  if (candidate === "") return { kind: "reject" };
  const keep: Token = { kind: "unresolved", token: candidate };
  if (!span && !candidate.includes("/")) {
    if (/[=|,]/.test(candidate) || candidate.startsWith("#") || candidate.startsWith("--")) return { kind: "reject" };
    return BARE_EXTENSION.test(candidate) ? keep : { kind: "reject" };
  }
  const home = candidate.startsWith("~/");
  const abs = candidate.startsWith("/");
  const flat = posix.normalize(candidate).replace(/\/+$/, "");
  const alnum = /[\p{L}\p{N}]/u.test(candidate);
  // Traversal first: `src/..` and `../..` name (and escape) a directory whatever their letters.
  if (!home && !abs && (flat === ".." || flat.startsWith("../") || (flat === "." && alnum))) return keep;
  // The only tokens dropped here are made of `/`, `~` and `.` alone (`/`, `//`, `~/`, `./`): they
  // name nothing. `**/*`, `-/-`, `*` or `{}` are punctuation too, but they might be globs or paths.
  if (/^[/~.]+$/.test(candidate)) return { kind: "reject" };
  if (!candidate.includes("/")) return keep;
  // Globs, placeholders, odd characters, URLs, and absolute or ~/ paths (outside the pinned repo, so
  // no history to pin, whatever their extension) can never be verified.
  if (/[*?[\]<>{}$=|,]/.test(candidate) || candidate.startsWith("#") || candidate.startsWith("--") || candidate.includes("://")) return keep;
  if (/^(~\/+|\/+)[^/]/.test(candidate)) return keep;
  const dotLead = candidate.startsWith("./");
  const dir = candidate.endsWith("/");
  const body = dotLead ? candidate.slice(2) : candidate;
  const trimmed = dir ? body.slice(0, -1) : body;
  const segments = trimmed.split("/");
  const wellFormed = trimmed !== "" && segments[0] !== "" && segments.at(-1) !== "";
  if (wellFormed && alnum && (dir || dotLead || EXTENSION.test(segments.at(-1) ?? ""))) return { kind: "path", path: posix.normalize(candidate) };
  return keep;
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
      // A span that is one path (spaces allowed) or has no separator stays one candidate; otherwise
      // it is split into pieces, each of which is still a span token and never dropped.
      if (whole.kind === "path" || !/[\s,]/.test(inner)) {
        record(whole);
        continue;
      }
      for (const token of inner.split(/[\s,]+/)) record(classifyToken(token, true));
      continue;
    }
    for (const token of part.replaceAll("`", " ").split(/[\s,]+/)) record(classifyToken(token, false));
  }
  return { paths, unresolved };
}

// `unchecked` counts deliverables with no path or with an UNRESOLVED candidate: any of them blocks
// PATHS-DONE, so every extraction miss fails conservative.
export function verdictFor(input: { exists: number; missing: number; unchecked: number; evidence: number; issue: IssueState }): Verdict {
  const checkable = input.exists + input.missing;
  // NOT-RUN is a positive claim ("every deliverable was looked for and nothing happened"), so it
  // needs a checkable path and no unchecked deliverable that could hide the work.
  if (checkable === 0) return input.issue === "CLOSED" || input.evidence > 0 ? "PARTIAL" : "NO-EVIDENCE-POSSIBLE";
  if (input.missing === 0 && input.unchecked === 0 && (input.issue === "none" || input.issue === "CLOSED")) return "PATHS-DONE";
  if (input.exists === 0 && input.evidence === 0 && input.issue !== "CLOSED") return input.unchecked === 0 ? "NOT-RUN" : "NO-EVIDENCE-POSSIBLE";
  return "PARTIAL";
}

export function flagsFor(status: string | null, verdict: Verdict): Flag[] {
  if (status === null || !VALID_STATUS.includes(status)) return ["INVALID-STATUS"];
  if ((status === "ready-not-run" || status === "draft") && verdict !== "NOT-RUN" && verdict !== "NO-EVIDENCE-POSSIBLE") return ["STALE-STATUS"];
  if (status === "done" && verdict !== "PATHS-DONE") return ["STALE-STATUS"];
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

// TOUCHED: on the ref and changed since `created` (a directory: a file under it was ADDED since then;
// edits to old files do not count). UNTOUCHED: on the ref, but not changed that way (it predates the
// prompt, so it is no evidence the prompt ran). MISSING: not in the pinned tree.
export function classifyPath(path: string, tree: Tree, git: Git, ref: string, created: string): PathState {
  const bare = path.replace(/\/+$/, "");
  // A trailing slash names a directory: it needs a tracked descendant, a file of that name is not one.
  const isFile = !path.endsWith("/") && tree.files.has(bare);
  const isDir = [...tree.files].some((f) => f.startsWith(`${bare}/`));
  if (!isFile && !isDir) return "MISSING";
  const out = must(git, ["log", ref, sinceFilter(created), ...(isFile ? [] : ["--diff-filter=A"]), "--format=%h", "--", literal(bare)]);
  return out.trim() === "" ? "UNTOUCHED" : "TOUCHED";
}

export function auditPrompt(file: string, text: string, tree: Tree, git: Git, ref: string, lookup: IssueLookup | null): PromptResult {
  const stem = basename(file).replace(/\.prompt\.md$/, "").replace(/\.md$/, "");
  const parsed = parsePrompt(text);
  // null when absent or invalid: nothing can be dated, so nothing is classified or queried.
  const created = parsed.created;
  const deliverables: DeliverableResult[] = parsed.deliverables.map((d) => {
    const c = extractCandidates(d);
    if (created === null) return { text: d, paths: [], unresolved: [...c.paths, ...c.unresolved], unchecked: true };
    const paths = c.paths.map((path) => ({ path, state: classifyPath(path, tree, git, ref, created) }));
    // Checked only if there is a path and every candidate was classified.
    return { text: d, paths, unresolved: c.unresolved, unchecked: paths.length === 0 || c.unresolved.length > 0 };
  });
  const all = deliverables.flatMap((d) => d.paths);
  const pathsTouched = all.filter((p) => p.state === "TOUCHED").length;
  const pathsUntouched = all.filter((p) => p.state === "UNTOUCHED").length;
  const pathsMissing = all.filter((p) => p.state === "MISSING").length;
  const commits = new Set<string>();
  if (created !== null) {
    const since = sinceFilter(created);
    const repoPaths = all.filter((p) => p.state === "TOUCHED").map((p) => literal(p.path.replace(/\/+$/, "")));
    if (repoPaths.length > 0) for (const h of must(git, ["log", ref, since, "--format=%h", "--", ...repoPaths]).split("\n")) if (h !== "") commits.add(h);
    const needles = [parsed.promptId, stem].filter((n): n is string => n !== null && n !== "" && !/[\r\n]/.test(n));
    // With no needle the query would be an unfiltered `git log`: skip it.
    if (needles.length > 0) for (const h of must(git, ["log", ref, since, "--fixed-strings", ...needles.map((n) => `--grep=${n}`), "--format=%h"]).split("\n")) if (h !== "") commits.add(h);
  }
  let issue: IssueState = "none";
  if (parsed.governingIssue !== null) issue = lookup === null ? "unknown" : lookup(parsed.governingIssue);
  const verdict = verdictFor({ exists: pathsTouched, missing: pathsMissing + pathsUntouched, unchecked: deliverables.filter((d) => d.unchecked).length, evidence: commits.size, issue });
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
  let files: string[];
  try {
    files = readdirSync(o.dir).filter((f) => f.endsWith(".prompt.md")).sort();
  } catch (e) {
    console.error(`prompt-audit: cannot read ${o.dir}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (files.length === 0) {
    console.error(`no prompts in ${o.dir}`);
    return 2;
  }
  // Only the newline git appends is removed: a repository path may itself end in whitespace.
  const top = gitAt(null)(["rev-parse", "--show-toplevel"]);
  const git = gitAt(top.code === 0 ? top.out.replace(/\n$/, "") : null);
  const sha = must(git, ["rev-parse", "--verify", `${o.ref}^{commit}`]).trim();
  const tree = buildTree(must(git, ["ls-tree", "-r", "-z", "--name-only", sha]));
  const lookup = o.noGh ? null : realIssueLookup;
  const results = files.map((f) => auditPrompt(join(o.dir, f), readFileSync(join(o.dir, f), "utf8"), tree, git, sha, lookup));
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
