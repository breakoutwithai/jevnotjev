// The DB refuses bad values on its own, and accepts every value the validator accepts (review O1).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecords } from "../../format/csv.ts";
import { validate } from "../../format/validate.ts";
import type { Query } from "../connect.ts";
import { decimalEquals } from "../decimal.ts";
import { exportCsv } from "../export.ts";
import { loadFile } from "../load.ts";
import { MIGRATIONS, migrate, MigrationError } from "../migrate.ts";
import {
  col,
  count,
  EXAMPLE,
  exampleRows,
  loadError,
  makeWorkspace,
  pgError,
  setCell,
  SQLSTATE,
  tmpPath,
  useConnection,
  writeCsv,
} from "./support.ts";

interface AnswerIds {
  id: string;
  workspace: string;
  file: string;
  run: string;
  testCase: string;
  question: string;
  questionId: string;
}

async function firstAnswer(conn: Query, workspace: string): Promise<AnswerIds> {
  const [row] = await conn`
    select a.id::text, a.workspace_id::text, a.import_file_pk::text, a.run_pk::text, a.case_pk::text,
      a.question_pk::text, a.question_id
    from jnj.answer a join jnj.workspace w on w.id = a.workspace_id where w.slug = ${workspace}
    order by a.id limit 1`.values();
  const [id, ws, file, run, testCase, question, questionId] = row ?? [];
  if ([id, ws, file, run, testCase, question, questionId].some((value) => typeof value !== "string")) {
    throw new Error("no answer loaded");
  }
  return {
    id: String(id),
    workspace: String(ws),
    file: String(file),
    run: String(run),
    testCase: String(testCase),
    question: String(question),
    questionId: String(questionId),
  };
}

const INSERT_ANSWER =
  "insert into jnj.answer (workspace_id, import_file_pk, run_pk, case_pk, question_pk, question_id," +
  " answerer_kind, answerer_model, output, confidence, cost_usd, source_line)" +
  " values ($1, $2, $3, $4, $5, $6, 'human', 'cw', $7, $8::numeric, $9::numeric, 99)";

async function withCell(column: string, value: string): Promise<string> {
  const { header, rows } = await exampleRows();
  setCell(rows, 0, col(header, column), value);
  return writeCsv(join(tmpPath(), "cell.csv"), header, rows);
}

describe("constraints", () => {
  const conn = useConnection();

  const badAnswers: [string, string | null, string | null, string, string][] = [
    ["maybe", null, null, SQLSTATE.foreignKeyViolation, "ForeignKeyViolation"],
    ["no", "1.5", null, SQLSTATE.checkViolation, "CheckViolation"],
    ["no", null, "-1", SQLSTATE.checkViolation, "CheckViolation"],
  ];
  for (const [output, confidence, cost, code, name] of badAnswers) {
    test(`[integration] db rejects bad answer values: ${output}-${confidence ?? "None"}-${cost ?? "None"}-${name}`, async () => {
      const workspace = await makeWorkspace(conn());
      await loadFile(conn(), workspace, EXAMPLE);
      const ids = await firstAnswer(conn(), workspace);
      const error = await pgError(
        conn().unsafe(INSERT_ANSWER, [
          ids.workspace,
          ids.file,
          ids.run,
          ids.testCase,
          ids.question,
          ids.questionId,
          output,
          confidence,
          cost,
        ]),
      );
      expect(error.code).toBe(code);
    });
  }

  test("[integration] db rejects label maybe and every update", async () => {
    const workspace = await makeWorkspace(conn());
    await loadFile(conn(), workspace, EXAMPLE);
    const ids = await firstAnswer(conn(), workspace);
    const bad = await pgError(
      conn().unsafe(
        "insert into jnj.label (answer_pk, workspace_id, import_file_pk, verdict, source) values ($1, $2, $3, 'maybe', 'human')",
        [ids.id, ids.workspace, ids.file],
      ),
    );
    expect(bad.code).toBe(SQLSTATE.checkViolation);
    for (const [table, column] of [
      ["label", "verdict"],
      ["answer", "output"],
      ["question", "question"],
      ["test_case", "case_id"],
      ["run", "run_id"],
      ["import_file", "original_name"],
      ["answer_option", "value"],
    ]) {
      const error = await pgError(
        conn().unsafe(`update jnj.${table} set ${column} = ${column} where workspace_id = $1`, [ids.workspace]),
      );
      expect(error.code).toBe(SQLSTATE.raiseException);
      expect(error.message).toContain(`UPDATE forbidden on jnj.${table}`);
    }
  });

  test("[integration] db rejects a single-option question", async () => {
    const workspace = await makeWorkspace(conn());
    const error = await pgError(conn()`
      insert into jnj.question (workspace_id, content_policy, prompt_version, question_id,
        question_sha256, question_length, answer_set)
      select id, content_policy, 'v1', 'q1', repeat('0', 64), 2, 'yes' from jnj.workspace where slug = ${workspace}`);
    expect(error.code).toBe(SQLSTATE.checkViolation);
  });

  test.each([
    ["confidence", "1e-400", "1e-400"],
    ["tokens_in", "3000000000", 3000000000n],
    ["tokens_in", "9223372036854775807", 9223372036854775807n],
    ["cost_usd", "1e-400", "1e-400"],
    ["cost_usd", "00042", "42"],
  ])("[integration] db accepts what the validator accepts: %s=%s", async (column, value, expected) => {
    const path = await withCell(column, value);
    expect(validate(await Bun.file(path).text()).errors).toEqual([]);
    const workspace = await makeWorkspace(conn());
    await loadFile(conn(), workspace, path);
    const [row] = await conn().unsafe(
      `select v.${column} as stored from jnj.record_v1 v join jnj.workspace w on w.id = v.workspace_id` +
        " where w.slug = $1 order by v.source_line limit 1",
      [workspace],
    );
    const stored: unknown = row?.["stored"];
    expect(typeof stored).toBe(typeof expected);
    if (typeof expected === "bigint") expect(stored).toBe(expected);
    else expect(typeof stored === "string" && decimalEquals(stored, expected)).toBe(true);
    const exported = readRecords((await exportCsv(conn(), workspace, "run-001")).text).map((record) => record.fields);
    const header = exported[0] ?? [];
    expect(decimalEquals(exported[1]?.[col(header, column)] ?? "", value)).toBe(true);
  });

  test.each([
    ["tokens_in", "9223372036854775808", "line 2: tokens_in: 9223372036854775808 is above 9223372036854775807"],
    ["latency_ms", "1" + "0".repeat(30), "line 2: latency_ms: 1000000000000000000000000000000 is above"],
    ["cost_usd", "1e-16384", "line 2: cost_usd: 1e-16384 has more than 16383 digits after the decimal point"],
    ["confidence", "0e-99999", "line 2: confidence: 0e-99999 has more than 16383 digits after the decimal point"],
    ["run_id", "run-001\n", "line 3: run_id: 'run-001\\n' ends with a line break"],
  ])("[integration] loader rejects before writing what the db cannot store: %s", async (column, value, message) => {
    const { header, rows } = await exampleRows();
    for (const row of column === "run_id" ? rows : rows.slice(0, 1)) row[col(header, column)] = value;
    const path = writeCsv(join(tmpPath(), "cell.csv"), header, rows);
    expect(validate(await Bun.file(path).text()).errors).toEqual([]);
    const workspace = await makeWorkspace(conn());
    const error = await loadError(loadFile(conn(), workspace, path));
    expect(error.messages.some((m) => m.startsWith(message))).toBe(true);
    expect(await count(conn(), "import_file", workspace)).toBe(0);
  });

  test("[integration] migrate is idempotent and refuses a changed applied file", async () => {
    expect(await migrate(conn())).toEqual([]);
    const dir = tmpPath();
    for (const name of readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort()) {
      writeFileSync(join(dir, name), readFileSync(join(MIGRATIONS, name), "utf8") + "\n-- edited\n", "utf8");
    }
    const error = await migrate(conn(), dir).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect(String(error)).toMatch(/0001_records\.sql changed after it was applied/);
  });
});
