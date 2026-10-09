# What `scripts/math-check.ts` compares

`bun scripts/math-check.ts <records.csv> [--last N] [--json]` recomputes the verdict figures from the CSV, written from `docs/decision/verdict-rules.md` with Node built-ins only, and compares them with the stdout of `bun src/decide/cli.ts verdict <file>`. This table has one row per numeric leaf of that verdict JSON, across every shape the command prints (a question that stops at rule 1, one that reaches the cost ratio, a compared or skipped rule comparison, complete or incomplete spend). `scripts/math-check.test.ts` (D15.c) fails when the verdict JSON of this fixture or of d06-tiny has a numeric leaf missing here.

## Tolerances
- Counts and rates (n, accepted, a to d, rates, p1, p2, diff, the interval bounds, addN, resamples): **1e-9 absolute**.
- Money and ratios (spend, cost per accepted, per-case costs, the cost ratio): **1e-9 relative**, the scale of the float error in a sum of costs (verdict-rules.md "Cost guards and tolerance" uses the same 1e-9).
- A blank, missing, `NaN`, text or non-finite app value where a number is expected is a mismatch, never a pass. The one exception is a hand value that is itself infinite: JSON prints infinity as `null`, so `null` is then the expected value, and an infinite hand value is never put through tolerance arithmetic.
- The app's verdicts are matched on the full (run_id, prompt_version, question_id); a verdict entry that is not an object, lacks one of the three, or repeats a key is bad input.

## Statuses
- **formula**: recomputed from the CSV by verdict-rules.md and compared.
- **partial**: compared only in part or only in some shapes; the reason says which.
- **excluded**: not compared; the reason says why.

| Leaf | Status | Reason |
|---|---|---|
| `exit_code` | partial | Recomputed from the per-question verdicts (docs/api.md "Exit codes"); a verdict that turns on the cost-ratio interval uses the app's bounds |
| `verdicts[].rule` | partial | Rules 1 and 2 (bar "clearly dearer") recomputed in full; "clearly dearer", rule 3 and rule 4 read the app's cost-ratio bounds, which are not recomputed |
| `verdicts[].addN` | formula | 30 minus the paired count, when rule 1 stops on too few paired cases; null otherwise and not compared |
| `verdicts[].numbers.jevVsLlm.n` | formula | Cases where Jev and the LLM both have a labelled row; unlabelled and `agent` rows drop out |
| `verdicts[].numbers.jevVsLlm.excluded` | formula | Cases with a Jev or LLM row that are not paired |
| `verdicts[].numbers.jevVsLlm.jev.accepted` | formula | Accepted Jev rows on the paired cases |
| `verdicts[].numbers.jevVsLlm.jev.acceptRate` | formula | accepted / n |
| `verdicts[].numbers.jevVsLlm.jev.spend.usd` | formula | Sum of cost_usd on the paired Jev rows, when none is missing |
| `verdicts[].numbers.jevVsLlm.jev.spend.knownUsd` | formula | Sum of the known costs when a paired Jev cost is missing |
| `verdicts[].numbers.jevVsLlm.jev.spend.missing` | formula | Paired Jev rows with no cost |
| `verdicts[].numbers.jevVsLlm.jev.costPerAccepted.usd` | formula | spend / accepted; its kind (value, undefined at 0 accepted, incomplete when a cost is missing) is compared as a state |
| `verdicts[].numbers.jevVsLlm.otherArm.accepted` | formula | As for Jev, LLM side |
| `verdicts[].numbers.jevVsLlm.otherArm.acceptRate` | formula | As for Jev, LLM side |
| `verdicts[].numbers.jevVsLlm.otherArm.spend.usd` | formula | As for Jev, LLM side |
| `verdicts[].numbers.jevVsLlm.otherArm.spend.knownUsd` | formula | As for Jev, LLM side |
| `verdicts[].numbers.jevVsLlm.otherArm.spend.missing` | formula | As for Jev, LLM side |
| `verdicts[].numbers.jevVsLlm.otherArm.costPerAccepted.usd` | formula | As for Jev, LLM side |
| `verdicts[].numbers.jevVsLlm.a` | formula | Both accepted |
| `verdicts[].numbers.jevVsLlm.b` | formula | Jev accepted, LLM rejected |
| `verdicts[].numbers.jevVsLlm.c` | formula | LLM accepted, Jev rejected |
| `verdicts[].numbers.jevVsLlm.d` | formula | Both rejected |
| `verdicts[].numbers.jevVsLlm.wins` | formula | b |
| `verdicts[].numbers.jevVsLlm.losses` | formula | c |
| `verdicts[].numbers.jevVsLlm.ties` | formula | a + d |
| `verdicts[].numbers.jevVsLlm.cases[].jevCostUsd` | formula | Each paired case's Jev cost, matched by case id: catches a wrong pairing; a missing cost is null in the app and not compared. Before any cost is read, the app's case ids must be distinct and exactly the hand's paired cases (state `cases[*].caseId`) |
| `verdicts[].numbers.jevVsLlm.cases[].otherCostUsd` | formula | As above, LLM side |
| `verdicts[].numbers.jevVsLlm.p1` | formula | (a + b) / n |
| `verdicts[].numbers.jevVsLlm.p2` | formula | (a + c) / n |
| `verdicts[].numbers.jevVsLlm.diff` | formula | p1 - p2 |
| `verdicts[].numbers.jevVsLlm.lower` | formula | Newcombe method 10 from the two Wilson intervals and phi, recomputed in full |
| `verdicts[].numbers.jevVsLlm.upper` | formula | As lower |
| `verdicts[].numbers.jevAccepted` | formula | Jev accepted on the paired cases |
| `verdicts[].numbers.llmAccepted` | formula | LLM accepted on the paired cases |
| `verdicts[].numbers.costRatio.ratio` | formula | cost per accepted (jev) / cost per accepted (llm), with the 0 case; printed only once rule 1 and the cost-free rule 2 conditions pass. An infinite ratio (LLM at $0 per accepted, Jev above) prints as null, which is then the expected value |
| `verdicts[].numbers.costRatio.lower` | partial | Bootstrap: 2,000 resamples from a seed the app does not print (#168), so the bound is not recomputed; checked to be 0 or more, at or below the upper bound and at or below the hand ratio |
| `verdicts[].numbers.costRatio.upper` | partial | As lower; checked to be at or above the lower bound and the hand ratio. A null bound is read as infinity only when the hand ratio is infinite |
| `verdicts[].numbers.costRatio.resamples` | formula | 2,000, verdict-rules.md "Cost ratio interval" |
| `verdicts[].numbers.costRatio.redrawn` | excluded | Count of redrawn resamples: depends on the seeded draws (#168) |
| `verdicts[].ruleComparison.n` | formula | Cases where Jev and the rule both have a labelled row, when 30 or more |
| `verdicts[].ruleComparison.a` | formula | Both accepted |
| `verdicts[].ruleComparison.b` | formula | Rule accepted, Jev rejected (rule first) |
| `verdicts[].ruleComparison.c` | formula | Jev accepted, rule rejected |
| `verdicts[].ruleComparison.d` | formula | Both rejected |
| `verdicts[].ruleComparison.p1` | formula | Rule accept rate |
| `verdicts[].ruleComparison.p2` | formula | Jev accept rate |
| `verdicts[].ruleComparison.diff` | formula | Rule minus Jev |
| `verdicts[].ruleComparison.lower` | formula | Newcombe method 10, rule minus Jev |
| `verdicts[].ruleComparison.upper` | formula | As lower |
| `verdicts[].ruleComparison.paired` | partial | Compared when the question has rule and Jev rows and fewer than 30 pair; with no rule or no Jev rows the app prints a constant 0, not compared |

States are compared by type and are not counted in `compared`: `verdict`, `condition`, `ruleComparison.kind`, each `spend.kind` and `costPerAccepted.kind` as text; `rule` and `exit_code` as numbers; `unmet` as an ordered list of text; `cases[*].caseId` as a set of distinct text; `numbers.jevVsLlm` as null when nothing pairs (`jevAccepted` and `llmAccepted` are still compared then). `reason` and `limitations` are prose and are not compared.

## Not printed by the app
| Figure | Status | Reason |
|---|---|---|
| Wilson interval of each rate (`wilson1`, `wilson2`, lower and upper) | excluded | app does not expose it (#168); `lower` and `upper`, which are built from it, are compared |
| `phi` | excluded | app does not expose it (#168); `lower` and `upper`, which are built from it, are compared |
| Bootstrap seed | excluded | app does not expose it (#168) |

`math-check.ts` still computes the excluded Wilson and phi values and lists them under `excluded` with the hand value, so a reader can check them against `expected.md`.

## Exit codes
0 when at least 1 figure was compared and none differ; 1 on any mismatch, each named with both values and the tolerance; 2 on bad input (unreadable file, malformed CSV, a records file that breaks the format/README.md contract, checked by math-check itself so `--app-json` cannot skip it, malformed app JSON, `--last` that is not a whole number above 0, or fewer than N cases); 3 when no figure was compared (a file of person-answered rows only: the verdict stops at "no Jev results" and prints no number to check).

## What this catches that `scripts/hand-check.ts` does not
- `hand-check.ts` checks the d06 figures against `expected.md` only; it never reads the app's output, and it throws on any question that passes rule 1. `math-check.ts` compares against the app itself, on any records file.
- The interval figures: Newcombe `lower` and `upper` for Jev against the LLM and for the rule against Jev, through phi with the n/2 reduction (q1 of this fixture, phi 0.505) and its clamp at 0 (q3).
- The later rules: rule 2 (q2, Jev clearly worse), rule 3 (q1, use Jev) and the cost ratio with its interval check.
- Any `--last N` slice of any run: the last N distinct `case_id` values in order of first appearance, sliced to a temporary file and run through the verdict command, with the source file, N and the selection rule printed.
- Pairing errors, through the per-case cost echoes matched by case id.
