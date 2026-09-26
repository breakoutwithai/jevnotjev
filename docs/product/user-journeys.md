Primary user: a solo builder who runs Claude Code on their own paid plan, keeps hitting usage limits, and wants to know whether letting Jev pick Haiku, Sonnet or Opus for each prompt gets more accepted answers from the same allowance, before trusting a router nobody has measured.

# TokenMax user journeys (v1)

TokenMax is a small web tool that compares one workflow across three approaches on the user's own test cases and reports cost per accepted result with a cautious verdict: use Jev, don't use Jev, or not enough evidence.

## The one workflow in v1

A Claude Code prompt router. For each prompt, Jev picks which model should answer it: Haiku, Sonnet or Opus.

| Approach | What it means for this workflow |
|---|---|
| LLM only (current setup) | Every prompt goes to the model the user runs today. |
| Simple baseline | A plain rule picks the model (for example, by prompt length), with no Jev call. |
| Jev routing | Jev picks the model per prompt; the Jev call cost is included. |

Accepted result: the user, reading the answer, marks it as good enough to use without re-asking.

Cost per accepted result: total spend for an approach (model tokens plus any Jev calls) divided by the number of its answers the user accepted.

## Journey J1: from a set of prompts to a first verdict

1. The user opens TokenMax and sees the one supported workflow, what it compares, and that cases should be synthetic or redacted.
2. The user adds a small test set of prompts they would really send to Claude Code.
3. The user supplies results and costs for the three approaches in the one documented file format.
4. The user labels each answer accepted or not accepted.
5. TokenMax shows cost per accepted result for each approach, side by side.
6. TokenMax shows the verdict and states that it is evidence from this test set only, not a promise about production.

## Journey J2: checking whether the router's picks can be trusted

1. From the verdict, the user opens the per-prompt view.
2. The user sees, for each prompt, which model Jev picked and whether that answer was accepted.
3. The user sees how often Jev picked the cheapest model whose answer was still accepted (router pick accuracy).
4. The user sees whether Jev's confidence separated right picks from wrong ones, including wrong picks made with high confidence.
5. The user decides whether to add more cases, change the baseline rule, or act on the verdict.
