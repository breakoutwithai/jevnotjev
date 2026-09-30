// The six BLOCKING probes of review db-schema-r1, each as a test.
// Each probe is the review's own reproduction, run against this schema; it must fail closed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { validate } from "../../format/validate.ts";
import type { Query } from "../connect.ts";
import { exportCsv } from "../export.ts";
import { loadFile } from "../load.ts";
import {
  col,
  count,
  D06,
  EXAMPLE,
  exampleRows,
  loadError,
  makeWorkspace,
  pgError,
  SQLSTATE,
  tmpPath,
  useConnection,
  writeCsv,
} from "./support.ts";

interface Ids {
  workspace: string;
  file: string;
  run: string;
  testCase: string;
  question: string;
  questionId: string;
}

/** Primary keys of the first loaded answer in a workspace, for direct-insert probes. */
async function ids(conn: Query, workspace: string): Promise<Ids> {
  const [row] = await conn`
    select a.workspace_id::text, a.import_file_pk::text, a.run_pk::text, a.case_pk::text, a.question_pk::text, a.question_id
    from jnj.answer a join jnj.workspace w on w.id = a.workspace_id where w.slug = ${workspace}
    order by a.id limit 1`.values();
  const values: unknown[] = row ?? [];
  const text = values.map((value) => {
    if (typeof value !== "string") throw new Error("no answer loaded");
    return value;
  });
  const [ws = "", file = "", run = "", testCase = "", question = "", questionId = ""] = text;
  return { workspace: ws, file, run, testCase, question, questionId };
}

async function workspaceId(conn: Query, slug: string): Promise<string> {
  const [row] = await conn`select id::text as id from jnj.workspace where slug = ${slug}`;
  const id: unknown = row?.["id"];
  if (typeof id !== "string") throw new Error(`no workspace ${slug}`);
  return id;
}

async function withAnswerSet(name: string, runId: string, answerSet: string): Promise<string> {
  const { header, rows } = await exampleRows();
  for (const row of rows) {
    row[col(header, "run_id")] = runId;
    row[col(header, "answer_set")] = answerSet;
  }
  return writeCsv(join(tmpPath(), name), header, rows);
}

function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

const INSERT_ANSWER =
  "insert into jnj.answer (workspace_id, import_file_pk, run_pk, case_pk, question_pk, question_id," +
  " answerer_kind, answerer_model, output, source_line) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)";

describe("review db-schema-r1 blockers", () => {
  const conn = useConnection();

  // B1: every FK between workspace-scoped tables carries workspace_id

  test("[integration] b1 answer cannot point at another workspace's question", async () => {
    const mine = await makeWorkspace(conn());
    const theirs = await makeWorkspace(conn());
    await loadFile(conn(), mine, EXAMPLE);
    await loadFile(conn(), theirs, D06);
    const my = await ids(conn(), mine);
    const their = await ids(conn(), theirs);
    const error = await pgError(
      conn().unsafe(INSERT_ANSWER, [my.workspace, my.file, my.run, my.testCase, their.question, their.questionId, "human", "cw", "no", 99]),
    );
    expect(error.code).toBe(SQLSTATE.foreignKeyViolation);
  });

  test("[integration] b1 answer_option cannot belong to another workspace's question", async () => {
    const mine = await makeWorkspace(conn());
    const theirs = await makeWorkspace(conn());
    await loadFile(conn(), theirs, D06);
    const myId = await workspaceId(conn(), mine);
    const their = await ids(conn(), theirs);
    const error = await pgError(
      conn().unsafe("insert into jnj.answer_option (workspace_id, question_pk, position, value) values ($1, $2, 9, 'maybe')", [
        myId,
        their.question,
      ]),
    );
    expect(error.code).toBe(SQLSTATE.foreignKeyViolation);
  });

  // B2: answer_set per (workspace, prompt_version, question_id) is immutable

  test.each(["no|yes", "yes|no|maybe"])("[integration] b2 reload with a different answer_set fails: %s", async (changed) => {
    const workspace = await makeWorkspace(conn());
    await loadFile(conn(), workspace, await withAnswerSet("a.csv", "run-1", "yes|no"));
    const error = await loadError(loadFile(conn(), workspace, await withAnswerSet("b.csv", "run-2", changed)));
    expect(error.message).toMatch(/answer_set/);
    const stored = await conn()`
      select q.answer_set, string_agg(o.value, '|' order by o.position) as options from jnj.question q
      join jnj.answer_option o on o.workspace_id = q.workspace_id and o.question_pk = q.id
      join jnj.workspace w on w.id = q.workspace_id where w.slug = ${workspace} group by q.answer_set`;
    expect(stored.map((row) => [row["answer_set"], row["options"]])).toEqual([["yes|no", "yes|no"]]);
    expect(await count(conn(), "run", workspace)).toBe(1);
  });

  test("[integration] b2 duplicate value in answer_set fails instead of collapsing", async () => {
    const path = await withAnswerSet("dup.csv", "run-1", "yes|yes|no");
    expect(validate(await Bun.file(path).text()).errors).toEqual([]);
    const workspace = await makeWorkspace(conn());
    const error = await loadError(loadFile(conn(), workspace, path));
    expect(error.message).toMatch(/answer_set yes\|yes\|no repeats a value/);
    expect(await count(conn(), "question", workspace)).toBe(0);
  });

  test("[integration] b2 db rejects a question whose options do not spell its answer_set", async () => {
    const workspace = await makeWorkspace(conn());
    const ws = await workspaceId(conn(), workspace);
    const error = await pgError(
      conn().begin(async (tx) => {
        const [question] = await tx`
          insert into jnj.question (workspace_id, content_policy, prompt_version, question_id,
            question_sha256, question_length, answer_set)
          select id, content_policy, 'v1', 'q1', repeat('0', 64), 2, 'yes|yes|no'
          from jnj.workspace where id = ${ws}::bigint returning id::text as id`;
        const q: unknown = question?.["id"];
        if (typeof q !== "string") throw new Error("no question id");
        await tx`insert into jnj.answer_option (workspace_id, question_pk, position, value)
          values (${ws}::bigint, ${q}::bigint, 1, 'yes'), (${ws}::bigint, ${q}::bigint, 3, 'no')`;
      }),
    );
    expect(error.code).toBe(SQLSTATE.checkViolation);
    expect(error.message).toMatch(/answer_set/);
    expect(await count(conn(), "question", workspace)).toBe(0);
  });

  // B3: one run = one file; DB keys at least as strict as the validator

  test("[integration] b3 a different file into a loaded run fails", async () => {
    const workspace = await makeWorkspace(conn());
    await loadFile(conn(), workspace, EXAMPLE);
    const { header, rows } = await exampleRows();
    for (const row of rows) row[col(header, "prompt_version")] = "refund-q.v2";
    const error = await loadError(loadFile(conn(), workspace, writeCsv(join(tmpPath(), "second.csv"), header, rows)));
    expect(error.message).toMatch(/run run-001 is already loaded from file/);
    expect(await count(conn(), "answer", workspace)).toBe(9);
  });

  test("[integration] b3 answer key matches the validator's key without prompt_version", async () => {
    const workspace = await makeWorkspace(conn());
    await loadFile(conn(), workspace, EXAMPLE);
    const my = await ids(conn(), workspace);
    const q2 = await conn().begin(async (tx) => {
      const [question] = await tx`
        insert into jnj.question (workspace_id, content_policy, prompt_version, question_id,
          question_sha256, question_length, answer_set)
        select id, content_policy, 'refund-q.v2', ${my.questionId}, repeat('0', 64), 14, 'yes|no'
        from jnj.workspace where id = ${my.workspace}::bigint returning id::text as id`;
      const id: unknown = question?.["id"];
      if (typeof id !== "string") throw new Error("no question id");
      await tx`insert into jnj.answer_option (workspace_id, question_pk, position, value)
        values (${my.workspace}::bigint, ${id}::bigint, 1, 'yes'), (${my.workspace}::bigint, ${id}::bigint, 2, 'no')`;
      return id;
    });
    const error = await pgError(
      conn().unsafe(INSERT_ANSWER, [my.workspace, my.file, my.run, my.testCase, q2, my.questionId, "jev", "jev-2", "no", 99]),
    );
    expect(error.code).toBe(SQLSTATE.uniqueViolation);
    expect(error.message).toContain("answer_run_pk_case_pk_question_id_answerer_kind_key");
  });

  // B4: file identity and a total export order

  test("[integration] b4 import_file is recorded and source_line is unique per file", async () => {
    const workspace = await makeWorkspace(conn());
    await loadFile(conn(), workspace, EXAMPLE);
    const recorded = await conn()`
      select f.file_sha256, f.original_name, f.purpose from jnj.import_file f
      join jnj.workspace w on w.id = f.workspace_id where w.slug = ${workspace}`;
    expect(recorded.map((row) => [row["file_sha256"], row["original_name"], row["purpose"]])).toEqual([
      [sha256(await Bun.file(EXAMPLE).bytes()), "example-v1.csv", "records"],
    ]);
    const my = await ids(conn(), workspace);
    const error = await pgError(
      conn().unsafe(INSERT_ANSWER, [my.workspace, my.file, my.run, my.testCase, my.question, my.questionId, "human", "cw", "no", 2]),
    );
    expect(error.code).toBe(SQLSTATE.uniqueViolation);
    expect(error.message).toContain("answer_import_file_pk_source_line_key");
  });

  test("[integration] b4 export is one run in source-line order", async () => {
    const workspace = await makeWorkspace(conn());
    const { header, rows } = await exampleRows();
    for (const row of rows) row[col(header, "run_id")] = "run-000";
    const later = writeCsv(join(tmpPath(), "run-000.csv"), header, [...rows].reverse());
    await loadFile(conn(), workspace, EXAMPLE);
    await loadFile(conn(), workspace, later);
    const only = (await exportCsv(conn(), workspace, "run-000")).text;
    const expected = (await Bun.file(later).text())
      .replace("1.8e-06", "0.0000018")
      .replace("1.6e-06", "0.0000016")
      .replace("1.9e-06", "0.0000019");
    expect(only).toBe(expected);
  });

  // B5: grants include USAGE on the schema; the loader role can really load

  test("[integration] b5 loader role can create a workspace, load and export", async () => {
    const slug = `ws-loader-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await conn()`set role jnj_loader`;
    try {
      const [who] = await conn()`select current_user as who`;
      expect(who?.["who"]).toBe("jnj_loader");
      const result = await loadFile(conn(), slug, D06, { createWorkspace: true });
      expect([result.status, result.answers, result.labels]).toEqual(["loaded", 30n, 29n]);
      const exported = await exportCsv(conn(), slug, "run-d06");
      expect(exported.text.split("\n").filter((line) => line !== "").length).toBe(31);
    } finally {
      await conn()`reset role`;
    }
    const [row] = await conn()`select content_policy from jnj.workspace where slug = ${slug}`;
    expect(row?.["content_policy"]).toBe("restricted");
  });

  test.each([
    "insert into jnj.workspace (slug, content_policy) values ('sneaky', 'synthetic')",
    "update jnj.workspace set content_policy = 'synthetic'",
    "delete from jnj.answer",
    "update jnj.label set verdict = 'reject'",
  ])("[integration] b5 loader role cannot widen policy, update or delete: %s", async (statement) => {
    await conn()`set role jnj_loader`;
    try {
      const error = await pgError(conn().unsafe(statement));
      expect(error.code).toBe(SQLSTATE.insufficientPrivilege);
    } finally {
      await conn()`reset role`;
    }
  });

  // B6: raw case text only in a synthetic workspace

  test("[integration] b6 restricted workspace stores hash and length but no text", async () => {
    const workspace = await makeWorkspace(conn(), "restricted");
    await loadFile(conn(), workspace, EXAMPLE);
    const stored = await conn()`
      select c.case_id, c.case_input, c.case_input_sha256, c.case_input_length from jnj.test_case c
      join jnj.workspace w on w.id = c.workspace_id where w.slug = ${workspace} order by c.case_id`;
    const { header, rows } = await exampleRows();
    const text = new Map(rows.map((row) => [row[col(header, "case_id")] ?? "", row[col(header, "case_input")] ?? ""]));
    expect(stored.map((row) => [row["case_id"], row["case_input"], row["case_input_sha256"], row["case_input_length"]])).toEqual(
      ["m01", "m02", "m03"].map((id) => {
        const input = text.get(id) ?? "";
        return [id, null, sha256(input), [...input].length];
      }),
    );
  });

  test("[integration] b6 db rejects text in a restricted workspace", async () => {
    const workspace = await makeWorkspace(conn(), "restricted");
    await loadFile(conn(), workspace, EXAMPLE);
    const my = await ids(conn(), workspace);
    const text = "a pasted message";
    const insert =
      "insert into jnj.test_case (workspace_id, content_policy, run_pk, case_id, case_input_sha256," +
      " case_input_length, case_input) values ($1, $2, $3, 'm99', $4, $5, $6)";
    const check = await pgError(conn().unsafe(insert, [my.workspace, "restricted", my.run, sha256(text), text.length, text]));
    expect(check.code).toBe(SQLSTATE.checkViolation);
    expect(check.message).toContain("case_input_only_when_synthetic");
    const foreign = await pgError(conn().unsafe(insert, [my.workspace, "synthetic", my.run, sha256(text), text.length, text]));
    expect(foreign.code).toBe(SQLSTATE.foreignKeyViolation);
  });

  test("[integration] b6 a workspace holding text cannot be downgraded to restricted", async () => {
    const workspace = await makeWorkspace(conn(), "synthetic");
    await loadFile(conn(), workspace, EXAMPLE);
    const error = await pgError(conn()`update jnj.workspace set content_policy = 'restricted' where slug = ${workspace}`);
    expect(error.code).toBe(SQLSTATE.foreignKeyViolation);
  });

  test("[integration] b6 export of a restricted workspace leaves case_input empty and says so", async () => {
    const workspace = await makeWorkspace(conn(), "restricted");
    await loadFile(conn(), workspace, EXAMPLE);
    const exported = await exportCsv(conn(), workspace, "run-001");
    const [header = [], ...rows] = exported.text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split(","));
    expect(new Set(rows.map((row) => row[col(header, "case_input")]))).toEqual(new Set([""]));
    expect(new Set(rows.map((row) => row[col(header, "question")]))).toEqual(new Set([""]));
    expect(exported.notices).toEqual([
      `case_input and question withheld: workspace ${workspace} is` +
        " content_policy=restricted; 3 cases and 1 questions keep only sha256 and length," +
        " so this export does not validate",
    ]);
  });
});
