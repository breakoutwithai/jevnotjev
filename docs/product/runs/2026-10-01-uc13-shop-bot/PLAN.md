# UC13 delivery plan

Governing issue: #30. Use case: [uc13-shop-bot-answer-or-handoff.md](../../use-cases/uc13-shop-bot-answer-or-handoff.md).

UC13 is delivered when this run folder holds a labelled `records.csv` and a `result.md` with a verdict, and the PR for #30 is merged. The stage-door demo (#33) and evidence beyond the synthetic set (#34) build on it and are not part of delivery.

## Ordered tasks
| # | Task | Issue | Owner | State (2026-10-01) | Done when |
|---|---|---|---|---|---|
| 1 | Synthetic shop: fact sheet, 40 messages, keyword rule | #30 | agent | done | `examples/uc13-shop-bot/` holds no real shop name, phone, location or branded guarantee (T8) |
| 2 | Three-arm runner with tests | #30 | agent | done | `bun test scripts/uc13` passes; `run --dry` gives 13 hand_off / 27 answer |
| 3 | Run the rule, Jev and LLM arms | #30 | agent | done | `records.csv` VALID, 120 rows, 3 arms, Jev model `jev-1.13.0` on 40 of 40 |
| 4 | Keep the Jev calls replayable | #30 | agent | done | `replay` rebuilds the Jev rows byte-identical from `examples/uc13-shop-bot/fixtures/uc13.jev.json` with no network |
| 5 | Set the 40 human labels | #31 | operator | open | `labels.csv` 40 rows; `label` reports 120 of 120 rows labelled |
| 6 | `result.md`: accuracy, cost, misses, latency, verdict | #32 | agent | open, needs 5 | `result.md` committed with a `Verdict:` line; new tests counted |
| 7 | Update the use case's run status and open questions | #30 | agent | open, needs 6 | run status shows labels and verdict; "Not established" restated against the result |
| 8 | Readiness gate and merge | #30 | agent, operator merges | open, needs 7 | gate GREEN on the head SHA, evidence comment on the PR, merge instruction given |

## Success criteria
| ID | Criterion | Target | How measured |
|---|---|---|---|
| S1 | Labels are human and blind | 40 of 40 cases labelled, `label_source` = `human`; the labelling page carries no arm output | `bun run validate records.csv` gaps = 0; test UC13-F23 asserts `label.html` holds no arm output, model id, confidence or probabilities (the answer words `answer` and `hand_off` are allowed: the buttons and acceptance rule need them) |
| S2 | Records are valid and complete | VALID, 120 rows, 3 arms, 40 cases, 0 gaps | `bun run validate docs/product/runs/2026-10-01-uc13-shop-bot/records.csv` |
| S3 | Jev provenance | 40 of 40 rows `jev-1.13.0`; 40 of 40 fixture request hashes match a `body_sha256` in the call log; replay byte-identical | `bun scripts/uc13/run-arms.ts replay` then `git diff --exit-code` on records.csv and raw.json |
| S4 | Verdict computed by the written rules | one verdict from `docs/decision/verdict-rules.md`, with paired n, counts a/b/c/d and intervals shown | `result.md` |
| S5 | Synthetic only, no names | 0 hits for real-shop terms and community member names in the PR diff, title, body and commits | grep of the diff and `gh pr view` text |
| S6 | Gate | `bun test` 0 fail with the test count above 166; `bun run typecheck` clean | the PR evidence comment |

## Metrics to report in result.md
Each is reported per arm (rule, Jev, LLM). None has a target: they are what UC13 measures.

| ID | Metric | Source | Baseline before labels |
|---|---|---|---|
| R1 | Right answers and rate | label = accept | not measurable |
| R2 | Answered when it should have handed off (unsafe misses), with the case ids | reject with output `answer` | not measurable |
| R3 | Handed off when it could have answered | reject with output `hand_off` | not measurable |
| R4 | Spend and cost per right answer | `cost_usd`, D07 | spend: rule $0, Jev $0.001302, LLM $0.103167 |
| R5 | Latency median and p95 | `latency_ms` | rule 0 / 0 ms; Jev 349.5 / 470 ms; LLM 4,172 / 9,273 ms (includes `claude -p` start-up) |
| R6 | Jev vs LLM and Jev vs rule on paired cases | Newcombe method 10, verdict rules | not measurable |
| R7 | Agreement across all three arms | outputs only | 28 of 40 |

## Out of scope here
- Stage-door demo on the site: #33.
- Shop owner's labels, real messages, decisions 2 to 5: #34.
- D08 verdict code in `src/core/verdict.ts`: the result script's verdict is provisional until D08 lands.
