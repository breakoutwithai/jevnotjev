// Findings of PR 15 review r2 (pr15-r2): R1, P2, P3, P4.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main as exportMain } from "../export-cli.ts";
import { loadFile } from "../load.ts";
import { MIGRATIONS } from "../migrate.ts";
import {
  databaseDsn,
  exampleRows,
  forceRollback,
  makeWorkspace,
  openConnection,
  pgError,
  SQLSTATE,
  tmpPath,
  useConnection,
  writeCsv,
} from "./support.ts";

const SECRET_NAME = "name-secret-upload.csv";

describe("PR 15 review r2", () => {
  const conn = useConnection();

  // R1: no function in schema jnj is executable by PUBLIC, and nothing outside jnj changes

  test("[integration] r1 no function in schema jnj is executable by public", async () => {
    const [functions] = await conn()`select count(*)::integer as n from pg_proc where pronamespace = 'jnj'::regnamespace`;
    const open = await conn()`
      select p.proname from pg_proc p where p.pronamespace = 'jnj'::regnamespace
      and has_function_privilege('public', p.oid, 'execute') order by 1`;
    expect(Number(functions?.["n"])).toBeGreaterThanOrEqual(5);
    expect(open.length).toBe(0);
  });

  test("[integration] r1 a function in another schema stays executable by public", async () => {
    const { result, error } = await forceRollback(conn(), async (tx) => {
      await tx`create schema other_app`;
      await tx`grant usage on schema other_app to public`;
      await tx`create function other_app.f() returns integer language sql as 'select 1'`;
      await tx`create function public.jnj_probe_g() returns integer language sql as 'select 2'`;
      await tx`set local role jnj_loader`;
      const [row] = await tx`select other_app.f() as f, public.jnj_probe_g() as g`;
      return [row?.["f"], row?.["g"]];
    });
    expect(error).toBeUndefined();
    expect(result).toEqual([1, 2]);
  });

  // P2: the jnj_loader guard covers every role attribute and membership

  test.each([
    "alter role jnj_loader createdb",
    "alter role jnj_loader replication",
    "alter role jnj_loader bypassrls",
    "grant pg_read_all_data to jnj_loader",
  ])("[integration] p2 migration refuses a jnj_loader with attributes or memberships: %s", async (change) => {
    const sql = readFileSync(join(MIGRATIONS, "0002_loader_role.sql"), "utf8");
    const { error } = await forceRollback(conn(), async (tx) => {
      await tx.unsafe(change);
      await tx.unsafe(sql);
    });
    const failure = await pgError(Promise.reject(error));
    expect(failure.code).toBe(SQLSTATE.raiseException);
    expect(failure.message).toContain("jnj_loader");
  });

  // P3: a restricted workspace's file name never leaves the client

  test("[integration] p3 restricted file name is hashed before it is sent", async () => {
    const { header, rows } = await exampleRows();
    const path = writeCsv(join(tmpPath(), SECRET_NAME), header, rows);
    const sent: string[] = [];
    const spy = await openConnection({ debug: (_id, _query, parameters) => sent.push(parameters.map(String).join("\u0000")) });
    try {
      await loadFile(spy, await makeWorkspace(conn(), "restricted"), path);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.some((parameters) => parameters.includes("name-secret"))).toBe(false);
      sent.length = 0;
      await loadFile(spy, await makeWorkspace(conn(), "synthetic"), path);
      expect(sent.some((parameters) => parameters.includes(SECRET_NAME))).toBe(true);
    } finally {
      await spy.end();
    }
  });

  // P4: export of an unknown run is a one-line error, no stack trace

  test("[integration] p4 export of an unknown run is one line and non-zero", async () => {
    const workspace = await makeWorkspace(conn());
    const out: string[] = [];
    const err: string[] = [];
    const code = await exportMain(
      [workspace, "--run", "nope"],
      { out: (line) => out.push(line + "\n"), err: (line) => err.push(line + "\n"), write: (text) => out.push(text) },
      { JNJ_DATABASE_URL: await databaseDsn() },
    );
    expect(code).toBe(1);
    expect(out.join("")).toBe("");
    expect(err.join("")).toBe(`ERROR run nope has no records in workspace ${workspace}\n`);
  });
});
