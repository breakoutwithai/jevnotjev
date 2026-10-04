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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

function runBun(root: string): { results: Map<string, Counts>; ok: boolean; tail: string; error: string | null } {
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
  rmSync(dir, { recursive: true, force: true });
  return { results, ok: run.exitCode === 0 && error === null, tail, error };
}

function runShell(root: string): Map<string, Counts> {
  const out = new Map<string, Counts>();
  const suites = readdirSync(join(root, SHELL_DIR)).filter((f) => f.endsWith(".test.sh")).sort();
  for (const suite of suites) {
    const file = `${SHELL_DIR}/${suite}`;
    const run = Bun.spawnSync(["bash", file], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const summary = parseShellSummary(`${run.stdout.toString()}\n${run.stderr.toString()}`);
    if (summary === null) {
      out.set(file, { passed: 0, failed: 1 });
    } else {
      // A non-zero exit is a failure even when the summary line claims none.
      out.set(file, { passed: summary.passed, failed: run.exitCode === 0 ? summary.failed : Math.max(1, summary.failed) });
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
      return 1;
    }
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
    return 1;
  }
  console.log(`gate: PASS files=${results.size} tests=${total}`);
  return 0;
}

if (import.meta.main) process.exit(main());
