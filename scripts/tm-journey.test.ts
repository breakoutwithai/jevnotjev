import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkPrototype, listPrototypes } from "./tm-journey-contract.ts";

const ROOT = join(import.meta.dir, "..");
const PROTOTYPES = join(ROOT, "prototype", "tm-journey");
const FIXTURES = join(import.meta.dir, "fixtures", "tm-journey-bad");
const STAGES = ["1", "2", "3", "4", "5", "6"];

for (const [name, expected] of [
  ["stages", "stages: expected 1..6, got [\"1\",\"2\",\"2\",\"4\",\"5\",\"6\"]"],
  ["ranking", "I2: ranking language"],
  ["external", "I3: external resource"],
  ["technical", "native prompt: command language outside prompt"],
  ["missing-copy", "native prompt: Copy the prompt button missing from stage 4"],
  ["img-no-alt", "I8: img missing alt"],
  ["img-bad-src", "I8: img src must use assets path: ./assets/tiny.svg"],
  ["asset-missing", "I8: missing asset assets/missing.svg"],
  ["claims", "claims rows 2: DESIGN on-screen text has a digit or savings claim"],
  ["dash", "dash: README.md"],
]) {
  test(`[unit] tm-journey: ${name} flags the bad fixture`, () => {
    if (name === undefined || expected === undefined) throw new Error("Incomplete fixture case");
    expect(checkPrototype(join(FIXTURES, name))).toEqual([expected]);
  });
}

test("[unit] tm-journey: a good fixture passes", () => {
  expect(checkPrototype(join(FIXTURES, "good"))).toEqual([]);
});

test("[integration] tm-journey: the five prototypes meet the contract", () => {
  const dirs = listPrototypes(PROTOTYPES);
  expect(dirs.length, `Found ${dirs.length} prototypes: ${dirs.join(", ")}`).toBe(5);
  const failures = dirs.flatMap((dir) => checkPrototype(dir).map((violation) => `${dir}: ${violation}`));
  expect(failures, failures.join("\n")).toEqual([]);
});

interface ShotReport {
  readonly viewports: readonly { readonly size: string; readonly jargon: readonly string[] }[];
  readonly stages: readonly string[];
  readonly blocked: readonly string[];
  readonly errors: readonly string[];
  readonly budgets: readonly { readonly name: string; readonly pass: boolean; readonly actual: number | boolean; readonly limit: number | boolean }[];
}

function isShotReport(value: unknown): value is ShotReport {
  if (typeof value !== "object" || value === null) return false;
  return "viewports" in value && Array.isArray(value.viewports)
    && "stages" in value && Array.isArray(value.stages)
    && "blocked" in value && Array.isArray(value.blocked)
    && "errors" in value && Array.isArray(value.errors)
    && "budgets" in value && Array.isArray(value.budgets);
}

test("[integration] tm-journey: first viewport has no jargon at either size", () => {
  const dirs = listPrototypes(PROTOTYPES);
  expect(dirs.length).toBe(5);
  const failures: string[] = [];
  for (const dir of dirs) {
    const result = spawnSync("bun", ["scripts/uat/prototype-shots.ts", dir, "--no-write", "--json"], {
      cwd: ROOT, encoding: "utf8", timeout: 60_000,
    });
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch { failures.push(`${dir}: invalid JSON; status=${result.status}; stderr=${result.stderr.trim()}; stdout=${result.stdout.trim()}`); continue; }
    if (!isShotReport(parsed)) { failures.push(`${dir}: incomplete shot report`); continue; }
    if (result.status !== 0) failures.push(`${dir}: exit status ${result.status}; stderr=${result.stderr.trim()}`);
    if (parsed.viewports.length !== 2 || JSON.stringify(parsed.viewports.map((viewport) => viewport.size)) !== JSON.stringify(["390x844", "1440x900"])) failures.push(`${dir}: viewports ${JSON.stringify(parsed.viewports.map((viewport) => viewport.size))}`);
    for (const viewport of parsed.viewports) if (viewport.jargon.length) failures.push(`${dir} ${viewport.size}: jargon ${JSON.stringify(viewport.jargon)}`);
    if (JSON.stringify(parsed.stages) !== JSON.stringify(STAGES)) failures.push(`${dir}: stages ${JSON.stringify(parsed.stages)}`);
    if (parsed.blocked.length) failures.push(`${dir}: blocked ${JSON.stringify(parsed.blocked)}`);
    if (parsed.errors.length) failures.push(`${dir}: errors ${JSON.stringify(parsed.errors.map((error) => error.split("\n", 1)[0]))}`);
    const failedBudgets = parsed.budgets.filter((entry) => !entry.pass);
    if (failedBudgets.length) failures.push(`${dir}: budgets ${JSON.stringify(failedBudgets)}`);
  }
  expect(failures, failures.join("\n")).toEqual([]);
}, 330_000);
