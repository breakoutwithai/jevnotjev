"""Validate a Jev!Jev eval record CSV against format jnj-record/1.

Usage: python3 format/validate.py <record.csv>
Exit 0 when the file is valid (gaps are reported, not errors); exit 1 on any error.
Needs: pip install -r requirements.txt
"""
import csv
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

SCHEMA = json.loads(Path(__file__).with_name("record-v1.schema.json").read_text())
COLUMNS = SCHEMA["required"]
INTEGER_COLUMNS = {"tokens_in", "tokens_out", "latency_ms"}
NUMBER_COLUMNS = {"confidence", "cost_usd"}


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
    return value


def read_rows(path):
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        header = reader.fieldnames or []
        errors = []
        missing = [c for c in COLUMNS if c not in header]
        unknown = [c for c in header if c not in COLUMNS]
        if missing:
            errors.append(f"header: missing columns {missing}")
        if unknown:
            errors.append(f"header: unknown columns {unknown}")
        if errors:
            return errors, []
        rows = [(line, {c: parse_cell(c, raw[c] or "") for c in COLUMNS}) for line, raw in enumerate(reader, start=2)]
    return [], rows


def validate(path):
    """Return (errors, gaps, rows). Errors make the file invalid; gaps are missing costs or labels."""
    errors, rows = read_rows(path)
    gaps = []
    if errors:
        return errors, gaps, rows
    if not rows:
        return ["file has no data rows"], gaps, rows

    validator = Draft202012Validator(SCHEMA)
    seen, inputs, questions = set(), {}, {}
    for line, row in rows:
        row_errors = [f"line {line}: {'.'.join(str(p) for p in e.absolute_path) or 'row'}: {e.message}"
                      for e in validator.iter_errors(row)]
        errors.extend(row_errors)
        if row_errors:
            continue
        where = f"({row['case_id']}, {row['question_id']}, {row['answerer']})"
        if row["output"] not in row["answer_set"].split("|"):
            errors.append(f"line {line}: output {row['output']!r} is not in answer_set {row['answer_set']!r}")
        key = (row["run_id"], row["case_id"], row["question_id"], row["answerer"])
        if key in seen:
            errors.append(f"line {line}: duplicate row for run {row['run_id']} {where}")
        seen.add(key)
        if inputs.setdefault(row["case_id"], row["case_input"]) != row["case_input"]:
            errors.append(f"line {line}: case_input differs from the first row for case_id {row['case_id']}")
        asked = (row["question"], row["answer_set"])
        if questions.setdefault((row["prompt_version"], row["question_id"]), asked) != asked:
            errors.append(f"line {line}: question {row['question_id']} changed within prompt_version "
                          f"{row['prompt_version']}; give the new wording a new prompt_version")
        if row["cost_usd"] is None:
            gaps.append(f"line {line}: cost_usd missing {where}")
        if row["label"] is None:
            gaps.append(f"line {line}: unlabelled {where}")
    return errors, gaps, rows


def summary(rows):
    """Per answerer: labelled, accepted, cost. Accuracy counts labelled rows only; cost with a gap is incomplete."""
    lines = []
    for answerer in sorted({row["answerer"] for _, row in rows}):
        mine = [row for _, row in rows if row["answerer"] == answerer]
        labelled = [row for row in mine if row["label"] is not None]
        accepted = sum(1 for row in labelled if row["label"] == "accept")
        costs = [row["cost_usd"] for row in mine]
        cost = "incomplete" if None in costs else f"${sum(costs):.6f}"
        lines.append(f"{answerer}: rows={len(mine)} labelled={len(labelled)} accepted={accepted} cost={cost}")
    return lines


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip())
        return 2
    errors, gaps, rows = validate(argv[1])
    for message in errors:
        print(f"ERROR {message}")
    for message in gaps:
        print(f"GAP {message}")
    if not errors:
        for line in summary(rows):
            print(line)
    cases = len({row["case_id"] for _, row in rows})
    print(f"{'INVALID' if errors else 'VALID'} rows={len(rows)} cases={cases} errors={len(errors)} gaps={len(gaps)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
