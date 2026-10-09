# Who Spent the Tokens? (pricing poster mockup)

A poster mockup that sets out the price of each method for the TokenMax run as a whodunnit. `poster.html` is the source (900 x 1350, open it in a browser); `poster.png` is a 2x render of it.

## Where each figure comes from

All read at `origin/main` `0d49859` on 2026-10-08.

| Poster figure | Source |
|---|---|
| Haiku 5.5: $0.10 in, $0.50 out per 1M | `src/decide/prices.ts`, llm entry `claude-haiku-5-5` |
| Haiku 4.5: $1 in, $5 out per 1M | `scripts/tokenmax/arms.ts` `LLM_PRICES` |
| Jev: $0.042 in per 1M, output free | `src/decide/prices.ts`, jev entry |
| Decisions: $0.10 in per 1M, output $0 | `src/decide/prices.ts`, decisions entry `gpt-6-luna` |
| Case 10 Haiku 4.5: $0.003022 | `docs/product/runs/2026-10-03-tokenmax/records.csv` line 31 |
| Case 10 Jev: $0.000016 | same file, line 21 |
| Run totals $0.022662 and $0.000161 | sum of `cost_usd` per answerer, same file |
| 10 of 10 accepted (LLM, Jev); rule 6 of 10 | `outcome` column, same file |
| About 140 times | 0.022662 / 0.000161154 = 140.6 |

## What it does not prove

- The Jev and Decisions rates come from the price table and have not been checked against a bill.
- The Decisions API has not been run on these cases, so it has no accepted count or spend.
- 10 cases, labels human reviewed but not blind; the run is below the minimum for a verdict.
- The logo slots hold plain wordmarks. No vendor logo artwork is included.
