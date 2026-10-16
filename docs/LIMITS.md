# Known limits (v0)

What a Jev!Jev verdict covers, what it needs, and what is not supported or tested. Each bullet states one limit and links the file it comes from. `src/docs/limits.test.ts` fails if a bullet changes or its source no longer contains the quoted text.

## 1. What the verdict establishes and what it does not

- These results are for this test set only, not production. [Source](decision/verdict-rules.md) <!-- claim: test-set-only -->
- Use Jev means the 95% interval puts Jev's accept rate less than 10 points below the LLM's; it does not mean Jev is as accurate. [Source](decision/verdict-rules.md) <!-- claim: use-jev-accuracy -->
- Use Jev also needs Jev's cost per accepted answer to be 0.8 or less of the LLM's, with the 95% upper bound of that ratio below 1. [Source](decision/verdict-rules.md) <!-- claim: use-jev-cost -->
- When the rule is compared, a 95% interval that puts the rule's accept rate less than 10 points below Jev's gives don't use Jev; a free rule that does the job wins. [Source](decision/verdict-rules.md) <!-- claim: use-jev-rule -->
- In the simulation behind the settings, which assumes an outcome correlation of 0.5 and an LLM accept rate of 0.8 or 0.9, a Jev exactly 10 points worse than the LLM most often gets not enough evidence at 30 paired cases. [Source](decision/verdict-rules.md) <!-- claim: simulation -->
- Beyond the 30-case minimum, the verdict does not say how many more cases would settle it. [Source](decision/verdict-rules.md) <!-- claim: no-case-count -->
- A refused, failed or unsupported answer has no label and drops out of the pairing, so the verdict's accept rates and cost per accepted answer leave it out; the answerer's row count and total cost still include it. [Source](../format/README.md) <!-- claim: dropped-rows -->
- An agent label that nobody reviewed is never counted as truth. [Source](../format/README.md) <!-- claim: agent-labels -->
- The results page shows labels and costs as recorded in the file and does not check how they were produced. [Source](../scripts/result-view.ts) <!-- claim: labels-as-recorded -->
- Decisions API answers are recorded, but the verdict reads Jev, the LLM and the rule only. [Source](../format/README.md) <!-- claim: decisions-arm -->

## 2. Evidence required

- A labelled test file in the jnj-record format. [Source](decision/verdict-rules.md) <!-- claim: labelled-record -->
- At least 30 paired labelled Jev and LLM cases; fewer gives not enough evidence. [Source](decision/verdict-rules.md) <!-- claim: min-paired -->
- A cost_usd on every paired Jev and LLM row; a missing one gives not enough evidence. [Source](decision/verdict-rules.md) <!-- claim: cost-required -->
- With no rule rows or fewer than 30 paired rule cases, the rule comparison is skipped and the verdict comes from Jev against the LLM only. [Source](decision/verdict-rules.md) <!-- claim: rule-skipped -->

## 3. Unsupported or untested

- The simulation does not cover true drops above 10 points, LLM accept rates below 0.8 or missing labels. [Source](decision/verdict-rules.md) <!-- claim: sim-untested -->
- Backstage tests only a Choice question with exactly two answers (issue #122). [Source](../src/backstage/contracts.ts) <!-- claim: two-answer-choice -->
- Inputs are text cases. [Source](RELEASE-v0.1.0.md) <!-- claim: text-inputs -->
- The release check (`bun scripts/release-check.ts`) uses a recorded Jev response for `run` and makes no paid provider call. [Source](RELEASE-v0.1.0.md) <!-- claim: release-recorded -->
- The release check does not exercise the HTTP surface. With `--url` it compares only the static site's `/DEPLOYED_SHA` to the candidate commit and does not check the backend or any other module. [Source](RELEASE-v0.1.0.md) <!-- claim: release-no-http -->

## 4. Data and trust

- Use made-up or redacted cases: a case you run goes to each provider you select. [Source](../site/privacy/index.html) <!-- claim: made-up-cases -->
- Backstage does not save cases, runs or keys to a file or database on the server. [Source](../site/privacy/index.html) <!-- claim: no-server-save -->
- Requests pass through the server and its web server may hold requests briefly while relaying. [Source](../site/privacy/index.html) <!-- claim: relay-buffer -->
- An unfinished scene draft is saved in the browser tab's storage. [Source](../site/privacy/index.html) <!-- claim: draft-in-tab -->
- Among other records, the server keeps ticket-form details including your email, an operators file of sign-in emails and password hashes, and event logs with sign-in email and IP address; the privacy page section What we keep has the rest. [Source](../site/privacy/index.html) <!-- claim: server-keeps -->
- The ticket office has no automatic or self-service deletion: an operator deletes a ticket row on request. [Source](../site/privacy/index.html) <!-- claim: deletion -->
- The evidence export check matches listed key shapes and exact supplied key values; a key in another shape that was not supplied, such as a Jev key, is not caught. [Source](product/what-is-stored.md) <!-- claim: scan-shapes -->
- The evidence export check tests reproducibility and looks for leaked credentials; it does not prove an export is authentic. [Source](product/what-is-stored.md) <!-- claim: export-check -->
- Retention and deletion policies of model providers and other infrastructure are unknown beyond the application code. [Source](../site/privacy/index.html) <!-- claim: provider-retention -->
