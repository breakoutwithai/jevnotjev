"""Tests for scripts/validate_results.py against format v0.1. All data is fictional."""
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "format" / "v0.1" / "example"
sys.path.insert(0, str(ROOT / "scripts"))

import validate_results as vr  # noqa: E402

HEADER = (EXAMPLE / "results.csv").read_text().splitlines()[0]
JEV_ROW = ("tokenmax-results/0.1,r1,c01,jev,jev-1.13.0,118,0.00000496,model-small,ok,310,38,0.0005,"
           "no,0.93,false,accept,human,2026-09-27")


def _results(tmp_path, *rows, header=HEADER):
    p = tmp_path / "results.csv"
    p.write_text("\n".join([header, *rows]) + "\n")
    return p


@pytest.mark.smoke
def test_example_validates_via_cli():
    res = subprocess.run([sys.executable, str(ROOT / "scripts" / "validate_results.py"),
                          str(EXAMPLE / "cases.csv"), str(EXAMPLE / "results.csv")],
                         capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "VERDICT format OK cases=3 rows=9 errors=0 warnings=2" in res.stdout


@pytest.mark.unit
def test_example_missing_cost_and_label_are_warnings_not_errors():
    r = vr.validate(EXAMPLE / "cases.csv", EXAMPLE / "results.csv")
    assert r.errors == []
    assert sorted(r.warnings) == [
        "r1/c02/now: cost missing (model_cost_usd)",
        "r1/c03/rule: unlabelled",
    ]
    assert r.spend[("r1", "rule")] == (pytest.approx(0.00116), True)
    assert r.spend[("r1", "now")][1] is False
    assert "fewer than 10 labelled cases" in r.not_enough_evidence
    assert "a picked output is unlabelled" in r.not_enough_evidence
    assert "a cost is missing" in r.not_enough_evidence


@pytest.mark.unit
@pytest.mark.parametrize("row, expect", [
    (JEV_ROW.replace(",jev,", ",llm,"), "arm"),
    (JEV_ROW.replace(",jev,jev-1.13.0,", ",now,always model-large,"), "jev_answer"),
    (JEV_ROW.replace(",c01,", ",c99,"), "case_id c99 is not in cases"),
    (JEV_ROW.replace("tokenmax-results/0.1", "tokenmax-results/0.2"), "format"),
    (JEV_ROW.replace(",0.93,", ",1.5,"), "jev_confidence"),
    (JEV_ROW.replace(",0.0005,", ",-1,"), "model_cost_usd"),
    (JEV_ROW.replace(",310,", ",lots,"), "model_tokens_in: not an integer"),
    (JEV_ROW.replace(",accept,human,", ",accept,,"), "label_source"),
])
def test_bad_rows_are_errors(tmp_path, row, expect):
    r = vr.validate(EXAMPLE / "cases.csv", _results(tmp_path, row))
    assert any(expect in e for e in r.errors), r.errors


@pytest.mark.unit
def test_duplicate_row_and_missing_column(tmp_path):
    r = vr.validate(EXAMPLE / "cases.csv", _results(tmp_path, JEV_ROW, JEV_ROW))
    assert any("duplicate row r1/c01/jev" in e for e in r.errors)
    r = vr.validate(EXAMPLE / "cases.csv", _results(tmp_path, JEV_ROW, header=HEADER.replace(",label_source", "")))
    assert any("missing columns: label_source" in e for e in r.errors)


@pytest.mark.unit
def test_empty_results_is_an_error(tmp_path):
    r = vr.validate(EXAMPLE / "cases.csv", _results(tmp_path))
    assert "no result rows" in r.errors
