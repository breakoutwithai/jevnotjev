import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(import.meta.dir, "prototype-shots.ts");
const STUB = join(ROOT, "scripts", "fixtures", "prototype-stub");
const EXTERNAL = join(ROOT, "scripts", "fixtures", "prototype-stub-external");
const VISUAL = join(ROOT, "scripts", "fixtures", "prototype-stub-visual");
const VISUAL_PASS = join(ROOT, "scripts", "fixtures", "prototype-stub-visual-pass");

interface ShotReport {
  readonly viewports: readonly { readonly size: string; readonly words: number; readonly text: string; readonly jargon: readonly string[]; readonly scrollText?: string }[];
  readonly stages: readonly string[];
  readonly blocked: readonly string[];
  readonly errors: readonly string[];
  readonly fullText?: string;
  readonly stagesDetail: readonly { readonly stage: string; readonly words: number; readonly visuals: number; readonly visualLabelled: boolean }[];
  readonly pageWords: number;
  readonly budgets: readonly { readonly name: string; readonly limit: number | boolean; readonly actual: number | boolean; readonly pass: boolean }[];
}

function run(dir: string, extra: readonly string[] = []): { status: number | null; report: ShotReport; stderr: string } {
  const result = spawnSync("bun", [SCRIPT, dir, "--no-write", "--json", ...extra], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, report: JSON.parse(result.stdout), stderr: result.stderr };
}

test("[integration] shots: first viewport excludes below-fold and hidden text at both sizes", () => {
  const { status, report, stderr } = run(STUB);
  expect(status, stderr).toBe(0);
  expect(report.viewports.map((viewport) => viewport.size)).toEqual(["390x844", "1440x900"]);
  for (const viewport of report.viewports) {
    expect(viewport.text).toContain("ABOVEFOLD");
    for (const absent of ["BELOWFOLD", "HIDDENTEXT", "SRONLYTEXT"]) expect(viewport.text).not.toContain(absent);
  }
  expect(report.stages).toEqual(["1", "2"]);
});

test("[integration] shots: full text includes below-fold text", () => {
  const { status, report, stderr } = run(STUB, ["--full"]);
  expect(status, stderr).toBe(0);
  expect(report.fullText).toContain("ABOVEFOLD");
  expect(report.fullText).toContain("BELOWFOLD");
  expect(report.fullText).not.toContain("HIDDENTEXT");
  expect(report.fullText).not.toContain("SRONLYTEXT");
});

test("[integration] shots: --scroll adds the text of the viewport after one scroll, and the first viewport still excludes it", () => {
  const { status, report, stderr } = run(STUB, ["--scroll"]);
  expect(status, stderr).toBe(0);
  for (const viewport of report.viewports) {
    expect(viewport.text).not.toContain("SECONDFOLD");
    expect(viewport.scrollText).toContain("SECONDFOLD");
    expect(viewport.scrollText).not.toContain("BELOWFOLD");
  }
});

test("[integration] shots: external request is blocked and reported", () => {
  const { status, report } = run(EXTERNAL);
  expect(status).toBe(1);
  expect(report.blocked).toContain("https://example.invalid/x.png");
});

test("[unit] jargon: matches whole words with optional plural s, ignoring case", async () => {
  const { findJargon } = await import("./prototype-shots.ts");
  const words = ["curl", "bun", "terminal", "logs", "subagent", "JSONL", "router", "rule"];
  expect(findJargon("Open your Terminal. Bun follows rules.", words)).toEqual(["bun", "terminal", "rule"]);
  expect(findJargon("TokenMax bundle ruler", words)).toEqual([]);
});

test("[integration] shots: stage and page counts exclude visible prompt text and report visual budgets", () => {
  const { status, report, stderr } = run(VISUAL);
  expect(status, stderr).toBe(0);
  expect(report.stagesDetail).toEqual([
    { stage: "1", words: 7, visuals: 1, visualLabelled: true },
    { stage: "2", words: 19, visuals: 0, visualLabelled: true },
  ]);
  expect(report.pageWords).toBe(26);
  expect(report.budgets.filter((budget) => !budget.pass).map((budget) => budget.name)).toEqual([
    "stage 2 words", "stage 2 visuals",
  ]);
});

test("[integration] shots: --strict fails on budgets and passes a compliant fixture", () => {
  expect(run(VISUAL, ["--strict"]).status).toBe(1);
  const passing = run(VISUAL_PASS, ["--strict"]);
  expect(passing.status, passing.stderr).toBe(0);
  expect(passing.report.budgets.every((budget) => budget.pass)).toBe(true);
});

test("[integration] shots: --visuals writes the first visual element screenshot", () => {
  const output = mkdtempSync(join(tmpdir(), "prototype-visuals-"));
  const result = spawnSync("bun", [SCRIPT, VISUAL_PASS, "--no-write", "--visuals", output], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(Bun.file(join(output, "stage-1-390.png")).size).toBeGreaterThan(0);
  expect(result.stdout).toContain("Stage 1 visual text: A clear path.");
});
