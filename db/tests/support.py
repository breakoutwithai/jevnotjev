"""Test helpers: paths, CSV writers and the round-trip equivalence rule."""
import csv
import io
import os
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "format" / "example-v1.csv"
D06 = ROOT / "examples" / "d06-tiny" / "records.csv"
ADMIN_DSN = os.environ.get("JNJ_TEST_ADMIN_DSN", "host=/tmp port=5432 dbname=postgres")
NUMERIC_COLUMNS = {"confidence", "cost_usd", "tokens_in", "tokens_out", "latency_ms"}


def write_csv(path, header, rows):
    """Write rows as CSV with LF endings and minimal quoting."""
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)
    return path


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        return header, [list(row) for row in reader]


def example_rows():
    return read_csv(EXAMPLE)


def count(conn, table, workspace):
    return conn.execute(
        f"select count(*) from jnj.{table} t join jnj.workspace w on w.id = t.workspace_id where w.slug = %s",
        (workspace,),
    ).fetchone()[0]


def numeric_only_differences(source_text, exported_text):
    """Compare two CSV texts under the round-trip rule.

    Header and row order must match and every text cell must be identical. A numeric cell
    may differ in spelling only when both sides are Decimal-equal (1.8e-06 == 0.0000018).
    Returns the (row, column, source, exported) cells that differ in spelling only; raises
    AssertionError on any other difference.
    """
    source = list(csv.reader(io.StringIO(source_text)))
    exported = list(csv.reader(io.StringIO(exported_text)))
    assert source[0] == exported[0], f"header differs: {source[0]} != {exported[0]}"
    assert len(source) == len(exported), f"row count differs: {len(source)} != {len(exported)}"
    header = source[0]
    respelled = []
    for index, (left, right) in enumerate(zip(source[1:], exported[1:]), start=2):
        for column, a, b in zip(header, left, right):
            if a == b:
                continue
            assert column in NUMERIC_COLUMNS and a and b, f"row {index} {column}: {a!r} != {b!r}"
            assert Decimal(a) == Decimal(b), f"row {index} {column}: {a!r} is not Decimal-equal to {b!r}"
            respelled.append((index, column, a, b))
    return respelled
