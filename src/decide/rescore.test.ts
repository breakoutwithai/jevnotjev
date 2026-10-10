import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRows, readDictRows } from "../format/csv.ts";

const ROOT = join(import.meta.dir, "..", "..");
const RUN = join(ROOT, "docs/product/runs/2026-10-01-uc13-shop-bot");
const RECORDS = join(RUN, "records.csv");
const LABELS = join(RUN, "labels.csv");
const CLI = join(ROOT, "src/decide/cli.ts");

function cli(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const done = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "" } });
  return { code: done.exitCode, stdout: done.stdout.toString(), stderr: done.stderr.toString() };
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): { readonly [key: string]: unknown } {
  if (!isRecord(value)) throw new Error("expected object");
  return value;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}
function firstVerdict(text: string): { readonly [key: string]: unknown } {
  return object(array(object(JSON.parse(text)).verdicts)[0]);
}
function expectedSeed(path: string): number {
  return createHash("sha256").update(readFileSync(path)).digest().readUInt32BE(0);
}
function withTemp(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jnj-rescore-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("rescore CLI", () => {
  test("[integration] D17-EMPTY rejects zero-byte records before manifest parsing", () => withTemp((dir) => {
    const records = join(dir, "empty-records.csv");
    const manifest = join(dir, "invalid-manifest.json");
    writeFileSync(records, "");
    writeFileSync(manifest, "not json");
    const expected = `ERROR ${records}: the file is empty: expected a header row and data rows\n`;
    for (const args of [
      ["rescore", records, "--labels", LABELS],
      ["rescore", records, "--labels", LABELS, "--manifest", manifest],
    ]) {
      const result = cli(args);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(expected);
    }
  }));

  test("[integration] D17-UC13 two runs are byte identical and match published figures", () => {
    const first = cli(["rescore", RECORDS, "--labels", LABELS]);
    const second = cli(["rescore", RECORDS, "--labels", LABELS]);
    expect(first.code).toBe(4);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(second.stdout);
    expect(createHash("sha256").update(first.stdout).digest("hex")).toBe("1f02f8560f15d041ae2498748040936f84a23e13945c50117e7ee891bc0e5d1c");
    const got = firstVerdict(first.stdout);
    const all = array(object(JSON.parse(readFileSync(join(ROOT, "site/shows/posters.json"), "utf8"))).posters);
    const uc13 = all.map(object).find((item) => item.id === "uc13");
    if (uc13 === undefined) throw new Error("uc13 poster missing");
    const published = object(uc13.run);
    expect(got.verdict).toBe(published.verdict);
    expect(got.reason).toBe(published.reason);
    const numbers = object(got.numbers);
    const pair = object(numbers.jevVsLlm);
    expect(pair.n).toBe(published.labelledPaired);
    expect(numbers.jevAccepted).toBe(38);
    expect(numbers.llmAccepted).toBe(38);
    const methods = array(published.methods).map(object);
    for (const side of [object(pair.jev), object(pair.otherArm)]) {
      const method = methods.find((item) => item.arm === side.arm);
      if (method === undefined) throw new Error(`missing poster method ${String(side.arm)}`);
      expect(side.accepted).toBe(method.accepted);
      expect(Number(Number(String(object(side.spend).usd)).toFixed(6))).toBe(Number(String(method.spendUsd)));
    }
    const rule = methods.find((item) => item.arm === "rule");
    if (rule === undefined) throw new Error("missing rule method");
    expect(object(got.ruleComparison).p1).toBe(Number(String(rule.accepted)) / 40);
    const { header, rows } = readDictRows(readFileSync(RECORDS, "utf8"));
    if (header === null) throw new Error("records header missing");
    const armAt = header.indexOf("answerer");
    const costAt = header.indexOf("cost_usd");
    const ruleSpend = rows.filter((row) => row.fields[armAt] === "rule")
      .reduce((sum, row) => sum + Number(row.fields[costAt]), 0);
    expect(Number(ruleSpend.toFixed(6))).toBe(Number(String(rule.spendUsd)));
  });

  test("[integration] D17-LABELS stripped labels rebuild the published UC13 counts", () => withTemp((dir) => {
    const baseline = cli(["rescore", RECORDS, "--labels", LABELS]);
    const { header, rows } = readDictRows(readFileSync(RECORDS, "utf8"));
    if (header === null) throw new Error("records header missing");
    const labelAt = header.indexOf("label");
    const stripped = join(dir, "stripped.csv");
    writeFileSync(stripped, formatRows([header, ...rows.map(({ fields }) => fields.map((value, i) => i === labelAt ? "" : value))]));
    const result = cli(["rescore", stripped, "--labels", LABELS]);
    expect(result.code).toBe(4);
    const actual = firstVerdict(result.stdout);
    const expected = firstVerdict(baseline.stdout);
    expect([actual.verdict, actual.reason]).toEqual([expected.verdict, expected.reason]);
    const numbers = object(actual.numbers);
    const published = object(expected.numbers);
    expect([numbers.jevAccepted, numbers.llmAccepted, object(numbers.jevVsLlm).n]).toEqual([
      published.jevAccepted, published.llmAccepted, object(published.jevVsLlm).n,
    ]);
  }));

  test("[integration] D17-LABELS changing m01 truth changes accepted counts", () => withTemp((dir) => {
    const baseline = cli(["rescore", RECORDS, "--labels", LABELS]);
    const changed = join(dir, "flipped.csv");
    writeFileSync(changed, readFileSync(LABELS, "utf8").replace("m01,hand_off", "m01,answer"));
    const result = cli(["rescore", RECORDS, "--labels", changed]);
    expect(result.code).toBe(4);
    expect(result.stdout).not.toBe(baseline.stdout);
    expect(object(firstVerdict(result.stdout).numbers).jevAccepted).not.toBe(object(firstVerdict(baseline.stdout).numbers).jevAccepted);
  }));

  test("[integration] D17-PROVENANCE retains per-case source and refuses a missing source", () => withTemp((dir) => {
    const { header, rows } = readDictRows(readFileSync(RECORDS, "utf8"));
    if (header === null) throw new Error("records header missing");
    const sourceAt = header.indexOf("label_source");
    const byAt = header.indexOf("labelled_by");
    const atAt = header.indexOf("labelled_at");
    const blindAt = header.indexOf("label_blind");
    const labelAt = header.indexOf("label");
    const path = join(dir, "provenance.csv");
    writeFileSync(path, formatRows([header, ...rows.map(({ fields }) => fields.map((value, i) =>
      fields[3] === "m01" && i === sourceAt ? "agent" :
      fields[3] === "m01" && i === byAt ? "reviewer" :
      fields[3] === "m01" && i === atAt ? "2026-10-04" :
      fields[3] === "m01" && i === blindAt ? "true" : value))]));
    const result = cli(["rescore", path, "--labels", LABELS]);
    expect(result.code).toBe(4);
    expect(object(object(firstVerdict(result.stdout).numbers).jevVsLlm).n).toBe(39);
    writeFileSync(path, formatRows([header, ...rows.map(({ fields }) => fields.map((value, i) =>
      fields[3] === "m01" && [labelAt, sourceAt, byAt, atAt, blindAt].includes(i) ? "" : value))]));
    const missing = cli(["rescore", path, "--labels", LABELS]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("records carry no label provenance for case m01");
  }));

  test("[integration] D17-TRUTH rejects values outside the question answer_set", () => withTemp((dir) => {
    const path = join(dir, "truth.csv");
    writeFileSync(path, readFileSync(LABELS, "utf8").replace("m01,hand_off", "m01,not_allowed"));
    const result = cli(["rescore", RECORDS, "--labels", path]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("m01");
    expect(result.stderr).toContain("q1");
    expect(result.stderr).toContain("answer, hand_off");
  }));

  test("[integration] D17-MANIFEST emit and verify preserves verdict bytes", () => withTemp((dir) => {
    const path = join(dir, "manifest.json");
    const first = cli(["rescore", RECORDS, "--labels", LABELS, "--write-manifest", path]);
    const second = cli(["rescore", RECORDS, "--labels", LABELS, "--manifest", path]);
    expect(first.code).toBe(4);
    expect(second.code).toBe(4);
    expect(second.stdout).toBe(first.stdout);
    const text = readFileSync(path, "utf8");
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + "\n");
    expect(text).not.toContain(ROOT);
    const manifest = object(JSON.parse(text));
    expect(manifest.format).toBe("jnj-manifest/1");
    expect(manifest.seed).toBe(2092528910);
    expect(manifest.resamples).toBe(2000);
    expect(Object.keys(object(manifest.models))).toEqual(["jev", "llm", "rule"]);
    expect(object(manifest.models).llm).toBe("claude-haiku-4-5-20251001");
    const inputs = object(manifest.inputs);
    expect(object(inputs.records).sha256).toBe(createHash("sha256").update(readFileSync(RECORDS)).digest("hex"));
    expect(object(inputs.labels).sha256).toBe(createHash("sha256").update(readFileSync(LABELS)).digest("hex"));
    expect(manifest.run_id).toBe("run-shopbot-2026-10-01");
    expect(manifest.prompt_version).toBe("shop-bot-handoff.v1");
  }));

  test("[integration] D17-MISMATCH tampered input and wrong seed exit 2 with named errors", () => withTemp((dir) => {
    const path = join(dir, "manifest.json");
    expect(cli(["rescore", RECORDS, "--labels", LABELS, "--write-manifest", path]).code).toBe(4);
    const changed = join(dir, "changed.csv");
    writeFileSync(changed, readFileSync(RECORDS, "utf8").replace("What will the snow", "What might the snow"));
    const tampered = cli(["rescore", changed, "--labels", LABELS, "--manifest", path]);
    expect(tampered.code).toBe(2);
    expect(tampered.stdout).toBe("");
    expect(tampered.stderr).toContain("records.sha256: expected");
    expect(tampered.stderr).toContain("got");
    const wrong = join(dir, "wrong.json");
    const saved = object(JSON.parse(readFileSync(path, "utf8")));
    writeFileSync(wrong, JSON.stringify({ ...saved, seed: Number(String(saved.seed)) + 1 }));
    const badSeed = cli(["rescore", RECORDS, "--labels", LABELS, "--manifest", wrong]);
    expect(badSeed.code).toBe(2);
    expect(badSeed.stdout).toBe("");
    expect(badSeed.stderr).toContain("seed: expected");
    writeFileSync(wrong, JSON.stringify({ ...saved, resamples: 1000 }));
    const badResamples = cli(["rescore", RECORDS, "--labels", LABELS, "--manifest", wrong]);
    expect(badResamples.code).toBe(2);
    expect(badResamples.stderr).toContain("resamples: expected 2000, got 1000");
  }));

  test("[integration] D17-MANIFEST rejects extra top-level and models keys", () => withTemp((dir) => {
    const path = join(dir, "manifest.json");
    expect(cli(["rescore", RECORDS, "--labels", LABELS, "--write-manifest", path]).code).toBe(4);
    const saved = object(JSON.parse(readFileSync(path, "utf8")));
    writeFileSync(path, JSON.stringify({ ...saved, extra: "value" }));
    const extra = cli(["rescore", RECORDS, "--labels", LABELS, "--manifest", path]);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain("extra");
    writeFileSync(path, JSON.stringify({ ...saved, models: { ...object(saved.models), unexpected: "model" } }));
    const model = cli(["rescore", RECORDS, "--labels", LABELS, "--manifest", path]);
    expect(model.code).toBe(2);
    expect(model.stderr).toContain("models.unexpected");
  }));

  test("[integration] D17-MANIFEST refuses symlink to an input", () => withTemp((dir) => {
    const labelsCopy = join(dir, "labels.csv");
    writeFileSync(labelsCopy, readFileSync(LABELS));
    const link = join(dir, "manifest.json");
    symlinkSync(labelsCopy, link);
    const before = readFileSync(labelsCopy, "utf8");
    const result = cli(["rescore", RECORDS, "--labels", labelsCopy, "--write-manifest", link]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("input file");
    expect(readFileSync(labelsCopy, "utf8")).toBe(before);
  }));

  test("[integration] D17-MANIFEST refuses hard link to each input", () => withTemp((dir) => {
    const recordsCopy = join(dir, "records.csv");
    const labelsCopy = join(dir, "labels.csv");
    const savedManifest = join(dir, "saved.json");
    writeFileSync(recordsCopy, readFileSync(RECORDS));
    writeFileSync(labelsCopy, readFileSync(LABELS));
    expect(cli(["rescore", recordsCopy, "--labels", labelsCopy, "--write-manifest", savedManifest]).code).toBe(4);
    const inputs: readonly (readonly [string, string])[] = [["records", recordsCopy], ["labels", labelsCopy], ["manifest", savedManifest]];
    for (const [name, input] of inputs) {
      const target = join(dir, `${name}-target.json`);
      linkSync(input, target);
      const before = readFileSync(input);
      const result = cli(["rescore", recordsCopy, "--labels", labelsCopy, "--manifest", savedManifest, "--write-manifest", target]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("input file");
      expect(readFileSync(input)).toEqual(before);
    }
  }));

  test("[integration] D17-LABELS missing, unknown and empty truth rows exit 2", () => withTemp((dir) => {
    const { header, rows } = readDictRows(readFileSync(LABELS, "utf8"));
    if (header === null) throw new Error("labels header missing");
    const missing = join(dir, "missing.csv");
    writeFileSync(missing, formatRows([header, ...rows.slice(1).map((row) => row.fields)]));
    const noM01 = cli(["rescore", RECORDS, "--labels", missing]);
    expect(noM01.code).toBe(2);
    expect(noM01.stderr).toContain("missing case_id m01");
    const unknown = join(dir, "unknown.csv");
    writeFileSync(unknown, formatRows([header, ...rows.map((row) => row.fields), ["m41", "answer"]]));
    const extra = cli(["rescore", RECORDS, "--labels", unknown]);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain("m41");
    const empty = join(dir, "empty.csv");
    writeFileSync(empty, formatRows([header]));
    const noLabels = cli(["rescore", RECORDS, "--labels", empty]);
    expect(noLabels.code).toBe(2);
    expect(noLabels.stderr).toContain("empty");
    writeFileSync(empty, "");
    const zeroBytes = cli(["rescore", RECORDS, "--labels", empty]);
    expect(zeroBytes.code).toBe(2);
    expect(zeroBytes.stderr).toContain("empty");
  }));

  test("[integration] D17-USAGE missing --labels exits 2 and prints usage", () => {
    const done = cli(["rescore", RECORDS]);
    expect(done.code).toBe(2);
    expect(done.stdout).toBe("");
    expect(done.stderr).toContain("--labels");
    expect(done.stderr).toContain("Usage:");
  });

  test("[integration] D17-168 d06 carries only bootstrap seed and resample count", () => {
    const input = join(ROOT, "examples/d06-tiny/records.csv");
    const done = cli(["verdict", input]);
    expect(done.code).toBe(4);
    const pair = object(object(firstVerdict(done.stdout).numbers).jevVsLlm);
    expect(pair).not.toHaveProperty("wilson1");
    expect(pair).not.toHaveProperty("wilson2");
    expect(pair).not.toHaveProperty("phi");
    expect(object(pair.bootstrap)).toEqual({ seed: expectedSeed(input), resamples: 2000 });
  });

  test("[integration] D17-168 rule comparison carries only bootstrap metadata", () => {
    const input = join(ROOT, "examples/d08-verdicts/r3-use-jev.csv");
    const done = cli(["verdict", input]);
    expect(done.code).toBe(0);
    const rule = object(firstVerdict(done.stdout).ruleComparison);
    expect(rule.kind).toBe("compared");
    expect(rule).not.toHaveProperty("wilson1");
    expect(rule).not.toHaveProperty("wilson2");
    expect(rule).not.toHaveProperty("phi");
    expect(object(rule.bootstrap)).toEqual({ seed: expectedSeed(input), resamples: 2000 });
  });

  test("[integration] D17-168 D08 verdict name, rule, condition and reason remain unchanged", () => {
    const expected: Readonly<Record<string, readonly [string, number, string, string]>> = {
      "r1-29-paired": ["not enough evidence", 1, "too-few-paired", "not enough evidence: 29 paired Jev and LLM cases, fewer than 30; add 1 more labelled case"],
      "r1-both-zero": ["not enough evidence", 1, "zero-accepted", "not enough evidence: Jev and the LLM both accepted 0 of 30 paired cases, so neither has a cost per accepted answer; check both arms' labels"],
      "r1-jev-zero": ["not enough evidence", 1, "zero-accepted", "not enough evidence: Jev accepted 0 of 30 paired cases and the LLM 1, so Jev has no cost per accepted answer; check the Jev labels"],
      "r1-llm-zero": ["not enough evidence", 1, "zero-accepted", "not enough evidence: the LLM accepted 0 of 30 paired cases and Jev 1, so the LLM has no cost per accepted answer; check the LLM labels"],
      "r1-cost-missing": ["not enough evidence", 1, "cost-missing", "not enough evidence: cost missing on a paired Jev or LLM row, so the cost ratio would look complete on partial spend"],
      "r1-no-jev": ["not enough evidence", 1, "no-jev-rows", "not enough evidence: no Jev results"],
      "r1-no-llm": ["not enough evidence", 1, "no-llm-rows", "not enough evidence: no LLM results"],
      "r2-jev-dearer": ["don't use Jev", 2, "jev-clearly-dearer", "don't use Jev: Jev is clearly dearer (cost ratio 1.800, lower bound 1.600, above 1)"],
      "r2-jev-worse": ["don't use Jev", 2, "jev-clearly-worse", "don't use Jev: Jev is clearly worse than the LLM (upper bound of Jev minus LLM -0.30, below -0.10)"],
      "r2-rule-within-margin": ["don't use Jev", 2, "rule-within-margin", "don't use Jev: the rule is within 10 points of Jev (lower bound of rule minus Jev -0.03, above -0.10, on 30 paired cases); a free rule does the job"],
      "r3-use-jev": ["use Jev", 3, "use-jev", "use Jev: Jev is within 10 points of the LLM (lower bound -0.03) and costs 0.009 of it per accepted answer (upper bound 0.010)"],
      "r4-accept-rate": ["not enough evidence", 4, "accept-rate-not-shown", "not enough evidence: Jev is not shown within 10 points of the LLM (lower bound of Jev minus LLM -0.11, not above -0.10)"],
      "r4-cheaper-under-20": ["not enough evidence", 4, "cheaper-by-less-than-20", "not enough evidence: cheaper, but by less than 20% (cost ratio 0.900); the cost ratio's upper bound 1.000 is not below 1"],
    };
    for (const [name, fields] of Object.entries(expected)) {
      const got = firstVerdict(cli(["verdict", join(ROOT, `examples/d08-verdicts/${name}.csv`)]).stdout);
      expect([got.verdict, got.rule, got.condition, got.reason]).toEqual([...fields]);
    }
  });
});
