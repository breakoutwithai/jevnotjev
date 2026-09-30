# Jev!Jev plan (v1)

Architecture for the requirements in [spec.md](spec.md) (#17). Tasks: [tasks.md](tasks.md). Language and runner follow #22: TypeScript on Bun.

## Shape
One TypeScript core under `src/` holds validation, calculations and the verdict. The browser and the command line both use it. The page is static and has no server; a `bun build` step bundles the core into `site/jnj.js`, which `site/index.html` loads with one `<script>` tag. The bundle is committed, and the gate rebuilds it and fails on any difference, because the deploy (`docs/DEPLOY.md`) serves `site/` as it is and builds nothing.

`format/validate.py` is the reference only until #22's parity check passes: the TypeScript validator must give the same VALID or INVALID, errors and gaps on every fixture, then the Python validator and its tests are removed (#22 steps 5 and 6). After that the fixture tests in `src/format/` are the reference.

## Data flow
```
file (picker or drop)                         R2.a
  -> parseCsv(text)             -> rows[]      R2.b, R2.d
  -> validate(rows)             -> {errors, gaps, records}   R3
       errors -> error view, nothing imported  R3.c, R12.a
  -> group(records)             -> decision points by (prompt_version, question_id)   R4
  -> calc(point)                -> per answerer totals, pairs by case_id, a/b/c/d, intervals, cost ratio   R5
  -> verdict(calc, rules)       -> {verdict, rule, conditions, numbers, add_n}   R6
  -> view(result)               -> HTML strings   R7, R8, R9, R10
  -> page wires the strings into the DOM   site/index.html
```

A decision point is one (`prompt_version`, `question_id`): `format/validate.py:87-90` lets a new `prompt_version` carry a different question and `answer_set`, so two versions are two decision points. Inside one decision point, cases pair by `case_id` for that `question_id`, as `verdict-rules.md:17` defines; the two agree.

Optional path through PR 15 (merged be5f849, `db/`; ported to `src/db/` by #22):
```
CSV -> load -> Postgres (schema jnj) -> export -> CSV -> the browser path above   R18
```
The browser never talks to the database. The exported CSV is an ordinary `jnj-record/1` file.

## Modules
| File | Owns | Used by | Tested by |
|---|---|---|---|
| `src/core/csv.ts` | CSV text to arrays of cells: quotes, doubled quotes, CRLF and LF, line numbers kept | browser, CLI | `src/core/csv.test.ts` |
| `src/format/validate.ts` | #22 step 2: header, schema per row (`format/record-v1.schema.json`), cross-row rules, gaps, same messages as `format/validate.py:24-95` | browser, CLI | `src/format/validate.test.ts`, `src/format/parity.test.ts` (until the Python file is removed) |
| `src/core/calc.ts` | grouping, per-answerer totals, pairing, a/b/c/d, Wilson, Newcombe method 10, cost ratio, seeded resampling | browser, CLI | `src/core/calc.test.ts` |
| `src/core/verdict.ts` | the four rules of `verdict-rules.md:53-69` and the edge cases at `:73-84`; returns the rule that fired and the numbers it read | browser, CLI | `src/core/verdict.test.ts` |
| `src/core/pipeline.ts` | `run(text) -> result[]`: csv, validate, group, calc, verdict in one call | browser, CLI | `src/core/pipeline.test.ts` |
| `src/browser/view.ts` | result objects to escaped HTML strings: answerer table, verdict block, gaps, per-case rows | browser | `src/browser/view.test.ts` |
| `src/browser/main.ts` | bundle entry: file input, drop zone, rendering the view strings | browser | by hand, screenshots (D4) |
| `src/cli/validate.ts` | command-line validator replacing `format/validate.py` | CLI | `src/format/validate.test.ts` |
| `site/jnj.js` | built bundle, committed | page | gate rebuild check |
| `site/data.js` | the router sample, removed; a UC11 CSV runs through `run()` instead (R11) | | |

Strict `tsconfig.json`, named exports, no `any` and no `as` casts (#22 step 1).

## Result object
One per decision point, the only thing `view.ts` reads:
```
{ point: {prompt_version, question_id, question, answer_set},
  answerers: {jev|rule|llm|human: {rows, labelled, accepted, spend | "incomplete", cost_per_accepted | "undefined", unlabelled_lines[], missing_cost_lines[]}},
  pairs: {jev_llm: {n, a, b, c, d, p1, p2, diff, lower, upper}, rule_jev: {... or skipped: reason}},
  cost_ratio: {value, lower, upper, seed} | {incomplete: lines[]},
  verdict: {word, rule: 1..4, condition, add_n, numbers{}},
  cases: [{case_id, outputs{}, labels{}, jev_vs{llm, rule}: win|loss|tie, jev_confidence}] }
```
`question` and `answer_set` are single values because a decision point is one `prompt_version`.

## Reproducibility
The resampling uses a small seeded generator (mulberry32) whose seed is the first 32 bits of the SHA-256 of the file text (`crypto.subtle.digest` in the browser and in Bun). Same file, same seed, same numbers (R13.a). The saved result names the verdict-rules version and the file hash (R13.b).

## Tests and the gate
- `scripts/ci-check.sh` runs `bun test` and `pytest docs/decision` (the research scripts stay Python per #22 step 6), rebuilds `site/jnj.js` and fails on a diff, prints the head SHA and both counts, and fails when either run fails, either count is 0, or a tracked test file was not collected (R17.d).
- Today `pytest.ini` collects `format` and `db` (PR 15), and `.deploy/tests/` is run by no gate. After #22, `pytest.ini` names only `docs/decision`.
- Oracles: `examples/d06-tiny/expected.md` for days 7 and 8; `docs/decision/newcombe_check.py:12-15` for the interval; a 30-plus-case fixture set for the verdict paths d06 cannot reach (`expected.md:91-92`).
- Parity (R3.b): while `format/validate.py` exists, `src/format/parity.test.ts` runs it and `src/cli/validate.ts` over `format/fixtures/*.csv` and compares VALID or INVALID and the error and gap counts. Its passing output is quoted on the #22 PR before the Python file goes.
- Traceability: `scripts/spec-check.ts` reads the criterion ids in `spec.md`, maps them to test names, and reports untested criteria (#18, #19).

## What does not change
- The schema and the format; a format change is `jnj-record/2`.
- No key, token or model call in the page. Secrets route front end to back end to vendor; v1 has no back end, so it has no secrets.
- Deploy serves `site/` as static files (`docs/DEPLOY.md`).
