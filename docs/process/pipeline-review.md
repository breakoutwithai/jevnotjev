# Adversarial review of the PR 21 change pipeline

VERDICT: BLOCK 13 blocking (PR 21, head 5e80a84ffa9a20dc7ca96981804d87c56ff92c9f, round 1)

## Scope and independence
- Reviewed: `docs/process/pipeline.md`, `docs/spec/spec.md`, `plan.md`, `tasks.md` at 5e80a84, main at 26c9751, the public comments on PRs 2, 3, 6 to 10, 12, 13, 15, 20, and issues 11, 14, 16 to 19.
- Position: every claim in `pipeline.md` is treated as false until a public artifact shows it. BLOCKING means one of: incorrect behaviour, a stated rule or invariant is contradicted, a security or data-integrity defect, or a check that would pass on broken work. Everything else is OPTIONAL.
- Independence: this review was written by an Anthropic Claude model (model id self-reported). PR 21 does not record its author's model. If an Anthropic model wrote it, this is a same-vendor review and does not count as the cross-check proposed in O1.
- Base: PR 21 branches from 5dbaa44; main has moved to 26c9751 (PR 20). Every "main" claim below was read at 26c9751.

## BLOCKING findings

### B1. A merge was pinned to a head the reviewer never saw (PR 10)
- Claim: `pipeline.md:57` "merge(pr, match_head_commit = reviewed_head) // a push after review fails the merge".
- Evidence: the PR 10 readiness comment says "Review round 2 (e97ea76): APPROVE". Commit 0189a7c was pushed after that (e97ea76 at 20:01:04Z, 0189a7c at 20:02:13Z). The merge comment reads "pinned to reviewed head 0189a7c (--match-head-commit)". Round 2 reviewed e97ea76, not 0189a7c. The 0189a7c diff is 3 lines in `expected.md` with no number changes, so this case did no harm. The mechanism still let an unreviewed push through, and the pinned SHA was chosen by the author.
- Fix: the evidence comment carries `REVIEWED: <sha>`. The merge goes ahead only if `git rev-parse <head>^{tree}` equals `git rev-parse <reviewed>^{tree}`. Otherwise another round runs. The PR 2 gate comment already used this tree check once ("same tree b871a46 as the reviewed 21d67bf").

### B2. Review verdicts on the record are the author's own report of them
- Claim: `pipeline.md:8` "Reviewer: a separate agent run", and `:45-46` "findings = reviewer.refute(pr.head)", "verify each BLOCKING finding".
- Evidence: PRs 2, 3, 6 to 10, 12, 13, 15 and 20 have 0 GitHub reviews (`pulls/<n>/reviews` length 0). Every comment on them comes from one account, the same account that opened the PR. What the reviewer actually wrote is never posted, only a summary ("Review round 2 (51f0eec): PASS, 0 blocking", PR 12). No comment names the reviewer's model. The public record would look the same if no separate reviewer had run.
- Fix: post the reviewer's output verbatim as its own comment. It must end in an anchored line `VERDICT: PASS <sha>` or `VERDICT: BLOCK <n> <sha>` and name the reviewer's model. The merge step greps that line and not the author's summary.

### B3. The content path let a wrong claim and unscrubbed private paths reach main (PR 20)
- Claim: `pipeline.md:66-75`. Content PRs get a scan only. "A content PR that changes a requirement, a verdict rule or a test oracle is a code change and takes the full path."
- Evidence, PR 20 (content, merged 13 s after its only commit, 148c54a committed 21:17:42Z, merged 21:17:55Z, no review):
  - `docs/research/2026-09-29-verdict-minimums/effort.md:29` says "Verdict rule needs at least 10 labelled cases (FLOW.md:46)". Two files on main contradict it: `verdict-rules.md:10` (minimum 30) and `FLOW.md:51` ("fewer than 30 paired labelled cases"). The citation also no longer resolves: `FLOW.md:46` is now the "Label source and labelling time" row. PR 20's title calls this folder "the research behind the verdict rules", and its banner covers only the routing premise.
  - The banner at line 3 of each file says "Kept as written, apart from private file paths replaced with a note". `jev.md:23` and `jev.md:58` still cite a script by a path under the author's home directory (tilde shorthand). `jev.md:48` cites a run folder and a script that do not exist in this repo (`git ls-tree -r origin/main` has no `scripts/` and not the cited run folder). PR 20's scan list covered absolute home paths but not the tilde shorthand.
- Second instance of the same defect: PR 21 creates all 19 requirements, yet its body classifies it "Content PR: private-content scan run over the changed files, empty". Under `pipeline.md:75` that makes it a code change. The author assigns the class, and in both instances the author got it wrong.
- Fix: a script over `git diff --name-only origin/main...HEAD` assigns the class instead of the author. Any path under `docs/decision/`, `docs/research/`, `docs/spec/`, `format/`, `examples/*/expected.md`, or a changed line that cites `verdict-rules.md`, sends the PR down the full path. The scan adds the tilde home shorthand and a check that every `file:line` citation in changed lines resolves.

### B4. The private term list is published in a public PR
- Claim: `pipeline.md:36` "list kept outside this public repo".
- Evidence: the PR 13 body prints the full scan command with its pattern, and the PR 13 merge comment names terms from the list. The list is now public through PR text, even though no file in the repo holds it. This review does not repeat the terms.
- Fix: the scan script prints only `scan: <n> hits, list <first 8 of sha256>`, and evidence quotes that line and never the pattern. Whether to edit the PR 13 body is the operator's call.

### B5. A contradiction of the verdict rules was graded OPTIONAL, and nothing tracks it
- Claim: `pipeline.md:50` "optional findings -> follow-up issues", and the rule that verdict-rules.md is "the only verdict rules" (`spec.md:5`).
- Evidence: the PR 12 gate comment lists "Optional round-2 notes O1-O3 (... diagram '10+ cases' vs 30) not blocking". Main still says "typed question, 10+ cases" at `docs/product/flow/comparison.dataflow.json:35` and `comparison.html:5066`, `:5076`, against the 30-case minimum in `verdict-rules.md:10`. The issue list is 11, 14, 16, 17, 18 and 19, and none of them covers O2 or O3 from PR 12 round 2. D2 in spec.md covers O1. The PR 10 gate comment reports O2, O4 and O5 fixed, and O1 and O3 are never mentioned again.
- Fix: write the BLOCKING criteria into `pipeline.md` and name contradicting `verdict-rules.md` as one of them. The evidence comment lists every OPTIONAL finding with an issue number or `dropped: <reason>`, and the merge step refuses when any optional finding has neither.

### B6. `pipeline.md` describes mechanisms in the present tense that do not exist
- Claim: `pipeline.md:3` "as it is run today". `:79` "Every test names the id it proves". `:80` "`scripts/spec-check.py` ... prints each criterion". `:32` "test count > 0".
- Evidence at 5e80a84: there is no `scripts/` directory. `pytest --collect-only` finds 22 tests, and 0 of them carry an `R<n>` id. Nothing in the repo checks the "test count > 0" of `:32`, because `scripts/ci-check.sh` (plan.md:57) is absent. Step 4, "assert test is RED on base", did not happen in PR 10, a `feat/` PR that added no test ("pytest: 22 passed" before and after).
- Fix: add a Status column to the step table (built, with the file path, or planned, with the task id), and write planned steps as planned.

### B7. The planned coverage leaves 13 must criteria with no test, and two planned test names prove something else
- Claim: `tasks.md:50` "Must requirements with a task ... 10 of 10", `spec.md:18` "Each criterion is proved by at least one test", and the rule of `pipeline.md:80` that a must criterion with no test fails the gate.
- Evidence: spec.md has 66 criteria (47 must, 15 should, 4 later), and 66 of 66 have zero tests today. Across all verifying-test cells in tasks.md, 13 must criteria have no planned test: R1.a to R1.e, R2.a, R3.a, R3.d, R4.a, R4.d, R6.h, R7.a and R7.c. Once T20 lands, spec-check fails on these 13 permanently. Coverage in `tasks.md:50` is counted per requirement, which hides the gap. Name matching also counts two criteria as tested when they are not. `test_R17a_gate_fails_on_zero_tests` (`tasks.md:24`) tests the gate's zero-count behaviour, not R17.a ("every test name carries the criterion id", `spec.md:116`). `test_R5h_python_and_browser_numbers_agree` (`tasks.md:40`) compares d08 numbers, while R5.h is the d06 `expected.md` numbers (`spec.md:56`).
- Fix: count coverage per criterion in tasks.md, add a test name for each of the 13, and rename or re-point the two mismatched tests.

### B8. "Test count > 0" passes when a whole test folder is never collected
- Claim: `pipeline.md:32` "assert all tests GREEN and test count > 0".
- Evidence: `pytest.ini` has `testpaths = format`. The planned tests live in `scripts/test_ci_check.py` (T1), `tests/test_docs_consistency.py` (T10) and `docs/decision/hand_check.py` (T17), and `plan.md:58` names only `db` as a folder to add. `.deploy/tests/` holds 3 shell tests (`branch-guard`, `release`, `nginx-vhost`) that no gate or pipeline step runs. The 22 format tests keep the count above 0, so a new test file outside `testpaths` never runs and the gate stays green.
- Fix: the gate compares the set of tracked test files (`git ls-files` over the test globs) with the set it actually ran, and fails on any difference.

### B9. Test results are not tied to the head they claim to cover, and main has no server-side guard
- Claim: `pipeline.md:53` "head SHA reviewed, test counts".
- Evidence: the PR 3 merge comment says "22 tests pass" but gives no SHA for the run. PR 15's test table ("22 passed" to "87 passed") gives no SHA, and the head has moved through d7fe6ee, e7fac6d and 0d347e7. PR 20 and PR 13 report no test run. main is unprotected: `branches/main` returns `protected: false`, and there are 0 rulesets. The only binding is the SHA the author types into a comment.
- Fix: the gate script prints one line, `head=<sha> clean=<yes|no> pytest=<n> node=<n>`. Evidence pastes that line, and a merge script refuses when its sha differs from the PR head.

### B10. The merge grant has no scope, no expiry and no record outside the agent's own comment
- Claim: `pipeline.md:6` "Operator: ... merges", and `:56` "standing_grant_covers(pr)".
- Evidence: 3 of the 6 merges in scope (12, 3, 20) ran under a grant. The only public trace is the agent's own quote: "Merged under the operator's session grant for this repo ("get control of jevnotjev and manage", 2026-09-30)" (PR 12). Every merge from PR 2 to PR 20 was made by the account that opened the PR, so the record cannot tell operator from agent. The grant covers the whole repo, so `standing_grant_covers` is true for any PR. PR 20 went from commit to merge in 13 s with no review. `pipeline.md` calls the grant "standing", while the comments call it a session grant.
- Failure mode: an unreviewed or self-classified PR merges on a grant that nobody but the merging agent can see.
- Fix: the agent pushes and comments under its own GitHub identity, so `mergedBy` shows who merged. A grant is posted by the operator's account as a comment that names PR numbers or a branch prefix and an end time. Content PRs under a grant still need B3's classifier.

### B11. The dash rule is claimed as enforced and is broken on main
- Claim: `pipeline.md:37` "assert no em or en dashes // enforced by a write hook".
- Evidence: `docs/product/flow/comparison.html` on main has 31 lines with an em dash and 2 with an en dash. The em dash count is the same at 092acd7 and 51f0eec. PR 12 regenerated this file, and the rendering step does not pass through the hook. The hook is not in this repo, so a clone has no enforcement.
- Fix: a grep for U+2014 and U+2013 over tracked text files in the gate script.

### B12. "One content PR per day" does not match practice
- Claim: `pipeline.md:71` "one content PR per day".
- Evidence: content PRs 13, 3 and 20 all merged on 2026-09-30 (20:42:56Z, 21:05:10Z, 21:17:55Z).
- Fix: delete the comment, or enforce it with a check.

### B13. The spec adds a grouping rule that no source file states
- Claim: `spec.md:5` "Where this file and one of those disagree, the source file wins".
- Evidence: `spec.md:43` (R4.a) groups decision points by (`prompt_version`, `question_id`). `verdict-rules.md:17` defines a paired case by `question_id` only. `format/README.md` and `FLOW.md` never define a decision point by `prompt_version`. A file with Jev under `v1` and the LLM under `v2` for the same `question_id` has pairs under verdict-rules.md and none under R4.a. The pipeline has no check that the spec restates its sources faithfully: spec-check reads test names, not sources.
- Fix: either amend `verdict-rules.md:17` (a verdict-rule change, full path) or restate R4.a to match it.

## OPTIONAL findings
- **O1. Same-vendor review.** Author and reviewer appear to be the same model family, but no comment names either model, so this cannot be checked. What same-vendor review misses is a premise that author and reviewer both hold. PR 10's body says "Hand figures cross-checked by a separate script: Jev 7 of 9 ... 9 paired cases", which is the pooled figure that round 1 then found wrong. The author's cross-check shared the defect's premise. Smallest cross-check: code-path PRs run one round through a different vendor's model with the same refute prompt, and record its `VERDICT` line and model id. PRs that carry numbers also get the independent recomputation T17 plans.
- **O2. The PR 15 row in the defects table rests on the author's report.** `pipeline.md:97` cites a design review that is not public, and RED and GREEN claims taken from the PR 15 body. There is no round-2 verdict at head 0d347e7. Status is UNVERIFIED until a posted round 2 covers 0d347e7. `tasks.md:45` still cites e7fac6d. PR 15's 65 new tests carry no criterion ids, so merging it adds 65 tests that `pipeline.md:79` counts as untraced.
- **O3. A finding about a test was closed by a test that was never committed.** PR 12's B2 closed with a widened test that is not in the repo (`pipeline.md:99`). US-06 still says "Given Jev routing has the lowest cost" (`user-stories.md:74`, tracked in #14). Whether the uncommitted test would catch it is UNVERIFIED, since its pattern is not public. Rule to add: a BLOCKING finding about a test closes only with a committed test.
- **O4. Some dependency cells name no file or line.** `tasks.md:5` requires file and line. T10 (`:33`), T21 (`:44`), T23 (`:46`, just "T12") and T24 (`:47`, "D1 in spec.md") do not give one.
- **O5. Wrong task reference.** `spec.md:151` says US-05 and US-06 are reworded "in task T20". The rewording is in T10 (`tasks.md:33`), and T20 is spec-check.
- **O6. The spec's view of main is out of date.** `spec.md:7` "State on main today (base 5dbaa44)". Main is now 26c9751. Rebase, then re-read the state section.
- **O7. Deploy is missing from the pipeline.** `pipeline.md` has no deploy step. `.deploy/deploy.sh` runs no test suite. `.deploy/tests/` is not wired into any gate.

## Pipeline steps with no mechanism behind them (at 5e80a84)
| Step (`pipeline.md` line) | Mechanism in this repo | Public evidence it ran |
|---|---|---|
| 1 operator_agrees (17) | none | none |
| 2 no build without a requirement id (22) | none | spec lands in this PR |
| 3 new worktree off origin/main (25) | none | branch names only |
| 4 test RED on base (30) | none | PR 12 and PR 15 comments (author report) |
| 4 count > 0 (32) | none, `scripts/ci-check.sh` absent | counts typed into comments |
| 4 spec_check (33) | none, `scripts/spec-check.py` absent | none |
| 5 private scan (36) | none in repo | "0 hits" typed into comments; pattern leaked (B4) |
| 5 no dashes (37) | hook outside the repo | violated on main (B11) |
| 7 refute loop (44-49) | none | author summaries only (B2) |
| 7 optional to issues (50) | none | not done for PR 10 O1 and O3, or PR 12 round-2 O2 and O3 (B5) |
| 8 evidence comment (53) | none | SHA missing on PR 3 and PR 15 test claims (B9) |
| 9 merge pinned to reviewed head (57) | `--match-head-commit`, fed the author's SHA | PR 10 pinned an unreviewed head (B1) |
| 10 portal log, score (60-61) | outside this repo | not checkable here |

## Answers to the seven questions
1. Match with PRs 10, 12, 13, 3, 15 and 20: partial. Review rounds and pinned merges show up in 10 and 12. PR 10 merged an unreviewed head (B1). Verdicts exist only as author summaries (B2). Authorisation is "operator instruction 'merge 10'" and "'merge 13'", and a grant quoted by the agent for 12, 3 and 20 (B10). PR 15 has no round 2 (O2).
2. Content PRs on a scan only: PR 20 put a 10-case floor that contradicts the 30-case rule and home-directory paths on main (B3). PR 21 misclassifies itself (B3).
3. Same-vendor review: O1.
4. Stale head: nothing mechanical prevents it. The SHA is not always in the evidence (B9), and the pinned SHA is the author's choice (B1).
5. Traceability: 66 criteria (47 must). 66 have zero tests today, and 13 must criteria have no planned test (B7). `testpaths = format` (B8).
6. Grant: B10.
7. Steps with no mechanism: see the table above.

