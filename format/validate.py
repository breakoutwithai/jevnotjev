"""Validate a TokenMax results CSV against format tokenmax-results/1.

Usage: python3 format/validate.py <results.csv>
Exit 0 when the file is valid (gaps are reported, not errors); exit 1 on any error.
Needs: pip install -r requirements.txt
"""
import csv
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).with_name("results-v1.schema.json")
SCHEMA = json.loads(SCHEMA_PATH.read_text())
COLUMNS = SCHEMA["required"]
INTEGER_COLUMNS = {"picker_tokens_in", "model_tokens_in", "model_tokens_out"}
NUMBER_COLUMNS = {"picker_cost_usd", "model_cost_usd", "jev_confidence"}
BOOLEAN_COLUMNS = {"fallback"}
COST_COLUMNS = ("picker_cost_usd", "model_cost_usd")


def parse_cell(column, raw):
    """Empty cell is null. A value that does not parse stays a string so the schema reports it."""
    value = raw.strip()
    if value == "":
        return None
    try:
        if column in INTEGER_COLUMNS:
            return int(value)
        if column in NUMBER_COLUMNS:
            return float(value)
    except ValueError:
        return value
    if column in BOOLEAN_COLUMNS:
        return {"true": True, "false": False}.get(value.lower(), value)
    return value


def validate(path):
    """Return (errors, gaps, rows). Errors make the file invalid; gaps are missing costs or labels."""
    errors, gaps, rows = [], [], []
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        header = reader.fieldnames or []
        missing = [c for c in COLUMNS if c not in header]
        unknown = [c for c in header if c not in COLUMNS]
        if missing:
            errors.append(f"header: missing columns {missing}")
        if unknown:
            errors.append(f"header: unknown columns {unknown}")
        if errors:
            return errors, gaps, rows
        for line, raw in enumerate(reader, start=2):
            row = {c: parse_cell(c, raw[c] or "") for c in COLUMNS}
            rows.append((line, row))

    if not rows:
        errors.append("file has no data rows")
        return errors, gaps, rows

    validator = Draft202012Validator(SCHEMA)
    seen, inputs = set(), {}
    for line, row in rows:
        for err in validator.iter_errors(row):
            field = ".".join(str(p) for p in err.absolute_path) or "row"
            errors.append(f"line {line}: {field}: {err.message}")
        key = (row["case_id"], row["arm"])
        if key in seen:
            errors.append(f"line {line}: duplicate case_id {row['case_id']} for arm {row['arm']}")
        seen.add(key)
        first = inputs.setdefault(row["case_id"], row["case_input"])
        if first != row["case_input"]:
            errors.append(f"line {line}: case_input differs from the first row for case_id {row['case_id']}")
        for column in COST_COLUMNS:
            if row[column] is None:
                gaps.append(f"line {line}: {column} missing ({row['case_id']}, arm {row['arm']})")
        if row["label"] is None:
            gaps.append(f"line {line}: unlabelled ({row['case_id']}, arm {row['arm']})")
    return errors, gaps, rows


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip())
        return 2
    errors, gaps, rows = validate(argv[1])
    for message in errors:
        print(f"ERROR {message}")
    for message in gaps:
        print(f"GAP {message}")
    cases = len({row["case_id"] for _, row in rows})
    verdict = "INVALID" if errors else "VALID"
    print(f"{verdict} rows={len(rows)} cases={cases} errors={len(errors)} gaps={len(gaps)}")
    if gaps and not errors:
        print("Gaps are allowed in the file; any gap makes the verdict 'not enough evidence' (FLOW.md, verdict rule 1).")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
