"""Apply numbered, forward-only SQL migrations and record each file's sha256.

Usage: JNJ_DATABASE_URL=<dsn> python3 db/migrate.py
Files are db/migrations/NNNN_name.sql, applied in number order, one transaction per file.
An applied file whose sha256 has changed stops the run: write a new migration instead.
"""
import hashlib
import os
import re
import sys
from pathlib import Path

import psycopg

MIGRATIONS = Path(__file__).resolve().with_name("migrations")
NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
LEDGER = """
create table if not exists public.jnj_schema_migration (
  number integer primary key,
  name text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
)
"""


def migrate(conn, directory=MIGRATIONS):
    """Apply pending migrations on an autocommit connection, one transaction per file.

    Returns the names applied; raises if an applied file changed.
    """
    files = sorted(p for p in Path(directory).iterdir() if NAME.match(p.name))
    applied_now = []
    conn.execute("select pg_advisory_lock(hashtext('jnj_schema_migration'))")
    try:
        conn.execute(LEDGER)
        ledger = {n: (name, sha) for n, name, sha in conn.execute(
            "select number, name, sha256 from public.jnj_schema_migration")}
        for path in files:
            number = int(NAME.match(path.name).group(1))
            sql = path.read_bytes()
            digest = hashlib.sha256(sql).hexdigest()
            if number in ledger:
                if ledger[number] != (path.name, digest):
                    raise RuntimeError(f"{path.name} changed after it was applied "
                                       f"(ledger has {ledger[number][0]} sha256 {ledger[number][1][:12]}); "
                                       "write a new migration instead")
                continue
            with conn.transaction():
                conn.execute(sql.decode("utf-8"))
                conn.execute("insert into public.jnj_schema_migration (number, name, sha256) values (%s, %s, %s)",
                             (number, path.name, digest))
            applied_now.append(path.name)
    finally:
        conn.execute("select pg_advisory_unlock(hashtext('jnj_schema_migration'))")
    return applied_now


def main():
    dsn = os.environ.get("JNJ_DATABASE_URL")
    if not dsn:
        print("set JNJ_DATABASE_URL to a libpq connection string", file=sys.stderr)
        return 2
    with psycopg.connect(dsn, autocommit=True) as conn:
        applied = migrate(conn)
    print("\n".join(f"applied {name}" for name in applied) or "up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
