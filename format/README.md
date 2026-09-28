# Results format `tokenmax-results/1`

The one file TokenMax reads: a CSV with one row per test case per arm. You fill it outside the tool (a runner script or by hand), then load it into the page.

| File | What |
|---|---|
| [results-v1.schema.json](results-v1.schema.json) | JSON Schema (draft 2020-12) for one row, after an empty cell is read as null |
| [example-v1.csv](example-v1.csv) | Sample: 4 fictional coding prompts x 3 arms, with one missing cost and one missing label |
| [validate.py](validate.py) | Checks a file against the schema plus the cross-row rules below |

```
pip install -r requirements.txt
python3 format/validate.py format/example-v1.csv
```
```
GAP line 8: unlabelled (c03, arm B)
GAP line 13: model_cost_usd missing (c04, arm C)
VALID rows=12 cases=4 errors=0 gaps=2
```

## Columns
Every column is required in the header, in any order. Unknown columns are an error.

| Column | Type | Rule |
|---|---|---|
| `format_version` | text | always `tokenmax-results/1` |
| `case_id` | text | letters, digits, `_`, `-`; up to 64 |
| `case_input` | text | the test case; synthetic or redacted only; same text on every arm's row |
| `arm` | `A` / `B` / `C` | A what you do now, B a simple rule, C Jev decides |
| `picker` | text | what chose the model, e.g. `current:always-sonnet`, `rule:len<60`, `jev` |
| `picker_tokens_in` | integer or empty | Jev input tokens; 0 for A and B |
| `picker_cost_usd` | number or empty | Jev: input tokens x $0.042 per million; 0 for A and B |
| `picked_model` | text | model that produced the output (arm A's model on a fallback) |
| `model_tokens_in`, `model_tokens_out` | integer or empty | from the provider's `usage` fields |
| `model_cost_usd` | number or empty | tokens x the dated price table |
| `output` | text | the model's answer, as labelled |
| `jev_answer` | text | arm C only, empty on A and B |
| `jev_confidence` | 0 to 1 | arm C only, empty on A and B |
| `fallback` | `true` / `false` | arm C only: confidence was under the cutoff, so arm A's model ran |
| `label` | `accept` / `reject` / empty | a person's call on the output |
| `label_source` | `human` / `pregrade_confirmed` / empty | empty exactly when `label` is empty |
| `price_table_date` | `YYYY-MM-DD` or empty | required whenever `model_cost_usd` is filled |

## Cross-row rules
- One row per `case_id` and `arm`.
- `case_input` is identical across a case's rows.
- At least one data row.

## Missing cost or labels
An empty cost or label keeps the file **valid** and is listed as a `GAP`. Any gap makes the verdict "not enough evidence" ([FLOW.md](../FLOW.md), verdict rule 1), so a half-filled file still loads and shows what is missing instead of guessing. A value that is present but malformed (`about a cent`, confidence `1.5`, arm `D`) is an **error** and the file is rejected.

## Versioning
The version lives in every row. A breaking change (a renamed, removed or re-typed column) ships as `tokenmax-results/2` with its own schema file; `/1` files keep validating against `results-v1.schema.json`.

## Sample data
Every case, output, model call and price in `example-v1.csv` is invented for this example; the price table dated 2026-09-01 is fictional. No real user data.
