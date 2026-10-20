# P2: The receipt

A torn stub and an empty gauge show User 1 stopped at a laptop, while User 2 holds a blank DESIGN receipt beside a proposed pacing dial. The built map prints an itemised week as pictograms, and sharing that week helps decide whether the pacing idea should be built.

## Six pictures

1. A split theatre stage shows the stopped worker and the unrun design, with the ask in HTML text beside User 2.
2. A blank receipt stamped DESIGN and a slow gauge frame the invitation beside User 2.
3. A receipt points toward a share counter through a padlock gate that only Share opens.
4. A copied prompt moves from an assistant window to a report.
5. A box-office receipt headed SAMPLE WEEK uses four pictograms for sessions, limit hits, big-model share and Codex use.
6. Two doors lead to the built map (BUILT) or the router design (DESIGN, in rehearsal, not run).

## Visible word budgets

Measured with `bun scripts/uat/prototype-shots.ts prototype/tm-journey/p2-receipt --scroll --strict` (exit 0), SVG text and the masthead included, the closed prompt excluded: first viewport 20 words at 390x844 and at 1440x900; stage 1: 18; stage 2: 12; stage 3: 15; stage 4: 15 (18 after a failed Copy, "Copy by hand."); stage 5: 18; stage 6: 18; page: 98. Every text that carries meaning renders at 14 px or more at 390 px (SVG text measured through its screen transform).

## Screenshots

`shot-390x844.png`, `shot-1440x900.png` and the two `-scroll1.png` files were captured from this `index.html` by the command above (Chromium launched; the earlier SIGABRT no longer occurs), after the last edit to `index.html`.

## Cost to ship as the real /tm/

This would replace the scroll story in `site/tm/index.html` and its presentation rules in `site/tm/tm.css`, then require a focused rewrite of `scripts/tm.dom.test.ts`. That test file runs 34 tests, with a floor of 34 in `.deploy/tests/expected-counts.json`; most bind to the current scroll story, so the test impact is substantial. The native prompt has not yet been exercised through Claude Code and Codex end to end; W9 records each as TESTED or UNTESTED, both UNTESTED (the harness refused the headless run).
