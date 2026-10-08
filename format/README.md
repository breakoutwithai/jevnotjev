# Eval record format `jnj-record/1` with its minor versions 1.1 and 1.2

One CSV to test a question against Jev, a simple rule, an LLM, the OpenAI Decisions API or a person on the same cases, and keep the answers, your accept/reject labels and what each answer cost.

One row = one answerer's answer to one question about one test case.

| File | What |
|---|---|
| [record-v1.schema.json](record-v1.schema.json) | JSON Schema (draft 2020-12) for one row; an empty cell is read as null |
| [example-v1.csv](example-v1.csv) | Fictional sample: 3 messages, 1 question, 3 answerers; one missing label, one missing cost |
| [example-v1.2.csv](example-v1.2.csv) | Fictional `jnj-record/1.2` sample: 2 messages, 4 answerers including `decisions`; one refused and one error row, no labels yet |
| [src/format/validate.ts](../src/format/validate.ts) | Checks a file against the schema and the cross-row rules below; no Node APIs, so the browser can import it. Command line: [src/format/cli.ts](../src/format/cli.ts) |

```
bun install
bun run validate format/example-v1.csv
```
```
GAP line 9: unlabelled (m02, q1, llm)
GAP line 10: cost_usd missing (m03, q1, llm)
jev: rows=3 labelled=3 accepted=3 cost=$0.000005
llm: rows=3 labelled=2 accepted=2 cost=incomplete
rule: rows=3 labelled=3 accepted=2 cost=$0.000000
run run-001: rows=9 cost=incomplete
VALID rows=9 cases=3 errors=0 gaps=2
```

## Columns
These 18 are required in the header, any order; the optional columns below are `price_table_date`, the three label provenance columns, the two blind-loop columns and `outcome`. Any other unknown column is an error.

| Column | Holds | Rule |
|---|---|---|
| `format_version` | `jnj-record/1`, `jnj-record/1.1` or `jnj-record/1.2` | 1.1 adds label provenance ([below](#label-provenance-jnj-record11)); 1.2 adds `decisions` and `outcome` ([below](#answerer-decisions-and-outcomes-jnj-record12)) |
| `run_id` | e.g. `run-001` | groups one run |
| `prompt_version` | e.g. `refund-q.v1` | new wording = new version |
| `case_id` | e.g. `m01` | the test case |
| `case_input` | the text being judged | synthetic or redacted only; same text on every row for that case |
| `question_id` | e.g. `q1` | |
| `question` | the question asked | same text for the same `prompt_version` and `question_id` |
| `answer_set` | e.g. `yes\|no` | allowed answers, at least two, separated by `\|` |
| `answerer` | `jev` / `rule` / `llm` / `human`, and `decisions` in 1.2 | who answered |
| `answerer_model` | e.g. `jev-1.13.0`, a rule name, a model id | |
| `output` | the answer | must be one of `answer_set`; empty only on a 1.2 row whose `outcome` is not `answered` |
| `confidence` | 0 to 1, or empty | empty when the answerer gives none (a rule) |
| `label` | `accept` / `reject` / empty | the call on the answer |
| `label_source` | `human` / `human_reviewed` / `agent` / empty | empty exactly when `label` is empty; a `jnj-record/1` row allows `human` or empty only |
| `tokens_in`, `tokens_out` | integers or empty | from the answerer's usage fields |
| `cost_usd` | number or empty | 0 for a rule |
| `latency_ms` | integer or empty | wall clock |

## Missing cost or labels
An empty `cost_usd` or `label` keeps the file **valid** and is listed as a `GAP`.
- Accepted counts use labelled rows only, so an unlabelled answer is never counted as right or wrong.
- An `agent` label was never reviewed by a person, so it is never counted as truth: the row counts as unlabelled in the summary and the metrics, and is listed as `GAP line <n>: agent label not reviewed (<case_id>, <question_id>, <answerer>)`.
- An answerer with any missing cost shows `cost=incomplete` instead of a total that looks complete.
- A case (one `case_id` under one `run_id`, `prompt_version` and `question_id`) with no row for `llm`, `rule` or `jev` gets one `GAP case <case_id> (question <question_id>, run <run_id>, prompt <prompt_version>): no <method> result` per absent method. `human` rows establish a case but satisfy no method, so a case with only human rows gets all three gaps. A worked file with one absent row and one blank cost: [examples/d12-three-methods](../examples/d12-three-methods/README.md).

A value that is present but malformed (`about a cent`, confidence `1.5`, answer `maybe` when the set is `yes|no`) is an **error** and the file is rejected.

## Optional columns
| Column | Holds | Rule |
|---|---|---|
| `price_table_date` | `YYYY-MM-DD`, or empty | the date of the list-price table that produced `cost_usd` on that row (FLOW.md: "one dated list-price table"); leave it empty for a cost that is not from a price table, such as a rule's 0 |

A file without the column stays valid `jnj-record/1`: every file written before the column existed validates unchanged, and the example above has none. When the column is present, a value that is not a real-looking date (`Sept 2026`, `2026-13-01`) is an error. The validator checks the format only; it does not compare the date to anything. The database (`src/db/`) does not store the column, so a load followed by an export drops it (#42).

## Label provenance (`jnj-record/1.1`)
A label is only as good as where it came from. A `jnj-record/1.1` row says who made the call, how, when, and whether it was made blind.

| Column | Holds | Rule |
|---|---|---|
| `label_source` | `human`: a person picked it in the tool that wrote the file. `human_reviewed`: a person stands behind it but did not pick it in that tool (an AI draft a person approved, or a label imported into Backstage from a file that marked it `human`). `agent`: an AI made it and nobody reviewed it | `agent` is never counted as truth (above) |
| `labelled_by` | a handle: a person's handle (`operator`, `backstage-operator`) or an agent's model id | letters, digits and `_ . : + -`, 1 to 64; never an email address |
| `labelled_at` | a UTC time (`2026-10-07T09:30:00Z`, seconds and milliseconds optional) or a date (`2026-10-03`) when only the day is known | |
| `label_blind` | `true` / `false` | `true` only when the call was made before seeing any answerer's output or any suggestion for that case; always `false` for `human_reviewed` |

- On a labelled 1.1 row all four are required: an empty one is an error (`line <n>: labelled_by: None is not of type 'string'`), and a file without one of the columns is an error on every labelled 1.1 row (`line <n>: row: 'labelled_by' is a required property`).
- On an unlabelled 1.1 row all four are empty.
- A `jnj-record/1` row leaves the three new columns empty and its `label_source` is `human` or empty, so every /1 file validates unchanged. A /1 `human` label states no labeller, time or blindness.
- Backstage exports 1.1: a pick in the judging room is `human`, labelled by `backstage-operator` (the page does not know which signed-in operator is clicking), and blind, because the case is picked before any answer or suggestion for it is on the page ([below](#blind-and-final-picks-jnj-record11)).
- The database (`src/db/`) stores `jnj-record/1` only (`db/migrations/0001_records.sql:45`), so a 1.1 file does not load.

## Blind and final picks (`jnj-record/1.1`)
A labeller picks the right answer for a case blind, then sees Jev's options for that case ranked by Jev's probabilities, then keeps the pick or changes it. Both picks are kept. The blind pick stays the truth: a label Jev influenced cannot judge Jev.

| Column | Holds | Rule |
|---|---|---|
| `label` | the blind pick's call on this answer: `accept` when the answer equals the blind pick, else `reject` | the only label counted as truth, as before |
| `label_final` | `accept` / `reject` / empty: the final pick's call on this answer, made after the suggestion step | reported beside `label`, never instead of it; needs a `label`, `label_blind` `true` and `label_source` `human` |
| `suggestion_shown` | `true` / `false` / empty | `true` when Jev's ranked suggestion for the case was shown before the final pick, `false` when none was available; present exactly when `label_final` is |

- Both columns are optional: a file without them validates unchanged, and every summary, metric and verdict reads `label` only.
- A final pick without a blind pick is an error (`line <n>: label_final: 'accept' is not of type 'null'`), as is one without its flag (`line <n>: suggestion_shown: None is not of type 'string'`) or on a row whose `label_blind` is not `true` (`line <n>: label_blind: 'true' was expected`) or whose `label_source` is not `human` (`line <n>: label_source: 'human' was expected`).
- An unsure blind pick is no label: the case's rows stay unlabelled and carry no final pick.
- With no suggestion for the case, the final pick can only keep the blind pick, and `suggestion_shown` is `false`.
- Blind is a property of the page, not a lock: the suggestion files behind `/label/` are public, so a labeller who opens them first is no longer blind. The page reads one only after that case's pick.
- A Jev suggestion is never stored as a label. It comes from the run's own Jev answer for the case (0 calls); with none, only from one call on the labeller's own key; otherwise the case shows "No suggestion yet". Ranking and call rules: `src/labels/rank.ts`, `src/labels/suggest.ts`.
- `jnj-record/1` rows leave both columns empty.

## Answerer decisions and outcomes (`jnj-record/1.2`)
A run through the API can ask the OpenAI Decisions API as a fourth arm, and an answerer can decline to answer. A `jnj-record/1.2` row is a 1.1 row (the label provenance rules above apply unchanged) with two additions.

| Column | Holds | Rule |
|---|---|---|
| `answerer` | also `decisions`: the OpenAI Decisions API | 1.2 only |
| `outcome` | `answered` / `refused` / `unsupported` / `error` / empty | optional column; empty or absent means `answered`. `refused`: the answerer declined. `unsupported`: the answerer cannot take this input (an image sent to an arm that reads text only). `error`: the call failed |

- A row whose `outcome` is `refused`, `unsupported` or `error` has an empty `output` and an empty `label`: there is no answer to judge, so it is never counted as right or wrong. A filled one is an error (`line <n>: output: 'yes' is not of type 'null'`, `line <n>: label: 'reject' is not of type 'null'`). It still counts in `rows` and in cost, and it is not listed as an `unlabelled` gap.
- An answered row (outcome `answered` or empty) needs an `output` in `answer_set`, as before: an empty one is `line <n>: output: None is not of type 'string'`.
- An unknown outcome is `line <n>: outcome: 'skipped' is not one of ['answered', 'refused', 'unsupported', 'error', None]`.
- A `jnj-record/1` or `jnj-record/1.1` row cannot name `decisions` (`line <n>: answerer: 'decisions' is not one of ['jev', 'rule', 'llm', 'human']`) and leaves `outcome` empty: the header may carry the column, as it may the 1.1 columns, but a filled cell is `line <n>: outcome: 'answered' is not of type 'null'`. Every /1 and /1.1 file validates unchanged.
- `decisions` is not one of the three methods every case is compared on (llm, rule, jev), so a case without it gets no gap. The verdict and metrics (`src/core/`) read llm, rule and jev only.
- The case table shows a row with no answer by its outcome: `refused, $0.000006, unlabelled`.
- The database (`src/db/`) stores `jnj-record/1` only, so a 1.2 file does not load.

## Versioning
- The file format: `format_version` in every row. A renamed, removed or re-typed column ships as `jnj-record/2` with its own schema; `/1` files keep validating. `jnj-record/1.1` and `jnj-record/1.2` only add optional columns, label sources, an answerer and an outcome, so the same schema and validator read all three.
- The question: rewording a question under the same `prompt_version` is an error, so every answer can be traced to the exact wording that produced it.

## Message contract
Validator and loader output is part of the format: scripts and people match on it, so a change to any rule below is a change to the format's output. Code: [src/format/quote.ts](../src/format/quote.ts), [validate.ts](../src/format/validate.ts), [schema.ts](../src/format/schema.ts). Tests: `src/format/*.test.ts`, `src/db/tests/`.

### Output lines and exit codes
- Order: every `ERROR <message>`, then every `GAP <message>`, then (only when there are no errors) one summary line per answerer, then one total line per run, then the verdict line.
- Summary: `<answerer>: rows=<n> labelled=<n> accepted=<n> cost=<total>`, answerers sorted by code point. `<total>` is `$` plus the sum to six decimal places (`$0.000005`), or `incomplete` when any row of that answerer has no cost.
- Run total: `run <run_id>: rows=<n> cost=<total>`, runs sorted by code point. The total adds every answerer's `cost_usd` in that run, in the same form as above (`incomplete` when any row of the run has no cost). Only the command line prints it; the browser loader shows the answerer lines.
- Verdict: `VALID rows=<n> cases=<n> errors=<n> gaps=<n>`, or `INVALID ...` with the same fields.
- Exit codes: 0 valid (gaps allowed), 1 invalid or unreadable, 2 wrong command line or, for the db commands, `JNJ_DATABASE_URL` not set. The validator prints its usage text to stdout on exit 2; the db commands print the usage line and `error: <message>` to stderr, or `set JNJ_DATABASE_URL to a libpq connection string` to stderr when the variable is missing.
- A file that is not strict UTF-8: `ERROR cannot read <path> in UTF-8: <reason>` on stderr, exit 1. Every other `ERROR`, `GAP`, summary and verdict line goes to stdout. A byte order mark is kept as text, so it shows up in the first header name.

### Where a message points
- `line <n>` is the physical line, counting the header as line 1, on which the record ends. A quoted line break inside a cell moves it on; blank lines are skipped but still counted.
- Header problems stop the check before any row is read: `header: duplicate column names [...]`, `header: missing columns [...]`, `header: unknown columns [...]`.
- `line <n>: row has more cells than the header` / `fewer cells`. Every row's cell count is reported, but any such error stops the check before schema and cross-row checks run. `file has no data rows`.
- A schema error: `line <n>: <column>: <message>`, or `line <n>: row: <message>` for a whole-row rule. A row's schema errors come in schema order (keywords in document order, depth first); a row with any schema error gets no cross-row checks.
- Cross-row errors: `line <n>: output <value> is not in answer_set <value>`, `line <n>: duplicate row for run <run_id> (<case_id>, <question_id>, <answerer>)`, `line <n>: case_input differs from the first row for case_id <case_id>`, `line <n>: question <question_id> changed within prompt_version <prompt_version>; give the new wording a new prompt_version`, `line <n>: labelled_at: <value> is not a calendar date` (1.1: the pattern admits `2026-02-31`, this check does not), `line <n>: <labelled_by|labelled_at|label_blind>: <value> ends with a line break` (the pattern's `$` would admit it).
- Gaps: `line <n>: cost_usd missing (<case_id>, <question_id>, <answerer>)`, `line <n>: unlabelled (...)`, `line <n>: agent label not reviewed (...)`.
- Loader (values the validator accepts but the database cannot store): `line <n>: <column>: <value> ends with a line break` for a pattern-checked text column, `line <n>: <column>: contains a NUL character, which the database cannot store`, `line <n>: confidence: <text> is above 1`, plus integer and decimal range messages; and `workspace <value> must match [a-z0-9-]{1,64}`. A database error prints as `ERROR database error <SQLSTATE>`, never with the connection string or a cell.

### Schema messages
`<value> is not of type 'string', 'null'` · `<value> is not one of [...]` · `<value> was expected` · `<text> does not match <pattern>` · `<text> should be non-empty` (minLength 1) / `is too short` · `<text> is expected to be empty` (maxLength 0) / `is too long` · `<number> is less than the minimum of <bound>` · `<number> is greater than the maximum of <bound>` · `<name> is a required property` · `Additional properties are not allowed (<names> was|were unexpected)` with names sorted · `False schema does not allow <value>`. A whole row in a message prints as `{...}`.

### How a value prints
- Text is quoted: single quotes, or double quotes when the text holds `'` and no `"` (`"it's"`). The chosen quote and `\` are escaped with `\`; tab, newline and carriage return print as `\t`, `\n`, `\r`; other control and non-printable characters (format, private-use, unassigned, line/paragraph separators, any space but U+0020) print as `\xNN` up to U+00FF, `\uNNNN` up to U+FFFF, else `\UNNNNNNNN`. Everything else, including accented letters and emoji, prints as itself.
- An empty cell is null and prints as `None`.
- An integer cell (`tokens_in`, `tokens_out`, `latency_ms`) prints bare: `42`.
- A number cell (`confidence`, `cost_usd`) is a float: the shortest digits that read back to the same value, always with a point (`1.0`, `0.0001`). Below `1e-4` or from `1e16` up it prints in exponent form with a sign and at least two exponent digits (`1e-05`, `1e+16`, `1.5e+300`). Negative zero is `-0.0`.
- A schema bound prints bare when it is a whole number (`minimum of 0`, not `0.0`).
- A list prints as `[a, b]` with each item formatted as above: `['label']`.
- Numbers compare exactly: `1` equals `1.0`, and a large integer is never rounded to a float before comparing.
- A pattern matches anywhere in the text; an unescaped `$` outside a character class also matches just before a final line break. An integer or number cell may likewise end in one line break, which is trimmed before parsing.
- Text length counts code points, not UTF-16 units.

### CSV
- Comma-separated, `"` quotes a field, `""` is a quote inside a quoted field. A line ends at `\n`, `\r\n` or a lone `\r`.
- A stray quote is kept as text, not rejected: `a"b"` reads as `a"b"`, `"ab"cd` as `abcd`; an unterminated quoted field runs to the end of the file.
- Writing quotes a field only when it holds `,`, `"`, `\r` or `\n`; a row that is one empty field is written `""`.

### Size limit on the public page
The page's "Load your own script (CSV)" refuses a file over 5 MB (`MAX_FILE_BYTES` in [src/browser/results-loader.ts](../src/browser/results-loader.ts)), checked before the file is read, with a message naming its size and the limit. Larger files: `bun run validate <file>`.

## Sample data
Every message, answer, model, token count and price in `example-v1.csv` is invented. `example-llm` is not a real model. No real user data.
