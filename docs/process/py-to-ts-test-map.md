# Python to TypeScript test map

Issue #22 moved the code to TypeScript on Bun. Every Python test has a TypeScript test with the same intent, fixtures, planted secrets and role checks; none was dropped.

| | Tests | Run with |
|---|---|---|
| Python, before (commit be5f849) | 94 passed (1 smoke, 24 unit, 69 integration): 22 format, 72 db | `python3 -m pytest` on Python 3.13.11, jsonschema 4.26.0, psycopg 3.3.6 |
| TypeScript, after | 98 passed (1 smoke, 28 unit, 69 integration): the 94 below plus 4 new in `src/format/pyrepr.test.ts` | `bun test` on Bun 1.4.2 |

The tier is the bracketed prefix of each test name: `bun test -t '\[unit\]'` runs one tier. Integration tests create one throwaway database `jnj_test_<hex>` per run and drop it `WITH (FORCE)` after the last test.

Changes the language forced:
- `test_n1_export_requires_a_run` checked that `export_csv(None, "ws")` raises `TypeError`. TypeScript rejects that call at compile time, so the test checks the function takes three parameters and that the command without `--run` exits 2.
- psycopg exception classes (`ForeignKeyViolation`, `CheckViolation`, ...) are checked as their SQLSTATE codes (`23503`, `23514`, `23505`, `P0001`, `42501`).
- `Decimal` values are checked as exact strings (numeric is read as a string, int8 as bigint), and `force_rollback=True` as a transaction that always rolls back.

| Python test | TypeScript file | TypeScript test |
|---|---|---|
| `format/test_validate.py::test_example_is_valid_with_its_two_gaps` | `src/format/validate.test.ts` | [smoke] example is valid with its two gaps |
| `format/test_validate.py::test_summary_counts_labelled_rows_only_and_marks_cost_incomplete` | `src/format/validate.test.ts` | [unit] summary counts labelled rows only and marks cost incomplete |
| `format/test_validate.py::test_output_outside_answer_set_is_an_error` | `src/format/validate.test.ts` | [unit] output outside answer_set is an error |
| `format/test_validate.py::test_unknown_answerer_is_an_error` | `src/format/validate.test.ts` | [unit] unknown answerer is an error |
| `format/test_validate.py::test_label_without_source_is_an_error` | `src/format/validate.test.ts` | [unit] label without source is an error |
| `format/test_validate.py::test_confidence_above_one_is_an_error` | `src/format/validate.test.ts` | [unit] confidence above one is an error |
| `format/test_validate.py::test_malformed_cost_is_an_error_not_a_gap` | `src/format/validate.test.ts` | [unit] malformed cost is an error not a gap |
| `format/test_validate.py::test_question_reworded_under_the_same_prompt_version_is_an_error` | `src/format/validate.test.ts` | [unit] question reworded under the same prompt_version is an error |
| `format/test_validate.py::test_reworded_question_with_a_new_prompt_version_is_valid` | `src/format/validate.test.ts` | [unit] reworded question with a new prompt_version is valid |
| `format/test_validate.py::test_duplicate_row_is_an_error` | `src/format/validate.test.ts` | [unit] duplicate row is an error |
| `format/test_validate.py::test_case_input_must_match_across_rows` | `src/format/validate.test.ts` | [unit] case_input must match across rows |
| `format/test_validate.py::test_wrong_format_version_is_an_error` | `src/format/validate.test.ts` | [unit] wrong format_version is an error |
| `format/test_validate.py::test_missing_column_is_an_error` | `src/format/validate.test.ts` | [unit] missing column is an error |
| `format/test_validate.py::test_empty_file_is_an_error` | `src/format/validate.test.ts` | [unit] empty file is an error |
| `format/test_validate.py::test_non_finite_or_odd_numbers_are_errors[confidence-nan]` | `src/format/validate.test.ts` | [unit] non-finite or odd numbers are errors: confidence=nan |
| `format/test_validate.py::test_non_finite_or_odd_numbers_are_errors[cost_usd-nan]` | `src/format/validate.test.ts` | [unit] non-finite or odd numbers are errors: cost_usd=nan |
| `format/test_validate.py::test_non_finite_or_odd_numbers_are_errors[cost_usd-inf]` | `src/format/validate.test.ts` | [unit] non-finite or odd numbers are errors: cost_usd=inf |
| `format/test_validate.py::test_non_finite_or_odd_numbers_are_errors[tokens_in-4_2]` | `src/format/validate.test.ts` | [unit] non-finite or odd numbers are errors: tokens_in=4_2 |
| `format/test_validate.py::test_padded_label_is_an_error` | `src/format/validate.test.ts` | [unit] padded label is an error |
| `format/test_validate.py::test_short_row_is_an_error` | `src/format/validate.test.ts` | [unit] short row is an error |
| `format/test_validate.py::test_extra_cells_are_an_error` | `src/format/validate.test.ts` | [unit] extra cells are an error |
| `format/test_validate.py::test_duplicate_header_is_an_error` | `src/format/validate.test.ts` | [unit] duplicate header is an error |
| `db/tests/test_blockers.py::test_b1_answer_cannot_point_at_another_workspaces_question` | `src/db/tests/blockers.test.ts` | [integration] b1 answer cannot point at another workspace's question |
| `db/tests/test_blockers.py::test_b1_answer_option_cannot_belong_to_another_workspaces_question` | `src/db/tests/blockers.test.ts` | [integration] b1 answer_option cannot belong to another workspace's question |
| `db/tests/test_blockers.py::test_b2_reload_with_a_different_answer_set_fails[no\|yes]` | `src/db/tests/blockers.test.ts` | [integration] b2 reload with a different answer_set fails: no\|yes |
| `db/tests/test_blockers.py::test_b2_reload_with_a_different_answer_set_fails[yes\|no\|maybe]` | `src/db/tests/blockers.test.ts` | [integration] b2 reload with a different answer_set fails: yes\|no\|maybe |
| `db/tests/test_blockers.py::test_b2_duplicate_value_in_answer_set_fails_instead_of_collapsing` | `src/db/tests/blockers.test.ts` | [integration] b2 duplicate value in answer_set fails instead of collapsing |
| `db/tests/test_blockers.py::test_b2_db_rejects_a_question_whose_options_do_not_spell_its_answer_set` | `src/db/tests/blockers.test.ts` | [integration] b2 db rejects a question whose options do not spell its answer_set |
| `db/tests/test_blockers.py::test_b3_a_different_file_into_a_loaded_run_fails` | `src/db/tests/blockers.test.ts` | [integration] b3 a different file into a loaded run fails |
| `db/tests/test_blockers.py::test_b3_answer_key_matches_the_validators_key_without_prompt_version` | `src/db/tests/blockers.test.ts` | [integration] b3 answer key matches the validator's key without prompt_version |
| `db/tests/test_blockers.py::test_b4_import_file_is_recorded_and_source_line_is_unique_per_file` | `src/db/tests/blockers.test.ts` | [integration] b4 import_file is recorded and source_line is unique per file |
| `db/tests/test_blockers.py::test_b4_export_is_one_run_in_source_line_order` | `src/db/tests/blockers.test.ts` | [integration] b4 export is one run in source-line order |
| `db/tests/test_blockers.py::test_b5_loader_role_can_create_a_workspace_load_and_export` | `src/db/tests/blockers.test.ts` | [integration] b5 loader role can create a workspace, load and export |
| `db/tests/test_blockers.py::test_b5_loader_role_cannot_widen_policy_update_or_delete[insert into jnj.workspace (slug, content_policy) values ('sneaky', 'synthetic')]` | `src/db/tests/blockers.test.ts` | [integration] b5 loader role cannot widen policy, update or delete: insert into jnj.workspace (slug, content_policy) values ('sneaky', 'synthetic') |
| `db/tests/test_blockers.py::test_b5_loader_role_cannot_widen_policy_update_or_delete[update jnj.workspace set content_policy = 'synthetic']` | `src/db/tests/blockers.test.ts` | [integration] b5 loader role cannot widen policy, update or delete: update jnj.workspace set content_policy = 'synthetic' |
| `db/tests/test_blockers.py::test_b5_loader_role_cannot_widen_policy_update_or_delete[delete from jnj.answer]` | `src/db/tests/blockers.test.ts` | [integration] b5 loader role cannot widen policy, update or delete: delete from jnj.answer |
| `db/tests/test_blockers.py::test_b5_loader_role_cannot_widen_policy_update_or_delete[update jnj.label set verdict = 'reject']` | `src/db/tests/blockers.test.ts` | [integration] b5 loader role cannot widen policy, update or delete: update jnj.label set verdict = 'reject' |
| `db/tests/test_blockers.py::test_b6_restricted_workspace_stores_hash_and_length_but_no_text` | `src/db/tests/blockers.test.ts` | [integration] b6 restricted workspace stores hash and length but no text |
| `db/tests/test_blockers.py::test_b6_db_rejects_text_in_a_restricted_workspace` | `src/db/tests/blockers.test.ts` | [integration] b6 db rejects text in a restricted workspace |
| `db/tests/test_blockers.py::test_b6_a_workspace_holding_text_cannot_be_downgraded_to_restricted` | `src/db/tests/blockers.test.ts` | [integration] b6 a workspace holding text cannot be downgraded to restricted |
| `db/tests/test_blockers.py::test_b6_export_of_a_restricted_workspace_leaves_case_input_empty_and_says_so` | `src/db/tests/blockers.test.ts` | [integration] b6 export of a restricted workspace leaves case_input empty and says so |
| `db/tests/test_constraints.py::test_db_rejects_bad_answer_values[maybe-None-None-ForeignKeyViolation]` | `src/db/tests/constraints.test.ts` | [integration] db rejects bad answer values: maybe-None-None-ForeignKeyViolation |
| `db/tests/test_constraints.py::test_db_rejects_bad_answer_values[no-confidence1-None-CheckViolation]` | `src/db/tests/constraints.test.ts` | [integration] db rejects bad answer values: no-1.5-None-CheckViolation |
| `db/tests/test_constraints.py::test_db_rejects_bad_answer_values[no-None-cost2-CheckViolation]` | `src/db/tests/constraints.test.ts` | [integration] db rejects bad answer values: no-None--1-CheckViolation |
| `db/tests/test_constraints.py::test_db_rejects_label_maybe_and_any_update` | `src/db/tests/constraints.test.ts` | [integration] db rejects label maybe and every update |
| `db/tests/test_constraints.py::test_db_rejects_a_single_option_question` | `src/db/tests/constraints.test.ts` | [integration] db rejects a single-option question |
| `db/tests/test_constraints.py::test_db_accepts_what_the_validator_accepts[confidence-1e-400-expected0]` | `src/db/tests/constraints.test.ts` | [integration] db accepts what the validator accepts: confidence=1e-400 |
| `db/tests/test_constraints.py::test_db_accepts_what_the_validator_accepts[tokens_in-3000000000-3000000000]` | `src/db/tests/constraints.test.ts` | [integration] db accepts what the validator accepts: tokens_in=3000000000 |
| `db/tests/test_constraints.py::test_db_accepts_what_the_validator_accepts[tokens_in-9223372036854775807-9223372036854775807]` | `src/db/tests/constraints.test.ts` | [integration] db accepts what the validator accepts: tokens_in=9223372036854775807 |
| `db/tests/test_constraints.py::test_db_accepts_what_the_validator_accepts[cost_usd-1e-400-expected3]` | `src/db/tests/constraints.test.ts` | [integration] db accepts what the validator accepts: cost_usd=1e-400 |
| `db/tests/test_constraints.py::test_db_accepts_what_the_validator_accepts[cost_usd-00042-expected4]` | `src/db/tests/constraints.test.ts` | [integration] db accepts what the validator accepts: cost_usd=00042 |
| `db/tests/test_constraints.py::test_loader_rejects_before_writing_what_the_db_cannot_store[tokens_in-9223372036854775808-line 2: tokens_in: 9223372036854775808 is above 9223372036854775807]` | `src/db/tests/constraints.test.ts` | [integration] loader rejects before writing what the db cannot store: tokens_in |
| `db/tests/test_constraints.py::test_loader_rejects_before_writing_what_the_db_cannot_store[latency_ms-1000000000000000000000000000000-line 2: latency_ms: 1000000000000000000000000000000 is above]` | `src/db/tests/constraints.test.ts` | [integration] loader rejects before writing what the db cannot store: latency_ms |
| `db/tests/test_constraints.py::test_loader_rejects_before_writing_what_the_db_cannot_store[cost_usd-1e-16384-line 2: cost_usd: 1e-16384 has more than 16383 digits after the decimal point]` | `src/db/tests/constraints.test.ts` | [integration] loader rejects before writing what the db cannot store: cost_usd |
| `db/tests/test_constraints.py::test_loader_rejects_before_writing_what_the_db_cannot_store[confidence-0e-99999-line 2: confidence: 0e-99999 has more than 16383 digits after the decimal point]` | `src/db/tests/constraints.test.ts` | [integration] loader rejects before writing what the db cannot store: confidence |
| `db/tests/test_constraints.py::test_loader_rejects_before_writing_what_the_db_cannot_store[run_id-run-001\n-line 3: run_id: 'run-001\\n' ends with a line break]` | `src/db/tests/constraints.test.ts` | [integration] loader rejects before writing what the db cannot store: run_id |
| `db/tests/test_constraints.py::test_migrate_is_idempotent_and_refuses_a_changed_applied_file` | `src/db/tests/constraints.test.ts` | [integration] migrate is idempotent and refuses a changed applied file |
| `db/tests/test_review_r2.py::test_n1_each_run_export_validates_when_runs_share_a_case_id` | `src/db/tests/review-r2.test.ts` | [integration] n1 each run's export validates when runs share a case_id |
| `db/tests/test_review_r2.py::test_n1_export_requires_a_run` | `src/db/tests/review-r2.test.ts` | [unit] n1 export requires a run |
| `db/tests/test_review_r2.py::test_n2_restricted_workspace_stores_question_and_file_name_as_hash_only` | `src/db/tests/review-r2.test.ts` | [integration] n2 restricted workspace stores question and file name as hash only |
| `db/tests/test_review_r2.py::test_n2_db_rejects_question_text_and_file_name_in_a_restricted_workspace` | `src/db/tests/review-r2.test.ts` | [integration] n2 db rejects question text and file name in a restricted workspace |
| `db/tests/test_review_r2.py::test_n2_o7_load_errors_never_echo_question_case_text_or_file_name[reworded-records]` | `src/db/tests/review-r2.test.ts` | [integration] n2 o7 load errors never echo question, case text or file name: reworded-records |
| `db/tests/test_review_r2.py::test_n2_o7_load_errors_never_echo_question_case_text_or_file_name[other_file_same_run-records]` | `src/db/tests/review-r2.test.ts` | [integration] n2 o7 load errors never echo question, case text or file name: other_file_same_run-records |
| `db/tests/test_review_r2.py::test_n2_o7_load_errors_never_echo_question_case_text_or_file_name[label_on_changed_row-labels]` | `src/db/tests/review-r2.test.ts` | [integration] n2 o7 load errors never echo question, case text or file name: label_on_changed_row-labels |
| `db/tests/test_review_r2.py::test_n2_o7_load_errors_never_echo_question_case_text_or_file_name[relabel-labels]` | `src/db/tests/review-r2.test.ts` | [integration] n2 o7 load errors never echo question, case text or file name: relabel-labels |
| `db/tests/test_review_r2.py::test_n2_o7_load_errors_never_echo_question_case_text_or_file_name[overlong_case-records]` | `src/db/tests/review-r2.test.ts` | [integration] n2 o7 load errors never echo question, case text or file name: overlong_case-records |
| `db/tests/test_review_r2.py::test_n2_o7_load_errors_never_echo_question_case_text_or_file_name[empty_question-records]` | `src/db/tests/review-r2.test.ts` | [integration] n2 o7 load errors never echo question, case text or file name: empty_question-records |
| `db/tests/test_review_r2.py::test_n2_o7_load_errors_never_echo_question_case_text_or_file_name[None-labels]` | `src/db/tests/review-r2.test.ts` | [integration] n2 o7 load errors never echo question, case text or file name: None-labels |
| `db/tests/test_review_r2.py::test_o6_confidence_above_one_is_rejected_by_loader_and_db` | `src/db/tests/review-r2.test.ts` | [integration] o6 confidence above one is rejected by loader and db |
| `db/tests/test_review_r2.py::test_o2_migration_refuses_a_jnj_loader_with_extra_powers[login]` | `src/db/tests/review-r2.test.ts` | [integration] o2 migration refuses a jnj_loader with extra powers: login |
| `db/tests/test_review_r2.py::test_o2_migration_refuses_a_jnj_loader_with_extra_powers[superuser]` | `src/db/tests/review-r2.test.ts` | [integration] o2 migration refuses a jnj_loader with extra powers: superuser |
| `db/tests/test_review_r2.py::test_o2_migration_refuses_a_jnj_loader_with_extra_powers[createrole]` | `src/db/tests/review-r2.test.ts` | [integration] o2 migration refuses a jnj_loader with extra powers: createrole |
| `db/tests/test_review_r2.py::test_o1_migrate_refuses_an_unapplied_file_numbered_below_the_latest` | `src/db/tests/review-r2.test.ts` | [integration] o1 migrate refuses an unapplied file numbered below the latest |
| `db/tests/test_review_r2.py::test_o1_migrate_refuses_when_an_applied_file_is_missing` | `src/db/tests/review-r2.test.ts` | [integration] o1 migrate refuses when an applied file is missing |
| `db/tests/test_review_r2.py::test_o1_sql_files_are_checked_out_with_lf` | `src/db/tests/review-r2.test.ts` | [unit] o1 sql files are checked out with LF |
| `db/tests/test_review_r2.py::test_o9_concurrent_ensure_workspace_does_not_collide` | `src/db/tests/review-r2.test.ts` | [integration] o9 concurrent ensureWorkspace does not collide |
| `db/tests/test_review_r3.py::test_r1_no_function_in_schema_jnj_is_executable_by_public` | `src/db/tests/review-r3.test.ts` | [integration] r1 no function in schema jnj is executable by public |
| `db/tests/test_review_r3.py::test_r1_a_function_in_another_schema_stays_executable_by_public` | `src/db/tests/review-r3.test.ts` | [integration] r1 a function in another schema stays executable by public |
| `db/tests/test_review_r3.py::test_p2_migration_refuses_a_jnj_loader_with_attributes_or_memberships[alter role jnj_loader createdb]` | `src/db/tests/review-r3.test.ts` | [integration] p2 migration refuses a jnj_loader with attributes or memberships: alter role jnj_loader createdb |
| `db/tests/test_review_r3.py::test_p2_migration_refuses_a_jnj_loader_with_attributes_or_memberships[alter role jnj_loader replication]` | `src/db/tests/review-r3.test.ts` | [integration] p2 migration refuses a jnj_loader with attributes or memberships: alter role jnj_loader replication |
| `db/tests/test_review_r3.py::test_p2_migration_refuses_a_jnj_loader_with_attributes_or_memberships[alter role jnj_loader bypassrls]` | `src/db/tests/review-r3.test.ts` | [integration] p2 migration refuses a jnj_loader with attributes or memberships: alter role jnj_loader bypassrls |
| `db/tests/test_review_r3.py::test_p2_migration_refuses_a_jnj_loader_with_attributes_or_memberships[grant pg_read_all_data to jnj_loader]` | `src/db/tests/review-r3.test.ts` | [integration] p2 migration refuses a jnj_loader with attributes or memberships: grant pg_read_all_data to jnj_loader |
| `db/tests/test_review_r3.py::test_p3_restricted_file_name_is_hashed_before_it_is_sent` | `src/db/tests/review-r3.test.ts` | [integration] p3 restricted file name is hashed before it is sent |
| `db/tests/test_review_r3.py::test_p4_export_of_an_unknown_run_is_one_line_and_non_zero` | `src/db/tests/review-r3.test.ts` | [integration] p4 export of an unknown run is one line and non-zero |
| `db/tests/test_roundtrip.py::test_equivalence_rule_accepts_respelled_numbers_and_nothing_else` | `src/db/tests/roundtrip.test.ts` | [unit] equivalence rule accepts respelled numbers and nothing else |
| `db/tests/test_roundtrip.py::test_d06_export_equals_source_after_crlf_to_lf` | `src/db/tests/roundtrip.test.ts` | [integration] d06 export equals source after CRLF to LF |
| `db/tests/test_roundtrip.py::test_example_export_is_byte_identical_except_exponent_cells` | `src/db/tests/roundtrip.test.ts` | [integration] example export is byte-identical except exponent cells |
| `db/tests/test_roundtrip.py::test_export_reload_export_is_a_fixed_point` | `src/db/tests/roundtrip.test.ts` | [integration] export, reload, export is a fixed point |
| `db/tests/test_roundtrip.py::test_reloading_the_identical_file_is_a_no_op` | `src/db/tests/roundtrip.test.ts` | [integration] reloading the identical file is a no-op |
| `db/tests/test_roundtrip.py::test_labels_file_fills_a_missing_label_and_cannot_change_one` | `src/db/tests/roundtrip.test.ts` | [integration] labels file fills a missing label and cannot change one |
| `db/tests/test_roundtrip.py::test_labels_file_row_must_match_a_loaded_answer` | `src/db/tests/roundtrip.test.ts` | [integration] labels file row must match a loaded answer |
| `db/tests/test_roundtrip.py::test_invalid_file_writes_nothing` | `src/db/tests/roundtrip.test.ts` | [integration] invalid file writes nothing |
| `db/tests/test_roundtrip.py::test_database_error_rolls_back_the_whole_file` | `src/db/tests/roundtrip.test.ts` | [integration] database error rolls back the whole file |
| `db/tests/test_roundtrip.py::test_type_fidelity` | `src/db/tests/roundtrip.test.ts` | [integration] type fidelity: numeric reads back exact text, int8 a bigint, timestamptz a Date object |

New in TypeScript, pinning the Python behaviour the messages depend on (outputs taken from CPython 3.13):

- `src/format/pyrepr.test.ts`: [unit] repr(float) switches to exponent form outside 1e-4..1e16
- `src/format/pyrepr.test.ts`: [unit] repr(str) picks quotes and escapes non-printable characters
- `src/format/pyrepr.test.ts`: [unit] csv reader keeps Python's line numbers, blank-line skipping and non-strict quotes
- `src/format/pyrepr.test.ts`: [unit] csv writer quotes like QUOTE_MINIMAL
