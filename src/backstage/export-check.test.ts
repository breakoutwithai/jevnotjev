import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExport, checkExportText, findCredentials } from "./export-check.ts";
import { CALC_VERSION } from "./contracts.ts";
import { SAMPLE_EXPORT_PATH, sampleExportText } from "../../scripts/d17-sample-export.ts";

const fixtureText = readFileSync(SAMPLE_EXPORT_PATH, "utf8");
function fixture(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fixtureText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("fixture is not an object");
  return { ...parsed };
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected a list");
  return value;
}
// Built from parts so no scanner reads the test file as holding a key.
const FAKE_KEYS = [
  "sk-" + "ant-" + "api03-" + "x".repeat(24),
  "sk-" + "proj-" + "A1b2C3d4E5f6G7h8I9j0",
  "xai-" + "Q".repeat(24),
  "AI" + "za" + "S".repeat(35),
  "Bear" + "er " + "eyJhbGciOiJIUzI1NiJ9.payload",
];

describe("D17 export check", () => {
  test("[integration] D17 sample export reloads ok and every verdict recomputes equal", async () => {
    const result = await checkExportText(fixtureText);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.calcVersion).toBe(CALC_VERSION);
    expect(result.cases).toBe(32);
    expect(result.labels).toBe(96);
    expect(result.totalSpend?.unknown).toBe(0);
    expect(result.verdicts.length).toBeGreaterThan(0);
    for (const v of result.verdicts) {
      expect(v.matches).toBe(true);
      expect(v.recomputed).toBe(v.exported);
    }
    expect(result.verdicts.map((v) => v.recomputed)).toEqual(["use Jev"]);
  });

  test("[integration] D17 committed sample equals a freshly generated export", async () => {
    expect(await sampleExportText()).toBe(fixtureText);
  });

  test("[unit] D17 tampering one exported label is reported as a mismatch", async () => {
    const data = fixture();
    const labels = list(data.labels).map((l) => (typeof l === "object" && l !== null ? { ...l } : l));
    const target = labels.findIndex(
      (l) => typeof l === "object" && l !== null && "armId" in l && l.armId === "jev" && "label" in l && l.label === "accept",
    );
    expect(target).toBeGreaterThanOrEqual(0);
    const entry = labels[target];
    if (typeof entry !== "object" || entry === null) throw new Error("no label entry");
    labels[target] = { ...entry, label: "reject" };
    const result = await checkExport({ ...data, labels });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith("label mismatch: case"))).toBe(true);
    expect(result.verdicts[0]?.matches).toBe(false);
  });

  test("[unit] D17 a tampered recorded verdict is reported as a mismatch", async () => {
    const data = fixture();
    const verdicts = list(data.verdicts).map((v) =>
      typeof v === "object" && v !== null && "verdict" in v && typeof v.verdict === "object" && v.verdict !== null
        ? { ...v, verdict: { ...v.verdict, verdict: "don't use Jev" } }
        : v,
    );
    const result = await checkExport({ ...data, verdicts });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith("verdict mismatch"))).toBe(true);
  });

  test("[unit] D17 a key-shaped string anywhere in the export is refused", async () => {
    for (const key of FAKE_KEYS) {
      const inLabel = fixture();
      const labels = list(inLabel.labels).map((l, i) =>
        i === 3 && typeof l === "object" && l !== null ? { ...l, output: "answer " + key } : l,
      );
      const placements: Record<string, unknown>[] = [
        { ...inLabel, labels },
        { ...fixture(), comparisonNote: key },
        { ...fixture(), extra: { nested: [{ header: key }] } },
      ];
      for (const data of placements) {
        const result = await checkExport(data);
        expect(result.ok).toBe(false);
        expect(result.problems[0]).toContain("looks like a credential");
        expect(JSON.stringify(result)).not.toContain(key);
      }
    }
    expect(findCredentials(JSON.parse(fixtureText))).toEqual([]);
  });

  test("[unit] D17 a supplied exact key value is refused, as containsKey does for a live run", async () => {
    const data = { ...fixture(), comparisonNote: "plain-value-0123" };
    expect((await checkExport(data)).ok).toBe(true);
    const result = await checkExport(data, { knownKeys: ["plain-value-0123"] });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("$.comparisonNote: contains a supplied key");
  });

  test("[unit] D17 a missing or different calcVersion is refused with a clear message", async () => {
    const { calcVersion: _drop, ...missing } = fixture();
    const noVersion = await checkExport(missing);
    expect(noVersion.ok).toBe(false);
    expect(noVersion.problems.some((p) => p.startsWith("No calcVersion"))).toBe(true);
    const other = await checkExport({ ...fixture(), calcVersion: "verdict/0" });
    expect(other.ok).toBe(false);
    expect(other.problems).toContain(
      `This export was made with a different calculation (verdict/0); this build runs ${CALC_VERSION}, so its verdicts cannot be reproduced here.`,
    );
  });

  test("[integration] D17 inspect-export CLI exits 0 on the sample and 1 on a copy holding a key", async () => {
    const cli = new URL("../../scripts/inspect-export.ts", import.meta.url).pathname;
    const run = async (file: string) => {
      const proc = Bun.spawn(["bun", cli, file], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      return { code: await proc.exited, out };
    };
    const ok = await run(SAMPLE_EXPORT_PATH);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`calcVersion: ${CALC_VERSION}`);
    expect(ok.out).toContain("problems: 0");
    const dir = mkdtempSync(join(tmpdir(), "d17-inspect-"));
    try {
      const tampered = join(dir, "export.json");
      const key = "sk-" + "ant-" + "k".repeat(40);
      writeFileSync(tampered, JSON.stringify({ ...fixture(), comparisonNote: key }));
      const bad = await run(tampered);
      expect(bad.code).toBe(1);
      expect(bad.out).toContain("looks like a credential");
      expect(bad.out).not.toContain(key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[unit] D17 null verdicts, bad JSON and a non-object are refused", async () => {
    const nullVerdicts = await checkExport({ ...fixture(), verdicts: null });
    expect(nullVerdicts.ok).toBe(false);
    expect(nullVerdicts.problems).toContain("verdicts is null: the export records no verdict to reproduce.");
    expect((await checkExportText("{not json")).problems).toEqual(["The export is not valid JSON."]);
    expect((await checkExport([1, 2])).ok).toBe(false);
  });
});
