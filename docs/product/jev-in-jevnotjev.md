# Using Jev to build Jev!Jev

## What Jev is (core features)
Source: community research page, captured 2026-09-26 (threads 17 to 26 September 2026).

| Feature | Detail |
|---|---|
| Typed decisions | Yes/no, one-of-N, or a score (e.g. a 0/1/2 rubric) |
| Confidence | Every answer carries a confidence score |
| Needs an answer space | You supply the options; open questions fail |
| No text output | Encoder-only classifier: it tags, it does not write or code |
| Cost | $0.042 per million input tokens, output free |
| Speed | Median 319 ms in one community test |
| Access | TypeSafe waitlist, OpenRouter, Vercel AI Gateway |
| Limits | Can still be wrong; one wrong answer carried 93% confidence. Accuracy on real messy data is not established |

## Where Jev could help this project
Each use is a candidate, not a claim. Each gets the same test Jev!Jev gives users: Jev vs an LLM vs a simple rule, on labelled cases.

| Stage | Decision Jev could make | Answer shape | Simple rule to beat |
|---|---|---|---|
| Design | Does this user story have testable acceptance criteria? | yes/no | regex for "Given / When / Then" |
| Design | Which comparison arm does this input belong to? | one-of-3 | lookup table |
| Building | Route each coding prompt to Haiku, Sonnet or Opus (historical: the prompt router was dropped 2026-09-28) | one-of-3 | prompt length |
| Building | Is this commit message a real change or noise? | yes/no | diff size |
| Functional testing | Does this output match the expected label? | yes/no | exact match |
| Functional testing | Grade an answer against a 0/1/2 rubric | score | human label |
| UAT | Sort a tester's feedback: bug, confusion, feature ask, praise | one-of-4 | keyword list |
| UAT | Is the user stuck on this screen? (from their notes) | yes/no | time on step |
| Serving others | Does this builder's project have a typed decision point Jev could make? | yes/no | our own read |
| Serving others | Which of our docs answers this question? | one-of-N | search |

## First one to try
Not chosen yet. Historical: the first pick was the prompt router, then described as "the TokenMax workflow itself". That router was dropped on 2026-09-28 and is superseded; it is not a current requirement. TokenMax is the flagship use case of Jev!Jev (more accepted results from the same token budget), not a router.
