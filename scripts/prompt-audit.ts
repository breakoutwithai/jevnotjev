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
// UNRESOLVED and counted with the unchecked deliverables; it is never matched by basename.
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

// A YAML comment starts at ` #` outside quotes. A value that starts with a quote ends at its closing
// quote. `atStart` (scalars only) also treats a leading `#` as a comment; a list item may start with `#36:`.
function stripComment(raw: string, atStart: boolean): string {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    for (let i = 1; i < v.length; i++) {
      if (q === '"' && v[i] === "\\") {
        i += 1;
        continue;
      }
      if (v[i] === q) {
        if (q === "'" && v[i + 1] === "'") {
          i += 1;
          continue;
        }
        return v.slice(0, i + 1);
      }
    }
    return v;
  }
  if (atStart && v.startsWith("#")) return "";
  const at = v.search(/\s#/);
  return (at === -1 ? v : v.slice(0, at)).trim();
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replaceAll('\\"', '"');
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  return v;
}

// Comma split that keeps commas inside quotes.
function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] ?? "";
    if (quote !== null) {
      cur += c;
      if (c === "\\" && quote === '"') {
        cur += inner[i + 1] ?? "";
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && cur.trim() === "") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ",") {
      items.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  items.push(cur);
  return items.map((s) => s.trim()).filter((s) => s !== "");
}

function frontMatterLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return [];
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return end === -1 ? [] : lines.slice(1, end);
}

// Only the keys the audit needs: top-level scalars and the deliverables list (block, indentless or
// flow). No YAML dependency.
export function parsePrompt(text: string): ParsedPrompt {
  const scalars = new Map<string, string>();
  const deliverables: string[] = [];
  const errors: string[] = [];
  let mode: "none" | "block" | "flow" = "none";
  let flowBuf = "";
  const finishFlow = (): void => {
    const inner = flowBuf.slice(flowBuf.indexOf("[") + 1, flowBuf.lastIndexOf("]"));
    for (const item of splitFlow(inner)) deliverables.push(unquote(stripComment(item, false)));
    flowBuf = "";
    mode = "none";
  };
  for (const line of frontMatterLines(text)) {
    if (mode === "flow") {
      flowBuf += ` ${line}`;
      if (line.includes("]")) finishFlow();
      continue;
    }
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (top !== null) {
      const key = top[1] ?? "";
      const value = top[2] ?? "";
      mode = "none";
      if (key === "deliverables") {
        const v = value.trim();
        if (v.startsWith("[")) {
          flowBuf = v;
          if (v.includes("]")) finishFlow();
          else mode = "flow";
        } else mode = "block";
        continue;
      }
      const stripped = stripComment(value, true);
      if (stripped !== "") scalars.set(key, unquote(stripped));
      continue;
    }
    if (mode !== "block") continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item?.[1] !== undefined) deliverables.push(unquote(stripComment(item[1], false)));
  }
  const created = scalars.get("created") ?? null;
  if (created !== null && !isIsoDate(created)) errors.push(`created "${created}" is not a YYYY-MM-DD date`);
  const rawIssue = scalars.get("governing_issue");
  let governingIssue: number | null = null;
  if (rawIssue !== undefined && rawIssue !== "null" && rawIssue !== "~") {
    if (/^[1-9]\d*$/.test(rawIssue)) governingIssue = Number(rawIssue);
    else errors.push(`governing_issue "${rawIssue}" is not a positive integer`);
  }
  return { promptId: scalars.get("prompt_id") ?? null, created, status: scalars.get("status") ?? null, governingIssue, deliverables, errors };
}

// Checklist items under "## Definition of done", up to the next "## " heading; fenced code is skipped.
export function countChecklist(text: string): { checked: number; unchecked: number } {
  let inSection = false;
  let fenced = false;
  let checked = 0;
  let unchecked = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
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

type Token = { kind: "path"; path: string } | { kind: "unresolved"; token: string } | { kind: "reject" };

function classifyToken(raw: string): Token {
  const candidate = raw.replace(/^[`"'([]+/, "").replace(/[`"')\],;:]+$/, "").replace(/\.+$/, "").trim();
  if (candidate === "" || /[<>*{}$=|,]/.test(candidate) || candidate.startsWith("#") || candidate.startsWith("--") || candidate.includes("://")) return { kind: "reject" };
  if (!candidate.includes("/")) return EXTENSION.test(candidate) ? { kind: "unresolved", token: candidate } : { kind: "reject" };
  const home = candidate.startsWith("~/");
  const abs = candidate.startsWith("/");
  const dotLead = candidate.startsWith("./");
  const dir = candidate.endsWith("/");
  const body = home || dotLead ? candidate.slice(2) : abs ? candidate.slice(1) : candidate;
  const trimmed = dir ? body.slice(0, -1) : body;
  const segments = trimmed.split("/");
  if (trimmed === "" || segments[0] === "" || segments.at(-1) === "") return { kind: "reject" };
  if (!segments.some((s) => /[A-Za-z0-9]/.test(s))) return { kind: "reject" };
  if (!(dir || home || dotLead || EXTENSION.test(segments.at(-1) ?? ""))) return { kind: "reject" };
  if (home) return { kind: "path", path: posix.join(homedir(), body) };
  const normalized = posix.normalize(candidate);
  if (abs) return { kind: "path", path: normalized };
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return { kind: "unresolved", token: candidate };
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
      const whole = classifyToken(inner);
      if (whole.kind !== "reject" || !/[\s,]/.test(inner)) {
        record(whole);
        continue;
      }
    }
    for (const token of part.replaceAll("`", " ").split(/[\s,]+/)) record(classifyToken(token));
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
  const inTree = tree.files.has(bare) || [...tree.files].some((f) => f.startsWith(`${bare}/`));
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
  const createdBad = parsed.created !== null && !isIsoDate(parsed.created);
  const created = parsed.created !== null && !createdBad ? parsed.created : null;
  const deliverables: DeliverableResult[] = parsed.deliverables.map((d) => {
    const c = extractCandidates(d);
    // An invalid created date means "touched since" cannot be computed: nothing is classified.
    if (createdBad) return { text: d, paths: [], unresolved: [...c.paths, ...c.unresolved], unchecked: true };
    const paths = c.paths.map((path) => ({ path, state: classifyPath(path, tree, git, fsExists, ref, created) }));
    return { text: d, paths, unresolved: c.unresolved, unchecked: paths.length === 0 };
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
  for (const h of must(git, ["log", ref, "--fixed-strings", ...needles.map((n) => `--grep=${n}`), "--format=%h"]).split("\n")) if (h !== "") commits.add(h);
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

function realGit(args: string[]): GitResult {
  const run = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
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
  const sha = must(realGit, ["rev-parse", "--verify", `${o.ref}^{commit}`]).trim();
  const tree = buildTree(must(realGit, ["ls-tree", "-r", "-z", "--name-only", sha]));
  const lookup = o.noGh ? null : realIssueLookup;
  const results = files.map((f) => auditPrompt(join(o.dir, f), readFileSync(join(o.dir, f), "utf8"), tree, realGit, sha, lookup, existsSync));
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
