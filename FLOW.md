# Jev!Jev: comparison flow

Take 30 or more examples of one decision your workflow already makes. Record what your current setup, a simple rule and Jev each chose and what it cost, and mark which answers you would keep. Jev!Jev shows the cost per answer you would keep for each, with a cautious verdict (use Jev, don't use Jev, or not enough evidence) that holds for those examples only.

Diagram: [docs/product/flow/comparison.html](docs/product/flow/comparison.html) (source: `comparison.dataflow.json`, rendered with archify).

## Scope (v1)
- **Workflow:** one decision point with a fixed answer set, asked as a typed question; code maps each answer to the next step. Jev is never asked "which model".
- **Historical (superseded 2026-09-28):** the first example was "How hard is this coding prompt? trivial / ordinary / hard", with code mapping the answer to Haiku, Sonnet or Opus (the Claude Code prompt router). That router was dropped and is not a v1 requirement.
- **User:** a builder who runs LLM calls in their workflow and wants to know if Jev can make some of those decisions cheaper without losing quality.
- **Accepted result:** an output a person marks "accept" under one written rule: correct and complete enough to use without edits. Labels are blind to which arm gave the answer. A Jev pre-grade may pre-fill a label but a person confirms it.
- **Flagship use case:** TokenMax, more accepted results from the same token budget.
- **First workflow:** UC11, a CV against a job ad: one yes/no question per ad line, asked of each CV. The spec names it the default sample and the default name until decided (`docs/spec/spec.md`). Its worked hand calculation is [examples/d06-tiny](examples/d06-tiny/). A second recorded run, UC13 (a shop bot that answers or hands off), is not the first workflow.
- **Verdict:** follows [verdict-rules.md](docs/decision/verdict-rules.md); fewer than 30 paired labelled cases is always "not enough evidence".
- **Out of scope:** many workflows at once; production integrations; sensitive data (synthetic or redacted cases only); claims beyond the user's own test set; pooling or sharing subscriptions; asking Jev "which model" to use; tasks that are not a typed answer on one text (counts or exit-code checks, diffs and document bundles, retrieval, free-text output, decisions where one wrong answer is not survivable); a claim that Jev is better in general (the evidence so far is synthetic or AI-drafted and approved by a person).

## Backstage live MVP (#67)

Backstage adds an explicit BYOK runner for one binary question: Jev, Anthropic and a local keyword rule. Calls start only when the tester presses Run. Keys stay in session/request memory, cases and frozen run evidence can be downloaded, and human blind labels drive the unchanged core verdict. The main-stage examples and CSV tools remain available. See [Backstage](backstage.md) for local use.

## Journey
1. Describe the decision and its answer set.
2. Write 30 or more test cases, and the simple rule, before seeing any results.
3. Ask the same typed question on every case to the three arms outside the tool (a local runner script with your own keys, or by hand) and fill one `jnj-record/1` CSV. No Jev integration is assumed: outputs and costs you collect by hand go in the same CSV, and a case with no row for a method is reported as a gap ([manual path](examples/d12-three-methods/README.md)).
4. Label every answer: accept or reject.
5. Load the CSV into the page and read the numbers and the verdict. The page reads the file in your browser and refuses a file over 5 MB (it checks on the page's own thread); use `bun run validate` for larger files.

## The three arms
Each arm answers the same typed question on the same case; code then acts on the answer the same way whichever arm gave it. Example: UC11, "Does the CV show the person has built a usage dashboard or meter for a shared subscription?" yes / no ([uc11](docs/product/use-cases/uc11-cv-vs-job-ad.md)).

| Arm | Plain name | `answerer` | What it does | Inputs it needs |
|---|---|---|---|---|
| A. What you do now | current LLM-only setup | `llm` | your LLM answers the question, as you would today; e.g. it reads the CV and answers yes or no | the case, the question, the answer set, your prompt and model |
| B. A simple rule | a simple baseline | `rule` | a rule written before labelling answers the question; e.g. keyword match `dashboard\|meter` | the case and the rule |
| C. Jev decides | Jev routing | `jev` | Jev answers the question and gives a confidence | the case, the question, the answer set |

Historical: arm examples were written for the Claude Code prompt router (every prompt to Sonnet; under 400 characters to Haiku; Jev's answer mapped to a model). That router was dropped on 2026-09-28 and these examples are superseded.

## Results file
One CSV in the `jnj-record/1` format, one row per answerer per question per case. Columns, schema, fictional sample and validator: [format/](format/README.md). That file is the only column list.

## Metrics and where each number comes from
| Metric | Input source | Shown or recorded only (file:line of the code that does it) |
|---|---|---|
| Tokens | the API's usage fields per call (Jev: `usage.input_tokens`, `usage.output_tokens`; model providers: `usage`) | Recorded as `tokens_in`, `tokens_out` (src/backstage/run.ts:1385-1386); not shown |
| Spend per case | `cost_usd` of that arm's answer. Jev: input tokens x $0.042 per million, output free. LLM: tokens x one dated list-price table (its date goes in the optional `price_table_date` column, format/README.md). Rule: 0 | Shown per method in the case table, result view and loaded panel (src/core/case-table.ts:32-38); not in Backstage |
| Spend per arm | sum of spend per case over all cases | Backstage "Answers-only spend" (src/backstage/main.ts:599); result view "Spend" (scripts/result-view.ts:147) |
| Kept answers (accepted count) | human labels on each answer | Backstage "Kept / labelled" (src/backstage/main.ts:597); result view "Accepted" (scripts/result-view.ts:145) |
| Cost per kept answer | spend per arm / kept answers; "undefined" when an arm keeps none | Backstage "Cost / kept" (src/backstage/main.ts:600); result view (scripts/result-view.ts:148) |
| Wins, losses and ties vs Jev | per case: Jev kept and the other arm not (win), the reverse (loss), or both the same (tie), from the labels | Computed (src/core/metrics.ts:66-69). Backstage shows the Jev-only and other-only win counts (src/backstage/main.ts:619-622); ties and a per-case view are not shown |
| Jev answer and confidence | `answers.<question>.choice` and `.confidence` in the Jev response | Backstage shows the answer and "Returned confidence" for a case once it is picked blind, and Jev's ranking after the pick (src/backstage/main.ts:373-380); the result view shows the answer without confidence (src/core/case-table.ts:35) |
| Latency | client wall clock around each call | Recorded as `latency_ms` (src/backstage/run.ts:541 and src/backstage/run.ts:1388); shown nowhere; not used in the verdict |
| Label source | `label_source` (`human`, `human_reviewed`, `agent` or empty) with `labelled_by`, `labelled_at` and `label_blind`, plus `label_final` and `suggestion_shown` from the blind-then-suggest loop (jnj-record/1.1) | Recorded (src/backstage/run.ts:1384-1391, format/README.md:45); not displayed |
| Labelling time | none: no column holds it and nothing measures it | Not recorded, not shown |
| Failed-attempt spend | charges of attempts that returned no answer: known dollars, plus a count of unknown charges (src/backstage/run.ts:1513-1522) | Backstage progress line (src/backstage/main.ts:532) |
| Total attempts | every attempt's cost once, shared Jev answers billed once (src/backstage/run.ts:1524-1533) | Backstage "Total actual attempts" (src/backstage/main.ts:582-587) |
| Unlabelled | answers with no label: neither kept nor rejected (src/core/metrics.ts:37) | Backstage "Unlabelled" (src/backstage/main.ts:598); result view "Gaps" (scripts/result-view.ts:146) |
| Excluded | cases where one answer is unlabelled or absent, left out of a pair (src/core/metrics.ts:57-58) | Backstage pair line (src/backstage/main.ts:618-619) |
| Interval bounds | 95% Newcombe bounds and cost-ratio bounds (docs/decision/verdict-rules.md) | Result view numbers table (scripts/result-view.ts:207) and the verdict reason text |
| Limitations | `limitations` on the verdict (src/core/verdict.ts) | Result view, per question (scripts/result-view.ts:252-253) and the loaded panel and current-verdict slot (src/browser/results-loader.ts) |
| Verdict | the rule below, applied to the numbers above | Backstage (src/backstage/main.ts:627-629); result view; loader |

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
