// Fixture replays must never look like real answers. When JNJ_DECIDE_FIXTURES is set, every row is stamped:
// evidence.replayed_fixture = true and run_id gets a "-fixture" suffix. The suffix is what survives into the CSV
// (evidence is not a CSV column), so a records file written in fixture mode names itself and no new column is needed.
// Shared by the CLI and any other front end (the MCP server) that can run in fixture mode.
import type { DecideRow } from "./types.ts";

export const FIXTURES_ENV_NAME = "JNJ_DECIDE_FIXTURES";
export const FIXTURE_RUN_SUFFIX = "-fixture";

/** True when the test-only fixture file is named in env (an empty value is absent). */
export function fixtureModeActive(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env[FIXTURES_ENV_NAME] ?? "") !== "";
}

/** Every row marked as a replay. Idempotent: an already-suffixed run id is not suffixed twice. */
export function stampFixtureRows(rows: readonly DecideRow[]): readonly DecideRow[] {
  return rows.map((row) => ({
    ...row,
    run_id: row.run_id.endsWith(FIXTURE_RUN_SUFFIX) ? row.run_id : row.run_id + FIXTURE_RUN_SUFFIX,
    evidence: { ...row.evidence, replayed_fixture: true },
  }));
}
