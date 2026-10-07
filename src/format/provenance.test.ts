// Label provenance, format jnj-record/1.1 (format/README.md "Label provenance"): every labelled 1.1 row says who
// labelled it, how, when, and whether the call was made blind. jnj-record/1 files keep validating unchanged.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { formatRow, readDictRows } from "./csv.ts";
import { COLUMNS, COLUMNS_V1_1, PROVENANCE_COLUMNS, report, summary, validate } from "./validate.ts";

const EXAMPLE = fileURLToPath(new URL("../../format/example-v1.csv", import.meta.url));
const exampleText = await Bun.file(EXAMPLE).text();

type Record = { [column: string]: string };

/** The example's rows upgraded to 1.1: every labelled row gets a complete provenance. */
function v11Rows(): Record[] {
  const { header, rows } = readDictRows(exampleText);
  return rows.map(({ fields }) => {
    const row: Record = {};
    (header ?? []).forEach((name, index) => {
      row[name] = fields[index] ?? "";
    });
    row["format_version"] = "jnj-record/1.1";
    const labelled = row["label"] !== "";
    row["labelled_by"] = labelled ? "op-1" : "";
    row["labelled_at"] = labelled ? "2026-10-07T09:30:00Z" : "";
    row["label_blind"] = labelled ? "true" : "";
    return row;
  });
}

function write(rows: readonly Record[], columns: readonly string[] = COLUMNS_V1_1): string {
  return [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))]
    .map((fields) => formatRow(fields, "\r\n"))
    .join("");
}

function first(rows: Record[]): Record {
  const row = rows[0];
  if (row === undefined) throw new Error("no row 0");
  return row;
}

describe("label provenance (jnj-record/1.1)", () => {
  test("[unit] M1 a 1.1 file with complete provenance is valid", () => {
    const { errors } = validate(write(v11Rows()));
    expect(errors).toEqual([]);
  });

  test("[unit] M1 the 1.1 columns are the /1 columns plus labelled_by, labelled_at, label_blind", () => {
    expect(PROVENANCE_COLUMNS).toEqual(["labelled_by", "labelled_at", "label_blind"]);
    expect(COLUMNS_V1_1).toEqual([...COLUMNS, "labelled_by", "labelled_at", "label_blind"]);
  });

  test("[smoke] M1 a jnj-record/1 file without the columns still validates unchanged", () => {
    const { errors, gaps } = validate(exampleText);
    expect(errors).toEqual([]);
    expect(gaps).toHaveLength(2);
  });

  test.each(["label_source", "labelled_by", "labelled_at", "label_blind"])(
    "[unit] M1 a labelled 1.1 row with an empty %s is rejected",
    (column) => {
      const rows = v11Rows();
      first(rows)[column] = "";
      expect(validate(write(rows)).errors).toEqual([`line 2: ${column}: None is not of type 'string'`]);
    },
  );

  test.each(["labelled_by", "labelled_at", "label_blind"])(
    "[unit] M1 a labelled 1.1 row in a file without the %s column is rejected",
    (column) => {
      const columns = COLUMNS_V1_1.filter((name) => name !== column);
      const errors = validate(write(v11Rows(), columns)).errors;
      expect(errors).toContain(`line 2: row: '${column}' is a required property`);
    },
  );

  test("[unit] M1 an unlabelled 1.1 row must leave the provenance empty", () => {
    const rows = v11Rows();
    const unlabelled = rows.find((row) => row["label"] === "");
    if (unlabelled === undefined) throw new Error("example has no unlabelled row");
    unlabelled["labelled_by"] = "op-1";
    expect(validate(write(rows)).errors).toEqual(["line 9: labelled_by: 'op-1' is not of type 'null'"]);
  });

  test.each(["human", "human_reviewed", "agent"])("[unit] M1 label_source %s is accepted in 1.1", (source) => {
    const rows = v11Rows();
    first(rows)["label_source"] = source;
    expect(validate(write(rows)).errors).toEqual([]);
  });

  test("[unit] M1 label_source outside human, human_reviewed, agent is rejected", () => {
    const rows = v11Rows();
    first(rows)["label_source"] = "robot";
    expect(validate(write(rows)).errors).toEqual([
      "line 2: label_source: 'robot' is not one of ['human', 'human_reviewed', 'agent', None]",
    ]);
  });

  test.each(["human_reviewed", "agent"])("[unit] M1 a jnj-record/1 row cannot claim label_source %s", (source) => {
    const { header, rows } = readDictRows(exampleText);
    const fields = [...(rows[0]?.fields ?? [])];
    fields[(header ?? []).indexOf("label_source")] = source;
    const text = [header ?? [], fields, ...rows.slice(1).map((r) => r.fields)].map((f) => formatRow(f)).join("");
    expect(validate(text).errors).toEqual([`line 2: label_source: '${source}' is not one of ['human', None]`]);
  });

  test("[unit] M1 a jnj-record/1 row cannot carry provenance cells", () => {
    const rows = v11Rows();
    first(rows)["format_version"] = "jnj-record/1";
    expect(validate(write(rows)).errors).toEqual([
      "line 2: labelled_by: 'op-1' is not of type 'null'",
      "line 2: labelled_at: '2026-10-07T09:30:00Z' is not of type 'null'",
      "line 2: label_blind: 'true' is not of type 'null'",
    ]);
  });

  test.each([
    ["labelled_by", "someone@example.com"],
    ["labelled_by", "has space"],
    ["labelled_at", "yesterday"],
    ["labelled_at", "2026-10-07T09:30:00+01:00"],
    ["labelled_at", "2026-13-01"],
    ["label_blind", "yes"],
  ])("[unit] M1 a malformed %s (%s) is rejected", (column, value) => {
    const rows = v11Rows();
    first(rows)[column] = value;
    const errors = validate(write(rows)).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.startsWith(`line 2: ${column}: `)).toBe(true);
  });

  test.each(["2026-10-03", "2026-10-07T09:30Z", "2026-10-07T09:30:00Z", "2026-10-07T09:30:00.123Z"])(
    "[unit] M1 labelled_at %s is accepted",
    (value) => {
      const rows = v11Rows();
      first(rows)["labelled_at"] = value;
      expect(validate(write(rows)).errors).toEqual([]);
    },
  );

  test.each(["2026-02-31", "2026-02-29T10:00:00Z", "2026-04-31"])("[unit] M1 labelled_at %s, not a calendar date, is rejected", (value) => {
    const rows = v11Rows();
    first(rows)["labelled_at"] = value;
    expect(validate(write(rows)).errors).toEqual([`line 2: labelled_at: '${value}' is not a calendar date`]);
  });

  test.each(["2028-02-29", "0099-01-01"])("[unit] M1 labelled_at %s, a calendar date, is accepted", (value) => {
    const rows = v11Rows();
    first(rows)["labelled_at"] = value;
    expect(validate(write(rows)).errors).toEqual([]);
  });

  test.each([
    ["labelled_by", "op-1\n"],
    ["labelled_at", "2026-10-07\n"],
  ])("[unit] M1 a %s ending in a line break is rejected", (column, value) => {
    const rows = v11Rows();
    first(rows)[column] = value;
    expect(validate(write(rows)).errors).toEqual([`line 3: ${column}: ${JSON.stringify(value).replace(/"/g, "'")} ends with a line break`]);
  });

  test("[unit] M1 an agent label is never counted as truth: unlabelled in the summary, reported as a gap", () => {
    const rows = v11Rows();
    first(rows)["label_source"] = "agent";
    const result = validate(write(rows));
    expect(result.errors).toEqual([]);
    expect(result.gaps).toContain("line 2: agent label not reviewed (m01, q1, jev)");
    expect(summary(result.rows)[0]).toBe("jev: rows=3 labelled=2 accepted=2 cost=$0.000005");
    expect(report(result).exitCode).toBe(0);
  });
});
