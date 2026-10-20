import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(import.meta.dir, "prototype-shots.ts");
const STUB = join(ROOT, "scripts", "fixtures", "prototype-stub");
const EXTERNAL = join(ROOT, "scripts", "fixtures", "prototype-stub-external");

interface ShotReport {
  readonly viewports: readonly { readonly size: string; readonly words: number; readonly text: string; readonly jargon: readonly string[]; readonly scrollText?: string }[];
  readonly stages: readonly string[];
  readonly blocked: readonly string[];
  readonly errors: readonly string[];
  readonly fullText?: string;
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
