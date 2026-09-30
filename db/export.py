"""Export one run as jnj-record/1 CSV from the view jnj.record_v1.

Usage: JNJ_DATABASE_URL=<dsn> python3 db/export.py <workspace> --run <run_id> > records.csv

One run per file: case text is fixed per run, not across runs, so a multi-run file could fail
validate.py. Rows come out in source-line order. LF line endings, minimal quoting, header
in format order. Numbers are written as Postgres prints them, so 1.8e-06 comes back as 0.0000018
(Decimal-equal). A restricted workspace keeps no case or question text: those cells are empty and
a notice says so.
"""
import argparse
import csv
import io
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "format"))
from validate import COLUMNS  # noqa: E402


@dataclass(frozen=True)
class Export:
    text: str
    notices: list = field(default_factory=list)


def export_csv(conn, workspace, run_id):
    """Return one run's records as CSV text plus any notices."""
    found = conn.execute("select id, content_policy from jnj.workspace where slug = %s", (workspace,)).fetchone()
    if found is None:
        raise LookupError(f"workspace {workspace} does not exist")
    workspace_pk, policy = found
    columns = ", ".join(f"{c}::text" for c in COLUMNS)
    rows = conn.execute(f"select {columns} from jnj.record_v1 where workspace_id = %s and run_id = %s"
                        " order by source_line", (workspace_pk, run_id)).fetchall()
    if not rows:
        raise LookupError(f"run {run_id} has no records in workspace {workspace}")
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(COLUMNS)
    writer.writerows(["" if cell is None else cell for cell in row] for row in rows)
    notices = []
    if policy != "synthetic":
        cases = len({row[COLUMNS.index("case_id")] for row in rows})
        questions = len({(row[COLUMNS.index("prompt_version")], row[COLUMNS.index("question_id")]) for row in rows})
        notices.append(f"case_input and question withheld: workspace {workspace} is content_policy={policy};"
                       f" {cases} cases and {questions} questions keep only sha256 and length,"
                       " so this export does not validate")
    return Export(buffer.getvalue(), notices)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("workspace")
    parser.add_argument("--run", required=True, help="the run_id to export")
    args = parser.parse_args(argv)
    dsn = os.environ.get("JNJ_DATABASE_URL")
    if not dsn:
        print("set JNJ_DATABASE_URL to a libpq connection string", file=sys.stderr)
        return 2
    with psycopg.connect(dsn, autocommit=True) as conn:
        result = export_csv(conn, args.workspace, args.run)
    for notice in result.notices:
        print(f"NOTICE {notice}", file=sys.stderr)
    sys.stdout.write(result.text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
