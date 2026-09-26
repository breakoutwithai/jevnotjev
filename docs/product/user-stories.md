# TokenMax user stories (v1)

Journeys are in `user-journeys.md`. Each story traces to one journey step. v1 is deliberately small and will grow day by day.

### US-01 See the one supported workflow before starting

As a builder who hits Claude Code usage limits, I want to see which workflow TokenMax supports and what it compares, so that I know in one screen whether it fits my setup.

Journey step: J1.1

- Given I open TokenMax for the first time
- When the start page loads
- Then it names the Claude Code prompt router workflow, the three approaches (LLM only, simple baseline, Jev routing), and what an accepted result means
- And it asks for synthetic or redacted prompts, not production data

### US-02 Add a small test set of prompts

As a builder, I want to add a handful of prompts I would really send to Claude Code, so that the comparison runs on my own work rather than a generic benchmark.

Journey step: J1.2

- Given I am on the test set step
- When I add prompts one by one or paste a list
- Then each prompt is saved as a numbered test case I can edit or remove
- And the page shows how many cases I have

### US-03 Supply results and costs in one documented format

As a builder, I want one clearly documented file format for the answers and costs from each approach, so that I can produce it from my own runs without guessing.

Journey step: J1.3

- Given the format is documented in this repo with an example file
- When I upload a file that matches it
- Then TokenMax shows, per test case, the model used, the answer and the cost for each of the three approaches
- And the Jev routing rows include the Jev call cost

- Given I upload a file that does not match the format
- When TokenMax reads it
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

- Given the test set is smaller than the documented minimum, or the approaches are too close to separate
- When the verdict is shown
- Then it reads "not enough evidence" and says what would change it

- Given Jev routing has the lowest cost per accepted result by a clear margin
- When the verdict is shown
- Then it reads "use Jev"
- And it states the verdict is evidence from this test set only

- Given LLM only or the simple baseline has the lowest cost per accepted result
- When the verdict is shown
- Then it reads "don't use Jev" and names the approach that won

### US-07 See router pick accuracy per prompt

As a builder, I want to see for each prompt whether Jev picked the cheapest model whose answer I accepted, so that I know how often the router gets the pick right, not just what it costs.

Journey step: J2.3

- Given each test case has labelled answers from Haiku, Sonnet and Opus
- When I open the per-prompt view
- Then each row shows Jev's pick, the cheapest accepted model, and whether they match
- And the page shows the share of prompts where they match

### US-08 Check whether confidence means a right pick

As a builder, I want to see Jev's confidence next to right and wrong picks, so that I do not treat a high confidence score as a right answer.

Journey step: J2.4

- Given Jev's confidence is included for each pick
- When I open the per-prompt view
- Then each row shows the confidence score
- And wrong picks at high confidence are listed first

## Out of scope for v1

- Any workflow other than the Claude Code prompt router.
- Running models or calling Jev from inside TokenMax; v1 reads results the user supplies.
- Live or streaming traffic; v1 works on a recorded test set.
- Real production or sensitive data; cases should be synthetic or redacted.
- Pooling or sharing subscriptions between people.
- Any guarantee about production performance; a verdict covers the test set only.
