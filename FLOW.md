# TokenMax: comparison flow

Take 30 or more examples of one decision your workflow already makes. Record what your current setup, a simple rule and Jev each chose and what it cost, and mark which answers you would keep. TokenMax shows the cost per answer you would keep for each, with a cautious verdict (use Jev, don't use Jev, or not enough evidence) that holds for those examples only.

Diagram: [docs/product/flow/comparison.html](docs/product/flow/comparison.html) (source: `comparison.dataflow.json`, rendered with archify).

## Scope (v1)
- **Workflow:** one decision point with a fixed answer set, asked as a typed question. First one: "How hard is this coding prompt? trivial / ordinary / hard"; code maps the answer to Haiku, Sonnet or Opus. Jev is never asked "which model".
- **User:** a builder who runs LLM calls in their workflow and wants to know if Jev can make some of those decisions cheaper without losing quality.
- **Accepted result:** an output a person marks "accept" under one written rule: correct and complete enough to use without edits. Labels are blind to which arm picked the output. A Jev pre-grade may pre-fill a label but a person confirms it.
- **Out of scope:** many workflows at once; the tool calling any model; production integrations; sensitive data (synthetic or redacted cases only); claims beyond the user's own test set; pooling or sharing subscriptions.

## Journey
1. Describe the decision and its answer set.
2. Write 30 or more test cases, and the simple rule, before seeing any results.
3. Run the cases through the three arms outside the tool (a local runner script with your own keys, or by hand) and fill one results CSV.
4. Label every output any arm picked: accept or reject.
5. Load the CSV into the page and read the numbers and the verdict.

## The three arms
| Arm | Portal name | What it does | Inputs it needs |
|---|---|---|---|
| A. What you do now | current LLM-only setup | what you do today at this decision, e.g. every prompt goes to Sonnet | the case, your prompt, your model |
| B. A simple rule | a simple baseline | a rule written before labelling, e.g. under 400 characters goes to Haiku; default "always the cheapest model" | the case and the rule |
| C. Jev decides | Jev routing | Jev answers the typed question; code maps the answer to a model; below a confidence cutoff fixed in advance, the case falls back to arm A's model | the case, the question, the answer set, the mapping, the cutoff |

## Results file
One CSV, one row per case per arm: `case_id, arm, picker, picker_tokens_in, picker_cost_usd, picked_model, model_tokens_in, model_tokens_out, model_cost_usd, jev_answer, jev_confidence, fallback, label, label_source, price_table_date`. Record format (any answerer: Jev, rule, LLM or person), schema, fictional sample and validator: [format/](format/README.md).

## Metrics and where each number comes from
| Metric shown | Input source |
|---|---|
| Tokens | the API's usage fields per call (Jev: `usage.input_tokens`, `usage.output_tokens`; model providers: `usage`) |
| Spend per case | picker cost + cost of the model call the pick triggers + any fallback call. Jev: input tokens x $0.042 per million, output free. Models: tokens x one dated list-price table. Rule: 0 |
| Spend per arm | sum of spend per case over all cases |
| Kept answers (accepted count) | human labels on each picked output |
| Cost per kept answer | spend per arm / kept answers; "undefined" when an arm keeps none |
| Wins and losses vs Jev | per case: Jev kept and the other arm not (win), or the reverse (loss), from the labels |
| Jev answer and confidence | `answers.<question>.choice` and `.confidence` in the Jev response |
| Latency | client wall clock around each call (shown, not used in the verdict) |
| Label source and labelling time | counted from the file; reported, not added to spend |
| Verdict | the rule below, applied to the numbers above |

## Verdict rule
Full rules, formulas and edge cases: [docs/decision/verdict-rules.md](docs/decision/verdict-rules.md). In order, first match wins:
1. **Not enough evidence** if there are no Jev or LLM rows, fewer than 30 paired labelled cases, Jev and the LLM both keep no answers, or a cost is missing on a paired Jev or LLM row.
2. **Don't use Jev** if the rule comes within 10 points of Jev's accept rate (on 30 or more paired cases), Jev is clearly more than 10 points worse than the LLM, Jev keeps no answers while the LLM keeps some, or Jev clearly costs more per kept answer.
3. **Use Jev** if Jev is not clearly more than 10 points worse than the LLM and costs at most 0.8x the LLM per kept answer, with the 95% bound below 1x.
4. **Not enough evidence** otherwise. Both numbers are shown.

The screen prints the rule that fired and the counts behind it. The verdict describes the builder's test set only, not production.

## No Jev key
You still get "what you do now" vs "a simple rule". The verdict says "not enough evidence: no Jev results", never "don't use Jev". With your consent we can run the Jev arm on your redacted cases and send back the rows.

## First measurement
[docs/benchmarks/2026-09-27-grading-speed-cost.md](docs/benchmarks/2026-09-27-grading-speed-cost.md): the token, cost and latency sources above, exercised on 90 synthetic items. It used Jev as a grader (a labelling aid), not as arm C.
