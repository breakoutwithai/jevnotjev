# TokenMax: comparison flow

TokenMax lets a builder compare one workflow across three approaches on their own test cases, and reports cost per accepted result with a cautious verdict: use Jev, don't use Jev (!Jev), or not enough evidence.

Diagram: [docs/product/flow/comparison.html](docs/product/flow/comparison.html) (source: `comparison.dataflow.json`, rendered with archify).

## Scope (v1)
- **Workflow:** one decision point with a fixed answer space. First one: routing a coding prompt to Haiku, Sonnet or Opus.
- **User:** a builder who runs LLM calls in their workflow and wants to know if Jev can make some of those decisions cheaper without losing quality.
- **Accepted result:** an output a person (or a checked Jev pre-grade) marks "accept" under one written rule: correct and complete enough to use without edits.
- **Out of scope:** many workflows at once; production integrations; sensitive production data (synthetic or redacted cases only); claims beyond the user's own test set; pooling or sharing subscriptions.

## Journey
1. Describe the workflow and the decision it makes.
2. Add a small test set of cases.
3. Run the same cases through the three arms.
4. Label each output accept or reject.
5. Read the metrics and the verdict.

## The three arms
| Arm | What runs | Inputs it needs |
|---|---|---|
| A. LLM only | the builder's current model call | the case, the builder's prompt, a model id |
| B. Simple baseline | a rule or a cheap model | the case and the rule (e.g. prompt length, keyword list) |
| C. Jev routing | Jev makes the decision, then the chosen path runs | the case, the question, the answer options (criteria) |

## Metrics and where each number comes from
| Metric shown | Input source |
|---|---|
| Latency per case | client wall clock around each call |
| Input and output tokens | the API's usage fields (Jev: `usage.input_tokens`, `usage.output_tokens`; Claude: `usage`) |
| Spend | Jev: input tokens x $0.042 per million, output free; Claude: `total_cost_usd` from the CLI; rule: 0 |
| Accepted count | acceptance labels (accept / reject per output) |
| Cost per accepted result | spend / accepted count, per arm |
| Accuracy | arm decisions compared with the acceptance labels |
| Jev confidence | `answers.<question>.confidence` in the Jev response |
| Verdict | cost per accepted result and accuracy across arms (rule below) |

## Verdict rule
- **Use Jev:** Jev's arm has the lowest cost per accepted result with accuracy equal to or better than the others.
- **!Jev:** another arm beats Jev on both.
- **Not enough evidence:** too few cases or labels to tell.

The verdict describes the builder's test set only, not production.

## First measurement
[docs/benchmarks/2026-09-27-grading-speed-cost.md](docs/benchmarks/2026-09-27-grading-speed-cost.md): the metric sources above, exercised on 90 synthetic items.
