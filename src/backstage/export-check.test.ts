import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkExport, checkExportText, findCredentials } from "./export-check.ts";
import { CALC_VERSION, type Scene } from "./contracts.ts";
import { BackstageRun, cohortVerdict } from "./run.ts";
import { EXPORT_COLUMNS } from "./records.ts";
import { formatRows } from "../format/csv.ts";
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
// KEY CORPUS: one realistic fake per shape CREDENTIAL_PATTERNS lists, built from parts so no scanner reads this file
// as holding a key. Every entry must be refused and never echoed (the corpus tests below).
const KEY_CORPUS: readonly (readonly [shape: string, key: string])[] = [
  ["Anthropic sk-ant-api03-", "sk-" + "ant-" + "api03-" + "Zq8_Lm2-".repeat(11) + "AA"],
  ["OpenAI sk-proj-", "sk-" + "proj-" + "A1b2C3d4E5f6G7h8_".repeat(9)],
  ["OpenAI legacy sk-", "sk-" + "T3Blbk" + "FJa1B2c3D4".repeat(4)],
  ["xAI xai-", "xai-" + "Q7wErT9y".repeat(10)],
  ["Google AIza", "AI" + "za" + "SyD9x_k".repeat(5)],
  ["GitHub ghp_", "gh" + "p_" + "a1B2c3".repeat(6)],
  ["Bearer JWT", "Bear" + "er " + "eyJhbGciOiJIUzI1NiJ9.payload"],
  ["lowercase bearer", "authorization: bear" + "er abc123DEF456ghi789JKL0"],
];
const FAKE_KEYS = KEY_CORPUS.map(([, key]) => key);

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
    const other = await checkExport({ ...fixture(), calcVersion: "verdict/1" });
    expect(other.ok).toBe(false);
    expect(other.problems).toContain(`calcVersion differs from ${CALC_VERSION}: this build cannot reproduce its verdicts.`);
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
      const key = "sk-" + "ant-" + "k9".repeat(20);
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
    const key = "sk-" + "ant-" + "z1".repeat(20);
    for (const data of [
      // The descendant value matches too, so its path would carry the parent key unless the segment is redacted.
      { ...fixture(), extra: { [key]: { child: "plain", deeper: [{ more: "xai-" + "y1".repeat(20) }] } } },
      { ...fixture(), calcVersion: key },
      { ...fixture(), calcVersion: "verdict/1 " + key },
    ]) {
      const result = await checkExport(data);
      expect(result.ok).toBe(false);
      expect(result.calcVersion).toBeNull();
      expect(result.problems[0]).toContain("looks like a credential");
      expect(JSON.stringify(result)).not.toContain(key);
      expect(JSON.stringify(result)).not.toContain("z1z1z1z1");
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
      const key = "sk-" + "ant-" + "q7".repeat(20);
      writeFileSync(file, JSON.stringify({ ...fixture(), calcVersion: key, extra: { [key]: { a: "b" } } }));
      const proc = Bun.spawn(["bun", cli, file], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(1);
      expect(out).toContain("looks like a credential");
      expect(out).not.toContain("q7q7q7q7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("D17 export check: round-2 fixes (#187)", () => {
  const SCENE: Scene = {
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
  async function emptyExport(): Promise<Obj> {
    const run = new BackstageRun(SCENE, "d17-empty", { arms: ["jev", "claude-haiku-4-5-20251001", "rule"] });
    await run.report();
    return obj(JSON.parse(JSON.stringify(run.evidence())));
  }

  /** A real run whose one case is `input`, labelled, revealed and reported, exported as evidence() writes it. */
  async function caseExport(input: string): Promise<string> {
    const scene: Scene = { ...SCENE, cases: [{ id: "c01", input }] };
    const run = new BackstageRun(scene, "d17-corpus", { arms: ["jev", "claude-haiku-4-5-20251001", "rule"] });
    await run.report();
    return JSON.stringify(run.evidence());
  }

  // PROSE CORPUS: text a user might type into a case or question. None of it is a credential, so every line must
  // export and check ok. Any change to CREDENTIAL_PATTERNS is checked against this list and KEY_CORPUS together.
  const PROSE_CORPUS: readonly string[] = [
    "token: pending-approval-from-security-2026",
    "password: reset-required-after-90-days",
    "Bump api_version_2026_10_11",
    "api-v2-endpoint-latency-p99 dashboard",
    "secret = rotated-quarterly-since-2024",
    "task-runner sk-learn-pipeline-model-v3",
    "Bearer authentication broke",
    "bearer bonds",
    "bearer of bad news: the 2026 budget is cut",
    "API keys are rotated monthly",
    "password reset flow",
    "Our api-gateway latency doubled; Bearer authentication broke",
    "Bearer token expired at 2026-10-11 12:00 UTC",
    "Customer said: my api key stopped working after the 2026-09-30 rotation",
    "Rotate the secret key every 90 days per policy SEC-0042",
    "The authorization header was missing entirely",
    "Upgraded from v1.13.0 to v2.0.0-rc.4 last week",
    "jev-1.13.0 answered in 812 ms",
    "Ticket billing-refund-escalation-2026-q3-eu-west-1 reopened",
    "Request 3f2b9c1e-7a4d-4e5f-9b8a-1c2d3e4f5a6b failed",
    "Fixed in commit 1bb6ee2d8ee7da9611c8e4b13ee84c7c520aa11",
    "Deployed f0d93b9 on 2026-10-11T09:30:00Z",
    "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "See https://jevnotjev.breakoutwithai.com/backstage?scene=p1#reveal",
    "Docs at https://docs.anthropic.com/en/api/messages",
    "Model claude-haiku-4-5-20251001 was slower than gpt-6.1-sol",
    "Compared gemini-2.5-flash with grok-4.5 and claude-opus-5-5",
    "SKUs sk-1234 and sk-5678 are out of stock",
    "xai-grok integration lands next quarter",
    "AIza is how Google keys start",
    "ghp_ prefixes mark GitHub personal tokens",
    "Order A1B2C3-2026-10-11 shipped to Unit 4B, 221B Baker Street",
    "secret_santa_2025_list_final_v2.xlsx",
  ];

  test("[unit] D17 PROSE CORPUS: every line in a real scene case exports and checks ok", async () => {
    expect(PROSE_CORPUS.length).toBeGreaterThanOrEqual(30);
    const refused: string[] = [];
    for (const line of PROSE_CORPUS) {
      if (findCredentials({ note: line }).length > 0) refused.push(line);
      const result = await checkExportText(await caseExport(line));
      if (!result.ok) refused.push(`${line} -> ${result.problems.join("; ")}`);
    }
    expect(refused).toEqual([]);
  });

  test("[unit] D17 the credential scan is linear: 2 MB adversarial strings per prefix scan in well under 2 s", () => {
    const size = 2 * 1024 * 1024;
    const seeds = ["sk-ant-", "sk-proj-", "sk-", "xai-", "AIza", "ghp_", "bearer ", "Bearer  ", "a-", "sk-a-"];
    const started = performance.now();
    for (const seed of seeds) expect(findCredentials({ note: seed.repeat(Math.ceil(size / seed.length)) })).toEqual([]);
    expect(findCredentials({ note: "sk-" + "ant-" + "a".repeat(size) })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("[unit] D17 KEY CORPUS: every supported key shape in a real scene case is refused, never echoed", async () => {
    expect(KEY_CORPUS.length).toBe(8);
    for (const [shape, key] of KEY_CORPUS) {
      for (const text of [await caseExport("Customer pasted " + key + " by mistake"), JSON.stringify({ ...fixture(), comparisonNote: key })]) {
        const result = await checkExportText(text);
        expect({ shape, ok: result.ok }).toEqual({ shape, ok: false });
        expect(result.problems[0]).toContain("looks like a credential");
        expect(JSON.stringify(result)).not.toContain(key);
      }
    }
  });

  test("[unit] D17 problems never echo an untrusted string: calcVersion, mode, case or arm ids", async () => {
    const calc = await checkExport({ ...fixture(), calcVersion: "calc-marker-v9" });
    expect(calc.problems).toContain(`calcVersion differs from ${CALC_VERSION}: this build cannot reproduce its verdicts.`);
    expect(JSON.stringify(calc.problems)).not.toContain("calc-marker");
    const mode = await problemsOf(tampered((d) => void (manifestOf(d).mode = "mode-marker")));
    expect(has(mode, "manifest.mode must be")).toBe(true);
    expect(JSON.stringify(mode)).not.toContain("mode-marker");
    const orphan = await problemsOf(
      tampered((d) => {
        const labels = list(d.labels);
        labels.push({ ...obj(labels[0]), caseId: "case-marker" });
        labels.push({ ...obj(labels[0]) });
        obj(list(d.attempts)[0]).caseId = "attempt-case-marker";
      }),
    );
    expect(orphan.length).toBeGreaterThan(2);
    for (const marker of ["case-marker", "attempt-case-marker", "c01"]) expect(JSON.stringify(orphan)).not.toContain(marker);
  });

  test("[integration] D17 inspect-export states the contract and never prints an untrusted calcVersion", async () => {
    const cli = fileURLToPath(new URL("../../scripts/inspect-export.ts", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "d17-inspect-"));
    try {
      const file = join(dir, "export.json");
      writeFileSync(file, JSON.stringify({ ...fixture(), calcVersion: "calc-marker-v9" }));
      const proc = Bun.spawn(["bun", cli, file], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(1);
      expect(out).toContain("Checks reproducibility and credentials; not proof the file came from a real run.");
      expect(out).toContain(`calcVersion: (differs from ${CALC_VERSION})`);
      expect(out).not.toContain("calc-marker");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[unit] D17 cohortVerdict is the one chain: equals the exported verdict, empty cohorts have none", async () => {
    const data = fixture();
    const manifest = manifestOf(data);
    const comparison = firstComparison(data);
    const context = {
      mode: "compare",
      key: { runId: String(comparison.runId), promptVersion: String(manifest.promptVersion), questionId: String(manifest.questionId) },
      question: String(obj(manifest.scene).question),
      answerSet: "yes|no",
    };
    const full = await cohortVerdict(String(comparison.csv), context, false);
    if (!full.ok) throw new Error("the sample's records failed validation");
    expect(JSON.parse(JSON.stringify(full.verdict))).toEqual(firstVerdict(data).verdict);
    const header = formatRows([EXPORT_COLUMNS]);
    const empty = await cohortVerdict(header, context, true);
    if (!empty.ok) throw new Error("an empty cohort failed");
    expect(empty.verdict).toBeNull();
    expect(empty.metrics.cases).toBe(0);
    expect((await cohortVerdict(header, context, false)).ok).toBe(false);
    const jevOnly = await cohortVerdict(String(comparison.csv), { ...context, mode: "jev-only" }, false);
    expect(jevOnly.ok && jevOnly.verdict).toBeNull();
  });

  test("[unit] D17 an empty export's scene gets the run constructor's validation", async () => {
    expect((await checkExport(await emptyExport())).problems).toEqual([]);
    const changes: ((scene: Obj) => void)[] = [
      (s) => void (obj(list(s.choices)[1]).name = obj(list(s.choices)[0]).name),
      (s) => void (obj(list(s.cases)[0]).input = ""),
      (s) => void (obj(list(s.cases)[0]).id = ""),
      (s) => void (s.matchChoice = "maybe"),
    ];
    for (const change of changes) {
      const data = await emptyExport();
      change(obj(manifestOf(data).scene));
      expect(has(await problemsOf(data), "manifest.scene")).toBe(true);
    }
  });
});
