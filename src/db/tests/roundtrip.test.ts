// Load, export and reload: round trip, idempotence, label gap fill, type fidelity.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { exportCsv } from "../export.ts";
import { loadFile } from "../load.ts";
import {
  cellOf,
  col,
  count,
  D06,
  EXAMPLE,
  exampleRows,
  loadError,
  makeWorkspace,
  numericOnlyDifferences,
  setCell,
  tmpPath,
  useConnection,
  writeCsv,
} from "./support.ts";

const TABLES = ["import_file", "run", "question", "test_case", "answer", "label"];

describe("round trip", () => {
  const conn = useConnection();

  test("[unit] equivalence rule accepts respelled numbers and nothing else", () => {
    const source = "a,cost_usd\nx,1.8e-06\n";
    expect(numericOnlyDifferences(source, "a,cost_usd\nx,0.0000018\n")).toEqual([[2, "cost_usd", "1.8e-06", "0.0000018"]]);
    expect(() => numericOnlyDifferences(source, "a,cost_usd\ny,1.8e-06\n")).toThrow();
    expect(() => numericOnlyDifferences(source, "a,cost_usd\nx,0.000002\n")).toThrow();
    expect(() => numericOnlyDifferences("a,cost_usd\nx,\n", "a,cost_usd\nx,0\n")).toThrow();
  });

  test("[integration] d06 export equals source after CRLF to LF", async () => {
    const raw = await Bun.file(D06).text();
    expect(raw.split("\r\n").length - 1).toBe(31);
    const body = raw.replaceAll("\r\n", "\n");
    expect(body.includes("\r")).toBe(false);
    expect(body.split("\n").length - 1).toBe(31);
    const workspace = await makeWorkspace(conn(), "synthetic");
    const result = await loadFile(conn(), workspace, D06);
    expect([result.status, result.answers, result.labels]).toEqual(["loaded", 30n, 29n]);
    expect((await exportCsv(conn(), workspace, "run-d06")).text).toBe(body);
  });

  test("[integration] example export is byte-identical except exponent cells", async () => {
    const workspace = await makeWorkspace(conn(), "synthetic");
    await loadFile(conn(), workspace, EXAMPLE);
    const source = await Bun.file(EXAMPLE).text();
    const exported = (await exportCsv(conn(), workspace, "run-001")).text;
    expect(numericOnlyDifferences(source, exported)).toEqual([
      [2, "cost_usd", "1.8e-06", "0.0000018"],
      [3, "cost_usd", "1.6e-06", "0.0000016"],
      [4, "cost_usd", "1.9e-06", "0.0000019"],
    ]);
    const exportedLines = exported.split("\n");
    const differing = source.split("\n").filter((line, index) => line !== exportedLines[index]);
    expect(differing.length).toBe(3);
    expect(differing.every((line) => line.includes("e-06"))).toBe(true);
  });

  test("[integration] export, reload, export is a fixed point", async () => {
    const first = await makeWorkspace(conn(), "synthetic");
    const second = await makeWorkspace(conn(), "synthetic");
    await loadFile(conn(), first, EXAMPLE);
    const text = (await exportCsv(conn(), first, "run-001")).text;
    const path = join(tmpPath(), "exported.csv");
    await Bun.write(path, text);
    await loadFile(conn(), second, path);
    expect((await exportCsv(conn(), second, "run-001")).text).toBe(text);
  });

  test("[integration] reloading the identical file is a no-op", async () => {
    const workspace = await makeWorkspace(conn(), "synthetic");
    await loadFile(conn(), workspace, D06);
    const snapshot = async (): Promise<[Record<string, number>, string]> => {
      const counts: Record<string, number> = {};
      for (const table of TABLES) counts[table] = await count(conn(), table, workspace);
      return [counts, (await exportCsv(conn(), workspace, "run-d06")).text];
    };
    const before = await snapshot();
    const result = await loadFile(conn(), workspace, D06);
    const after = await snapshot();
    expect([result.status, result.answers, result.labels]).toEqual(["unchanged", 0n, 0n]);
    expect(after).toEqual(before);
    expect(before[0]).toEqual({ import_file: 1, run: 1, question: 2, test_case: 5, answer: 30, label: 29 });
  });

  test("[integration] labels file fills a missing label and cannot change one", async () => {
    const workspace = await makeWorkspace(conn(), "synthetic");
    await loadFile(conn(), workspace, EXAMPLE);
    const { header, rows } = await exampleRows();
    const label = col(header, "label");
    const source = col(header, "label_source");
    expect(cellOf(rows, 7, label)).toBe("");
    setCell(rows, 7, label, "reject");
    setCell(rows, 7, source, "human");
    const dir = tmpPath();
    const filled = await loadFile(conn(), workspace, writeCsv(join(dir, "labels.csv"), header, rows), { purpose: "labels" });
    expect([filled.status, filled.answers, filled.labels]).toEqual(["loaded", 0n, 1n]);
    expect(await count(conn(), "label", workspace)).toBe(9);
    const exported = (await exportCsv(conn(), workspace, "run-001")).text.split("\n");
    expect(exported[8]?.endsWith(",no,,reject,human,115,3,0.00037,1750")).toBe(true);

    setCell(rows, 0, label, "reject");
    const error = await loadError(
      loadFile(conn(), workspace, writeCsv(join(dir, "relabel.csv"), header, rows), { purpose: "labels" }),
    );
    expect(error.message).toMatch(/changing a label is rejected/);
    expect(await count(conn(), "label", workspace)).toBe(9);
  });

  test("[integration] labels file row must match a loaded answer", async () => {
    const workspace = await makeWorkspace(conn(), "synthetic");
    await loadFile(conn(), workspace, EXAMPLE);
    const { header, rows } = await exampleRows();
    setCell(rows, 7, col(header, "output"), "yes");
    setCell(rows, 7, col(header, "label"), "reject");
    setCell(rows, 7, col(header, "label_source"), "human");
    const error = await loadError(
      loadFile(conn(), workspace, writeCsv(join(tmpPath(), "labels.csv"), header, rows), { purpose: "labels" }),
    );
    expect(error.message).toMatch(/line 9: row does not match a loaded answer/);
    expect(await count(conn(), "label", workspace)).toBe(8);
  });

  test("[integration] invalid file writes nothing", async () => {
    const workspace = await makeWorkspace(conn(), "synthetic");
    const { header, rows } = await exampleRows();
    setCell(rows, -1, col(header, "confidence"), "1.5");
    const error = await loadError(loadFile(conn(), workspace, writeCsv(join(tmpPath(), "bad.csv"), header, rows)));
    expect(error.message).toMatch(/line 10: confidence/);
    expect(await count(conn(), "import_file", workspace)).toBe(0);
    expect(await count(conn(), "answer", workspace)).toBe(0);
  });

  test("[integration] database error rolls back the whole file", async () => {
    const workspace = await makeWorkspace(conn(), "synthetic");
    await loadFile(conn(), workspace, EXAMPLE);
    const { header, rows } = await exampleRows();
    for (const row of rows) {
      row[col(header, "run_id")] = "run-002";
      row[col(header, "prompt_version")] = "refund-q.v2";
    }
    // only the last row reuses the loaded prompt_version, with new wording: the DB catches it
    setCell(rows, -1, col(header, "prompt_version"), "refund-q.v1");
    setCell(rows, -1, col(header, "question"), "Is this a refund request?");
    const error = await loadError(loadFile(conn(), workspace, writeCsv(join(tmpPath(), "reworded.csv"), header, rows)));
    expect(error.message).toMatch(/question q1 under prompt_version refund-q\.v1/);
    const counts = {
      import_file: await count(conn(), "import_file", workspace),
      run: await count(conn(), "run", workspace),
      answer: await count(conn(), "answer", workspace),
    };
    expect(counts).toEqual({ import_file: 1, run: 1, answer: 9 });
  });

  test("[integration] type fidelity: numeric reads back exact text, int8 a bigint, timestamptz a Date object", async () => {
    const workspace = await makeWorkspace(conn(), "synthetic");
    await loadFile(conn(), workspace, EXAMPLE);
    const rows = await conn()`
      select v.confidence, v.cost_usd, v.tokens_in, v.latency_ms, v.label, v.labelled_at, f.loaded_at
      from jnj.record_v1 v join jnj.import_file f on f.id = v.import_file_pk
      join jnj.workspace w on w.id = v.workspace_id where w.slug = ${workspace} order by v.source_line`;
    const first = rows[0];
    if (first === undefined) throw new Error("no rows");
    expect([first["confidence"], first["cost_usd"], first["tokens_in"], first["latency_ms"]]).toEqual([
      "0.96",
      "0.0000018",
      42n,
      380n,
    ]);
    expect(typeof first["confidence"]).toBe("string");
    expect(typeof first["cost_usd"]).toBe("string");
    expect(typeof first["tokens_in"]).toBe("bigint");
    expect(first["labelled_at"]).toBeInstanceOf(Date);
    expect(first["loaded_at"]).toBeInstanceOf(Date);
    expect(rows[3]?.["confidence"]).toBeNull();
    expect(rows[7]?.["label"]).toBeNull();
    expect(rows[7]?.["labelled_at"]).toBeNull();
    expect(rows[8]?.["cost_usd"]).toBeNull();
    expect(rows[3]?.["cost_usd"]).toBe("0");
  });
});
