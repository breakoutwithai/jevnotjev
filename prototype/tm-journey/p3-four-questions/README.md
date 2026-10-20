# p3 Four picture cards

A picture story with captions: User 1 hits the limit and the curtain drops, User 2 is only a design (a gauge and a dial, labelled DESIGN in readable HTML text), and four large picture cards (which tool, which plan, which day, pasted before) show their answer inside the stage 3 figure when tapped, above a padlock gate with a Share button. Without JavaScript the cards, the padlock gate, the safety sentence and the prompt in a closed `<details>` still show; the tap hint and answers need JavaScript.

Status words follow prototype/tm-journey/FRAMING.md; every on-screen claim is a row in claims.md.

## The six stages as pictures

| Stage | Picture | Words |
|---|---|---|
| 1 Arrive in pain | Diptych: User 1 at a laptop, lit warning sign, empty meter, work stopped mid-sentence; a closed second stage beside it, labelled DESIGN, pacing tool, in rehearsal, not run | 18 (also the whole first viewport at both sizes) |
| 2 Understand what this is | User 2 concept: gauge that fills slowly, dial, tags "DESIGN" and "Next, in rehearsal, not run yet", the ask as caption | 18 |
| 3 Decide to try | Four tappable picture cards with a drawn question mark, the tapped answer inside the figure, a padlock gate with a Share button, and the exact safety sentence | 18 in every tapped state |
| 4 Run it | Clipboard, agent window with the pasted block, Enter key; one status line ("Map sends nothing.", then "Copied." or "Copy by hand."), "Copy the prompt", closed "See the prompt" | 18 |
| 5 Read your result | Cream sample card stamped SAMPLE WEEK: two recorded hits (one solid, one dashed), clock, sessions, big-model bar, Codex gauge; the card is the sample link | 18 |
| 6 Next step | Two doors: lit BUILT "Run the map, share your week", dashed DESIGN "Follow the router design (issue 236)", in rehearsal, not run (plain text, not a link) | 18 |

Page total 120 visible words (budget 250); one `data-visual` figure per stage; no horizontal scroll at 390 or 1440.

## Cost to ship as the real /tm/

Replace site/tm/index.html, site/tm/tm.css and site/tm/tm.js (the scroll story) with this markup, one inline style block and about 60 lines of script (cards, copy). scripts/tm.dom.test.ts runs 34 tests (floor in .deploy/tests/expected-counts.json:55), most bound to the scroll story (curtain, scenes, ticket, wires), so most would be rewritten; the sample-link test and the share-figure tests carry over. New tests would cover the six `data-stage` markers, the word budgets, the prompt text, the copy button and the card answer line. Rough size: one PR of about 450 lines of page plus script and 250 to 350 lines of test churn. /tm/map.ts and its parity test are untouched.

## Known gaps

- The cards print no words. The exact stage 3 safety sentence is 15 words, so only 3 words fit under the 18-word budget in every state: the questions live in the accessible names and a drawn question mark, and the answer (3 words) shows inside the figure. Printing "Which tool?" style questions needs a bigger stage budget or a shorter sentence.
- Stage 1 holds the headline, the DESIGN label and the Example button (18 words); the verbatim ask is in stage 2.
- Stage 5 prints "2 recorded limit hits" without the weekday and time (budget); the aria-label has them.
- "1 short window, 1 unknown" is drawn and spoken (aria-label) but not printed, because of the 18-word stage 5 budget.
- Door B "Follow the pacing work" has no link; no public follow page is sourced.
- Whether Claude Code or Codex completes the prompt is UNTESTED here (FRAMING.md:26, W9).
