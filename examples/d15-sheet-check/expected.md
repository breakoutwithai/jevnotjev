# Day 15: the sheet-check example, worked by hand

`records.csv` is a fictional fixture for checking the verdict maths by hand. Every value below was worked from `docs/decision/verdict-rules.md` "Formulas" and "Verdict, in order", then compared with the app (`bun src/decide/cli.ts verdict examples/d15-sheet-check/records.csv`): 0 differences. `bun scripts/math-check.ts examples/d15-sheet-check/records.csv` repeats that comparison, and `scripts/math-check.test.ts` holds this file's Figures table to it.

d06-tiny has 5 paired cases with b = 0 and d = 0, so phi is 0 and the verdict stops at rule 1. This file reaches what d06 cannot: phi with the n/2 reduction, the Newcombe interval on 30 or more paired cases, the cost ratio, and rules 2 and 3.

## The data
One run (`run-d15`), one prompt version (`sheet-check.v1`), 42 fictional order notes to a fictional shop (`c01` to `c42`), three yes/no questions, 246 rows.

| Question | Cases | Answerers | What it reaches |
|---|---|---|---|
| q1: Is this message asking for a refund or exchange? | c01 to c42 | jev, rule, llm | rule 3, use Jev; phi 0.505 after the n/2 reduction; rule comparison on 42 cases |
| q2: Does the message say when the order arrived? | c01 to c30 | jev, llm | rule 2, Jev clearly worse |
| q3: Is the customer unhappy? | c01 to c30 | jev, llm | rule 1, cost missing; the n/2 reduction stops at 0, so phi is 0 |

## What is real and what is invented
| Column | Source |
|---|---|
| `case_input` | Invented, one line per case. `c07` holds a comma, so the field is quoted |
| `label` | Invented: chosen to give the 2x2 counts below. A label is the call on the answer, so `output` is the case's answer when the label is accept and the other answer when it is reject |
| `jev`, `llm`, `rule` output, confidence, tokens, cost, latency | Invented. No model was called. `example-llm` is not a real model and the rule rows are not a real keyword run. Costs are round numbers for hand arithmetic: $0.00002 per Jev row, $0.002 per LLM row, $0 per rule row |

## Edge states
| Edge | Row | Effect |
|---|---|---|
| Unlabelled row | c41 q1 llm | Left out of the q1 Jev and LLM pairing (format/README.md "Missing cost or labels") |
| `agent` label | c42 q1 llm, a `jnj-record/1.1` row labelled by `example-agent` | Never reviewed by a person, so it counts as unlabelled: left out of the pairing |
| One arm with 0 accepted | q2 jev, 30 rejects | Cost per accepted is undefined; Jev at 0 with the LLM above 0 |
| Missing cost | c30 q3 jev | Jev spend on q3 is incomplete, so q3 stops at rule 1 "cost missing", ahead of any cost ratio |
| Quoted comma | c07 `case_input` | Read as one field |

The edge states sit on different questions on purpose: each question reaches a different rule.

## Formulas used
From verdict-rules.md, for n paired cases with a both accepted, b Jev only, c the other only, d neither:

- accept rate = accepted / n; spend = sum of cost_usd; cost per accepted = spend / accepted (undefined at 0 accepted); cost ratio = cost per accepted(jev) / cost per accepted(llm).
- p1 = (a + b) / n, p2 = (a + c) / n, diff = p1 - p2.
- Wilson 95% interval of x out of n, with p = x / n and z = 1.959963984540054 (the 0.975 quantile of the standard normal): centre = p + z^2/(2n), half = z * sqrt(p(1-p)/n + z^2/(4n^2)), den = 1 + z^2/n; lower = (centre - half) / den (0 when x = 0), upper = (centre + half) / den (1 when x = n). z^2 = 3.84145882069.
- phi = (a*d - b*c) / sqrt((a+b)(c+d)(a+c)(b+d)), with a*d - b*c reduced by n/2 (not below 0) when positive; 0 when the root is 0.
- lower = diff - sqrt((p1 - l1)^2 - 2*phi*(p1 - l1)*(u2 - p2) + (u2 - p2)^2); upper = diff + sqrt((u1 - p1)^2 - 2*phi*(u1 - p1)*(p2 - l2) + (p2 - l2)^2).

## q1: refund or exchange
**Pairing.** Jev and the LLM both have rows for c01 to c42. c41 (LLM unlabelled) and c42 (LLM `agent` label) drop out: **n = 40**, excluded 2.

| Cases | Jev | LLM | Cell |
|---|---|---|---|
| c01 to c28 | accept | accept | a = 28 |
| c29 to c32 | accept | reject | b = 4 |
| c33, c34 | reject | accept | c = 2 |
| c35 to c40 | reject | reject | d = 6 |

| | Jev | LLM |
|---|---|---|
| Accepted | 28 + 4 = 32 | 28 + 2 = 30 |
| Accept rate | 32/40 = 0.8 | 30/40 = 0.75 |
| Spend | 40 x 0.00002 = $0.0008 | 40 x 0.002 = $0.08 |
| Cost per accepted | 0.0008 / 32 = $0.000025 | 0.08 / 30 = $0.00266666666667 |

Cost ratio = 0.000025 / 0.00266666666667 = **0.009375** (3/320).

**Interval for Jev minus LLM.** p1 = 32/40 = 0.8, p2 = 30/40 = 0.75, diff = **0.05**.
- Wilson 32/40: centre = 0.8 + 3.84145882069/80 = 0.848018235259; half = 1.959963984540054 x sqrt(0.16/40 + 3.84145882069/6400) = 0.132934518467; den = 1 + 3.84145882069/40 = 1.09603647052. l1 = 0.652426936536, u1 = 0.895000102746.
- Wilson 30/40: centre = 0.798018235259; half = 0.142522240859; same den. l2 = 0.598060385792, u2 = 0.858128813609.
- phi: a*d - b*c = 168 - 8 = 160, positive, reduced by n/2 = 20 to 140. Root = sqrt(32 x 8 x 30 x 10) = sqrt(76800) = 277.128129211. **phi = 140 / 277.128129211 = 0.505181485541.**
- p1 - l1 = 0.147573063464, u1 - p1 = 0.0950001027456, p2 - l2 = 0.151939614208, u2 - p2 = 0.108128813609.
- lower = 0.05 - sqrt(0.147573063464^2 - 2 x 0.505181485541 x 0.147573063464 x 0.108128813609 + 0.108128813609^2) = **-0.0817094841822**.
- upper = 0.05 + sqrt(0.0950001027456^2 - 2 x 0.505181485541 x 0.0950001027456 x 0.151939614208 + 0.151939614208^2) = **0.182388839828**.

**Rule minus Jev.** The rule has labelled rows on all 42 cases, and so does Jev, so 42 are paired (30 or more: compared). Rule accepts c01 to c18, c35, c36, c41; Jev accepts c01 to c32 and c41.
- both 19 (c01 to c18, c41); rule only 2 (c35, c36); Jev only 14 (c19 to c32); neither 7 (c33, c34, c37 to c40, c42).
- p1 (rule) = 21/42 = 0.5, p2 (Jev) = 33/42 = 0.785714285714, diff = **-0.285714285714**.
- Wilson 21/42: l1 = 0.355259895964, u1 = 0.644740104036. Wilson 33/42: l2 = 0.640601546837, u2 = 0.88294200124.
- phi: 19 x 7 - 2 x 14 = 105, reduced by 21 to 84; root = sqrt(21 x 21 x 33 x 9) = 361.907446732; phi = 0.232103541274.
- lower = **-0.440214306166**, upper = **-0.106110918432**.

**Verdict: use Jev (rule 3).**
1. Rule 1 does not fire: Jev and LLM rows exist, 40 paired (30 or more), 62 accepted between them, every paired cost present.
2. Rule 2 does not fire: rule minus Jev lower -0.440 is not above -0.10; Jev minus LLM upper 0.182 is not below -0.10; Jev has 32 accepted; the cost ratio's lower bound (app: 0.00794, below) is not above 1.
3. Rule 3 holds: lower -0.0817 is above -0.10; cost ratio 0.009375 is 0.8 or less; the upper bound (app: 0.01074) is below 1.

The cost-ratio interval comes from 2,000 seeded resamples (verdict-rules.md "Cost ratio interval"). The seed is not printed by the app (#168), so it is not recomputed here: the app's bounds are stated below as read from the app, and checked only for holding the hand ratio (0.00794 <= 0.009375 <= 0.01074).

## q2: arrival date
30 paired cases (c01 to c30), nothing excluded. Jev rejects all 30; the LLM accepts c01 to c24.

| | Jev | LLM |
|---|---|---|
| Accepted | 0 | 24 |
| Accept rate | 0/30 = 0 | 24/30 = 0.8 |
| Spend | 30 x 0.00002 = $0.0006 | 30 x 0.002 = $0.06 |
| Cost per accepted | undefined (0 accepted) | 0.06 / 24 = $0.0025 |

a = 0, b = 0, c = 24, d = 6. p1 = 0, p2 = 0.8, diff = **-0.8**.
- Wilson 0/30: lower 0 (x = 0), upper = 2 x 0.0640243136782 / 1.12804862736 = 0.113513393174. Wilson 24/30: l2 = 0.626943035869, u2 = 0.904948928227.
- phi: the root is sqrt(0 x 30 x 24 x 6) = 0, so **phi = 0**.
- lower = -0.8 - sqrt(0^2 + 0.104948928227^2) = **-0.904948928227**; upper = -0.8 + sqrt(0.113513393174^2 + 0.173056964131^2) = **-0.593036227169**.

**Verdict: don't use Jev (rule 2, Jev clearly worse).** Rule 1 passes (30 paired, the LLM has 24 accepted, costs complete). The rule comparison is skipped (no rule rows). The upper bound -0.593 is below -0.10, which comes before the one-side 0 accepted check (rule 1, verdict-rules.md "Zero accepted"). No cost ratio is computed.

## q3: unhappy customer
30 paired cases (c01 to c30). Jev accepts c01 to c25; the LLM accepts c01 to c22 and c26 to c29. The Jev row for c30 has no cost.

| | Jev | LLM |
|---|---|---|
| Accepted | 25 | 26 |
| Accept rate | 25/30 = 0.833333333333 | 26/30 = 0.866666666667 |
| Spend | incomplete: 29 x 0.00002 = $0.00058 known, 1 missing (c30) | 30 x 0.002 = $0.06 |
| Cost per accepted | incomplete (cost missing beats the count) | 0.06 / 26 = $0.00230769230769 |

a = 22 (c01 to c22), b = 3 (c23 to c25), c = 4 (c26 to c29), d = 1 (c30). p1 = 0.833333333333, p2 = 0.866666666667, diff = **-0.0333333333333**.
- Wilson 25/30: l1 = 0.664356494936, u1 = 0.926634576282. Wilson 26/30: l2 = 0.70318673318, u2 = 0.946903445159.
- phi: a*d - b*c = 22 - 12 = 10, positive; reduced by n/2 = 15 it would be -5, so it stops at 0: **phi = 0** although the root (114.01754251) is not 0.
- lower = **-0.220392448422**, upper = **0.154897404296**.

**Verdict: not enough evidence (rule 1, cost missing).** 30 paired and 51 accepted pass the first rule 1 conditions; the c30 Jev cost is missing on a paired row.

## Whole file
Matches `bun run validate examples/d15-sheet-check/records.csv`: `VALID rows=246 cases=42 errors=0 gaps=63` (60 of the gaps are q2 and q3 having no rule rows; the others are the unlabelled row, the agent label and the missing cost). The verdict command exits 3, because q2 is "don't use Jev".

## Figures
One row per figure, keyed `<question>:<path in that question's verdict object>` as `scripts/math-check.ts` names them. Values to 12 significant figures. The `wilson` and `phi` rows are not printed by the app (#168); `app.costRatio` rows are the app's bootstrap bounds, read from the app, not worked by hand. The per-case cost echoes (`cases[<id>]`) are not listed: every Jev row costs $0.00002, every LLM row $0.002, except the c30 q3 Jev row, which has none.

| Key | Value |
|---|---|
| `q1:numbers.jevVsLlm.n` | 40 |
| `q1:numbers.jevVsLlm.excluded` | 2 |
| `q1:numbers.jevVsLlm.jev.accepted` | 32 |
| `q1:numbers.jevVsLlm.jev.acceptRate` | 0.8 |
| `q1:numbers.jevVsLlm.jev.spend.kind` | complete |
| `q1:numbers.jevVsLlm.jev.spend.usd` | 0.0008 |
| `q1:numbers.jevVsLlm.jev.costPerAccepted.kind` | value |
| `q1:numbers.jevVsLlm.jev.costPerAccepted.usd` | 0.000025 |
| `q1:numbers.jevVsLlm.otherArm.accepted` | 30 |
| `q1:numbers.jevVsLlm.otherArm.acceptRate` | 0.75 |
| `q1:numbers.jevVsLlm.otherArm.spend.kind` | complete |
| `q1:numbers.jevVsLlm.otherArm.spend.usd` | 0.08 |
| `q1:numbers.jevVsLlm.otherArm.costPerAccepted.kind` | value |
| `q1:numbers.jevVsLlm.otherArm.costPerAccepted.usd` | 0.00266666666667 |
| `q1:numbers.jevVsLlm.a` | 28 |
| `q1:numbers.jevVsLlm.b` | 4 |
| `q1:numbers.jevVsLlm.c` | 2 |
| `q1:numbers.jevVsLlm.d` | 6 |
| `q1:numbers.jevVsLlm.wins` | 4 |
| `q1:numbers.jevVsLlm.losses` | 2 |
| `q1:numbers.jevVsLlm.ties` | 34 |
| `q1:numbers.jevVsLlm.p1` | 0.8 |
| `q1:numbers.jevVsLlm.p2` | 0.75 |
| `q1:numbers.jevVsLlm.diff` | 0.05 |
| `q1:numbers.jevVsLlm.lower` | -0.0817094841822 |
| `q1:numbers.jevVsLlm.upper` | 0.182388839828 |
| `q1:numbers.jevVsLlm.wilson1.lower` | 0.652426936536 |
| `q1:numbers.jevVsLlm.wilson1.upper` | 0.895000102746 |
| `q1:numbers.jevVsLlm.wilson2.lower` | 0.598060385792 |
| `q1:numbers.jevVsLlm.wilson2.upper` | 0.858128813609 |
| `q1:numbers.jevVsLlm.phi` | 0.505181485541 |
| `q1:numbers.jevAccepted` | 32 |
| `q1:numbers.llmAccepted` | 30 |
| `q1:ruleComparison.kind` | compared |
| `q1:ruleComparison.n` | 42 |
| `q1:ruleComparison.a` | 19 |
| `q1:ruleComparison.b` | 2 |
| `q1:ruleComparison.c` | 14 |
| `q1:ruleComparison.d` | 7 |
| `q1:ruleComparison.p1` | 0.5 |
| `q1:ruleComparison.p2` | 0.785714285714 |
| `q1:ruleComparison.diff` | -0.285714285714 |
| `q1:ruleComparison.lower` | -0.440214306166 |
| `q1:ruleComparison.upper` | -0.106110918432 |
| `q1:ruleComparison.wilson1.lower` | 0.355259895964 |
| `q1:ruleComparison.wilson1.upper` | 0.644740104036 |
| `q1:ruleComparison.wilson2.lower` | 0.640601546837 |
| `q1:ruleComparison.wilson2.upper` | 0.88294200124 |
| `q1:ruleComparison.phi` | 0.232103541274 |
| `q1:numbers.costRatio.ratio` | 0.009375 |
| `q1:numbers.costRatio.resamples` | 2000 |
| `q1:verdict` | use Jev |
| `q1:rule` | 3 |
| `q1:condition` | use-jev |
| `q1:unmet` | (none) |
| `q2:numbers.jevVsLlm.n` | 30 |
| `q2:numbers.jevVsLlm.excluded` | 0 |
| `q2:numbers.jevVsLlm.jev.accepted` | 0 |
| `q2:numbers.jevVsLlm.jev.acceptRate` | 0 |
| `q2:numbers.jevVsLlm.jev.spend.kind` | complete |
| `q2:numbers.jevVsLlm.jev.spend.usd` | 0.0006 |
| `q2:numbers.jevVsLlm.jev.costPerAccepted.kind` | undefined |
| `q2:numbers.jevVsLlm.otherArm.accepted` | 24 |
| `q2:numbers.jevVsLlm.otherArm.acceptRate` | 0.8 |
| `q2:numbers.jevVsLlm.otherArm.spend.kind` | complete |
| `q2:numbers.jevVsLlm.otherArm.spend.usd` | 0.06 |
| `q2:numbers.jevVsLlm.otherArm.costPerAccepted.kind` | value |
| `q2:numbers.jevVsLlm.otherArm.costPerAccepted.usd` | 0.0025 |
| `q2:numbers.jevVsLlm.a` | 0 |
| `q2:numbers.jevVsLlm.b` | 0 |
| `q2:numbers.jevVsLlm.c` | 24 |
| `q2:numbers.jevVsLlm.d` | 6 |
| `q2:numbers.jevVsLlm.wins` | 0 |
| `q2:numbers.jevVsLlm.losses` | 24 |
| `q2:numbers.jevVsLlm.ties` | 6 |
| `q2:numbers.jevVsLlm.p1` | 0 |
| `q2:numbers.jevVsLlm.p2` | 0.8 |
| `q2:numbers.jevVsLlm.diff` | -0.8 |
| `q2:numbers.jevVsLlm.lower` | -0.904948928227 |
| `q2:numbers.jevVsLlm.upper` | -0.593036227169 |
| `q2:numbers.jevVsLlm.wilson1.lower` | 0 |
| `q2:numbers.jevVsLlm.wilson1.upper` | 0.113513393174 |
| `q2:numbers.jevVsLlm.wilson2.lower` | 0.626943035869 |
| `q2:numbers.jevVsLlm.wilson2.upper` | 0.904948928227 |
| `q2:numbers.jevVsLlm.phi` | 0 |
| `q2:numbers.jevAccepted` | 0 |
| `q2:numbers.llmAccepted` | 24 |
| `q2:ruleComparison.kind` | skipped |
| `q2:verdict` | don't use Jev |
| `q2:rule` | 2 |
| `q2:condition` | jev-clearly-worse |
| `q2:unmet` | (none) |
| `q3:numbers.jevVsLlm.n` | 30 |
| `q3:numbers.jevVsLlm.excluded` | 0 |
| `q3:numbers.jevVsLlm.jev.accepted` | 25 |
| `q3:numbers.jevVsLlm.jev.acceptRate` | 0.833333333333 |
| `q3:numbers.jevVsLlm.jev.spend.kind` | incomplete |
| `q3:numbers.jevVsLlm.jev.spend.knownUsd` | 0.00058 |
| `q3:numbers.jevVsLlm.jev.spend.missing` | 1 |
| `q3:numbers.jevVsLlm.jev.costPerAccepted.kind` | incomplete |
| `q3:numbers.jevVsLlm.otherArm.accepted` | 26 |
| `q3:numbers.jevVsLlm.otherArm.acceptRate` | 0.866666666667 |
| `q3:numbers.jevVsLlm.otherArm.spend.kind` | complete |
| `q3:numbers.jevVsLlm.otherArm.spend.usd` | 0.06 |
| `q3:numbers.jevVsLlm.otherArm.costPerAccepted.kind` | value |
| `q3:numbers.jevVsLlm.otherArm.costPerAccepted.usd` | 0.00230769230769 |
| `q3:numbers.jevVsLlm.a` | 22 |
| `q3:numbers.jevVsLlm.b` | 3 |
| `q3:numbers.jevVsLlm.c` | 4 |
| `q3:numbers.jevVsLlm.d` | 1 |
| `q3:numbers.jevVsLlm.wins` | 3 |
| `q3:numbers.jevVsLlm.losses` | 4 |
| `q3:numbers.jevVsLlm.ties` | 23 |
| `q3:numbers.jevVsLlm.p1` | 0.833333333333 |
| `q3:numbers.jevVsLlm.p2` | 0.866666666667 |
| `q3:numbers.jevVsLlm.diff` | -0.0333333333333 |
| `q3:numbers.jevVsLlm.lower` | -0.220392448422 |
| `q3:numbers.jevVsLlm.upper` | 0.154897404296 |
| `q3:numbers.jevVsLlm.wilson1.lower` | 0.664356494936 |
| `q3:numbers.jevVsLlm.wilson1.upper` | 0.926634576282 |
| `q3:numbers.jevVsLlm.wilson2.lower` | 0.70318673318 |
| `q3:numbers.jevVsLlm.wilson2.upper` | 0.946903445159 |
| `q3:numbers.jevVsLlm.phi` | 0 |
| `q3:numbers.jevAccepted` | 25 |
| `q3:numbers.llmAccepted` | 26 |
| `q3:ruleComparison.kind` | skipped |
| `q3:verdict` | not enough evidence |
| `q3:rule` | 1 |
| `q3:condition` | cost-missing |
| `q3:unmet` | (none) |
| `q1:app.costRatio.lower` | 0.00794117647059 |
| `q1:app.costRatio.upper` | 0.0107414529915 |
