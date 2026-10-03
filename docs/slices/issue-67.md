## Problem

Backstage's design in #55 and #56 is an offline walkthrough. The requested MVP must instead let testers bring their own keys and run real comparisons while retaining the site's theatre style.

## Scope

One binary decision, user text cases, a deterministic keyword baseline, direct Jev and Anthropic calls with the tester's keys, blind human labels, shared-core metrics/verdict and downloadable records/evidence. Six rooms: New Scene, Casting, Learning Lines, Rehearsals, Dress Rehearsal, Opening Night. Compact forms and cards; MVP finish.

No accounts, stored keys, saved server runs, arbitrary baseline code, multiple LLM providers or model-generated labels. Existing main stage and record/calculation contracts remain intact. Inputs may be templated; outputs always come from real execution.

## Invariants and acceptance

- B1: All six rooms work at 360px and desktop, keyboard accessible, in the site's light/dark theatre palette.
- B2: Question/options/definitions/acceptance rule/cases/keyword rule freeze into a run; edits create a new run. Double Run and late responses cannot corrupt a run.
- B3: Jev and Anthropic use only the supplied provider key and pinned model; actual output/usage/latency/model are captured. Invalid keys and off-model/malformed responses fail visibly, never fall back to sample data.
- B4: Keys stay in session/request memory, never logs, storage, URLs, exports or downstream prompts. Backend validates input, uses fixed upstream hosts, bounds requests/concurrency and sanitizes failures.
- B5: Run, Stop and explicit retry preserve completed answers and distinguish failed/uncertain calls. No synthetic answer is inserted for a failure. Retry charges remain visible in evidence.
- B6: Blind labels use actual outputs; labels and shared core drive every count, cost and verdict. Missing usage/cost stays missing. Cohorts never mix.
- B7: CSV validates as jnj-record/1 and reproduces the displayed result; sanitized evidence includes input identity, model IDs, usage and dated price provenance, without keys.
- B8: Local build produces reproducible browser/backend artifacts. Existing static deploy guards remain; backend has an explicit versioned deployment path and rollback. No production build.
- B9: Live acceptance requires a real BYOK browser/API run with sanitized evidence. Test doubles may exercise failures but cannot establish B3/B9. Keys/budget and human labels are needed for the complete live comparison evidence.

## Validation

RED checks for invalid inputs/key leaks, response parsing/model pins, frozen run identity, partial failures, CSV roundtrip and shared-core parity; GREEN local Bun tests/typecheck plus browser walkthrough. Exercise production bundle, not just source. Local failure controls cover invalid key, timeout, rate limit and stale result. Live provider smoke evidence is reported separately from deterministic tests.

## Dependencies and decisions

Uses existing src/core, src/format and Jev response validator. Does not depend on merging design PR #56 or result-removal PR #66. Start with Jev plus Anthropic as proposed in the accepted build plan. Tester access can be configured for rollout; no credentials are embedded in the build. No merge or production deploy authority is implied by this issue.

Refs #55 and #56. The live scope follows the operator's instructions: real, no mocks, bring your own key.

## Implementation contract

Browser-only state; no database. Two choices, 1-100 cases (each <=8000 chars), one question <=1000 chars, definitions <=1000 each. Literal case-insensitive keyword baseline. Every frozen run has UUID run ID, prompt version and fixed question ID. Acceptance rubric and exclusions are recorded for human judgment, never auto-labeling.

POST /api/backstage/answer accepts protocol version, run/case identity, question/choices/definitions, case input, provider (jev or llm), and only that provider's key. Fixed upstream URLs and pins jev-1.13.0 / claude-haiku-4-5-20251001. Server enforces origin, JSON/body limits, bounded concurrency, timeout and no redirects. No automatic retries. Response echoes identity and an input fingerprint, contains allowlisted output/usage/model/timing/price evidence or safe typed failure with charge uncertainty. Keys must be redacted even if upstream echoes them. No upstream error body is forwarded.

Shared contract lives in src/backstage/contracts.ts. Provider/server files are separate from browser imports. Successful answers become records only when the strict returned choice/model checks pass. Missing cost remains blank. Retried attempts remain in evidence, successful prior answers are not repeated. Stop cancels queued work; ambiguous in-flight cancellation is retained. Costs of failed attempts are separate from accepted-output statistics and shown as additional known/unknown attempt spend.

Browser exports exact records.csv used for fileSeed/cohortMetrics/verdict plus safe run evidence. Rehearsal cards conceal provider metadata while labeling. New edits invalidate the active run via explicit new scene; keys never enter manifest or storage. DOM uses textContent for user/provider text.

Build locally with Bun: reproducible browser bundle and server bundle, release SHA protocol handshake. Service serves local static assets for development and API on loopback for deployment. Deployment setup must not alter existing production until separately authorized; exact prepared artifact instructions and rollback are required. No merge/deploy in this task.

Validation: isolated adapter HTTP doubles are tests only. Live B9 remains pending until actual tester credentials/budget and human labels are available; no mock product mode exists. Independent review covers spec and final security/correctness/architecture/CI. Full bun test and tsc locally, plus browser/mobile checks.

### Concrete bounds and provider mapping

- Keyword rule is any-of literal case-insensitive match; match selects choice one, otherwise choice two. Empty list always selects choice two; model identity is keywords-v1. Frozen manifest records keyword list.
- Choices: distinct trimmed names, 1-64 characters, no pipe/control characters; definitions nonempty <=1000. Generated line-case IDs are case-1, case-2 etc; imported IDs must match [A-Za-z0-9_-]{1,64} and be unique.
- Jev POST https://api.typesafe.ai/v1/systemone with Bearer key; state is case input, questions.q1 uses choice type, question instructions and criteria map. Anthropic POST https://api.anthropic.com/v1/messages with x-api-key and anthropic-version 2023-06-01; max_tokens 128, system instructs exact named choice only, user content contains JSON question/choices/input. Only a single exact permitted text choice with end_turn is accepted. Prompt version backstage-v1. No browser-direct provider request.
- API body max 65536 bytes; upload deadline 5 seconds; upstream body max 65536 bytes; upstream deadline 30 seconds; server max 8 simultaneous requests; browser sequential calls. Fixed public same-origin deployment via nginx to loopback backend, local origin http://localhost:3456. No CORS response headers. Production origin explicitly configured.
- Update FLOW.md and docs/spec/plan.md to distinguish offline analysis tools from the new explicitly initiated Backstage BYOK call boundary. Existing main stage remains static. New deployment contract is documented separately; no server rollout in this implementation session.

### Build verification

Implementation uses an explicit reveal boundary: results and downloads unlock only after the tester locks the blind labeling pass. Revealed runs cannot change labels or retry. Secret-bearing rejected candidates never become exportable active runs. Local validation on 2026-10-03: 410 regression tests / 1892 assertions and 5 deployment tests / 22 assertions passed; typecheck and reproducible paired build passed. Independent GPT and Claude review findings were resolved and rechecked. All six rooms fit a 360px viewport. Actual browser calls using deliberately invalid credentials returned HTTP401 from both real providers, without fallback answers. Downloaded rule-only records validated and matched the displayed shared-core verdict. Successful inference and human-labelled live comparison remain pending; invalid-key checks do not satisfy B9. No production rollout performed.
