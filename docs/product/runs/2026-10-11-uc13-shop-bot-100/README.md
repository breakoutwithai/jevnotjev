# Ski shop bot run on 100 messages (run-shopbot-2026-10-11)

The UC13 question (answer from the fact sheet, or hand off to staff) on 100 customer messages: the 40 of `run-shopbot-2026-10-01` plus 60 new ones (m41 to m100). Fact sheet, rule, question, criteria and prompt (`shop-bot-handoff.v1`) are unchanged from the first run. The first run's folder is not touched.

## Where the 60 new messages came from

`examples/uc13-shop-bot/cases-m41-m100.jsonl`, sha256 `770f082bbb7bba6d10609d73d9d5bb32426d8639439d1bf22e82f7481a7652f3`, copied unchanged. Five AI persona writers (a parent with kids, a backcountry expert, a first-time tourist, a group organiser, a local regular) wrote 12 each. They knew only the shop's name and that it rents and tunes gear: none saw the fact sheet, the rule, the arms or the question. All 60 were written before any arm ran.

## Arm outputs and spend, one call per message, run 2026-10-11

| Arm | Model | hand_off | answer | Spend (USD) |
|---|---|---|---|---|
| rule | keywords.v1 | 30 | 70 | 0 |
| jev | jev-1.13.0 | 63 | 37 | 0.00328442 |
| llm | claude-haiku-5-5 | 71 | 29 | 0.01625538 |

- **Jev spend:** 78,201 input tokens at the published $0.042 per million, output free; not checked against a bill.
- **LLM spend:** the sum of `total_cost_usd` reported by `claude -p`.
- **LLM model:** requested as `haiku`, as in the first run. The first run's `haiku` resolved to `claude-haiku-4-5-20251001`; this run's resolved to `claude-haiku-5-5` (from `modelUsage` in each reply). The two LLM arms are not the same model.

## Files

- `records.csv`: 300 rows, jnj-record/1.1, unlabelled.
- `raw.json`: every Jev and LLM call's choice and model, plus the inputs fingerprint.
- `examples/uc13-shop-bot/fixtures/uc13-2026-10-11.jev.json`: the Jev requests and responses. `bun scripts/uc13/run-arms.ts replay --run 2026-10-11` rebuilds the Jev rows and calls from it with no network, keeping the LLM rows and calls already in `records.csv` and `raw.json` and recomputing the rule rows; the result is byte-identical to the committed files.
- `LABELS.md`, `labels-draft.csv`, `label-drafts/`: AI label drafts, not approved.

## Reproduce

```
bun scripts/uc13/run-arms.ts run --dry --run 2026-10-11   # rule arm only, writes nothing
bun scripts/uc13/run-arms.ts run --run 2026-10-11         # all three arms; Jev via $JEV_CALL
```
