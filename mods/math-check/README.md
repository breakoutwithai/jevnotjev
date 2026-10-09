# math-check: check Jev!Jev math by hand

A Claude Code mod for code reviewers. It adds a **Check Jev!Jev math by hand** button above the prompt and a
`/jnj-math-check [N] [records.csv]` command. Either one exports the last N cases (default 30) of a jnj-record CSV
to an `.xlsx` workbook where a spreadsheet recomputes every verdict figure with visible formulas, next to the
app's own figure.

The mod computes nothing itself. It runs `bun mods/math-check/export.ts <records.csv> --last N` in the session's
directory; export.ts runs `scripts/math-check.ts --json` (which reads the app's figures from
`bun src/decide/cli.ts verdict`) and writes the workbook. No provider is called.

## Load it from a clone

```sh
git clone https://github.com/breakoutwithai/jevnotjev && cd jevnotjev
bun install
claude --plugin-dir mods/math-check
```

The button and the command appear only when the session's directory holds `scripts/math-check.ts` and
`mods/math-check/export.ts`, so start `claude` from the repository root. Drawing (the button) works only in the
terminal and the Desktop app's Code tab; VS Code chat, `claude -p` and cloud sessions run the hooks but draw nothing.

## What a press does

- **Source:** the CSV you name, else the newest `docs/product/runs/<date>-*/records.csv` by the folder name's date.
  The source file and N are always printed.
- **Cases:** the last N distinct `case_id` values in file order. Fewer than N cases is an error, never a shorter
  export.
- **Output:** `jnj-math-check/<run_id>-last<N>-<yyyymmdd-hhmm>.xlsx` under the session's directory (git-ignored).
  An existing file is never overwritten.
- **Toast:** math-check's counts (`N figures checked, K differ`) and the workbook's path. The mod then
  tries `open` on the file once; if that fails the path is still printed.

## The sheet

One sheet, `Check`, top to bottom:

- **Result lines, by formula:** an overall line, then one per question, for example
  `q1 use Jev: 32 checked, 0 differ, 4 app-read`. `differ` counts DIFF and ERROR.
- **Provenance:** source file, N, the selection rule and the jevnotjev SHA. The tolerance (1e-9) is stated once:
  absolute for counts and rates, relative for spend, cost per accepted and the cost ratio.
- **One block per question:** Figure | Hand | App | Status. Hand is a live formula; App is the app's figure
  as `scripts/math-check.ts --json` read it from the verdict command. Status is one of:
  - `CHECKED`: Hand and App agree within the tolerance.
  - `DIFF`: they do not.
  - `ERROR`: one of them is blank, text or an error.
  - `APP-READ`: the app's value, not recomputed (the verdict, the rule fired and the bootstrap bounds). A bootstrap
    bound that does not hold the hand ratio is DIFF.
- **Deciding conditions:** paired n vs 30, Newcombe lower and upper vs -0.10, cost ratio vs 0.8, and rule minus Jev
  lower vs -0.10. They sit beside the verdict and are working rows, with no status.
- **Collapsed row groups:** the Wilson l1, u1, l2, u2 chain, z and phi before the n/2 reduction, and the bootstrap
  resample count.
- **Case table at the bottom:** one row per question and case with a Jev or LLM row. Columns: case_id, question,
  Jev accept and LLM accept (1 accept, 0 reject), Jev cost, LLM cost, included (formula: both arms labelled), and
  the reason a row is not included. Then the app's per-case costs and two per-row checks, then the rule columns when
  the file has rule rows.
  - The labels are transcribed as they are written: an unlabelled, unanswered or `agent`-labelled row is left blank
    with its reason (format/README.md "Missing cost or labels"), so it shows included = 0.
  - Every Hand cell is a short COUNTIFS or SUMIFS over this table.

Spend is arithmetic only, not tied to a provider bill. No formula cell carries a cached value: the spreadsheet
computes them all when the file opens (`fullCalcOnLoad`). `phi` is shown, and not compared, because the app does
not print it (#168).

### Where each math-check figure is checked

Every figure `scripts/math-check.ts --json` compares lands on one row; a figure with no row gets an `unmapped:` row
whose status is ERROR, so none is dropped silently. `layoutWorkbook()` returns this map, and `compare-csv.ts`
checks it against the engine's output.

| math-check figure (`<question>:` prefix dropped) | Sheet row | Checked as |
|---|---|---|
| `verdict`, `rule`, `condition`, `unmet` (states) | verdict, rule fired | APP-READ |
| `numbers.jevVsLlm.n`, `.excluded`, `.a`, `.b`, `.c`, `.d` | paired n, excluded, a, b, c, d | Hand |
| `numbers.jevVsLlm.wins`, `.losses`, `.ties` | b, c, d | hidden echo column: b, c, a + d |
| `numbers.jevVsLlm.jev.accepted`, `.otherArm.accepted` | Jev accepted, LLM accepted | Hand |
| `numbers.jevAccepted`, `numbers.llmAccepted` | Jev accepted, LLM accepted | echo (Hand when nothing pairs) |
| `numbers.jevVsLlm.jev.acceptRate`, `.otherArm.acceptRate`, `.p1`, `.p2`, `.diff`, `.lower`, `.upper` | Jev rate, LLM rate, p1, p2, diff, Newcombe lower, upper | Hand |
| `numbers.jevVsLlm.<arm>.spend.usd` or `.spend.knownUsd`, `.spend.missing` | Jev or LLM spend, costs missing | Hand |
| `numbers.jevVsLlm.<arm>.costPerAccepted.usd`, `numbers.costRatio.ratio` | cost per accepted, cost ratio | Hand |
| `numbers.costRatio.lower`, `.upper` | bootstrap lower, upper | APP-READ, DIFF when the ratio falls outside |
| `numbers.costRatio.resamples` | bootstrap resamples (collapsed) | Hand (2000) |
| `numbers.jevVsLlm.cases[<id>].jevCostUsd`, `.otherCostUsd` | `per-case costs: K/M match` | per row of the case table |
| `addN` | cases still needed (30 - n) | Hand |
| `ruleComparison.n` or `.paired`, `.a` to `.d`, `.p1`, `.p2`, `.diff`, `.lower`, `.upper` | Jev vs rule block | Hand |

## Engine check

`examples/d15-sheet-check/compare.csv` is the fixture workbook's Check sheet as LibreOffice recalculated it.
Rebuild it with `bun mods/math-check/compare-csv.ts` (needs LibreOffice's `soffice`). The test
`mods/math-check/compare-csv.test.ts` checks that every figure math-check compares sits on a CHECKED (or APP-READ)
row whose engine value equals the app value, and that every result line reads 0 differ.

## Tests

`bun test mods/` runs the mod's tests with Bun. `hooks/run.ts` holds the logic both the button and the command
call; `hooks/register.tsx` only wires it to the engine. To type-check the hooks module, start one interactive
session with `--plugin-dir mods/math-check` (the engine lays its declarations in `.claude-plugin/types/`), then run
`bunx tsc -p mods/math-check`.
