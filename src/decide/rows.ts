// Rows to jnj-record/1.2 CSV, in the format's own column order. Evidence is not a CSV column.
import { formatRows } from "../format/csv.ts";
import { COLUMNS_V1_2 } from "../format/validate.ts";
import type { DecideRow } from "./types.ts";

export const ROW_COLUMNS: readonly string[] = COLUMNS_V1_2;

function cell(row: DecideRow, column: string): string {
  switch (column) {
    case "format_version": return row.format_version;
    case "run_id": return row.run_id;
    case "prompt_version": return row.prompt_version;
    case "case_id": return row.case_id;
    case "case_input": return row.case_input;
    case "question_id": return row.question_id;
    case "question": return row.question;
    case "answer_set": return row.answer_set;
    case "answerer": return row.answerer;
    case "answerer_model": return row.answerer_model;
    case "output": return row.output ?? "";
    case "confidence": return row.confidence === null ? "" : String(row.confidence);
    case "tokens_in": return row.tokens_in === null ? "" : String(row.tokens_in);
    case "tokens_out": return row.tokens_out === null ? "" : String(row.tokens_out);
    case "cost_usd": return row.cost_usd === null ? "" : String(row.cost_usd);
    case "latency_ms": return row.latency_ms === null ? "" : String(row.latency_ms);
    case "price_table_date": return row.price_table_date ?? "";
    case "outcome": return row.outcome;
    default: return ""; // label, label_source and the label provenance columns: always empty
  }
}

export function rowsToCsv(rows: readonly DecideRow[]): string {
  return formatRows([ROW_COLUMNS, ...rows.map((r) => ROW_COLUMNS.map((c) => cell(r, c)))]);
}
