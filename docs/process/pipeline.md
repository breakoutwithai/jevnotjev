# How Jev!Jev changes are made

The pipeline every change to this repo goes through, as it is run today, with the spec layer from #16 to #19 marked where it plugs in. Written as pseudocode so each step has one owner and one exit condition.

## Roles
- **Operator**: the builder. Owns the premise, merges, and writes the challenge portal log in their own words.
- **Agent**: builds, tests, opens the PR, fixes blockers.
- **Reviewer**: a separate agent run that tries to refute the PR; it never fixes what it finds.

## Code and feature changes

```
change(day_step):
    // 1 portal step first, done as written
    step = read_portal_step(day)                       // not reordered, not replaced by notes
    concept, premise = state(step)                     // what will exist after, and why it is true
    require operator_agrees(concept, premise)

    // 2 spec layer (#16, #17): place the change before building it
    reqs  = requirement_ids(spec.md, step)             // R<n>, with must / should / later
    tasks = tasks_for(reqs, tasks.md)                  // T<n>, files, depends-on line, test name
    if not reqs: add requirement to spec.md first      // nothing is built without an id

    // 3 isolation
    tree = new_worktree(branch = "<type>/<slug>", base = origin/main)   // never the primary checkout

    // 4 build, tests first
    for criterion in criteria(reqs):                   // R5.e, R6.g, ...
        write_test(name contains criterion id)         // traceability rule, below
        assert test is RED on base                     // a test that cannot fail proves nothing
    implement(tasks)
    assert all tests GREEN and test count > 0          // "0 tests" also exits 0
    spec_check()                                       // #19: untested must criterion fails

    // 5 private-content scan over every changed file
    assert scan(changed_files, private_term_list) is empty   // list kept outside this public repo
    assert no em or en dashes                          // enforced by a write hook

    // 6 PR
    pr = open_pr(title, body = what, why, tests before and after, Refs or Closes)

    // 7 refute-by-default review, repeated until clean
    round = 1
    loop:
        findings = reviewer.refute(pr.head)            // every defect, BLOCKING or OPTIONAL
        verify each BLOCKING finding against the code  // a finding is a claim too
        if no confirmed BLOCKING: break
        fix(confirmed BLOCKING); push                  // new head
        round += 1                                     // re-review the NEW head, never the old one
    optional findings -> follow-up issues

    // 8 evidence on the PR
    comment(pr, rounds, verdict per round, head SHA reviewed, test counts, follow-ups)

    // 9 merge, pinned to the reviewed head
    require operator_says_merge(pr) or standing_grant_covers(pr)
    merge(pr, match_head_commit = reviewed_head)       // a push after review fails the merge

    // 10 close the day
    operator writes portal_log(own words)              // the agent supplies facts and links only
    capture score
```

## Content changes (docs, use cases, blog)

```
content_change():
    tree = new_worktree(branch = "docs/<slug>", base = origin/main)
    write()
    assert scan(changed_files, private_term_list) is empty
    open_pr()                                          // one content PR per day
    // no review rounds
```

A content PR that changes a requirement, a verdict rule or a test oracle is a code change and takes the full path.

## Traceability
- Every acceptance criterion in [spec.md](../spec/spec.md) has an id, `R<n>.<letter>`.
- Every test names the id it proves: `test_R5e_newcombe_matches_table_iii` in pytest, `R5.e Newcombe matches the 7 Table III rows` in a Node test title.
- `scripts/spec-check.py` (#19) reads the ids from `spec.md` and the test names from the test run, and prints each criterion as tested, untested, or task open. It exits non-zero while any must criterion has no passing test, and treats 0 checked criteria as a failure.
- Links run both ways: criterion to test (spec-check), test to criterion (the id in its name). A test with no id and a criterion with no test are both reported (#18).

## Where the spec layer plugs in
| Spec Kit step | File | Pipeline step | Issue |
|---|---|---|---|
| specify | `docs/spec/spec.md` | 2, before the worktree | #16 |
| plan | `docs/spec/plan.md` | 2 | #17 |
| tasks | `docs/spec/tasks.md` | 2 and 4 | #17 |
| implement | the PR | 3 to 9 | |
| check what remains | `scripts/spec-check.py` | 4, and after every merge | #18, #19 |

## Defects the review step has caught
| Where | Round | Finding | Fix |
|---|---|---|---|
| PR 10 (day 6 tiny dataset) | 1, at 158eb0d | Pairs were pooled across q1 and q2 (9 pairs), against the paired-case definition per question in `verdict-rules.md` | e97ea76: one verdict per question (q1 n=5, add 25; q2 n=4, add 26). Round 2 approved after the reviewer recomputed every figure. Now R4.b. |
| PR 12 (router marked historical) | 1, at 092acd7 | B1: per-arm router text left in `FLOW.md` and the diagram source without a historical mark. B2: the contract test matched exact phrases only, so it passed with B1 present | 51f0eec: text and diagram corrected; the widened test was RED at 092acd7 (8 failures) and GREEN at 51f0eec. The site sample and the US-06 wording went to #14. |
| Postgres schema design (PR 15, pending) | design review | Six blockers: B1 an answer could point at another workspace's question (cross-workspace foreign key hole); B2 a reload could silently rewrite or collapse an answer set; B3 database keys looser than the validator's; B4 export order undefined; B5 missing schema USAGE grant for the loader role; B6 raw case text stored | Each blocker has a named test in `db/tests/test_blockers.py` on the PR branch, shown RED with its fix removed and GREEN with it restored. |

The widened contract test from PR 12 was run in review and is not committed to this repo; T10 in [tasks.md](../spec/tasks.md) adds a committed consistency test (R17.c).
