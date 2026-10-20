# TokenMax journey prototype rubric, version 2

Why version 2: round 1 scores exist under `rubric.md` (version 1, unchanged), and operator Amendments 3 and 4 (2026-10-20) change what the prototypes are: a native prompt pasted into Claude Code or Codex replaces the shell command, and each stage is a visual with a caption under word budgets. So the Q3 key changes and Q6 (the glance test) is added here, in a new file, as the brief requires. Everything else is version 1 unchanged. The framing the keys rely on is in `FRAMING.md`.

## Purpose

This scoring instrument is frozen before any of the five prototypes exists. Never edit this rubric after scores exist. If the rubric is wrong, create a new version file and rerun every prototype with that version.

## Reader inputs

For Q1 through Q4, the reader sees only the two first-viewport screenshots, `shot-390x844.png` and `shot-1440x900.png`, and the first-viewport visible text printed by `scripts/uat/prototype-shots.ts` at both sizes. For the stage walk, the reader sees the full-page visible text. Show prototypes as letters A to E in a shuffled order and record the shuffle seed in `RESULTS.md`. Readers do not see this answer key while answering.

For Q6 only, the reader sees nothing but the six stage visuals with their captions: `stage-1-390.png` to `stage-6-390.png` and the caption text printed by `prototype-shots.ts --visuals`, no body text.

For Q5 only, the reader also sees the viewport after one scroll at both sizes: `shot-390x844-scroll1.png`, `shot-1440x900-scroll1.png` and the after-one-scroll text printed by `prototype-shots.ts --scroll`.

Each reader answers each question in one or two sentences, or writes "not stated" when the first viewport does not say.

## Questions

Q1 What is this, and what does it give me?

Q2 Who is it for?

Q3 What do I do next?

Q4 Is it safe to try, and what leaves my machine?

Q5 How does User 1's week differ from User 2's, and which half exists today?

Q6 (glance test, from the six stage pictures and captions only) What story do these pictures tell?

## Answer key

A grader sees only this key and the answers labelled A to E. Grade each question 0 or 1.

- **Q1 = 1** when the answer names both (a) TokenMax as a token router (or tool) that is being designed, not yet built, to keep the visitor from hitting weekly limits, and (b) that it asks people to share their week (or gathers weeks from willing people) to decide whether it is worth building. An answer that describes the router as working today scores 0. Source: `prototype/tm-journey/FRAMING.md` lines 5 to 9 (operator framing, Amendment 2) and issue 236 (open: the router run is planned, not run).
- **Q2 = 1** when the answer says people who use Claude Code or Codex on their own computer. Naming the limit-hit situation is enough if it names one of those tools. Generic "developers" or "AI users" scores 0.
- **Q3 = 1** when the answer says the next thing to do is paste a prompt into Claude Code or Codex (the tool the visitor already uses), for example to map or share their week. Opening an example alone, "scroll" or "learn more" scores 0. Source: operator Amendment 3 (2026-10-20), recorded in `FRAMING.md`; the prompt runs `skills/tokenmax-map/scripts/map.ts`.
- **Q4 = 1** when the answer states all of: (a) the map runs on the visitor's own computer and sends nothing by itself; (b) sharing is optional, a separate choice; (c) what leaves the machine when they do share: only totals or counts for the week. Source, `skills/tokenmax-map/SKILL.md` line 20: "The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory, and sends nothing." Source, line 22: "The fields are aggregate counts only" and "The link carries the fields after `#m=`, a part of the address that never reaches a server until you open the page and press Share there. The script itself sends nothing." "not stated" scores 0.

- **Q5 = 1** when the answer states all three: User 1 stops (runs out) at the limit; User 2 is what the router is meant to do, a design that is not built; what exists today is the map the visitor can run and share. An answer that treats User 2's pacing as working, or that cannot say which half exists, scores 0. Source: `prototype/tm-journey/FRAMING.md` lines 13 to 14 (BUILT and DESIGN) and issue 236.
- **Q6 = 1** under the Q5 key applied to the glance answer: User 1 stops at the limit; User 2 is pictured pacing the week as a design that is not built; and the pictures carry the ask to share a week. All three are needed.

## Status check (BUILT or DESIGN)

From the full page (all four screenshots plus `full-page.txt`), the reader marks each of these six statements BUILT, DESIGN or "not stated", by what the page says about it. The statements are the same for every prototype so the scores compare.

- S1 A map of your own last 7 days of Claude Code and Codex use. Key: BUILT.
- S2 A link you can press to share your week's totals. Key: BUILT.
- S3 A public board of weeks people have shared. Key: BUILT.
- S4 An example week you can open without running anything. Key: BUILT.
- S5 A router that sends each job to a cheaper option so you do not hit your weekly limit. Key: DESIGN.
- S6 Pacing your allowance across the week so it is used rather than hit. Key: DESIGN.

Status score = count of statements marked as the key says (0 to 6). The keys follow `FRAMING.md` lines 13 to 14; the honesty hat separately checks that every `claims.md` line carries BUILT or DESIGN and that each matches its source.

## Stage walk

Give the reader these six stage definitions and the full-page visible text. For each stage, the reader quotes the first short phrase of 3 to 8 words, copied exactly, where that stage begins.

1. Arrive in pain.
2. Understand what this is.
3. Decide to try.
4. Run it with reassurance.
5. Read your result.
6. Next step: run the map now and share your week (built), or follow the router work (design, not yet).

A quote counts when it is found inside the element marked `data-stage="k"` for its stage k. The stage score is the length of the longest run of counted quotes that appear in increasing page order, from 0 to 6.

## Total and ranking

Total per reader per prototype is Q1 + Q2 + Q3 + Q4 + Q5 + Q6 (0 to 6) plus the stage score (0 to 6) plus the status score (0 to 6), so 0 to 18. Rank by mean total across readers, highest first. Break ties by fewer words in the first viewport, using the mean of the word counts printed by `prototype-shots.ts` at both sizes.

## Hard checks

These checks are not scored, but any failure blocks a prototype from ranking (version 2 adds the word and visual budgets of Amendment 4, measured by `prototype-shots.ts --strict`: first viewport at most 25 words at both sizes, each stage exactly one labelled visual and at most 18 words, whole page at most 250 words, the prompt text excluded):

- No jargon word in the first viewport at either size. `jargon.txt` is matched case-insensitively as a whole word with an optional trailing `s`, so "rules", "Bun", and "Terminal" match; "TokenMax" never matches.
- Exactly six `data-stage` elements with values 1 through 6.
- No rank, leaderboard, or efficiency wording (issue 259).
- No external request at load.

## Results and human test

Results are **SIMULATED** model readers. The operator's human test is three people who have hit a limit: show each the 390x844 screenshot for 10 seconds and ask whether they can state the purpose.
