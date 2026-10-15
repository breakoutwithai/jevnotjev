# Known limits (v0)

What a Jev!Jev verdict covers, what it needs, and what is not supported or tested. Each bullet states one limit and links the file it comes from. `src/docs/limits.test.ts` fails if a bullet changes or its source no longer says it.

## 1. What the verdict establishes and what it does not

- These results are for this test set only, not production. [Source](decision/verdict-rules.md) <!-- claim: test-set-only -->
- Use Jev means the 95% interval puts Jev's accept rate no more than 10 points below the LLM's; it does not mean Jev is as accurate. [Source](decision/verdict-rules.md) <!-- claim: use-jev-accuracy -->
- Use Jev also needs Jev's cost per accepted answer to be 0.8 or less of the LLM's, with the 95% upper bound of that ratio below 1. [Source](decision/verdict-rules.md) <!-- claim: use-jev-cost -->
- In the simulation behind the settings, which assumes an outcome correlation of 0.5 between Jev and the LLM, a Jev exactly 10 points worse most often gets not enough evidence at 30 paired cases. [Source](decision/verdict-rules.md) <!-- claim: simulation -->
- Beyond the 30-case minimum, the verdict does not say how many more cases would settle it. [Source](decision/verdict-rules.md) <!-- claim: no-case-count -->
- A refused, failed or unsupported answer has no label and drops out of the pairing, so accept rates do not show how often an answerer refuses or fails. [Source](../format/README.md) <!-- claim: dropped-rows -->
- An agent label that nobody reviewed is never counted as truth. [Source](../format/README.md) <!-- claim: agent-labels -->
- The results page shows labels and costs as recorded in the file and does not check how they were produced. [Source](../scripts/result-view.ts) <!-- claim: labels-as-recorded -->
- Decisions API answers are recorded, but the verdict reads Jev, the LLM and the rule only. [Source](../format/README.md) <!-- claim: decisions-arm -->

## 2. Evidence required

- A labelled test file in the jnj-record format. [Source](decision/verdict-rules.md) <!-- claim: labelled-record -->
- At least 30 paired labelled Jev and LLM cases; fewer gives not enough evidence. [Source](decision/verdict-rules.md) <!-- claim: min-paired -->
- A cost_usd on every paired Jev and LLM row; a missing one gives not enough evidence. [Source](decision/verdict-rules.md) <!-- claim: cost-required -->
- With no rule rows or fewer than 30 paired rule cases, the rule comparison is skipped and the verdict comes from Jev against the LLM only. [Source](decision/verdict-rules.md) <!-- claim: rule-skipped -->

## 3. Unsupported or untested

- Backstage tests only a question with exactly two answers (issue #122). [Source](../src/backstage/contracts.ts) <!-- claim: two-answer-choice -->
- Inputs are text cases. [Source](RELEASE-v0.1.0.md) <!-- claim: text-inputs -->
- The release check (`bun scripts/release-check.ts`) uses a recorded Jev response and makes no paid provider call. [Source](RELEASE-v0.1.0.md) <!-- claim: release-recorded -->
- The release check does not exercise the HTTP surface or a hosted deployment. [Source](RELEASE-v0.1.0.md) <!-- claim: release-no-http -->

## 4. Data and trust

- Use made-up or redacted cases: a case you run goes to each provider you select. [Source](../site/privacy/index.html) <!-- claim: made-up-cases -->
- Backstage does not save cases, runs or keys to a file or database on the server. [Source](../site/privacy/index.html) <!-- claim: no-server-save -->
- Requests pass through the server and its web server may hold requests briefly while relaying. [Source](../site/privacy/index.html) <!-- claim: relay-buffer -->
- An unfinished scene draft is saved in the browser tab's storage. [Source](../site/privacy/index.html) <!-- claim: draft-in-tab -->
- The server does keep ticket-form details including your email, an operators file of sign-in emails and password hashes, and event logs with sign-in email and IP address. [Source](../site/privacy/index.html) <!-- claim: server-keeps -->
- A ticket row is deleted only by an operator on request; there is no self-service deletion. [Source](../site/privacy/index.html) <!-- claim: deletion -->
- The credential scan matches listed key shapes; a key in another shape, including the Jev key, is not caught. [Source](product/what-is-stored.md) <!-- claim: scan-shapes -->
- The evidence export check tests reproducibility and looks for leaked credentials; it does not prove an export is authentic. [Source](product/what-is-stored.md) <!-- claim: export-check -->
- Provider retention and deletion policies are unknown beyond the application code. [Source](../site/privacy/index.html) <!-- claim: provider-retention -->
