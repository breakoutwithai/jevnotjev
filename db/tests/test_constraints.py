"""The DB refuses bad values on its own, and accepts every value validate.py accepts (review O1)."""
import csv
import io
from decimal import Decimal

import psycopg
import pytest

from export import export_csv
from load import LoadError, load_file
from migrate import migrate
from support import EXAMPLE, ROOT, count, example_rows, write_csv
from validate import validate


def first_answer(conn, workspace):
    return conn.execute(
        "select a.id, a.workspace_id, a.import_file_pk, a.run_pk, a.case_pk, a.question_pk, a.question_id"
        " from jnj.answer a join jnj.workspace w on w.id = a.workspace_id where w.slug = %s order by a.id limit 1",
        (workspace,),
    ).fetchone()


INSERT_ANSWER = ("insert into jnj.answer (workspace_id, import_file_pk, run_pk, case_pk, question_pk, question_id,"
                 " answerer_kind, answerer_model, output, confidence, cost_usd, source_line)"
                 " values (%s,%s,%s,%s,%s,%s,'human','cw',%s,%s,%s,99)")


@pytest.mark.integration
@pytest.mark.parametrize("output,confidence,cost,error", [
    ("maybe", None, None, psycopg.errors.ForeignKeyViolation),
    ("no", Decimal("1.5"), None, psycopg.errors.CheckViolation),
    ("no", None, Decimal("-1"), psycopg.errors.CheckViolation),
])
def test_db_rejects_bad_answer_values(conn, make_workspace, output, confidence, cost, error):
    workspace = make_workspace()
    load_file(conn, workspace, EXAMPLE)
    _, ws, file_pk, run_pk, case_pk, question_pk, qid = first_answer(conn, workspace)
    with pytest.raises(error):
        conn.execute(INSERT_ANSWER, (ws, file_pk, run_pk, case_pk, question_pk, qid, output, confidence, cost))


@pytest.mark.integration
def test_db_rejects_label_maybe_and_any_update(conn, make_workspace):
    workspace = make_workspace()
    load_file(conn, workspace, EXAMPLE)
    answer_pk, ws, file_pk, *_ = first_answer(conn, workspace)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("insert into jnj.label (answer_pk, workspace_id, import_file_pk, verdict, source)"
                     " values (%s, %s, %s, 'maybe', 'human')", (answer_pk, ws, file_pk))
    for table, column in [("label", "verdict"), ("answer", "output"), ("question", "question"),
                          ("test_case", "case_id"), ("run", "run_id"), ("import_file", "original_name"),
                          ("answer_option", "value")]:
        with pytest.raises(psycopg.errors.RaiseException, match=f"UPDATE forbidden on jnj.{table}"):
            conn.execute(f"update jnj.{table} set {column} = {column} where workspace_id = %s", (ws,))


@pytest.mark.integration
def test_db_rejects_a_single_option_question(conn, make_workspace):
    workspace = make_workspace()
    ws = conn.execute("select id from jnj.workspace where slug = %s", (workspace,)).fetchone()[0]
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("insert into jnj.question (workspace_id, content_policy, prompt_version, question_id,"
                     " question_sha256, question_length, answer_set)"
                     " select id, content_policy, 'v1', 'q1', repeat('0', 64), 2, 'yes' from jnj.workspace"
                     " where id = %s", (ws,))


def with_cell(tmp_path, column, value, row=0):
    header, rows = example_rows()
    rows[row][header.index(column)] = value
    return write_csv(tmp_path / "cell.csv", header, rows)


@pytest.mark.integration
@pytest.mark.parametrize("column,value,expected", [
    ("confidence", "1e-400", Decimal("1e-400")),
    ("tokens_in", "3000000000", 3000000000),
    ("tokens_in", "9223372036854775807", 9223372036854775807),
    ("cost_usd", "1e-400", Decimal("1e-400")),
    ("cost_usd", "00042", Decimal("42")),
])
def test_db_accepts_what_the_validator_accepts(conn, make_workspace, tmp_path, column, value, expected):
    path = with_cell(tmp_path, column, value)
    assert validate(path)[0] == []
    workspace = make_workspace()
    load_file(conn, workspace, path)
    stored = conn.execute(
        f"select v.{column} from jnj.record_v1 v join jnj.workspace w on w.id = v.workspace_id"
        " where w.slug = %s order by v.source_line limit 1", (workspace,)).fetchone()[0]
    assert stored == expected and type(stored) is type(expected)
    exported = list(csv.reader(io.StringIO(export_csv(conn, workspace, "run-001").text)))
    assert Decimal(exported[1][exported[0].index(column)]) == Decimal(value)


@pytest.mark.integration
@pytest.mark.parametrize("column,value,message", [
    ("tokens_in", "9223372036854775808", "line 2: tokens_in: 9223372036854775808 is above 9223372036854775807"),
    ("latency_ms", "1" + "0" * 30, "line 2: latency_ms: 1000000000000000000000000000000 is above"),
    ("cost_usd", "1e-16384", "line 2: cost_usd: 1e-16384 has more than 16383 digits after the decimal point"),
    ("confidence", "0e-99999", "line 2: confidence: 0e-99999 has more than 16383 digits after the decimal point"),
    ("run_id", "run-001\n", "line 3: run_id: 'run-001\\n' ends with a line break"),
])
def test_loader_rejects_before_writing_what_the_db_cannot_store(conn, make_workspace, tmp_path, column, value, message):
    header, rows = example_rows()
    for row in rows if column == "run_id" else rows[:1]:
        row[header.index(column)] = value
    path = write_csv(tmp_path / "cell.csv", header, rows)
    assert validate(path)[0] == [], "validate.py accepts the value"
    workspace = make_workspace()
    with pytest.raises(LoadError) as caught:
        load_file(conn, workspace, path)
    assert any(m.startswith(message) for m in caught.value.messages), caught.value.messages
    assert count(conn, "import_file", workspace) == 0


@pytest.mark.integration
def test_migrate_is_idempotent_and_refuses_a_changed_applied_file(conn, tmp_path):
    assert migrate(conn) == []
    for source in sorted((ROOT / "db" / "migrations").glob("*.sql")):
        (tmp_path / source.name).write_text(source.read_text(encoding="utf-8") + "\n-- edited\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="0001_records.sql changed after it was applied"):
        migrate(conn, tmp_path)
