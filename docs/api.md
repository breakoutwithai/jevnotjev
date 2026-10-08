# Jev!Jev decide API

Ask one typed question (yes/no, pick one of N, or a score level) about a set of text cases, of up to four arms: Jev, the OpenAI Decisions API, an LLM and a keyword rule. Every answer comes back as a `jnj-record/1.2` row with its outcome, cost and pins. The run is priced before anything is spent, and once a person has labelled the rows the verdict comes back with a CI exit code.

The same six tools are reached three ways: the command line (`src/decide/cli.ts`, this page), a stdio MCP server (`src/mcp/server.ts`) and HTTP under `/api/v1` (see HTTP below). The core is `src/decide/`; every surface is a thin wrapper over it.

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

Keys come from the caller's environment only: `JEV_API_KEY` (or, when it is empty, `TYPESAFE_API_KEY`, the name the Backstage copy tells you to set), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. No flag takes a key (argv is visible to every process on the host), and no key is printed or written. With no `ANTHROPIC_API_KEY` the llm arm uses the local `claude` binary; set `--arms` without `llm` to skip it.

Input files: questions are one QuestionSpec or a JSON array of them; cases are JSONL (one Case per line, path ending `.jsonl`) or a JSON array; a rule file is `{"keywords": [...], "match": "...", "otherwise": "..."}`.

Flags: `--questions <file>`, `--cases <file>` (estimate, run), `--case <file>` or `--input <text>` (ask, exactly one), `--case-id <id>` (ask with `--input` only; with `--case` it is an error, the file carries its id), `--out <file>` (run; must not be the cases, questions or rule file), `--question <id>` (verdict), `--arms jev,decisions,llm,rule` (exactly these arms; without it the defaults), `--llm-model <id>`, `--rule <file>`, `--budget <usd>`, `--dry-run`, `--run-id <id>`, `--prompt-version <v>`.

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

`JNJ_DECIDE_FIXTURES=<file>` makes `ask` and `run` answer every provider call from a JSON file of recorded responses (`{"hosts": {"api.typesafe.ai": {"http": 200, "response": {...}}}, "cli": {"stdout": "...", "exitCode": 0}}`) and never call a provider or start a `claude` binary. A request carrying no key gets a 401. The CLI prints a `NOTE` on stderr when it is set, and stamps every row: `evidence.replayed_fixture` is `true` and the `run_id` gets a `-fixture` suffix (the suffix is what reaches the CSV, where evidence is not a column). It exists for `src/decide/cli.test.ts`; never set it outside a test.

## MCP

`bun src/mcp/server.ts` is a stdio MCP server with the six tools, for coding agents. It runs on the caller's machine: install with `bun install` in a clone of this repo.

Keys come from the server process environment only, the same names as the CLI: `JEV_API_KEY` (or, when it is empty, `TYPESAFE_API_KEY`), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. They are read per call and never appear in a tool argument, result or error. With no `ANTHROPIC_API_KEY` the llm arm uses the local `claude` binary. Set only the keys for the arms you use.

Claude Code, with `claude mcp add` (the shell expands the keys, and Claude Code stores the values in its local config):

```sh
claude mcp add jnj-decide -e JEV_API_KEY="$JEV_API_KEY" -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -- bun /path/to/jevnotjev/src/mcp/server.ts
```

Or a project `.mcp.json`, where `${VAR}` is expanded from the environment Claude Code starts in, so no key value is written to any file:

```json
{
  "mcpServers": {
    "jnj-decide": {
      "command": "bun",
      "args": ["/path/to/jevnotjev/src/mcp/server.ts"],
      "env": {
        "JEV_API_KEY": "${JEV_API_KEY}",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

Arguments are the contract's JSON shapes: `questions` is an array of QuestionSpec, `cases` an array of Case, `arms` an Arms object, `options` a RunOptions object. Each result is one text block of JSON, the same body the CLI prints; bad input is a tool error (`isError`) whose text names the field, the same message the CLI prints with exit 2.

`run` returns the rows inline when called without `out`, like `ask`; with `out` it writes the jnj-record/1.2 CSV to that path on the server's machine (relative paths resolve from the server's working directory) and returns the summary. Use `out` for anything beyond a handful of cases, then `verdict` and `validate` on the same file.

`out` rules (the CLI's `--out` follows the same ones): the path must end in `.csv`; it may be a new file, or an existing file whose first line is a jnj-record header (so a records file can be re-run over). An existing file with any other first line, and a directory, are refused with an `isError` result that names the reason, before any provider is called and with the file untouched. With `options.dryRun: true` and `out`, `run` writes no file and returns the dry-run body (`dryRun`, `calls: 0`, `spentUsd: 0`, `estimate`).

One call per tool (the `arguments` object of a `tools/call`):

```jsonc
// arms: arms, pinned models, dated prices, which key env names are set
{}

// estimate: provider calls, upper-bound cost, cases a verdict needs (spends 0)
{ "questions": [{ "name": "needs_human", "type": "noul", "instructions": "Does this message need a person?" }],
  "cases": [{ "id": "m04", "input": "Do you have women's boots in size 6?" }],
  "arms": { "jev": true, "decisions": true, "llm": "claude-haiku-5-5" } }

// ask: one case, rows with evidence
{ "questions": [{ "name": "topic", "type": "choice", "instructions": "What is this message mainly about?",
                  "choices": [{ "name": "stock", "definition": "Availability." }, { "name": "other", "definition": "Anything else." }] }],
  "case": { "id": "m04", "input": "Do you have women's boots in size 6?" },
  "arms": { "jev": true, "llm": false } }

// run: many cases to a records file, stop before spending more than 5 cents
{ "questions": [{ "name": "urgency", "type": "score", "instructions": "How urgent is this message?",
                  "levels": [{ "label": "Not urgent", "description": "General." }, { "label": "Urgent", "description": "Today." }] }],
  "cases": [{ "id": "m04", "input": "Do you have women's boots in size 6?" }, { "id": "m05", "input": "My order never came." }],
  "options": { "budgetUsd": 0.05, "runId": "shop-001" },
  "out": "/abs/path/records.csv" }

// verdict: after a person has labelled the file; exit_code 0, 3 or 4 in the body; an invalid file is a tool error
{ "file": "/abs/path/records.csv", "question": "urgency" }

// validate: the record validator
{ "file": "/abs/path/records.csv" }
```

`JNJ_DECIDE_FIXTURES` (see Test-only above) works the same way in the server's environment, with the same `NOTE` on stderr and the same row stamp (`evidence.replayed_fixture`, `-fixture` run id suffix), and is used by `src/mcp/server.test.ts`; never set it outside a test.

## HTTP

The six tools under `/api/v1` on the Backstage server (`src/backstage/server.ts`, routes in `src/backstage/api-v1.ts`), for scripts, CI jobs and agents. Same contract as the CLI and MCP: the request body is the MCP tool's arguments, and the response body is the JSON the CLI prints.

| Route | Tool | Body |
|---|---|---|
| `GET /api/v1/arms` | arms | none |
| `POST /api/v1/estimate` | estimate | `{questions, cases, arms?, options?}` |
| `POST /api/v1/ask` | ask | `{questions, case, arms?, options?}` |
| `POST /api/v1/run` | run | `{questions, cases, arms?, options?}`; rows inline, no `out`; `options.format: "csv"` returns `records` |
| `POST /api/v1/verdict` | verdict | `{records: "<jnj-record CSV text>", question?}` |
| `POST /api/v1/validate` | validate | `{records: "<jnj-record CSV text>"}` |

### Auth: operator-minted bearer tokens

Every `/api/v1` route, `GET /arms` included, answers `401 {"code":"unauthenticated"}` (with `WWW-Authenticate: Bearer`) unless the request carries `Authorization: Bearer <token>` with a minted token. There is no sign-up: the operator mints each token on the host that serves the API, as the user the server runs as:

```sh
bun scripts/api-token-mint.ts --label ci-bot
# stderr: minted tok_3f9c... for "ci-bot" into <state file>; the token below is shown once and not stored
# stdout: jnj_...   (43 characters after the prefix; copy it now, it is not shown again)
```

- The state file keeps only each token's sha256 (with an id, label and date); a copy of the file cannot call the API. A presented token is compared in constant time against every stored hash.
- Path: `JNJ_API_TOKENS_PATH`, else `$STATE_DIRECTORY/api-tokens.json` (the systemd state directory), else `$HOME/.jevnotjev/api-tokens.json`. All are outside the served `site/` directory; a path inside the static root is refused and every route stays 401. `api-tokens.json` and `.jevnotjev/` are gitignored.
- The file is mode 0600 in a 0700 directory, set on every mint even when they already existed. A mint takes an exclusive `api-tokens.json.lock` (a lock older than 30 s is taken over), writes a temp file and renames it into place, so concurrent mints all persist. The server re-reads it when it changes, so a new token works without a restart. To revoke, delete its entry by `id`.
- The browser routes keep their cookie session: a bearer token opens no `/backstage/` or `/api/backstage/` route, and a session cookie opens no `/api/v1` route.

### Provider keys: per request, the caller's own

| Header | Arm |
|---|---|
| `x-jev-key` | jev |
| `x-openai-key` | decisions |
| `x-anthropic-key` | llm (Messages API) |

- Keys are read from the request headers for that request only. They are never logged, stored, echoed or put in an error body. The server's own environment keys and the funded trial key are never used for an API caller.
- A missing key fails only its arm: that arm's rows are `outcome=error` with `evidence.reason` `missing key: <arm> needs keys.<name>`.
- The `claude-cli` transport is not offered over HTTP (it would spend the operator's subscription on a caller's behalf). With no `x-anthropic-key` the llm rows are `outcome=error`, `evidence.reason` `missing key: llm needs keys.anthropic`; `arms` reports `transports: ["messages-api"]`.
- `arms` reports which key headers are set (`keySet`), never a value, plus `keyHeaders` and `limits`.

### Limits

| Limit | Value |
|---|---|
| cases per `estimate` or `run` | 10 |
| questions per request | 5 |
| `options.budgetUsd` on `ask` and `run` | 1.00 when absent; above 5.00 is a 400 |
| request body | 64 KiB (413 above) |
| `/api/v1` requests in flight | 4, inside the server's overall cap of 8 (503 above) |
| one provider call | 30 s |
| one `/api/v1` request | 100 s, then no new provider call |
| one `/api/v1` connection idle | 120 s |

Send more cases as several `run` requests. `verdict` and `validate` take the CSV text, so a records file up to 64 KiB.

- `run` with `options.format: "csv"` returns `records`, the rows as one jnj-record/1.2 CSV string, in place of `rows`. Label it, then send it to `verdict` or `validate` as is. The default, `"rows"`, returns the JSON rows.
- A request stops starting provider calls when the client disconnects or after 100 s. The call in flight is aborted; it and every call not made are `outcome=error`, `evidence.reason` `aborted`, counted as `incomplete`, and the summary has `stoppedByAbort: true`. Its concurrency slot is freed when the run returns.
- `HEAD /api/v1/arms` with a valid token answers 200 with no body.

### Status codes

| Status | When |
|---|---|
| 200 | the tool answered; `verdict` carries `exit_code` 0, 3 or 4, `validate` `exit_code` 0 or 1 |
| 400 | `{code: "invalid-input", exit_code: 2, errors}`: bad body, an unknown key such as `out`, a floating model id, invalid records for `verdict`; or `invalid-json` |
| 401 | no bearer token, or not a minted one |
| 404, 405, 413, 415, 503 | unknown route, wrong method (`Allow` names the right one), body too large, not `application/json`, busy |

No CORS header is set on any response: v1 has no browser callers.

### One request per route

```sh
API=https://<host>/api/v1
AUTH="Authorization: Bearer $JNJ_API_TOKEN"

# arms: arms, pinned models, dated prices, which key headers are set, limits
curl -sS "$API/arms" -H "$AUTH"

# estimate: provider calls, upper-bound cost, cases a verdict needs (spends 0)
curl -sS "$API/estimate" -H "$AUTH" -H 'content-type: application/json' -d '{
  "questions": [{"name": "needs_human", "type": "noul", "instructions": "Does this message need a person?"}],
  "cases": [{"id": "m04", "input": "Do you have boots in size 6?"}],
  "arms": {"jev": true, "decisions": true, "llm": "claude-haiku-5-5"}}'

# ask: one case, rows with evidence
curl -sS "$API/ask" -H "$AUTH" -H "x-jev-key: $JEV_API_KEY" -H 'content-type: application/json' -d '{
  "questions": [{"name": "topic", "type": "choice", "instructions": "What is this message mainly about?",
                 "choices": [{"name": "stock", "definition": "Availability."}, {"name": "other", "definition": "Anything else."}]}],
  "case": {"id": "m04", "input": "Do you have boots in size 6?"},
  "arms": {"jev": true, "llm": false}}'

# run: up to 10 cases, rows inline, stop before spending more than 5 cents
curl -sS "$API/run" -H "$AUTH" -H "x-jev-key: $JEV_API_KEY" -H "x-anthropic-key: $ANTHROPIC_API_KEY" \
  -H 'content-type: application/json' -d '{
  "questions": [{"name": "urgency", "type": "score", "instructions": "How urgent is this message?",
                 "levels": [{"label": "Not urgent", "description": "General."}, {"label": "Urgent", "description": "Today."}]}],
  "cases": [{"id": "m04", "input": "Do you have boots in size 6?"}, {"id": "m05", "input": "My order never came."}],
  "arms": {"jev": true, "llm": "claude-haiku-5-5"},
  "options": {"budgetUsd": 0.05, "runId": "shop-001"}}'

# verdict: after a person has labelled the records; exit_code 0 use Jev, 3 don't use Jev, 4 not enough evidence
jq -Rs '{records: ., question: "urgency"}' records.csv |
  curl -sS "$API/verdict" -H "$AUTH" -H 'content-type: application/json' -d @-

# validate: the record validator
jq -Rs '{records: .}' records.csv | curl -sS "$API/validate" -H "$AUTH" -H 'content-type: application/json' -d @-
```
