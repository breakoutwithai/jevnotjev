"""Findings of PR 15 review r2 (pr15-r2): R1, P2, P3, P4."""
import psycopg
import pytest

import export
from load import load_file
from migrate import MIGRATIONS
from support import example_rows, write_csv

SECRET_NAME = "name-secret-upload.csv"


# R1: no function in schema jnj is executable by PUBLIC, and nothing outside jnj changes

@pytest.mark.integration
def test_r1_no_function_in_schema_jnj_is_executable_by_public(conn):
    functions = conn.execute("select count(*) from pg_proc where pronamespace = 'jnj'::regnamespace").fetchone()[0]
    public = conn.execute(
        "select p.proname from pg_proc p where p.pronamespace = 'jnj'::regnamespace"
        " and has_function_privilege('public', p.oid, 'execute') order by 1").fetchall()
    assert functions >= 5 and public == []


@pytest.mark.integration
def test_r1_a_function_in_another_schema_stays_executable_by_public(conn):
    with conn.transaction(force_rollback=True):
        conn.execute("create schema other_app")
        conn.execute("grant usage on schema other_app to public")
        conn.execute("create function other_app.f() returns integer language sql as 'select 1'")
        conn.execute("create function public.jnj_probe_g() returns integer language sql as 'select 2'")
        conn.execute("set local role jnj_loader")
        assert conn.execute("select other_app.f(), public.jnj_probe_g()").fetchone() == (1, 2)


# P2: the jnj_loader guard covers every role attribute and membership

@pytest.mark.integration
@pytest.mark.parametrize("change", [
    "alter role jnj_loader createdb",
    "alter role jnj_loader replication",
    "alter role jnj_loader bypassrls",
    "grant pg_read_all_data to jnj_loader",
])
def test_p2_migration_refuses_a_jnj_loader_with_attributes_or_memberships(conn, change):
    sql = (MIGRATIONS / "0002_loader_role.sql").read_text(encoding="utf-8")
    with pytest.raises(psycopg.errors.RaiseException, match="jnj_loader"):
        with conn.transaction(force_rollback=True):
            conn.execute(change)
            conn.execute(sql)


# P3: a restricted workspace's file name never leaves Python

class Spy:
    """Records every query parameter sent through execute(); everything else goes to the connection."""

    def __init__(self, connection):
        self.connection = connection
        self.sent = []

    def execute(self, query, params=None, **kwargs):
        self.sent.append(repr(params))
        return self.connection.execute(query, params, **kwargs)

    def __getattr__(self, name):
        return getattr(self.connection, name)


@pytest.mark.integration
def test_p3_restricted_file_name_is_hashed_before_it_is_sent(conn, make_workspace, tmp_path):
    path = write_csv(tmp_path / SECRET_NAME, *example_rows())
    spy = Spy(conn)
    load_file(spy, make_workspace("restricted"), path)
    assert spy.sent and not any("name-secret" in params for params in spy.sent), spy.sent
    synthetic = Spy(conn)
    load_file(synthetic, make_workspace("synthetic"), path)
    assert any(SECRET_NAME in params for params in synthetic.sent)


# P4: export of an unknown run is a one-line error, no traceback

@pytest.mark.integration
def test_p4_export_of_an_unknown_run_is_one_line_and_non_zero(database, make_workspace, monkeypatch, capsys):
    workspace = make_workspace()
    monkeypatch.setenv("JNJ_DATABASE_URL", database)
    assert export.main([workspace, "--run", "nope"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == f"ERROR run nope has no records in workspace {workspace}\n"
