# Postgres record store (`jnj-record/1`)

Stores eval record files (answers plus accept/reject labels) in Postgres 14+ and exports them back as the same CSV.

| File | What |
|---|---|
| [migrations/](migrations) | Numbered, forward-only SQL. `0001_records.sql` tables, view, load function; `0002_loader_role.sql` the `jnj_loader` role |
| [migrate.py](migrate.py) | Applies pending migrations, one transaction each, and records each file's sha256 in `jnj_schema_migration`. A changed applied file stops the run |
| [load.py](load.py) | Validates a CSV with `format/validate.py`, copies raw cells to a temp stage table, then `jnj.load_stage()` casts and inserts in one transaction |
| [export.py](export.py) | Writes CSV from the view `jnj.record_v1` |

## Connect
Every command reads the libpq connection string from `JNJ_DATABASE_URL`. Keep passwords in `~/.pgpass` or `PGPASSWORD`, never in the repo.

```
pip install -r requirements.txt
export JNJ_DATABASE_URL="host=/tmp port=5432 dbname=jnj"
python3 db/migrate.py
```

## Load
```
python3 db/load.py --create-workspace demo format/example-v1.csv    # loaded answers=9 labels=8
python3 db/load.py demo format/example-v1.csv                       # unchanged answers=0 labels=0
python3 db/load.py --labels demo labelled.csv                       # adds labels that were missing
```
- The whole file loads or nothing does. Validator errors and values the database cannot store (an integer above 2^63-1, more than 16383 decimal places) are reported per line before any write.
- One run comes from one file. The identical file again is a no-op; a different file with a loaded `run_id` fails.
- A question's wording and `answer_set` are fixed per workspace, `prompt_version` and `question_id`. A change fails; give it a new `prompt_version`. An `answer_set` with a repeated value (`yes|yes|no`) fails.
- `--labels` loads a file whose rows are all loaded already and adds only missing labels. Changing an existing label fails.

## Case text
A workspace is `restricted` (the default) or `synthetic`. A restricted workspace keeps each case's sha256 and length, never the text, and the database enforces it. Only an admin can mark a workspace synthetic:
```
insert into jnj.workspace (slug, content_policy) values ('fixtures', 'synthetic');
```

## Export
```
python3 db/export.py demo > demo.csv
python3 db/export.py demo --run run-001 > run-001.csv
```
Rows come out in load order (file, then line), LF line endings, minimal quoting. Numbers come back as Postgres prints them: `1.8e-06` becomes `0.0000018` and `00042` becomes `42`, equal as decimals. A restricted workspace exports an empty `case_input` and prints a NOTICE, and that file does not validate.

## Roles
`jnj_loader` (NOLOGIN) has USAGE on schema `jnj`, SELECT on its tables, INSERT on the record tables, and may create a restricted workspace. It has no UPDATE and no DELETE, and every UPDATE on a record table is refused by a trigger. Grant it to a login role: `grant jnj_loader to <login role>;`.

## Tests
```
python3 -m pytest -m integration db    # needs a local Postgres; JNJ_TEST_ADMIN_DSN, default host=/tmp port=5432
```
Each session creates `jnj_test_<uuid>`, migrates it and drops it `WITH (FORCE)`.

## Next
- Day 7 metrics: a new migration with views in schema `jnj_metrics` that read only `jnj.record_v1`.
- `query_log`, `use_case` and the app roles from issue #11 wait for a call site.
