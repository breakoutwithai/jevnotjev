// The test gate (#87): runs every suite, Bun and shell, and checks each test file against its
// committed floor in .deploy/tests/expected-counts.json. A total and an exit code are proxies: a
// file bun stops discovering, or a shell suite that loses a case, still exits 0 with a healthy
// total. The gate fails when any file passes fewer tests than its floor, when a floored file did
// not run, when a test fails, when fewer files ran than the floor, or when a test file has no floor.
//
//   bun scripts/gate.ts          run everything, print one row per file and a verdict; exit 0 or 1
//   bun scripts/gate.ts --seed   run everything and print the manifest JSON of what passed
//
// Raising a floor is part of the PR that adds tests.
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Counts = { passed: number; failed: number };
export type Manifest = { minFiles: number; files: Record<string, number> };

const MANIFEST_PATH = ".deploy/tests/expected-counts.json";
const SHELL_DIR = ".deploy/tests";

const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

// Top-level <testsuite> elements are files: bun writes name == file for them; nested describe
// blocks carry their own name and a line attribute.
export function parseJunit(xml: string): Map<string, Counts> {
  const out = new Map<string, Counts>();
  for (const match of xml.matchAll(/<testsuite\s[^>]*>/g)) {
    const tag = match[0];
    const name = attr(tag, "name");
    const file = attr(tag, "file");
    if (name === undefined || name !== file || attr(tag, "line") !== undefined) continue;
    const tests = count(tag, "tests", file);
    const failed = count(tag, "failures", file);
    const skipped = count(tag, "skipped", file);
    if (failed + skipped > tests) throw new Error(`${file}: failures ${failed} + skipped ${skipped} exceed tests ${tests}`);
    out.set(file, { passed: tests - failed - skipped, failed });
  }
  return out;
}

// Bun's JUnit includes the test name and assertion message inside a non-self-closing testcase.
// Keep this diagnostic separate from the count parser: malformed XML must still fail the gate.
export function parseJunitIncidents(xml: string): string[] {
  const incidents: string[] = [];
  for (const match of xml.matchAll(/<testcase\s([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const testcaseAttrs = match[1];
    const testcaseBody = match[2];
    if (testcaseAttrs === undefined || testcaseBody === undefined) continue;
    const file = decodeXml(attr(` ${testcaseAttrs}`, "file") ?? "unknown file");
    const name = decodeXml(attr(` ${testcaseAttrs}`, "name") ?? "unknown case");
    for (const incident of testcaseBody.matchAll(/<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
      const kind = incident[1];
      if (kind === undefined) continue;
      const attributes = incident[2] ?? "";
      const detail = decodeXml(attr(attributes, "message") ?? attr(attributes, "type") ?? kind)
        .replace(/\s*\n\s*/g, "; ").replace(/\s+/g, " ").trim().slice(0, 500);
      incidents.push(`${file} :: ${name} :: ${kind === "skipped" ? "skipped" : `${attr(attributes, "type") ?? kind}: ${detail}`}`);
    }
  }
  return incidents;
}

function decodeXml(value: string): string {
  return value.replace(/&#(x[\da-fA-F]+|\d+);|&(amp|lt|gt|quot|apos);/g, (entity, numeric: string | undefined, named: string | undefined) => {
    if (numeric !== undefined) {
      const point = numeric.startsWith("x") ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    const names: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return named === undefined ? entity : names[named] ?? entity;
  });
}

// A green run cleans its temporary report. Any red gate retains the original JUnit plus a
// readable summary in a private 0700 temporary directory, including floor-only failures.
export function finalizeBunReport(dir: string, passed: boolean, xml: string | null): string | null {
  if (passed) {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  chmodSync(dir, 0o700);
  const report = join(dir, "junit.xml");
  const incidents = xml === null ? [] : parseJunitIncidents(xml);
  writeFileSync(join(dir, "incidents.txt"), `${incidents.length ? incidents.join("\n") : "No testcase failure or skip encoded; inspect JUnit and gate counts."}\n`, { mode: 0o600 });
  return report;
}

// A count attribute must be a whole number written in digits; anything else (NaN, a fraction, a
// negative) would compare false against every floor and pass silently.
function count(tag: string, name: string, file: string): number {
  const raw = attr(tag, name);
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${file}: ${name}="${raw ?? ""}" is not a whole number`);
  return Number(raw);
}

export type SeedResult = { manifest: Manifest } | { error: string };

// The manifest a real run supports: only from a bun run that exited 0 with a report, and only when
// no test failed anywhere.
export function buildSeed(bun: { ok: boolean; results: Map<string, Counts> }, shell: Map<string, Counts>): SeedResult {
  if (!bun.ok) return { error: "bun test failed; no seed" };
  if (bun.results.size === 0) return { error: "bun test produced no report; no seed" };
  const all = new Map<string, Counts>([...bun.results, ...shell]);
  for (const [file, got] of all) if (got.failed > 0) return { error: `${file}: ${got.failed} failed; no seed` };
  const files: Record<string, number> = {};
  for (const file of [...all.keys()].sort()) files[file] = all.get(file)?.passed ?? 0;
  return { manifest: { minFiles: all.size, files } };
}

export function parseShellSummary(output: string): Counts | null {
  const lines = [...output.matchAll(/^\[T\d\] passed=(\d+) failed=(\d+)\s*$/gm)];
  const last = lines.at(-1);
  if (last === undefined) return null;
  return { passed: Number(last[1]), failed: Number(last[2]) };
}

export function parseManifest(text: string): Manifest {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error(`${MANIFEST_PATH}: not an object`);
  const minFiles: unknown = Reflect.get(raw, "minFiles");
  const files: unknown = Reflect.get(raw, "files");
  if (typeof minFiles !== "number" || !Number.isInteger(minFiles)) throw new Error(`${MANIFEST_PATH}: minFiles must be an integer`);
  if (typeof files !== "object" || files === null) throw new Error(`${MANIFEST_PATH}: files must be an object`);
  const floors: Record<string, number> = {};
  for (const [file, floor] of Object.entries(files)) {
    if (typeof floor !== "number" || !Number.isInteger(floor) || floor < 0) throw new Error(`${MANIFEST_PATH}: floor for ${file} must be a whole number`);
    floors[file] = floor;
  }
  return { minFiles, files: floors };
}

export function checkCounts(manifest: Manifest, results: Map<string, Counts>): string[] {
  const problems: string[] = [];
  for (const [file, floor] of Object.entries(manifest.files)) {
    const got = results.get(file);
    if (got === undefined) problems.push(`${file}: not run (floor ${floor})`);
    else if (got.passed < floor) problems.push(`${file}: ${got.passed} passed, floor ${floor}`);
  }
  for (const [file, got] of results) {
    if (got.failed > 0) problems.push(`${file}: ${got.failed} failed`);
    if (!(file in manifest.files)) problems.push(`${file}: no floor in ${MANIFEST_PATH} (${got.passed} passed)`);
  }
  if (results.size < manifest.minFiles) problems.push(`files: ${results.size} ran, floor ${manifest.minFiles}`);
  return problems;
}

function runBun(root: string): { results: Map<string, Counts>; ok: boolean; tail: string; error: string | null; artifactDir: string; xml: string | null } {
  const dir = mkdtempSync(join(tmpdir(), "jevnotjev-gate-"));
  const report = join(dir, "junit.xml");
  const run = Bun.spawnSync(["bun", "test", "--reporter=junit", `--reporter-outfile=${report}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const tail = `${run.stdout.toString()}${run.stderr.toString()}`.trim().split("\n").slice(-6).join("\n");
  let results = new Map<string, Counts>();
  let error: string | null = null;
  let xml: string | null = null;
  try {
    xml = readFileSync(report, "utf8");
  } catch {
    error = "bun test wrote no junit report";
  }
  if (xml !== null) {
    try {
      results = parseJunit(xml);
    } catch (e) {
      error = `bun junit report rejected: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { results, ok: run.exitCode === 0 && error === null, tail, error, artifactDir: dir, xml };
}

// The #240 guard: every shell suite runs once, here; the five guarded suites get all four GIT_* destinations pointing at a
// sentinel repository. A suite that leaks into an inherited repository corrupts the sentinel and
// fails; a suite that needs a clean env to pass fails on its own assertions.
// The five suites the #240 integration tests covered; the others read this checkout's history.
const GIT_GUARDED = ["ship", "branch-guard", "monitor", "release", "verify"];
const GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !GIT_ENV.includes(entry[0])));
}

function sentinelGit(dir: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-C", dir, ...args], { env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`sentinel git ${args.join(" ")} failed: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

function makeSentinel(): string {
  const dir = mkdtempSync(join(tmpdir(), "jnj-gate-sentinel-"));
  sentinelGit(dir, "init", "-q", "--initial-branch=main", "--template=");
  sentinelGit(dir, "config", "user.name", "Sentinel Actor");
  sentinelGit(dir, "config", "user.email", "sentinel@example.test");
  sentinelGit(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "sentinel.txt"), "unchanged sentinel worktree\n");
  sentinelGit(dir, "add", "sentinel.txt");
  sentinelGit(dir, "commit", "-qm", "sentinel base");
  return dir;
}

function sentinelSnapshot(dir: string): string {
  return JSON.stringify([
    readFileSync(join(dir, ".git/config"), "utf8"),
    readFileSync(join(dir, ".git/HEAD"), "utf8"),
    sentinelGit(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
    readFileSync(join(dir, ".git/index")).toString("hex"),
    readFileSync(join(dir, "sentinel.txt"), "utf8"),
  ]);
}

export function runShell(root: string, shellDir: string = SHELL_DIR, guarded: string[] = GIT_GUARDED): Map<string, Counts> {
  const out = new Map<string, Counts>();
  const suites = readdirSync(join(root, shellDir)).filter((f) => f.endsWith(".test.sh")).sort();
  for (const suite of suites) {
    const file = `${shellDir}/${suite}`;
    const sentinel = makeSentinel();
    try {
      const before = sentinelSnapshot(sentinel);
      const poisoned = guarded.includes(suite.replace(/\.test\.sh$/, ""));
      const env = !poisoned ? process.env : { ...cleanEnv(), GIT_DIR: join(sentinel, ".git"), GIT_WORK_TREE: sentinel, GIT_INDEX_FILE: join(sentinel, ".git/index"), GIT_COMMON_DIR: join(sentinel, ".git") };
      const run = Bun.spawnSync(["bash", file], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const summary = parseShellSummary(`${run.stdout.toString()}\n${run.stderr.toString()}`);
      const leaked = poisoned && sentinelSnapshot(sentinel) !== before;
      if (leaked) console.log(`gate: ${file} modified the inherited-GIT_* sentinel repository (#240)`);
      if (summary === null) {
        out.set(file, { passed: 0, failed: 1 });
      } else {
        // A non-zero exit is a failure even when the summary line claims none.
        out.set(file, { passed: summary.passed, failed: run.exitCode === 0 && !leaked ? summary.failed : Math.max(1, summary.failed) });
      }
    } finally {
      rmSync(sentinel, { recursive: true, force: true });
    }
  }
  return out;
}

function main(): number {
  const root = join(import.meta.dir, "..");
  const seed = process.argv.includes("--seed");
  const bun = runBun(root);
  const shell = runShell(root);
  const results = new Map<string, Counts>([...bun.results, ...shell]);
  if (seed) {
    const built = buildSeed(bun, shell);
    if ("error" in built) {
      console.error(`gate --seed: ${built.error}${bun.error ? ` (${bun.error})` : ""}\n${bun.tail}`);
      console.error(`gate: retained private JUnit ${finalizeBunReport(bun.artifactDir, false, bun.xml)}`);
      return 1;
    }
    finalizeBunReport(bun.artifactDir, true, bun.xml);
    console.log(JSON.stringify(built.manifest, null, 2));
    return 0;
  }
  const manifest = parseManifest(readFileSync(join(root, MANIFEST_PATH), "utf8"));
  const names = [...new Set([...Object.keys(manifest.files), ...results.keys()])].sort();
  let total = 0;
  for (const file of names) {
    const got = results.get(file);
    const floor = manifest.files[file];
    total += got?.passed ?? 0;
    console.log(`${String(got?.passed ?? "-").padStart(4)} / ${String(floor ?? "-").padStart(4)}  ${got?.failed ? `${got.failed} FAILED  ` : ""}${file}`);
  }
  const problems = checkCounts(manifest, results);
  if (bun.error !== null) problems.push(bun.error);
  if (!bun.ok && problems.length === 0) problems.push(`bun test exited non-zero:\n${bun.tail}`);
  if (problems.length > 0) {
    console.log(`gate: FAIL (${problems.length} problem${problems.length === 1 ? "" : "s"})`);
    for (const p of problems) console.log(`  ${p}`);
    const report = finalizeBunReport(bun.artifactDir, false, bun.xml);
    for (const incident of bun.xml === null ? [] : parseJunitIncidents(bun.xml)) console.log(`  case: ${incident}`);
    console.log(`gate: retained private JUnit ${report}`);
    return 1;
  }
  finalizeBunReport(bun.artifactDir, true, bun.xml);
  console.log(`gate: PASS files=${results.size} tests=${total}`);
  return 0;
}

if (import.meta.main) process.exit(main());
