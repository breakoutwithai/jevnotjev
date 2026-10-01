# TokenMax minimum-evidence research (d05)

> **Research record, 2026-09-29.** Kept as written, apart from private file paths replaced with a note. Where it describes a routing question (trivial / ordinary / hard prompts sent to Haiku, Sonnet or Opus), that premise was dropped on 2026-09-28 and is history, not a plan: see `docs/decision/verdict-rules.md` and `FLOW.md` for the current method. Prices were re-checked on 2026-09-30 against first-party pages and three price lists: 12 of 12 listed models unchanged. On 2026-10-01 (#38) the simulation was ported to [sim.ts](sim.ts) and `sim_out.txt` regenerated; every value is within Monte Carlo tolerance of the first run (see [README.md](README.md)), and the simulation numbers below were updated to the regenerated output.


Script: [sim.ts](sim.ts) (Bun, seed 20260929, about 22 s). Full output: `sim_out.txt`. First run 2026-09-29; regenerated 2026-10-01 on Bun 1.4.2.
Tags: SRC = opened this session; SIM = my script; UNVERIFIED = memory or inference, source not opened.

## 1. Which test for paired accept/reject

Data is a 2x2 per case: both accept (a), Jev only (b), LLM only (c), neither (d). Only b and c carry information about the difference.

**McNemar exact.** Conditional binomial test on the discordant pairs: b ~ Binomial(b+c, 0.5) under "no difference". Wikipedia: chi-square is poorly approximated when b+c < 25, use the exact binomial; it adds that exact and continuity-corrected versions are "overly conservative" and mid-P is better (SRC https://en.wikipedia.org/wiki/McNemar%27s_test). It tests difference = 0 only. TokenMax asks "not more than X points worse", a non-inferiority question, so McNemar alone answers the wrong question. Useful as a secondary "is Jev reliably different" flag.

**Wilson / Clopper-Pearson on the difference.** Neither is defined for a paired difference directly. The paired analogue is Newcombe 1998 method 10: Wilson score limits for each marginal rate, combined with a correlation term phi from the 2x2 table. Newcombe's abstract calls it a "computationally simpler method ... [that] also performs well"; his simulations give mean coverage above 0.95 across the zones examined, and he says paired designs are used for equivalence, where the interval is compared with a prespecified margin (SRC https://www.eiti.uottawa.ca/~nat/Courses/csi5388/Newcombe.1998.pdf, Stat Med 17:2635-2650; local pdftotext read). The simulation uses `src/core/calc.ts`, whose method 10 (phi with the n/2 correction) matches the 7 method-10 rows of the paper's Table III (`src/core/calc.test.ts`). Clopper-Pearson is the exact single-proportion interval, appropriate for one answerer's accept rate, and conservative (UNVERIFIED, not opened).

**Paired bootstrap.** Resample cases with both labels together, take the percentile interval of (Jev rate minus LLM rate). Simple and extends to cost per accepted. Weakness at small n with few discordant pairs (SIM below): it over-claims.

**Recommendation for n = 10 to 100:** Newcombe paired interval (method 10) for the accept-rate difference, decision by comparing the interval with the margin; exact McNemar as the secondary flag; paired bootstrap only for cost per accepted and only from n >= 30. Evidence: SIM part A, and Newcombe's coverage results.

## 2. Simulation

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

## 3. Edge cases

| Case | Handling | Source |
|---|---|---|
| Zero accepted | Cost per accepted is undefined (0 in denominator). Show "no accepted results", total cost, cost per case. Accept-rate upper bound about 3/n (n=30: 10%) | rule of three, SRC https://en.wikipedia.org/wiki/Rule_of_three_(statistics) |
| All accepted | Rate 100%. Wilson-based intervals stay non-degenerate (Wald would give zero width). Verdict driven by the difference interval | Newcombe uses Wilson (SRC); degenerate-Wald claim UNVERIFIED |
| Ties (both accept or both reject) | Concordant pairs add no information to McNemar; they only tighten Wilson marginals. Do not drop them from n | McNemar definition (SRC); rest UNVERIFIED |
| Missing labels | Exclude the whole case for the answerers compared, report count excluded, never treat unlabelled as reject. Complete-case analysis is unbiased only if missingness is unrelated to the outcome | UNVERIFIED (standard practice, no source opened) |
| Free rule (cost 0) | Cost per accepted = 0. Ratio to other answerers undefined, bootstrap CI is [0, 0]. Show "free" and the other answerer's absolute cost per accepted; the verdict rests on accept rate only | UNVERIFIED (arithmetic) |
| Cost per accepted, few accepted | Ratio CI blows up as accepted count falls (part B: width above 100% at n=10). Report as not enough evidence below the minimum n | SIM |

## 4. Human labelling time

Maddalena, Degl'Innocenti, Basaldella, Mizzaro, "Crowdsourcing Relevance Assessments: The Unexpected Benefits of Limiting the Time to Judge", AAAI HCOMP 2016 (SRC https://cdn.aaai.org/ojs/13284/13284-64-16801-1-2-20201228.pdf, read via pdftotext):
- Literature cited there: average 100 s per AQUAINT document (Villa and Halvey 2013); expert judges up to 140 s, crowd workers up to 90 s (Yilmaz et al. 2014).
- Their own crowd data: 97% of recorded times between 2 and 100 s, about 80% under 35 s, about 60% between 5 and 35 s.
- Abstract: top judgment quality with 25 to 30 s per topic-document pair; under 5 s reads as spam.
These are document-relevance judgments on long text. A short TokenMax item is likely faster, but I found no published figure for short accept/reject items: UNVERIFIED. Grady and Lease (aclanthology W10-0727) was opened but no per-item time figure was extracted.

Planning arithmetic using 30 s per label (my assumption from the 25 to 30 s figure): 3 answers per case.
- 30 cases: 90 labels, 45 min.
- 50 cases: 150 labels, 75 min.
- 100 cases: 300 labels, 2.5 h.

## 5. Recommended defaults (each tied to section 2)

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
