# How Jev!Jev changes are made

What happens to a change in this repo today, what is only planned, and the limits the round-1 review found ([pipeline-review.md](pipeline-review.md)). Each pseudocode step carries a status: **run** (done today, by a person or an agent following this file), **checked** (a script or GitHub enforces it) or **planned** (with its issue or task).

## Roles
- **Operator**: the builder. Owns the premise and writes the challenge portal log in their own words.
- **Agent**: builds, tests, opens the PR, fixes blockers, and has merged every PR so far.
- **Reviewer**: a separate agent run that tries to refute the PR and does not fix what it finds.

The author and the merger are the same GitHub account on all 12 merged PRs (2 to 23), so the public record cannot tell operator from agent (review B10).

## Code and feature changes

```
change(day_step):
    // 1 portal step first, done as written                      [run]
    step = read_portal_step(day)
    concept, premise = state(step)
    require operator_agrees(concept, premise)                    // not recorded in the repo

    // 2 spec layer: place the change before building it         [planned, #16 #17, this PR]
    reqs  = requirement_ids(spec.md, step)
    tasks = tasks_for(reqs, tasks.md)

    // 3 isolation                                               [run]
    tree = new_worktree(branch = "<type>/<slug>", base = origin/main)

    // 4 build, tests first
    for criterion in criteria(reqs):
        write_test(name contains criterion id)                   [planned, #18; 0 tests carry an id today]
        assert test is RED on base                               [run on some PRs; PR 10 added no test]
    implement(tasks)
    run bun test                                                 [run; nothing checks the count]
    gate prints head=<sha> and counts; fails on 0 or uncollected [planned, T1]
    spec_check()                                                 [planned, #19, T20; no scripts/ folder yet]

    // 5 private-content scan                                    [run, outside the repo]
    scan(changed_files)                                          // prints one line: VERDICT public-scan OK|HITS files=<n> hits=<n>
    no em or en dashes                                           [run, outside the repo; see limits]

    // 6 PR                                                      [run]
    pr = open_pr(title, body, Refs or Closes)

    // 7 refute-by-default review                                [run; see limits]
    loop:
        findings = reviewer.refute(pr.head)                      // BLOCKING or OPTIONAL
        verify each BLOCKING finding against the code
        if no confirmed BLOCKING: break
        fix, push, re-review the NEW head
    optional findings -> follow-up issues                        [run, not always: review B5]

    // 8 evidence comment                                        [run; head SHA not always named]
    comment(pr, rounds, verdicts, head SHA, test counts, follow-ups)

    // 9 merge                                                   [run]
    require operator_says_merge(pr) or grant_covers(pr)
    merge(pr, --match-head-commit <sha>)                         [checked by GitHub, for whichever SHA is given]

    // 10 close the day                                          [run, outside the repo]
    operator writes portal_log(own words); capture score
```

## Content changes (docs, use cases, blog)

```
content_change():                                                [run]
    tree = new_worktree(branch = "docs/<slug>", base = origin/main)
    write()
    scan(changed_files)
    open_pr()
    // no review rounds
```

- One content PR per day is an aim, not a rule: content PRs 13, 3 and 20 all merged on 2026-09-30.
- A content PR that changes a requirement, a verdict rule, the research behind a rule, or a test oracle takes the code path. The author assigns the class and has got it wrong three times: PR 20 (research with a stale 10-case minimum and private paths); PR 23, which fixed PR 20 by changing `docs/research` (the research behind a rule, so code path) and merged with no review round; and this PR 21, which adds requirements and so takes the code path.

## Private term list
The scan's term list was published once, in the PR 13 body and merge comment. It now lives outside this repo, and PR bodies and comments quote only the scan's verdict line, never the pattern.

## Limits found in review, with the smallest fix for each
| Finding | Fact | Smallest mechanism | Status |
|---|---|---|---|
| B1 merge pinned to an unreviewed head | PR 10 round 2 approved e97ea76; 0189a7c (a wording-only change to 3 lines of `expected.md`) was pushed 69 s later; the merge was pinned to 0189a7c, the head at merge time, not the reviewed one | the evidence comment names `REVIEWED: <sha>`, and the merge passes that SHA to `--match-head-commit`, so any later push fails the merge and needs another round | open |
| B2 verdicts are the author's summaries | the 12 merged PRs have 0 GitHub reviews; every comment comes from the author's account; no comment names the reviewer's model; every reviewer so far is from the same model family as the author | post the reviewer's output verbatim, ending in `VERDICT: PASS <sha>` or `VERDICT: BLOCK <n> <sha>` with its model id; code PRs get one round from another vendor's model | open |
| B9 evidence without a head SHA | the PR 3 merge comment and the PR 15 test table give counts with no SHA | an evidence comment template whose first line is the gate's `head=<sha>` output (T1) | open |
| B10 grant and merger | author and merger are the same account; the merge grant was recorded privately and quoted only by the agent; `main` has no branch protection and 0 rulesets | the operator posts any grant on the PR from their own account; branch protection requiring one approval is the operator's call | open, operator's call |
| B11 dash rule | the hook that blocks dashes is not in this repo, so a clone has no check; generated files bypassed it (33 lines in `comparison.html` at 26c9751, 31 with an em dash and 2 with an en dash, removed by PR 23) | a grep for U+2014 and U+2013 over tracked text files in the gate (T1) | open |

## Planned traceability
- Every acceptance criterion in [spec.md](../spec/spec.md) has an id, `R<n>.<letter>`.
- Planned in #18 and #19: every test names the id it proves, and `scripts/spec-check.ts` reports each criterion as tested, untested or task open, failing on an untested must criterion or on 0 criteria checked. Neither exists yet; 0 criteria have a test today.
- `bun test` collects every tracked `*.test.ts` (#25 moved the code to TypeScript on Bun for #22); `.deploy/tests/` is run by nothing.

## Where the spec layer plugs in
| Spec Kit step | File | Pipeline step | Issue |
|---|---|---|---|
| specify | `docs/spec/spec.md` | 2 | #16 |
| plan | `docs/spec/plan.md` | 2 | #17 |
| tasks | `docs/spec/tasks.md` | 2 and 4 | #17 |
| implement | the PR | 3 to 9 | |
| check what remains | `scripts/spec-check.ts` (planned) | 4, and after every merge | #18, #19 |

## Defects review has caught
| Where | Round | Finding | Fix |
|---|---|---|---|
| PR 10 (day 6 tiny dataset) | 1, at 158eb0d | Pairs were pooled across q1 and q2 (9 pairs), against the paired-case definition per question in `verdict-rules.md` | e97ea76: one verdict per question (q1 n=5, add 25; q2 n=4, add 26). Round 2 approved e97ea76; the merge went in at 0189a7c (B1). Now R4.b. |
| PR 12 (router marked historical) | 1, at 092acd7 | B1: per-arm router text left in `FLOW.md` and the diagram source without a historical mark. B2: the contract test matched exact phrases only, so it passed with B1 present | 51f0eec: text and diagram corrected; the widened test was RED at 092acd7 (8 failures) and GREEN at 51f0eec. That test was never committed; T10 adds a committed one (R17.c). |
| Postgres schema design (PR 15, merged be5f849) | design review | Six blockers: B1 cross-workspace foreign key hole; B2 silent answer-set rewrite on reload; B3 database keys looser than the validator's; B4 export order undefined; B5 missing schema USAGE grant for the loader role; B6 raw case text stored | Each has a named test, now in `src/db/tests/blockers.test.ts` (#25). The design review is not public, so the RED and GREEN claims rest on the PR body (review O2). |
| PR 21 (this PR) | 1, at 5e80a84 | 13 blocking, [pipeline-review.md](pipeline-review.md) | see the response section there |
