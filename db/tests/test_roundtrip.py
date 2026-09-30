"""Load, export and reload: round trip, idempotence, label gap fill, type fidelity."""
import datetime
from decimal import Decimal

import pytest

from export import export_csv
from load import LoadError, load_file
from support import D06, EXAMPLE, count, example_rows, numeric_only_differences, write_csv


@pytest.mark.unit
def test_equivalence_rule_accepts_respelled_numbers_and_nothing_else():
    source = "a,cost_usd\nx,1.8e-06\n"
    assert numeric_only_differences(source, "a,cost_usd\nx,0.0000018\n") == [(2, "cost_usd", "1.8e-06", "0.0000018")]
    with pytest.raises(AssertionError):
        numeric_only_differences(source, "a,cost_usd\ny,1.8e-06\n")
    with pytest.raises(AssertionError):
        numeric_only_differences(source, "a,cost_usd\nx,0.000002\n")
    with pytest.raises(AssertionError):
        numeric_only_differences("a,cost_usd\nx,\n", "a,cost_usd\nx,0\n")


@pytest.mark.integration
def test_d06_export_equals_source_after_crlf_to_lf(conn, make_workspace):
    raw = D06.read_bytes()
    assert raw.count(b"\r\n") == 31
    body = raw.replace(b"\r\n", b"\n")
    assert b"\r" not in body and body.count(b"\n") == 31, "d06 has no line break inside a cell"
    workspace = make_workspace("synthetic")
    result = load_file(conn, workspace, D06)
    assert (result.status, result.answers, result.labels) == ("loaded", 30, 29)
    assert export_csv(conn, workspace, "run-d06").text.encode("utf-8") == body


@pytest.mark.integration
def test_example_export_is_byte_identical_except_exponent_cells(conn, make_workspace):
    workspace = make_workspace("synthetic")
    load_file(conn, workspace, EXAMPLE)
    source = EXAMPLE.read_text(encoding="utf-8")
    exported = export_csv(conn, workspace, "run-001").text
    respelled = numeric_only_differences(source, exported)
    assert respelled == [
        (2, "cost_usd", "1.8e-06", "0.0000018"),
        (3, "cost_usd", "1.6e-06", "0.0000016"),
        (4, "cost_usd", "1.9e-06", "0.0000019"),
    ]
    differing_lines = [a for a, b in zip(source.splitlines(), exported.splitlines()) if a != b]
    assert len(differing_lines) == 3 and all("e-06" in line for line in differing_lines)


@pytest.mark.integration
def test_export_reload_export_is_a_fixed_point(conn, make_workspace, tmp_path):
    first_ws, second_ws = make_workspace("synthetic"), make_workspace("synthetic")
    load_file(conn, first_ws, EXAMPLE)
    first = export_csv(conn, first_ws, "run-001").text
    path = tmp_path / "exported.csv"
    path.write_text(first, encoding="utf-8")
    load_file(conn, second_ws, path)
    assert export_csv(conn, second_ws, "run-001").text == first


@pytest.mark.integration
def test_reloading_the_identical_file_is_a_no_op(conn, make_workspace):
    workspace = make_workspace("synthetic")
    load_file(conn, workspace, D06)
    before = ({t: count(conn, t, workspace) for t in ("import_file", "run", "question", "test_case", "answer", "label")},
              export_csv(conn, workspace, "run-d06").text)
    result = load_file(conn, workspace, D06)
    after = ({t: count(conn, t, workspace) for t in ("import_file", "run", "question", "test_case", "answer", "label")},
             export_csv(conn, workspace, "run-d06").text)
    assert (result.status, result.answers, result.labels) == ("unchanged", 0, 0)
    assert after == before
    assert before[0] == {"import_file": 1, "run": 1, "question": 2, "test_case": 5, "answer": 30, "label": 29}


@pytest.mark.integration
def test_labels_file_fills_a_missing_label_and_cannot_change_one(conn, make_workspace, tmp_path):
    workspace = make_workspace("synthetic")
    load_file(conn, workspace, EXAMPLE)
    header, rows = example_rows()
    label, source = header.index("label"), header.index("label_source")
    assert rows[7][label] == ""
    rows[7][label], rows[7][source] = "reject", "human"
    filled = load_file(conn, workspace, write_csv(tmp_path / "labels.csv", header, rows), purpose="labels")
    assert (filled.status, filled.answers, filled.labels) == ("loaded", 0, 1)
    assert count(conn, "label", workspace) == 9
    exported = export_csv(conn, workspace, "run-001").text.splitlines()
    assert exported[8].endswith(",no,,reject,human,115,3,0.00037,1750")

    rows[0][label] = "reject"
    with pytest.raises(LoadError, match="changing a label is rejected"):
        load_file(conn, workspace, write_csv(tmp_path / "relabel.csv", header, rows), purpose="labels")
    assert count(conn, "label", workspace) == 9


@pytest.mark.integration
def test_labels_file_row_must_match_a_loaded_answer(conn, make_workspace, tmp_path):
    workspace = make_workspace("synthetic")
    load_file(conn, workspace, EXAMPLE)
    header, rows = example_rows()
    rows[7][header.index("output")] = "yes"
    rows[7][header.index("label")], rows[7][header.index("label_source")] = "reject", "human"
    with pytest.raises(LoadError, match="line 9: row does not match a loaded answer"):
        load_file(conn, workspace, write_csv(tmp_path / "labels.csv", header, rows), purpose="labels")
    assert count(conn, "label", workspace) == 8


@pytest.mark.integration
def test_invalid_file_writes_nothing(conn, make_workspace, tmp_path):
    workspace = make_workspace("synthetic")
    header, rows = example_rows()
    rows[-1][header.index("confidence")] = "1.5"
    with pytest.raises(LoadError, match="line 10: confidence"):
        load_file(conn, workspace, write_csv(tmp_path / "bad.csv", header, rows))
    assert count(conn, "import_file", workspace) == 0 and count(conn, "answer", workspace) == 0


@pytest.mark.integration
def test_database_error_rolls_back_the_whole_file(conn, make_workspace, tmp_path):
    workspace = make_workspace("synthetic")
    load_file(conn, workspace, EXAMPLE)
    header, rows = example_rows()
    for row in rows:
        row[header.index("run_id")] = "run-002"
        row[header.index("prompt_version")] = "refund-q.v2"
    # only the last row reuses the loaded prompt_version, with new wording: the DB catches it
    rows[-1][header.index("prompt_version")] = "refund-q.v1"
    rows[-1][header.index("question")] = "Is this a refund request?"
    with pytest.raises(LoadError, match="question q1 under prompt_version refund-q.v1"):
        load_file(conn, workspace, write_csv(tmp_path / "reworded.csv", header, rows))
    assert {t: count(conn, t, workspace) for t in ("import_file", "run", "answer")} == \
        {"import_file": 1, "run": 1, "answer": 9}


@pytest.mark.integration
def test_type_fidelity(conn, make_workspace):
    workspace = make_workspace("synthetic")
    load_file(conn, workspace, EXAMPLE)
    rows = conn.execute(
        "select v.confidence, v.cost_usd, v.tokens_in, v.latency_ms, v.label, v.labelled_at, f.loaded_at"
        " from jnj.record_v1 v join jnj.import_file f on f.id = v.import_file_pk"
        " join jnj.workspace w on w.id = v.workspace_id where w.slug = %s order by v.source_line",
        (workspace,),
    ).fetchall()
    confidence, cost, tokens_in, latency, label, labelled_at, loaded_at = rows[0]
    assert (confidence, cost, tokens_in, latency) == (Decimal("0.96"), Decimal("0.0000018"), 42, 380)
    assert type(confidence) is Decimal and type(cost) is Decimal and type(tokens_in) is int
    assert labelled_at.tzinfo is not None and loaded_at.tzinfo is not None
    assert isinstance(loaded_at, datetime.datetime)
    assert rows[3][0] is None, "a rule gives no confidence: NULL, not 0"
    assert rows[7][4] is None and rows[7][5] is None, "unlabelled answer has no label row"
    assert rows[8][1] is None, "missing cost is a gap: NULL, never 0"
    assert rows[3][1] == Decimal("0"), "a rule's cost of 0 stays 0"
