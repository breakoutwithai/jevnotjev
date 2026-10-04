# Issue 67: Jev-first Backstage

Governing scope: https://github.com/breakoutwithai/jevnotjev/issues/67. This slice extends the six-room MVP with real selected-provider calls. Implementation does not constitute deployment or live-provider acceptance.

Acceptance IDs below reproduce the Jev-first extension in issue #67 (read 2026-10-04). Tests may cover more than one criterion; their descriptive titles identify the behavior, while this table preserves the governing numbering.

- JF1: Jev is sufficient to start. Competitors and the local rule are optional, unselected by default. Missing/invalid competitor keys affect only their arms, never discard Jev results.
- JF2: A dated public catalog identifies exact models and their official source documents. Separate arm IDs preserve multiple models from one provider across dispatch, retry, labels and exports. No silent model substitution.
- JF3: Use fixed native provider endpoints and explicit generation parameters; requested/returned identities and incomplete output are checked. OpenAI/xAI requests disable response storage. Unknown pricing stays null.
- JF4: Preserve jnj-record/1 using one compatible cohort/CSV per comparator, with original attempt IDs mapped in evidence. Reused Jev observations are disclosed; unique attempts are charged once in total spend. No pooled winner.
- JF5: Clear keys stops further dispatch and clears application-held keys. Export/copy/error paths exclude keys. Copy the exact decision for Playground or local CLI; use environment placeholders. Show a neon-accented, precise privacy notice and jev@breakoutwithai.com contact; no unverified retention promise.
- JF6: A real small Jev-only no-key trial remains disabled until a dedicated funded key, signing secret, durable atomic quota ledger and explicit daily budget are configured. No private burner key reuse. Budget reservations and unknown-charge holds survive restart; no mocked trial answers.
- JF7: Protocol/catalog/build mismatches fail before upstream dispatch. Test model separation, invalid-key isolation, export round-trips, clearing during runs, replay/concurrency and quota exhaustion. Real provider/browser acceptance remains separate from controlled transport tests.

M1 delivers JF1–JF5 and the BYOK portions of JF7. M2 delivers the disabled-by-default funded trial and its accounting/infrastructure tests. Funding is not a dependency of BYOK delivery.

Catalog documentation checked 2026-10-04: [TypeSafe](https://docs.typesafe.ai/models), [Anthropic](https://platform.claude.com/docs/en/models/overview), [OpenAI](https://developers.openai.com/api/docs/models), [Google](https://ai.google.dev/gemini-api/docs/models), [xAI](https://docs.x.ai/developers/models). Catalog source verification is separate from account availability and live output verification.

Backstage uses its own v2 transport contract while preserving jnj-record/1 CSV compatibility. Multiple LLMs never share one legacy answerer slot inside a cohort. Each pair reuses the same Jev observation, so only native unique attempts determine total spend. Failed/unknown attempts remain in evidence, not fabricated answer rows. A header-only failed-run export is not an evaluation dataset.

No infrastructure-wide key-retention guarantee is made. Trial setup and rollout must follow the separately reviewed [deployment contract](../backstage-deploy.md); no funded secret is delivered by an application release.
