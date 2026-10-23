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
- On the TokenMax page, Jev is shown as an example in rehearsal and has not been run on your usage. [Source](../site/tm/index.html) <!-- claim: tm-jev-rehearsal -->

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
- Google sign-in for Backstage and paid comparisons are deferred beyond v0 (issue #77). [Source](RELEASE-v0.1.0.md) <!-- claim: backstage-deferred -->
- The admin page, API and MCP connector have been exercised only by the operator and by scripted tests, not by an outside user. [Source](RELEASE-v0.1.0.md) <!-- claim: admin-exercised -->
- The TokenMax prompt asks your assistant about Claude Code and Codex history only; other assistants are not asked about. [Source](../site/tm/index.html) <!-- claim: tm-claude-codex -->
- The TokenMax page reads the last 7 days or the last 8 weeks; over 7 days it shows per-week averages, each self-reported total divided evenly by days / 7, not verified and not a measured week, and a Sessions per day line shows as not recorded unless it has one number per day for a period of 8 to 90 days, or seven numbers otherwise. [Source](../src/browser/tm-week.ts) <!-- claim: tm-eight-weeks -->
- The remote admin MCP connector uses a bearer token today; OAuth sign-in is planned and not built yet. [Source](guest-access.md) <!-- claim: connector-bearer -->
- Whether a Claude app sends an Origin header to the remote admin MCP connector is not verified; if it sends its own web origin, every call is refused with 403 until that origin is allowed. [Source](guest-access.md) <!-- claim: connector-origin -->
- A reply sent with emoji as JSON surrogate-pair escapes takes twelve bytes a character, so an all-emoji reply within the 8,000-character limit can still be refused with 413 by the 64 KiB request cap; how Claude's client encodes a reply over the remote connector is not verified. [Source](guest-access.md) <!-- claim: reply-escapes -->
- The remote guest MCP endpoint uses a guest bearer token and has no OAuth; whether Claude's hosted apps send an Origin header to it is not verified. [Source](guest-access.md) <!-- claim: guest-connector -->
- The guest MCP adapter runs as a local stdio server (`src/guest-intake/mcp.ts`) and as a remote MCP Streamable HTTP endpoint at /api/v1/guest/mcp for Claude's hosted apps, which cannot run the stdio adapter; the remote endpoint is stateless, answers an authenticated GET or DELETE with 405, and has a 64 KiB request cap, a 256 KiB response cap and a 30-second deadline per request. [Source](guest-access.md) <!-- claim: guest-transport -->
- No consented outside user's own run from start to verdict is documented yet; the next step is to invite one and document it. [Source](RELEASE-v0.1.0.md) <!-- claim: no-outside-run -->
- A remote admin MCP request can run past its 30-second deadline by a database lock wait; a call whose client disconnects still runs until it completes or reaches the deadline, and a reply answered 504 may still have been stored. [Source](guest-access.md) <!-- claim: admin-deadline -->
- The admin token header must spell the scheme `Bearer`; `bearer` or `BEARER` is refused. [Source](guest-access.md) <!-- claim: bearer-scheme -->
- Responses under /api/v1/guest/ that nginx forwards from the app carry two X-Content-Type-Options: nosniff headers and two Referrer-Policy headers, no-referrer from the app and strict-origin-when-cross-origin from nginx; issue #369 rates this low severity for a JSON API called with bearer tokens, and it is disclosed here, not fixed. [Source](../src/guest-intake/guest-routes.ts) <!-- claim: duplicate-headers -->
- The TokenMax week map shows only the block you paste back from your own Claude Code or Codex after running its prompt; every number on the page comes from that block. [Source](../src/browser/tm-week.ts) <!-- claim: tm-pasted -->
- On the TokenMax week map, a line your assistant could not fill, or one the page cannot read, is shown as not recorded; nothing is invented in its place. [Source](../src/browser/tm-week.ts) <!-- claim: tm-not-recorded -->
- The /guide/ page's collapsed field guide is headed "Backstage workspace, deferred beyond v0" and still describes the Backstage workspace (issue #261). [Source](../site/guide/index.html) <!-- claim: guide-text-only -->

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
- A question sent from the ask page is read and answered by a person; it is never sent to a model provider and no Jev run happens. [Source](../site/privacy/index.html) <!-- claim: question-human -->
- Your email is not checked and no reply is emailed to it; the reply appears on the ask page under your status code. [Source](../site/privacy/index.html) <!-- claim: question-email -->
- Questions have no retention period yet and nothing is deleted automatically; a person deletes one by hand on request. [Source](../site/privacy/index.html) <!-- claim: question-retention -->
- Operator tools such as a Claude connector may send question text to a model provider when an operator connects one, which differs from the ask page promise that no model provider sees your question, so the connector is not run on visitor rows without the visitor's consent. [Source](guest-access.md) <!-- claim: connector-model -->
- An operator token is not bound to one endpoint: the same token works on the admin API and the remote admin MCP connector. [Source](guest-access.md) <!-- claim: token-audience -->
- Admin routes run before the server's concurrency slot and have no per-IP rate limit. [Source](guest-access.md) <!-- claim: admin-rate-limit -->
- A question's text is untrusted: it can instruct the operator's agent to copy other visitors' emails or questions into a reply its sender reads, so the operator reads each reply before approving it. [Source](guest-access.md) <!-- claim: visitor-text -->
- On the TokenMax page, reading a pasted week and Show my week happen in your browser; nothing is sent until you press Submit. [Source](../site/tm/index.html) <!-- claim: tm-browser -->
- Submit sends the numbers mapped from your pasted block, a nickname you choose and a generated request key to the public board at /maps/, and the nickname is public. [Source](../site/tm/index.html) <!-- claim: tm-submit-sends -->
- The board shows a submitted TokenMax week as self-reported and not verified; the numbers come from your own assistant's pasted block. [Source](../site/tm/index.html) <!-- claim: tm-self-reported -->
- Submit is refused when a required line is not recorded or a number cannot be held, with a message naming the line. [Source](../src/browser/tm-submit.ts) <!-- claim: tm-submit-refused -->
- The TokenMax page keeps the delete key and retry key only in its own memory, not in browser storage, and removes an older key an earlier version stored there; the server keeps the submitted row with no automatic deletion date until its delete link is used. [Source](../site/tm/index.html) <!-- claim: tm-storage -->
- If you reload or close the TokenMax page, it no longer has the key that removes your entry, and pressing Submit again sends a new key and can add a second row. [Source](../site/tm/index.html) <!-- claim: tm-key-lost -->
- A TokenMax Submit on a stalled or failed connection may or may not have reached the board; pressing Submit again on the same page for the same result and nickname does not add a second row. [Source](../src/browser/tm-run.ts) <!-- claim: tm-stalled -->
- The board does not detect the same result shared under another nickname, from another page load or by the mapper and the page, so its totals count shared maps, not distinct people, and one nickname can have several rows. [Source](../site/maps/maps.js) <!-- claim: board-counts-maps -->
