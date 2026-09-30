# UC11: CV against a job ad

**User story:** As a hiring manager I want each CV checked against each line of my job ad, so I read the strong ones first and stop paying an LLM to reread every CV in full.

**Prompted by:** a satirical job ad the builder posted in the challenge community, "Head of Token Maximisation" at the fictional TokenTogether, plus five fictional CVs written against it. This is the **TokenMax** flagship use case: more accepted results from the same token budget.

## Jev or not
"Rank these CVs" is a written judgement, so as asked it is **Jev probably not**. Split into one yes/no question per ad line, each answer is a fixed choice on one text (the CV), code acts on it, and a wrong answer on one line is survivable because a person still reads the shortlist. That shape is **Jev could help**.

| Decision (typed question) | Answers | State (what Jev reads) | Code does with each answer | Mark | Simple rule to beat |
|---|---|---|---|---|---|
| Does the CV show the person has built or run a product that pools AI subscriptions or tokens? (ad line: "Build our flagship Token Pot") | yes / no | one CV | yes adds a point for that line | Jev could help | keyword match: `token pot\|pool` |
| Does the CV show the person has built a usage dashboard or meter for a shared subscription? (ad line: "Develop a dashboard showing whose subscription is carrying the group project") | yes / no | one CV | yes adds a point for that line | Jev could help | keyword match: `dashboard\|meter` |
| One more question per remaining ad line, written the same way | yes / no | one CV | sums the points; the shortlist is the CVs with the most lines met | Needs a test | keyword match per line |

The ranking comes from code summing the per-line answers, not from asking Jev "who is best". Each line is its own decision point with its own verdict.

## Why keyword match is the rule to beat
The fictional CVs were written to break it. One CV stuffs the ad's words ("Token", "Pooling", "Max Max Ultra Max") into a skills list with nothing built behind them. Another "pooled 2.3 million dormant frequent flyer accounts", which matches `pool` but is airline loyalty, not AI subscriptions. A keyword rule says yes to both; a person says no.

## Worked hand calculation
[`examples/d06-tiny/`](../../../examples/d06-tiny/) is this use case at toy size: 5 CVs, the two questions above, three answerers (Jev, the keyword rule, an LLM). [`records.csv`](../../../examples/d06-tiny/records.csv) holds the rows and [`expected.md`](../../../examples/d06-tiny/expected.md) works every accept rate, cost per accepted result and verdict by hand. Only the rule's outputs there are real; the Jev and LLM outputs and costs are invented for arithmetic. Both questions end at "not enough evidence" because 5 cases is far below the 30 the verdict rules need.

## Keep the answer key out of the matcher
The correct answers (a ranked key with the reason for each CV) were written after the CVs and are held separately. They are labels, used only to mark each answer accepted or rejected. They must never be in the text any answerer reads, or the test measures copying, not matching.

## How Jev!Jev tests this use case
- Cases: 30 or more CVs against one ad, each labelled by hand yes or no per ad line, with the labeller not shown any answerer's output first.
- Arms: what you do now (an LLM reads the whole CV and the whole ad), a simple rule (keyword match per line), Jev decides (one yes/no per line).
- Accepted result: a per-line answer the hiring manager agrees with; the headline number is cost per accepted result per line.

## Not established
- Whether Jev beats keyword match on real CVs; the fixture here is fictional and 5 cases long.
- Whether per-line yes/no loses signal a whole-CV read would catch (for example an honest but inexperienced candidate with one good idea).
