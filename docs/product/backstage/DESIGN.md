# Backstage Pass: design for the Jev playground

Design for #55. A few invited testers walk the TokenMax example (`examples/d06-tiny/`) through six rooms, one per stage of preparing the five main-stage acts (`site/index.html:458-521`). One page, a stepper, offline. This is the design and a clickable mock ([mock.html](mock.html)), not the production build.

## Principles
- **Theatre kept, plainly.** Room names are stage jobs a non-builder knows. Each room names the act it prepares.
- **Every number is computed, never typed.** The mock parses `records.csv` (inlined verbatim) and computes counts, costs and the verdict reason in the page. Editing a label in Rehearsals moves Dress Rehearsal and Opening Night, with the file's value shown beside anything that moved. This answers #55 question 2 (hard-coded display text).
- **Honest at five cases.** Both decision points end at "not enough evidence". The walkthrough says so and says why; it does not suggest a better verdict is one click away.
- **Offline.** No model call, no network request, no key, no storage (FLOW.md:12 excludes the tool calling any model).
- **Missing is never zero.** A missing cost shows "n/a, 1 cost missing"; an unlabelled answer counts in no total.

## Flow

```
[Backstage Pass ticket]  -->  stage door
        |
        v
 1 New Scene ----> 2 Casting ----> 3 Learning Lines ----> 4 Rehearsals ----> 5 Dress Rehearsal ----> 6 Opening Night
 (Act I)           (Act II)        (Act III cases)        (Act III labels)   (Act IV)                 (Act V)
                                                              |                   ^                        ^
                                                              +-- label edits ----+------------------------+
 Decision point switch (q1 Token Pot | q2 Dashboard) sits under the stepper and applies to every room.
```

Stepper: six buttons (3 x 2 grid at 360px, one row from 720px), Back / Next at the foot, any room reachable directly.

## Rooms

| # | Room | Prepares | Day protocol | What it teaches | TokenMax artefact shown | The one interaction |
|---|---|---|---|---|---|---|
| 0 | Backstage Pass | entry | - | What backstage is, that nothing leaves the browser | Ticket: 6 rooms, 5 CVs, 30 rows | "Go through the stage door" |
| 1 | New Scene | Act I, The question | D02 | Fix the question, the acceptance rule and the exclusions before seeing any answer | q1/q2 question text (records.csv `question`), ad line (expected.md, The workflow), answer set yes/no, acceptance rule (FLOW.md:11), five exclusions (four of the six in FLOW.md:12, plus the answer-key rule from uc11, "Keep the answer key out of the matcher") | Switch decision point |
| 2 | Casting | Act II, Enter the three players | D03 | Three arms answer the same typed question; each needs different inputs | Three cards: What you do now (`llm`, `example-llm`), A simple rule (`rule`, `keywords:token pot\|pool` or `dashboard\|meter`), Jev decides (`jev`, `jev-1.13.0`); inputs from FLOW.md "The three arms"; real vs invented tag from expected.md | Read the cards (no control beyond the switch) |
| 3 | Learning Lines | Act III, the cases | D04, D06 | The data is small enough to check by eye, in one versioned format | 15 of the 30 rows per question: CV text, each player's output, Jev confidence, cost; "cost missing" on rule cv5 q2. The keyword rule is re-run in the page and its matches highlighted | Switch decision point |
| 4 | Rehearsals | Act III, the labels | FLOW.md:11 | Labelling is blind: player, confidence and cost are hidden, order shuffled | One answer at a time with the CV and question; label pre-filled from the file (`label_source` human); cv2 q2 LLM shows as unlabelled | Accept / Reject / No label |
| 5 | Dress Rehearsal | Act IV, The reckoning | D07 | Cost per kept answer, on paired cases; missing and zero shown as such | Jev vs LLM and Jev vs rule tables (paired n, accepted, rate, spend, cost per accepted), cost ratio, Jev minus LLM, a/b/c/d, rule minus Jev, whole-file table. "Below minimum: n of 30" | Switch decision point; edits from Rehearsals show "file: x" |
| 6 | Opening Night | Act V, The verdict | D05, D08 | One of three verdicts, the rule that fired, its reason and its limits | Both decision points: verdict word, "Rule 1 fired", the exact `src/core/verdict.ts` reason line, rule comparison skipped (5 paired), three limits | Read; "New acts" card points to running your own scene with 30+ cases |

Room name decisions: "Casting / Role Play" became **Casting** (one word, and "role play" suggests acting out answers). "Opening Night / New Acts" became **Opening Night**, with "New acts" as its closing card rather than a seventh room.

### Copy drafts (as in the mock)
- Door: "The main stage plays five acts on a finished dataset. Back here you see how each act is prepared, using one small worked example, TokenMax: five fictional CVs, two yes/no questions, three players. Nothing on this page calls a model or leaves your browser."
- New Scene: "Write the question, the rule for a kept answer and what you leave out, before you see a single answer."
- Casting: "Three players answer the same typed question on the same case. Each needs different inputs."
- Learning Lines: "The script every player reads: five CVs, small enough to check by eye."
- Rehearsals: "Mark each answer accept or reject without knowing who gave it. Labels come pre-filled from the file; you confirm or change them."
- Dress Rehearsal: "Count the kept answers and divide the bill by them. A missing cost or label is shown as missing, never as zero."
- Opening Night: "One of three verdicts per decision point, the rule that fired, and what it does not cover." Closing: "Five cases cannot reach 'use Jev' or 'don't use Jev'; that is the lesson of this walkthrough, not a fault in it."

## What the TokenMax numbers are

With the file's labels the mock shows, per decision point (all from `expected.md`):

| | q1 Token Pot | q2 Dashboard |
|---|---|---|
| Paired Jev and LLM cases | 5 | 4 (cv2 LLM unlabelled) |
| Jev / LLM accepted | 4 / 5 | 3 / 3 |
| Jev / LLM spend | $0.0001 / $0.01 | $0.00008 / $0.008 |
| Jev / LLM cost per accepted | $0.000025 / $0.002 | $0.0000267 / $0.00267 |
| Cost ratio | 0.0125 | 0.01 |
| Jev minus LLM | -0.2 | 0 |
| a / b / c / d (Jev vs LLM) | 4 / 0 / 1 / 0 | 3 / 0 / 0 / 1 |
| Rule minus Jev (5 paired) | -0.4 | 0 |
| Verdict | not enough evidence, rule 1, add 25 | not enough evidence, rule 1, add 26 |

Whole file: jev 10 rows, 10 labelled, 8 accepted, $0.0002; rule 10, 10, 6, spend n/a (cv5 q2 cost missing); llm 10, 9, 8, $0.02.

Display rounding: costs and ratios at 3 significant figures, so q2 shows $0.0000267 and $0.00267 as expected.md writes them.

**What a tester can and cannot move.** A label edit changes counts, rates, costs per accepted, the ratio, a/b/c/d and the "add N more" figure (clearing a label drops the case from pairing). It cannot change the verdict word: at 5 cases rule 1 ("fewer than 30 paired") fires first whatever the labels say. The page says so. Showing rules 2 to 4 needs a 30-case fixture (expected.md, Why so small).

## Parity evidence (mock against src/core)

The mock writes its computed state to a hidden `#calc-dump`. Rendered with headless Chrome and compared field by field with `src/core/metrics.ts` + `src/core/verdict.ts` run on the same records (labels rewritten to match), 113 checks per scenario:

| Scenario (`#set=` hash) | Mismatches |
|---|---|
| file labels | 0 |
| `cv1:q1:jev:reject` | 0 |
| `cv2:q2:llm:accept,cv4:q1:jev:none` | 0 |

Checked: paired n, excluded, a/b/c/d, accepted, accept rate, spend (kind, value, missing count), cost per accepted (kind, value), verdict, rule, reason string, addN, rule comparison, whole-cohort rows/labelled/accepted/spend. No number in the mock differs from expected.md.

The mock's verdict implements only rule 1 (the only reachable rule at 5 cases). **The build must not copy it:** it should bundle `src/core/metrics.ts` and `src/core/verdict.ts` (metrics.ts:2 says it is pure and browser-importable; verdict.ts and calc.ts import nothing outside src/core, but they are TypeScript, so the site needs a build step it does not have today) so the invariant in #55 holds by construction, with the C2 parity test from #55 as the guard.

## Layout and look
- Main-stage tokens (`site/index.html:19-76`): curtain red, brass, keep green, cut red, the same light and dark values; `prefers-color-scheme` plus a "House lights" toggle (`data-theme`). System font stacks instead of Alegreya and Schibsted Grotesk, so backstage loads nothing external.
- Mobile first. Measured in headless Chrome with the page in a 360px-wide iframe (Chrome headless will not size a window below 500px): `scrollWidth == clientWidth` (360/360) on the door and all six rooms for both questions, and no card's content wider than the card. At 1280px: 1265/1265 with the scrollbar.
- Ticket and valance borrow the main stage's ticket and curtain; no overture animation, no emoji, no gradient hero.

## Cut for simplicity
- Overture curtains, scroll beats and motion from the main stage.
- Loading your own CSV, writing your own question, any live Jev call (needs FE to BE to Jev; separate issue per #55).
- Saving labels: edits live in memory and reset on reload. No accounts, no storage.
- Intervals, bootstrap cost bounds and the full verdict ladder in the UI (unreachable at 5 cases; the build gets them free from `src/core`).
- A Jev pre-grade on labels: the fixture has none (every label is `label_source` human), so the mock does not invent one. In the build, a pre-graded label would show "pre-grade, confirm" in the same slot.
- A 30-case fixture that reaches "use Jev" or "don't use Jev": not written; would be the next example if testers need to see other verdicts.

## Open questions for the operator
1. **Access gate.** Recommend nginx basic auth on `/backstage/` with one credential per tester, added via `.deploy/provision.sh` (#55). A client-side password is not a gate and would put a secret in front-end code. Alternative: unlisted path, accepted as not access control. Which?
2. **Tester feedback channel.** Recommend a GitHub issue template ("Backstage feedback: room, what confused you, what you expected"), no new backend. Alternatives: a form, or email. Which, and do testers have GitHub accounts?
3. **Who and how many testers.** Sets how many basic-auth credentials to issue (UNVERIFIED; operator).
4. **Second fixture.** Should backstage also carry a 30-case file so testers see a verdict other than "not enough evidence", or does TokenMax at 5 cases teach the minimum-evidence lesson well enough on its own?
5. **Rule cost display.** The rule's cost is $0 per call with one row missing a cost by design (expected.md, planted gap). Keep the planted gap visible to testers, as the mock does?

## Build notes (for the implementation PR)
- New `site/backstage/index.html`, bundling `src/core/*` (the site has no module or bundling step today: `site/index.html` loads no ES modules); records loaded as a static asset from the same origin (counts as static per #55 criterion 4).
- Tests per #55: C2 parity (flip cv1 q1 jev, compare with `src/core`), C3 blank cost renders "n/a", C4 headless run records zero non-static requests, C6 scrollWidth at 360px.
- Mock-only hooks not to carry over: `#calc-dump`, `#set=` and `#room=` hash parameters.
