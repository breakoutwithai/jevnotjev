#!/usr/bin/env bash
# Parity: the Python validator, loader, exporter and migrator as they were at PARITY_REF
# (default be5f849, the last commit with them) against the TypeScript port, on every fixture.
# Prints the fixture count; exits non-zero on a difference or on zero fixtures.
#
#   bash scripts/parity.sh
#
# Needs: bun, git, a local Postgres (JNJ_TEST_ADMIN_DSN, default host=/tmp port=5432 dbname=postgres)
# and python3 with venv. PARITY_PYTHON=<interpreter with jsonschema and psycopg> skips the venv install.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${PARITY_REF:-be5f849}"
ADMIN="${JNJ_TEST_ADMIN_DSN:-host=/tmp port=5432 dbname=postgres}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/jnj-parity.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/py"
git -C "$ROOT" archive "$REF" format db requirements.txt | tar -x -C "$WORK/py"

PYTHON="${PARITY_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  BASE=""
  for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then BASE="$candidate"; break; fi
  done
  [ -n "$BASE" ] || { echo "parity: no python3 found" >&2; exit 1; }
  "$BASE" -m venv "$WORK/venv"
  "$WORK/venv/bin/pip" install --quiet --disable-pip-version-check -r "$WORK/py/requirements.txt"
  PYTHON="$WORK/venv/bin/python"
fi
echo "parity: python $("$PYTHON" --version 2>&1 | cut -d' ' -f2) from $REF, bun $(bun --version)"

status=0
bun "$ROOT/scripts/parity.ts" --python "$PYTHON" --python-root "$WORK/py" --work "$WORK" --admin "$ADMIN" || status=$?
exit "$status"
