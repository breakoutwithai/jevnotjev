import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { formatRow, readDictRows } from "./csv.ts";
import { COLUMNS, summary, validate } from "./validate.ts";

const EXAMPLE = fileURLToPath(new URL("../../format/example-v1.csv", import.meta.url));
const exampleText = await Bun.file(EXAMPLE).text();

type Record = { [column: string]: string };

function readExample(): Record[] {
  const { header, rows } = readDictRows(exampleText);
  return rows.map(({ fields }) => {
    const row: Record = {};
    (header ?? []).forEach((name, index) => {
      row[name] = fields[index] ?? "";
    });
    return row;
  });
}

/** csv.DictWriter: header, then each row's values for those columns, CRLF line endings. */
function write(rows: readonly Record[], columns: readonly string[] = COLUMNS): string {
  return [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))]
    .map((fields) => formatRow(fields, "\r\n"))
    .join("");
}

function errorsFor(rows: readonly Record[]): readonly string[] {
  return validate(write(rows)).errors;
}

function at(rows: Record[], index: number): Record {
  const row = rows[index];
  if (row === undefined) throw new Error(`no row ${index}`);
  return row;
}

function exampleLines(): [string, string] {
  const [header = "", first = ""] = exampleText.split(/\r?\n/);
  return [header, first];
}

describe("format validator", () => {
  test("[smoke] example is valid with its two gaps", () => {
    const { errors, gaps, rows } = validate(exampleText);
    expect(errors).toEqual([]);
    expect(rows.length).toBe(9);
    expect(gaps).toEqual(["line 9: unlabelled (m02, q1, llm)", "line 10: cost_usd missing (m03, q1, llm)"]);
  });

  test("[unit] summary counts labelled rows only and marks cost incomplete", () => {
    expect(summary(validate(exampleText).rows)).toEqual([
      "jev: rows=3 labelled=3 accepted=3 cost=$0.000005",
      "llm: rows=3 labelled=2 accepted=2 cost=incomplete",
      "rule: rows=3 labelled=3 accepted=2 cost=$0.000000",
    ]);
  });

  test("[unit] output outside answer_set is an error", () => {
    const rows = readExample();
    at(rows, 0)["output"] = "maybe";
    expect(errorsFor(rows).some((e) => e.includes("line 2: output 'maybe' is not in answer_set"))).toBe(true);
  });

  test("[unit] unknown answerer is an error", () => {
    const rows = readExample();
    at(rows, 0)["answerer"] = "robot";
    expect(errorsFor(rows).some((e) => e.includes("line 2: answerer"))).toBe(true);
  });

  test("[unit] label without source is an error", () => {
    const rows = readExample();
    at(rows, 0)["label_source"] = "";
    expect(errorsFor(rows).some((e) => e.includes("line 2: label_source"))).toBe(true);
  });

  test("[unit] confidence above one is an error", () => {
    const rows = readExample();
    at(rows, 0)["confidence"] = "1.5";
    expect(errorsFor(rows).some((e) => e.includes("line 2: confidence"))).toBe(true);
  });

  test("[unit] malformed cost is an error not a gap", () => {
    const rows = readExample();
    at(rows, 0)["cost_usd"] = "about a cent";
    const { errors, gaps } = validate(write(rows));
    expect(errors.some((e) => e.includes("line 2: cost_usd"))).toBe(true);
    expect(gaps.some((g) => g.includes("line 2"))).toBe(false);
  });

  test("[unit] question reworded under the same prompt_version is an error", () => {
    const rows = readExample();
    at(rows, 3)["question"] = "Does this message want money back?";
    expect(errorsFor(rows).some((e) => e.includes("line 5: question q1 changed within prompt_version"))).toBe(true);
  });

  test("[unit] reworded question with a new prompt_version is valid", () => {
    const rows = readExample();
    at(rows, 3)["question"] = "Does this message want money back?";
    at(rows, 3)["prompt_version"] = "refund-q.v2";
    expect(errorsFor(rows)).toEqual([]);
  });

  test("[unit] duplicate row is an error", () => {
    const rows = readExample();
    rows.push({ ...at(rows, 0) });
    expect(errorsFor(rows).some((e) => e.includes("duplicate row for run run-001 (m01, q1, jev)"))).toBe(true);
  });

  test("[unit] case_input must match across rows", () => {
    const rows = readExample();
    at(rows, 3)["case_input"] = "something else";
    expect(errorsFor(rows).some((e) => e.includes("line 5: case_input differs"))).toBe(true);
  });

  test("[unit] wrong format_version is an error", () => {
    const rows = readExample();
    at(rows, 0)["format_version"] = "jnj-record/2";
    expect(errorsFor(rows).some((e) => e.includes("line 2: format_version"))).toBe(true);
  });

  test("[unit] missing column is an error", () => {
    const columns = COLUMNS.filter((c) => c !== "label");
    expect(validate(write(readExample(), columns)).errors).toEqual(["header: missing columns ['label']"]);
  });

  test("[unit] empty file is an error", () => {
    expect(validate(write([])).errors).toEqual(["file has no data rows"]);
  });

  test.each([
    ["confidence", "nan"],
    ["cost_usd", "nan"],
    ["cost_usd", "inf"],
    ["tokens_in", "4_2"],
  ])("[unit] non-finite or odd numbers are errors: %s=%s", (column, value) => {
    const rows = readExample();
    at(rows, 0)[column] = value;
    expect(errorsFor(rows).some((e) => e.includes(`line 2: ${column}`))).toBe(true);
  });

  test("[unit] padded label is an error", () => {
    const rows = readExample();
    at(rows, 0)["label"] = " accept ";
    expect(errorsFor(rows).some((e) => e.includes("line 2: label"))).toBe(true);
  });

  test("[unit] short row is an error", () => {
    const [header, first] = exampleLines();
    const short = first.split(",").slice(0, -4).join(",");
    expect(validate(`${header}\n${short}\n`).errors).toEqual(["line 2: row has fewer cells than the header"]);
  });

  test("[unit] extra cells are an error", () => {
    const [header, first] = exampleLines();
    expect(validate(`${header}\n${first},junk,junk\n`).errors).toEqual(["line 2: row has more cells than the header"]);
  });

  test("[unit] duplicate header is an error", () => {
    const [header, first] = exampleLines();
    expect(validate(`${header},run_id\n${first},run-002\n`).errors[0]).toBe("header: duplicate column names ['run_id']");
  });
});
