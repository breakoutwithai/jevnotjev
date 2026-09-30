// Connection strings: a secret or the string itself never reaches an error message or stderr.

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parseConninfo } from "./connect.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SECRET = "planted-s3cret-9f2c";
const MALFORMED = [
  `postgres://u:${SECRET}@h:notaport/db`,
  `postgresql://u:${SECRET}@[bad/db`,
  `postgres://h:notaport/${SECRET}`,
  `host=/tmp ${SECRET}`,
  `host=/tmp dbname='${SECRET}`,
];

function thrown(dsn: string): string {
  try {
    parseConninfo(dsn);
  } catch (error) {
    return error instanceof Error ? `${error.name} ${error.message} ${String(error.cause ?? "")}` : String(error);
  }
  throw new Error("expected the connection string to be refused");
}

function run(script: string, args: readonly string[], dsn: string): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", script, ...args], {
    cwd: ROOT,
    env: { ...process.env, JNJ_DATABASE_URL: dsn, PGPASSWORD: "" },
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("connection strings", () => {
  test.each(MALFORMED)("[unit] a malformed connection string is refused without echoing it: %#", (dsn) => {
    const message = thrown(dsn);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(dsn);
  });

  test("[unit] a secret in a postgres:// URL is refused before the URL is parsed", () => {
    expect(thrown(`postgres://u:${SECRET}@h/db`)).toContain("PGPASSWORD");
    expect(thrown(`postgres://u:${SECRET}@h:notaport/db`)).toContain("PGPASSWORD");
  });

  const commands: [string, string[]][] = [
    ["src/db/load-cli.ts", ["demo", "format/example-v1.csv"]],
    ["src/db/export-cli.ts", ["demo", "--run", "run-001"]],
    ["src/db/migrate-cli.ts", []],
  ];

  for (const [script, args] of commands) {
    test(`[unit] ${script} reports a malformed connection string in one line without echoing it`, () => {
      const dsn = `postgres://u:${SECRET}@h:notaport/db`;
      const { code, stdout, stderr } = run(script, args, dsn);
      expect(code).not.toBe(0);
      expect(stdout + stderr).not.toContain(SECRET);
      expect(stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(stderr).toStartWith("ERROR ");
    });

    test(`[unit] ${script} reports a refused connection in one line without echoing the connection string`, () => {
      const dsn = `host=127.0.0.1 port=1 dbname=${SECRET} connect_timeout=2`;
      const { code, stdout, stderr } = run(script, args, dsn);
      expect(code).toBe(1);
      expect(stdout + stderr).not.toContain(SECRET);
      expect(stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(stderr).toStartWith("ERROR ");
    });
  }
});
