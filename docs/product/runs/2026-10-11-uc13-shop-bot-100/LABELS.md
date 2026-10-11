# Labels for run-shopbot-2026-10-11: DRAFT, not approved

`records.csv` in this folder carries NO labels. The files below are AI drafts waiting for the operator's review. Nothing here is a label until a person approves it.

## How the drafts were made

Same method as `../2026-10-01-uc13-shop-bot/LABELS.md`.

1. Three AI labellers each labelled all 100 messages (m01 to m100) on their own, from `examples/uc13-shop-bot/fact-sheet.md`, the messages in `cases.jsonl` and `cases-m41-m100.jsonl` (case_id and case_input only, no persona field), and the answer/hand_off definitions in `docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md`. Each took a different reading: what the fact sheet alone settles (labeller 1), what the shop owner would want (labeller 2), what the customer actually needs (labeller 3).
2. They labelled before any arm of this run had produced an answer, from a copy of those three inputs only. None saw a rule, Jev or LLM answer, the earlier run's labels, or any per-arm total.
3. Each draft is in `label-drafts/labeller-<n>.csv` (`case_id,truth,certainty,reason`). `labels-draft.csv` lines them up with the majority call.

## Agreement

- Unanimous: 99 of 100 (63 hand_off, 36 answer).
- Disputed: 1, `m67` ("can we pick the equipment at the lift base or only in the village?"): labellers 1 and 3 `answer`, labeller 2 `hand_off`. All three marked it low certainty.
- m01 to m40: the drafts match the labels approved on 2026-10-03 on 40 of 40.
- Marked low certainty by at least one labeller (22): m07 m12 m24 m28 m33 m35 m41 m43 m44 m48 m49 m59 m65 m66 m67 m79 m80 m84 m86 m88 m89 m92.

## To approve

The operator reviews `labels-draft.csv`, decides m67 and any low-certainty call, writes `labels.csv` (`case_id,truth`, 100 rows) in this folder, then runs:

```
bun scripts/uc13/run-arms.ts label --run 2026-10-11 --source human_reviewed --by operator --at <YYYY-MM-DD> --blind false
```

Until then `bun src/decide/cli.ts verdict` on this `records.csv` reports not enough evidence, by design: unlabelled rows count for nothing.
