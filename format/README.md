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

A value that is present but malformed (`about a cent`, confidence `1.5`, answer `maybe` when the set is `yes|no`) is an **error** and the file is rejected.

## Versioning
- The file format: `format_version` in every row. A renamed, removed or re-typed column ships as `jnj-record/2` with its own schema; `/1` files keep validating.
- The question: rewording a question under the same `prompt_version` is an error, so every answer can be traced to the exact wording that produced it.

## Sample data
Every message, answer, model, token count and price in `example-v1.csv` is invented. `example-llm` is not a real model. No real user data.
