# Jev!Jev tasks (v1)

Tasks for [spec.md](spec.md) and [plan.md](plan.md) (#17), in challenge-route order. Each task is one PR through [the pipeline](../process/pipeline.md): RED tests first, named with the criterion id they prove.

"Depends on" names the file and line that creates the dependency when that file exists today. When the dependency is on a file an earlier task creates, it names that task and the function or file it reads, since there is no line yet. A dependency that is only a shared topic is listed as "none". Test names are `bun test` titles: the tier in brackets first, then the criterion id (`[unit] R5.e ...`). The table lists titles without the tier.

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
| T0 | before 7 | R3.b | **done in #25** (#22): `package.json`, `tsconfig.json`, `src/format/`, `src/db/` | TypeScript on Bun; port the validator, loader, exporter and migrator; parity on every fixture; then remove the originals | none | Parity harness: 59 fixtures, 818 comparisons, 0 differences (quoted on #25); harness removed after, in history at cd8397f |
| T1 | 7 | R17.d | `scripts/ci-check.sh` | Gate runs `bun test`, rebuilds `site/jnj.js`, prints `head=<sha> clean=<yes\|no>` and the test count; fails on a failure, a 0 count, a bundle diff, or a tracked test file that was not collected | T0: `bun test` exists from #25 | `R17.d gate fails on zero tests`, `R17.d gate fails on an uncollected test file` (`scripts/ci-check.test.ts`) |
| T2 | 7 | R2.b, R2.d | `src/format/csv.ts` (exists from #25), `src/format/csv.test.ts` | Reuse `readRecords()`: quoted commas, doubled quotes, CRLF and LF, source line numbers in `CsvRecord.line`; add the criterion tests | T0: `src/format/csv.ts` | `R2.b parses quoted comma, doubled quote and CRLF`, `R2.d d06 parses to 30 rows of 18 cells` (`src/format/csv.test.ts`) |
| T3 | 7 | R4.a, R4.b, R4.d, R5.a, R5.b | `src/core/calc.ts` | Group by (`prompt_version`, `question_id`); per answerer rows, labelled, accepted, spend or `incomplete`, cost per accepted or `undefined` | T2: `calc.test.ts` reads `examples/d06-tiny/records.csv` through `readRecords()` | `R4.a two prompt_versions of one question_id are two decision points`, `R4.b q1 and q2 are never pooled`, `R4.d human rows are counted and not in the verdict`, `R5.a d06 whole-file totals match expected.md:53-57`, `R5.b zero accepted gives undefined` |
| T4 | 7 | R5.c, R5.d | `src/core/calc.ts` | Pairing by `case_id` on labelled rows inside one decision point; a, b, c, d, p1, p2, diff for Jev vs LLM and rule vs Jev | T3: pairing reads the groups `group()` returns | `R5.c q2 cv2 drops out, n=4`, `R5.d d06 a b c d match the oracle table` |
| T5 | 7 | R5.e | `src/core/calc.ts` | Wilson interval and Newcombe method 10 per `verdict-rules.md:42-49` | T0: `src/format/validate.ts` (the TypeScript core that `src/core/calc.ts` sits beside and imports types from) | `R5.e Newcombe matches the 7 Table III rows` (rows from `docs/decision/newcombe-table3.json`) |
| T6 | 7 | R5.f, R5.g, R13.a | `src/core/calc.ts` | Cost ratio with 0 and infinity; 2,000 seeded paired resamples, both-zero redrawn; seed from the file's SHA-256 | T3: the ratio divides the two `cost_per_accepted` values T3 returns | `R5.f d06 q1 ratio 0.0125 and q2 0.01`, `R5.g both-zero resample is redrawn`, `R13.a same file gives identical interval twice` |
| T7 | 8 | R6.b | `examples/d08-verdicts/make.ts`, `examples/d08-verdicts/*.csv`, `examples/d08-verdicts/expected.md` | Synthetic 30-plus-case files, one per verdict branch, every count worked in `expected.md`; per-call costs $0.00002 Jev and $0.002 LLM so the cost bar holds in every resample and each branch turns on accept rate. Includes one file per rule-1 condition: no LLM rows, 29 paired cases, both 0 accepted, a paired row with no cost | the files: none. Its test calls `verdict()` from T8 | `R6.b each d08 rule-1 file gives not enough evidence naming its condition` (`src/core/verdict.test.ts`) |
| T8 | 8 | R6.a, R6.c to R6.g | `src/core/verdict.ts` | The four rules in order, first match wins; returns the rule, the condition, the numbers read, and `add_n` | T4, T5, T6: `verdict-rules.md:62-68` conditions read the Newcombe bounds and cost-ratio bounds those tasks compute | `R6.g d06 q1 add 25 and q2 add 26`, `R6.f no Jev rows is never don't use Jev`, one `R6.c`, `R6.d` and `R6.e` test per matching d08 file |
| T9 | 9 | R1, R6.h, R7.a, R7.b, R7.c, R8.a, R8.b, R11.b | `src/browser/view.ts`, `src/core/pipeline.ts`, `src/browser/main.ts`, `site/sample/uc11.csv`, `site/index.html`, `site/jnj.js` | First result view: the UC11 sample runs through `run()` and renders the answerer table, verdict, rule fired, numbers, gaps and the test-set-only line | T8: `run()` calls `verdict()`; `site/index.html:698-702` reads `J.verdict` from `data.js` and is rewired to the `run()` result | `R1.a` to `R1.e` one test each on the start copy (`src/browser/start.test.ts`), `R6.h view says the rule comparison is skipped for d06`, `R7.a view shows spend, accepted and cost per accepted per answerer`, `R7.b view names rule 1 and paired count 5 for d06 q1`, `R7.c view carries the test-set-only sentence`, `R8.a view lists line 25 as unlabelled`, `R8.b view shows rule spend incomplete` |
| T10 | 9 | R11.a, R17.c | `site/data.js`, `site/index.html`, `docs/product/user-stories.md` | Remove the router sample (`site/data.js:4-8`, picks at `site/index.html:599-604`); reword US-05 and US-06 to link verdict-rules | T9: `site/index.html:508` loads `data.js` until T9 gives the page the `run()` sample | `R17.c verdict wording agrees across stories, site and verdict-rules` (`src/docs/consistency.test.ts`: no Haiku / Sonnet / Opus pick outside lines marked historical; US-05 and US-06 name "undefined (0 accepted)" and link verdict-rules.md) |
| T11 | 10 | R3.a, R3.d, R3.e | `src/format/validate.ts`, `format/fixtures/*.csv` | One fixture per validator rule; gap handling; the validator wired into `run()` | T0: `src/format/validate.ts` is the #22 port | `R3.a one fixture per validator rule is rejected`, `R3.d missing cost and label are gaps and the file stays valid`, `R3.e d06 valid with gaps at lines 21 and 25` |
| T12 | 10 | R2.a, R2.c, R3.c, R7.d | `src/browser/main.ts`, `site/index.html` | Enable the drop zone (`site/index.html:489-497`); replace `takeFile` (`:716-724`) with a call to `run()`; an invalid file shows its first error and imports nothing | T9, T11: `main.ts` calls `run()`, which calls `validate()` | `R2.a file input accepts .csv and the drop zone is enabled` (`src/browser/static.test.ts`), `R2.c page makes no network call` (same file: no `fetch`, `XMLHttpRequest`, `sendBeacon` or `WebSocket` in the bundle outside the sample load), `R3.c invalid file returns only errors and no result` (`pipeline.test.ts`) |
| T13 | 11 | R14 | `src/browser/cases.ts`, `site/index.html` | Decision and answer set entry; add, edit, remove numbered cases; download a case list | T9: `main.ts` from T9 hosts the entry form | `R14.b cases renumber after a removal`, `R14.c case list downloads with 4 columns` |
| T14 | 12 | R4.c, R9, R10 | `src/browser/view.ts`, `site/index.html` | Decision-point selector; per-case rows with outputs, labels, win/loss/tie; rejected Jev answers first by confidence | T4: win and loss counts are b and c from `pairs.jev_llm` | `R4.c d06 shows two decision points`, `R9.c d06 q1 Jev losses equal c=1`, `R10.b cv4 q1 (0.62) listed first` |
| T15 | 13 | R6.a, R7.d | `src/core/pipeline.test.ts` | Happy path: d06 and each d08 file through `run()` give the verdicts in their `expected.md` | T8, T11: `run()` calls both | `R6.a every d08 file gives its expected verdict`, `R7.d numbers come from the file, not data.js` |
| T16 | 14 | R7.b, R8.c, R8.d | `src/browser/view.ts` | Every number links to its formula in `verdict-rules.md` and lists the rows behind it; "below minimum" and 3/n shown | T9: extends `view.ts` from T9 | `R8.c d06 marked below minimum with paired count`, `R8.d zero accepted shows upper bound 3/n` |
| T17 | 15 | R5.h | `scripts/hand-check.ts`, `scripts/hand-check.test.ts` | A second, independent calculation of every d06 number, written from `verdict-rules.md` without importing `src/core/`, compared with `expected.md` and with the CLI's `run()` output | T3 to T6: compares with their numbers through `run()` | `R5.h hand check reproduces d06 expected.md` |
| T18 | 16 | R12 | `src/core/pipeline.ts`, `format/fixtures/` | Empty, header-only, not-CSV, rule-only and second-load cases | T12: the load path is the one T12 wires | `R12.a empty file is a named error`, `R12.b rule-only file says no Jev results`, `R12.c second load replaces the first` |
| T19 | 17 | R13 | `src/core/pipeline.ts`, `site/index.html` | Save result: verdict, numbers, rules version, file SHA-256; same file gives a byte-identical saved result | T6: the seed comes from the hash T6 computes | `R13.b saved result is byte-identical across two loads` |
| T20 | 17 | R17.a, R17.b | `scripts/spec-check.ts`, `scripts/ci-check.sh` | List every criterion with its tests; report a test with no id; exit non-zero on an untested must criterion or 0 checked | T1: `scripts/ci-check.sh` from T1 calls spec-check | `R17.a spec-check reports a test with no criterion id`, `R17.b spec-check fails on an untested must criterion`, `R17.b spec-check fails on zero criteria` (`scripts/spec-check.test.ts`) |
| T21 | 18 | R16 | `site/index.html`, `README.md` | First-use guide in `FLOW.md` Journey order | T12: the guide ends at the load `main.ts` wires in T12 | `R16.b guide commands run on a clean clone` (`src/docs/guide.test.ts`) |
| T22 | later | R18 | `src/db/` (#22 port of PR 15, merged be5f849) | Export from Postgres loads in the browser with the same numbers | T0: `src/db/` exists only after #22; T15: compares with `run()` on the original file | `R18.a db export gives the same verdict` |
| T23 | later | R15 | `src/browser/label.ts`, `site/index.html` | Label on the page; download a valid file | T12: extends the load `main.ts` wires in T12 | `R15.b labelled download passes the validator` |
| T24 | later | R19 | per #11 | Generalised-question log | D1 at `spec.md:157` (hosting), which #11 lists as out of scope and separate | per #11 Done when |

## Coverage, per criterion
Counted per criterion, since a requirement with a task can still have criteria with no test. All 47 must criteria have a planned test whose name and body are about that criterion; 0 have a passing test today.

| Criteria | Task | Test file |
|---|---|---|
| R1.a to R1.e | T9 | `src/browser/start.test.ts` |
| R2.a, R2.c | T12 | `src/browser/static.test.ts` |
| R2.b, R2.d | T2 | `src/format/csv.test.ts` |
| R3.a, R3.d, R3.e | T11 | `src/format/validate.test.ts` |
| R3.b | T0 (done, #25) | Parity harness, removed after #25 (history at cd8397f) |
| R3.c | T12 | `src/core/pipeline.test.ts` |
| R4.a, R4.b, R4.d | T3 | `src/core/calc.test.ts` |
| R4.c | T14 | `src/browser/view.test.ts` |
| R5.a to R5.g | T3 to T6 | `src/core/calc.test.ts` |
| R5.h | T17 | `scripts/hand-check.test.ts` |
| R6.a | T15 | `src/core/pipeline.test.ts` |
| R6.b | T7 | `src/core/verdict.test.ts` |
| R6.c to R6.g | T8 | `src/core/verdict.test.ts` |
| R6.h, R7.a, R7.b, R7.c, R8.a, R8.b | T9 | `src/browser/view.test.ts` |
| R7.d | T15 | `src/core/pipeline.test.ts` |
| R8.c, R8.d | T16 | `src/browser/view.test.ts` |
| R12.a to R12.c | T18 | `src/core/pipeline.test.ts` |
| R13.a | T6 | `src/core/calc.test.ts` |
| R13.b | T19 | `src/core/pipeline.test.ts` |

Every task names its verifying test: 25 of 25.

## Test runner
`bun test` is the only runner: #25 (T0, for #22) replaced the earlier one, which collected `format` at 5e80a84 and `format db` after PR 15, and removed the original validator and loader. `.deploy/tests/` (3 shell tests) is run by no gate. The research scripts were removed (history at cd8397f); `docs/decision/newcombe-table3.json` holds the rows the T5 interval test will check. T1 fails on any tracked test file `bun test` did not collect.

Decision: the operator's decision recorded on #22 ([comment](https://github.com/breakoutwithai/jevnotjev/issues/22#issuecomment-5920877319): "we default to typescript", 2026-09-30) supersedes the "T17 test file and runner" row in the "Response to round 2" section of `pipeline-review.md`. The hand check (T17) is a TypeScript `bun test` in the gate; it stays independent because it is written from `verdict-rules.md` and does not import `src/core/`. The Newcombe reference values (Table III of Newcombe 1998) are the R5.e oracle, in `docs/decision/newcombe-table3.json`.
