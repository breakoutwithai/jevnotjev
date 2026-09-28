# TokenMax result format, v0.1

Two CSV files describe one comparison: the test cases, and one result row per case per arm per run. Every row carries its format version, so a file can be checked on its own.

| File | Version string | Schema | Example |
|---|---|---|---|
| Test cases | `tokenmax-cases/0.1` | [v0.1/cases.schema.json](v0.1/cases.schema.json) | [v0.1/example/cases.csv](v0.1/example/cases.csv) |
| Results | `tokenmax-results/0.1` | [v0.1/results.schema.json](v0.1/results.schema.json) | [v0.1/example/results.csv](v0.1/example/results.csv) |

All example data is fictional: made-up prompts, placeholder model names (`model-small`, `model-large`) and made-up costs. No real user data.

## Check a file

```bash
pip install jsonschema
python3 scripts/validate_results.py format/v0.1/example/cases.csv format/v0.1/example/results.csv
```

The last line is `VERDICT format OK cases=3 rows=9 errors=0 warnings=2`. Exit code 0 means the files are valid; 1 means at least one error.

## Test cases file

| Column | Type | Meaning |
|---|---|---|
| `format` | `tokenmax-cases/0.1` | version |
| `case_id` | lowercase id, e.g. `c01` | unique per file |
| `decision` | text | the decision point under test, same wording for every case |
| `input` | text | what the workflow receives; fictional or redacted |
| `note` | text, optional | anything else |

Write the cases and the simple rule before seeing any result.

## Results file

One row per run, case and arm. `arm` is `now` (what you do now), `rule` (a simple rule) or `jev` (Jev decides), as in [FLOW.md](../FLOW.md).

| Column | Type | Meaning |
|---|---|---|
| `format` | `tokenmax-results/0.1` | version |
| `run_id` | lowercase id | groups one run; per-run cost is the sum over its rows |
| `case_id` | id from the cases file | |
| `arm` | `now` / `rule` / `jev` | |
| `picker` | text | what chose the model: your model, the rule text, or the Jev model id |
| `picker_tokens_in`, `picker_cost_usd` | integer, USD | cost of choosing; 0 for `now` and `rule` |
| `picked_model` | text | the model that answered |
| `output` | text | that model's answer |
| `model_tokens_in`, `model_tokens_out`, `model_cost_usd` | integer, integer, USD | cost of answering |
| `jev_answer`, `jev_confidence` | text, 0 to 1 | required on `jev` rows, empty on the others |
| `fallback` | `true` / `false` | `true` when Jev's confidence was under the cutoff and the case went to arm `now`'s model; always `false` off the `jev` arm |
| `label` | `accept` / `reject` / empty | your judgement of `output` |
| `label_source` | `human` / `grader` / empty | who labelled it; required when `label` is set |
| `price_table_date` | `YYYY-MM-DD` | date of the price list the costs came from |

Spend per row = `picker_cost_usd` + `model_cost_usd`.

## Missing costs and labels

An empty cell is null. A missing cost or a missing label is allowed, because real runs have gaps, but it can never produce a verdict:

| Gap | Validator | Verdict |
|---|---|---|
| empty `picker_cost_usd` or `model_cost_usd` | `WARN <run>/<case>/<arm>: cost missing (<column>)`; that arm's spend is marked incomplete | not enough evidence |
| empty `label` on a row with output | `WARN <run>/<case>/<arm>: unlabelled` | not enough evidence |
| fewer than 10 fully labelled cases, or no `jev` rows | reported on the `READY` line | not enough evidence |

Anything else wrong (unknown arm, a Jev answer on a non-Jev row, a confidence above 1, a negative cost, a case not in the cases file, a duplicate row, a missing column, the wrong version) is an error.

## Versioning

The version is in every row. A change that adds an optional column is `0.2`; a change that renames or removes a column, or changes a meaning, is `1.0`. Each version keeps its own folder (`format/v0.1/`), so old files stay checkable.
