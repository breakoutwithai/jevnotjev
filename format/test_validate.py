import csv
from pathlib import Path

import pytest

from validate import COLUMNS, summary, validate

EXAMPLE = Path(__file__).with_name("example-v1.csv")


def read_example():
    with open(EXAMPLE, newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def write(tmp_path, rows, columns=COLUMNS):
    path = tmp_path / "record.csv"
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return path


def errors_for(tmp_path, rows):
    return validate(write(tmp_path, rows))[0]


@pytest.mark.smoke
def test_example_is_valid_with_its_two_gaps():
    errors, gaps, rows = validate(EXAMPLE)
    assert errors == []
    assert len(rows) == 9
    assert gaps == ["line 9: unlabelled (m02, q1, llm)", "line 10: cost_usd missing (m03, q1, llm)"]


@pytest.mark.unit
def test_summary_counts_labelled_rows_only_and_marks_cost_incomplete():
    _, _, rows = validate(EXAMPLE)
    assert summary(rows) == [
        "jev: rows=3 labelled=3 accepted=3 cost=$0.000005",
        "llm: rows=3 labelled=2 accepted=2 cost=incomplete",
        "rule: rows=3 labelled=3 accepted=2 cost=$0.000000",
    ]


@pytest.mark.unit
def test_output_outside_answer_set_is_an_error(tmp_path):
    rows = read_example()
    rows[0]["output"] = "maybe"
    assert any("line 2: output 'maybe' is not in answer_set" in e for e in errors_for(tmp_path, rows))


@pytest.mark.unit
def test_unknown_answerer_is_an_error(tmp_path):
    rows = read_example()
    rows[0]["answerer"] = "robot"
    assert any("line 2: answerer" in e for e in errors_for(tmp_path, rows))


@pytest.mark.unit
def test_label_without_source_is_an_error(tmp_path):
    rows = read_example()
    rows[0]["label_source"] = ""
    assert any("line 2: label_source" in e for e in errors_for(tmp_path, rows))


@pytest.mark.unit
def test_confidence_above_one_is_an_error(tmp_path):
    rows = read_example()
    rows[0]["confidence"] = "1.5"
    assert any("line 2: confidence" in e for e in errors_for(tmp_path, rows))


@pytest.mark.unit
def test_malformed_cost_is_an_error_not_a_gap(tmp_path):
    rows = read_example()
    rows[0]["cost_usd"] = "about a cent"
    errors, gaps, _ = validate(write(tmp_path, rows))
    assert any("line 2: cost_usd" in e for e in errors)
    assert not any("line 2" in g for g in gaps)


@pytest.mark.unit
def test_question_reworded_under_the_same_prompt_version_is_an_error(tmp_path):
    rows = read_example()
    rows[3]["question"] = "Does this message want money back?"
    assert any("line 5: question q1 changed within prompt_version" in e for e in errors_for(tmp_path, rows))


@pytest.mark.unit
def test_reworded_question_with_a_new_prompt_version_is_valid(tmp_path):
    rows = read_example()
    rows[3]["question"] = "Does this message want money back?"
    rows[3]["prompt_version"] = "refund-q.v2"
    assert errors_for(tmp_path, rows) == []


@pytest.mark.unit
def test_duplicate_row_is_an_error(tmp_path):
    rows = read_example()
    rows.append(dict(rows[0]))
    assert any("duplicate row for run run-001 (m01, q1, jev)" in e for e in errors_for(tmp_path, rows))


@pytest.mark.unit
def test_case_input_must_match_across_rows(tmp_path):
    rows = read_example()
    rows[3]["case_input"] = "something else"
    assert any("line 5: case_input differs" in e for e in errors_for(tmp_path, rows))


@pytest.mark.unit
def test_wrong_format_version_is_an_error(tmp_path):
    rows = read_example()
    rows[0]["format_version"] = "jnj-record/2"
    assert any("line 2: format_version" in e for e in errors_for(tmp_path, rows))


@pytest.mark.unit
def test_missing_column_is_an_error(tmp_path):
    columns = [c for c in COLUMNS if c != "label"]
    assert validate(write(tmp_path, read_example(), columns))[0] == ["header: missing columns ['label']"]


@pytest.mark.unit
def test_empty_file_is_an_error(tmp_path):
    assert validate(write(tmp_path, []))[0] == ["file has no data rows"]
