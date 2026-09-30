Primary user: a builder who runs LLM calls in their workflow, keeps hitting usage limits, and wants to know whether letting Jev make one decision in that workflow gets more accepted results from the same token budget, before trusting it. The flagship use case, TokenMax, asks this for the token budget itself; other use cases ask it for other decisions.

# Jev!Jev user journeys (v1)

Jev!Jev is a small web tool that compares one workflow across three approaches on the user's own test cases and reports cost per accepted result with a cautious verdict: use Jev, don't use Jev, or not enough evidence.

## The one workflow in v1

One decision point with a fixed answer set, asked as a typed question; code maps each answer to the next step (`FLOW.md`, Scope). The user chooses the decision.

Historical: v1 first named the Claude Code prompt router (Jev picks Haiku, Sonnet or Opus per prompt). That router was dropped on 2026-09-28 and is superseded; no replacement workflow is chosen here.

| Approach | What it means for this workflow |
|---|---|
| LLM only (current setup) | What the user does today at this decision, usually their LLM. |
| Simple baseline | A plain rule written before labelling makes the decision, with no Jev call. |
| Jev routing | Jev answers the typed question per case; the Jev call cost is included. |

Accepted result: the user, reading the answer, marks it as good enough to use without re-asking.

Cost per accepted result: total spend for an approach (model tokens plus any Jev calls) divided by the number of its answers the user accepted.

## Journey J1: from a set of cases to a first verdict

1. The user opens Jev!Jev and sees the one supported workflow, what it compares, and that cases should be synthetic or redacted.
2. The user adds a small test set of cases from their own workflow (synthetic or redacted).
3. The user supplies results and costs for the three approaches in the one documented file format.
4. The user labels each answer accepted or not accepted.
5. Jev!Jev shows cost per accepted result for each approach, side by side.
6. Jev!Jev shows the verdict and states that it is evidence from this test set only, not a promise about production.

## Journey J2: checking whether Jev's answers can be trusted

1. From the verdict, the user opens the per-case view.
2. The user sees, for each case, what each approach picked and whether that result was accepted.
3. The user sees wins and losses against Jev per case: Jev accepted and the other approach not, or the reverse (`FLOW.md`, Metrics).
4. The user sees whether Jev's confidence separated right answers from wrong ones, including wrong answers given with high confidence.
5. The user decides whether to add more cases, change the baseline rule, or act on the verdict.
