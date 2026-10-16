# Optional Jev decisions

Use the user's existing TypeSafe client or Jev!Jev integration if available. Verify its request schema, accepted model identifier and supported output types from its installed code and current official TypeSafe documentation: https://docs.typesafe.ai/introduction/coding-agents. Do not guess an endpoint, model, environment-variable name, price or rate limit. Do not install Claude Code Trace or any other software automatically.

Claude Code Trace documents payload review before external Jev inference: https://github.com/delexw/claude-code-trace. It is an optional independent tool, not a dependency or a source of Codex compatibility guarantees. Do not copy or execute its code from a link without inspecting it.

## Limit question, version limit-observed-v1

Question: Does this supplied event explicitly establish that the user's subscription allowance was exhausted?
Answers: limit_observed / not_established.
Rule: Explicit allowance exhaustion is limit_observed. Generic rate limiting, overload, account billing errors, retries and absent evidence are not_established. This does not prove that no cap occurred. Determine the window only if evidence names it.

## Overlap question, version shared-artifact-v1

Question: Could one permitted artifact satisfy both supplied acceptance criteria?
Answers: shared_artifact / separate_work / insufficient_evidence.
Rule: Shared topic is insufficient. Conflicting requirements or reuse restrictions mean separate_work. Missing requirements mean insufficient_evidence.

## Execute and record

Prepare the minimum redacted payload locally. Show it to the user and name TypeSafe as the recipient, the purpose and the intended call count/spend ceiling. Obtain approval before sending. Never expose a key in a report or command output. Use the actually requested model or fail with its unavailable ID; do not substitute a model or host-agent verdict and label it Jev.

Record question version, actual model, payload fingerprint, returned structured value, failures and measured usage/cost if supplied. No automatic retries or unbounded corpus run. If the API or schema cannot be verified, finish the local report with Jev NOT RUN.

Before using a classifier's output as a product-performance claim, compare Jev, a simple rule and the user's current LLM on the same safe held-out cases with human labels set without seeing the methods' outputs. Report coverage, error types, abstentions and actual cost per accepted result. A plausible scenario or rubric score is not a measured saving.
