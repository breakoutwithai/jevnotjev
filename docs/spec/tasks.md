# Jev!Jev tasks (v1)

Tasks for [spec.md](spec.md) and [plan.md](plan.md) (#17), in challenge-route order. Each task is one PR through [the pipeline](../process/pipeline.md): RED tests first, named with the criterion id they prove.

"Depends on" names the file and line that creates the dependency, or "none". A task whose dependency is only a shared topic is listed as "none".

Day 7 and day 8 oracle: `examples/d06-tiny/expected.md`. The numbers the tests assert:

| Point | Pair | n | a | b | c | d | Accept rates | Cost per accepted | Ratio | Diff | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| q1 | Jev vs LLM | 5 | 4 | 0 | 1 | 0 | 0.8 / 1.0 | $0.000025 / $0.002 | 0.0125 | -0.2 | not enough evidence, add 25 |
| q1 | rule vs Jev | 5 | 2 | 0 | 2 | 1 | rule 0.4 / Jev 0.8 | | | rule minus Jev -0.4 | skipped (5 paired) |
| q2 | Jev vs LLM | 4 | 3 | 0 | 0 | 1 | 0.75 / 0.75 | $0.0000267 / $0.00267 | 0.01 | 0 | not enough evidence, add 26 |
| q2 | rule vs Jev | 5 | 4 | 0 | 0 | 1 | 0.8 / 0.8 | rule spend incomplete | | 0 | skipped (5 paired) |

Whole file (`expected.md:53-57`): jev 10 rows, 10 labelled, 8 accepted, $0.0002; rule 10, 10, 6, incomplete; llm 10, 9, 8, $0.02.

In the rule-vs-Jev rows, a to d are counted with the rule as the first answerer (b = rule only, c = Jev only), matching "rule minus Jev" in `verdict-rules.md:62`. `expected.md:71` counts them with Jev first (b = 2 there); the numbers are the same pairs.

## Tasks

| Task | Day | Reqs | Files | Behaviour | Depends on | Verifying test |
|---|---|---|---|---|---|---|
| T1 | 7 | R17.d | `scripts/ci-check.sh`, `pytest.ini`, `site/jnj/test/` | Gate runs every test runner, prints `head=<sha> clean=<yes\|no>` and each count, fails on a failure, a 0 count, or a tracked test file that was not collected | none | `test_R17d_gate_fails_on_zero_tests`, `test_R17d_gate_fails_on_uncollected_test_file` (`scripts/test_ci_check.py`) |
| T2 | 7 | R2.b, R2.d | `site/jnj/csv.js` | Parse CSV text: quoted commas, doubled quotes, CRLF and LF; keep source line numbers | none | `R2.b parses quoted comma, doubled quote and CRLF`, `R2.d d06 parses to 30 rows of 18 cells` (`csv.test.mjs`) |
| T3 | 7 | R4.a, R4.b, R5.a, R5.b | `site/jnj/calc.js` | Group by `question_id` (`verdict-rules.md:17`); per answerer rows, labelled, accepted, spend or `incomplete`, cost per accepted or `undefined` | T2: `calc.test.mjs` reads `examples/d06-tiny/records.csv` through `csv.js` | `R5.a d06 whole-file totals match expected.md:53-57`, `R5.b zero accepted gives undefined`, `R4.a one question_id under two prompt_versions is one decision point`, `R4.b q1 and q2 are never pooled`, `R4.d human rows are counted and not in the verdict` |
| T4 | 7 | R5.c, R5.d | `site/jnj/calc.js` | Pairing on labelled rows per question; a, b, c, d, p1, p2, diff for Jev vs LLM and rule vs Jev | T3: pairing reads the groups `group()` returns | `R5.c q2 cv2 drops out, n=4`, `R5.d d06 a b c d match the oracle table` |
| T5 | 7 | R5.e | `site/jnj/calc.js` | Wilson interval and Newcombe method 10 per `verdict-rules.md:42-49` | none | `R5.e Newcombe matches the 7 Table III rows` (rows from `docs/decision/newcombe_check.py:12-15`) |
| T6 | 7 | R5.f, R5.g, R13.a | `site/jnj/calc.js` | Cost ratio with 0 and infinity; 2,000 seeded paired resamples, both-zero redrawn; seed from the file's SHA-256 | T3: the ratio divides the two `cost_per_accepted` values T3 returns | `R5.f d06 q1 ratio 0.0125 and q2 0.01`, `R5.g both-zero resample is redrawn`, `R13.a same file gives identical interval twice` |
| T7 | 8 | R6.b, R6.c, R6.d, R6.e | `examples/d08-verdicts/make.py`, `examples/d08-verdicts/*.csv`, `examples/d08-verdicts/expected.md` | Synthetic 30-plus-case files, one per verdict branch, with every count worked in `expected.md`; per-call costs $0.00002 Jev and $0.002 LLM so the cost bar holds in every resample and each branch turns on accept rate | none | `test_R6b_d08_files_validate` (`format/test_validate.py`, runs `validate.py` on each) |
| T8 | 8 | R6.a to R6.h | `site/jnj/verdict.js` | The four rules in order, first match wins; returns the rule, the condition, the numbers read, and `add_n` | T4, T5, T6: `verdict-rules.md:62-68` conditions read the Newcombe bounds and cost-ratio bounds those tasks compute | `R6.g d06 q1 add 25 and q2 add 26`, `R6.f no Jev rows is never don't use Jev`, one `R6.b`/`R6.c`/`R6.d`/`R6.e` test per d08 file |
| T9 | 9 | R1, R7.a, R7.b, R7.c, R8, R11.b | `site/jnj/view.js`, `site/jnj/pipeline.js`, `site/sample/uc11.csv`, `site/index.html` | First result view: the UC11 sample runs through `pipeline.run()` and renders the answerer table, verdict, rule fired, numbers, gaps and the test-set-only line | T8: `pipeline.run()` calls `verdict()`; `site/index.html:698-702` reads `J.verdict` from `data.js` and is rewired to the pipeline result | `R1.a` to `R1.e` one test each on the start copy (`start.test.mjs`), `R7.a view shows spend, accepted and cost per accepted per answerer`, `R7.b view names rule 1 and paired count 5 for d06 q1`, `R7.c view carries the test-set-only sentence`, `R6.h view says the rule comparison is skipped for d06`, `R8.a view lists line 25 as unlabelled`, `R8.b view shows rule spend incomplete` |
| T10 | 9 | R11.a, R17.c | `site/data.js`, `site/index.html`, `docs/product/user-stories.md` | Remove the router sample (`site/data.js:4-8`, picks at `site/index.html:599-604`); reword US-05 and US-06 to link verdict-rules | T9: the page needs the pipeline sample before `data.js` goes | `test_R17c_verdict_wording_agrees` (`tests/test_docs_consistency.py`: no Haiku / Sonnet / Opus pick outside lines marked historical; US-05 and US-06 name "undefined (0 accepted)" and link verdict-rules.md) |
| T11 | 10 | R3.a, R3.b, R3.d, R3.e | `site/jnj/validate.js`, `format/fixtures/*.csv`, `format/test_parity.py` | Port `format/validate.py:24-95`; one fixture per rule; parity against Python | T2: `validate.js` takes the cells `csv.js` returns | `R3.a one fixture per validate.py rule, rejected by both`, `test_R3b_browser_and_python_agree_on_every_fixture`, `R3.d missing cost and label are gaps and the file stays valid`, `R3.e d06 valid with gaps at lines 21 and 25` |
| T12 | 10 | R2.a, R2.c, R3.c, R7.d | `site/index.html` | Enable the drop zone (`site/index.html:489-497`); `takeFile` (`:716-724`) calls `pipeline.run()`; an invalid file shows its first error and imports nothing | T9, T11: `takeFile` calls `pipeline.run()`, which calls `validate()` | `R2.a file input accepts .csv and the drop zone is enabled` (`static.test.mjs`), `R3.c invalid file returns only errors and no result` (`pipeline.test.mjs`), `R2.c page makes no network call` (`site/jnj/test/static.test.mjs`: no `fetch`, `XMLHttpRequest`, `sendBeacon` or `WebSocket` in `site/` outside the sample load) |
| T13 | 11 | R14 | `site/jnj/cases.js`, `site/index.html` | Decision and answer set entry; add, edit, remove numbered cases; download a case list | none | `R14.b cases renumber after a removal`, `R14.c case list downloads with 4 columns` |
| T14 | 12 | R4.c, R9, R10 | `site/jnj/view.js`, `site/index.html` | Decision-point selector; per-case rows with outputs, labels, win/loss/tie; rejected Jev answers first by confidence | T4: win and loss counts are b and c from `pairs.jev_llm` | `R9.c d06 q1 Jev losses equal c=1`, `R10.b cv4 q1 (0.62) listed first`, `R4.c d06 shows two decision points` |
| T15 | 13 | R2, R3, R6, R7 | `site/jnj/test/pipeline.test.mjs` | Happy path: d06 and each d08 file through `pipeline.run()` give the verdicts in their `expected.md` | T8, T11: `pipeline.run()` calls both | `R6.a every d08 file gives its expected verdict`, `R7.d numbers come from the file, not data.js` |
| T16 | 14 | R7.b, R8.c, R8.d | `site/jnj/view.js` | Every number links to its formula in `verdict-rules.md` and lists the rows behind it; "below minimum" and 3/n shown | T9: extends the view T9 renders | `R8.c d06 marked below minimum with paired count`, `R8.d zero accepted shows upper bound 3/n` |
| T17 | 15 | R5.h, R6.a | `docs/decision/hand_check.py`, `examples/d08-verdicts/expected.md` | A second, independent Python calculation of every d06 and d08 number; compare with `pipeline.run()` output | T7: reads the d08 files | `test_R5h_hand_check_reproduces_d06_expected_md`, `test_R6a_hand_check_agrees_with_browser_on_d08` |
| T18 | 16 | R12 | `site/jnj/pipeline.js`, `format/fixtures/` | Empty, header-only, not-CSV, rule-only and second-load cases | T12: the load path is the one T12 wires | `R12.a empty file is a named error`, `R12.b rule-only file says no Jev results`, `R12.c second load replaces the first` |
| T19 | 17 | R13 | `site/jnj/pipeline.js`, `site/index.html` | Save result: verdict, numbers, rules version, file SHA-256; same file gives a byte-identical saved result | T6: the seed comes from the hash T6 computes | `R13.b saved result is byte-identical across two loads` |
| T20 | 17 | R17.a, R17.b | `scripts/spec-check.py`, `scripts/ci-check.sh` | List every criterion with its tests; exit non-zero on an untested must criterion or 0 checked | T1: the gate script calls spec-check | `test_R17a_spec_check_reports_a_test_with_no_criterion_id`, `test_R17b_spec_check_fails_on_untested_must`, `test_R17b_spec_check_fails_on_zero_criteria` |
| T21 | 18 | R16 | `site/index.html`, `README.md` | First-use guide in `FLOW.md` Journey order | T12: the guide ends at a working load | `test_R16b_guide_commands_run_on_a_clean_clone` |
| T22 | later | R18 | `db/` (PR 15, merged be5f849), `db/tests/` | Export from Postgres loads in the browser with the same numbers | T15: compares with `pipeline.run()` on the original file | `test_R18a_db_export_gives_same_verdict` |
| T23 | later | R15 | `site/jnj/label.js`, `site/index.html` | Label on the page; download a valid file | T12 | `R15.b labelled download passes validate.py` |
| T24 | later | R19 | per #11 | Generalised-question log | D1 in spec.md (hosting) | per #11 Done when |

## Coverage, per criterion
Counted per criterion, since a requirement with a task can still have criteria with no test. All 47 must criteria have a planned test; 0 have a passing test today.

| Criteria | Task | Test file |
|---|---|---|
| R1.a to R1.e | T9 | `site/jnj/test/start.test.mjs` |
| R2.a, R2.c | T12 | `site/jnj/test/static.test.mjs` |
| R2.b, R2.d | T2 | `csv.test.mjs` |
| R3.a, R3.b, R3.d, R3.e | T11 | `validate.test.mjs`, `format/test_parity.py` |
| R3.c | T12 | `pipeline.test.mjs` |
| R4.a, R4.b, R4.d | T3 | `calc.test.mjs` |
| R4.c | T14 | `view.test.mjs` |
| R5.a to R5.g | T3 to T6 | `calc.test.mjs` |
| R5.h | T17 | `docs/decision/test_hand_check.py` |
| R6.a | T15, T17 | `pipeline.test.mjs` |
| R6.b to R6.g | T8 | `verdict.test.mjs` |
| R6.h, R7.a, R7.b, R7.c, R8.a, R8.b | T9 | `view.test.mjs` |
| R7.d | T15 | `pipeline.test.mjs` |
| R8.c, R8.d | T16 | `view.test.mjs` |
| R12.a to R12.c | T18 | `pipeline.test.mjs` |
| R13.a | T6 | `calc.test.mjs` |
| R13.b | T19 | `pipeline.test.mjs` |

Every task names its verifying test: 24 of 24.

## Test runner
At 5e80a84 `pytest.ini` had `testpaths = format`; PR 15 made it `format db`. `.deploy/tests/` (3 shell tests) is run by no gate. Test files planned outside those folders (`scripts/`, `tests/`, `docs/decision/`) would not be collected, which is why T1 fails on an uncollected tracked test file. #22 moves the code to TypeScript on Bun and replaces the runner with `bun test`; the `.mjs` and `node --test` names above follow that port when it lands.
