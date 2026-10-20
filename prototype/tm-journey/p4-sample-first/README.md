# P4: Try the example first

A theatre scene lets visitors explore one recorded sample week before they decide whether to map their own. The stopped User 1 sits beside User 2's explicitly unbuilt pacing design, so the example remains evidence of the map rather than evidence of the design.

## Six pictures

1. A falling curtain interrupts a laptop sentence at a lit LIMIT sign; a line under the picture says how to map your week. 15 words in the stage, 10 in the line.
2. User 1's recorded week on a Fri 9 to Fri 16 Oct 2026 strip with the Wednesday hit marked; User 2 sits in a separate DESIGN panel, in rehearsal, not run, with no values. 18 words.
3. A report approaches a Share door; the caption says what the map sends and what only Share sends. 16 words.
4. A prompt card enters a laptop; a copy button and closed prompt disclosure sit below it. 15 visible words, excluding the prompt.
5. A SAMPLE WEEK label over four panels with the real sample figures, and the guide link. 18 words.
6. Two doors: BUILT leads to the map; DESIGN is plain text about the router design (issue 236), in rehearsal, not run. 18 words.

"See sample" goes to picture 5. The ask sits beside picture 2. The range control moves a spotlight along the strip and sets the day text, a polite live region mirrored in the control's aria-valuetext; with JavaScript off, the strip and the Wednesday mark remain visible.

## Capture status

Captured with `bun scripts/uat/prototype-shots.ts prototype/tm-journey/p4-sample-first --scroll --strict` (exit 0): first viewport 25 words at 390x844 and 1440x900; stages at most 18 words each; page 130 words excluding the prompt. The four PNGs in this folder are from that run.

## Cost to ship as the real /tm/

This would replace the scroll story in `site/tm/index.html` and move the inline styles and interaction into `site/tm/tm.css` and its page script. `scripts/tm.dom.test.ts` runs 34 tests, floored in `.deploy/tests/expected-counts.json`; most assert the current scroll story and would need rewriting for the six scenes, copy behavior, sample link, sharing wording and no-JavaScript view. This is a page and test rewrite, not a mapper change.
