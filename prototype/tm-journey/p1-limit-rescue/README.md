# p1 limit rescue: split-screen cinema

The page opens on the moment the limit runs out, told as a film split screen: on the left you stop mid-sentence as the curtain drops under a lit LIMIT sign; on the right a gauge fills slowly beside a dial, marked DESIGN. Each of the six journey stages is one cinema frame with one picture and one caption, so the built map and the not-yet-run pacing idea never share a sentence.

## First viewport (poster frame, outside the six stages)

Headline "Hit your Claude limit again?", one line "We're designing a tool that paces it.", the split-screen picture (LIMIT left, DESIGN right) and one control beside User 2: "Help us decide if it is worth building: share your week." (jumps to stage 4). 25 words at 390x844 and at 1440x900.

## The six stages as pictures

| Stage | Left half | Right half | Caption or controls | Words |
|---|---|---|---|---|
| 1 Arrive | laptop, "working..." | curtain drops, "usage limit reached", Wed 14 Oct, 16:20 UTC | You, mid-sentence: the limit ran out. | 15 |
| 2 Understand | BUILT: your week drawn on the laptop | DESIGN: gauge, "pace it" dial, Next, in rehearsal, not run yet | A map shows where your week went. | 17 |
| 3 Decide | map on the laptop under a padlock | Share button sends a totals card and a nickname tag to the board | The map sends nothing. Your week's totals and a nickname you choose go only when you press Share. | 18 |
| 4 Run | prompt card pasted into an assistant window, Enter | the window shows the report tiles and a link | Open Claude Code or Codex, paste this, press Enter. Copy the prompt; See the prompt (closed) | 15 |
| 5 Read | marquee: 2 recorded limit hits, 14 Oct 16:20 UTC | 3,993 sessions; 87% big model; Codex 15% | Sample week (sample card); Guide (/guide/#tokenmax) | 18 |
| 6 Next | lit, open door | dim scaffolded door: Next, in rehearsal, not run yet, #236 | Run the map and share your week; Follow the pacing work | 18 |

Halves sit side by side from 640 px and stack top over bottom below it. Every picture is drawn in its end state; motion (curtain drop, slow gauge, dial, sign glow) runs only under `prefers-reduced-motion: no-preference`, and nothing blinks faster than once per 1.2 s. Without JS every frame and the prompt are visible; JS only adds Copy.

## Budget (from `bun scripts/uat/prototype-shots.ts prototype/tm-journey/p1-limit-rescue --scroll --strict`, exit 0)

| Budget | Limit | Actual |
|---|---|---|
| First viewport 390x844 | 25 | 25 |
| First viewport 1440x900 | 25 | 25 |
| Stages 1 to 6 words | 18 each | 15, 17, 18, 15, 18, 18 |
| Visuals per stage | 1 | 1 each, all labelled |
| Page words (prompt excluded) | 250 | 140 |

## Cost to ship as the real /tm/

- **Files:** replace `site/tm/index.html` (204 lines), `site/tm/tm.css` (367) and `site/tm/tm.js` (235) with one page of about 550 lines, mostly inline SVG; `site/tm/map.ts` is untouched. Move the CSS to `tm.css` and the copy script to `tm.js` to match the site's layout, and link `site/page.css` instead of copying its tokens.
- **Tests:** `scripts/tm.dom.test.ts` runs 34 tests (floor in `.deploy/tests/expected-counts.json:55`). Reading the test titles, about 10 runs carry over with small edits (no horizontal scroll, no dashes, text size, target size, sample-link marking, reduced motion); the rest are bound to the scroll story (terminal output, wires, ticket, curtain, router card, motion-mode switching, the copied shell command) and would be rewritten for frames, the prompt copy and the stage word budgets. The floor in `expected-counts.json` changes with them.
- **Open item before shipping:** whether Claude Code and Codex each complete the prompt is UNTESTED (FRAMING.md:26, W9).
