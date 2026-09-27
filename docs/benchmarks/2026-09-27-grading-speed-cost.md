# Grading 90 answers: Jev vs Claude models (2026-09-27)

Task: grade 90 short developer answers (30 prompts x 3 candidate answers) accept or reject under one rule. Set is synthetic and its expected labels were written by an AI, so accuracy is indicative only. One run per mode.

## All 90 in one call
| Grader | Time | Cost | Tokens in / out | Matches expected |
|---|---|---|---|---|
| Jev (jev-1.13.0) | 0.4 s | $0.0006 | 15,255 / 2,793 | 86/90 |
| Claude Haiku 4.5 | 93.0 s | $0.0629 | 6,265 / 10,076 | 87/90 |
| Claude Sonnet 5 | 52.6 s | $0.0901 | 8,318 / 5,685 | 86/90 |
| Claude Opus 5.5 | 17.3 s | $0.1047 | 8,255 / 1,935 | 88/90 |

## One call per answer (90 calls)
| Grader | Time | Cost | Matches expected |
|---|---|---|---|
| Jev | 29.4 s | $0.0015 | 80/90 |
| Haiku 4.5 | 683.4 s | $0.3395 | 87/90 |
| Sonnet 5 | 280.6 s | $0.1721 | 86/90 |
| Opus 5.5 | 273.9 s | $0.4960 | 83/90 (3 unparsed) |

## How it was measured
- Jev: `POST api.typesafe.ai/v1/systemone`, several questions per call for the one-call mode; tokens from the response `usage`; cost at $0.042 per million input tokens, output free.
- Claude: `claude -p` with a short system prompt and no tools; model id checked on every call; cost from `total_cost_usd`. Times include CLI start-up.

## Not established
- Accuracy on real, human-labelled data.
- Why Jev scored 80/90 one by one but 86/90 in one call.
- Variance: each mode ran once.
