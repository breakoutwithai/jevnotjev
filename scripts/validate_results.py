#!/usr/bin/env python3
"""Validate a TokenMax cases file and results file against format v0.1.

Usage: validate_results.py <cases.csv> <results.csv>

Each CSV row is typed by its JSON Schema (an empty cell is null), then validated.
Errors (exit 1): a row the schema rejects, an unknown case, a duplicate row, a missing column.
Warnings (exit 0): a missing cost or an unlabelled output. Both make the verdict
"not enough evidence", so they are reported rather than rejected.
"""
from __future__ import annotations

import csv
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from jsonschema import Draft202012Validator

FORMAT_DIR = Path(__file__).resolve().parent.parent / "format" / "v0.1"
COST_FIELDS = ("picker_cost_usd", "model_cost_usd")
MIN_LABELLED_CASES = 10


@dataclass
class Report:
    cases: int = 0
    rows: int = 0
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    spend: dict = field(default_factory=dict)
    not_enough_evidence: list = field(default_factory=list)


def _schema(name: str) -> dict:
    return json.loads((FORMAT_DIR / name).read_text())


def _types(prop: dict) -> list:
    t = prop.get("type", [])
    return t if isinstance(t, list) else [t]


def _coerce(cell: str, prop: dict):
    """CSV cell -> typed value, driven by the schema. Raises ValueError with the expected type."""
    if cell == "":
        return None
    types = _types(prop)
    if "integer" in types:
        try:
            return int(cell)
        except ValueError:
            raise ValueError("not an integer") from None
    if "number" in types:
        try:
            return float(cell)
        except ValueError:
            raise ValueError("not a number") from None
    if "boolean" in types:
        if cell in ("true", "false"):
            return cell == "true"
        raise ValueError("not true or false")
    return cell


def _read(path: Path, schema: dict, report: Report, label) -> list:
    props = schema["properties"]
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in props if c not in (reader.fieldnames or [])]
        if missing:
            report.errors.append(f"{path.name}: missing columns: {', '.join(missing)}")
            return []
        rows = []
        validator = Draft202012Validator(schema)
        for n, raw in enumerate(reader, start=2):
            rid = label(raw, n)
            row, ok = {}, True
            for key, cell in raw.items():
                try:
                    row[key] = _coerce(cell, props.get(key, {}))
                except ValueError as e:
                    report.errors.append(f"{rid}: {key}: {e}")
                    ok = False
            for err in validator.iter_errors(row):
                where = ".".join(str(p) for p in err.path) or "row"
                report.errors.append(f"{rid}: {where}: {err.message}")
                ok = False
            if ok:
                rows.append(row)
    return rows


def validate(cases_path, results_path) -> Report:
    r = Report()
    cases = _read(Path(cases_path), _schema("cases.schema.json"), r,
                  lambda raw, n: f"cases line {n} ({raw.get('case_id')})")
    case_ids = [c["case_id"] for c in cases]
    for cid in {c for c in case_ids if case_ids.count(c) > 1}:
        r.errors.append(f"duplicate case {cid}")
    r.cases = len(set(case_ids))

    errors_before = len(r.errors)
    rows = _read(Path(results_path), _schema("results.schema.json"), r,
                 lambda raw, n: f"{raw.get('run_id')}/{raw.get('case_id')}/{raw.get('arm')}")
    r.rows = len(rows)
    if r.rows == 0 and len(r.errors) == errors_before:
        r.errors.append("no result rows")

    seen, labelled = set(), {}
    for row in rows:
        rid = f"{row['run_id']}/{row['case_id']}/{row['arm']}"
        if rid in seen:
            r.errors.append(f"duplicate row {rid}")
        seen.add(rid)
        if row["case_id"] not in case_ids:
            r.errors.append(f"{rid}: case_id {row['case_id']} is not in cases")
        missing_cost = [f for f in COST_FIELDS if row.get(f) is None]
        for f in missing_cost:
            r.warnings.append(f"{rid}: cost missing ({f})")
        if row.get("output") is not None and row.get("label") is None:
            r.warnings.append(f"{rid}: unlabelled")
        key = (row["run_id"], row["arm"])
        total, complete = r.spend.get(key, (0.0, True))
        total += sum(row.get(f) or 0.0 for f in COST_FIELDS)
        r.spend[key] = (total, complete and not missing_cost)
        labelled.setdefault(row["case_id"], True)
        labelled[row["case_id"]] &= row.get("label") is not None

    if not any(row["arm"] == "jev" for row in rows):
        r.not_enough_evidence.append("no Jev rows")
    if sum(labelled.values()) < MIN_LABELLED_CASES:
        r.not_enough_evidence.append(f"fewer than {MIN_LABELLED_CASES} labelled cases")
    if any(w.endswith("unlabelled") for w in r.warnings):
        r.not_enough_evidence.append("a picked output is unlabelled")
    if any("cost missing" in w for w in r.warnings):
        r.not_enough_evidence.append("a cost is missing")
    return r


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    r = validate(*argv)
    for e in r.errors:
        print(f"ERROR {e}")
    for w in r.warnings:
        print(f"WARN  {w}")
    for (run, arm), (total, complete) in sorted(r.spend.items()):
        print(f"SPEND {run} {arm} ${total:.8f}" + ("" if complete else " (incomplete: a cost is missing)"))
    if r.not_enough_evidence:
        print("READY not enough evidence: " + "; ".join(r.not_enough_evidence))
    else:
        print("READY enough evidence for a verdict")
    status = "FAIL" if r.errors else "OK"
    print(f"VERDICT format {status} cases={r.cases} rows={r.rows} errors={len(r.errors)} warnings={len(r.warnings)}")
    return 1 if r.errors else 0


if __name__ == "__main__":
    sys.exit(main())
