# How Jev!Jev changes are made

What happens to a change in this repo today. Each step carries a status: **checked** (a script or GitHub enforces it), **run** (done every time by a person or an agent, not enforced) or **planned** (with its issue).

## Roles
- **Operator**: owns the product decisions, gives the merge word for each PR and the deploy word for each release, and labels cases. Agents never label.
- **Agent**: builds in its own worktree, tests, opens the PR, fixes confirmed findings.
- **Reviewer**: a separate run, from a different model where possible, that tries to refute the PR and does not fix what it finds.

## Code changes

```
change():
    tree = new_worktree(branch = "<type>/<slug>", base = origin/main)       [run]
    write the failing test first, then the code                               [run]
    bun run typecheck                                                         [run]
    bun run gate                                                              [checked by scripts/gate.ts]
        // every Bun and shell suite runs; each test file must pass at least its
        // floor in .deploy/tests/expected-counts.json; a file with no floor, a
        // floored file that did not run, or fewer files than minFiles fails
    PR diff holds code, scripts, tests and product docs only                  [run]
        // run output, screenshots, walkthroughs and UAT captures stay outside the repo
    scan(changed files) for private content; no em or en dashes               [run, outside the repo]
    pr = open_pr(body: Closes or Refs <issue>)                                [run]
    loop:                                                                     [run]
        findings = reviewer.refute(pr.head)        // BLOCKING or OPTIONAL
        fix confirmed BLOCKING findings, re-gate, re-review the new head
    comment(pr, gate line with counts, review verdict, head SHA)              [run]
    require operator merge word
    merge(pr, --squash, --match-head-commit <reviewed head>)                  [checked by GitHub]
```

Raising a floor in `expected-counts.json` is part of the PR that adds the tests.

## Docs changes
Same path, without the test-first step. A docs change to a requirement, a verdict rule or a test oracle is a code change and gets the full review.

## Deploy

```
deploy():
    require operator deploy word                                              [run]
    tree = clean worktree at origin/main                                      [run]
    .deploy/ship.sh --dry-run                                                 [run]
    .deploy/ship.sh                                                           [checked by .deploy/ship.sh]
        // static site, then Backstage; refuses unless HEAD == fresh origin/main
        // Backstage refuses a SHA whose merged PR body does not name #67
        //   (.deploy/backstage-deploy.sh:41)
        // ends with the live verify and a vYYYY.MM.DD.N release tag
    served /DEPLOYED_SHA == the shipped SHA                                   [checked by the live verify]
```

A deploy is done when the served SHA matches, not when a command exits 0. A change to the Backstage nginx snippet goes through `.deploy/ship.sh --setup --module backstage` first.

## Acceptance testing
Browser and persona checks run against the served build. A FAIL or NOT RUN result keeps acceptance open; a PASS counts only with the served SHA it ran on. Their output (screenshots, records, reports) is kept outside this repo.

## Traceability
- Acceptance criteria in [spec.md](../spec/spec.md) carry ids, `R<n>.<letter>`.
- A test that proves a criterion names its tier and id in its title: `[unit] R6 ...`. Few tests do so today.
- A checker that reports each criterion as tested or untested is planned (#18, #19).
