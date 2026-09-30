"""Load a jnj-record/1 CSV into Postgres.

Usage: JNJ_DATABASE_URL=<dsn> python3 db/load.py [--labels] [--create-workspace] <workspace> <record.csv>

The file is checked by format/validate.py first; any error and nothing is written. Cells are copied
as raw text into a temp stage table and jnj.load_stage() casts and inserts them in one transaction,
so Python never parses a number. Reloading the identical file is a no-op. --labels loads a file whose
rows are already loaded and only adds labels that were missing.
"""
import argparse
import csv
import hashlib
import os
import re
import sys
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "format"))
from validate import COLUMNS, SCHEMA, validate  # noqa: E402

BIGINT_MAX = 9223372036854775807
NUMERIC_MAX_SCALE = 16383
NUMERIC_MAX_WEIGHT = 131071
INTEGER_COLUMNS = ("tokens_in", "tokens_out", "latency_ms")
NUMBER_COLUMNS = ("confidence", "cost_usd")
PATTERN_COLUMNS = tuple(c for c in COLUMNS if "pattern" in SCHEMA["properties"][c] and c != "answer_set")


class LoadError(Exception):
    """The file cannot be loaded; messages use validate.py's 'line N: column: ...' form."""

    def __init__(self, messages):
        self.messages = list(messages)
        super().__init__("\n".join(self.messages))


@dataclass(frozen=True)
class LoadResult:
    status: str
    answers: int
    labels: int


def read_raw(path):
    """Rows as (line, {column: raw text}) exactly as the CSV holds them."""
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        return [(reader.line_num, {c: row[c] for c in COLUMNS}) for row in reader]


def storage_errors(rows):
    """Values validate.py accepts that the database cannot store as written."""
    errors = []
    for line, row in rows:
        for column, raw in row.items():
            if "\x00" in raw:
                errors.append(f"line {line}: {column}: contains a NUL character, which the database cannot store")
        for column in PATTERN_COLUMNS:
            if row[column].endswith("\n"):
                errors.append(f"line {line}: {column}: {row[column]!r} ends with a line break")
        for column in INTEGER_COLUMNS:
            raw = row[column]
            if raw and int(raw) > BIGINT_MAX:
                errors.append(f"line {line}: {column}: {raw.strip()} is above {BIGINT_MAX}, the largest integer stored")
        for column in NUMBER_COLUMNS:
            raw = row[column]
            if not raw:
                continue
            number = Decimal(raw)
            if -number.as_tuple().exponent > NUMERIC_MAX_SCALE:
                errors.append(f"line {line}: {column}: {raw.strip()} has more than {NUMERIC_MAX_SCALE} "
                              "digits after the decimal point")
            elif number and number.adjusted() > NUMERIC_MAX_WEIGHT:
                errors.append(f"line {line}: {column}: {raw.strip()} has more than {NUMERIC_MAX_WEIGHT + 1} "
                              "digits before the decimal point")
    return errors


def ensure_workspace(conn, workspace):
    """Create a restricted workspace if it does not exist (the loader role may do this)."""
    if not re.fullmatch(r"[a-z0-9-]{1,64}", workspace):
        raise LoadError([f"workspace {workspace!r} must match [a-z0-9-]{{1,64}}"])
    if conn.execute("select 1 from jnj.workspace where slug = %s", (workspace,)).fetchone() is None:
        conn.execute("insert into jnj.workspace (slug) values (%s)", (workspace,))


def load_file(conn, workspace, path, purpose="records", create_workspace=False):
    """Load one CSV into a workspace in one transaction. Returns a LoadResult; raises LoadError or psycopg.Error."""
    if purpose not in ("records", "labels"):
        raise ValueError(f"purpose must be records or labels, not {purpose!r}")
    path = Path(path)
    errors, _gaps, _rows = validate(path)
    if errors:
        raise LoadError(errors)
    rows = read_raw(path)
    errors = storage_errors(rows)
    if errors:
        raise LoadError(errors)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    with conn.transaction():
        if create_workspace:
            ensure_workspace(conn, workspace)
        conn.execute("drop table if exists pg_temp.jnj_stage")
        conn.execute("create temp table jnj_stage (line integer not null, "
                     + ", ".join(f"{c} text not null" for c in COLUMNS) + ") on commit drop")
        with conn.cursor().copy(f"copy pg_temp.jnj_stage (line, {', '.join(COLUMNS)}) from stdin") as copy:
            for line, row in rows:
                copy.write_row([line, *(row[c] for c in COLUMNS)])
        status, answers, labels = conn.execute(
            "select status, answers, labels from jnj.load_stage(%s, %s, %s, %s)",
            (workspace, digest, path.name, purpose),
        ).fetchone()
    return LoadResult(status, answers, labels)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("workspace")
    parser.add_argument("path")
    parser.add_argument("--labels", action="store_true", help="only add missing labels to loaded rows")
    parser.add_argument("--create-workspace", action="store_true", help="create a restricted workspace if missing")
    args = parser.parse_args(argv)
    dsn = os.environ.get("JNJ_DATABASE_URL")
    if not dsn:
        print("set JNJ_DATABASE_URL to a libpq connection string", file=sys.stderr)
        return 2
    try:
        with psycopg.connect(dsn, autocommit=True) as conn:
            result = load_file(conn, args.workspace, args.path,
                               purpose="labels" if args.labels else "records",
                               create_workspace=args.create_workspace)
    except LoadError as error:
        for message in error.messages:
            print(f"ERROR {message}", file=sys.stderr)
        return 1
    except psycopg.Error as error:
        print(f"ERROR {error.diag.message_primary or error}", file=sys.stderr)
        return 1
    print(f"{result.status} answers={result.answers} labels={result.labels}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
