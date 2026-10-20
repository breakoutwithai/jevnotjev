# p3 Four picture cards

A picture story with captions: User 1 hits the limit and the curtain drops, User 2 is only a design (a gauge and a dial, labelled DESIGN), and four large picture cards (Tool, Plan, Day, Prompt) change one reassurance line when tapped. Without JavaScript all four cards, the default line and the prompt in a closed `<details>` still show.

Status words follow prototype/tm-journey/FRAMING.md; every on-screen claim is a row in claims.md.

## The six stages as pictures

| Stage | Picture | Words |
|---|---|---|
| 1 Arrive in pain | Diptych: User 1 at a laptop, lit LIMIT sign, empty meter, work stopped mid-sentence; a closed second stage beside it | 17 (also the whole first viewport at both sizes) |
| 2 Understand what this is | User 2 concept: gauge that fills slowly, dial, tags "DESIGN" and "Next, in rehearsal, not run yet", the ask as caption | 18 |
| 3 Decide to try | Four tappable picture cards, caption says the map sends nothing and only Share sends the totals and a nickname | 18 |
| 4 Run it | Clipboard, agent window with the pasted block, Enter key; one reassurance chip, "Copy the prompt", closed "See the prompt" | 18 |
| 5 Read your result | Cream sample card: two recorded hits (one solid, one dashed), clock, sessions, big-model bar, Codex gauge; the card is the sample link | 18 |
| 6 Next step | Two doors: lit "Run the map and share your week", dashed "Follow the pacing work #236" | 18 |

Page total 119 visible words (budget 250); one `data-visual` figure per stage; no horizontal scroll at 390 or 1440.

## Cost to ship as the real /tm/

Replace site/tm/index.html, site/tm/tm.css and site/tm/tm.js (the scroll story) with this markup, one inline style block and about 60 lines of script (cards, copy). scripts/tm.dom.test.ts runs 34 tests (floor in .deploy/tests/expected-counts.json:55), most bound to the scroll story (curtain, scenes, ticket, wires), so most would be rewritten; the sample-link test and the share-figure tests carry over. New tests would cover the six `data-stage` markers, the word budgets, the prompt text, the copy button and the card chip. Rough size: one PR of about 450 lines of page plus script and 250 to 350 lines of test churn. /tm/map.ts and its parity test are untouched.

## Known gaps

- The chip that cards change sits in stage 4, below the cards, to keep stage 3 at 18 words; `scrollIntoView` brings it into view on tap.
- "1 short window, 1 unknown" is drawn and spoken (aria-label) but not printed, because of the 18-word stage 5 budget.
- Door B "Follow the pacing work" has no link; no public follow page is sourced.
- Whether Claude Code or Codex completes the prompt is UNTESTED here (FRAMING.md:26, W9).
