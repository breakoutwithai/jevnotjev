# Jev!Jev decide API

Ask one typed question (yes/no, pick one of N, or a score level) about a set of text cases, of up to four arms: Jev, the OpenAI Decisions API, an LLM and a keyword rule. Every answer comes back as a `jnj-record/1.2` row with its outcome, cost and pins. The run is priced before anything is spent, and once a person has labelled the rows the verdict comes back with a CI exit code.

The same six tools are reached three ways: the command line (`src/decide/cli.ts`, this page), a stdio MCP server (added in M4) and HTTP under `/api/v1` (added in M5). The core is `src/decide/`; every surface is a thin wrapper over it.

## Contract (v1)

```
QuestionSpec = { name, type: "noul", instructions, criteria? }
             | { name, type: "choice", instructions, choices: [{ name, definition }] }      2 to 10 choices
             | { name, type: "score", instructions, levels: [{ label, description }] }      2 to 10 levels, low to high
Case       = { id, input: string }                                                          text only in v1
Arms       = { jev?: boolean = true, decisions?: boolean = false, llm?: string | false = "claude-haiku-5-5",
               rule?: { keywords: string[], match: string, otherwise: string } | false = false }
RunOptions = { dryRun?: boolean, budgetUsd?: number, runId?: string = "run-001", promptVersion?: string = "decide.v1" }
```

- `name` and case `id` match `[A-Za-z0-9_-]{1,64}`; `runId` and `promptVersion` match `[A-Za-z0-9_.-]{1,64}`.
- A non-text case input (an object with a `type`, or a base64 data URI) is not sent anywhere: every arm returns outcome `unsupported` for it.
- Several questions on one case go in one provider request for `jev` and `decisions`, so the input is paid once; the call's cost is split evenly over its rows (`evidence.shared_by`).
- Model ids are pinned. An unknown or floating id (`claude-haiku-latest`) is rejected with the list of accepted ids.

### Answer rows

One `jnj-record/1.2` row per (case, question, arm), in the column order of [format/README.md](../format/README.md):

| Field | Value |
|---|---|
| `answerer` | `jev`, `decisions`, `llm` or `rule` |
| `answerer_model` | the resolved id: `jev-1.13.0`, `gpt-6-luna`, `claude-haiku-5-5`, `keyword-rule` |
| `output` | yes/no, a choice name or a level label; empty unless `outcome` is `answered` |
| `confidence` | noul: max(p, 1 - p); choice and score: the provider's confidence; the llm and rule give none |
| `tokens_in`, `tokens_out`, `cost_usd`, `latency_ms` | measured per call; `cost_usd` is the row's share |
| `price_table_date` | the date the prices below were read; empty for the rule |
| `prompt_version`, `run_id` | echoed from RunOptions |
| `outcome` | `answered`, `refused`, `unsupported` or `error` |
| `label`, `label_source` | always empty: a model answer is never a truth label |

`ask` also returns each row's `evidence` (never a CSV column): `probabilities`, `score`, `probability`, `reason` for a row that is not answered, `shared_by`, `call_cost_usd`, `http`, and the llm `transport`. No row, evidence field or error message holds a key.

### Mapping

| Contract | Jev | Decisions | LLM (Haiku 5.5) |
|---|---|---|---|
| noul | `noul`; output yes when p >= 0.5 | `predicate`; output yes when p >= 0.5 | JSON reply `"yes"` or `"no"` |
| choice | `choice` | `choice` with `{value, description}` items | JSON reply, one choice name |
| score | `score`; output is the level with the highest probability | `score`; output is the level with the highest probability, the weighted index kept in evidence only | JSON reply, one level label |

### Outcomes

| Outcome | When |
|---|---|
| `answered` | an answer inside `answer_set` |
| `refused` | Decisions answer `{type: "refusal"}`, or a Messages `stop_reason` of `refusal` |
| `unsupported` | a non-text input; the rule asked anything but a 2-option choice |
| `error` | an HTTP error, a reply outside `answer_set`, a missing key (only that arm), or the budget cap (`reason: "budget"`, counted as `incomplete`) |

### Transports

| Arm | Endpoint | Key |
|---|---|---|
| jev | `POST https://api.typesafe.ai/v1/systemone` | `JEV_API_KEY` |
| decisions | `POST https://api.openai.com/v1/decisions` | `OPENAI_API_KEY` |
| llm, `messages-api` | `POST https://api.anthropic.com/v1/messages` (no temperature, no prefill; text blocks selected by type) | `ANTHROPIC_API_KEY` |
| llm, `claude-cli` | the local `claude` binary, run from an empty temp directory with lean flags; used when no `ANTHROPIC_API_KEY` is set; cost is the CLI's list price | none |
| rule | local keyword match, no call | none |

### Price table (read 2026-10-08)

| Arm | Model | Input per 1M tokens | Output per 1M tokens | Source |
|---|---|---|---|---|
| jev | `jev-1.13.0` | $0.042 | free | FLOW.md, Spend per case |
| decisions | `gpt-6-luna` | $0.10 | free | https://developers.openai.com/api/docs/guides/decisions |
| llm | `claude-haiku-5-5` | $0.10 ($0.50 above 100,000 input tokens) | $0.50 ($2.50 above 100,000) | https://platform.claude.com/docs/en/models/haiku-5-5/overview |
| rule | `keyword-rule` | $0 | $0 | local |

`estimate` is an upper bound: request bytes plus 256 tokens in per call, and the llm's `max_tokens` (1024) out.

### Exit codes

| Code | `verdict` | `validate` | other subcommands |
|---|---|---|---|
| 0 | use Jev | valid | done |
| 1 | | invalid file, or unreadable | could not write `--out` |
| 2 | invalid input (bad file, unknown question, usage) | usage | invalid input or usage |
| 3 | don't use Jev | | |
| 4 | not enough evidence | | |

With several questions in one file, `verdict` exits 3 when any question is "don't use Jev", else 4 when any is "not enough evidence", else 0. `--question <id>` scores one.

## The six tools

| Tool | Does | Spends |
|---|---|---|
| `arms` | arms, models, prices with dates, types, which key env names are set | 0 |
| `estimate` | dry-run price, provider calls, cases needed for a verdict (30 paired labelled) | 0 |
| `ask` | one case, the questions, the chosen arms; rows with evidence | yes |
| `run` | many cases; writes the records CSV; budget cap | yes |
| `verdict` | labelled records to verdict and exit code (`src/core/verdict.ts`, unchanged) | 0 |
| `validate` | the record validator (`src/format/validate.ts`) | 0 |

## Command line

`bun src/decide/cli.ts <command>` (or `bun run decide <command>`). JSON on stdout, errors on stderr.

Keys come from the caller's environment only: `JEV_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. No flag takes a key (argv is visible to every process on the host), and no key is printed or written. With no `ANTHROPIC_API_KEY` the llm arm uses the local `claude` binary; set `--arms` without `llm` to skip it.

Input files: questions are one QuestionSpec or a JSON array of them; cases are JSONL (one Case per line, path ending `.jsonl`) or a JSON array; a rule file is `{"keywords": [...], "match": "...", "otherwise": "..."}`.

Flags: `--arms jev,decisions,llm,rule` (exactly these arms; without it the defaults), `--llm-model <id>`, `--rule <file>`, `--budget <usd>`, `--dry-run`, `--run-id <id>`, `--prompt-version <v>`.

```sh
# arms, models and dated prices
bun src/decide/cli.ts arms

# price a run before spending: calls, upper-bound cost, cases still needed for a verdict
bun src/decide/cli.ts estimate --questions questions.json --cases cases.jsonl --arms jev,decisions,llm

# one case, every row with its evidence
JEV_API_KEY=... OPENAI_API_KEY=... bun src/decide/cli.ts ask --questions questions.json \
  --input "Do you have women's boots in size 6?" --arms jev,decisions

# many cases to a records file, stop before spending more than 5 cents
JEV_API_KEY=... bun src/decide/cli.ts run --questions questions.json --cases cases.jsonl \
  --arms jev,llm --budget 0.05 --run-id shop-001 --out records.csv

# after a person has labelled records.csv: the verdict and its exit code
bun src/decide/cli.ts verdict records.csv --question needs_human; echo "exit $?"

# the record validator
bun src/decide/cli.ts validate records.csv
```

A `run` stopped by the budget cap still writes every row: the calls not made are `outcome=error`, `reason=budget`, and the summary has `stoppedByBudget: true`. The cap is checked before each call against an upper-bound estimate; the `claude-cli` transport has no output cap, so with it the budget can be overshot by at most one call, and the summary's `budgetNote` says so.

### Test-only: recorded fixtures

`JNJ_DECIDE_FIXTURES=<file>` makes `ask` and `run` answer every provider call from a JSON file of recorded responses (`{"hosts": {"api.typesafe.ai": {"http": 200, "response": {...}}}, "cli": {"stdout": "...", "exitCode": 0}}`) and never call a provider or start a `claude` binary. A request carrying no key gets a 401. The CLI prints a `NOTE` on stderr when it is set. It exists for `src/decide/cli.test.ts`; never set it outside a test.

## MCP

Added in M4.

## HTTP

Added in M5.
