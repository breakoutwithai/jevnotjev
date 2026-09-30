# Day 6: tiny example dataset, worked by hand

`records.csv` is the fixture for day 7's calculations. The numbers below were worked out by hand; code written on day 7 must reproduce them.

## The workflow
TokenMax's flagship use case: check a CV against a job ad, one yes/no question per ad line. The ad is the fictional "Head of Token Maximisation" (TokenTogether). The five CVs are fictional; `case_input` is a short excerpt of each.

| Question | Ad line it checks |
|---|---|
| q1: Does the CV show the person has built or run a product that pools AI subscriptions or tokens? | "Build our flagship Token Pot" |
| q2: Does the CV show the person has built a usage dashboard or meter for a shared subscription? | "Develop a dashboard showing whose subscription is carrying the group project" |

5 CVs x 2 questions = 10 cases. 3 answerers x 10 = 30 rows.

## What is real and what is invented
| Column | Source |
|---|---|
| `label` | A person's call, from the correct answers below |
| `rule` output | Real: the keyword rule `token pot\|pool` (q1) or `dashboard\|meter` (q2), matched against `case_input` |
| `jev` and `llm` output, confidence, tokens, cost, latency | Invented. No model was called. `example-llm` is not a real model. Costs are round numbers chosen for hand arithmetic: $0.00002 per Jev call, $0.002 per LLM call. |

## Correct answers
| Case | q1 | q2 | Why |
|---|---|---|---|
| cv1 | no | no | Pooled frequent flyer accounts, not AI subscriptions |
| cv2 | no | no | Cancels subscriptions; audits usage but built no meter |
| cv3 | yes | yes | Launched Token Pot; built the "Who is carrying this project" dashboard |
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

## Per answerer, all rows
Matches `python3 format/validate.py examples/d06-tiny/records.csv`.

| Answerer | Rows | Labelled | Accepted | Spend, all rows |
|---|---|---|---|---|
| jev | 10 | 10 | 8 | 10 x 0.00002 = $0.0002 |
| rule | 10 | 10 | 6 | incomplete (cv5 q2 missing) |
| llm | 10 | 9 | 8 | 10 x 0.002 = $0.02 |

## Jev against the LLM, paired cases (verdict rules)
Paired = both labelled on the same case: 10 minus cv2 q2 = **9**.

| | Jev | LLM |
|---|---|---|
| Accepted | 7 (rejects cv4 q1, cv5 q2) | 8 (rejects cv5 q2) |
| Accept rate | 7/9 = 0.778 | 8/9 = 0.889 |
| Spend | 9 x 0.00002 = $0.00018 | 9 x 0.002 = $0.018 |
| Cost per accepted | 0.00018 / 7 = $0.0000257 | 0.018 / 8 = $0.00225 |

- Cost ratio = 0.0000257 / 0.00225 = **2/175 = 0.0114** (Jev costs about 1% of the LLM per accepted answer).
- Paired counts: a (both accept) = 7, b (Jev only) = 0, c (LLM only) = 1 (cv4 q1), d (both reject) = 1 (cv5 q2).
- Accept-rate difference, Jev minus LLM = 7/9 - 8/9 = **-0.111**.

## Jev against the rule, paired cases
Paired = **10**. Jev accepted 8, the rule 6. a = 6, b (Jev only) = 2 (cv1 q1, cv5 q1), c = 0, d = 2 (cv4 q1, cv5 q2). Difference, rule minus Jev = 6/10 - 8/10 = **-0.2**. Rule spend is incomplete; the verdict does not use rule cost.

## Expected verdict
**Not enough evidence.** Rule 1 fires: 9 paired Jev and LLM cases, fewer than 30. The screen should say "add 21 more labelled cases". The rule comparison is skipped (10 paired rule cases, fewer than 30). Rates and costs are still shown, marked "below minimum".

The file is small on purpose, so every number above can be checked by eye. It cannot reach a "use Jev" or "don't use Jev" verdict.
