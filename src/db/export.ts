// Export one run as jnj-record/1 CSV from the view jnj.record_v1.
//
// One run per file: case text is fixed per run, not across runs, so a multi-run file could fail
// validation. Rows come out in source-line order. LF line endings, minimal quoting, header in format
// order. Numbers are written the way Postgres prints them, so 1.8e-06 comes back as 0.0000018 (equal as
// decimals). A restricted workspace keeps no case or question text: those cells are empty and a
// notice says so.

import { formatRow, formatRows } from "../format/csv.ts";
import { COLUMNS } from "../format/validate.ts";
import type { Query } from "./connect.ts";

/** The workspace or run does not exist. */
export class ExportLookupError extends Error {
  override readonly name = "ExportLookupError";
}

export interface Export {
  readonly text: string;
  readonly notices: readonly string[];
}

function cellText(value: unknown): string {
  if (value === null) return "";
  if (typeof value !== "string") throw new Error("record_v1 returned a non-text cell");
  return value;
}

function column(row: readonly string[], name: string): string {
  return row[COLUMNS.indexOf(name)] ?? "";
}

/** One run's records in CSV text, plus its notices. */
export async function exportCsv(sql: Query, workspace: string, runId: string): Promise<Export> {
  const [found] = await sql`select id::text as id, content_policy from jnj.workspace where slug = ${workspace}`;
  if (found === undefined) throw new ExportLookupError(`workspace ${workspace} does not exist`);
  const workspacePk: unknown = found["id"];
  const policy: unknown = found["content_policy"];
  if (typeof workspacePk !== "string" || typeof policy !== "string") throw new Error("unexpected workspace row");
  const selected = COLUMNS.map((name) => `${name}::text`).join(", ");
  const result = await sql
    .unsafe(
      `select ${selected} from jnj.record_v1 where workspace_id = $1::bigint and run_id = $2 order by source_line`,
      [workspacePk, runId],
    )
    .values();
  const rows = result.map((row) => Array.from(row, cellText));
  if (rows.length === 0) throw new ExportLookupError(`run ${runId} has no records in workspace ${workspace}`);
  const notices: string[] = [];
  if (policy !== "synthetic") {
    const cases = new Set(rows.map((row) => column(row, "case_id"))).size;
    const questions = new Set(rows.map((row) => JSON.stringify([column(row, "prompt_version"), column(row, "question_id")])))
      .size;
    notices.push(
      `case_input and question withheld: workspace ${workspace} is content_policy=${policy};` +
        ` ${cases} cases and ${questions} questions keep only sha256 and length,` +
        " so this export does not validate",
    );
  }
  return { text: formatRow(COLUMNS) + formatRows(rows), notices };
}
