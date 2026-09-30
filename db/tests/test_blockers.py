"""The six BLOCKING probes of review db-schema-r1, each as a test.

Each probe is the review's own reproduction, run against this schema; it must now fail closed.
"""
import hashlib
import uuid

import psycopg
import pytest

from export import export_csv
from load import load_file
from support import D06, EXAMPLE, count, example_rows, write_csv
from validate import validate


def ids(conn, workspace):
    """Primary keys of the first loaded answer in a workspace, for direct-insert probes."""
    return conn.execute(
        "select a.workspace_id, a.import_file_pk, a.run_pk, a.case_pk, a.question_pk, a.question_id"
        " from jnj.answer a join jnj.workspace w on w.id = a.workspace_id where w.slug = %s order by a.id limit 1",
        (workspace,),
    ).fetchone()


# B1: every FK between workspace-scoped tables carries workspace_id

@pytest.mark.integration
def test_b1_answer_cannot_point_at_another_workspaces_question(conn, make_workspace):
    mine, theirs = make_workspace(), make_workspace()
    load_file(conn, mine, EXAMPLE)
    load_file(conn, theirs, D06)
    ws, file_pk, run_pk, case_pk, _, _ = ids(conn, mine)
    _, _, _, _, their_question, their_qid = ids(conn, theirs)
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        conn.execute(
            "insert into jnj.answer (workspace_id, import_file_pk, run_pk, case_pk, question_pk, question_id,"
            " answerer_kind, answerer_model, output, source_line) values (%s,%s,%s,%s,%s,%s,'human','cw','no',99)",
            (ws, file_pk, run_pk, case_pk, their_question, their_qid),
        )


@pytest.mark.integration
def test_b1_answer_option_cannot_belong_to_another_workspaces_question(conn, make_workspace):
    mine, theirs = make_workspace(), make_workspace()
    load_file(conn, theirs, D06)
    my_id = conn.execute("select id from jnj.workspace where slug = %s", (mine,)).fetchone()[0]
    their_question = ids(conn, theirs)[4]
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        conn.execute("insert into jnj.answer_option (workspace_id, question_pk, position, value)"
                     " values (%s, %s, 9, 'maybe')", (my_id, their_question))


# B2: answer_set per (workspace, prompt_version, question_id) is immutable

def with_answer_set(tmp_path, name, run_id, answer_set):
    header, rows = example_rows()
    for row in rows:
        row[header.index("run_id")] = run_id
        row[header.index("answer_set")] = answer_set
    return write_csv(tmp_path / name, header, rows)


@pytest.mark.integration
@pytest.mark.parametrize("changed", ["no|yes", "yes|no|maybe"])
def test_b2_reload_with_a_different_answer_set_fails(conn, make_workspace, tmp_path, changed):
    workspace = make_workspace()
    load_file(conn, workspace, with_answer_set(tmp_path, "a.csv", "run-1", "yes|no"))
    with pytest.raises(psycopg.errors.RaiseException, match="answer_set"):
        load_file(conn, workspace, with_answer_set(tmp_path, "b.csv", "run-2", changed))
    stored = conn.execute(
        "select q.answer_set, string_agg(o.value, '|' order by o.position) from jnj.question q"
        " join jnj.answer_option o on o.workspace_id = q.workspace_id and o.question_pk = q.id"
        " join jnj.workspace w on w.id = q.workspace_id where w.slug = %s group by q.answer_set",
        (workspace,),
    ).fetchall()
    assert stored == [("yes|no", "yes|no")]
    assert count(conn, "run", workspace) == 1


@pytest.mark.integration
def test_b2_duplicate_value_in_answer_set_fails_instead_of_collapsing(conn, make_workspace, tmp_path):
    path = with_answer_set(tmp_path, "dup.csv", "run-1", "yes|yes|no")
    assert validate(path)[0] == [], "the validator accepts yes|yes|no; the loader must not collapse it"
    workspace = make_workspace()
    with pytest.raises(psycopg.errors.RaiseException, match="answer_set yes\\|yes\\|no repeats a value"):
        load_file(conn, workspace, path)
    assert count(conn, "question", workspace) == 0


@pytest.mark.integration
def test_b2_db_rejects_a_question_whose_options_do_not_spell_its_answer_set(conn, make_workspace):
    workspace = make_workspace()
    ws = conn.execute("select id from jnj.workspace where slug = %s", (workspace,)).fetchone()[0]
    with pytest.raises(psycopg.errors.CheckViolation, match="answer_set"):
        with conn.transaction():
            q = conn.execute("insert into jnj.question (workspace_id, prompt_version, question_id, question, answer_set)"
                             " values (%s, 'v1', 'q1', 'Q?', 'yes|yes|no') returning id", (ws,)).fetchone()[0]
            conn.execute("insert into jnj.answer_option (workspace_id, question_pk, position, value)"
                         " values (%s, %s, 1, 'yes'), (%s, %s, 3, 'no')", (ws, q, ws, q))
    assert count(conn, "question", workspace) == 0


# B3: one run = one file; DB keys at least as strict as validate.py

@pytest.mark.integration
def test_b3_a_different_file_into_a_loaded_run_fails(conn, make_workspace, tmp_path):
    workspace = make_workspace()
    load_file(conn, workspace, EXAMPLE)
    header, rows = example_rows()
    for row in rows:
        row[header.index("prompt_version")] = "refund-q.v2"
    with pytest.raises(psycopg.errors.RaiseException, match="run run-001 is already loaded from file"):
        load_file(conn, workspace, write_csv(tmp_path / "second.csv", header, rows))
    assert count(conn, "answer", workspace) == 9


@pytest.mark.integration
def test_b3_answer_key_matches_the_validators_key_without_prompt_version(conn, make_workspace):
    workspace = make_workspace()
    load_file(conn, workspace, EXAMPLE)
    ws, file_pk, run_pk, case_pk, _, qid = ids(conn, workspace)
    with conn.transaction():
        q2 = conn.execute("insert into jnj.question (workspace_id, prompt_version, question_id, question, answer_set)"
                          " values (%s, 'refund-q.v2', %s, 'Other wording?', 'yes|no') returning id",
                          (ws, qid)).fetchone()[0]
        conn.execute("insert into jnj.answer_option (workspace_id, question_pk, position, value)"
                     " values (%s, %s, 1, 'yes'), (%s, %s, 2, 'no')", (ws, q2, ws, q2))
    with pytest.raises(psycopg.errors.UniqueViolation, match="answer_run_pk_case_pk_question_id_answerer_kind_key"):
        conn.execute(
            "insert into jnj.answer (workspace_id, import_file_pk, run_pk, case_pk, question_pk, question_id,"
            " answerer_kind, answerer_model, output, source_line) values (%s,%s,%s,%s,%s,%s,'jev','jev-2','no',99)",
            (ws, file_pk, run_pk, case_pk, q2, qid),
        )


# B4: file identity and a total export order

@pytest.mark.integration
def test_b4_import_file_is_recorded_and_source_line_is_unique_per_file(conn, make_workspace):
    workspace = make_workspace()
    load_file(conn, workspace, EXAMPLE)
    recorded = conn.execute(
        "select f.file_sha256, f.original_name, f.purpose from jnj.import_file f"
        " join jnj.workspace w on w.id = f.workspace_id where w.slug = %s", (workspace,)).fetchall()
    assert recorded == [(hashlib.sha256(EXAMPLE.read_bytes()).hexdigest(), "example-v1.csv", "records")]
    ws, file_pk, run_pk, case_pk, question_pk, qid = ids(conn, workspace)
    with pytest.raises(psycopg.errors.UniqueViolation, match="answer_import_file_pk_source_line_key"):
        conn.execute(
            "insert into jnj.answer (workspace_id, import_file_pk, run_pk, case_pk, question_pk, question_id,"
            " answerer_kind, answerer_model, output, source_line) values (%s,%s,%s,%s,%s,%s,'human','cw','no',2)",
            (ws, file_pk, run_pk, case_pk, question_pk, qid),
        )


@pytest.mark.integration
def test_b4_export_orders_by_file_then_line_and_can_scope_to_a_run(conn, make_workspace, tmp_path):
    workspace = make_workspace()
    header, rows = example_rows()
    for row in rows:
        row[header.index("run_id")] = "run-000"
    later = write_csv(tmp_path / "run-000.csv", header, rows)
    load_file(conn, workspace, EXAMPLE)
    load_file(conn, workspace, later)
    lines = export_csv(conn, workspace).text.splitlines()
    assert len(lines) == 19
    assert [line.split(",")[1] for line in lines[1:]] == ["run-001"] * 9 + ["run-000"] * 9
    only = export_csv(conn, workspace, run_ids=["run-000"]).text
    assert only == later.read_text(encoding="utf-8").replace("1.8e-06", "0.0000018") \
        .replace("1.6e-06", "0.0000016").replace("1.9e-06", "0.0000019")


# B5: grants include USAGE on the schema; the loader role can really load

@pytest.mark.integration
def test_b5_loader_role_can_create_a_workspace_load_and_export(conn):
    slug = f"ws-loader-{uuid.uuid4().hex[:10]}"
    conn.execute("set role jnj_loader")
    try:
        assert conn.execute("select current_user").fetchone()[0] == "jnj_loader"
        result = load_file(conn, slug, D06, create_workspace=True)
        assert (result.status, result.answers, result.labels) == ("loaded", 30, 29)
        exported = export_csv(conn, slug)
        assert len(exported.text.splitlines()) == 31
    finally:
        conn.execute("reset role")
    assert conn.execute("select content_policy from jnj.workspace where slug = %s", (slug,)).fetchone() == ("restricted",)


@pytest.mark.integration
@pytest.mark.parametrize("statement", [
    "insert into jnj.workspace (slug, content_policy) values ('sneaky', 'synthetic')",
    "update jnj.workspace set content_policy = 'synthetic'",
    "delete from jnj.answer",
    "update jnj.label set verdict = 'reject'",
])
def test_b5_loader_role_cannot_widen_policy_update_or_delete(conn, statement):
    conn.execute("set role jnj_loader")
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(statement)
    finally:
        conn.execute("reset role")


# B6: raw case text only in a synthetic workspace

@pytest.mark.integration
def test_b6_restricted_workspace_stores_hash_and_length_but_no_text(conn, make_workspace):
    workspace = make_workspace("restricted")
    load_file(conn, workspace, EXAMPLE)
    stored = conn.execute(
        "select c.case_id, c.case_input, c.case_input_sha256, c.case_input_length from jnj.test_case c"
        " join jnj.workspace w on w.id = c.workspace_id where w.slug = %s order by c.case_id", (workspace,)).fetchall()
    header, rows = example_rows()
    text = {row[header.index("case_id")]: row[header.index("case_input")] for row in rows}
    assert stored == [(case, None, hashlib.sha256(text[case].encode("utf-8")).hexdigest(), len(text[case]))
                      for case in ("m01", "m02", "m03")]


@pytest.mark.integration
def test_b6_db_rejects_text_in_a_restricted_workspace(conn, make_workspace):
    workspace = make_workspace("restricted")
    load_file(conn, workspace, EXAMPLE)
    ws, _, run_pk, _, _, _ = ids(conn, workspace)
    text = "a pasted message"
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    with pytest.raises(psycopg.errors.CheckViolation, match="case_input_only_when_synthetic"):
        conn.execute("insert into jnj.test_case (workspace_id, content_policy, run_pk, case_id, case_input_sha256,"
                     " case_input_length, case_input) values (%s, 'restricted', %s, 'm99', %s, %s, %s)",
                     (ws, run_pk, digest, len(text), text))
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        conn.execute("insert into jnj.test_case (workspace_id, content_policy, run_pk, case_id, case_input_sha256,"
                     " case_input_length, case_input) values (%s, 'synthetic', %s, 'm99', %s, %s, %s)",
                     (ws, run_pk, digest, len(text), text))


@pytest.mark.integration
def test_b6_a_workspace_holding_text_cannot_be_downgraded_to_restricted(conn, make_workspace):
    workspace = make_workspace("synthetic")
    load_file(conn, workspace, EXAMPLE)
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        conn.execute("update jnj.workspace set content_policy = 'restricted' where slug = %s", (workspace,))


@pytest.mark.integration
def test_b6_export_of_a_restricted_workspace_leaves_case_input_empty_and_says_so(conn, make_workspace):
    workspace = make_workspace("restricted")
    load_file(conn, workspace, EXAMPLE)
    exported = export_csv(conn, workspace)
    header, *rows = [line.split(",") for line in exported.text.splitlines()]
    assert {row[header.index("case_input")] for row in rows} == {""}
    assert exported.notices == [f"case_input withheld: workspace {workspace} is content_policy=restricted;"
                                " 3 cases keep only sha256 and length, so this export does not validate"]
