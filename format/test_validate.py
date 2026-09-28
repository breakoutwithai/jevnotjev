import csv
from pathlib import Path

import pytest

from validate import COLUMNS, validate

EXAMPLE = Path(__file__).with_name("example-v1.csv")


def read_example():
    with open(EXAMPLE, newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def write(tmp_path, rows, columns=COLUMNS):
    path = tmp_path / "results.csv"
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return path


@pytest.mark.unit
def test_example_is_valid_and_reports_its_two_gaps():
    errors, gaps, rows = validate(EXAMPLE)
    assert errors == []
    assert len(rows) == 12
    assert gaps == [
        "line 8: unlabelled (c03, arm B)",
        "line 13: model_cost_usd missing (c04, arm C)",
    ]


@pytest.mark.unit
def test_unknown_arm_is_an_error(tmp_path):
    rows = read_example()
    rows[0]["arm"] = "D"
    errors, _, _ = validate(write(tmp_path, rows))
    assert any("line 2: arm" in e for e in errors)


@pytest.mark.unit
def test_label_without_source_is_an_error(tmp_path):
    rows = read_example()
    rows[0]["label_source"] = ""
    errors, _, _ = validate(write(tmp_path, rows))
    assert any("line 2: label_source" in e for e in errors)


@pytest.mark.unit
def test_jev_arm_needs_answer_confidence_and_fallback(tmp_path):
    rows = read_example()
    rows[8]["jev_confidence"] = ""
    errors, _, _ = validate(write(tmp_path, rows))
    assert any("line 10: jev_confidence" in e for e in errors)


@pytest.mark.unit
def test_non_jev_arm_must_not_carry_a_jev_answer(tmp_path):
    rows = read_example()
    rows[0]["jev_answer"] = "trivial"
    errors, _, _ = validate(write(tmp_path, rows))
    assert any("line 2: jev_answer" in e for e in errors)


@pytest.mark.unit
def test_confidence_above_one_is_an_error(tmp_path):
    rows = read_example()
    rows[8]["jev_confidence"] = "1.5"
    errors, _, _ = validate(write(tmp_path, rows))
    assert any("line 10: jev_confidence" in e for e in errors)


@pytest.mark.unit
def test_duplicate_case_and_arm_is_an_error(tmp_path):
    rows = read_example()
    rows.append(dict(rows[0]))
    errors, _, _ = validate(write(tmp_path, rows))
    assert any("duplicate case_id c01 for arm A" in e for e in errors)


@pytest.mark.unit
def test_case_input_must_match_across_arms(tmp_path):
    rows = read_example()
    rows[4]["case_input"] = "something else"
    errors, _, _ = validate(write(tmp_path, rows))
    assert any("line 6: case_input differs" in e for e in errors)


@pytest.mark.unit
def test_wrong_format_version_is_an_error(tmp_path):
    rows = read_example()
    rows[0]["format_version"] = "tokenmax-results/2"
    errors, _, _ = validate(write(tmp_path, rows))
    assert any("line 2: format_version" in e for e in errors)


@pytest.mark.unit
def test_missing_column_is_an_error(tmp_path):
    columns = [c for c in COLUMNS if c != "label"]
    errors, _, _ = validate(write(tmp_path, read_example(), columns))
    assert errors == ["header: missing columns ['label']"]


@pytest.mark.unit
def test_empty_file_is_an_error(tmp_path):
    errors, _, _ = validate(write(tmp_path, []))
    assert errors == ["file has no data rows"]


@pytest.mark.unit
def test_non_numeric_cost_is_an_error_not_a_gap(tmp_path):
    rows = read_example()
    rows[0]["model_cost_usd"] = "about a cent"
    errors, gaps, _ = validate(write(tmp_path, rows))
    assert any("line 2: model_cost_usd" in e for e in errors)
    assert not any("line 2" in g for g in gaps)
