# Claims: p1 limit-hit rescue (rebuild, operator Amendment 2)

Every number or promise on `index.html`, with the line it rests on and its status. Paths are relative to the tree root
(`/Users/breakout/projects/jevnotjev-wt/20261020-tm-journey-prototypes`, branch `feat/tm-journey-prototypes`).
A literal `|` inside a quote is written `\|`. Status follows `prototype/tm-journey/FRAMING.md:11-14`: BUILT is the map,
the share link, the shared board and the example; DESIGN is the router, pacing and Jev picking the cheaper door.
A DESIGN row carries no figure and no result. The only digits in DESIGN rows are the identifier "issue 236".

## Stage 1: the pain and the ask (first viewport)

| Status | On-screen text | Source file:line | Exact words at that line |
|---|---|---|---|
| BUILT | "For Claude Code and Codex users who keep running out" | site/index.html:676 | "For people who hit their Claude weekly limit." |
| DESIGN | "TokenMax is a tool we are designing that would pace your Claude Code and Codex use so you do not hit your weekly limit. It is not built yet." | prototype/tm-journey/FRAMING.md:6 and :14 | ":6 TokenMax is being designed and might be built if there is enough demand."; ":14 DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route" |
| BUILT | "You've hit your limit" (User 1's notice) | skills/tokenmax-map/SKILL.md:62 | "its only text is the cap notice, for example `You've hit your session limit · resets 10:10pm (Europe/Warsaw)` or `You've hit your limit · resets ...`" |
| BUILT | "2 limit hits, Wed 14 Oct, from 16:20 UTC" (User 1) | scripts/tm.dom.test.ts:24 and site/tm/index.html:49 | ":24 caps: { short: 1, weekly: 0, unknown: 1 },"; ":49 (line 37: 1 unknown window, 1 short), all on 2026-10-14 from 16:20 UTC (line 39)" (weekday: `date -j -f %Y-%m-%d 2026-10-14 +%A` prints Wednesday) |
| BUILT | "See the example week" (link to stage 5) | prototype/tm-journey/FRAMING.md:13 | "BUILT: ... the example (the sample card, `site/tm/index.html:31`)." |
| DESIGN | "User 2", "Design, not built", "What we are designing" | prototype/tm-journey/FRAMING.md:14 | "DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route (issue 236, \"in rehearsal, not run\"; ...). A DESIGN line never carries a number or a result." |
| DESIGN | "The same week, paced, so the allowance is used rather than hit." | prototype/tm-journey/FRAMING.md:14 | "DESIGN: the router, pacing, ..." |
| DESIGN | "Nothing has run, so there is no result to show." | GitHub breakoutwithai/jevnotjev issue 236 (state OPEN, `gh issue view 236` 2026-10-20) and FRAMING.md:14 | title "TokenMax router: Jev on the jobs rules cannot route"; FRAMING.md:14 "\"in rehearsal, not run\"" |
| BUILT | "Help us decide if it is worth building: share your week." (button to stage 4) | prototype/tm-journey/FRAMING.md:9 | "The visitor is invited to do one thing: contribute their own week (the map, built today) to help decide whether the router gets built. Ask on screen: \"Help us decide if it is worth building: share your week.\"" |
| BUILT | "Your map is made on your own computer and sends nothing." | skills/tokenmax-map/SKILL.md:20 | "The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory, and sends nothing." |
| BUILT | "Sharing is a separate choice: only your week's totals leave, when you press Share." | skills/tokenmax-map/SKILL.md:22 | "The fields are aggregate counts only: ... The link carries the fields after `#m=`, a part of the address that never reaches a server until you open the page and press Share there. The script itself sends nothing." |
| BUILT | "Built today: the map of your own week, the share link, the shared board and an example week." | prototype/tm-journey/FRAMING.md:13 | "BUILT: the map (`skills/tokenmax-map/scripts/map.ts`), the share link (map.ts `shareLink`), the shared board (`site/maps/`), the example (the sample card, `site/tm/index.html:31`)." |
| BUILT | "Two illustrative weeks. User 1's limit hits are from one builder's real week, 16 Oct 2026." | scripts/tm.dom.test.ts:14 | "// One builder's real week, 16 Oct 2026 (the builder's own tokenmax-map 0.2.0 run, ..." |

## Stage 2: what this is

| Status | On-screen text | Source file:line | Exact words at that line |
|---|---|---|---|
| BUILT | "Jev is the product: TokenMax is one use of it" / "TokenMax is the flagship example for Jev!Jev." | prototype/tm-journey/FRAMING.md:5 and FLOW.md:1 | ":5 Jev is the product. TokenMax is one use case of Jev and the flagship example for Jev!Jev."; FLOW.md:1 "# Jev!Jev: comparison flow" |
| DESIGN | "It is being designed, and might be built if enough people need it." | prototype/tm-journey/FRAMING.md:6 | "TokenMax is being designed and might be built if there is enough demand." |
| BUILT | "Part of it you can use today" | prototype/tm-journey/FRAMING.md:13 | "BUILT: the map ..., the share link ..., the shared board ..., the example ..." |
| DESIGN | "the rest is still on paper" | prototype/tm-journey/FRAMING.md:14 | "DESIGN: the router, pacing, Jev picking the cheaper door ..." |
| DESIGN | "The TokenMax router: A token router that would keep you from hitting your weekly limit by pacing the week." | prototype/tm-journey/FRAMING.md:7 | "One line: \"a token router that [...] from hitting weekly limits\". This line is DESIGN" (elided; the page uses "would keep you from") |
| DESIGN | "Fixed rules would send most jobs; Jev would pick the cheaper door for the jobs the rules cannot route. In rehearsal, not run (issue 236). No result yet." | issue 236 (OPEN) and FRAMING.md:14 | issue body "Rules route most jobs; this run measures whether Jev decides the jobs the rules cannot."; FRAMING.md:14 "Jev picking the cheaper door for the jobs the rules cannot route (issue 236, \"in rehearsal, not run\"" |
| BUILT | "The map: Your last 7 days of Claude Code and Codex, drawn on your own computer, in two reports." | skills/tokenmax-map/SKILL.md:14 and :42 | ":14 Anyone with Bun can map their last 7 days without installing anything:"; ":42 writes `private-report.md` and `share-draft.md` into a new folder" |
| BUILT | "Your map prints a link; open it and press Share to post your week's totals to the board." | skills/tokenmax-map/SKILL.md:22 and site/maps/index.html:19 | ":22 `--share` also prints the share fields (format tm-share/1) and a link."; ":19 To add yours, run <a href=\"/tm/\">the mapper</a> with <code>--share</code> and open the link it prints." |
| BUILT | "Newest first, self-reported, not verified." / "See the board" | site/maps/index.html:86 | "Newest first, self-reported, not verified" |
| BUILT | "Through jevnotjev, TokenMax is gathering weeks from willing people. Each week shared helps decide whether the router gets built." | prototype/tm-journey/FRAMING.md:8 and :9 | ":8 Through jevnotjev, TokenMax is gathering data from willing participants."; ":9 contribute their own week (the map, built today) to help decide whether the router gets built." |
| BUILT | "How many sessions you ran in Claude Code and in Codex, and how many had helper work running alongside." | skills/tokenmax-map/SKILL.md:22 | "sessions, subagent sessions (Claude: sessions with subagent work, ...; Codex: sessions with a `parent_thread_id`)" |
| BUILT | "Each time you hit a limit: the short window, the weekly window, or unknown" | skills/tokenmax-map/SKILL.md:22 | "cap episodes by window (short, weekly, unknown)" |
| BUILT | "and when it first hit (UTC)" | skills/tokenmax-map/scripts/map.ts:606 | "\| Episode \| Source \| Window \| Reset reading \| First (UTC) \| Occurrences \| Sessions \| Evidence \|" |
| BUILT | "How much output each tool wrote, and what share of Claude output came from the big Opus model." | skills/tokenmax-map/SKILL.md:22 | "output tokens per source, the Opus share of Claude output tokens" |
| BUILT | "How much of the Codex week was used at the last reading." | skills/tokenmax-map/SKILL.md:22 | "the last Codex weekly-window reading" |
| BUILT | "It does not: Say what caused a limit." | skills/tokenmax-map/SKILL.md:66 | "Do not claim that work before a cap caused the cap, or that a recommendation saves allowance without a comparison." (the map's own rule; quoted, not a page claim) |
| BUILT | "Turn counts into a cost or a percent of your plan." (it does not) | skills/tokenmax-map/scripts/map.ts:637 | "- Token counts are not subscription percentages or cost." |
| BUILT | "Read your messages. The only text it reads is Claude Code's own limit notice." (it does not) | skills/tokenmax-map/scripts/map.ts:637 | "Message text is not read except Claude Code cap notices." |
| BUILT | "Send anything anywhere." (it does not) | skills/tokenmax-map/SKILL.md:20 | "... and sends nothing." |
| BUILT | "Understand your TokenMax map" | site/guide/index.html:25 | "Understand your TokenMax map" |

## Stage 3: decide to try

| Status | On-screen text | Source file:line | Exact words at that line |
|---|---|---|---|
| BUILT | "You use Claude Code or Codex on this computer." | skills/tokenmax-map/SKILL.md:20 | "The script reads the Claude Code and Codex logs in your home folder" |
| DESIGN | "You want a say in whether the router gets built." | prototype/tm-journey/FRAMING.md:9 | "to help decide whether the router gets built" |
| BUILT | "One line to paste, shown in the next act." | skills/tokenmax-map/SKILL.md:12 and :14 | ":12 ## One-line run"; ":14 Anyone with Bun can map their last 7 days without installing anything:" |
| BUILT | "It looks at your last 7 days unless you ask for more." | skills/tokenmax-map/SKILL.md:28 | "Otherwise default to the last 7 days (one weekly-limit window; keeps the run small), offer a longer period only if the user asks" |
| BUILT | "Two reports in a new folder on your computer. Nothing is sent." | skills/tokenmax-map/SKILL.md:20 | "writes the two reports into a new folder in the current directory, and sends nothing." |
| BUILT | "If you share, only your week's totals go: no paths, project names, ids or times." | skills/tokenmax-map/SKILL.md:22 | "The fields are aggregate counts only: ... No paths, project names, alias, ids or timestamps appear, even with `--by-project` or `--alias`." |

## Stage 4: make your map (the only place the command appears)

| Status | On-screen text | Source file:line | Exact words at that line |
|---|---|---|---|
| BUILT | "it reads the Claude Code and Codex history on your own computer and writes two reports into a new folder there." | skills/tokenmax-map/SKILL.md:20 | "The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory, and sends nothing." |
| BUILT | "It never overwrites an earlier report." | skills/tokenmax-map/SKILL.md:28 | "never overwrite an earlier report." |
| BUILT | "What leaves: nothing, until you open the link it prints and press Share. Then only your week's totals go: counts, with no paths, project names, ids or times." | skills/tokenmax-map/SKILL.md:22 | "The fields are aggregate counts only ... No paths, project names, alias, ids or timestamps appear ... a part of the address that never reaches a server until you open the page and press Share there. The script itself sends nothing." |
| BUILT | (details) "The line needs Bun, a program that runs it." and `curl -fsSL https://bun.sh/install \| bash` | skills/tokenmax-map/SKILL.md:14 and :20 | ":14 Anyone with Bun can map their last 7 days without installing anything:"; ":20 No Bun yet: `curl -fsSL https://bun.sh/install \| bash`." |
| BUILT | (details) "Add `--days 30` to the end of the line for 30 days. Shared maps go up to 90 days." | skills/tokenmax-map/scripts/map.ts:799 | "Reads the last 7 days by default. Use --days N for a longer window; shared maps allow up to 90 days." |
| BUILT | (details) "The line fetches one file from this site and runs it. Read map.ts" | skills/tokenmax-map/SKILL.md:10 | "The site serves a byte-identical copy of `scripts/map.ts` at https://jevnotjev.breakoutwithai.com/tm/map.ts" |
| BUILT | Command `curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts \| bun run - --share` (last element of stage 4) | skills/tokenmax-map/SKILL.md:17 | "curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts \| bun run - --share" |

## Stage 5: read your result (the example week, BUILT)

| Status | On-screen text | Source file:line | Exact words at that line |
|---|---|---|---|
| BUILT | "private-report.md, for you only, and share-draft.md, to review before any sharing" | skills/tokenmax-map/SKILL.md:42 and :91 | ":42 writes `private-report.md` and `share-draft.md` into a new folder"; ":91 Mark the file DRAFT - NOT APPROVED FOR SHARING. Tell the user to review it" |
| BUILT | "One builder's real week, 7 days to 16 Oct 2026" | scripts/tm.dom.test.ts:14 and site/tm/index.html:46 | ":14 One builder's real week, 16 Oct 2026"; ":46 period 2026-10-09 to 2026-10-16 (line 24)" |
| BUILT | "2 limit hits: 1 short window, 1 unknown window. Both on Wed 14 Oct, from 16:20 UTC." | scripts/tm.dom.test.ts:24 and site/tm/index.html:49 | ":24 caps: { short: 1, weekly: 0, unknown: 1 },"; ":49 all on 2026-10-14 from 16:20 UTC (line 39)" |
| BUILT | "The report says when, not why." | skills/tokenmax-map/SKILL.md:66 | "Do not claim that work before a cap caused the cap" |
| BUILT | "515 sessions" (Claude Code) / "3,478 sessions" (Codex) | site/tm/index.html:47 and scripts/tm.dom.test.ts:22 | ":47 sessions 515 Claude and 3,478 Codex (line 32, sum 3,993)"; ":22 sessions: 515 + 3478," |
| BUILT | "9,977,232 output tokens" / "7,503,143 output tokens" | scripts/tm.dom.test.ts:25 | "output_tokens: { claude: 9977232, codex: 7503143 }," |
| BUILT | "87% of that output on Opus, the big model" | scripts/tm.dom.test.ts:26 | "opus_share_pct: 87," |
| BUILT | "weekly window 15% used" | scripts/tm.dom.test.ts:27 | "codex_weekly_pct: 15," |
| BUILT | "444 sessions had helper work running alongside" | scripts/tm.dom.test.ts:23 | "subagent_sessions: 68 + 376," |
| BUILT | "Proposals (not measured savings)" | skills/tokenmax-map/scripts/map.ts:627 and SKILL.md:80 | ":627 ## Proposals (not measured savings)"; ":80 Label each recommendation as a proposal, not measured savings." |
| BUILT | "2 limit episodes: put must-deliver work early in the window and queue optional work for after the reset." | skills/tokenmax-map/scripts/map.ts:630 | "${s.episodes.length} cap episode(s) in the period: put must-deliver work early in the window and queue optional work for after the reset reading." |
| BUILT | "87% of Claude output came from Opus-class models: test whether routine helper work holds quality on a smaller model before moving it." | skills/tokenmax-map/scripts/map.ts:634 | "Opus-class models produced ${share(opus, allOut)} of Claude output tokens: test whether routine subagent work holds quality on a smaller model before moving it." (fires when Opus share > 0.5; the sample is 87%) |
| BUILT | "Token counts are not a percent of your plan or a cost." | skills/tokenmax-map/scripts/map.ts:637 | "- Token counts are not subscription percentages or cost." |
| BUILT | "Open the sample card" (href ends `&sample`) | site/tm/index.html:31 and scripts/tm.dom.test.ts:258 | the `See a sample card` href, copied byte for byte (`diff` of line 31's href against the page's href is empty); test: "toBe(`${shareLink(REAL)}&sample`)" |

## Stage 6: next step

| Status | On-screen text | Source file:line | Exact words at that line |
|---|---|---|---|
| BUILT | "Help us decide if it is worth building: share your week." | prototype/tm-journey/FRAMING.md:9 | "Ask on screen: \"Help us decide if it is worth building: share your week.\"" |
| BUILT | "Run the map now and share your week: See your own week, then open the link it prints and press Share to add it to the board: newest first, self-reported, not verified." | site/maps/index.html:19 and :86 | ":19 To add yours, run <a href=\"/tm/\">the mapper</a> with <code>--share</code> and open the link it prints. Every number here is self-reported by the tokenmax-map skill and not verified."; ":86 Newest first, self-reported, not verified" |
| DESIGN | "Follow the router work: Jev picking the cheaper door for the jobs the rules cannot route, so the week is paced and used rather than hit. In rehearsal, not run: issue 236 in the jevnotjev repository. Nothing to run yet." | issue 236 (OPEN) and FRAMING.md:14 | title "TokenMax router: Jev on the jobs rules cannot route"; FRAMING.md:14 "(issue 236, \"in rehearsal, not run\"" |

## Removed in this rebuild

- User 2's four sample figures in the first viewport (3,993 sessions, 2 limit hits, 87%, 15%) and the hero proposal line: Amendment 2 makes User 2 a design concept with no numbers. The figures now appear only in stage 5, the example.
- The hero understudy strip ("Next, in rehearsal, not run yet" in stage 1): replaced by User 2's "Design, not built" panel; it named "the jobs a fixed list cannot sort", which has no line of its own.
- Stage 3 "Bun, the program the line runs on" and the "read the script" link: the technical block may not appear in stages 1 to 3. Both moved behind details controls in stage 4.
- "A few minutes" (drafted for stage 3): no source line gives a run time, so it was cut before publishing.
- "Get your own map" (hero button): replaced by the ask, which links to the same stage.
- Still not used (unchanged from the first pass): the second report proposal at map.ts:631 (the live TokenMax band), because this prototype did not verify that the band is built on origin/main.
