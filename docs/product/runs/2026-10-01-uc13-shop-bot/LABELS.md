# How labels.csv was made

`labels.csv` holds one truth per message (`answer` or `hand_off`) for all 40 messages. `bun scripts/uc13/run-arms.ts label` turned it into the `label` column of `records.csv` (120 rows).

1. Three AI labellers each labelled all 40 messages on their own, from `examples/uc13-shop-bot/fact-sheet.md`, `examples/uc13-shop-bot/cases.jsonl` and the answer/hand_off definitions in `docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md:31`. Each took a different reading: what the fact sheet alone settles, what the shop owner would want, and what the customer actually needs.
2. None of them opened a file with the rule, Jev or LLM answer to a message. Two of them read the per-arm answer and hand_off totals in the use-case doc's run status table; none saw a per-message answer.
3. All three agreed on all 40 messages: 20 `answer`, 20 `hand_off`.
4. A person reviewed the agreed file, with the five least certain calls listed for review (m07, m12, m28, m33, m35), and approved it on 2026-10-03.

`records.csv` marks every label `label_source: human` (`scripts/uc13/arms.ts:250`); read it as "approved by a person", with the drafting described above.
