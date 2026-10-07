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
4. **Not enough evidence** otherwise. The screen names every rule-3 condition that was not met. It gives no count of more cases: the research behind these settings states no sample size for a stable verdict (no source gives the n needed), and a projection from the observed counts would be a rule this document does not argue (#49). The only count the screen gives is rule 1's: 30 minus the paired cases.

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

## Statistical basis (research record)

> **Research record, 2026-09-29.** Kept as written, apart from private file paths removed. Where it describes a routing question (trivial / ordinary / hard prompts sent to Haiku, Sonnet or Opus), that premise was dropped on 2026-09-28 and is history, not a plan: see the rules above and `FLOW.md` for the current method. Prices were re-checked on 2026-09-30 against first-party pages and three price lists: 12 of 12 listed models unchanged. On 2026-10-01 (#38) the simulation was ported to [sim.ts](../research/2026-09-29-verdict-minimums/sim.ts) and `sim_out.txt` regenerated; every value is within Monte Carlo tolerance of the first run (see the [research README](../research/2026-09-29-verdict-minimums/README.md)), and the simulation numbers below were updated to the regenerated output.


Script: [sim.ts](../research/2026-09-29-verdict-minimums/sim.ts) (Bun, seed 20260929, about 22 s). Full output: `sim_out.txt`. First run 2026-09-29; regenerated 2026-10-01 on Bun 1.4.2.
Tags: SRC = opened this session; SIM = my script; UNVERIFIED = memory or inference, source not opened.

### 1. Which test for paired accept/reject

Data is a 2x2 per case: both accept (a), Jev only (b), LLM only (c), neither (d). Only b and c carry information about the difference.

**McNemar exact.** Conditional binomial test on the discordant pairs: b ~ Binomial(b+c, 0.5) under "no difference". Wikipedia: chi-square is poorly approximated when b+c < 25, use the exact binomial; it adds that exact and continuity-corrected versions are "overly conservative" and mid-P is better (SRC https://en.wikipedia.org/wiki/McNemar%27s_test). It tests difference = 0 only. TokenMax asks "not more than X points worse", a non-inferiority question, so McNemar alone answers the wrong question. Useful as a secondary "is Jev reliably different" flag.

**Wilson / Clopper-Pearson on the difference.** Neither is defined for a paired difference directly. The paired analogue is Newcombe 1998 method 10: Wilson score limits for each marginal rate, combined with a correlation term phi from the 2x2 table. Newcombe's abstract calls it a "computationally simpler method ... [that] also performs well"; his simulations give mean coverage above 0.95 across the zones examined, and he says paired designs are used for equivalence, where the interval is compared with a prespecified margin (SRC https://www.eiti.uottawa.ca/~nat/Courses/csi5388/Newcombe.1998.pdf, Stat Med 17:2635-2650; local pdftotext read). The simulation uses `src/core/calc.ts`, whose method 10 (phi with the n/2 correction) matches the 7 method-10 rows of the paper's Table III (`src/core/calc.test.ts`). Clopper-Pearson is the exact single-proportion interval, appropriate for one answerer's accept rate, and conservative (UNVERIFIED, not opened).

**Paired bootstrap.** Resample cases with both labels together, take the percentile interval of (Jev rate minus LLM rate). Simple and extends to cost per accepted. Weakness at small n with few discordant pairs (SIM below): it over-claims.

**Recommendation for n = 10 to 100:** Newcombe paired interval (method 10) for the accept-rate difference, decision by comparing the interval with the margin; exact McNemar as the secondary flag; paired bootstrap only for cost per accepted and only from n >= 30. Evidence: SIM part A, and Newcombe's coverage results.

### 2. Simulation

Setup (all SIM). Jev and LLM outcomes per case are correlated via a Gaussian copula, latent rho 0.5 (ASSUMPTION, no data; rho 0 also run, in sim_out.txt, gives similar shape). 2000 reps per Newcombe cell, 400 per bootstrap cell. Rule: interval for (Jev minus LLM) accept rate. `ok` if lower bound > -X. `reject` if upper bound < -X. Otherwise `not enough evidence` (nee). Cells are %ok / %reject / %nee.

Newcombe interval, margin X = 0.10, rho 0.5:

| p_llm | Jev drop | n=10 | n=20 | n=30 | n=50 | n=100 |
|---|---|---|---|---|---|---|
| 0.8 | 0.00 | 4/0/96 | 13/0/87 | 17/0/83 | 31/0/69 | 53/0/47 |
| 0.8 | 0.05 | 2/0/98 | 6/0/94 | 5/0/94 | 10/0/90 | 16/0/84 |
| 0.8 | 0.10 | 1/1/98 | 2/2/97 | 2/2/96 | 2/2/96 | 2/2/95 |
| 0.9 | 0.00 | 2/0/98 | 11/0/89 | 22/0/78 | 38/0/62 | 70/0/30 |
| 0.9 | 0.05 | 1/0/99 | 5/0/95 | 6/0/93 | 11/0/88 | 21/0/79 |
| 0.9 | 0.10 | 1/1/99 | 1/1/98 | 2/1/97 | 3/1/96 | 3/2/95 |

Newcombe interval, margin X = 0.05, rho 0.5 (selected rows):

| p_llm | Jev drop | n=10 | n=20 | n=30 | n=50 | n=100 |
|---|---|---|---|---|---|---|
| 0.8 | 0.00 | 2/0/98 | 6/1/94 | 5/0/94 | 10/0/90 | 17/0/83 |
| 0.9 | 0.00 | 1/0/99 | 3/0/97 | 6/0/94 | 12/0/88 | 25/0/75 |
| 0.8 | 0.10 | 0/2/98 | 1/4/95 | 1/4/95 | 0/9/91 | 0/15/85 |
| 0.9 | 0.10 | 0/1/99 | 0/3/97 | 0/5/95 | 0/10/90 | 0/17/83 |

Findings:
- A 5-point margin is unreachable: at n=100 and a truly equal Jev, only 17% (p 0.8) to 25% (p 0.9) of test sets reach `ok`.
- A 10-point margin with a truly equal Jev reaches `ok` in 53% to 70% of sets at n=100, 17% to 22% at n=30, under 5% at n=10.
- False `ok` when Jev is exactly 10 points worse (the margin boundary) stays 1% to 3% at every n. The rule errs toward "not enough evidence", not toward wrong go-decisions.
- Bootstrap percentile interval over-claims at n=10 (rho 0.5, X=0.10, drop 0.10): 12% (p 0.8) and 19% (p 0.9) false `ok`, against 1% and 1% for Newcombe. From n=20 it tracks Newcombe within a few points.

Cost per accepted, bootstrap CI width as % of the point estimate (median of 300 reps, 500 resamples; LLM mean $0.01 per call, Jev $0.0001, 100x gap; lognormal per-call sigma 0.5, an ASSUMPTION; Jev drop 0.05, rho 0.5):

| n | p_llm | LLM width % | Jev width % | LLM/Jev ratio width % |
|---|---|---|---|---|
| 10 | 0.8 | 91 | 104 | 120 |
| 20 | 0.8 | 64 | 70 | 86 |
| 30 | 0.8 | 51 | 56 | 70 |
| 50 | 0.8 | 40 | 43 | 54 |
| 100 | 0.8 | 28 | 30 | 38 |
| 10 | 0.9 | 71 | 80 | 100 |
| 20 | 0.9 | 51 | 57 | 74 |
| 30 | 0.9 | 43 | 49 | 61 |
| 50 | 0.9 | 33 | 37 | 48 |
| 100 | 0.9 | 24 | 26 | 34 |

Width tracks 1/sqrt(accepted count), not the cost gap. Zero of 300 reps had 2 or fewer Jev accepts at p >= 0.75, so the undefined case did not occur in the sim; it appears only when the true accept rate is low (not simulated).

### 3. Edge cases

| Case | Handling | Source |
|---|---|---|
| Zero accepted | Cost per accepted is undefined (0 in denominator). Show "no accepted results", total cost, cost per case. Accept-rate upper bound about 3/n (n=30: 10%) | rule of three, SRC https://en.wikipedia.org/wiki/Rule_of_three_(statistics) |
| All accepted | Rate 100%. Wilson-based intervals stay non-degenerate (Wald would give zero width). Verdict driven by the difference interval | Newcombe uses Wilson (SRC); degenerate-Wald claim UNVERIFIED |
| Ties (both accept or both reject) | Concordant pairs add no information to McNemar; they only tighten Wilson marginals. Do not drop them from n | McNemar definition (SRC); rest UNVERIFIED |
| Missing labels | Exclude the whole case for the answerers compared, report count excluded, never treat unlabelled as reject. Complete-case analysis is unbiased only if missingness is unrelated to the outcome | UNVERIFIED (standard practice, no source opened) |
| Free rule (cost 0) | Cost per accepted = 0. Ratio to other answerers undefined, bootstrap CI is [0, 0]. Show "free" and the other answerer's absolute cost per accepted; the verdict rests on accept rate only | UNVERIFIED (arithmetic) |
| Cost per accepted, few accepted | Ratio CI blows up as accepted count falls (part B: width above 100% at n=10). Report as not enough evidence below the minimum n | SIM |

### 4. Human labelling time

Maddalena, Degl'Innocenti, Basaldella, Mizzaro, "Crowdsourcing Relevance Assessments: The Unexpected Benefits of Limiting the Time to Judge", AAAI HCOMP 2016 (SRC https://cdn.aaai.org/ojs/13284/13284-64-16801-1-2-20201228.pdf, read via pdftotext):
- Literature cited there: average 100 s per AQUAINT document (Villa and Halvey 2013); expert assessors up to 140 s, crowd workers up to 90 s (Yilmaz et al. 2014).
- Their own crowd data: 97% of recorded times between 2 and 100 s, about 80% under 35 s, about 60% between 5 and 35 s.
- Abstract: top judgment quality with 25 to 30 s per topic-document pair; under 5 s reads as spam.
These are document-relevance judgments on long text. A short TokenMax item is likely faster, but I found no published figure for short accept/reject items: UNVERIFIED. Grady and Lease (aclanthology W10-0727) was opened but no per-item time figure was extracted.

Planning arithmetic using 30 s per label (my assumption from the 25 to 30 s figure): 3 answers per case.
- 30 cases: 90 labels, 45 min.
- 50 cases: 150 labels, 75 min.
- 100 cases: 300 labels, 2.5 h.

### 5. Recommended defaults (each tied to section 2)

| Setting | Default | Tie to evidence |
|---|---|---|
| Minimum labelled paired cases for any verdict | 30 | Below 30, `ok` fires in under 20% of equal-quality cases (n=20: 11% to 13%, n=10: 2% to 4%) and cost CI width is above 50% of the estimate (n=30: 43% to 56%). Bootstrap over-claims at n=10 |
| Recommended cases shown in UI | 50 to 100 | n=100 is the first size where a truly equal Jev reaches `ok` in over half of sets (53% to 70%); 100 cases is about 2.5 h of labelling at 30 s |
| Allowed accept-rate drop (margin X) | 0.10 (10 points) | X=0.05 reaches `ok` in only 17% to 25% at n=100; X=0.10 gives 53% to 70% with 1% to 3% false `ok` at the boundary |
| "Use Jev" rule | Newcombe 95% lower bound of (Jev minus LLM) > -0.10 AND cost per accepted lower than LLM | As above |
| "Don't use Jev" rule | Upper bound < -0.10 | At the margin boundary (Jev exactly 10 points worse, X=0.10, rho 0.5, Newcombe) it fires in 1% to 2% of test sets at n=30 to 100. Drops larger than 0.10 were not simulated at X=0.10, so how often it fires when Jev is much worse is UNVERIFIED |
| Margin for "cheaper" | Cost-per-accepted ratio (Jev/LLM) point estimate <= 0.8 and bootstrap upper bound < 1.0 | With 100x per-call gaps the ratio interval cannot reach 1 even at n=10; with realistic gaps of 1.5x to 2x it would (not simulated, UNVERIFIED). Width 61% to 70% at n=30 means a 0.8 point estimate needs a genuine gap |
| Everything else | "Not enough evidence", show the interval and the count of labels needed | Most cells (over 80% at n <= 30) land here by design |

Caveats: rho 0.5 and sigma 0.5 are assumptions, so rerun `sim.ts` with the builder's real pilot correlation and cost spread. The sim does not cover true drops above 0.10, low accept rates (p_llm below 0.8), or missing labels.
