import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkExport, checkExportText, findCredentials } from "./export-check.ts";
import { CALC_VERSION, type Scene } from "./contracts.ts";
import { BackstageRun } from "./run.ts";
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
    expect(result.problems.some((p) => p.includes("records differ") && p.includes("column label)"))).toBe(true);
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
    const cli = fileURLToPath(new URL("../../scripts/inspect-export.ts", import.meta.url));
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

type Obj = Record<string, unknown>;
function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function obj(value: unknown): Obj {
  if (!isObj(value)) throw new Error("expected an object");
  return value;
}
/** A deep copy of the sample with `change` applied in place. */
function tampered(change: (data: Obj) => void): Obj {
  const data = obj(JSON.parse(fixtureText));
  change(data);
  return data;
}
function manifestOf(data: Obj): Obj {
  return obj(data.manifest);
}
function firstComparison(data: Obj): Obj {
  return obj(list(data.comparisons)[0]);
}
function firstVerdict(data: Obj): Obj {
  return obj(list(data.verdicts)[0]);
}
async function problemsOf(data: unknown): Promise<string[]> {
  const result = await checkExport(data);
  expect(result.ok).toBe(false);
  return [...result.problems];
}
function has(problems: readonly string[], part: string): boolean {
  return problems.some((p) => p.includes(part));
}

describe("D17 export check: reviewed defects (#187)", () => {
  test("[unit] D17 credential rejection echoes no untrusted value: redacted key paths, no calcVersion", async () => {
    const key = "sk-" + "ant-" + "z".repeat(30);
    for (const data of [
      // The descendant value matches too, so its path would carry the parent key unless the segment is redacted.
      { ...fixture(), extra: { [key]: { child: "plain", deeper: [{ more: "token: " + "y".repeat(12) }] } } },
      { ...fixture(), calcVersion: key },
      { ...fixture(), calcVersion: "verdict/1 " + key },
    ]) {
      const result = await checkExport(data);
      expect(result.ok).toBe(false);
      expect(result.calcVersion).toBeNull();
      expect(result.problems[0]).toContain("looks like a credential");
      expect(JSON.stringify(result)).not.toContain(key);
      expect(JSON.stringify(result)).not.toContain("zzzzzzzz");
    }
  });

  test("[unit] D17 a manifest mode that is unknown or disagrees with the arms is refused", async () => {
    for (const mode of ["banana", "jev-only"]) {
      const problems = await problemsOf(
        tampered((d) => {
          manifestOf(d).mode = mode;
          firstVerdict(d).verdict = null;
        }),
      );
      expect(has(problems, "manifest.mode must be")).toBe(true);
    }
  });

  test("[unit] D17 label provenance and output are carried into the recompute and reconciled", async () => {
    const agent = await checkExport(
      tampered((d) => {
        for (const l of list(d.labels)) obj(l).labelSource = "agent";
      }),
    );
    expect(agent.ok).toBe(false);
    expect(agent.verdicts[0]?.recomputed).not.toBe("use Jev");
    expect(agent.verdicts[0]?.matches).toBe(false);
    const output = await problemsOf(
      tampered((d) => {
        const l = obj(list(d.labels)[0]);
        l.output = l.output === "yes" ? "no" : "yes";
      }),
    );
    expect(has(output, "output")).toBe(true);
  });

  test("[unit] D17 duplicate, contradictory, orphan or garbage labels are refused", async () => {
    const duplicate = await problemsOf(
      tampered((d) => {
        const labels = list(d.labels);
        const first = obj(labels[0]);
        labels.push({ ...first, label: first.label === "accept" ? "reject" : "accept" });
      }),
    );
    expect(has(duplicate, "duplicate label")).toBe(true);
    const garbage = await problemsOf(
      tampered((d) => {
        const labels = list(d.labels);
        labels.push({ ...obj(labels[0]), caseId: "c99", label: "garbage" });
      }),
    );
    expect(has(garbage, "label value")).toBe(true);
    const orphan = await problemsOf(
      tampered((d) => {
        const labels = list(d.labels);
        labels.push({ ...obj(labels[0]), caseId: "c99" });
      }),
    );
    expect(has(orphan, "no answer")).toBe(true);
  });

  test("[unit] D17 comparisons and verdicts must correspond 1:1 with the manifest's pairs", async () => {
    const dupComparison = await problemsOf(tampered((d) => void list(d.comparisons).push({ ...firstComparison(d) })));
    expect(has(dupComparison, "comparisons must be")).toBe(true);
    const dupVerdict = await problemsOf(tampered((d) => void list(d.verdicts).push({ ...firstVerdict(d) })));
    expect(has(dupVerdict, "verdicts must be")).toBe(true);
    const stray = await problemsOf(tampered((d) => void list(d.verdicts).push({ ...firstVerdict(d), armId: "other-arm" })));
    expect(has(stray, "verdicts must be")).toBe(true);
    const none = await problemsOf(tampered((d) => void (d.verdicts = [])));
    expect(has(none, "verdicts must be")).toBe(true);
  });

  test("[unit] D17 protocol version, an empty scene and altered case input are refused", async () => {
    expect(has(await problemsOf(tampered((d) => void (d.version = "backstage/0"))), "version must be")).toBe(true);
    const empty = await problemsOf(tampered((d) => void (obj(manifestOf(d).scene).cases = [])));
    expect(has(empty, "at least one case")).toBe(true);
    const input = await problemsOf(
      tampered((d) => void (obj(list(obj(manifestOf(d).scene).cases)[0]).input = "Case 1: someone else entirely")),
    );
    expect(has(input, "records differ")).toBe(true);
  });

  test("[unit] D17 top-level records and attempts are reconciled with the comparisons and answers", async () => {
    expect(has(await problemsOf(tampered((d) => void (d.records = "broken csv"))), "records differ")).toBe(true);
    expect(has(await problemsOf(tampered((d) => void (d.attempts = []))), "no successful attempt")).toBe(true);
    const output = await problemsOf(
      tampered((d) => {
        const a = obj(list(d.attempts)[0]);
        a.output = a.output === "yes" ? "no" : "yes";
      }),
    );
    expect(has(output, "output")).toBe(true);
    const cost = await problemsOf(tampered((d) => void (obj(list(d.attempts)[0]).costUsd = 0.5)));
    expect(has(cost, "records differ")).toBe(true);
    expect(has(cost, "totalSpend does not match")).toBe(true);
  });

  test("[unit] D17 spend must be finite, non-negative and equal to the attempts' accounting", async () => {
    const cases: [string, number][] = [
      ["knownUsd", -1],
      ["knownUsd", Infinity],
      ["unknown", 0.5],
      ["unknown", -1],
    ];
    for (const [field, value] of cases) {
      const problems = await problemsOf(tampered((d) => void (obj(d.totalSpend)[field] = value)));
      expect(has(problems, `totalSpend.${field} must be`)).toBe(true);
    }
    expect(has(await problemsOf(tampered((d) => void (obj(d.totalSpend).knownUsd = 1))), "totalSpend does not match")).toBe(true);
    expect(has(await problemsOf(tampered((d) => void (obj(d.extraSpend).unknown = 2))), "extraSpend does not match")).toBe(true);
  });

  test("[unit] D17 an absent cohort is a problem, not a thrown error", async () => {
    const changes: ((d: Obj) => void)[] = [
      (d) => void (firstComparison(d).runId = "other-run"),
      (d) => void (manifestOf(d).promptVersion = "other-prompt"),
      (d) => void (manifestOf(d).questionId = "other-question"),
    ];
    for (const change of changes) {
      const result = await checkExport(tampered(change));
      expect(result.ok).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(has(result.problems, "could not be checked")).toBe(false);
    }
  });

  test("[unit] D17 a valid empty run exported after report() checks ok", async () => {
    const scene: Scene = {
      question: "Is this person a qualified TypeScript builder?",
      choices: [
        { name: "yes", definition: "Builds software in TypeScript" },
        { name: "no", definition: "Does not build software in TypeScript" },
      ],
      acceptance: "The answer matches the person described",
      exclusions: "None",
      keywords: ["typescript"],
      matchChoice: "yes",
      otherwiseChoice: "no",
      cases: [{ id: "c01", input: "Case 1: TypeScript builder" }],
    };
    const run = new BackstageRun(scene, "d17-empty", { arms: ["jev", "claude-haiku-4-5-20251001", "rule"] });
    await run.report();
    const text = JSON.stringify(run.evidence());
    const result = await checkExportText(text);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.verdicts.map((v) => v.recomputed)).toEqual([null]);
    const claimed = { ...obj(JSON.parse(text)), verdicts: [{ armId: "claude-haiku-4-5-20251001", runId: run.manifest.runId, verdict: { verdict: "use Jev" } }] };
    expect(has(await problemsOf(claimed), "verdict mismatch")).toBe(true);
  });

  test("[unit] D17 checkExportText never throws on malformed or hostile JSON", async () => {
    const deep = "[".repeat(20000) + "]".repeat(20000);
    const deepResult = await checkExportText(`{"extra":${deep}}`);
    expect(deepResult.ok).toBe(false);
    expect(has(deepResult.problems, "nests deeper than")).toBe(true);
    const base = fixture();
    const manifest = obj(base.manifest);
    const inputs: unknown[] = [
      null,
      1,
      "x",
      [],
      {},
      { ...base, manifest: null },
      { ...base, manifest: { ...manifest, scene: 5 } },
      { ...base, manifest: { ...manifest, arms: "jev" } },
      { ...base, manifest: { ...manifest, scene: { ...obj(manifest.scene), cases: [null, { id: 1 }] } } },
      { ...base, labels: [null, 1, "x"] },
      { ...base, attempts: [null, { ok: "yes" }] },
      { ...base, comparisons: [{ armId: 1 }] },
      { ...base, verdicts: [7] },
      { ...base, totalSpend: "lots" },
      { ...base, records: 5 },
      { ...base, suggestionAttempts: {} },
    ];
    for (const input of inputs) {
      const result = await checkExportText(JSON.stringify(input));
      expect(result.ok).toBe(false);
      expect(has(result.problems, "could not be checked")).toBe(false);
    }
  });

  test("[integration] D17 inspect-export CLI prints no credential carried in calcVersion or a key name", async () => {
    const cli = fileURLToPath(new URL("../../scripts/inspect-export.ts", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "d17-inspect-"));
    try {
      const file = join(dir, "export.json");
      const key = "sk-" + "ant-" + "q".repeat(40);
      writeFileSync(file, JSON.stringify({ ...fixture(), calcVersion: key, extra: { [key]: { a: "b" } } }));
      const proc = Bun.spawn(["bun", cli, file], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(1);
      expect(out).toContain("looks like a credential");
      expect(out).not.toContain("qqqqqqqq");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
