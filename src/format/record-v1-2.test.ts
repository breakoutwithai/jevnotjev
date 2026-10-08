// Format jnj-record/1.2 (format/README.md "Answerer decisions and outcomes"): the answerer `decisions` and the optional
// `outcome` column. A row whose outcome is not `answered` carries no output and no label. /1 and /1.1 files are unchanged.
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { caseCell } from "../core/case-table.ts";
import { formatRow, readDictRows } from "./csv.ts";
import { COLUMNS, COLUMNS_V1_1, COLUMNS_V1_2, OUTCOMES, report, summary, validate } from "./validate.ts";

const ROOT = join(import.meta.dir, "..", "..");
const EXAMPLE_V1 = join(ROOT, "format", "example-v1.csv");
const EXAMPLE_V1_2 = join(ROOT, "format", "example-v1.2.csv");

type Record = { [column: string]: string };

async function recordsOf(path: string): Promise<{ header: readonly string[]; rows: Record[] }> {
  const { header, rows } = readDictRows(await Bun.file(path).text());
  return {
    header: header ?? [],
    rows: rows.map(({ fields }) => {
      const row: Record = {};
      (header ?? []).forEach((name, index) => {
        row[name] = fields[index] ?? "";
      });
      return row;
    }),
  };
}

function write(rows: readonly Record[], columns: readonly string[]): string {
  return [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))]
    .map((fields) => formatRow(fields, "\r\n"))
    .join("");
}

function first(rows: Record[]): Record {
  const row = rows[0];
  if (row === undefined) throw new Error("no row 0");
  return row;
}

/** The /1 example as unlabelled /1.2 rows with an outcome column: the shape an API run writes. */
async function v12Rows(): Promise<Record[]> {
  const { rows } = await recordsOf(EXAMPLE_V1);
  return rows.map((row) => ({ ...row, format_version: "jnj-record/1.2", label: "", label_source: "", outcome: "answered" }));
}

/** Every record file the repo ships that is jnj-record/1 or /1.1, found by its first data row. */
async function v1AndV11Files(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".csv")) {
        const { rows } = await recordsOf(path);
        const version = rows[0]?.["format_version"];
        if (version === "jnj-record/1" || version === "jnj-record/1.1") found.push(path);
      }
    }
  };
  await walk(join(ROOT, "examples"));
  await walk(join(ROOT, "format"));
  return found;
}

describe("jnj-record/1.2: answerer decisions and outcome (F12-1)", () => {
  test("[unit] F12-1 the /1.2 example, with a decisions answerer and a refused row, is valid", async () => {
    const result = validate(await Bun.file(EXAMPLE_V1_2).text());
    expect(result.errors).toEqual([]);
    const versions = new Set(result.rows.map(({ values }) => values.get("format_version")));
    expect([...versions]).toEqual(["jnj-record/1.2"]);
    expect(result.rows.some(({ values }) => values.get("answerer") === "decisions")).toBe(true);
    expect(result.rows.some(({ values }) => values.get("outcome") === "refused" && values.get("output") === null)).toBe(true);
    expect(report(result).exitCode).toBe(0);
  });

  test("[unit] F12-1 the 1.2 columns are the 1.1 columns plus price_table_date and outcome", () => {
    expect(COLUMNS_V1_2).toEqual([...COLUMNS_V1_1, "price_table_date", "outcome"]);
    expect(OUTCOMES).toEqual(["answered", "refused", "unsupported", "error"]);
  });

  test.each(["jev", "rule", "llm", "human", "decisions"])("[unit] F12-1 a 1.2 row accepts answerer %s", async (answerer) => {
    const rows = await v12Rows();
    // Its own run, so a changed answerer never duplicates another row of the example.
    Object.assign(first(rows), { answerer, run_id: "run-answerer" });
    expect(validate(write(rows, COLUMNS_V1_2)).errors).toEqual([]);
  });

  test("[unit] F12-1 a 1.2 file without the outcome column is valid and every row reads as answered", async () => {
    const rows = await v12Rows();
    const result = validate(write(rows, [...COLUMNS]));
    expect(result.errors).toEqual([]);
    expect(result.rows.every(({ values }) => values.get("outcome") === undefined)).toBe(true);
  });

  test("[unit] F12-1 an unknown outcome value is rejected", async () => {
    const rows = await v12Rows();
    first(rows)["outcome"] = "skipped";
    expect(validate(write(rows, COLUMNS_V1_2)).errors).toEqual([
      "line 2: outcome: 'skipped' is not one of ['answered', 'refused', 'unsupported', 'error', None]",
    ]);
  });

  test.each(["jnj-record/1", "jnj-record/1.1"])("[unit] F12-1 a %s row cannot name answerer decisions", async (version) => {
    const { rows } = await recordsOf(EXAMPLE_V1);
    first(rows)["format_version"] = version;
    first(rows)["answerer"] = "decisions";
    if (version === "jnj-record/1.1") for (const row of rows) Object.assign(row, { label: "", label_source: "" });
    expect(validate(write(rows, [...COLUMNS])).errors).toEqual([
      "line 2: answerer: 'decisions' is not one of ['jev', 'rule', 'llm', 'human']",
    ]);
  });

  test.each(["jnj-record/1", "jnj-record/1.1"])(
    "[unit] F12-1 a %s file may carry an empty outcome column, and a filled outcome cell is rejected",
    async (version) => {
      const { rows } = await recordsOf(EXAMPLE_V1);
      for (const row of rows) Object.assign(row, { format_version: version, label: "", label_source: "", outcome: "" });
      const columns = [...COLUMNS, "outcome"];
      expect(validate(write(rows, columns)).errors).toEqual([]);
      first(rows)["outcome"] = "answered";
      expect(validate(write(rows, columns)).errors).toEqual(["line 2: outcome: 'answered' is not of type 'null'"]);
    },
  );

  test("[smoke] F12-1 every /1 and /1.1 file the repo ships still validates with no errors", async () => {
    const files = await v1AndV11Files();
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const file of files) {
      const errors = validate(await Bun.file(file).text()).errors;
      expect({ file, errors }).toEqual({ file, errors: [] });
    }
  });

  test("[unit] F12-1 a labelled 1.2 row needs the 1.1 label provenance", async () => {
    const rows = await v12Rows();
    Object.assign(first(rows), { label: "accept", label_source: "human" });
    expect(validate(write(rows, COLUMNS_V1_2)).errors).toEqual([
      "line 2: labelled_by: None is not of type 'string'",
      "line 2: labelled_at: None is not of type 'string'",
      "line 2: label_blind: None is not of type 'string'",
    ]);
    Object.assign(first(rows), { labelled_by: "op-1", labelled_at: "2026-10-08", label_blind: "true" });
    expect(validate(write(rows, COLUMNS_V1_2)).errors).toEqual([]);
  });
});

describe("jnj-record/1.2: empty output only when the outcome is not answered (F12-2)", () => {
  test.each(["refused", "unsupported", "error"])("[unit] F12-2 an empty output is valid with outcome %s", async (outcome) => {
    const rows = await v12Rows();
    Object.assign(first(rows), { outcome, output: "" });
    expect(validate(write(rows, COLUMNS_V1_2)).errors).toEqual([]);
  });

  test("[unit] F12-2 an empty output with outcome answered is rejected", async () => {
    const rows = await v12Rows();
    Object.assign(first(rows), { outcome: "answered", output: "" });
    expect(validate(write(rows, COLUMNS_V1_2)).errors).toEqual(["line 2: output: None is not of type 'string'"]);
  });

  test("[unit] F12-2 an empty output with no outcome is rejected, as an absent outcome means answered", async () => {
    const rows = await v12Rows();
    Object.assign(first(rows), { outcome: "", output: "" });
    expect(validate(write(rows, COLUMNS_V1_2)).errors).toEqual(["line 2: output: None is not of type 'string'"]);
    expect(validate(write(rows, [...COLUMNS])).errors).toEqual(["line 2: output: None is not of type 'string'"]);
  });

  test("[unit] F12-2 an empty output in a /1 file is still rejected", async () => {
    const { rows } = await recordsOf(EXAMPLE_V1);
    first(rows)["output"] = "";
    expect(validate(write(rows, [...COLUMNS])).errors).toEqual(["line 2: output: None is not of type 'string'"]);
  });

  test("[unit] F12-2 an answered output must still be in answer_set", async () => {
    const rows = await v12Rows();
    first(rows)["output"] = "maybe";
    expect(validate(write(rows, COLUMNS_V1_2)).errors).toEqual(["line 2: output 'maybe' is not in answer_set 'yes|no'"]);
  });

  test("[unit] F12-2 a refused row cannot carry an output or a label: no answer, nothing to judge", async () => {
    const rows = await v12Rows();
    Object.assign(first(rows), { outcome: "refused", output: "yes" });
    expect(validate(write(rows, COLUMNS_V1_2)).errors).toEqual(["line 2: output: 'yes' is not of type 'null'"]);
    Object.assign(first(rows), {
      output: "",
      label: "reject",
      label_source: "human",
      labelled_by: "op-1",
      labelled_at: "2026-10-08",
      label_blind: "true",
    });
    expect(validate(write(rows, COLUMNS_V1_2)).errors).toEqual(["line 2: label: 'reject' is not of type 'null'"]);
  });

  test("[unit] F12-2 a refused row counts in rows and cost, and its case cell names the outcome", async () => {
    const rows = await v12Rows();
    Object.assign(first(rows), { outcome: "refused", output: "" });
    const result = validate(write(rows, COLUMNS_V1_2));
    expect(result.errors).toEqual([]);
    expect(summary(result.rows)[0]).toBe("jev: rows=3 labelled=0 accepted=0 cost=$0.000005");
    expect(caseCell(result.rows[0]?.values)).toBe("refused, $0.000002, unlabelled");
  });

  test("[unit] F12-2 a row with no answer is not an unlabelled gap: there is nothing to label", async () => {
    const rows = await v12Rows();
    Object.assign(first(rows), { outcome: "refused", output: "" });
    const gaps = validate(write(rows, COLUMNS_V1_2)).gaps;
    expect(gaps.some((gap) => gap.startsWith("line 2: "))).toBe(false);
    expect(gaps).toContain("line 3: unlabelled (m02, q1, jev)");
  });
});
