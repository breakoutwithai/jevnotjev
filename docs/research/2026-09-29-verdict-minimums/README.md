# Research: how much evidence a verdict needs (2026-09-29)

**Question.** Before writing the verdict rules (`docs/decision/verdict-rules.md`), what minimum number of cases, what margin and what cost bar make a use Jev / don't use Jev / not enough evidence verdict trustworthy, and what does collecting that evidence cost a builder?

**Answer used.** 30 paired labelled cases, a 10-point accept-rate margin, a cost ratio of 0.8 or less with its upper bound below 1. At 10 and 20 cases an equally good Jev reaches "use Jev" in only 2% to 13% of simulated test sets; at 30, 17% to 22%.

| File | What it covers |
|---|---|
| [verdict-rules.md](../../decision/verdict-rules.md) "Statistical basis" | Which paired test, the simulation, the case floor and margin |
| [models.md](models.md) | Other models' list prices (fetched 2026-09-29, re-checked 2026-09-30) |

The simulation is [`sim.ts`](sim.ts) (Bun, seed 20260929, about 22 s on Bun 1.4.2); its output is [`sim_out.txt`](../../decision/sim_out.txt). Regenerate from the repo root with `bun docs/research/2026-09-29-verdict-minimums/sim.ts > docs/decision/sim_out.txt`. Wilson and Newcombe come from `src/core/calc.ts`, random numbers from mulberry32 with Box-Muller normals, and Jev and LLM outcomes are correlated through a Gaussian copula, as in the first run.

**Port check (2026-10-01, #38).** `sim.ts` uses a different random generator from the first run of 2026-09-29 (history at cd8397f), so cells match within Monte Carlo error, not exactly. The tolerance was fixed before comparing:
- Shares (every Part A value; Part B's "%reps Jev has <=2 accepts"): within when |new - old| <= 4 SE + r, with SE = sqrt(2 p (1-p) / K) for two independent runs, p the mean of the two values, K the test sets behind the cell (2,000 Newcombe, 400 bootstrap, 300 Part B), and r the print rounding (1 point; 0.1 in Part B).
- Part B widths (a median over 300 sets, not a share): SD measured for each cell over 20 runs of `sim.ts` with other seeds; within when |new - old| <= 4 sqrt(2) SD + 1.

Result: 760 values compared (720 in Part A, 40 in Part B), 760 within tolerance, 360 identical. Largest difference 8 points: Part A, rho 0.5, margin 0.10, bootstrap, p_llm 0.9, drop 0.05, n=100, `ok` 26% before and 18% now, against a tolerance of 12.7. Largest Part B difference 5 points: ratio width, n=10, p_llm 0.9, 105% before and 100% now, tolerance 13.3. The regenerated file replaced the first run's output, and the numbers quoted from it here, in `docs/decision/verdict-rules.md` were updated to match.

**Not proven.** Labelling time per answer is unmeasured.

**How research is filed.** One folder per question under `docs/research/<date>-<slug>/`: a README with the question, the answer, sources with dates and what is unproven; scripts and outputs beside it. Raw captures and anything private stay out of this repo.
