# Research: how much evidence a verdict needs (2026-09-29)

**Question.** Before writing the verdict rules (`docs/decision/verdict-rules.md`), what minimum number of cases, what margin and what cost bar make a use Jev / don't use Jev / not enough evidence verdict trustworthy, and what does collecting that evidence cost a builder?

**Answer used.** 30 paired labelled cases, a 10-point accept-rate margin, a cost ratio of 0.8 or less with its upper bound below 1. At 10 cases an equally good Jev reaches "use Jev" in only 2% to 13% of simulated test sets; at 30, 18% to 21%.

| File | What it covers |
|---|---|
| [stats.md](stats.md) | Which paired test, the simulation, the case floor and margin |
| [jev.md](jev.md) | Jev's price, limits and our measured grading runs |
| [models.md](models.md) | Other models' list prices (fetched 2026-09-29, re-checked 2026-09-30) |
| [effort.md](effort.md) | Builder minutes per step and where the time goes |

The simulation script and its output are public at [`docs/decision/sim_min_n.py`](https://github.com/breakoutwithai/jevnotjev/blob/cd8397f/docs/decision/sim_min_n.py) (commit cd8397f; removed when the repo dropped Python) and [`sim_out.txt`](../../decision/sim_out.txt).

**Not proven.** Labelling time per answer is unmeasured. Grading accuracy was measured against AI-written labels on a synthetic set. The Jev price is from the vendor's docs page, not a bill.

**How research is filed.** One folder per question under `docs/research/<date>-<slug>/`: a README with the question, the answer, sources with dates and what is unproven; scripts and outputs beside it. Raw captures and anything private stay out of this repo.
