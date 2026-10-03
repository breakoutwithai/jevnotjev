# TokenMax live run, 2026-10-03

The five fictional CVs and two questions of [examples/d06-tiny](../../../../examples/d06-tiny/records.csv), asked live of three answerers, one call per CV per question per arm. Refs #55. Captured 2026-10-03T06:40:15Z (`captured_utc` in `raw.json`).

## Files
| File | What it holds |
|---|---|
| `records.csv` | 30 `jnj-record/1` rows (5 CVs x 2 questions x 3 arms). `bun run validate` reports VALID, errors=0, gaps=30 (every row unlabelled) |
| `raw.json` | Every Jev and LLM request and its full raw response, latency and UTC time, plus `inputs_sha256` (`1e1481573029fd4effacfda2c5a7816bcfc3db8dcde923528be60922f6b508e8`) over the CVs, questions and prompts |
| `label.html` | Blind labelling page: each of the 30 answers with its CV and question, no arm name, model, confidence, tokens or cost |

## The arms
| Arm | Model id | How it was called | Calls |
|---|---|---|---|
| rule | `keywords:token pot\|pool` (q1), `keywords:dashboard\|meter` (q2) | the keyword rules in `examples/d06-tiny/expected.md`, case-insensitive substring match, no network | 10 (local) |
| jev | `jev-1.13.0`: pinned in every request; the API answered HTTP 200 with that model on 10 of 10 | `~/.claude/scripts/jaylo-jev.sh call`, which reads the key itself; each request's sha256 matches a `body_sha256` line in its call log, 10 of 10 | 10 |
| llm | `claude-haiku-4-5-20251001`: `haiku` requested and accepted by `claude -p` 2.1.288; the id is the `modelUsage` key in each reply | `claude -p --model haiku --output-format json --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence`, system prompt with the question and yes/no definitions, the CV as the user turn | 10 |

Jev and the LLM got the same question and the same definitions (yes: "The CV shows it."; no: "The CV does not show it.").

## Price table and spend
| Arm | Price source | Tokens in / out | Spend |
|---|---|---|---|
| rule | none | 0 / 0 | $0 |
| jev | FLOW.md metric table: $0.042 per million input tokens, output free (published price, not yet checked against a bill) | 3,837 / 320 | $0.00016115 |
| llm | [models.md](../../../research/2026-09-29-verdict-minimums/models.md) sections 1 and 4, fetched 2026-09-29, re-checked 2026-09-30: Claude Haiku 4.5 input $1, output $5, cache read $0.10 per million, cache write 1.25x (5 m) or 2x (1 h) | 5,262 / 3,480 | $0.022662 |
| **Total** | | | **$0.02282315** |

The LLM replies were one word, but each call reported 242 to 498 output tokens; output was 77% of LLM spend. No call read or wrote the cache. For every LLM call, the table cost equals the `total_cost_usd` that `claude -p` reported (sum $0.022662).

Latency is client wall clock around each call, start-up included: Jev 392 to 476 ms (median 430), LLM 3,923 to 6,030 ms (median 4,597.5), rule 0.

## What is real
Everything in `records.csv` except the labels: the CV text and questions (inputs from d06), every output, Jev confidence, token count, cost and latency come from the calls in `raw.json` or the keyword rule. The d06 Jev and LLM rows were not read; they are invented (`examples/d06-tiny/expected.md`).

Labels are blank. To label:

1. Open `label.html` in a browser, mark each of the 30 answers accept or reject, and press Download labels.csv (the browser saves it, usually to `~/Downloads/labels.csv`).
2. From the repo root: `bun scripts/tokenmax/run.ts label ~/Downloads/labels.csv` (any path works; with no path it reads `docs/product/runs/2026-10-03-tokenmax/labels.csv`).

Each item id is bound to this run, its CV, question, answer set, prompt version and answer, so a `labels.csv` from an older page is refused rather than attached to a changed answer. A verdict comes later from `src/core/verdict.ts` on the labelled records; none is written here.

## Rebuild
- `bun scripts/tokenmax/run.ts replay` rebuilds `records.csv` from `raw.json` with no network, keeping a label only when its row's run, prompt, CV, question, answer set and answer are unchanged. It refuses a `raw.json` whose price table differs from the dated one.
- Single operator: do not run these commands concurrently; nothing locks `records.csv`.
- `bun scripts/tokenmax/run.ts page` regenerates `label.html`.
- `bun scripts/tokenmax/run.ts run` makes 20 new paid calls, after checking that every record the inputs would produce passes the jnj-record/1 schema. It writes nothing unless all 20 succeed; then `raw.json` is validated and written atomically, and `records.csv` is derived from it by a second atomic write.
- `raw.json` is the record of the run; `records.csv` is rebuilt from it by `replay`. Labels live only in `records.csv`, and `replay` preserves them. If the second write of a run fails, run `replay` to recover `records.csv`.
