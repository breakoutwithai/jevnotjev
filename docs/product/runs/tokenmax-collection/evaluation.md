# Synthetic contract evaluation — issue #242

The executed matrix is four provider/mode combinations: Claude/host, Claude/Jev, Codex/host and Codex/Jev. All four collected synthetic records, returned the same tm-collection/1 envelope and passed the actual ingestDraft receiver. See fixture-journeys.json for the inputs' aggregate results, observed stub calls, local elapsed collector time and transport character counts. No live host-model or Jev inference ran. Injected transport answers are synthetic contract fixtures, not model results, and do not establish semantic quality.

Command: `bun test src/tokenmax-collection/collector.test.ts scripts/tokenmax-collection/run.test.ts`. Initial collector-focused result: 26 passing tests across 2 files (23 collector, 3 local runner), 0 failures. Exact names/counts are in collector-green.txt. Initial missing-implementation failure is preserved in red.txt. Type checking passed with `bun run typecheck`.

| Metric | Observed result | What remains |
|---|---|---|
| M1: four collection/paste journeys | 4/4 synthetic provider/mode paths receiver-valid | Real participant collection and live semantic transport acceptance |
| M2: privacy/preservation | Planted email and credential canaries absent from adapter state and public envelope; span-ID validation, changed-result review, uncertainty, missing authorization, invalid responses and timeout behavior covered | Blind held-out human labels; privacy false-accept and preservation-error rates. Existing tests use synthetic agent-proposed labels and injected decisions. No accuracy claim. |
| M3: runtime/model consumption | Local fixture collector elapsed time and stub calls recorded per case. Host baseline makes zero Jev calls. Cache behavior and concurrency bound tested. | Matched completed live runs, actual host context tokens, Jev input usage, separate collection/inference/render/user-wait timings, actual prices and cost. All NOT RUN/unknown. Local fixture elapsed times cannot be compared with screenshot attempts. |

The earlier tests supplied synthetic usage values (10 input / 2 output per stub call) solely to test usage accounting. Those values are not measured model consumption. The machine-readable evaluation uses null usage/cost to avoid conflating the two. No savings, productivity, subscription allowance or host/Jev quality comparison is established. COLD/ON_TRACK/HOT/RESERVE/CAPPED/STALE are calculated only in local private results from adequate observed window readings, with tested reserve arithmetic; missing/invalid readings remain UNKNOWN. These deterministic synthetic cases do not validate real quota coverage. Explicit cap episodes and weekly usage readings remain observations, with missing readings unknown.

## Bounded live evaluation proposal — NOT RUN

After obtaining approval covering recipients, bounded candidate contents and a spend ceiling, use the same fixed synthetic source files, period, candidates, questions and output requirements for host and real pinned Jev. First add blind human labels; agent-proposed fixtures alone cannot support quality claims. Default candidate bound is 40 and concurrency 3 (configurable up to 200 candidates and 8 workers). One candidate performs at most 3 ordered calls: selection, grouped classification/privacy, paired-state Switch Check. Thus an uncached default-bound run makes at most 120 transport calls, with a 5-second per-call timeout. Lower explicit bounds are appropriate for the first acceptance run. Exact token/currency estimates are unknown pending provider pricing and tokenizer observations; obtain the budget before running rather than treating this bound as permission.

Report false exclusions, privacy false accepts, preservation failures and abstentions against those labels, plus actual usage, cost, cache hits and stage timings. API key availability and a passed stub response do not establish live acceptance. Private live processing is not authorized by this synthetic run. The local runner intentionally makes no hosted semantic calls and reports explicitly requested Jev unavailable/NOT RUN.

Redaction-preservation and outcome comparisons adapt the Switch Check pattern credited to Lutfiya Miller: does B preserve the relevant facts and action of A? Her approval, authorship, endorsement and prior measurement results are not claimed.

## Standalone participant artifact

Developer build command: `bun build scripts/tokenmax-collection/run.ts --target=node --format=esm --outfile=scripts/tokenmax-collection/collect.mjs`. The resulting self-contained JavaScript artifact runs with `node scripts/tokenmax-collection/collect.mjs --claude SELECTED_DIR --out NEW_DIR`. Participants do not need Bun to execute that artifact. Native TypeScript execution remains unsupported because the reused Jev validator contains syntax beyond Node strip-only support. An actual Node v26.3.0 child-process test executed host and unavailable-Jev metadata paths on a synthetic fixture, trapped fetch attempts, validated outputs through the receiver and observed zero network attempts. Older Node versions were not empirically tested. The artifact is metadata-only and makes no live semantic or Jev calls.

## Independent-review corrections

The local Jev adapter now requires a separate processing policy naming the exact TypeSafe recipient, bounded sanitized-candidate content scope, maximum calls, total input bytes and a per-call spend reservation under an approved ceiling. A credential alone leaves Jev unavailable with zero calls. Synthetic approval requires an injected test transport and cannot invoke the default real transport. Allocation exhaustion stops before transport without retry or host fallback. Reservations are an approved allocation limit, not observed provider cost or a billing guarantee. Actual cost remains unknown. approval-red.txt records the failure before the fix.

The original file header establishes a Codex fork identity before sorting; copied parent metadata cannot rename that child. Inherited events preceding the child start supply cumulative baselines without becoming child usage or active-session evidence. fork-red.txt captures the reproduced failing three-session fixture before correction; the passing regression also reverses file ordering.

Latest complete focused verification after zone and empty-source regressions: 51 tests across eight files, 0 failures; actual names and counts are in verification.txt. No live quality measurement is added by these tests.
