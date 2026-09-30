# Jev!Jev plan (v1)

Architecture for the requirements in [spec.md](spec.md) (#17). Tasks: [tasks.md](tasks.md).

## Shape
A static page with no build step and no server. Everything that turns a file into a verdict runs in the browser, in small plain-JavaScript modules that also load in Node for tests. The Python validator stays the reference for the format; the browser validator is a port that must agree with it on a shared fixture set.

## Data flow
```
file (picker or drop)                         R2.a
  -> csv.parse(text)            -> rows[]      R2.b, R2.d
  -> validate(rows)             -> {errors, gaps, records}   R3
       errors -> error view, nothing imported  R3.c, R12.a
  -> group(records)             -> decision points by (prompt_version, question_id)   R4
  -> calc(point)                -> per answerer totals, pairs, a/b/c/d, intervals, cost ratio   R5
  -> verdict(calc, rules)       -> {verdict, rule, conditions, numbers, add_n}   R6
  -> view(result)               -> HTML strings   R7, R8, R9, R10
  -> page wires the strings into the DOM   site/index.html
```

Optional path, pending PR 15 (not merged, `db/` on branch `feat/db-records`):
```
CSV -> db/load.py -> Postgres (schema jnj) -> db/export.py -> CSV -> the browser path above   R18
```
The browser never talks to the database. The exported CSV is an ordinary `jnj-record/1` file.

## Modules
| File | Owns | Pure | Tested by |
|---|---|---|---|
| `site/jnj/csv.js` | CSV text to arrays of cells: quotes, doubled quotes, CRLF and LF, line numbers kept | yes | `site/jnj/test/csv.test.mjs` |
| `site/jnj/validate.js` | port of `format/validate.py:24-95`: header, schema per row (from `format/record-v1.schema.json`), cross-row rules, gaps | yes | `site/jnj/test/validate.test.mjs`, `format/test_parity.py` |
| `site/jnj/calc.js` | grouping, per-answerer totals, pairing, a/b/c/d, Wilson, Newcombe method 10, cost ratio, seeded resampling | yes | `site/jnj/test/calc.test.mjs` |
| `site/jnj/verdict.js` | the four rules of `verdict-rules.md:53-69` and the edge cases at `:73-84`; returns the rule that fired and the numbers it read | yes | `site/jnj/test/verdict.test.mjs` |
| `site/jnj/view.js` | result objects to escaped HTML strings: answerer table, verdict block, gaps, per-case rows | yes | `site/jnj/test/view.test.mjs` |
| `site/jnj/pipeline.js` | `run(text) -> result`: csv, validate, group, calc, verdict in one call | yes | `site/jnj/test/pipeline.test.mjs` |
| `site/index.html` | DOM wiring only: file input, drop zone, rendering the view strings | no | by hand, screenshots (D4) |
| `site/data.js` | the sample. Replaced by a UC11 CSV run through `pipeline.js` (R11) | | |
| `format/validate.py` | reference validator, unchanged | | `format/test_validate.py` (22 tests) |

Each module is one file of the form `(function (root) { ... if (typeof module === "object") module.exports = api; else root.JNJ_<NAME> = api; })(this);` so `index.html` loads it with a `<script>` tag and Node tests `require` it. No npm packages; Node's built-in `node:test` runs the tests (Node on the build machine: v26.7.0).

## Result object
One per decision point, the only thing `view.js` reads:
```
{ point: {prompt_version, question_id, question, answer_set},
  answerers: {jev|rule|llm|human: {rows, labelled, accepted, spend | "incomplete", cost_per_accepted | "undefined", unlabelled_lines[], missing_cost_lines[]}},
  pairs: {jev_llm: {n, a, b, c, d, p1, p2, diff, lower, upper}, rule_jev: {... or skipped: reason}},
  cost_ratio: {value, lower, upper, seed} | {incomplete: lines[]},
  verdict: {word, rule: 1..4, condition, add_n, numbers{}},
  cases: [{case_id, outputs{}, labels{}, jev_vs{llm, rule}: win|loss|tie, jev_confidence}] }
```

## Reproducibility
The resampling uses a small seeded generator (mulberry32) whose seed is the first 32 bits of the SHA-256 of the file text (`crypto.subtle.digest` in the browser, `node:crypto` in tests). Same file, same seed, same numbers (R13.a). The saved result names the verdict-rules version and the file hash (R13.b).

## Tests and the gate
- `scripts/ci-check.sh` runs `pytest` and `node --test site/jnj/test/`, prints both counts, and exits non-zero when either fails or either count is 0.
- `pytest.ini` `testpaths` gains each Python test folder as it lands (`db` when PR 15 merges).
- Oracles: `examples/d06-tiny/expected.md` for days 7 and 8; `docs/decision/newcombe_check.py:12-15` for the interval; a 30-plus-case fixture set for the verdict paths d06 cannot reach (`expected.md:91-92`).
- Parity: `format/test_parity.py` runs `format/validate.py` and `node site/jnj/validate.js <file>` over `format/fixtures/*.csv` and compares VALID or INVALID and the error and gap counts.
- Traceability: `scripts/spec-check.py` reads the criterion ids here and in `spec.md`, maps them to test names, and reports untested criteria (#18, #19).

## What does not change
- `format/validate.py`, the schema and the format stay as they are; a format change is `jnj-record/2`.
- No key, token or model call in the page. Secrets route front end to back end to vendor; v1 has no back end, so it has no secrets.
- Deploy is unchanged: `site/` is served as static files (`docs/DEPLOY.md`).
