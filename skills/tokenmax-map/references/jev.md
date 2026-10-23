# Optional Jev decisions

The mapper's `--jev` mode is the client: it builds each body locally, writes the exact bodies to `jev-payload.json`, and sends nothing until the user answers yes. Its request shape, model identifiers, key variable and price follow the official TypeSafe documentation (https://docs.typesafe.ai/api, /models, /images, /primitives/box, /introduction/quickstart). Do not guess an endpoint, model, environment-variable name, price or rate limit; if the docs change, change the mapper and its tests. Do not install other software automatically.

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`.
- Models: `jev-1.13.0` for noul, choice and score; `jev-1.14.0` with the header `TypeSafe-Danger-Zone-Images: true` for box.
- Price: $0.042 per million input tokens; output tokens are free.

## The four questions, version tokenmax-jev-v1

State holds metadata numbers only. Independent questions about the same state go in one body.

| Id | Type | Question | Rule to beat | Label |
|---|---|---|---|---|
| will_hit | noul | Using the numbers in `window`, will this usage window reach 100% used before it resets? | pace rule: used share / elapsed share x 100 >= 100 | the window's recorded outcome, once closed |
| helper_size | choice | Which helper size would have been enough for this session's work, judged only from the numbers in `session`? Options small, medium, large, none | under 20,000 output and 25 tool calls small; over 200,000 output or 250 tool calls large; else medium | the user's own call, in a labels file |
| tokenmax_score | score | How heavily did this session use the person's token allowance, judged only from the numbers in `session`? Levels light, ordinary, heavy | terciles of output tokens within the source | the user's own rating, in a labels file |
| meter | box | the usage meter (the bar or percentage showing how much of the limit is used) in `pic` | a fixed crop for a known page layout | a hand-drawn box, accepted at IoU 0.5 or more |

`window` fields: source, window_minutes, used_percent, elapsed_percent, read_at, resets_at, used_percent_history. `session` fields: source, output_tokens, tool_calls, minutes, has_subagents, records, model_mix (output share by model class), share_of_day_output_percent.

## Questions that do not go to Jev

| Question | Why a rule is exact |
|---|---|
| Did this session hit a usage limit? | A cap record exists or not. |
| Did this week hit the weekly limit, after the fact? | A Claude weekly notice or a Codex reading at 100% is a recorded fact. |
| Short or weekly window for a cap? | The notice names it; a bare notice gives Jev no more evidence. |
| Totals per day, model or source; subagent or not; reset and elapsed time | Arithmetic over recorded fields. |
| Anything about message text | The skill reads none. |

## Overlap question, version shared-artifact-v1

Used only when comparing approved summaries (SKILL.md "Compare approved summaries"); the mapper does not send it.

Question: Could one permitted artifact satisfy both supplied acceptance criteria?
Answers: shared_artifact / separate_work / insufficient_evidence.
Rule: Shared topic is insufficient. Conflicting requirements or reuse restrictions mean separate_work. Missing requirements mean insufficient_evidence.

## Execute and record

Show the payload and name TypeSafe as the recipient, the purpose and the call count before sending; obtain approval. Never expose the key in a report or command output. Use the requested model or record the call as failed; never substitute a model or a host-agent verdict and label it Jev.

The report records question version, model, returned values, failures, input tokens and cost. No automatic retries and no unbounded corpus run. A verdict needs at least 30 paired labelled cases (docs/LIMITS.md) with labels set without seeing either method's output. A plausible score or a Jev-rule agreement count is not a measured saving.
