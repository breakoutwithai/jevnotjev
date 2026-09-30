# Day 6: tiny example dataset, worked by hand

`records.csv` is the fixture for the calculations (day 7) and the verdict (day 8). Every number below was worked out by hand; that code must reproduce them.

## The workflow
TokenMax's flagship use case: check a CV against a job ad, one yes/no question per ad line. The ad is the fictional "Head of Token Maximisation" (TokenTogether). The five CVs are fictional.

| Question | Ad line it checks |
|---|---|
| q1: Does the CV show the person has built or run a product that pools AI subscriptions or tokens? | "Build our flagship Token Pot" |
| q2: Does the CV show the person has built a usage dashboard or meter for a shared subscription? | "Develop a dashboard showing whose subscription is carrying the group project" |

Each question is its own decision point, so each gets its own verdict (`FLOW.md`, one verdict per decision point; formulas in `docs/decision/verdict-rules.md`). A paired case is a `case_id` (a CV) where both answerers have a labelled row for that question. 5 CVs x 2 questions x 3 answerers = 30 rows.

## What is real and what is invented
| Column | Source |
|---|---|
| `case_input` | Condensed and reworded from each fictional CV, keeping the lines both questions turn on; not a verbatim quote |
| `label` | A person's call, from the correct answers below |
| `rule` output | Real: the keyword rule `token pot\|pool` (q1) or `dashboard\|meter` (q2), matched case-insensitively against `case_input` |
| `jev` and `llm` output, confidence, tokens, cost, latency | Invented. No model was called. `example-llm` is not a real model. Costs are round numbers chosen for hand arithmetic: $0.00002 per Jev call, $0.002 per LLM call. |

## Correct answers
| Case | q1 | q2 | Why |
|---|---|---|---|
| cv1 | no | no | Pooled frequent flyer accounts, not AI subscriptions |
| cv2 | no | no | Cancels subscriptions; audits usage but built no meter |
| cv3 | yes | yes | Launched Token Pot; built the "Who is carrying this project" dashboard, close to the ad's "whose subscription is carrying the group project" |
| cv4 | no | no | Pooling keywords, no product built |
| cv5 | no | no | Spreadsheet of money owed, and a meter only as an idea |

## Every row, by hand
A = accept, R = reject, - = unlabelled.

| Case | Jev | Rule | LLM |
|---|---|---|---|
| cv1 q1 | no A | yes R | no A |
| cv1 q2 | no A | no A | no A |
| cv2 q1 | no A | no A | no A |
| cv2 q2 | no A | no A | no - (unlabelled) |
| cv3 q1 | yes A | yes A | yes A |
| cv3 q2 | yes A | yes A | yes A |
| cv4 q1 | yes R | yes R | no A |
| cv4 q2 | no A | no A | no A |
| cv5 q1 | no A | yes R | no A |
| cv5 q2 | yes R | yes R (cost missing) | yes R |

Two planted gaps: the LLM row for cv2 q2 has no label, and the rule row for cv5 q2 has no cost.

## Per answerer, whole file
Matches `python3 format/validate.py examples/d06-tiny/records.csv` (`cases=5` there counts CVs).

| Answerer | Rows | Labelled | Accepted | Spend, all rows |
|---|---|---|---|---|
| jev | 10 | 10 | 8 | 10 x 0.00002 = $0.0002 |
| rule | 10 | 10 | 6 | incomplete (cv5 q2 missing) |
| llm | 10 | 9 | 8 | 10 x 0.002 = $0.02 |

## q1: pooled product (Token Pot line)
**Jev against the LLM:** 5 paired cases (cv1 to cv5).

| | Jev | LLM |
|---|---|---|
| Accepted | 4 (rejects cv4) | 5 |
| Accept rate | 4/5 = 0.8 | 5/5 = 1.0 |
| Spend | 5 x 0.00002 = $0.0001 | 5 x 0.002 = $0.01 |
| Cost per accepted | 0.0001 / 4 = $0.000025 | 0.01 / 5 = $0.002 |

Cost ratio = 0.000025 / 0.002 = **1/80 = 0.0125**. a (both accept) = 4, b (Jev only) = 0, c (LLM only) = 1 (cv4), d = 0. Jev minus LLM = **-0.2**.

**Jev against the rule:** 5 paired cases. Jev 4 accepted, rule 2. a = 2 (cv2, cv3), b (Jev only) = 2 (cv1, cv5), c = 0, d = 1 (cv4). Rule minus Jev = **-0.4**.

**Verdict: not enough evidence.** Rule 1: 5 paired Jev and LLM cases, fewer than 30; "add 25 more labelled cases". The rule comparison is skipped (5 paired rule cases).

## q2: usage dashboard line
**Jev against the LLM:** 4 paired cases (cv1, cv3, cv4, cv5; cv2 drops out because the LLM row is unlabelled).

| | Jev | LLM |
|---|---|---|
| Accepted | 3 (rejects cv5) | 3 (rejects cv5) |
| Accept rate | 3/4 = 0.75 | 3/4 = 0.75 |
| Spend | 4 x 0.00002 = $0.00008 | 4 x 0.002 = $0.008 |
| Cost per accepted | 0.00008 / 3 = $0.0000267 | 0.008 / 3 = $0.00267 |

Cost ratio = **1/100 = 0.01**. a = 3, b = 0, c = 0, d = 1 (cv5). Jev minus LLM = **0**.

**Jev against the rule:** 5 paired cases. Jev 4 accepted, rule 4. a = 4, b = 0, c = 0, d = 1 (cv5). Rule minus Jev = **0**. Rule spend is incomplete (cv5 missing); the verdict never uses rule cost.

**Verdict: not enough evidence.** Rule 1: 4 paired Jev and LLM cases, fewer than 30; "add 26 more labelled cases". The rule comparison is skipped (5 paired rule cases).

## Why so small
The file is small on purpose, so every number above can be checked by eye. Neither question can reach a "use Jev" or "don't use Jev" verdict; those paths need a fixture of 30 or more cases, not written yet.
