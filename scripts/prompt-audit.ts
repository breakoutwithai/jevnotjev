// Prompt audit: what does the repo show for each prompt in docs/prompts/*.prompt.md?
//
// This reports EVIDENCE only. It never decides whether a prompt ran or is done: there is
// no verdict. A MISSING path is a pointer for a human to check, not a finding. Verdicts, if there are
// to be any, are decided in #191 (structured deliverables), #192 (Definition of done verification)
// and #193 (status lifecycle), not in this script.
//
// The `status:` header is self-reported and goes stale, so this lists the evidence next to it: it
// checks each deliverable path against the tracked tree of a git ref (TOUCHED = changed since the
// prompt was created, UNTOUCHED = predates it), counts the commits on that ref that touch a TOUCHED
// or MISSING deliverable or mention the prompt, and (optionally) reads the governing issue.
//
//   bun scripts/prompt-audit.ts                  table + per-prompt detail; exit 0
//   bun scripts/prompt-audit.ts --json           full structured result (a JSON array)
//   bun scripts/prompt-audit.ts --strict         exit 1 when any prompt carries a flag
//   bun scripts/prompt-audit.ts --no-gh          skip the `gh issue view` lookup (issue: unknown)
//   bun scripts/prompt-audit.ts --dir <path>     prompt directory (default docs/prompts)
//   bun scripts/prompt-audit.ts --ref <ref>      git ref the evidence is read from (default origin/main)
//   bun scripts/prompt-audit.ts --repo <o/n>     the audited repo for declared outputs (default: from origin)
//   bun scripts/prompt-audit.ts --attributions <file>  attribution ledger (default scripts/prompt-attributions.json)
//
// Table columns: prompt, status, touched (touched/checkable), missing (count), evid (evidence
// commits), flags. The detail lines add the issue state, the Definition of done counts (counted, not
// verified), the unchecked deliverable count and the MISSING / UNTOUCHED / IGNORED / UNRESOLVED lists.
//
// Flags: INVALID-STATUS and INVALID-HEADER (a bad `created`, `governing_issue`, `prompt_id`,
// `deliverables` or front matter), INVALID-ATTRIBUTION (a ledger SHA that credits nothing), and STALE-STATUS, one rule only: `draft` or `ready-not-run` with
// evidence commits or a TOUCHED path. `done` and `running` are never flagged, because no claim of
// absence is made.
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
// A deliverable with no path or any UNRESOLVED candidate is counted as unchecked. A path absent from
// the pinned tree is MISSING, unless `git check-ignore --no-index` says an ignore rule covers it:
// then it is IGNORED (run outputs are gitignored, so absence proves nothing) and counts as unchecked.
// That lookup reads the WORKING TREE's ignore files, not the pinned commit's; a check-ignore failure
// (e.g. a path beyond a symlink) is listed as UNRESOLVED and does not abort. A file or directory is
// TOUCHED when any commit changed it (or anything under it) since `created`, whether by adding or
// editing. MISSING paths also get the evidence query, so a file added after `created` and since
// deleted or renamed counts as evidence. A folder deliverable is TOUCHED by any change under it,
// including unrelated work, so a STALE-STATUS on a broad folder needs a human check.
// The front matter is parsed with Bun.YAML and every field is type-checked (INVALID-HEADER);
// `created` is required. The Definition of done is counted (not verified) from Bun.markdown's
// rendering of the body.
// Declared outputs (#191, M1): the deterministic path. A prompt whose front matter has `outputs:` is
// audited from those declared fields only; the prose extraction above is NOT run for it.
//   outputs:
//     - repo: breakoutwithai/jevnotjev
//       path: scripts/prompt-audit.ts
//       kind: file            # file | dir (a dir path ends with /)
// An output is DELIVERED when at least one commit on the pinned ref, after `created`, touches the path
// (a dir: anything under it, history included, so a file later deleted still counts) AND carries the
// line `Prompt-Id: <prompt_id>` anywhere in its message (a squash merge keeps the branch commits'
// trailer lines in its body). The id is matched whole-line and regex-escaped, so `abc` never matches
// `abc-2`. Merge commits never deliver and a deletion or rename-away is not delivery of the old path.
// Other `Prompt-Id:` values on the delivering commits are listed as `sharedWith`. Otherwise NOT-DELIVERED. An output naming another repo than the audited one (derived from
// `git remote get-url origin`, or --repo owner/name) is OTHER-REPO: listed, not counted. An invalid
// output (bad repo, a non-relative path, `..`, a glob or placeholder, a kind other than file|dir, a dir
// without a trailing slash) is INVALID-HEADER, on the output and on the prompt. The table column `out`
// is delivered/declared (`-` for a legacy prompt). Still no done/not-done verdict: that is #193.
// A prompt with no `outputs:` is legacy: evidence only, exactly as described above.
// Attribution ledger: prompts that ran before Prompt-Id trailers existed are credited by
// scripts/prompt-attributions.json ({ "<prompt_id>": ["<40-hex sha>", ...] }, operator-approved and tracked;
// --attributions <file> overrides the path). A malformed ledger exits 2. Only a prompt whose id is in the
// ledger is affected, and a trailer delivery always wins (DELIVERED, unchanged). Otherwise an output is
// credited by the ledger SHAs that are on the ref, not merges, on/after `created` and touch the path:
// DELIVERED-ATTRIBUTED when the path is in the ref's tree now, REMOVED when it is not (credited once,
// absent now). Both stay distinct from DELIVERED: the `out` column reads delivered+attributed/declared
// (`1+1/3`; REMOVED is not counted) and the detail lists them. A ledger SHA that credits none of the
// prompt's outputs (not on the ref, a merge, before `created`, or wrong path) is an error on that prompt and
// raises INVALID-ATTRIBUTION, so --strict exits 1. A ledger entry for a prompt not in the directory is ignored.
// Limitation: a backtick span containing whitespace is one UNRESOLVED candidate, never a path, so a
// file name with a space (or a comma and space) is always UNRESOLVED.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";

export type IssueState = "OPEN" | "CLOSED" | "unknown" | "none";
export type PathState = "TOUCHED" | "UNTOUCHED" | "MISSING" | "IGNORED";
export type Flag = "STALE-STATUS" | "INVALID-STATUS" | "INVALID-HEADER" | "INVALID-ATTRIBUTION";

export type ParsedPrompt = {
  promptId: string | null;
  created: string | null;
  status: string | null;
  governingIssue: number | null;
  deliverables: string[];
  outputs: DeclaredOutput[] | null;
  errors: string[];
};

export type OutputKind = "file" | "dir";
// A declared output as written; `error` is set when it breaks a schema rule (the fields are then best effort).
export type DeclaredOutput = { repo: string; path: string; kind: OutputKind | null; error: string | null };

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
  const out: ParsedPrompt = { promptId: null, created: null, status: null, governingIssue: null, deliverables: [], outputs: null, errors: [] };
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
  if (issue === "none") {
    const reason = data["governing_issue_reason"];
    if (typeof reason !== "string" || reason.trim() === "") out.errors.push("governing_issue none needs a governing_issue_reason");
  } else if (issue !== undefined && issue !== null) {
    const n = typeof issue === "string" && /^[1-9]\d*$/.test(issue) ? Number(issue) : issue;
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) out.governingIssue = n;
    else out.errors.push(`governing_issue "${String(issue)}" is not a positive integer`);
  }
  const list = data["deliverables"];
  if (list !== undefined && list !== null) {
    if (Array.isArray(list) && list.every((x): x is string => typeof x === "string")) out.deliverables = list;
    else out.errors.push("deliverables is not a list of strings");
  }
  if (Object.hasOwn(data, "outputs")) {
    const raw = data["outputs"];
    if (!Array.isArray(raw) || raw.length === 0) {
      out.errors.push("outputs must be a non-empty list");
      out.outputs = [];
    } else {
      if (out.promptId === null && !out.errors.some((e) => e.startsWith("prompt_id"))) out.errors.push("prompt_id is required when outputs are declared");
      out.outputs = raw.map((entry, i) => validateOutput(entry, i));
      for (const [i, o] of out.outputs.entries()) if (o.error !== null) out.errors.push(`outputs[${i}]: ${o.error}`);
    }
  }
  return out;
}

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function pathProblem(path: string, kind: OutputKind | null): string | null {
  if (path === "") return "path is missing";
  if (/[\u0000-\u001f]/.test(path) || path !== path.trim()) return "path has control or edge whitespace";
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path) || path.includes("\\") || path.includes("://")) return "path is not repo-relative";
  if (/[*?[\]{}<>$]/.test(path)) return "path has a glob or placeholder character";
  const segments = path.endsWith("/") ? path.slice(0, -1).split("/") : path.split("/");
  if (segments.includes("..")) return "path contains ..";
  if (segments.includes(".")) return "path contains a . segment";
  if (segments.includes("")) return "path has an empty segment";
  if (kind === "dir" && !path.endsWith("/")) return "a dir path must end with /";
  if (kind === "file" && path.endsWith("/")) return "a file path must not end with /";
  return null;
}

// One `outputs` entry against the schema rules shared with the create-prompt linter.
export function validateOutput(entry: unknown, index: number): DeclaredOutput {
  if (!isRecord(entry)) return { repo: "", path: "", kind: null, error: `entry ${index} is not a mapping` };
  const str = (k: string): string => {
    const v = entry[k];
    return typeof v === "string" ? v : "";
  };
  const repo = str("repo");
  const path = str("path");
  const rawKind = str("kind");
  const kind: OutputKind | null = rawKind === "file" || rawKind === "dir" ? rawKind : null;
  const problems: string[] = [];
  if (!REPO_NAME.test(repo)) problems.push("repo must be owner/name");
  if (kind === null) problems.push("kind must be file or dir");
  const p = pathProblem(path, kind);
  if (p !== null) problems.push(p);
  return { repo, path, kind, error: problems.length === 0 ? null : problems.join("; ") };
}

// owner/name from a git remote URL, or null. Only three anchored forms are understood:
// https://<host>/<owner>/<name>(.git), git@<host>:<owner>/<name>(.git), ssh://git@<host>/<owner>/<name>(.git).
// A local path, a file:// URL or a short URL derives nothing, so declared outputs then need --repo.
const REMOTE_FORMS = [
  /^https:\/\/[A-Za-z0-9.-]+\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  /^git@[A-Za-z0-9.-]+:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  /^ssh:\/\/git@[A-Za-z0-9.-]+\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
];
export function parseRemoteRepo(url: string): string | null {
  for (const form of REMOTE_FORMS) {
    const m = form.exec(url.trim());
    if (m !== null) return `${m[1]}/${m[2]}`;
  }
  return null;
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
// is either a checkable repo path or an UNRESOLVED candidate that is listed for a human, so a shape the
// rules did not anticipate fails conservative instead of vanishing. Only a bare word, or a token made
// of `/`, `~` and `.` alone (`/`, `//`, `~/`, `./`), is dropped as prose; `**/*`, `-/-` and `*` are not.
function classifyToken(raw: string, span: boolean): Token {
  const candidate = cleanToken(raw, span);
  if (candidate === "") return { kind: "reject" };
  const keep: Token = { kind: "unresolved", token: candidate };
  // A glob character anywhere (a trailing `?` was already stripped as prose) keeps the token, with or
  // without a slash or backticks: `*`, `*.ts` and `{a,b}` can name files the audit cannot check.
  if (/[*?[{]/.test(candidate)) return keep;
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

// Candidate paths in one deliverable string. A backtick span is exactly one candidate; everything
// else splits on whitespace and commas.
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
      // A span is always exactly one candidate. With whitespace in it (`a.ts + b.ts`, `bun test`,
      // `My Notes/x.md`) it cannot be told apart from several things, so it is never a path and is
      // never split into checkable ones: one UNRESOLVED candidate.
      if (/\s/.test(inner)) {
        if (inner !== "" && !unresolved.includes(inner)) unresolved.push(inner);
      } else record(classifyToken(inner, true));
      continue;
    }
    for (const token of part.replaceAll("`", " ").split(/[\s,]+/)) record(classifyToken(token, false));
  }
  return { paths, unresolved };
}

// One status rule: a prompt still marked draft or ready-not-run while the repo shows evidence commits
// or a TOUCHED path. `done` and `running` are never flagged: no claim of absence is made.
export function flagsFor(status: string | null, evidence: number, touched: number): Flag[] {
  if (status === null || !VALID_STATUS.includes(status)) return ["INVALID-STATUS"];
  if ((status === "ready-not-run" || status === "draft") && (evidence > 0 || touched > 0)) return ["STALE-STATUS"];
  return [];
}

export type TableRow = { stem: string; status: string | null; touched: number; checkable: number; missing: number; evidence: number; out: string; flags: Flag[] };

export function renderTable(rows: TableRow[]): string {
  const cell = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 3)}...` : s.padEnd(w));
  // The out column fits its widest cell (min 3); the stem column gives up the difference beyond 5
  // so the longest row (both INVALID flags, 29 characters) stays under 100 characters.
  const outWidth = Math.max(3, ...rows.map((r) => r.out.length));
  // The flags width is the widest joined flag list (at least the 29 the 33 above assumed).
  const flagsWidth = Math.max(29, ...rows.map((r) => r.flags.join(",").length));
  const stemWidth = Math.max(5, Math.min(28, 62 - outWidth - flagsWidth));
  const line = (stem: string, status: string, touched: string, missing: string, evid: string, out: string, flags: string) => `${cell(stem, stemWidth)} ${cell(status, 13)} ${cell(touched, 7)} ${cell(missing, 7)} ${cell(evid, 4)} ${cell(out, outWidth)} ${flags}`.trimEnd();
  // A prompt with declared outputs has no touched/missing figures: those columns are legacy-only.
  return [
    line("prompt", "status", "touched", "missing", "evid", "out", "flags"),
    ...rows.map((r) => (r.out === "-" ? line(r.stem, r.status ?? "(none)", `${r.touched}/${r.checkable}`, String(r.missing), String(r.evidence), r.out, r.flags.join(",")) : line(r.stem, r.status ?? "(none)", "-", "-", String(r.evidence), r.out, r.flags.join(",")))),
  ].join("\n");
}

export type OutputOutcome = "DELIVERED" | "DELIVERED-ATTRIBUTED" | "REMOVED" | "NOT-DELIVERED" | "OTHER-REPO" | "INVALID-HEADER";
export type OutputResult = { repo: string; path: string; kind: string; result: OutputOutcome; commits: string[]; sharedWith: string[] };

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
  outputs: OutputResult[] | null;
  pathsTouched: number;
  pathsUntouched: number;
  pathsMissing: number;
  evidenceCommits: string[];
  dod: { checked: number; unchecked: number };
  uncheckedDeliverables: number;
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
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sinceFilter = (created: string): string => `--since-as-filter=${created}T00:00:00Z`;

export type Tree = { files: Set<string> };

// Input is `git ls-tree -r -z --name-only`: NUL-separated, so names with newlines or non-ASCII survive.
export function buildTree(lsTreeZ: string): Tree {
  return { files: new Set(lsTreeZ.split("\0").filter((l) => l !== "")) };
}

// TOUCHED: on the ref and changed since `created` (a directory: anything under it, added or edited).
// UNTOUCHED: on the ref, but not changed since (it predates the prompt, so it is no evidence the
// prompt ran). MISSING: not in the pinned tree and not covered by an ignore rule. IGNORED: not in the
// tree and the working tree's ignore rules cover it (run outputs are gitignored by policy, so absence
// proves nothing). UNKNOWN: check-ignore could not answer (exit other than 0 or 1, e.g. 128 for a path
// beyond a symlink); it never aborts the audit and the caller treats it as unresolved.
export type ClassifiedState = PathState | "UNKNOWN";
export function classifyPath(path: string, tree: Tree, git: Git, ref: string, created: string): ClassifiedState {
  const bare = path.replace(/\/+$/, "");
  // A trailing slash names a directory: it needs a tracked descendant, a file of that name is not one.
  const isFile = !path.endsWith("/") && tree.files.has(bare);
  const isDir = [...tree.files].some((f) => f.startsWith(`${bare}/`));
  if (!isFile && !isDir) {
    // Plain path: check-ignore rejects :(literal) pathspec magic. --no-index so a tracked-ness
    // lookup never hides a rule; it reads the working tree's ignore files, not the pinned commit's.
    const r = git(["check-ignore", "-q", "--no-index", "--", path]);
    return r.code === 0 ? "IGNORED" : r.code === 1 ? "MISSING" : "UNKNOWN";
  }
  // --full-history: without it a path added and deleted on a merged branch is simplified away.
  const out = must(git, ["log", ref, "--no-show-signature", sinceFilter(created), "--full-history", "--format=%h", "--", literal(bare)]);
  return out.trim() === "" ? "UNTOUCHED" : "TOUCHED";
}

// Full SHAs of commits on `ref`, after `created`, that carry the line `Prompt-Id: <id>` (key case and
// spacing are flexible, the id is exact) and touch the output. Merge commits never deliver: their diff
// credits whatever the other side brought in, and the branch's own commits still count (--full-history).
// The pathspec query is a prefilter; each candidate's own changed paths, deletions excluded and renames
// not detected (a rename is a delete of the old path plus an add of the new), must then match the kind:
// file = exactly the path, dir = anything under it. A deletion is therefore not delivery of what it removes.
export function deliveringCommits(git: Git, ref: string, created: string, promptId: string, path: string, kind: OutputKind = path.endsWith("/") ? "dir" : "file"): string[] {
  const bare = path.replace(/\/+$/, "");
  const out = must(git, ["log", ref, "--no-show-signature", sinceFilter(created), "--full-history", "--no-merges", "-E", `--grep=^[Pp][Rr][Oo][Mm][Pp][Tt]-[Ii][Dd]:[ \t]*${escapeRegex(promptId)}[ \t]*\r?$`, "--format=%H", "--", literal(bare)]);
  const dirPrefix = `${bare}/`;
  return out
    .split("\n")
    .filter((h) => h !== "")
    .filter((sha) => {
      const changed = must(git, ["diff-tree", "--root", "--no-commit-id", "--name-only", "--no-renames", "--diff-filter=d", "-r", "-z", sha]).split("\0");
      return changed.some((p) => (kind === "file" ? p === bare : p.startsWith(dirPrefix)));
    });
}

// Other prompt ids named by `Prompt-Id:` lines on the given commits (one squash can deliver several prompts).
export function sharedPromptIds(git: Git, shas: string[], promptId: string): string[] {
  const ids: string[] = [];
  for (const sha of shas) {
    for (const line of must(git, ["log", "-1", "--no-show-signature", "--format=%B", sha]).split("\n")) {
      const m = /^prompt-id:[ \t]*(.*?)[ \t]*\r?$/i.exec(line);
      const id = m?.[1];
      if (id !== undefined && id !== "" && id !== promptId && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

// prompt_id -> approved commit SHAs, for prompts that ran before Prompt-Id trailers existed.
export type Attributions = Record<string, string[]>;
export const DEFAULT_ATTRIBUTIONS = join(import.meta.dir, "prompt-attributions.json");

// A malformed ledger throws: an object of non-empty prompt_id -> non-empty array of 40-hex SHAs, or nothing.
export function parseAttributions(text: string, source = "attributions"): Attributions {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source}: attributions are not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(data)) throw new Error(`${source}: attributions must be an object of prompt_id -> [sha]`);
  // No prototype: a `__proto__` or `constructor` prompt id is an ordinary own key.
  const out: Attributions = Object.create(null);
  for (const [id, shas] of Object.entries(data)) {
    if (id.trim() === "") throw new Error(`${source}: attributions have an empty prompt_id`);
    if (!Array.isArray(shas) || shas.length === 0) throw new Error(`${source}: attributions for ${id} must be a non-empty array`);
    const clean = shas.map((s): string => {
      if (typeof s !== "string" || !/^[0-9a-f]{40}$/.test(s)) throw new Error(`${source}: attributions for ${id} has a value that is not a 40-hex sha: ${JSON.stringify(s)}`);
      return s;
    });
    out[id] = clean;
  }
  return out;
}

export function loadAttributions(path: string): Attributions {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read attributions ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseAttributions(text, path);
}

// Ledger SHAs that are on the ref, not merges, on/after `created`, and touch the output path (one query).
function attributedCommits(git: Git, ref: string, created: string, path: string, kind: OutputKind, ledger: string[]): string[] {
  const bare = path.replace(/\/+$/, "");
  const found = new Set(must(git, ["log", ref, "--no-show-signature", sinceFilter(created), "--full-history", "--no-merges", "--format=%H", "--", literal(bare)]).split("\n"));
  // The pathspec is a prefilter; each candidate's own changed paths (deletions included, renames not
  // detected) must match the kind: file = exactly the path, dir = anything under it.
  return ledger
    .filter((sha) => found.has(sha))
    .filter((sha) => {
      const changed = must(git, ["diff-tree", "--root", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", sha]).split("\0");
      return changed.some((p) => (kind === "file" ? p === bare : p.startsWith(`${bare}/`)));
    });
}

// A file output needs that exact file in the tree; only a dir output accepts descendants.
function treeHas(tree: Tree, path: string, kind: OutputKind): boolean {
  const bare = path.replace(/\/+$/, "");
  return kind === "file" ? tree.files.has(bare) : [...tree.files].some((f) => f.startsWith(`${bare}/`));
}

function auditOutputs(declared: DeclaredOutput[], parsed: ParsedPrompt, tree: Tree, git: Git, ref: string, repo: string | null, ledger: string[], matched: Set<string>): OutputResult[] {
  return declared.map((o): OutputResult => {
    const base = { repo: o.repo, path: o.path, kind: o.kind ?? "" };
    if (o.error !== null || parsed.created === null || parsed.promptId === null) return { ...base, result: "INVALID-HEADER", commits: [], sharedWith: [] };
    if (repo === null) throw new Error("cannot derive owner/name from `git remote get-url origin`; pass --repo owner/name");
    if (o.repo.toLowerCase() !== repo.toLowerCase()) return { ...base, result: "OTHER-REPO", commits: [], sharedWith: [] };
    const commits = deliveringCommits(git, ref, parsed.created, parsed.promptId, o.path, o.kind ?? "file");
    // Queried even when a trailer delivered, so a ledger SHA is judged against every declared output.
    const attributed = ledger.length === 0 ? [] : attributedCommits(git, ref, parsed.created, o.path, o.kind ?? "file", ledger);
    for (const sha of attributed) matched.add(sha);
    if (commits.length > 0) return { ...base, result: "DELIVERED", commits, sharedWith: sharedPromptIds(git, commits, parsed.promptId) };
    if (attributed.length > 0) return { ...base, result: treeHas(tree, o.path, o.kind ?? "file") ? "DELIVERED-ATTRIBUTED" : "REMOVED", commits: attributed, sharedWith: [] };
    return { ...base, result: "NOT-DELIVERED", commits: [], sharedWith: [] };
  });
}

export function auditPrompt(file: string, text: string, tree: Tree, git: Git, ref: string, lookup: IssueLookup | null, repo: string | null = null, attributions: Attributions | null = null): PromptResult {
  const stem = basename(file).replace(/\.prompt\.md$/, "").replace(/\.md$/, "");
  const parsed = parsePrompt(text);
  // null when absent or invalid: nothing can be dated, so nothing is classified or queried.
  const created = parsed.created;
  const ledger = parsed.promptId === null || attributions === null || !Object.hasOwn(attributions, parsed.promptId) ? [] : (attributions[parsed.promptId] ?? []);
  const matched = new Set<string>();
  const outputs = parsed.outputs === null ? null : auditOutputs(parsed.outputs, parsed, tree, git, ref, repo, ledger, matched);
  // A ledger SHA that credits no declared output is a wrong SHA: reported, never trusted. Only when
  // every output could be queried (a prompt with an invalid or other-repo output is not judged).
  const attributionErrors = outputs === null || outputs.some((o) => o.result === "INVALID-HEADER" || o.result === "OTHER-REPO") ? [] : ledger.filter((sha) => !matched.has(sha)).map((sha) => `attribution ${sha} touches no declared output on ${ref} after created`);
  // Declared outputs replace the prose extraction: a prompt with `outputs:` never reaches the path heuristics.
  const deliverables: DeliverableResult[] = (outputs === null ? parsed.deliverables : []).map((d) => {
    const c = extractCandidates(d);
    if (created === null) return { text: d, paths: [], unresolved: [...c.paths, ...c.unresolved], unchecked: true };
    const paths: PathResult[] = [];
    const unresolved = [...c.unresolved];
    for (const path of c.paths) {
      const state = classifyPath(path, tree, git, ref, created);
      if (state === "UNKNOWN") unresolved.push(path);
      else paths.push({ path, state });
    }
    // Checked only if there is a path and every candidate was classified and none is IGNORED.
    return { text: d, paths, unresolved, unchecked: paths.length === 0 || unresolved.length > 0 || paths.some((p) => p.state === "IGNORED") };
  });
  const all = deliverables.flatMap((d) => d.paths);
  const pathsTouched = all.filter((p) => p.state === "TOUCHED").length;
  const pathsUntouched = all.filter((p) => p.state === "UNTOUCHED").length;
  const pathsMissing = all.filter((p) => p.state === "MISSING").length;
  const commits = new Set<string>();
  if (outputs !== null) for (const o of outputs) for (const h of o.commits) commits.add(h);
  if (created !== null && outputs === null) {
    const since = sinceFilter(created);
    // MISSING paths are queried too: a file added after `created` and since deleted or renamed has
    // history on the ref even though it is gone from the tree. The path keeps its MISSING state.
    const repoPaths = all.filter((p) => p.state === "TOUCHED" || p.state === "MISSING").map((p) => literal(p.path.replace(/\/+$/, "")));
    if (repoPaths.length > 0) for (const h of must(git, ["log", ref, "--no-show-signature", since, "--full-history", "--format=%h", "--", ...repoPaths]).split("\n")) if (h !== "") commits.add(h);
    const needles = [parsed.promptId, stem].filter((n): n is string => n !== null && n !== "" && !/[\r\n]/.test(n));
    // With no needle the query would be an unfiltered `git log`: skip it.
    if (needles.length > 0) for (const h of must(git, ["log", ref, "--no-show-signature", since, "--fixed-strings", ...needles.map((n) => `--grep=${n}`), "--format=%h"]).split("\n")) if (h !== "") commits.add(h);
  }
  let issue: IssueState = "none";
  if (parsed.governingIssue !== null) issue = lookup === null ? "unknown" : lookup(parsed.governingIssue);
  const flags = flagsFor(parsed.status, commits.size, pathsTouched);
  if (parsed.errors.length > 0) flags.push("INVALID-HEADER");
  if (attributionErrors.length > 0) flags.push("INVALID-ATTRIBUTION");
  return {
    stem,
    file,
    promptId: parsed.promptId,
    created: parsed.created,
    status: parsed.status,
    governingIssue: parsed.governingIssue,
    issue,
    errors: [...parsed.errors, ...attributionErrors],
    deliverables,
    outputs,
    pathsTouched,
    pathsUntouched,
    pathsMissing,
    evidenceCommits: [...commits],
    dod: countChecklist(text),
    uncheckedDeliverables: deliverables.filter((d) => d.unchecked).length,
    flags,
  };
}

// delivered[+attributed]/declared, OTHER-REPO outputs not counted; `-` for a legacy prompt. REMOVED is
// not counted as delivered: it is credited once but absent from the ref now (listed in the detail).
function outCell(r: PromptResult): string {
  if (r.outputs === null) return "-";
  const counted = r.outputs.filter((o) => o.result !== "OTHER-REPO");
  const attributed = counted.filter((o) => o.result === "DELIVERED-ATTRIBUTED").length;
  return `${counted.filter((o) => o.result === "DELIVERED").length}${attributed > 0 ? `+${attributed}` : ""}/${counted.length}`;
}

export function renderReport(results: PromptResult[], refLine: string | null = null): string {
  const table = renderTable(
    results.map((r) => ({ stem: r.stem, status: r.status, touched: r.pathsTouched, checkable: r.pathsTouched + r.pathsUntouched + r.pathsMissing, missing: r.pathsMissing, evidence: r.evidenceCommits.length, out: outCell(r), flags: r.flags })),
  );
  const bullets = results.map((r) => {
    if (r.outputs !== null) {
      const declaredOutputs = r.outputs;
      const names = (result: OutputOutcome): string => {
        const found = declaredOutputs.filter((o) => o.result === result).map((o) => (o.path === "" ? "(no path)" : o.path));
        return found.length === 0 ? "none" : found.join(", ");
      };
      const declared = [
        `issue: ${r.governingIssue === null ? "none" : `#${r.governingIssue} ${r.issue}`}`,
        `DoD: ${r.dod.checked} checked, ${r.dod.unchecked} unchecked (unverified)`,
        `NOT-DELIVERED: ${names("NOT-DELIVERED")}`,
      ];
      for (const result of ["DELIVERED-ATTRIBUTED", "REMOVED"] as const) if (declaredOutputs.some((o) => o.result === result)) declared.push(`${result}: ${names(result)}`);
      const other = declaredOutputs.filter((o) => o.result === "OTHER-REPO");
      if (other.length > 0) declared.push(`OTHER-REPO: ${other.map((o) => `${o.repo}:${o.path}`).join(", ")}`);
      const shared = declaredOutputs.filter((o) => o.sharedWith.length > 0);
      if (shared.length > 0) declared.push(`shared: ${shared.map((o) => `${o.path} with ${o.sharedWith.join(", ")}`).join("; ")}`);
      if (declaredOutputs.some((o) => o.result === "INVALID-HEADER")) declared.push(`INVALID: ${names("INVALID-HEADER")}`);
      if (r.errors.length > 0) declared.push(`ERRORS: ${r.errors.join("; ")}`);
      return `- ${r.stem}: ${declared.join(" | ")}`;
    }
    const paths = r.deliverables.flatMap((d) => d.paths);
    const list = (state: PathState): string => {
      const found = paths.filter((p) => p.state === state).map((p) => p.path);
      return found.length === 0 ? "none" : found.join(", ");
    };
    const unresolved = r.deliverables.flatMap((d) => d.unresolved);
    const parts = [
      `issue: ${r.governingIssue === null ? "none" : `#${r.governingIssue} ${r.issue}`}`,
      `DoD: ${r.dod.checked} checked, ${r.dod.unchecked} unchecked (unverified)`,
      `unchecked deliverables: ${r.uncheckedDeliverables}`,
      `TOUCHED: ${r.pathsTouched}`,
      `MISSING: ${list("MISSING")}`,
      `UNTOUCHED: ${list("UNTOUCHED")}`,
    ];
    if (paths.some((p) => p.state === "IGNORED")) parts.push(`IGNORED: ${list("IGNORED")}`);
    if (unresolved.length > 0) parts.push(`UNRESOLVED: ${unresolved.join(", ")}`);
    if (r.errors.length > 0) parts.push(`ERRORS: ${r.errors.join("; ")}`);
    return `- ${r.stem}: ${parts.join(" | ")}`;
  });
  return `${refLine === null ? "" : `${refLine}\n`}${table}\n\n${bullets.join("\n")}`;
}

export type Options = { dir: string; ref: string; repo: string | null; attributions: string; json: boolean; strict: boolean; noGh: boolean; help: boolean };
export type ParsedArgs = { ok: true; options: Options } | { ok: false; error: string };

export const USAGE = "Usage: bun scripts/prompt-audit.ts [--dir <path>] [--ref <ref>] [--repo <owner/name>] [--attributions <file>] [--json] [--strict] [--no-gh] [--help]";

export function parseArgs(args: string[]): ParsedArgs {
  const options: Options = { dir: "docs/prompts", ref: "origin/main", repo: null, attributions: DEFAULT_ATTRIBUTIONS, json: false, strict: false, noGh: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") options.json = true;
    else if (a === "--strict") options.strict = true;
    else if (a === "--no-gh") options.noGh = true;
    else if (a === "--help" || a === "-h") options.help = true;
    else if (a === "--dir" || a === "--ref" || a === "--repo" || a === "--attributions") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return { ok: false, error: `missing value for ${a}` };
      if (a === "--dir") options.dir = v;
      else if (a === "--ref") options.ref = v;
      else if (a === "--attributions") options.attributions = v;
      else if (REPO_NAME.test(v)) options.repo = v;
      else return { ok: false, error: `--repo must be owner/name, got ${v}` };
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
  const attributions = loadAttributions(o.attributions);
  // Only the newline git appends is removed: a repository path may itself end in whitespace.
  const top = gitAt(null)(["rev-parse", "--show-toplevel"]);
  const git = gitAt(top.code === 0 ? top.out.replace(/\n$/, "") : null);
  const sha = must(git, ["rev-parse", "--verify", `${o.ref}^{commit}`]).trim();
  const tree = buildTree(must(git, ["ls-tree", "-r", "-z", "--name-only", sha]));
  const lookup = o.noGh ? null : realIssueLookup;
  const remote = git(["remote", "get-url", "origin"]);
  const repo = o.repo ?? (remote.code === 0 ? parseRemoteRepo(remote.out) : null);
  const results = files.map((f) => auditPrompt(join(o.dir, f), readFileSync(join(o.dir, f), "utf8"), tree, git, sha, lookup, repo, attributions));
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
