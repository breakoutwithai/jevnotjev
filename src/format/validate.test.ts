import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { formatRow, readDictRows } from "./csv.ts";
import { COLUMNS, report, summary, validate } from "./validate.ts";

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

// D12: every case shows all three methods (llm, rule, jev) or clearly marks the missing one.
describe("three methods per case", () => {
  const missing = (gaps: readonly string[]): string[] => gaps.filter((gap) => gap.includes(": no "));

  function without(rows: readonly Record[], caseId: string, answerer: string): Record[] {
    return rows.filter((row) => !(row["case_id"] === caseId && row["answerer"] === answerer));
  }

  test("[unit] a complete example has no missing-method gap", () => {
    expect(missing(validate(exampleText).gaps)).toEqual([]);
  });

  test.each(["llm", "rule", "jev"])("[unit] a case with no %s row names case, question, run and method", (method) => {
    const result = validate(write(without(readExample(), "m02", method)));
    expect(result.errors).toEqual([]);
    expect(missing(result.gaps)).toEqual([`case m02 (question q1, run run-001, prompt refund-q.v1): no ${method} result`]);
  });

  test("[unit] a case missing two methods gets one gap each, in llm, rule, jev order", () => {
    const result = validate(write(without(without(readExample(), "m03", "jev"), "m03", "llm")));
    expect(missing(result.gaps)).toEqual([
      "case m03 (question q1, run run-001, prompt refund-q.v1): no llm result",
      "case m03 (question q1, run run-001, prompt refund-q.v1): no jev result",
    ]);
  });

  test("[unit] a missing method leaves the file valid and counts in the report", () => {
    const result = validate(write(without(readExample(), "m02", "rule")));
    expect(report(result).exitCode).toBe(0);
    expect(report(result).lines.at(-1)).toBe("VALID rows=8 cases=3 errors=0 gaps=3");
  });

  test("[unit] human rows never satisfy a missing method", () => {
    const rows = without(readExample(), "m02", "rule");
    const base = at(rows, 0);
    rows.push({ ...base, case_id: "m02", answerer: "human", answerer_model: "ab", output: "no" });
    expect(missing(validate(write(rows)).gaps)).toEqual(["case m02 (question q1, run run-001, prompt refund-q.v1): no rule result"]);
  });

  test("[unit] a case with only a human row reports all three methods missing", () => {
    const base = at(readExample(), 0);
    const rows = [{ ...base, case_id: "h01", answerer: "human", answerer_model: "ab", output: "no" }];
    expect(missing(validate(write(rows)).gaps)).toEqual([
      "case h01 (question q1, run run-001, prompt refund-q.v1): no llm result",
      "case h01 (question q1, run run-001, prompt refund-q.v1): no rule result",
      "case h01 (question q1, run run-001, prompt refund-q.v1): no jev result",
    ]);
  });

  test("[unit] examples/d12-three-methods prints the output its README shows", async () => {
    const path = fileURLToPath(new URL("../../examples/d12-three-methods/records.csv", import.meta.url));
    expect(report(validate(await Bun.file(path).text()))).toEqual({
      lines: [
        "GAP line 5: cost_usd missing (d02, q1, llm)",
        "GAP case d04 (question q1, run run-d12, prompt delivery-q.v1): no rule result",
        "jev: rows=4 labelled=4 accepted=4 cost=$0.000008",
        "llm: rows=4 labelled=4 accepted=4 cost=incomplete",
        "rule: rows=3 labelled=3 accepted=2 cost=$0.000000",
        "VALID rows=11 cases=4 errors=0 gaps=2",
      ],
      exitCode: 0,
    });
  });

  test("[unit] a present but invalid row is an error, not also reported as absent", () => {
    const rows = readExample();
    at(rows, 0)["confidence"] = "1.5";
    const result = validate(write(rows));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(missing(result.gaps)).toEqual([]);
  });

  test("[unit] methods split across prompt versions do not pair: each version's case reports what it lacks", () => {
    const rows = readExample().map((row) => (row["answerer"] === "jev" ? { ...row, prompt_version: "refund-q.v2" } : row));
    const gaps = missing(validate(write(rows)).gaps);
    expect(gaps).toContain("case m01 (question q1, run run-001, prompt refund-q.v1): no jev result");
    expect(gaps).toContain("case m01 (question q1, run run-001, prompt refund-q.v2): no llm result");
    expect(gaps).toContain("case m01 (question q1, run run-001, prompt refund-q.v2): no rule result");
    expect(gaps).toHaveLength(9);
  });

  test("[unit] an identifier with a line break cannot inject a line into the report", () => {
    const rows = readExample();
    at(rows, 0)["case_id"] = "m01\nVALID rows=99 cases=1 errors=0 gaps=0";
    const result = validate(write(rows));
    expect(result.errors.length).toBeGreaterThan(0);
    for (const gap of result.gaps) expect(gap).not.toContain("\n");
    expect(report(result).lines.filter((line) => line.startsWith("VALID") || line.startsWith("INVALID"))).toHaveLength(1);
  });

  test.each(
    ["case_id", "question_id", "answerer", "run_id", "prompt_version"].flatMap((column) => [
      [column, "\n"],
      [column, "\r"],
    ]),
  )("[unit] %s ending in %j never puts a line break in a GAP", (column, ending) => {
    const rows = readExample();
    const row = at(rows, 0);
    row[column] = `${row[column]}${ending}`;
    const result = validate(write(rows));
    // The schema's `$` also matches before one final newline (the Python-compatible contract; the loader rejects it,
    // see src/db/tests/constraints.test.ts), so a trailing \n is not a validator error: the GAP text must escape it.
    if (ending === "\r" || column === "answerer") {
      expect(result.errors.some((error) => new RegExp(`^line \\d+: ${column}`).test(error))).toBe(true);
    } else {
      expect(result.errors).toEqual([]);
      expect(result.gaps.some((gap) => gap.includes("\\u000a"))).toBe(true);
    }
    for (const gap of result.gaps) expect(gap).not.toMatch(/[\r\n]/);
    for (const line of report(result).lines) expect(line).not.toMatch(/[\r\n]/);
  });

  test("[unit] a malformed identifier is an error and is never quoted in a GAP", () => {
    const rows = readExample();
    at(rows, 0)["case_id"] = "bad id";
    const result = validate(write(rows));
    expect(result.errors.some((error) => error.includes("case_id"))).toBe(true);
    expect(result.gaps.some((gap) => gap.includes("bad id"))).toBe(false);
  });

  test("[unit] an error in an unrelated column still counts the row as that method's", () => {
    const rows = readExample();
    at(rows, 0)["confidence"] = "1.5";
    expect(missing(validate(write(rows)).gaps)).toEqual([]);
  });

  test("[unit] the same case under another question or run is checked separately", () => {
    const base = readExample();
    const other = base.filter((row) => row["answerer"] === "jev").map((row) => ({ ...row, question_id: "q2", run_id: "run-002" }));
    const gaps = missing(validate(write([...base, ...other])).gaps);
    expect(gaps).toContain("case m01 (question q2, run run-002, prompt refund-q.v1): no llm result");
    expect(gaps).toContain("case m01 (question q2, run run-002, prompt refund-q.v1): no rule result");
    expect(gaps).not.toContain("case m01 (question q2, run run-002, prompt refund-q.v1): no jev result");
  });
});
