SIMULATED research: every score below comes from model readers, not people. The human reader test is the operator's step (last section).

# TokenMax journey prototypes: results (refs #309)

Five ways to take a person from "I hit my Claude or Codex limit again" to a TokenMax map of their own week, built to the brief plus operator Amendments 1 to 4, scored blind against a frozen rubric, reviewed by five hats, fixed, re-scored.

## What exists

| Prototype | Builder | Visual language | First viewport words |
|---|---|---|---|
| p1-limit-rescue | claude-opus-5-5 | split-screen cinema | 25 |
| p2-receipt | gpt-6-sol, fixes claude-sonnet-5-5 | receipt pictogram strip | 20 |
| p3-four-questions | claude-sonnet-5-5 | four tappable picture cards | 18 |
| p4-sample-first | gpt-6-sol, fixes claude-sonnet-5-5 | explorable week, drag handle | 25 |
| p5-before-after | claude-opus-5-5 | before/after comic strip | 25 |

All five pass `prototype-shots.ts --strict` (first viewport at most 25 words, each stage one labelled visual and at most 18 words, page at most 250 words without the prompt) and `scripts/tm-journey-contract.ts` (`bun test scripts/tm-journey.test.ts`: 13 of 13). Stage 4 of every prototype is one native prompt for Claude Code or Codex behind "See the prompt"; no shell command appears anywhere else. No raster image was generated (0 of the 10 allowed); every visual is inline SVG or CSS.

## Round 2 blind scores (rubric-v2.md, the pages at 80d9251)

Shuffle seed 20261021 (`scoring/r2/mapping.json`: A p4, B p5, C p2, D p1, E p3). Readers saw letters only: claude-opus-5-5 (fresh subagent; Q6 by a second fresh subagent that saw only the six stage pictures and captions), gpt-6-sol and gpt-6-astra (`codex exec -m <id>`, read-only, images attached). No third provider resolved: grok-4.7 is in the CLI catalogue but the CLI is not authenticated, and no Gemini id is pinned, so the third reader is gpt-6-astra, the same vendor as gpt-6-sol. Q1 to Q6 graded by claude-sonnet-5-5 from the key and anonymised answers only; stage walk and status check are mechanical. Raw answers, grades and tally in `scoring/r2/`.

| Prototype | Reader | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Stage walk | Status | Total of 18 |
|---|---|---|---|---|---|---|---|---|---|---|
| p5 | claude-opus-5-5 | 0 | 1 | 0 | 0 | 1 | 1 | 2 | 5 | 10 |
| p5 | gpt-6-sol | 0 | 1 | 0 | 0 | 0 | 1 | 2 | 5 | 9 |
| p5 | gpt-6-astra | 0 | 1 | 0 | 0 | 1 | 1 | 3 | 5 | 11 |
| p1 | claude-opus-5-5 | 0 | 1 | 0 | 0 | 1 | 1 | 2 | 5 | 10 |
| p1 | gpt-6-sol | 0 | 1 | 0 | 0 | 1 | 1 | 2 | 5 | 10 |
| p1 | gpt-6-astra | 0 | 1 | 0 | 0 | 0 | 1 | 2 | 5 | 9 |
| p4 | claude-opus-5-5 | 0 | 1 | 0 | 0 | 1 | 1 | 3 | 5 | 11 |
| p4 | gpt-6-sol | 0 | 1 | 0 | 0 | 0 | 0 | 3 | 5 | 9 |
| p4 | gpt-6-astra | 0 | 1 | 0 | 0 | 0 | 0 | 3 | 4 | 8 |
| p3 | claude-opus-5-5 | 0 | 1 | 0 | 0 | 1 | 0 | 2 | 5 | 9 |
| p3 | gpt-6-sol | 0 | 1 | 0 | 0 | 0 | 0 | 2 | 5 | 8 |
| p3 | gpt-6-astra | 0 | 1 | 0 | 0 | 0 | 0 | 4 | 5 | 10 |
| p2 | claude-opus-5-5 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 5 | 7 |
| p2 | gpt-6-sol | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 4 | 6 |
| p2 | gpt-6-astra | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 5 | 8 |

What the table says:
- Q1, Q3 and Q4 score 0 for every reader on every prototype. Under the 25-word first viewport no page says, at a glance, that TokenMax is a router in design that would keep you off your weekly limit AND that sharing a week decides whether it is built (Q1), that the next step is pasting a prompt into Claude Code or Codex (Q3), or what leaves the machine (Q4). The words that carried those answers in round 1 were cut to meet the budgets.
- The stage walk scores 2 to 4 of 6 everywhere: readers took the hero (outside data-stage 1 on p1, p4, p5) as stage 1, so every later quote lands one stage early. This measures markup against reading order, not comprehension.
- Q6 (glance test) separates the pages: p1 and p5 carry the two-users story in pictures alone for all three readers; p3 and p2 for none.

## Round 1 (superseded pages, rubric.md v1)

Round 1 scored the text-heavy pages at f826a59 to f6937a6 with seed 20261020 (`scoring/r1/`): p1 16.00 of 17, p3 15.67, p5 15.67, p2 14.67, p4 14.33. Q1 scored 0 for all 15 answers there too: readers put the "share your week to decide" ask under Q3, not under "what is this". Those pages were then rebuilt under Amendments 3 and 4, so the two rounds are not comparable.

## Hat findings and what was fixed

| Round | Hats | Blocking found | Outcome |
|---|---|---|---|
| 1 (text pages) | copy, honesty, a11y, cost (Claude); honesty+copy (gpt-6-astra) | 41 (gpt) plus 21 (honesty) and others, many overlapping | Classes carried into the rebuild brief; pages rebuilt (8ec469b) |
| 2 (visual pages, 8ec469b) | visual, honesty (claude-opus-5-5); a11y, copy+cost (claude-sonnet-5-5); honesty+copy (gpt-6-astra) | 6 to 12 per prototype | Fixed in one pass (1d7ed73) |
| Re-sweep (80d9251) | gpt-6-astra | 8, two classes | Named below, not fixed |

Confirmed and fixed in 1d7ed73: first viewport names what the visitor gets and links the stage 5 example; readable DESIGN, in rehearsal, not run label on User 2; "87% Claude output: big model" and "Codex week 15% used" with a SAMPLE WEEK label; the stage 3 sentence "The map sends nothing. Only Share sends your week's totals and a nickname you choose." with no stronger aria-label (the agent itself may be a cloud model, `skills/tokenmax-map/SKILL.md:24`); the DESIGN door is plain text "Follow the router design (issue 236)"; the real notice wording; Copy status within budget; p2 stage 1 cut from 24 to 18 words, its receipt paper redrawn under its labels (labels had been at 1.06:1 contrast) and a Share gate drawn on stage 3; p3 answers inside the stage 3 figure and "Prompt asks first."; p4 strip over the sample period Fri 9 to Fri 16 Oct with "no recorded limit hit" on days without one, User 2 in its own lane and the LIMIT sign at full contrast; p5 BUILT stamp moved off the untested prompt.

Refuted or accepted as written: the guide link stays root-relative because the page ships at /tm/; the DESIGN door has no link because no sourced destination exists on the allowed hosts; the "p5 is a re-skin of p1" finding (gpt-6-astra) was refuted by the visual hat, which found five distinct visual languages, though p2's receipt, p3's cards and p4's week each dominate only one or two stages.

Named, not fixed (re-sweep, same class as Q1 = 0): (a) no page states on screen that TokenMax is a Jev use case and what pacing would do about weekly limits (FRAMING.md:5-9); (b) p2 and p3 show User 1's stop only as a picture and an aria-label; (c) p3's four questions are in aria-labels only, because the mandated stage 3 sentence uses 15 of its 18 words. These conflict with the word budgets; see the operator decisions below.

## W9: the native prompt in Claude Code and Codex

Both UNTESTED. The mapper itself works on a synthetic fixture home (`HOME=<fixture> bun skills/tokenmax-map/scripts/map.ts --share`: exit 0, 2 sessions, 1 cap, a share link). The headless `claude -p` run was refused by the Claude Code permission classifier before it started (no credits spent); the Codex run was not attempted because it has the same shape. Detail in `scoring/r2/w9-result.md`. No prototype claims the prompt works; every claims.md says UNTESTED per tool.

## Ranked recommendation

1. **p5-before-after**, mean 10.00 of 18.
2. **p1-limit-rescue**, mean 9.67: 0.33 behind, one point summed over three readers, inside reader noise.
3. p4-sample-first 9.33; 4. p3-four-questions 9.00; 5. p2-receipt 7.00.

Build p5 or p1. They are the only two whose pictures alone told the two-users story to all three readers (Q6), the cheapest to ship by the cost hat (copy-only JS, size M), and the visual hat passed p5 with no blocking finding. Round 1 also put p1 first. p4's day strip needs per-day data the map does not output beyond the one dated fact, and p2 scored lowest in both rounds.

## Operator decisions before the real /tm/ build

- The word budgets and the Q1/Q3/Q4 keys cannot both hold in a 25-word first viewport. Either raise the first-viewport budget to about 40 words, or accept that the purpose, the paste-a-prompt step and the privacy line live in stages 2 to 4.
- Approve one W9 run per tool (a permission rule for `claude -p` with a fixture home, or an interactive run you watch) before any page says the prompt works.

## The human test (operator step)

Show the 390x844 first screen of p5 and p1 (`p5-before-after/shot-390x844.png`, `p1-limit-rescue/shot-390x844.png`) to three people who have hit a Claude or Codex limit, 10 seconds each, and record how many state the purpose in their own words. Issue 309 criterion 7 asks for 2 of 3 or better.

Not proven: all scores are model readers; no person has seen these pages.
