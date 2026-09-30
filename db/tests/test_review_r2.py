"""Findings of PR 15 review r1 (pr15-r1): N1, N2 and the optional fixes O1, O2, O4, O6, O7, O9."""
import hashlib
import shutil
import subprocess
import threading
import time
from decimal import Decimal

import psycopg
import pytest

import export
from export import export_csv
from load import LoadError, ensure_workspace, load_file
from migrate import MIGRATIONS, migrate
from support import EXAMPLE, ROOT, example_rows, write_csv
from validate import validate

SECRET_QUESTION = "Q-SECRET: is this person asking for money back?"
SECRET_CASE = "CASE-SECRET kettle arrived broken"
SECRET_NAME = "name-secret-upload.csv"


def secret_rows():
    header, rows = example_rows()
    for row in rows:
        row[header.index("question")] = SECRET_QUESTION
        row[header.index("case_input")] = SECRET_CASE + " " + row[header.index("case_id")]
    return header, rows


def assert_no_secret(error):
    text = str(error) + "\n".join(getattr(error, "messages", []))
    for secret in (SECRET_QUESTION, SECRET_CASE, SECRET_NAME, "Q-SECRET", "CASE-SECRET", "name-secret"):
        assert secret not in text, f"error echoes {secret!r}: {text}"


# N1: every export is one run and validates

@pytest.mark.integration
def test_n1_each_run_export_validates_when_runs_share_a_case_id(conn, make_workspace, tmp_path):
    workspace = make_workspace("synthetic")
    load_file(conn, workspace, EXAMPLE)
    header, rows = example_rows()
    for row in rows:
        row[header.index("run_id")] = "run-009"
        if row[header.index("case_id")] == "m01":
            row[header.index("case_input")] = "A different message with the same case_id."
    load_file(conn, workspace, write_csv(tmp_path / "run-009.csv", header, rows))
    for run_id in ("run-001", "run-009"):
        path = tmp_path / f"export-{run_id}.csv"
        path.write_text(export_csv(conn, workspace, run_id).text, encoding="utf-8")
        errors, _gaps, exported = validate(path)
        assert errors == [] and len(exported) == 9


@pytest.mark.unit
def test_n1_export_requires_a_run():
    with pytest.raises(TypeError):
        export_csv(None, "ws")
    with pytest.raises(SystemExit) as caught:
        export.main(["some-workspace"])
    assert caught.value.code == 2


# N2: restricted workspaces keep question text and file name only as sha256 + length

@pytest.mark.integration
def test_n2_restricted_workspace_stores_question_and_file_name_as_hash_only(conn, make_workspace, tmp_path):
    workspace = make_workspace("restricted")
    header, rows = secret_rows()
    load_file(conn, workspace, write_csv(tmp_path / SECRET_NAME, header, rows))
    question = conn.execute(
        "select q.question, q.question_sha256, q.question_length from jnj.question q"
        " join jnj.workspace w on w.id = q.workspace_id where w.slug = %s", (workspace,)).fetchall()
    assert question == [(None, hashlib.sha256(SECRET_QUESTION.encode()).hexdigest(), len(SECRET_QUESTION))]
    name = conn.execute(
        "select f.original_name, f.original_name_sha256, f.original_name_length from jnj.import_file f"
        " join jnj.workspace w on w.id = f.workspace_id where w.slug = %s", (workspace,)).fetchall()
    assert name == [(None, hashlib.sha256(SECRET_NAME.encode()).hexdigest(), len(SECRET_NAME))]
    dump = "\n".join(str(r) for r in conn.execute(
        "select v.* from jnj.record_v1 v join jnj.workspace w on w.id = v.workspace_id where w.slug = %s",
        (workspace,)).fetchall())
    assert "SECRET" not in dump


@pytest.mark.integration
def test_n2_db_rejects_question_text_and_file_name_in_a_restricted_workspace(conn, make_workspace):
    workspace = make_workspace("restricted")
    ws = conn.execute("select id from jnj.workspace where slug = %s", (workspace,)).fetchone()[0]
    digest = hashlib.sha256(SECRET_QUESTION.encode()).hexdigest()
    with pytest.raises(psycopg.errors.CheckViolation, match="question_only_when_synthetic"):
        conn.execute("insert into jnj.question (workspace_id, content_policy, prompt_version, question_id,"
                     " question_sha256, question_length, question, answer_set)"
                     " values (%s, 'restricted', 'v1', 'q1', %s, %s, %s, 'yes|no')",
                     (ws, digest, len(SECRET_QUESTION), SECRET_QUESTION))
    digest = hashlib.sha256(SECRET_NAME.encode()).hexdigest()
    with pytest.raises(psycopg.errors.CheckViolation, match="original_name_only_when_synthetic"):
        conn.execute("insert into jnj.import_file (workspace_id, content_policy, purpose, file_sha256,"
                     " original_name_sha256, original_name_length, original_name)"
                     " values (%s, 'restricted', 'records', %s, %s, %s, %s)",
                     (ws, "0" * 64, digest, len(SECRET_NAME), SECRET_NAME))


def reworded(header, rows):
    for row in rows:
        row[header.index("run_id")] = "run-002"
        row[header.index("question")] = SECRET_QUESTION + " (reworded)"
    return header, rows


def other_file_same_run(header, rows):
    for row in rows:
        row[header.index("prompt_version")] = "refund-q.v2"
    return header, rows


def label_on_changed_row(header, rows):
    rows[7][header.index("output")] = "yes"
    rows[7][header.index("label")], rows[7][header.index("label_source")] = "reject", "human"
    return header, rows


def relabel(header, rows):
    rows[0][header.index("label")] = "reject"
    return header, rows


def overlong_case(header, rows):
    for row in rows:
        if row[header.index("case_id")] == "m02":
            row[header.index("case_input")] = SECRET_CASE + " x" * 5000
    return header, rows


def empty_question(header, rows):
    for row in rows:
        row[header.index("question")] = ""
    return header, rows


@pytest.mark.integration
@pytest.mark.parametrize("change,purpose", [
    (reworded, "records"),
    (other_file_same_run, "records"),
    (label_on_changed_row, "labels"),
    (relabel, "labels"),
    (overlong_case, "records"),
    (empty_question, "records"),
    (None, "labels"),
])
def test_n2_o7_load_errors_never_echo_question_case_text_or_file_name(conn, make_workspace, tmp_path,
                                                                      change, purpose):
    workspace = make_workspace("restricted")
    first = write_csv(tmp_path / SECRET_NAME, *secret_rows())
    load_file(conn, workspace, first)
    path = first if change is None else write_csv(tmp_path / ("2-" + SECRET_NAME), *change(*secret_rows()))
    with pytest.raises(LoadError) as caught:
        load_file(conn, workspace, path, purpose=purpose)
    assert caught.value.messages
    assert_no_secret(caught.value)


# O6: confidence above 1 is rejected by the loader and the DB

@pytest.mark.integration
def test_o6_confidence_above_one_is_rejected_by_loader_and_db(conn, make_workspace, tmp_path):
    header, rows = example_rows()
    rows[0][header.index("confidence")] = "1.00000000000000000001"
    path = write_csv(tmp_path / "conf.csv", header, rows)
    assert validate(path)[0] == [], "validate.py reads it as the float 1.0"
    workspace = make_workspace()
    with pytest.raises(LoadError, match="line 2: confidence: 1.00000000000000000001 is above 1"):
        load_file(conn, workspace, path)
    load_file(conn, workspace, EXAMPLE)
    answer = conn.execute(
        "select a.id from jnj.answer a join jnj.workspace w on w.id = a.workspace_id where w.slug = %s limit 1",
        (workspace,)).fetchone()[0]
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("insert into jnj.answer (workspace_id, import_file_pk, run_pk, case_pk, question_pk,"
                     " question_id, answerer_kind, answerer_model, output, confidence, source_line)"
                     " select workspace_id, import_file_pk, run_pk, case_pk, question_pk, question_id, 'human',"
                     " 'cw', output, %s, 99 from jnj.answer where id = %s",
                     (Decimal("1.00000000000000000001"), answer))


# O2: the migration refuses to adopt a jnj_loader that is more than a NOLOGIN group

@pytest.mark.integration
@pytest.mark.parametrize("attribute", ["login", "superuser", "createrole"])
def test_o2_migration_refuses_a_jnj_loader_with_extra_powers(conn, attribute):
    sql = (MIGRATIONS / "0002_loader_role.sql").read_text(encoding="utf-8")
    # force_rollback: the role is cluster-wide, so the ALTER must never commit, even if the migration passes
    with pytest.raises(psycopg.errors.RaiseException, match="jnj_loader"):
        with conn.transaction(force_rollback=True):
            conn.execute(f"alter role jnj_loader {attribute}")
            conn.execute(sql)
    assert conn.execute("select rolcanlogin or rolsuper or rolcreaterole from pg_roles"
                        " where rolname = 'jnj_loader'").fetchone() == (False,)


# O4: functions added later are not executable by PUBLIC

@pytest.mark.integration
def test_o4_a_function_added_later_is_not_executable_by_public(conn):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with conn.transaction():
            conn.execute("create function jnj.added_later() returns integer language sql as 'select 1'")
            conn.execute("set local role jnj_loader")
            conn.execute("select jnj.added_later()")


# O1: migrate.py enforces number order and notices a missing applied file

@pytest.mark.integration
def test_o1_migrate_refuses_an_unapplied_file_numbered_below_the_latest(conn, tmp_path):
    for source in MIGRATIONS.glob("*.sql"):
        shutil.copy(source, tmp_path / source.name)
    (tmp_path / "0000_backfill.sql").write_text("select 1;\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="0000_backfill.sql is numbered below applied migration 0002"):
        migrate(conn, tmp_path)


@pytest.mark.integration
def test_o1_migrate_refuses_when_an_applied_file_is_missing(conn, tmp_path):
    shutil.copy(MIGRATIONS / "0001_records.sql", tmp_path / "0001_records.sql")
    with pytest.raises(RuntimeError, match="0002_loader_role.sql was applied but is missing"):
        migrate(conn, tmp_path)


@pytest.mark.unit
def test_o1_sql_files_are_checked_out_with_lf():
    out = subprocess.run(["git", "-C", str(ROOT), "check-attr", "text", "eol", "--", "db/migrations/0001_records.sql"],
                         capture_output=True, text=True, check=True).stdout
    assert "text: set" in out and "eol: lf" in out


# O9: two first loads racing to create the same workspace both succeed

@pytest.mark.integration
def test_o9_concurrent_ensure_workspace_does_not_collide(database):
    slug = f"ws-race-{time.time_ns() % 10**9}"
    errors = []
    with psycopg.connect(database) as first, psycopg.connect(database, autocommit=True) as second:
        ensure_workspace(first, slug)  # uncommitted: the second insert must wait on it

        def run():
            try:
                with second.transaction():
                    ensure_workspace(second, slug)
            except Exception as error:  # noqa: BLE001 - the test reports whatever the thread hit
                errors.append(error)

        thread = threading.Thread(target=run)
        thread.start()
        with psycopg.connect(database, autocommit=True) as watcher:
            for _ in range(200):
                waiting = watcher.execute("select count(*) from pg_stat_activity where pid = %s"
                                          " and wait_event_type = 'Lock'", (second.info.backend_pid,)).fetchone()[0]
                if waiting:
                    break
                time.sleep(0.01)
        assert waiting, "the second insert never waited on the first"
        first.commit()
        thread.join(5)
    assert errors == []
