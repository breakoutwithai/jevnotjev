# Jev!Jev: scope on one page

## Product
Jev!Jev helps decide whether one typed decision in your workflow should go to Jev, a simple rule, or the LLM you use now. You record what each of the three chose and what it cost on 30 or more of your own cases, mark which answers you would keep, and it reports cost per accepted result with a cautious verdict that holds for those cases only ([README.md:5](README.md), [FLOW.md:3](FLOW.md)).

## Flagship use case: TokenMax
More accepted results from the same token budget. In the repo it is UC11 ([use-cases/README.md:32](docs/product/use-cases/README.md), [uc11-cv-vs-job-ad.md:3](docs/product/use-cases/uc11-cv-vs-job-ad.md)).

## First workflow
UC11, a CV against a job ad: one yes/no question per ad line, asked of each CV. The spec names it the default sample ([spec.md:91](docs/spec/spec.md)) and the default name until decided ([spec.md:158](docs/spec/spec.md)); the repo has no later document that replaces it. Its worked hand calculation is [examples/d06-tiny](examples/d06-tiny/). A second recorded run, UC13 (a shop bot that answers or hands off), is in [docs/product/runs/2026-10-01-uc13-shop-bot](docs/product/runs/2026-10-01-uc13-shop-bot/) and is not the first workflow.

## Acceptance rule
An accepted result is an output a person marks "accept" under one written rule: correct and complete enough to use without edits, labelled blind to which method gave it ([FLOW.md:11](FLOW.md)). The verdict (use Jev, don't, or not enough evidence) follows [verdict-rules.md](docs/decision/verdict-rules.md) (order of checks at [line 53](docs/decision/verdict-rules.md)); fewer than 30 paired labelled cases is always "not enough evidence".

## Not in scope
- Many workflows at once, production integrations, sensitive data (synthetic or redacted cases only), claims beyond the user's own test set, and pooling or sharing subscriptions ([FLOW.md:12](FLOW.md)).
- Asking Jev "which model" to use ([FLOW.md:8](FLOW.md)); the dropped prompt router is historical ([FLOW.md:9](FLOW.md)).
- Tasks that are not a typed answer on one text: counts or exit-code checks, diffs and document bundles, retrieval, free-text output, and decisions where one wrong answer is not survivable ([when-not-to-use-jev.md](docs/product/use-cases/when-not-to-use-jev.md)).
- A claim that Jev is better in general. The evidence so far is synthetic or AI-drafted and approved by a person; see what is open in [docs/challenge/EVIDENCE.md](docs/challenge/EVIDENCE.md).
