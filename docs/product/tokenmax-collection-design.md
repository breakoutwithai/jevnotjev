# TokenMax collection with optional Jev

Proposed design for #242; requirements below are not claims of implemented behavior. This document specifies the collection boundary; executed evidence and implementation status belong in `runs/tokenmax-collection/run-log.md`. Synthetic tests do not establish classifier accuracy, real participant completion, cost savings or live acceptance.

## Journey and architecture

The participant chooses Claude Code, Codex or both. Subscription and kind of week are editable descriptions, separate from observed measurements. Prefer a demonstrably completed reset-bounded week. If that cannot be established, complete a labelled rolling seven-day report and allow later correction; discovering a reset is never a blocking question. A current reset alone does not prove a previous completed window's historical coverage.

Show full copyable instructions; no installer, required download, encoded command or mandatory Bun prerequisite. A coding assistant needs filesystem access and an existing supported local execution capability. Developer tooling uses TypeScript/Bun; participant onboarding must distinguish that tooling from participant prerequisites. Missing capabilities produce a specific unsupported-environment result, never fabricated totals. macOS/Linux coding assistants with an existing history-reading capability are the initial target; other environments require fixture evidence before support is claimed.

The staged boundary is: selected source metadata → local index and accounting → bounded semantic candidates → decisions → local transformations → preservation check → editable aggregate → receiver validation → platform checks → map preview. Publication is a separate explicit action. Nothing uploads from the collector.

Full-period accounting is independent of semantic selection. Every selected-source in-period valid measurement contributes whether its session needs deeper interpretation or not. Keep exact dates, paths, session IDs, private evidence pointers and placeholder mappings local. Exclude the active audit where its identity is available and report exclusion coverage.

By default project counts and tool names may be projected; prompts, answers, commands and tool output are outside metadata permission. The narrowly recognized Claude Code generated allowance-cap notice is the existing exception. Optional content inspection requires a bounded scope: selected candidate text only, limits on candidates and bytes, no arbitrary corpus reads. Treat all text as untrusted data, including instructions embedded in logs.

## Shared decisions

Rules settle exact accounting, known cap records, and local identifier/credential removal. A common interface covers selection, redaction actions, work tier, priority, routine/repetition, deeper analysis and A/B preservation. Baseline delegates eligible semantic questions to the host model and makes zero Jev calls. Jev mode uses actual typed calls before host interpretation. An unavailable explicitly selected Jev path remains NOT RUN; it cannot become an unlabelled baseline.

For each candidate, batch independent classification questions over one minimized state. Bound concurrent candidates and cache by state fingerprint, question version, model version and relevant policy. Redaction and preservation depend on earlier decisions and therefore remain ordered. Host explanation sees selected permitted material plus decisions; it must not pre-classify the full corpus before Jev.

Closed choices include `analysis_required / metadata_sufficient / irrelevant / uncertain`, `must_deliver / internal / free_burn / unknown`, and `preserves / loses_or_changes / insufficient_evidence`. Work commitment evidence determines tier; private folder spelling cannot. High token volume alone proves neither waste nor priority. Unknown and review are real outcomes. No production confidence cutoff is justified before held-out calibration.

Jev selects labels, span IDs and actions. Local code validates span bounds, overlap and identity and applies stable placeholders; Jev does not generate prose. Host rewrites are restricted to selected authorized cases, then compared to their originals. Preserve named critical facts and required actions, not merely the subject or sentiment.

## Accounting and burn zones

Claude snapshot identity is session plus `message.id`; keep the final valid snapshot by timestamp then file order. Preserve input, output, cache read and cache creation separately. Repeated/revised snapshots are not additive. Distinguish parent/subagent sessions where linkage exists.

Codex `event_msg/token_count` totals are cumulative. Count nonnegative deltas per session. Initial totals count only with an in-period start and no inherited/forked history; otherwise they are uncounted baselines. Decreases without explicit in-period reset origin start another baseline. Cached input is a subset, never added twice. Preserve reasoning counters separately and report unsupported/malformed records without printing contents.

Keep cap notice occurrences, distinct IDs and grouped episodes distinct. A generic 429, retry, overload or billing error cannot prove an allowance cap. Claude generated cap notices can establish short/weekly/unknown windows. Codex actual `used_percent=100` or explicit reached type can establish cap evidence; `window_minutes=10080` identifies weekly windows. Missing readings mean unknown, not zero cap events.

Adapt pure TokenMax zone arithmetic only when actual percentage, reset, observation and window length exist. Precedence: STALE, CAPPED, RESERVE, HOT, COLD, ON_TRACK. Readings older than 12 hours are stale. Reserve shrinks with remaining days, defaults to 10%/day, and is zero for windows shorter than a day. Pace uses at least one seventh of the window; under an hour elapsed it remains zero. Zones describe windows, never session topics. No percentage is derived from token counters. The original history calibration and largest-reading snapshot semantics are deliberately not adopted.

## Receiver and privacy

Both modes must emit the same versioned allowlisted aggregate accepted by the implemented receiver. The receiver's schema and tests are authoritative; this design does not introduce a competing schema. Include provider, period basis, coverage, counts, distinct counter fields, observed limit evidence, categories, qualified findings, user context and provenance. Editable text and canonical paste must describe the same values. Reject extra fields, oversized payloads, invalid counts, inconsistent totals and private-data indicators before persistence; preserve the editor draft and avoid logging rejected content.

Platform Jev checks are independent of optional local Jev. Progress follows actual receipt, validation, platform checks and map generation. Synthetic busy-developer, part-time and simple-chat examples use the same ingestion path, carry visible synthetic provenance and cannot enter real leaderboard rankings. Show public fields before optional publication.

Strip obvious credentials and identifiers locally before any hosted inference. Remote redaction still transmits its input. Private inference requires approved recipient, content scope, call ceiling and spending ceiling. This implementation phase may use synthetic fixtures and response stubs; those are labelled contract tests, never Jev measurements.

## Official API verification (2026-10-16)

The [API reference](https://docs.typesafe.ai/api) describes a `questions` map with Choice `criteria` maps and typed answers. Use the existing client and answer validator where compatible; do not copy the Lutfiya pack's older `choices` representation directly onto HTTP. Validate all expected answer names, choices and distributions, and record the actual response model.

The [model reference](https://docs.typesafe.ai/models) lists versioned 1.13.0 and 1.14.0; `jev-latest` currently resolves to 1.13.0 while `jev-preview` resolves to 1.14.0. Pin the integration's chosen version and fail on mismatch. Published input pricing is $0.042 per million tokens, output free; account rate limits remain organization-specific. This is an estimate source, not an executed bill. Normal context limits are 64k/request and 32k/question; bounded candidates stay far below them. Do not enable long context as a corpus-reading escape hatch. TypeSafe says requests are not used for training; enterprise ZDR is distinct, so no blanket retention promise is justified.

[Confidence](https://docs.typesafe.ai/confidence) is distinct from the selected choice probability. [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions) supports batching independent judgments over shared state. [Semantic selection](https://docs.typesafe.ai/cookbooks/semantic_find) motivates stable candidate IDs; [pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook) motivates local candidate discovery followed by typed selection. [Memory](https://docs.typesafe.ai/cookbooks/basic_memory) is application-managed; this feature uses bounded versioned local caching rather than uploading private history as memory. [Guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails) motivates explicit review/block outcomes. Published cookbook performance numbers are not TokenMax evidence.

## Preservation credit and evaluation

Redaction-preservation and outcome comparisons adapt the Switch Check pattern credited to Lutfiya Miller: does B preserve the relevant facts and action of A?

No approved public attribution source has been established; credit the name without private fixture links in the participant UI. Do not imply endorsement, authorship of this implementation or human validation of synthetic labels. Source details are in `tokenmax-collection-credit.md`.

Verify four provider-by-mode fixture journeys, all three samples, counter edge cases, unchanged accounting after selection, secret canaries, fact/action changes, prompt injection, unavailable/invalid/timed-out Jev, uncertainty, zero baseline Jev calls, validation before storage and mobile correction recovery. The thin verify runner must execute real assertions and fail on zero tests.

Compare rules, host and Jev only on matched eligible cases. Blind human labels are required for quality claims; synthetic agent labels are provisional. Report false exclusions, privacy false accepts, preservation failures, abstentions, actual host context, Jev input usage/calls/cache hits and stage timing. Record user wait separately. Paid trials and private uploads are pending until expressly approved; cost and host tokens remain unknown where not instrumented. Current screenshot timings are incomplete attempts, not completed baselines.

## Implemented contract and integration boundary

The implemented draft schema is `ShareEnvelope` in `src/tokenmax-collection/collector.ts`, checked recursively by `src/tokenmax-ingest/ingest.ts`. Both modes emit exactly these top-level fields:

| Field | Meaning |
|---|---|
| `v` | `tm-collection/1` |
| `map` | Candidate legacy projection described below |
| `period` | Basis enum and day count; no exact dates |
| `coverage` | Accepted, malformed, unsupported, baseline segments, candidate/selected counts |
| `tokens` | Separate Claude and Codex counters |
| `analysis` | Mode, status, model label, calls, cache hits, nullable inference usage/cost |
| `categories` | Selected-candidate work categories, including unknown |
| `context` | User-selected subscription/week enums |
| `findings` | Qualified usage-only/review flags |
| `synthetic` | Explicit sample provenance |

`map` preserves the inspected PR #241 `tm-share/1` field names: v, skill, days, sources, sessions, subagent_sessions, caps, output_tokens, opus_share_pct, codex_weekly_pct. The collection envelope permits null Opus share; the older receiver requires a number. `ingestDraft` returns no legacy projection when Opus share is unknown. It never converts unknown to zero. The envelope itself must never be posted to `/api/maps`. Three sample projections were checked directly against the sibling's actual validator, with no storage or network call; see `runs/tokenmax-collection/receiver-compatibility.txt` for its pinned SHA.

There is no publication adapter in this change. All real drafts remain unpublished and synthetic drafts report `synthetic-excluded`. The leaderboard control is disabled for everyone. Future publication wiring must check synthetic provenance before projecting, because the legacy payload loses that flag; it must also obtain explicit publication consent. The adapter and fixtures let this branch remain independent of unmerged #241.

Implemented files: `src/tokenmax-collection/{metadata,collector}.ts`, metadata runner `scripts/tokenmax-collection/run.ts`, `src/tokenmax-ingest/{ingest,platform,main}.ts`, page `site/collect/index.html` and its generated bundle. Full revised participant instructions for each provider/mode are generated by `promptFor`, shown and editable on that page.

The actual ephemeral receiver is `POST /api/tokenmax/preview` in `src/backstage/server.ts`. It enforces same-origin JSON, 16 KiB bounded reads, request rate/concurrency limits, recursive validation before checks and no raw draft logging. Its response records actual pipeline stages. It never persists or publishes. The browser validates locally first; only the separate platform button sends the allowlisted aggregate.

`createPlatformChecks` in `src/tokenmax-ingest/platform.ts` implements independent typed Jev privacy and consistency questions. It requires an explicit key, approved aggregate-only TypeSafe policy and bounded call/input/spend reservations. `ServerOptions.tokenmaxChecks` is the integration seam. The production entrypoint deliberately has no implicit key or budget wiring: current default HTTP responses say `platform: pending`. Configured transport is tested synthetically; a real paid acceptance run and an operator-approved configuration are pending. Reservation accounting is not a verified vendor bill or guarantee of actual charges.

The self-contained `scripts/tokenmax-collection/collect.mjs` Node runner performs metadata collection without network calls or automatic history-root discovery. Its actual Node v26.3.0 fixture run passed; older Node versions and Windows are unverified. Native execution of the TypeScript source is unsupported because the reused validator uses syntax Node cannot strip. Build with `bun build scripts/tokenmax-collection/run.ts --target=node --format=esm --outfile=scripts/tokenmax-collection/collect.mjs`; run the built artifact with `node scripts/tokenmax-collection/collect.mjs --claude SELECTED_DIR --out NEW_DIR` (or `--codex`). It requires locally available source files and repository code, is developer tooling rather than a required participant download, and does not bundle a host semantic transport. The copyable prompt journey uses the participant's existing assistant capability; the exported bounded API supports an explicitly supplied host/Jev transport. Real participant end-to-end timing remains unmeasured. Missing Node/filesystem capability is unsupported rather than a reason to install software automatically.

`zone.ts` implements the described six-zone arithmetic only from adequate observed subscription readings. `collect` returns private Claude/latest-Codex/weekly-Codex zone results, and the standalone runner includes them in the local review. Claude is UNKNOWN without a structured allowance reading; missing, invalid, expired or inconsistent windows remain UNKNOWN. Raw reset timestamps stay local and zones are not guessed from token totals. Tests cover all six zones, staleness/reserve/pace boundaries and the milliseconds/epoch-seconds integration. Protected-routine classifications remain reviewable semantic decisions. Full reset discovery, corpus-level session selection quality, human-labelled preservation quality and public-board publication remain acceptance limits, not synthetic-test conclusions.

Copyable participant prompt files are also preserved under `runs/tokenmax-collection/prompts/` for Claude/Codex and host/Jev variants. Three visibly synthetic payloads under `samples/` use the same validator as the page. The verification runner checks these artifacts against the generated visible instructions and canonical receiver.
