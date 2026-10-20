# TokenMax journey prototype rubric, version 1

Version 1 includes Q5 and the two-users stage 6 wording from operator Amendment 1 (2026-10-20). Both were added before any prototype existed and before any score, so this is still version 1.

## Purpose

This scoring instrument is frozen before any of the five prototypes exists. Never edit this rubric after scores exist. If the rubric is wrong, create a new version file and rerun every prototype with that version.

## Reader inputs

For Q1 through Q4, the reader sees only the two first-viewport screenshots, `shot-390x844.png` and `shot-1440x900.png`, and the first-viewport visible text printed by `scripts/uat/prototype-shots.ts` at both sizes. For the stage walk, the reader sees the full-page visible text. Show prototypes as letters A to E in a shuffled order and record the shuffle seed in `RESULTS.md`. Readers do not see this answer key while answering.

For Q5 only, the reader also sees the viewport after one scroll at both sizes: `shot-390x844-scroll1.png`, `shot-1440x900-scroll1.png` and the after-one-scroll text printed by `prototype-shots.ts --scroll`.

Each reader answers each question in one or two sentences, or writes "not stated" when the first viewport does not say.

## Questions

Q1 What is this, and what does it give me?

Q2 Who is it for?

Q3 What do I do next?

Q4 Is it safe to try, and what leaves my machine?

Q5 How does User 1's week differ from User 2's, and which half exists today?

## Answer key

A grader sees only this key and the answers labelled A to E. Grade each question 0 or 1.

- **Q1 = 1** when the answer names both a summary or map of the visitor's own recent Claude Code or Codex use and at least one thing it shows: usage limit hits, sessions, how much was used (output), or which model did the work. Source, `skills/tokenmax-map/SKILL.md` line 14: "Anyone with Bun can map their last 7 days without installing anything:" Source, line 22: "The fields are aggregate counts only: skill version, days, sources, sessions, subagent sessions (Claude: sessions with subagent work, because a Claude Code subagent transcript carries its parent's sessionId; Codex: sessions with a `parent_thread_id`), cap episodes by window (short, weekly, unknown), output tokens per source, the Opus share of Claude output tokens and the last Codex weekly-window reading."
- **Q2 = 1** when the answer says people who use Claude Code or Codex on their own computer. Naming the limit-hit situation is enough if it names one of those tools. Generic "developers" or "AI users" scores 0.
- **Q3 = 1** when the answer names a concrete action that exists in the first viewport: open or see an example, or get or run the visitor's own map. "Scroll" or "learn more" alone scores 0.
- **Q4 = 1** when the answer states both that it runs on the visitor's own computer and sends nothing by itself, and that sharing is a separate choice or only totals are shared. Source, `skills/tokenmax-map/SKILL.md` line 20: "The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory, and sends nothing." Source, line 22: "The link carries the fields after `#m=`, a part of the address that never reaches a server until you open the page and press Share there. The script itself sends nothing." "not stated" scores 0.

- **Q5 = 1** when the answer states all three: User 1 stops (runs out) at the limit; User 2 has the map and sees where the week went; the pacing half (Jev pacing the allowance) is not built yet, only the map exists today. An answer that treats the pacing as working, or that cannot say which half exists, scores 0. Source: issue 236 (open: the router run is planned, not run) and `skills/tokenmax-map/SKILL.md` line 22 (what the map outputs).

## Stage walk

Give the reader these six stage definitions and the full-page visible text. For each stage, the reader quotes the first short phrase of 3 to 8 words, copied exactly, where that stage begins.

1. Arrive in pain.
2. Understand what this is.
3. Decide to try.
4. Run it with reassurance.
5. Read your result.
6. Next step: run the map now (real), share to the board, or follow the pacing work (not yet).

A quote counts when it is found inside the element marked `data-stage="k"` for its stage k. The stage score is the length of the longest run of counted quotes that appear in increasing page order, from 0 to 6.

## Total and ranking

Total per reader per prototype is Q1 + Q2 + Q3 + Q4 + Q5 (0 to 5) plus the stage score (0 to 6), so 0 to 11. Rank by mean total across readers, highest first. Break ties by fewer words in the first viewport, using the mean of the word counts printed by `prototype-shots.ts` at both sizes.

## Hard checks

These checks are not scored, but any failure blocks a prototype from ranking:

- No jargon word in the first viewport at either size. `jargon.txt` is matched case-insensitively as a whole word with an optional trailing `s`, so "rules", "Bun", and "Terminal" match; "TokenMax" never matches.
- Exactly six `data-stage` elements with values 1 through 6.
- No rank, leaderboard, or efficiency wording (issue 259).
- No external request at load.

## Results and human test

Results are **SIMULATED** model readers. The operator's human test is three people who have hit a limit: show each the 390x844 screenshot for 10 seconds and ask whether they can state the purpose.
