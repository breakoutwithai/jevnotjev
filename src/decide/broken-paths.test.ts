import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES_ENV } from "./cli-args.ts";
import { readDictRows } from "../format/csv.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(import.meta.dir, "cli.ts");
const EXAMPLES = join(ROOT, "examples", "d08-verdicts");
const QUESTION = JSON.stringify([{ name: "q", type: "noul", instructions: "Is this useful?" }]);
const CASE = JSON.stringify({ id: "c1", input: "A shop question" });
const KEY = "private-test-key";
const RECORD_COMMANDS: readonly (readonly [string, number])[] = [["verdict", 2], ["validate", 1]];
const EMPTY_CASE_FILES: readonly (readonly [string, string])[] = [["empty.jsonl", ""], ["empty.json", "[]"]];
const VERDICT_CASES: readonly (readonly [string, string, string])[] = [
  ["r1-both-zero.csv", "both-zero-accepted", "not enough evidence: Jev and the LLM both have 0 accepted; neither answer is being accepted"],
  ["r1-no-jev.csv", "no-jev-rows", "not enough evidence: no Jev results"],
  ["r1-no-llm.csv", "no-llm-rows", "not enough evidence: no LLM results"],
];
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}
function errorRow(body: unknown, arm: string, reason: string): void {
  const rows = field(body, "rows");
  expect(Array.isArray(rows)).toBe(true);
  if (!Array.isArray(rows)) return;
  expect(rows).toHaveLength(1);
  const row: unknown = rows[0];
  expect(field(row, "case_id")).toBe("c1");
  expect(field(row, "answerer")).toBe(arm);
  expect(field(row, "outcome")).toBe("error");
  expect(field(field(row, "evidence"), "reason")).toBe(reason);
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(err).not.toMatch(/(?:^|\n)\s+at \S+|UnhandledPromiseRejection|private-test-key/);
  return { code, out, err };
}

test("[integration] D16-CLI-EMPTY empty records name the empty file and use verdict code 2 or validate code 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jnj-broken-cli-"));
  try {
    const file = join(dir, "empty.csv");
    writeFileSync(file, "");
    for (const [command, code] of RECORD_COMMANDS) {
      const got = await cli([command, file]);
      expect(got.code).toBe(code);
      expect(got.err).toBe(`ERROR ${command === "verdict" ? `${file}: ` : ""}the file is empty: expected a header row and data rows\n`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[integration] D16-CLI-HEADER header-only records report zero data rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jnj-broken-cli-"));
  try {
    const file = join(dir, "header.csv");
    writeFileSync(file, readFileSync(join(EXAMPLES, "r1-both-zero.csv"), "utf8").split("\n")[0] + "\n");
    for (const [command, code] of RECORD_COMMANDS) {
      const got = await cli([command, file]);
      expect(got.code).toBe(code);
      expect(got.err).toBe("ERROR file has no data rows\n");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[integration] D16-CLI-CASES empty JSONL and JSON array name zero cases for run and estimate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jnj-broken-cli-"));
  try {
    const questions = join(dir, "questions.json");
    writeFileSync(questions, QUESTION);
    for (const [name, contents] of EMPTY_CASE_FILES) {
      const cases = join(dir, name);
      writeFileSync(cases, contents);
      for (const command of ["run", "estimate"]) {
        const args = [command, "--questions", questions, "--cases", cases, "--arms", "jev"];
        if (command === "run") args.push("--out", join(dir, "out.csv"));
        const got = await cli(args);
        expect(got.code).toBe(2);
        expect(got.err).toBe("ERROR no cases\n");
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[integration] D16-CLI-ASK-EMPTY ask rejects an empty case file with code 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jnj-broken-cli-"));
  try {
    const questions = join(dir, "questions.json");
    const file = join(dir, "case.json");
    writeFileSync(questions, QUESTION);
    for (const contents of ["", "[]"]) {
      writeFileSync(file, contents);
      const got = await cli(["ask", "--questions", questions, "--case", file, "--arms", "jev"]);
      expect(got.code).toBe(2);
      expect(got.err).toBe(`ERROR ${file}: ${contents === "" ? "the case file is empty: expected one case object" : "case must be an object"}\n`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [name, condition, reason] of VERDICT_CASES) {
  test(`[integration] D16-CLI-VERDICT ${name} gives not enough evidence and names ${condition}`, async () => {
    const got = await cli(["verdict", join(EXAMPLES, name)]);
    expect(got.code).toBe(4);
    const body: unknown = JSON.parse(got.out);
    const verdicts = field(body, "verdicts");
    expect(Array.isArray(verdicts)).toBe(true);
    if (!Array.isArray(verdicts)) return;
    const verdict: unknown = verdicts[0];
    expect(field(verdict, "verdict")).toBe("not enough evidence");
    expect(field(verdict, "condition")).toBe(condition);
    expect(field(verdict, "reason")).toBe(reason);
  });
}

test("[integration] D16-CLI-ARM ask and run reject an unknown arm with code 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jnj-broken-cli-"));
  try {
    const questions = join(dir, "questions.json");
    const cases = join(dir, "cases.jsonl");
    writeFileSync(questions, QUESTION);
    writeFileSync(cases, CASE + "\n");
    for (const command of ["ask", "run"]) {
      const args = [command, "--questions", questions, "--arms", "mystery"];
      if (command === "ask") args.push("--input", "A shop question");
      else args.push("--cases", cases, "--out", join(dir, "out.csv"));
      const got = await cli(args);
      expect(got.code).toBe(2);
      expect(got.err).toContain('--arms: unknown arm "mystery"; accepted: jev, decisions, llm, rule');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[integration] D16-CLI-UTF8 verdict and validate reject undecodable bytes with documented codes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jnj-broken-cli-"));
  try {
    const file = join(dir, "bad.csv");
    writeFileSync(file, Buffer.from([0xff, 0xfe]));
    for (const [command, code] of RECORD_COMMANDS) {
      const got = await cli([command, file]);
      expect(got.code).toBe(code);
      expect(got.err).toBe(`ERROR cannot read ${file} as UTF-8: The encoded data was not valid for encoding utf-8\n`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const arm of ["jev", "decisions", "llm"]) {
  const statuses: readonly (readonly [number, string])[] = [
    [429, `${arm}: rate limited by the provider (HTTP 429)`],
    [503, `${arm}: provider server error (HTTP 503)`],
    [418, `${arm}: provider returned HTTP 418`],
    [0, `${arm}: provider request timed out`],
  ];
  for (const [status, reason] of statuses) {
    test(`[integration] D16-CLI-PROVIDER ${arm} ${status} gives named error rows for ask and run`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "jnj-broken-cli-"));
      try {
        const questions = join(dir, "questions.json");
        const cases = join(dir, "cases.jsonl");
        const fixtures = join(dir, "fixtures.json");
        writeFileSync(questions, QUESTION);
        writeFileSync(cases, CASE + "\n" + JSON.stringify({ id: "c2", input: "Another shop question" }) + "\n");
        writeFileSync(fixtures, JSON.stringify({ hosts: {
          "api.typesafe.ai": { http: status, response: { error: KEY } },
          "api.openai.com": { http: status, response: { error: KEY } },
          "api.anthropic.com": { http: status, response: { error: KEY } },
        }, cli: null }));
        for (const command of ["ask", "run"]) {
          const args = [command, "--questions", questions, "--arms", arm];
          if (command === "ask") args.push("--input", "A shop question", "--case-id", "c1");
          else args.push("--cases", cases, "--out", join(dir, "out.csv"));
          const got = await cli(args, { [FIXTURES_ENV]: fixtures, JEV_API_KEY: KEY, OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY });
          expect(got.code).toBe(0);
          const body: unknown = JSON.parse(got.out);
          if (command === "ask") errorRow(body, arm, reason);
          else {
            expect(field(body, "errorReasons")).toEqual([reason]);
            const csv = readDictRows(readFileSync(join(dir, "out.csv"), "utf8"));
            expect(csv.rows).toHaveLength(2);
            const header = csv.header;
            if (header === null) throw new Error("missing exported header");
            for (const [index, row] of csv.rows.entries()) {
              expect(row.fields[header.indexOf("case_id")]).toBe(index === 0 ? "c1" : "c2");
              expect(row.fields[header.indexOf("answerer")]).toBe(arm);
              expect(row.fields[header.indexOf("outcome")]).toBe("error");
            }
          }
          expect(got.out).not.toContain(KEY);
          if (command === "run") expect(readFileSync(join(dir, "out.csv"), "utf8")).not.toContain(KEY);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
