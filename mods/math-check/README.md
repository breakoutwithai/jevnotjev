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
- **Toast:** the Summary sentence (`All N figures match` or `K of N differ`) and the workbook's path. The mod then
  tries `open` on the file once; if that fails the path is still printed.

## The sheets

| Sheet | What it holds |
|---|---|
| Summary | A1 is a formula sentence: `All N figures match` or `K of N differ`, then the differing figures, the source file, N, the selection rule, the jevnotjev SHA and the tolerance |
| Cases | The selected rows with their source line numbers, and an Included column computed by formula (unlabelled and `agent` rows are left out) |
| Hand | Every covered figure recomputed with spreadsheet formulas over Cases, from `docs/decision/verdict-rules.md` "Formulas" (counts, rates, spend, cost per accepted, ratios, Wilson, phi, Newcombe) |
| App | The app's figures as `scripts/math-check.ts --json` read them from the verdict command |
| Compare | Per figure: Hand, App, the difference, the tolerance and OK / MISMATCH / ERROR (blank, error or text is ERROR), with totals |
| Coverage | `examples/d15-sheet-check/coverage.md`: each verdict figure marked formula, partial or excluded, with the reason |

Spend is arithmetic only, not tied to a provider bill. No formula cell carries a cached value: the spreadsheet
computes them all when the file opens.

## Engine check

`examples/d15-sheet-check/compare.csv` is the fixture workbook's Compare sheet as LibreOffice recalculated it.
Rebuild it with `bun mods/math-check/compare-csv.ts` (needs LibreOffice's `soffice`); the test
`mods/math-check/compare-csv.test.ts` checks every engine Hand value against `scripts/math-check.ts --json`.

## Tests

`bun test mods/` runs the mod's tests with Bun. `hooks/run.ts` holds the logic both the button and the command
call; `hooks/register.tsx` only wires it to the engine. To type-check the hooks module, start one interactive
session with `--plugin-dir mods/math-check` (the engine lays its declarations in `.claude-plugin/types/`), then run
`bunx tsc -p mods/math-check`.
