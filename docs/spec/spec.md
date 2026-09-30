# Jev!Jev specification (v1)

Scope for #16. The journey this specifies: a builder loads one `jnj-record/1` CSV in the browser, Jev!Jev validates it, computes the numbers per decision point, applies [verdict-rules.md](../decision/verdict-rules.md), and shows the numbers, the rule that fired and every gap. Plan: [plan.md](plan.md). Tasks: [tasks.md](tasks.md). How changes are made: [../process/pipeline.md](../process/pipeline.md).

Sources this file restates rather than replaces: [FLOW.md](../../FLOW.md) (scope, arms, metric sources), [format/README.md](../../format/README.md) (the only column list), [verdict-rules.md](../decision/verdict-rules.md) (the only verdict rules), [user-journeys.md](../product/user-journeys.md), [user-stories.md](../product/user-stories.md). Where this file and one of those disagree, the source file wins and this file is corrected.

## State on main (read at 3b5e66e; the first line updated for #25)
- `src/format/validate.ts` validates a file (TypeScript on Bun, #25 for #22; `bun run validate <file>`). `bun test` runs the tests; `.deploy/tests/` is run by no gate.
- `site/index.html` is a static page. Its CSV handler (`site/index.html:716-724`) counts rows and columns, then replays the sample; it computes nothing from the file. The drop zone is disabled (`site/index.html:489-497`).
- Every number and the verdict on the page come from `site/data.js`, which still holds the dropped prompt router sample (`site/data.js:4-8`, picks per Haiku / Sonnet / Opus read at `site/index.html:599-604`, verdict read at `site/index.html:698-702`). Tracked in #14.
- PR 15 (Postgres store for `jnj-record/1`, `db/`) is merged (be5f849). The browser path does not depend on it.

## Priorities
- **must**: needed for the day-13 happy path (load a file, see a correct verdict with its numbers).
- **should**: on the challenge route but the happy path works without it.
- **later**: after day 18, or blocked on an open decision.

Criterion ids are `R<n>.<letter>`. Each criterion is proved by at least one test whose name carries the id (`R5.e ...` at the start of a `bun test` title); see [pipeline.md](../process/pipeline.md#planned-traceability).

## Requirements

### R1 Start page states what is compared (must)
- R1.a The page names the one supported shape: one decision point with a fixed answer set, asked as a typed question.
- R1.b It names the three answerers with their `answerer` values: what you do now (`llm`), a simple rule (`rule`), Jev decides (`jev`).
- R1.c It defines an accepted result as in `FLOW.md` (Scope): correct and complete enough to use without edits, marked by a person.
- R1.d It asks for synthetic or redacted cases only.
- R1.e It states that a verdict covers the loaded test set only, not production.

### R2 Load a file in the browser (must)
- R2.a A `.csv` file can be chosen with the file picker or dropped on the drop zone.
- R2.b The file is parsed in the browser with CSV quoting rules: quoted fields with commas, doubled quotes, CRLF or LF line ends.
- R2.c No network request carries any part of the file. The page holds no API key.
- R2.d `examples/d06-tiny/records.csv` parses to 30 data rows with 18 columns.

### R3 Validate with the `jnj-record/1` rules (must)
- R3.a Every rule of the original validator at 3b5e66e, now `src/format/validate.ts` (header, per-row schema, output in `answer_set`, duplicate key, `case_input` consistency, question rewording within a `prompt_version`, empty file) has a browser equivalent.
- R3.b Before the original validator is removed (#22), the TypeScript validator and the original agree on VALID or INVALID and on the error and gap counts for every file in a shared fixture set. Met in #25: `bash scripts/parity.sh`, 59 fixtures, 0 differences.
- R3.c An invalid file shows its first error with line and field, and nothing from it is imported or shown as a result.
- R3.d A missing `cost_usd` or `label` is listed as a gap and the file stays valid.
- R3.e `examples/d06-tiny/records.csv` gives the equivalent of `VALID rows=30 cases=5 errors=0 gaps=2`, with gaps at line 21 (cost, cv5 q2 rule) and line 25 (label, cv2 q2 llm).

### R4 One verdict per decision point (must)
- R4.a Rows are grouped by (`prompt_version`, `question_id`); each group is one decision point. `src/format/validate.ts:156-165` lets a new `prompt_version` carry a different question and `answer_set`, so two versions of one `question_id` are two decision points. Inside one decision point, cases pair by `case_id` for that `question_id`, as `verdict-rules.md:17` defines; the two agree.
- R4.b Pairs, counts and verdicts are never pooled across decision points (the defect found in PR 10 round 1).
- R4.c The result view lists every decision point in the file and shows one at a time.
- R4.d Rows with `answerer = human` are counted and shown but not used in the verdict (`verdict-rules.md`, Terms, names only `jev`, `rule`, `llm`).

### R5 Calculations per decision point (must)
- R5.a Per answerer: rows, labelled, accepted, and spend, or `incomplete` when any of that answerer's rows lacks a cost.
- R5.b Cost per accepted = spend / accepted; shows "undefined (0 accepted)" with total spend when accepted is 0.
- R5.c A paired case is a `case_id` where both answerers have a labelled row for the question; unlabelled rows drop out of every count.
- R5.d For Jev against the LLM and Jev against the rule: n, a, b, c, d, p1, p2 and diff as defined in `verdict-rules.md:34-40`.
- R5.e The 95% interval for diff is Newcombe's paired method 10 and matches all 7 rows of Table III to 4 decimal places (the rows in `docs/decision/newcombe_check.py:12-15`).
- R5.f Cost ratio = Jev cost per accepted / LLM cost per accepted, 0 when the LLM has 0 accepted and Jev some, infinity when Jev has 0 and the LLM some.
- R5.g The cost ratio interval is 2,000 paired resamples, 2.5th and 97.5th percentiles, a resample where both have 0 accepted is drawn again.
- R5.h Every number in `examples/d06-tiny/expected.md` is reproduced exactly: q1 Jev 4/5, LLM 5/5, ratio 0.0125, a=4 b=0 c=1 d=0, diff -0.2, rule minus Jev -0.4; q2 n=4, 3/4 each, ratio 0.01, diff 0, rule minus Jev 0.

### R6 Verdict (must)
- R6.a The four rules of `verdict-rules.md:53-69` are applied in order, first match wins.
- R6.b Each rule-1 condition on its own gives "not enough evidence": no `jev` or no `llm` rows; fewer than 30 paired Jev and LLM cases; both 0 accepted; a paired Jev or LLM row with no cost.
- R6.c Each rule-2 condition on its own gives "don't use Jev": rule within 10 points of Jev on 30 or more paired rule cases; Jev clearly worse than the LLM; Jev 0 accepted and the LLM some; cost ratio lower bound above 1.
- R6.d "Use Jev" only when the lower bound of (Jev minus LLM) is above -0.10 and the cost ratio is 0.8 or less with its upper bound below 1.
- R6.e Otherwise "not enough evidence", naming the unmet condition and, for a short file, "add N more labelled cases".
- R6.f A file with no Jev rows reads "not enough evidence: no Jev results", never "don't use Jev".
- R6.g On `examples/d06-tiny/`, q1 and q2 both give "not enough evidence" with "add 25" and "add 26" more labelled cases.
- R6.h When the rule comparison is skipped (no rule rows, or fewer than 30 paired rule cases), the view says so.

### R7 Result view (must)
- R7.a Each answerer side by side: spend, accepted count, cost per accepted.
- R7.b The verdict, the rule number that fired, and every number that rule read.
- R7.c The sentence that the verdict is evidence from this test set only.
- R7.d Every number shown after a load comes from the loaded file, none from `site/data.js`.

### R8 Gaps are visible (must)
- R8.a Unlabelled rows: count per answerer and the line numbers.
- R8.b Missing costs: line numbers, and `incomplete` in place of a total.
- R8.c Below 30 paired cases: rates and costs still shown, marked "below minimum", with the paired count.
- R8.d An answerer at 0 accepted shows the rule-of-three upper bound 3/n.

### R9 Per-case wins and losses (should)
- R9.a Each case row shows every answerer's output and label.
- R9.b Each row marks Jev win, loss or tie against each other answerer (`FLOW.md`, Metrics).
- R9.c The win and loss counts equal b and c from R5.d for the same pair.

### R10 Confidence against correctness (should)
- R10.a Each Jev row shows its confidence; an empty confidence shows "none".
- R10.b Rejected Jev answers are listed first, highest confidence first.

### R11 The page sample is a typed question (should)
- R11.a The dropped router sample is removed from `site/data.js`, or labelled historical on the page (#14 part 1).
- R11.b The default sample is UC11 (CV against a job ad) and runs through the same pipeline as a loaded file.

### R12 Empty and broken input (must)
- R12.a An empty file, a header-only file, and a file that is not CSV each show a named error and no result.
- R12.b A file with only `rule` rows loads and shows "not enough evidence: no Jev results".
- R12.c Loading a second file replaces every number from the first.

### R13 Reproducible (must)
- R13.a The resampling is seeded from the file content, so the same file gives the same numbers and verdict on every load.
- R13.b The result can be saved as a file that names the verdict-rules version and the input file's SHA-256.

### R14 Workflow and case entry on the page (should)
- R14.a The builder can describe the decision (question and answer set) on the page.
- R14.b The builder can add, edit and remove numbered cases; the page shows the count.
- R14.c The cases download as a case list (`case_id`, `case_input`, `question`, `answer_set`) for the runner to answer outside the tool.

### R15 Labelling on the page (later)
- R15.a Each loaded answer can be marked accept or reject; the page shows how many are still unlabelled.
- R15.b The labelled file downloads as `jnj-record/1` and passes the format validator (`src/format/validate.ts` after T0).

### R16 First-use guide (should)
- R16.a A guide on the page takes a new builder from an empty folder to a loaded file in the order of `FLOW.md` (Journey).
- R16.b The guide's sample commands run as written on a clean clone.

### R17 Traceability and completion check (should)
- R17.a Every test name carries the criterion id it proves (#18).
- R17.b `scripts/spec-check.ts` lists every criterion with its tests, exits non-zero while any must criterion has no passing test, and fails when it checked 0 criteria (#19).
- R17.c One test checks that the verdict wording in `user-stories.md`, the site and `verdict-rules.md` agree (#14 part 2, #19).
- R17.d The gate prints the head SHA it ran on and fails on a failing test, a 0 test count, or a tracked test file it did not collect.

### R18 Store records in Postgres (later)
- R18.a A file loaded with `bun run load` and exported with `bun run export` (`src/db/`, the #25 port of PR 15) loads in the browser with the same numbers as the original file.

### R19 Ask your own question, keeping only a generalised question (later)
- R19.a As #11: the raw question is never stored; only a generalised, scanned question the user chose to keep.

## Exclusions
- Live model calls from the tool, including Jev: v1 reads results the builder supplies (`FLOW.md`, Scope).
- Accounts, sign-in, and any server-side state for the main journey.
- The Claude Code prompt router (Haiku / Sonnet / Opus per prompt): dropped on 2026-09-28; historical only.
- Comparing or combining decision points into one verdict.
- Production, streaming or sensitive data; claims beyond the loaded test set.
- Pooling or sharing subscriptions.
- Latency in the verdict: shown only (`FLOW.md`, Metrics).

## Story map
Every story in `docs/product/user-stories.md` at 5dbaa44.

| Story | Requirements | Note |
|---|---|---|
| US-01 See the one supported workflow | R1, R16 | |
| US-02 Add a small test set of cases | R14 | should; cases are also accepted inside the CSV (R2) |
| US-03 Supply results and costs in one format | R2, R3 | the "names the first row and field" criterion is R3.c |
| US-04 Label each answer | R8.a, R15 | v1 reads labels from the CSV and shows what is unlabelled; labelling on the page is later |
| US-05 Compare cost per accepted result | R5.a, R5.b, R7.a | wording follows verdict-rules: "undefined (0 accepted)", not "no accepted results" |
| US-06 Read a cautious verdict | R6, R7.b, R7.c | conflicts with verdict-rules; see below |
| US-07 Wins and losses against Jev | R9 | |
| US-08 Confidence against right picks | R10 | |

Mapped: 8 of 8. Excluded: 0.

**US-06 against verdict-rules.md (#14).** US-06 picks "don't use Jev" when LLM only or the rule has the lowest cost per accepted result. `verdict-rules.md:54` compares Jev with the rule on accept rate only, because a rule costs 0, and `verdict-rules.md:66-68` requires Jev at 0.8x the LLM's cost per accepted or less. Under US-06 as written, any rule with one accepted answer gives "don't use Jev". **verdict-rules.md wins.** R6 restates it; US-05 and US-06 are reworded to link to it in task T10.

## Open decisions
| # | Decision | Owner | Default until decided |
|---|---|---|---|
| D1 | Where Postgres is hosted (#11) | operator | no hosted database; the browser path does not need one |
| D2 | Name on the page and in docs: "TokenMax" or "UC11" for the CV example (PR 12 round-2 note O1) | operator | "UC11, CV against a job ad", with TokenMax as the flagship label |
| D3 | Where metrics are computed canonically: the shared TypeScript core, or SQL over `jnj.record_v1` as PR 15 defers to a `jnj_metrics` schema | operator | the TypeScript core; any SQL version must reproduce the same fixtures |
| D4 | Browser automation for the happy-path test (a headless browser adds a dependency) | operator | pipeline tested with `bun test` without a DOM; the page is checked by hand with screenshots |
| D5 | Whether in-page labelling (R15) moves into v1 | operator | later |
| D6 | The 30-plus-case fixture for the "use Jev" and "don't use Jev" paths: synthetic, or a first real labelled UC11 set | operator | synthetic, generated by a script in the repo |
| D7 | Whether `human` answerer rows get their own comparison | operator | shown, not compared (R4.d) |
| D8 | Whether answers to two `prompt_version`s of one question may ever be compared in one verdict. That changes the pairing in `verdict-rules.md:17`, so it is a verdict-rule change and takes the full pipeline path | operator | no: each `prompt_version` is its own decision point (R4.a) |
