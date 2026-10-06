# Eval record format `jnj-record/1`

One CSV to test a question against Jev, a simple rule, an LLM or a person on the same cases, and keep the answers, your accept/reject labels and what each answer cost.

One row = one answerer's answer to one question about one test case.

| File | What |
|---|---|
| [record-v1.schema.json](record-v1.schema.json) | JSON Schema (draft 2020-12) for one row; an empty cell is read as null |
| [example-v1.csv](example-v1.csv) | Fictional sample: 3 messages, 1 question, 3 answerers; one missing label, one missing cost |
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
VALID rows=9 cases=3 errors=0 gaps=2
```

## Columns
All 18 are required in the header, any order. Unknown columns are an error.

| Column | Holds | Rule |
|---|---|---|
| `format_version` | `jnj-record/1` | fixed |
| `run_id` | e.g. `run-001` | groups one run |
| `prompt_version` | e.g. `refund-q.v1` | new wording = new version |
| `case_id` | e.g. `m01` | the test case |
| `case_input` | the text being judged | synthetic or redacted only; same text on every row for that case |
| `question_id` | e.g. `q1` | |
| `question` | the question asked | same text for the same `prompt_version` and `question_id` |
| `answer_set` | e.g. `yes\|no` | allowed answers, at least two, separated by `\|` |
| `answerer` | `jev` / `rule` / `llm` / `human` | who answered |
| `answerer_model` | e.g. `jev-1.13.0`, a rule name, a model id | |
| `output` | the answer | must be one of `answer_set` |
| `confidence` | 0 to 1, or empty | empty when the answerer gives none (a rule) |
| `label` | `accept` / `reject` / empty | a person's call on the answer |
| `label_source` | `human` / empty | empty exactly when `label` is empty |
| `tokens_in`, `tokens_out` | integers or empty | from the answerer's usage fields |
| `cost_usd` | number or empty | 0 for a rule |
| `latency_ms` | integer or empty | wall clock |

## Missing cost or labels
An empty `cost_usd` or `label` keeps the file **valid** and is listed as a `GAP`.
- Accepted counts use labelled rows only, so an unlabelled answer is never counted as right or wrong.
- An answerer with any missing cost shows `cost=incomplete` instead of a total that looks complete.
- A case (one `case_id` under one `run_id`, `prompt_version` and `question_id`) with no row for `llm`, `rule` or `jev` gets one `GAP case <case_id> (question <question_id>, run <run_id>, prompt <prompt_version>): no <method> result` per absent method. `human` rows establish a case but satisfy no method, so a case with only human rows gets all three gaps. A worked file with one absent row and one blank cost: [examples/d12-three-methods](../examples/d12-three-methods/README.md).

A value that is present but malformed (`about a cent`, confidence `1.5`, answer `maybe` when the set is `yes|no`) is an **error** and the file is rejected.

## Versioning
- The file format: `format_version` in every row. A renamed, removed or re-typed column ships as `jnj-record/2` with its own schema; `/1` files keep validating.
- The question: rewording a question under the same `prompt_version` is an error, so every answer can be traced to the exact wording that produced it.

## Message contract
Validator and loader output is part of the format: scripts and people match on it, so a change to any rule below is a change to the format's output. Code: [src/format/quote.ts](../src/format/quote.ts), [validate.ts](../src/format/validate.ts), [schema.ts](../src/format/schema.ts). Tests: `src/format/*.test.ts`, `src/db/tests/`.

### Output lines and exit codes
- Order: every `ERROR <message>`, then every `GAP <message>`, then (only when there are no errors) one summary line per answerer, then the verdict line.
- Summary: `<answerer>: rows=<n> labelled=<n> accepted=<n> cost=<total>`, answerers sorted by code point. `<total>` is `$` plus the sum to six decimal places (`$0.000005`), or `incomplete` when any row of that answerer has no cost.
- Verdict: `VALID rows=<n> cases=<n> errors=<n> gaps=<n>`, or `INVALID ...` with the same fields.
- Exit codes: 0 valid (gaps allowed), 1 invalid or unreadable, 2 wrong command line or, for the db commands, `JNJ_DATABASE_URL` not set. The validator prints its usage text to stdout on exit 2; the db commands print the usage line and `error: <message>` to stderr, or `set JNJ_DATABASE_URL to a libpq connection string` to stderr when the variable is missing.
- A file that is not strict UTF-8: `ERROR cannot read <path> in UTF-8: <reason>` on stderr, exit 1. Every other `ERROR`, `GAP`, summary and verdict line goes to stdout. A byte order mark is kept as text, so it shows up in the first header name.

### Where a message points
- `line <n>` is the physical line, counting the header as line 1, on which the record ends. A quoted line break inside a cell moves it on; blank lines are skipped but still counted.
- Header problems stop the check before any row is read: `header: duplicate column names [...]`, `header: missing columns [...]`, `header: unknown columns [...]`.
- `line <n>: row has more cells than the header` / `fewer cells`. Every row's cell count is reported, but any such error stops the check before schema and cross-row checks run. `file has no data rows`.
- A schema error: `line <n>: <column>: <message>`, or `line <n>: row: <message>` for a whole-row rule. A row's schema errors come in schema order (keywords in document order, depth first); a row with any schema error gets no cross-row checks.
- Cross-row errors: `line <n>: output <value> is not in answer_set <value>`, `line <n>: duplicate row for run <run_id> (<case_id>, <question_id>, <answerer>)`, `line <n>: case_input differs from the first row for case_id <case_id>`, `line <n>: question <question_id> changed within prompt_version <prompt_version>; give the new wording a new prompt_version`.
- Gaps: `line <n>: cost_usd missing (<case_id>, <question_id>, <answerer>)`, `line <n>: unlabelled (...)`.
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

## Sample data
Every message, answer, model, token count and price in `example-v1.csv` is invented. `example-llm` is not a real model. No real user data.
