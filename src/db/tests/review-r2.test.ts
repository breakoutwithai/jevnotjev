// Findings of PR 15 review r1 (pr15-r1): N1, N2 and the optional fixes O1, O2, O6, O7, O9.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "../../format/validate.ts";
import { exportCsv } from "../export.ts";
import { main as exportMain } from "../export-cli.ts";
import { ensureWorkspace, LoadError, loadFile, type Purpose } from "../load.ts";
import { MIGRATIONS, migrate, MigrationError } from "../migrate.ts";
import {
  col,
  EXAMPLE,
  exampleRows,
  forceRollback,
  loadError,
  makeWorkspace,
  openConnection,
  pgError,
  ROOT,
  SQLSTATE,
  tmpPath,
  useConnection,
  writeCsv,
  type Csv,
} from "./support.ts";

const SECRET_QUESTION = "Q-SECRET: is this person asking for money back?";
const SECRET_CASE = "CASE-SECRET kettle arrived broken";
const SECRET_NAME = "name-secret-upload.csv";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function secretRows(): Promise<Csv> {
  const { header, rows } = await exampleRows();
  for (const row of rows) {
    row[col(header, "question")] = SECRET_QUESTION;
    row[col(header, "case_input")] = `${SECRET_CASE} ${row[col(header, "case_id")] ?? ""}`;
  }
  return { header, rows };
}

function assertNoSecret(error: LoadError): void {
  const text = `${error.message}\n${error.messages.join("\n")}`;
  for (const secret of [SECRET_QUESTION, SECRET_CASE, SECRET_NAME, "Q-SECRET", "CASE-SECRET", "name-secret"]) {
    expect(text.includes(secret)).toBe(false);
  }
}

function setRow(rows: string[][], index: number, header: readonly string[], changes: Record<string, string>): void {
  const row = rows[index];
  if (row === undefined) throw new Error(`no row ${index}`);
  for (const [name, value] of Object.entries(changes)) row[col(header, name)] = value;
}

type Change = (csv: Csv) => Csv;

const reworded: Change = ({ header, rows }) => {
  for (const row of rows) {
    row[col(header, "run_id")] = "run-002";
    row[col(header, "question")] = `${SECRET_QUESTION} (reworded)`;
  }
  return { header, rows };
};

const otherFileSameRun: Change = ({ header, rows }) => {
  for (const row of rows) row[col(header, "prompt_version")] = "refund-q.v2";
  return { header, rows };
};

const labelOnChangedRow: Change = ({ header, rows }) => {
  setRow(rows, 7, header, { output: "yes", label: "reject", label_source: "human" });
  return { header, rows };
};

const relabel: Change = ({ header, rows }) => {
  setRow(rows, 0, header, { label: "reject" });
  return { header, rows };
};

const overlongCase: Change = ({ header, rows }) => {
  for (const row of rows) {
    if (row[col(header, "case_id")] === "m02") row[col(header, "case_input")] = SECRET_CASE + " x".repeat(5000);
  }
  return { header, rows };
};

const emptyQuestion: Change = ({ header, rows }) => {
  for (const row of rows) row[col(header, "question")] = "";
  return { header, rows };
};

describe("PR 15 review r1", () => {
  const conn = useConnection();

  // N1: every export is one run and validates

  test("[integration] n1 each run's export validates when runs share a case_id", async () => {
    const workspace = await makeWorkspace(conn(), "synthetic");
    await loadFile(conn(), workspace, EXAMPLE);
    const { header, rows } = await exampleRows();
    for (const row of rows) {
      row[col(header, "run_id")] = "run-009";
      if (row[col(header, "case_id")] === "m01") row[col(header, "case_input")] = "A different message with the same case_id.";
    }
    const dir = tmpPath();
    await loadFile(conn(), workspace, writeCsv(join(dir, "run-009.csv"), header, rows));
    for (const runId of ["run-001", "run-009"]) {
      const result = validate((await exportCsv(conn(), workspace, runId)).text);
      expect(result.errors).toEqual([]);
      expect(result.rows.length).toBe(9);
    }
  });

  test("[unit] n1 export requires a run", async () => {
    expect(exportCsv.length).toBe(3);
    const err: string[] = [];
    const code = await exportMain(
      ["some-workspace"],
      { out: () => undefined, err: (line) => err.push(line), write: () => undefined },
      {},
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--run");
  });

  // N2: restricted workspaces keep question text and file name only as sha256 + length

  test("[integration] n2 restricted workspace stores question and file name as hash only", async () => {
    const workspace = await makeWorkspace(conn(), "restricted");
    const { header, rows } = await secretRows();
    await loadFile(conn(), workspace, writeCsv(join(tmpPath(), SECRET_NAME), header, rows));
    const question = await conn()`
      select q.question, q.question_sha256, q.question_length from jnj.question q
      join jnj.workspace w on w.id = q.workspace_id where w.slug = ${workspace}`;
    expect(question.map((row) => [row["question"], row["question_sha256"], row["question_length"]])).toEqual([
      [null, sha256(SECRET_QUESTION), SECRET_QUESTION.length],
    ]);
    const name = await conn()`
      select f.original_name, f.original_name_sha256, f.original_name_length from jnj.import_file f
      join jnj.workspace w on w.id = f.workspace_id where w.slug = ${workspace}`;
    expect(name.map((row) => [row["original_name"], row["original_name_sha256"], row["original_name_length"]])).toEqual([
      [null, sha256(SECRET_NAME), SECRET_NAME.length],
    ]);
    const dump = await conn()`
      select v::text as row from jnj.record_v1 v join jnj.workspace w on w.id = v.workspace_id where w.slug = ${workspace}`;
    expect(dump.map((row) => String(row["row"])).join("\n").includes("SECRET")).toBe(false);
  });

  test("[integration] n2 db rejects question text and file name in a restricted workspace", async () => {
    const workspace = await makeWorkspace(conn(), "restricted");
    const [found] = await conn()`select id::text as id from jnj.workspace where slug = ${workspace}`;
    const ws = String(found?.["id"]);
    const question = await pgError(
      conn().unsafe(
        "insert into jnj.question (workspace_id, content_policy, prompt_version, question_id, question_sha256," +
          " question_length, question, answer_set) values ($1, 'restricted', 'v1', 'q1', $2, $3, $4, 'yes|no')",
        [ws, sha256(SECRET_QUESTION), SECRET_QUESTION.length, SECRET_QUESTION],
      ),
    );
    expect(question.code).toBe(SQLSTATE.checkViolation);
    expect(question.message).toContain("question_only_when_synthetic");
    const name = await pgError(
      conn().unsafe(
        "insert into jnj.import_file (workspace_id, content_policy, purpose, file_sha256, original_name_sha256," +
          " original_name_length, original_name) values ($1, 'restricted', 'records', $2, $3, $4, $5)",
        [ws, "0".repeat(64), sha256(SECRET_NAME), SECRET_NAME.length, SECRET_NAME],
      ),
    );
    expect(name.code).toBe(SQLSTATE.checkViolation);
    expect(name.message).toContain("original_name_only_when_synthetic");
  });

  const leaks: [string, Change | null, Purpose][] = [
    ["reworded", reworded, "records"],
    ["other_file_same_run", otherFileSameRun, "records"],
    ["label_on_changed_row", labelOnChangedRow, "labels"],
    ["relabel", relabel, "labels"],
    ["overlong_case", overlongCase, "records"],
    ["empty_question", emptyQuestion, "records"],
    ["None", null, "labels"],
  ];
  for (const [name, change, purpose] of leaks) {
    test(`[integration] n2 o7 load errors never echo question, case text or file name: ${name}-${purpose}`, async () => {
      const workspace = await makeWorkspace(conn(), "restricted");
      const dir = tmpPath();
      const secret = await secretRows();
      const first = writeCsv(join(dir, SECRET_NAME), secret.header, secret.rows);
      await loadFile(conn(), workspace, first);
      let path = first;
      if (change !== null) {
        const changed = change(await secretRows());
        path = writeCsv(join(dir, `2-${SECRET_NAME}`), changed.header, changed.rows);
      }
      const error = await loadError(loadFile(conn(), workspace, path, { purpose }));
      expect(error.messages.length).toBeGreaterThan(0);
      assertNoSecret(error);
    });
  }

  // O6: confidence above 1 is rejected by the loader and the DB

  test("[integration] o6 confidence above one is rejected by loader and db", async () => {
    const { header, rows } = await exampleRows();
    setRow(rows, 0, header, { confidence: "1.00000000000000000001" });
    const path = writeCsv(join(tmpPath(), "conf.csv"), header, rows);
    expect(validate(await Bun.file(path).text()).errors).toEqual([]);
    const workspace = await makeWorkspace(conn());
    const error = await loadError(loadFile(conn(), workspace, path));
    expect(error.message).toMatch(/line 2: confidence: 1\.00000000000000000001 is above 1/);
    await loadFile(conn(), workspace, EXAMPLE);
    const [answer] = await conn()`
      select a.id::text as id from jnj.answer a join jnj.workspace w on w.id = a.workspace_id
      where w.slug = ${workspace} limit 1`;
    const check = await pgError(
      conn().unsafe(
        "insert into jnj.answer (workspace_id, import_file_pk, run_pk, case_pk, question_pk, question_id," +
          " answerer_kind, answerer_model, output, confidence, source_line)" +
          " select workspace_id, import_file_pk, run_pk, case_pk, question_pk, question_id, 'human', 'cw', output," +
          " $1::numeric, 99 from jnj.answer where id = $2::bigint",
        ["1.00000000000000000001", String(answer?.["id"])],
      ),
    );
    expect(check.code).toBe(SQLSTATE.checkViolation);
  });

  // O2: the migration refuses to adopt a jnj_loader that is more than a NOLOGIN group

  test.each(["login", "superuser", "createrole"])(
    "[integration] o2 migration refuses a jnj_loader with extra powers: %s",
    async (attribute) => {
      const sql = readFileSync(join(MIGRATIONS, "0002_loader_role.sql"), "utf8");
      // always rolled back: the role is cluster-wide, so the ALTER must never commit
      const { error } = await forceRollback(conn(), async (tx) => {
        await tx.unsafe(`alter role jnj_loader ${attribute}`);
        await tx.unsafe(sql);
      });
      const failure = await pgError(Promise.reject(error));
      expect(failure.code).toBe(SQLSTATE.raiseException);
      expect(failure.message).toContain("jnj_loader");
      const [role] = await conn()`
        select rolcanlogin or rolsuper or rolcreaterole as powered from pg_roles where rolname = 'jnj_loader'`;
      expect(role?.["powered"]).toBe(false);
    },
  );

  // O1: migrate enforces number order and notices a missing applied file

  test("[integration] o1 migrate refuses an unapplied file numbered below the latest", async () => {
    const dir = tmpPath();
    for (const name of readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql"))) {
      copyFileSync(join(MIGRATIONS, name), join(dir, name));
    }
    writeFileSync(join(dir, "0000_backfill.sql"), "select 1;\n", "utf8");
    const error = await migrate(conn(), dir).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect(String(error)).toMatch(/0000_backfill\.sql is numbered below applied migration 0002/);
  });

  test("[integration] o1 migrate refuses when an applied file is missing", async () => {
    const dir = tmpPath();
    copyFileSync(join(MIGRATIONS, "0001_records.sql"), join(dir, "0001_records.sql"));
    const error = await migrate(conn(), dir).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect(String(error)).toMatch(/0002_loader_role\.sql was applied but is missing/);
  });

  test("[unit] o1 sql files are checked out with LF", () => {
    const result = Bun.spawnSync(["git", "-C", ROOT, "check-attr", "text", "eol", "--", "db/migrations/0001_records.sql"]);
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    expect(out).toContain("text: set");
    expect(out).toContain("eol: lf");
  });

  // O9: two first loads racing to create the same workspace both succeed

  test("[integration] o9 concurrent ensureWorkspace does not collide", async () => {
    const slug = `ws-race-${process.hrtime.bigint() % 1_000_000_000n}`;
    const errors: unknown[] = [];
    const firstPool = await openConnection();
    const secondPool = await openConnection();
    const watcher = await openConnection();
    const first = await firstPool.reserve();
    try {
      await first`begin`;
      await ensureWorkspace(first, slug); // uncommitted: the second insert must wait on it
      const [pid] = await secondPool`select pg_backend_pid()::integer as pid`;
      const secondPid: unknown = pid?.["pid"];
      const second = secondPool
        .begin((tx) => ensureWorkspace(tx, slug))
        .catch((error: unknown) => {
          errors.push(error);
        });
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting === 0; attempt++) {
        const [row] = await watcher`
          select count(*)::integer as n from pg_stat_activity where pid = ${Number(secondPid)} and wait_event_type = 'Lock'`;
        waiting = Number(row?.["n"] ?? 0);
        if (waiting === 0) await Bun.sleep(10);
      }
      expect(waiting).toBeGreaterThan(0);
      await first`commit`;
      await second;
    } finally {
      first.release();
      await Promise.all([firstPool.end(), secondPool.end(), watcher.end()]);
    }
    expect(errors).toEqual([]);
  });
});
