# p5 Before and after: a six-panel comic strip

The cover shows two stages side by side: User 1 at a laptop under a lit LIMIT sign, and User 2 drawn as a dashed blueprint labelled DESIGN, in rehearsal, not run, with the ask beside it. Six comic panels follow, one per journey stage: User 1 runs out at the recorded moment, pacing appears only as a blueprint ("Pacing, in rehearsal, not run yet"), and the strip ends at the map you can run today and its sample card.

Open `index.html` directly; it is self-contained and fetches nothing at load. Every fact on screen is sourced in `claims.md` (BUILT or DESIGN per row).

## First viewport (cover, outside the stages)

Picture: two theatre stages. Left: curtain dropping, lit LIMIT sign, empty meter, the sentence on screen stopped at a cursor. Right: dashed User 2, a gauge filling slowly, a dashed dial, and under that half an HTML label "DESIGN in rehearsal, not run" (14 px at 390 wide). Heading: "One prompt maps your Claude Code and Codex week". The ask: "Help us decide if pacing is worth building." Control: "Example week" (in-page link to stage 5). 25 words at 390x844 and at 1440x900, no jargon.

## The six stages as pictures

| Stage | Picture | Caption and labels | Words |
|---|---|---|---|
| 1 Arrive in pain | Two-beat meme: "working..." with a half-full meter, then curtain down, LIMIT lit, meter empty, "again?" | User 1 ran out: 2 recorded limit hits, Wed 14 Oct from 16:20 UTC. | 17 |
| 2 What this is | Blueprint grid: dashed User 2, gauge filling slowly, dashed dial, DESIGN stamp, banner | Pacing, in rehearsal, not run yet / Help us decide if it is worth building: share your week. | 18 |
| 3 Decide to try | Laptop with a map inside a dashed, padlocked line; a finger on Share; one card with a name tag flies to the board | The map sends nothing. Only Share sends your week's totals and a nickname you choose. | 15 |
| 4 Run it | Prompt card goes into a laptop chat; the map's report comes out stamped BUILT | Open Claude Code or Codex, paste, press Enter. Button "Copy the prompt", closed "See the prompt", status "Copied." or "Copy by hand." | 15 (16 or 18 with status) |
| 5 Read your result | The sample card as a ticket labelled SAMPLE WEEK (the whole card links to it): 3,993 sessions, 87% Claude output: big model, Codex week 15% used, two stop marks | 2 limit hits, 14 Oct. | 18 |
| 6 Next step | A lit open door with User 1 walking in; a dashed, crossed-out door with User 2 behind it | BUILT Share your week / DESIGN Follow the router design (issue 236), in rehearsal, not run / The map guide | 18 |

Page total: 139 words, prompt excluded (budget 250). Counts are from `bun scripts/uat/prototype-shots.ts prototype/tm-journey/p5-before-after --scroll --strict`, which exits 0. The Copy status states were counted separately with the same `visibleText` rule and the prompt open: 16 ("Copied.") and 18 ("Copy by hand.").

Agent completion of the stage 4 prompt is UNTESTED in Claude Code and in Codex (`claims.md`, FRAMING.md:26, W9).

## Cost to ship as the real /tm/

- **site/tm:** replace `index.html` and `tm.css` with this page's markup and about 160 lines of CSS (linked after `../page.css`, web fonts restored), and replace `tm.js`, the scroll story, with the 25-line copy script. The served `site/tm/map.ts` is untouched.
- **Tests:** `scripts/tm.dom.test.ts` runs 34 tests (floor in `.deploy/tests/expected-counts.json:55`). Most are bound to the scroll story (`#term`, `#openCard`, `#sceneB`, `#sceneD`, the motion modes) and would be rewritten against the six panels: the sample-card href, the REAL figures only in stages 1 and 5, every DESIGN label free of digits, the prompt text and the Copy button, no jargon in the first viewport. The floor in `expected-counts.json` changes with the rewrite.
- **Rough size:** one PR, about 450 lines of site change plus a test-file rewrite of similar size. UNVERIFIED until the suites run against it.
