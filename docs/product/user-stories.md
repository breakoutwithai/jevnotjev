# Jev!Jev user stories (v1)

## Journeys

Primary user: a builder who runs LLM calls in their workflow, keeps hitting usage limits, and wants to know whether letting Jev make one decision in that workflow gets more accepted results from the same token budget, before trusting it. The flagship use case, TokenMax, asks this for the token budget itself; other use cases ask it for other decisions.

Jev!Jev is a small web tool that compares one workflow across three approaches on the user's own test cases and reports cost per accepted result with a cautious verdict: use Jev, don't use Jev, or not enough evidence.

### The one workflow in v1

One decision point with a fixed answer set, asked as a typed question; code maps each answer to the next step (`FLOW.md`, Scope). The user chooses the decision.

Historical: v1 first named the Claude Code prompt router (Jev picks Haiku, Sonnet or Opus per prompt). That router was dropped on 2026-09-28 and is superseded; no replacement workflow is chosen here.

| Approach | What it means for this workflow |
|---|---|
| LLM only (current setup) | What the user does today at this decision, usually their LLM. |
| Simple baseline | A plain rule written before labelling makes the decision, with no Jev call. |
| Jev routing | Jev answers the typed question per case; the Jev call cost is included. |

Accepted result: the user, reading the answer, marks it as good enough to use without re-asking.

Cost per accepted result: total spend for an approach (model tokens plus any Jev calls) divided by the number of its answers the user accepted.

### Journey J1: from a set of cases to a first verdict

1. The user opens Jev!Jev and sees the one supported workflow, what it compares, and that cases should be synthetic or redacted.
2. The user adds a small test set of cases from their own workflow (synthetic or redacted).
3. The user supplies results and costs for the three approaches in the one documented file format.
4. The user labels each answer accepted or not accepted.
5. Jev!Jev shows cost per accepted result for each approach, side by side.
6. Jev!Jev shows the verdict and states that it is evidence from this test set only, not a promise about production.

### Journey J2: checking whether Jev's answers can be trusted

1. From the verdict, the user opens the per-case view.
2. The user sees, for each case, what each approach picked and whether that result was accepted.
3. The user sees wins and losses against Jev per case: Jev accepted and the other approach not, or the reverse (`FLOW.md`, Metrics).
4. The user sees whether Jev's confidence separated right answers from wrong ones, including wrong answers given with high confidence.
5. The user decides whether to add more cases, change the baseline rule, or act on the verdict.

Each story below traces to one journey step. v1 is deliberately small and will grow day by day.

## Stories

### US-01 See the one supported workflow before starting

As a builder who hits usage limits, I want to see which kind of decision Jev!Jev compares and how, so that I know in one screen whether it fits my setup.

Journey step: J1.1

- Given I open Jev!Jev for the first time
- When the start page loads
- Then it names the one supported shape (one decision point with a fixed answer set), the three approaches (LLM only, simple baseline, Jev routing), and what an accepted result means
- And it asks for synthetic or redacted cases, not production data

### US-02 Add a small test set of cases

As a builder, I want to add a handful of cases my workflow really handles, so that the comparison runs on my own work rather than a generic benchmark.

Journey step: J1.2

- Given I am on the test set step
- When I add cases one by one or paste a list
- Then each case is saved as a numbered test case I can edit or remove
- And the page shows how many cases I have

### US-03 Supply results and costs in one documented format

As a builder, I want one clearly documented file format for the answers and costs from each approach, so that I can produce it from my own runs without guessing.

Journey step: J1.3

- Given the format is documented in this repo with an example file
- When I upload a file that matches it
- Then Jev!Jev shows, per test case, what each of the three approaches picked, the result and the cost
- And the Jev routing rows include the Jev call cost

- Given I upload a file that does not match the format
- When Jev!Jev reads it
- Then it names the first row and field that failed and imports nothing

### US-04 Label each answer accepted or not

As a builder, I want to mark each answer accepted or not accepted, so that cost is measured against results I would actually use.

Journey step: J1.4

- Given results are imported
- When I mark an answer accepted or not accepted
- Then the label is saved against that case and approach
- And the page shows how many answers are still unlabelled

### US-05 Compare cost per accepted result

As a builder, I want to see cost per accepted result for each approach side by side, so that I can see which one gets the most usable answers from the same spend.

Journey step: J1.5

- Given every answer in the test set is labelled
- When I open the results
- Then each approach shows total spend, accepted count, and total spend divided by accepted count
- And an approach with zero accepted answers shows "no accepted results" instead of a number

### US-06 Read a cautious verdict

As a builder, I want a verdict of use Jev, don't use Jev, or not enough evidence, so that I get a decision and not just a table.

Journey step: J1.6

The thresholds, the order the rules apply in and every edge case are written once, in [docs/decision/verdict-rules.md](../decision/verdict-rules.md); this story does not restate them.

- Given a labelled test file
- When the verdict is shown
- Then it reads exactly one of "use Jev", "don't use Jev" or "not enough evidence", as `docs/decision/verdict-rules.md` decides
- And it names the rule that fired and shows the numbers behind it
- And for "not enough evidence" it says what would change it
- And it states the verdict is evidence from this test set only

### US-07 See wins and losses against Jev per case

As a builder, I want to see for each case whether Jev's result was accepted where another approach's was not, or the reverse, so that I know where Jev gains or loses, not just what it costs.

Journey step: J2.3

- Given every picked result in the test set is labelled
- When I open the per-case view
- Then each row shows each approach's pick, its label, and whether Jev won, lost or tied against each other approach
- And the page shows the win and loss counts that feed the verdict

Historical: US-07 was "See router pick accuracy per prompt" for the Claude Code prompt router (Haiku, Sonnet or Opus). That router was dropped on 2026-09-28; the story is superseded by the wins and losses above.

### US-08 Check whether confidence means a right pick

As a builder, I want to see Jev's confidence next to right and wrong picks, so that I do not treat a high confidence score as a right answer.

Journey step: J2.4

- Given Jev's confidence is included for each pick
- When I open the per-case view
- Then each row shows the confidence score
- And wrong picks at high confidence are listed first

## Out of scope for v1

- More than one decision point at a time (`FLOW.md`, Scope). The earlier limit to the Claude Code prompt router is historical: that router was dropped on 2026-09-28.
- Running models or calling Jev from inside Jev!Jev; v1 reads results the user supplies.
- Live or streaming traffic; v1 works on a recorded test set.
- Real production or sensitive data; cases should be synthetic or redacted.
- Pooling or sharing subscriptions between people.
- Any guarantee about production performance; a verdict covers the test set only.
