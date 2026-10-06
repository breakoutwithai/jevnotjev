# Verdict rules (day 5)

How Jev!Jev turns a labelled test file (`jnj-record/1`, see [format/README.md](../../format/README.md)) into one of three verdicts for one decision point: **use Jev**, **don't use Jev**, or **not enough evidence**.

The verdict describes the builder's test set, not production.

## Settings
| Setting | Value | Why |
|---|---|---|
| Minimum paired labelled cases | 30 | At 10 and 20 cases, a Jev that is truly as good as the LLM reaches "use Jev" in only 2% to 13% of simulated test sets; at 30, 17% to 22% (table below) |
| Accept-rate margin | 10 points | With a 5-point margin, even 100 cases reach "use Jev" in only 17% to 25% of test sets |
| Cost ratio to count as cheaper | 0.8 or less | Jev must be at least 20% cheaper per accepted answer, with the 95% upper bound below 1; compared with a tolerance of 1e-9 (see [Cost guards and tolerance](#cost-guards-and-tolerance)) |
| Confidence level | 95% | |

## Terms
- **Answerer**: `jev`, `rule` (the simple baseline) or `llm` (what the builder does now), from the `answerer` column.
- **Paired case**: a `case_id` where both answerers being compared have a labelled row for the same `question_id`. Unlabelled rows are left out of every count.
- **Accepted**: a row with `label = accept`.

## Formulas
For one answerer X on the paired cases, n cases:

```
accept_rate(X)   = accepted(X) / n
spend(X)         = sum of cost_usd over X's rows
cost_per_accepted(X) = spend(X) / accepted(X)          undefined when accepted(X) = 0
cost_ratio       = cost_per_accepted(jev) / cost_per_accepted(llm)
                   = 0 when the LLM has 0 accepted and Jev has 1 or more
                   = infinity when Jev has 0 accepted and the LLM has 1 or more
```

Both at 0 accepted has no ratio; rule 1 stops before it is needed.

Accept-rate difference, Jev minus the other answerer, on paired cases:

```
a = both accepted        b = Jev accepted, other rejected
c = other accepted, Jev rejected        d = both rejected
p1 = (a + b) / n         p2 = (a + c) / n         diff = p1 - p2
```

95% interval for `diff`: Newcombe's paired method 10 (Newcombe 1998, "Improved confidence intervals for the difference between binomial proportions based on paired data", Statistics in Medicine 17:2635-2650), built from the Wilson interval of each rate:

```
(l1, u1) = Wilson 95% interval of p1        (l2, u2) = Wilson 95% interval of p2
phi = (a*d - b*c) / sqrt((a+b)(c+d)(a+c)(b+d)),  with a*d - b*c reduced by n/2 (not below 0) when positive; 0 when the root is 0
lower = diff - sqrt((p1 - l1)^2 - 2*phi*(p1 - l1)*(u2 - p2) + (u2 - p2)^2)
upper = diff + sqrt((u1 - p1)^2 - 2*phi*(u1 - p1)*(p2 - l2) + (p2 - l2)^2)
```

Cost ratio interval: resample the paired cases with replacement 2,000 times, recompute `cost_ratio` each time, take the 2.5th and 97.5th percentiles. Resamples use the same two special values: ratio 0 when the LLM has 0 accepted and Jev has some, infinity when Jev has 0 and the LLM has some, and a resample where both have 0 is drawn again. A resample is also drawn again when both cost $0 per accepted answer or when its ratio overflows to a value that is not finite; an infinity from Jev at 0 accepted is kept.

## Verdict, in order, first match wins
Jev is compared with the LLM on accept rate and cost, and with the rule on accept rate only (a rule costs 0, so Jev can never be cheaper than it).

1. **Not enough evidence** when any of these holds (two cost guards also give this verdict, checked after the first three rule-2 conditions: see [Cost guards and tolerance](#cost-guards-and-tolerance)):
   - no `jev` rows, or no `llm` rows;
   - fewer than 30 paired labelled cases between Jev and the LLM;
   - Jev and the LLM both have 0 accepted;
   - any `cost_usd` missing on a paired Jev or LLM row.
2. **Don't use Jev** when any of these holds:
   - the rule is within the margin of Jev: lower bound of (rule minus Jev) above -0.10, on at least 30 paired Jev and rule cases. A free rule that does the job wins. Skipped when there are fewer than 30 paired rule cases or no rule rows.
   - Jev is clearly worse than the LLM: upper bound of (Jev minus LLM) below -0.10.
   - Jev has 0 accepted and the LLM has 1 or more.
   - Jev is clearly dearer: the cost ratio's lower bound is above 1.
3. **Use Jev** when all of these hold:
   - lower bound of (Jev minus LLM) above -0.10;
   - cost ratio 0.8 or less, and its upper bound below 1.
4. **Not enough evidence** otherwise. The screen names every rule-3 condition that was not met. It gives no count of more cases: the research behind these settings states no sample size for a stable verdict ([effort.md](../research/2026-09-29-verdict-minimums/effort.md) "Implication for how many cases to ask for": "no source gives the n needed"), and a projection from the observed counts would be a rule this document does not argue (#49). The only count the screen gives is rule 1's: 30 minus the paired cases.

The screen shows the rule that fired and every number behind it.

## Edge cases
| Case | What happens |
|---|---|
| An answerer has 0 accepted | `cost_per_accepted` shows "undefined (0 accepted)" with total spend. Its accept rate is shown with an upper bound of 3/n (rule of three: 0 of 30 means at most 10% at 95%). Jev at 0 with the LLM above 0: don't use Jev. Both at 0: not enough evidence, and the screen says neither answer is being accepted. |
| Fewer than 30 paired cases | Not enough evidence. The screen shows the paired count and "add N more labelled cases". Rates and costs are still shown, marked "below minimum". |
| A cost is missing | The file stays valid (format rule). A missing cost on a paired Jev or LLM row makes that answerer's cost `incomplete` and the verdict not enough evidence, because a cost ratio built on partial spend would look complete. A missing cost on an unlabelled or unpaired row is not used and does not block the verdict. |
| No rule rows, or fewer than 30 paired rule cases | The rule comparison is skipped and the screen says so; the verdict comes from Jev against the LLM. |
| Labels missing on some rows | Those rows drop out of the pairing. If that takes the paired count below 30, rule 1 applies. |
| The rule costs 0 | Its cost per accepted is 0, so it is never compared on cost. It is compared on accept rate only: if it comes within 10 points of Jev, the verdict is don't use Jev, because ordinary code does the job. |
| Both accept everything | `diff` = 0 and its interval is narrow; the verdict turns on cost. |
| Jev is cheaper but not by enough (ratio between 0.8 and 1) | Not enough evidence: "cheaper, but by less than 20%". |
| No Jev key, so no Jev rows | Not enough evidence: no Jev results. Never "don't use Jev". |

## Evidence behind the settings
Simulation: output in [sim_out.txt](sim_out.txt) (2,000 test sets per Newcombe cell and 400 per bootstrap cell, seed 20260929), regenerated 2026-10-01 by [sim.ts](../research/2026-09-29-verdict-minimums/sim.ts) with `bun docs/research/2026-09-29-verdict-minimums/sim.ts > docs/decision/sim_out.txt`. Every value is within Monte Carlo tolerance of the first run of 2026-09-29; the comparison is in the [research README](../research/2026-09-29-verdict-minimums/README.md). Outcome correlation between Jev and the LLM 0.5, an assumption. Share of test sets where a Jev truly equal to the LLM passes the accept-rate test for "use Jev" (Newcombe interval, 10-point margin). The simulation applies only that test, so these are upper bounds: the cost bar and the rule comparison can only lower them.

| LLM accept rate | n=10 | n=20 | n=30 | n=50 | n=100 |
|---|---|---|---|---|---|
| 0.8 | 4% | 13% | 17% | 31% | 53% |
| 0.9 | 2% | 11% | 22% | 38% | 70% |

When Jev is exactly 10 points worse, it wrongly reaches "use Jev" in 3% of test sets or fewer at every n. The rule leans towards "not enough evidence"; at 30 cases that is the most common result.

Cost side, list prices read from the vendors' pages on 2026-09-29, for a 400-token question with a 5-token answer: Jev (`jev-1.13.0`, $0.042 per million input tokens, output free) $0.017 per 1,000 calls; `gpt-6-luna` $0.04; Claude Haiku 4.5 $0.43; Claude Sonnet 5.5 $0.85; Claude Opus 5.5 $1.70. With per-call costs that far apart, the cost condition is usually met and the verdict turns on accept rate.

## Checked, and still open
- The interval code matches all 7 method-10 rows of Table III in Newcombe (1998), as transcribed from the paper into [newcombe-table3.json](newcombe-table3.json): the original research script printed `checked=7 mismatches=0` on 2026-09-29 (history at [cd8397f](https://github.com/breakoutwithai/jevnotjev/tree/cd8397f/docs/decision)). The TypeScript verdict code must pass the same check against that file.
- The 0.5 outcome correlation is assumed; it is re-measured on the first real labelled file.
- How long a person takes to label one answer is unmeasured, so whether 30 cases fits one sitting is open.

## Cost guards and tolerance
Added with the verdict code (#48). These cover files whose costs give no usable ratio; they never change a verdict on real per-call prices.

- **Two more ways to reach "not enough evidence"**, reported as rule 1:
  - `no-cost-ratio`: Jev and the LLM both cost $0 per accepted answer on the paired cases, so there is no ratio.
  - `cost-not-finite`: either paired spend is not a finite number, or n times the largest single paired cost is not (a resample can repeat that case n times), or the ratio of the two costs per accepted overflows.
- **Order.** Both guards run after the four rule-1 conditions above and after the first three rule-2 conditions (rule within the margin, Jev clearly worse, Jev 0 accepted), which do not read cost. They run before "Jev clearly dearer" and rule 3, the first conditions that need the ratio. So a file where Jev is clearly worse still gets "don't use Jev" even when every cost is $0.
- **Tolerance.** Spend is a sum of floating-point numbers, so a ratio that is exactly 0.8 in decimal can come out as 0.8000000000000002. Every comparison with 0.8 or 1 uses a tolerance of 1e-9 (`COST_TOLERANCE` in `src/core/verdict.ts`): ratio 0.8 or less means at most 0.8 + 1e-9; the upper bound is below 1 when under 1 - 1e-9; the lower bound is above 1 when over 1 + 1e-9; "cheaper, but by less than 20%" applies when the ratio is under 1 - 1e-9.
- **Extra resample redraws**, as in "Cost ratio interval": a resample where both cost $0 per accepted, or whose ratio overflows, is drawn again.
