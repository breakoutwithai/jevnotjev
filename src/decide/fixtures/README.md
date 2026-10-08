# src/decide fixtures

Recorded provider responses for `src/decide/decide.test.ts`, from the M0 probes of 2026-10-08 (one UC13 message, "Do you have women's boots in size 6?"). No file holds a key; `D-FIXTURES` checks each with `assertNoSecrets` (`scripts/uc13/calls.ts`).

| File | Arm | Source | Verified |
|---|---|---|---|
| `m0-jev.json` | jev | one systemone call, three questions, HTTP 200 | yes, request and response as sent and received |
| `m0-decisions.json` | decisions | one `/v1/decisions` call, three questions, HTTP 200 | yes |
| `m0-decisions-refusal.json` | decisions | a question the API refused, HTTP 200 | yes |
| `m0-llm-cli.jsonl` | llm, claude-cli | `claude -p --output-format stream-json` with the lean flags | yes; the init event (local paths) is dropped and the session id and uuid keys are removed |
| `m0-llm.UNVERIFIED.json` | llm, messages-api | the real Haiku 5.5 reply text in a documented Messages envelope | no: no Messages API response was captured (empty key, HTTP 401); usage is not measured |
| `llm-refusal.UNVERIFIED.json` | llm, messages-api | documented `stop_reason` refusal | no: no live refusal was captured |
