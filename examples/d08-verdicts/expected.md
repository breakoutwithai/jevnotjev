# Day 8 verdict fixtures

Synthetic `jnj-record/1` files for the paths `examples/d06-tiny/` cannot reach (`d06-tiny/expected.md:91-92`), one per verdict branch, with every count worked by hand below. Each file is one decision point (`q1`, prompt `d08.v1`) and was written by `bun examples/d08-verdicts/make.ts`; `src/core/verdict.test.ts` checks the committed files equal that output. The rules are `docs/decision/verdict-rules.md` and nothing else.

## How the files are built
- Every case's correct answer is "yes"; an accepted row answers yes, a rejected row answers no. Every row is labelled by a human.
- Per-call costs, as in d06: Jev $0.00002, LLM $0.002, rule $0. Two files change one cost on purpose (below), because the cost conditions of rules 2 and 4 cannot be reached at those prices.
- a to d count Jev against the other answerer: a both accept, b Jev only, c other only, d both reject. For the rule comparison the rule is first (rule minus Jev, `verdict-rules.md:62`), so b and c swap.
- Cases are numbered c01 upwards and filled in the order a, b, c, d; rule rows accept from c01 upwards.

## Counts and point values (exact)
Cost per accepted = spend / accepted; ratio = Jev cost per accepted / LLM cost per accepted.

| File | Cases | Jev vs LLM a b c d | Jev acc | LLM acc | Jev spend | LLM spend | Jev per acc | LLM per acc | Ratio | Jev minus LLM | Rule acc | Rule minus Jev |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r1-no-jev | 30 | no Jev rows | | 27 | | 30 x 0.002 = $0.06 | | 0.06 / 27 = $0.0022222 | | | 10 | |
| r1-no-llm | 30 | no LLM rows | 27 | | 30 x 0.00002 = $0.0006 | | 0.0006 / 27 = $0.0000222 | | | | 10 | 10/30 - 27/30 = -0.5667 |
| r1-29-paired | 29 | 26 2 1 0 | 28 | 27 | 29 x 0.00002 = $0.00058 | 29 x 0.002 = $0.058 | $0.0000207 | $0.0021481 | 0.00058/28 / (0.058/27) = 0.0096 | 28/29 - 27/29 = 0.0345 | | |
| r1-both-zero | 30 | 0 0 0 30 | 0 | 0 | $0.0006 | $0.06 | undefined (0 accepted) | undefined (0 accepted) | none | 0 | | |
| r1-cost-missing | 30 | 27 3 0 0 | 30 | 27 | incomplete (c01 Jev cost missing; $0.00058 known) | $0.06 | incomplete | $0.0022222 | none | 0.1 | | |
| r2-rule-within-margin | 30 | 27 0 0 3 | 27 | 27 | $0.0006 | $0.06 | $0.0000222 | $0.0022222 | 0.01 | 0 | 30 | 30/30 - 27/30 = 0.1 (rule-first a=27 b=3 c=0 d=0) |
| r2-jev-worse | 30 | 15 0 15 0 | 15 | 30 | $0.0006 | $0.06 | $0.00004 | $0.002 | 0.02 | 15/30 - 30/30 = -0.5 | | |
| r2-jev-zero | 30 | 0 0 1 29 | 0 | 1 | $0.0006 | $0.06 | undefined (0 accepted) | $0.06 | infinity | 0/30 - 1/30 = -0.0333 | | |
| r2-jev-dearer | 30 | 27 3 0 0 | 30 | 27 | 30 x 0.004 = $0.12 | $0.06 | $0.004 | $0.0022222 | 0.004 / 0.0022222 = 1.8 | 0.1 | | |
| r3-use-jev | 30 | 27 3 0 0 | 30 | 27 | $0.0006 | $0.06 | $0.00002 | $0.0022222 | 0.00002 / 0.0022222 = 0.009 | 0.1 | 10 | 10/30 - 30/30 = -0.6667 (rule-first a=10 b=0 c=20 d=0) |
| r4-accept-rate | 30 | 27 0 0 3 | 27 | 27 | $0.0006 | $0.06 | $0.0000222 | $0.0022222 | 0.01 | 0 | | |
| r4-cheaper-under-20 | 30 | 27 3 0 0 | 30 | 27 | 30 x 0.002 = $0.06 | $0.06 | $0.002 | $0.0022222 | 0.002 / 0.0022222 = 0.9 | 0.1 | | |

The two cost changes: `r2-jev-dearer` charges Jev $0.004 per call, and `r4-cheaper-under-20` charges Jev $0.002 per call.

## Intervals
Newcombe method 10 bounds, to 4 places, as `newcombePaired()` in `src/core/calc.ts` prints them; that code matches all 7 rows of Newcombe's Table III (R5.e). They follow from the counts alone.

| a b c d (first, second) | Used in | Lower | Upper |
|---|---|---|---|
| 27 3 0 0 | Jev minus LLM in r1-cost-missing, r2-jev-dearer, r3-use-jev, r4-cheaper-under-20; rule minus Jev in r2-rule-within-margin | -0.0310 | 0.2562 |
| 27 0 0 3 | Jev minus LLM in r2-rule-within-margin, r4-accept-rate | -0.1097 | 0.1097 |
| 15 0 15 0 | r2-jev-worse | -0.6685 | -0.2969 |
| 0 0 1 29 | r2-jev-zero | -0.1667 | 0.0834 |
| 10 0 20 0 | rule minus Jev in r3-use-jev | -0.8077 | -0.4548 |

Cost ratio intervals need no simulation to check, because in these files only the LLM's accepted count k varies between resamples (Jev accepts every case, or accepts exactly the cases the LLM does), so each resample's ratio is a fixed number times k:

| File | Ratio in a resample with k LLM accepts of 30 | 2.5th to 97.5th percentile |
|---|---|---|
| r2-jev-dearer | 0.004 / (0.06 / k) = k / 15 | 1.6 (k = 24) to 2.0 (k = 30) |
| r3-use-jev | 0.00002 / (0.06 / k) = k / 3,000 | 0.0077 (k = 23) to 0.0100 (k = 30) |
| r4-accept-rate | Jev and the LLM accept the same cases: 0.00002 / 0.002 | 0.01 to 0.01 |
| r4-cheaper-under-20 | 0.002 / (0.06 / k) = k / 30 | 0.8 (k = 24) to 1.0 (k = 30) |

The k at each percentile comes from the 2,000 seeded resamples (seed: first 32 bits of the file's SHA-256), so it is the code's draw, not hand arithmetic; the formula for the ratio at that k is.

## Verdicts
First match wins, in the order of `verdict-rules.md:53-69`.

| File | Verdict | Rule | Condition that decides it |
|---|---|---|---|
| r1-no-jev | not enough evidence | 1 | no `jev` rows: "no Jev results", never don't use Jev (R6.f) |
| r1-no-llm | not enough evidence | 1 | no `llm` rows |
| r1-29-paired | not enough evidence | 1 | 29 paired Jev and LLM cases, fewer than 30: add 1 more labelled case |
| r1-both-zero | not enough evidence | 1 | Jev and the LLM both have 0 accepted |
| r1-cost-missing | not enough evidence | 1 | the c01 Jev row is paired and has no cost |
| r2-rule-within-margin | don't use Jev | 2 | 30 paired rule cases; lower bound of rule minus Jev -0.0310, above -0.10 |
| r2-jev-worse | don't use Jev | 2 | upper bound of Jev minus LLM -0.2969, below -0.10 |
| r2-jev-zero | don't use Jev | 2 | Jev 0 accepted, LLM 1. On its own: the upper bound 0.0834 is not below -0.10 and there are no rule rows |
| r2-jev-dearer | don't use Jev | 2 | cost ratio 1.8, lower bound 1.6, above 1 |
| r3-use-jev | use Jev | 3 | lower bound -0.0310 above -0.10; ratio 0.009, 0.8 or less, upper bound 0.0100 below 1. The rule is compared (30 cases) and its lower bound -0.8077 is not above -0.10 |
| r4-accept-rate | not enough evidence | 4 | lower bound of Jev minus LLM -0.1097, not above -0.10 (identical answers on 30 cases at 90% are not enough to show the 10-point margin) |
| r4-cheaper-under-20 | not enough evidence | 4 | cost ratio 0.9: "cheaper, but by less than 20%"; its upper bound 1.0 is not below 1 either |
