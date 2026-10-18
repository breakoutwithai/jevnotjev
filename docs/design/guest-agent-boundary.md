# Guest questions: is an agent layer needed?

Issue: #256 (child of #253). Spec: `docs/product/guest-intake.md`. Status: decision note. Nothing here is built.

## Decision

No agent layer for the first release. A question is a form or a guest API/MCP call, a durable row, an operator CLI review and a person-written reply. That already gives the visitor a receipt, a status and a reviewed answer, with one owner for every step. A platform agent would only relay text that the CLI already moves.

The guest's own Claude Code or Codex can help them prepare a question: the `/ask/` receipt and the reviewed replies carry prompts to try in their own assistant. That spends the guest's tools, not ours.

## Options compared

| Option | What it adds | Cost and risk | When |
|---|---|---|---|
| 1. Deterministic intake, manual review | Nothing beyond what ships | One operator reads every row | Now |
| 2. On-demand draft assistant | The operator asks for a draft clarification or reply for one row, then edits it | A provider call per draft; untrusted text in a prompt | After measured review load or repeated confusion |
| 3. Durable background draft worker | Drafts appear for queued rows without a request | Everything in option 2, plus jobs, retries, restarts and a second write path | When asynchronous throughput is the bottleneck |

Move from option 1 only on evidence, recorded in #253 before any build:

- Review load: the queue's own numbers (rows per week, time from `pending_review` to a decision, from `question_events`) show the operator cannot keep up.
- Repeated confusion: the same `needs_info` template sent for a large share of rows, so a draft would remove a step a person now repeats.

Neither number exists yet. Neither is a reason to add a model on day one.

## Before choosing a model

Name the exact missing capability first: for example "draft a `needs_info` note from the question text" or "propose two fixed answers and three made-up cases". Then pick the smallest model that does that one job.

OpenRouter, DeepSeek and any other provider are candidates only. Their current model ids, prices, data retention, routing and SDK compatibility are UNVERIFIED here and are not researched in this slice; settle them from each provider's current primary documentation when an evaluation is authorized. No provider is wired and no evaluation call is made now.

## If option 2 or 3 is ever built

### Shape

- Draft only. A model output is a proposal stored beside the row. Only the operator CLI turns it into a state change, a reply or anything a person outside sees.
- Provider-neutral: one adapter interface (`draft(input) -> { text, model, usage }`), chosen by configuration, with a fake for tests. No provider SDK types leak past it.
- Small deterministic tools only: read one row's question text, read the template list, write one draft. No shell, no broad filesystem, no network beyond the configured provider, no auto-loaded skills or MCP servers, no model-defined tools.
- A skill is versioned guidance plus an explicit tool allowlist. It grants nothing by itself and is never built from user input.
- Question text is untrusted data. It cannot change the worker's instructions, tools, recipient or authority, whatever it says.

### Durability (option 3)

- Transactional outbox: the row's state change and the job that follows it are written in one SQLite transaction.
- Versioned state and a cursor. A job's output and the cursor that marks it done are committed together, so a restart neither loses nor repeats work.
- Leased jobs with an owner and an expiry; a crashed worker's lease lapses and another takes the job.
- Bounded retries with backoff, an attempt budget and a timeout per attempt; past the budget the job goes to a dead-letter table for a person.
- Intent before side effect: record what is about to happen, then do it, then record the outcome.
- Idempotency keys at every receiver, so a retried draft write is one draft.
- An attempt that timed out with an unknown outcome is not retried blindly; it is marked ambiguous and checked first.
- Cancellation: a deleted or withdrawn row cancels its jobs, and a running job checks before it writes.
- Tests that kill the worker mid-job and resume it, and that replay the outbox after a restart.

### Approval and dispatch

- An approval binds the exact draft content hash, the action, the recipient and an expiry. Editing the draft invalidates the approval.
- At dispatch, check again: the row still exists and is not deleted, the guest token (if any) is not revoked, the approval matches the hash and has not expired.
- No automatic email, publication or other outbound send. Any send is its own explicit operator action.

### Logging

- Log each real tool call as an event (tool, row id, outcome, duration), with question text, emails and tokens redacted. A run that logs zero tool events when tools were called is a defect.

## Not in this slice

A worker, a provider adapter, a model choice, provider research, and any automatic reply, email or publication.
