# P2: The receipt

A torn LIMIT stub shows User 1 stopped at a laptop, while User 2 holds a blank DESIGN receipt beside a proposed pacing dial. The built map prints an itemised week as pictograms, and sharing that week helps decide whether the pacing idea should be built.

## Six pictures

1. A split theatre stage shows the stopped worker and the unrun design.
2. A blank receipt and slow gauge frame the invitation beside User 2.
3. A private receipt points toward a share counter.
4. A copied prompt moves from an assistant window to a report.
5. A box-office receipt uses four pictograms for sessions, recorded limits, big-model share and Codex use.
6. Two doors lead to the built map or the design work.

## Visible word budgets

Counting SVG text, captions, controls and headings, with the closed prompt excluded: stage 1: 25 including the masthead; stage 2: 12; stage 3: 17; stage 4: 15; stage 5: 18; stage 6: 17. The entire page has 104 visible words. Browser measurements were blocked by a Chromium SIGABRT; these are static counts. The existing PNGs predate this rebuild and must not be treated as current screenshots.

## Cost to ship as the real /tm/

This would replace the scroll story in `site/tm/index.html` and its presentation rules in `site/tm/tm.css`, then require a focused rewrite of `scripts/tm.dom.test.ts`. That test file runs 34 tests, with a floor of 34 in `.deploy/tests/expected-counts.json`; most bind to the current scroll story, so the test impact is substantial. The native prompt has not yet been exercised through Claude Code and Codex end to end; W9 records each as TESTED or UNTESTED.
