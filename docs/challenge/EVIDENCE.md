# Evidence index, D01 to D12

One row per challenge day: the step in our words, what was built, and the proof a reader can open. Every PR number, merge SHA, tag and URL below was resolved on 2026-10-06 against `breakoutwithai/jevnotjev` at `96f5b14` (`gh pr view`, `git tag --contains`, `curl`). A column with no proof says so; nothing is claimed that does not resolve.

Test counts are the per-file floors in [`.deploy/tests/expected-counts.json`](../../.deploy/tests/expected-counts.json), which `bun scripts/gate.ts` enforces (it fails if a file passes fewer). Line numbers are at `96f5b14`.

Scope of the whole project: [SCOPE.md](../../SCOPE.md).

| Day | Step (our words) | Built | Proof | Open |
|---|---|---|---|---|
| D01 | Enrol and get the plan. Setup only: no portal log exists for this day. | Project chosen and submitted; planning lives outside this repo. | None in this repo, by design. | No public artifact for this day. |
| D02 | Choose the first workflow. | Journeys and stories for the TokenMax use case; candidate use cases UC9 and UC10 (#3), UC11 and UC12 (#13). | Commit [`1ff0906`](https://github.com/breakoutwithai/jevnotjev/commit/1ff0906e76b415707d40ab2929e24877b21531cb) (2026-09-26, no PR): [user-journeys.md](../product/user-journeys.md), [user-stories.md](../product/user-stories.md). #3 `5dbaa44`, #13 `e49fcae`. [use-cases/](../product/use-cases/). | Docs only, no tests, no tag. |
| D03 | Map the comparison: three methods, what is measured, where each number comes from. | [FLOW.md](../../FLOW.md) and the flow diagram [comparison.html](../product/flow/comparison.html). | #2 `e2c0ad4`. | Docs only, no tests, no tag. |
| D04 | Define the result format. | `jnj-record/1`: [schema](../../format/record-v1.schema.json), [example](../../format/example-v1.csv), validator. | #6 `583f5f9` (the validator was Python then; ported to TypeScript in #25 `8105ea2`, Python removed in #27). Today: [validate.test.ts](../../src/format/validate.test.ts) 47 tests, e.g. `:45` the example is valid with two gaps. | The tests shipped in #6 no longer exist; the TypeScript tests are the current proof. No tag. |
| D05 | Set the verdict rules. | [verdict-rules.md](../decision/verdict-rules.md): formulas, the 30-case minimum, edge cases, and the simulation behind the settings. | #7 `c768fd5`. Simulation ported to TypeScript in #45 `25fb30e`: [sim.test.ts](../research/2026-09-29-verdict-minimums/sim.test.ts) 6 tests. Newcombe oracle [newcombe-table3.json](../decision/newcombe-table3.json) read by [calc.test.ts](../../src/core/calc.test.ts) 22 tests (#41 `56f31ed`). | The original #7 scripts were Python and are gone. The 30-case minimum is a setting chosen by simulation, not validated on real data. |
| D06 | Build a tiny example dataset. | [examples/d06-tiny](../../examples/d06-tiny/): fictional CVs, three methods, figures worked by hand in [expected.md](../../examples/d06-tiny/expected.md). | #10 `5662f74`. Independent check #44 `1247ec1`: [hand-check.test.ts](../../scripts/hand-check.test.ts) 23 tests, `:14` reproduces expected.md. | The data is invented, so it shows the arithmetic and says nothing about real accuracy. |
| D07 | Implement the metric calculations. | Accepted counts and cost per accepted result per method: [metrics.ts](../../src/core/metrics.ts). | #29 `c677acb`. [metrics.test.ts](../../src/core/metrics.test.ts) 18 tests, e.g. `:68` Jev vs LLM cost per accepted 0.000025 vs 0.002. | Checked on the d06 fixture only. No tag. |
| D08 | Implement the verdict. | [verdict.ts](../../src/core/verdict.ts): use Jev, don't, or not enough evidence, with the reason in words. Twelve verdict fixtures in [examples/d08-verdicts](../../examples/d08-verdicts/). | #48 `13ea6fa`. [verdict.test.ts](../../src/core/verdict.test.ts) 22 tests, `:40` each rule-1 file names its condition, `:67` no Jev rows is never "don't use Jev". | Fixtures are synthetic. No verdict has been produced from a human-labelled real workflow. |
| D09 | Create the first result view. | A page showing the three methods side by side with the numbers each verdict read: `docs/product/result-views/result-d06.html`, built by [result-view.ts](../../scripts/result-view.ts). | #61 `53e5b24`, #63 `40cbcfb`. [result-view.test.ts](../../scripts/result-view.test.ts) 42 tests, `:124` counts match expected.md. | Not on the site: #66 `b0dac46` unpublished it, and `https://jevnotjev.breakoutwithai.com/result-d06.html` returns 404. Local artifact only. |
| D10 | Make the workflow input concrete: a form for the question, the answers and the acceptance rule, kept apart from keys. | Backstage, a bring-your-own-key runner. Form fields at [index.html:86](../../site/backstage/index.html) ("Keep an answer when...") and `:94`. In-page confirm panels replace native dialogs (#90). | #70 `6142bf9`, #75 `ea3eb14`, #90 `59cf821`; first in release `v2026.10.04.1`. Live: `https://jevnotjev.breakoutwithai.com/backstage/` answers 302 (sign-in gate, so a reader needs a tester login). [confirm.test.ts](../../src/backstage/confirm.test.ts) 21 tests, [page.test.ts](../../src/backstage/page.test.ts) 7 tests. | The public cannot open Backstage without a login. No screenshots or walkthrough record are in this repo. |
| D11 | Add test-case entry: load cases, say they must be synthetic or redacted, show clear errors on bad input. | Case import in Backstage with a synthetic-or-redacted notice ([index.html:225](../../site/backstage/index.html)) and named malformed-CSV errors. | #94 `e656084` (`v2026.10.05.1`); #95 `bd08f1c` (`v2026.10.05.2`) rewrote the error messages. [run.test.ts:933](../../src/backstage/run.test.ts) loads three cases and checks each error names the line, the problem and the fix; run.test.ts 45 tests. | No UAT record for this day is in this repo, and no outside user has entered cases. |
| D12 | Support comparison results: every case shows all three methods' answer and cost, or says which is missing. | Validator reports a gap per missing method; the result view shows `missing`, `cost missing`, `unlabelled`; the page loads your own CSV in the browser. [examples/d12-three-methods](../../examples/d12-three-methods/). | #102 `a177a50`, #103 `aa23633`; release `v2026.10.06.3`. [validate.test.ts:166](../../src/format/validate.test.ts) missing-method tests, `:215` the example prints the output its README shows; [results-loader.dom.test.ts](../../src/browser/results-loader.dom.test.ts) 20 tests, `:116` a valid file shows VALID, each method's summary and a verdict. Live: `https://jevnotjev.breakoutwithai.com/results-loader.js` answers 200. | The three parallel D12 PRs are not listed yet; this row gains their numbers after they merge. The example data is typed by hand, not produced by Jev. |

## What the evidence does not show

- No human-labelled result for a real workflow yet. The UC13 run labels were drafted by three AI labellers and approved by a person ([LABELS.md](../product/runs/2026-10-01-uc13-shop-bot/LABELS.md)); the TokenMax run is unlabelled (`VALID rows=30 cases=5 errors=0 gaps=30`, [README](../product/runs/2026-10-03-tokenmax/README.md)).
- The examples are synthetic or fictional. They show the code does what the rules say, not that Jev is cheaper or better on anyone's data.
- No outside user has run a comparison end to end and reported back.

## How to check it yourself

Needs [Bun](https://bun.sh). From a clone of the repo, run these on `96f5b14`; the output below was captured on that tree.

```
bun install
```
Last line: `7 packages installed [26.00ms]` (the timing varies).

```
bun scripts/gate.ts
```
Last line: `gate: PASS files=63 tests=1277`

```
bun src/format/cli.ts examples/d12-three-methods/records.csv
```
Last line: `VALID rows=11 cases=4 errors=0 gaps=2`

The file and test counts rise as later PRs add tests; fewer than the floors in `expected-counts.json` is a failure.
