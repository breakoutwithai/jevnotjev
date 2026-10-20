# p5 Before and after: claims (rebuild 2, operator Amendment 2)

Every on-screen number or promise in `index.html`, with its source and its status. Sources were read in this tree (`feat/tm-journey-prototypes`, HEAD bc69ce7). Status is BUILT or DESIGN per `prototype/tm-journey/FRAMING.md:11-14`. A DESIGN row carries no number and no result, and never says "saves" in the present tense. "Paraphrase" means the screen uses the visitor's words for the quoted text; the meaning is unchanged.

## Stage 1: arrive (first viewport)

| On-screen text | Status | Source file:line | Exact words at that line |
|---|---|---|---|
| For Claude Code and Codex users | BUILT | site/index.html:676 | "For people who hit their Claude weekly limit." (audience; the map reads both tools, SKILL.md:20) |
| TokenMax is a tool we are designing, not built yet, that would pace your Claude Code and Codex use so you do not hit your weekly limit. | DESIGN | prototype/tm-journey/FRAMING.md:6-7 | "TokenMax is being designed and might be built if there is enough demand."; line 7 gives the one-line router description and marks it "This line is DESIGN" (router said in plain words per jargon.txt, in the conditional "would"; no number) |
| User 1, How it goes now: Wed 14 Oct, from 16:20 UTC: 2 limit hits, mid-task. Stops. | BUILT | site/tm/index.html:48-49; scripts/tm.dom.test.ts:24 | "2 cap hits (line 37: 1 unknown window, 1 short), all on 2026-10-14 from 16:20 UTC"; "caps: { short: 1, weekly: 0, unknown: 1 }," (User 1 is illustrative; the time and count are the sample week's, as the map reports them) |
| User 2, What we are designing: the same week, paced so the allowance is used rather than hit. Design, not built. | DESIGN | prototype/tm-journey/FRAMING.md:14; issue 236 (OPEN) | "DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route (issue 236, \"in rehearsal, not run\" ...). A DESIGN line never carries a number or a result."; issue title "TokenMax router: Jev on the jobs rules cannot route" (no figure, no chart value, day pills carry no values) |
| Help us decide if it is worth building: share your week. | BUILT (the share), DESIGN (what is decided) | prototype/tm-journey/FRAMING.md:9 | "Ask on screen: \"Help us decide if it is worth building: share your week.\"" (verbatim) |
| Built today: A map of your own last 7 days, made on your computer. | BUILT | skills/tokenmax-map/SKILL.md:14, :20 | "Anyone with Bun can map their last 7 days without installing anything"; "The script reads the Claude Code and Codex logs in your home folder" |
| It sends nothing by itself; if you choose to share, only the week's totals go. | BUILT | skills/tokenmax-map/SKILL.md:22 | "The fields are aggregate counts only ... never reaches a server until you open the page and press Share there. The script itself sends nothing." |
| See an example week (in-page link to stage 5) | BUILT | FRAMING.md:13 | "the example (the sample card, `site/tm/index.html:31`)" |
| Open a sample card (href) | BUILT | site/tm/index.html:31; scripts/tm.dom.test.ts:258 | the `#m=...&sample` href, copied byte for byte (diff of the two hrefs is empty); "toBe(`${shareLink(REAL)}&sample`)" |
| Two illustrative weeks. User 1's limit time comes from one builder's real week, 16 Oct 2026. | BUILT | site/tm/index.html:36 | "One builder's real week (16 Oct 2026)." (User 1 and User 2 are illustrative, stated once) |

## Stage 2: what this is

| On-screen text | Status | Source file:line | Exact words at that line |
|---|---|---|---|
| TokenMax is one use case of Jev | BUILT | prototype/tm-journey/FRAMING.md:5 | "Jev is the product. TokenMax is one use case of Jev and the flagship example for Jev!Jev." |
| Jev, the question-answering tool this site is named after | BUILT | site/index.html:7 | "the four kinds of question Jev answers" |
| The map: writes a private report and a share draft into a new folder | BUILT | skills/tokenmax-map/SKILL.md:20, :42 | "writes the two reports into a new folder in the current directory"; "writes `private-report.md` and `share-draft.md` into a new folder" |
| sessions in Claude Code and in Codex | BUILT | skills/tokenmax-map/scripts/map.ts:545-546 | "sessions with in-period evidence"; "sessions with established usage" |
| limit hits: short window, weekly, or unknown | BUILT | skills/tokenmax-map/scripts/map.ts:585 | "\| Source \| Occurrences \| Distinct events \| Episodes \| Short \| Weekly \| Unknown \|" |
| output from each tool | BUILT | skills/tokenmax-map/scripts/map.ts:705 | "output_tokens: { claude: number; codex: number };" |
| how much of Claude's output came from the big model | BUILT | skills/tokenmax-map/SKILL.md:22 | "the Opus share of Claude output tokens" |
| how much of the Codex week is used | BUILT | skills/tokenmax-map/SKILL.md:22 | "the last Codex weekly-window reading" |
| up to three proposals, each labelled a proposal, not measured savings | BUILT | skills/tokenmax-map/SKILL.md:80; map.ts:636 | "Up to three recommendations ... Label each recommendation as a proposal, not measured savings."; "proposals.slice(0, 3)" |
| The share link: holds your week's totals and nothing else | BUILT | skills/tokenmax-map/SKILL.md:22 | "The fields are aggregate counts only ... No paths, project names, alias, ids or timestamps appear" |
| public board of maps, newest first, self-reported, not verified | BUILT | site/maps/index.html:86, :19 | "Newest first, self-reported, not verified"; "Every number here is self-reported by the tokenmax-map skill and not verified." |
| An example week: one builder's real week, open it without making anything | BUILT | FRAMING.md:13; site/tm/index.html:31, :36 | "the example (the sample card ...)"; the sample href; "One builder's real week (16 Oct 2026)." |
| The pacing tool (Design, not built): send each job to the cheaper door, Jev picking the door for jobs a fixed checklist cannot place, so the allowance is paced and used rather than hit. In rehearsal, not run yet. | DESIGN | FRAMING.md:14; issue 236 (OPEN); site/tm/index.html:145 | "Jev picking the cheaper door for the jobs the rules cannot route (issue 236, \"in rehearsal, not run\""; "Rules route most jobs; this run measures whether Jev decides the jobs the rules cannot."; "not run yet" (the count on that line is left out, see the removed list) |

## Stage 3: decide to try

| On-screen text | Status | Source file:line | Exact words at that line |
|---|---|---|---|
| Made on your own computer; reads your Claude Code and Codex history there | BUILT | skills/tokenmax-map/SKILL.md:20 | "reads the Claude Code and Codex logs in your home folder" |
| leaves those files unchanged | BUILT | skills/tokenmax-map/SKILL.md:32 | "Read only selected files and keep source files unchanged." |
| Sends nothing by itself; writes your map into a new folder and gives you a link | BUILT | skills/tokenmax-map/SKILL.md:20, :22 | "and sends nothing."; "`--share` also prints the share fields (format tm-share/1) and a link." |
| Sharing is a separate choice: open the link, check the fields, press Share. Only the week's totals go: sessions, limit hits by window, output per tool, big-model share, Codex week used. No file paths, project names, ids or timestamps. | BUILT | skills/tokenmax-map/SKILL.md:22 | "sessions, subagent sessions ..., cap episodes by window (short, weekly, unknown), output tokens per source, the Opus share of Claude output tokens and the last Codex weekly-window reading. No paths, project names, alias, ids or timestamps appear" |
| Your last 7 days; a longer period only if you ask for it | BUILT | skills/tokenmax-map/SKILL.md:28 | "default to the last 7 days (one weekly-limit window; keeps the run small), offer a longer period only if the user asks" |
| It will not tell you why you hit a limit, or what your week cost | BUILT | skills/tokenmax-map/SKILL.md:66; map.ts:637 | "Do not claim that work before a cap caused the cap"; "Token counts are not subscription percentages or cost." |
| Weeks shared by willing people help decide whether the router (Design, not built) is worth building | DESIGN | FRAMING.md:4-5 | "Through jevnotjev, TokenMax is gathering data from willing participants."; "contribute their own week (the map, built today) to help decide whether the router gets built" |

## Stage 4: make your map

| On-screen text | Status | Source file:line | Exact words at that line |
|---|---|---|---|
| What it does: reads your Claude Code and Codex history and writes your map into a new folder | BUILT | skills/tokenmax-map/SKILL.md:20 | "The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory" |
| Where it runs: on your own computer; paste one line into a terminal | BUILT | skills/tokenmax-map/SKILL.md:14-17 | "Anyone with Bun can map their last 7 days without installing anything:" then the one-line command |
| What leaves: nothing, until you open the link it prints and press Share there | BUILT | skills/tokenmax-map/SKILL.md:22 | "never reaches a server until you open the page and press Share there. The script itself sends nothing." |
| What is shared then: only the week's totals, the same fields as the sample card | BUILT | skills/tokenmax-map/SKILL.md:22; map.ts:690-708 | "The fields are aggregate counts only"; the tm-share/1 fields the sample card carries |
| wrote .../private-report.md, wrote .../share-draft.md (scan: clean) | BUILT | skills/tokenmax-map/scripts/map.ts:899-900 | "wrote ${join(args.out, \"private-report.md\")}"; "(scan: ... \"clean\")" |
| claude sessions 515, codex sessions 3478, cap hits 2 | BUILT | map.ts:901; site/tm/index.html:62 | "claude sessions ${...}, codex sessions ${...}, cap hits ${s.episodes.length}"; "claude sessions 515, codex sessions 3478, cap hits 2" |
| Share fields (tm-share/1). Nothing has been sent. | BUILT | map.ts:780 | "Share fields (${SHARE_VERSION}). Nothing has been sent." |
| Open this link to review and share: | BUILT | map.ts:785 | "Open this link to review and share:" |
| (details) Bun is the program that runs the map; the Bun install line | BUILT | skills/tokenmax-map/SKILL.md:14, :20 | "Anyone with Bun can map"; "No Bun yet: `curl -fsSL https://bun.sh/install \| bash`." |
| (details) "It says bun is not found" | none in the repo | n/a | the shell's own message when `bun` is missing; UNVERIFIED wording per shell, not a TokenMax claim |
| (details) add --days 30 for a longer period, up to 90 days | BUILT | site/maps/index.html:19; map.ts:793 | "Maps cover 7 days by default, or up to 90 with <code>--days</code>."; "const VALUE_FLAGS = [\"--claude\", \"--codex\", \"--days\", ...]" |
| the command (last thing in stage 4, shown once on the page) | BUILT | skills/tokenmax-map/SKILL.md:17 | "curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts \| bun run - --share" |

## Stage 5: read your result (the example, BUILT)

| On-screen text | Status | Source file:line | Exact words at that line |
|---|---|---|---|
| One builder's real week, 9 to 16 Oct 2026 | BUILT | site/tm/index.html:46 | "period 2026-10-09 to 2026-10-16" |
| Claude Code 515, Codex 3,478, 3,993 in all | BUILT | scripts/tm.dom.test.ts:22; site/tm/index.html:47 | "sessions: 515 + 3478,"; "sessions 515 Claude and 3,478 Codex (line 32, sum 3,993)" |
| With helper work: 444 sessions | BUILT | scripts/tm.dom.test.ts:23; site/tm/index.html:48 | "subagent_sessions: 68 + 376,"; "subagent sessions 68 and 376 (line 33, sum 444)" |
| 2 (1 short window, 1 unknown window), Wed 14 Oct from 16:20 UTC | BUILT | scripts/tm.dom.test.ts:24; site/tm/index.html:48-49 | "caps: { short: 1, weekly: 0, unknown: 1 },"; "all on 2026-10-14 from 16:20 UTC" |
| Output: Claude 9,977,232, Codex 7,503,143 (tokens) | BUILT | scripts/tm.dom.test.ts:25 | "output_tokens: { claude: 9977232, codex: 7503143 }," |
| 87% of Claude output on Opus | BUILT | scripts/tm.dom.test.ts:26 | "opus_share_pct: 87," |
| Codex week 15% used | BUILT | scripts/tm.dom.test.ts:27 | "codex_weekly_pct: 15," |
| Proposals (not measured savings) | BUILT | map.ts:627 | "## Proposals (not measured savings)" |
| 1. 2 limit hits in the week: put must-deliver work early in the window and queue optional work for after the reset. | BUILT | map.ts:630 | "${s.episodes.length} cap episode(s) in the period: put must-deliver work early in the window and queue optional work for after the reset reading." (paraphrase; episodes = 2) |
| 2. 1 hit has no named window: the live TokenMax band can tell the five-hour window from the weekly one when the limit fires. | BUILT | map.ts:631 | "${unknownCaps} episode(s) have no named window: the live TokenMax band (`.tokenmax/live.json` in your home folder) can tell the five-hour from the weekly window when the cap fires." (paraphrase; the report's text, the band itself was not opened) |
| 3. 87% of Claude output came from Opus-class models: test whether routine helper work holds up on a smaller model before moving it. | BUILT | map.ts:634 | "Opus-class models produced ${share(opus, allOut)} of Claude output tokens: test whether routine subagent work holds quality on a smaller model before moving it." (paraphrase; fires because 87% > 50%) |
| The report labels each one a proposal to try, not measured savings. | BUILT | SKILL.md:80 | "Label each recommendation as a proposal, not measured savings." |
| Built today: this map, the link that shares its totals, and the board; this week is also a sample card | BUILT | FRAMING.md:13 | "BUILT: the map ..., the share link (map.ts `shareLink`), the shared board (`site/maps/`), the example (the sample card, `site/tm/index.html:31`)." |
| Not on this map: whether trying the proposals helps, what caused a limit, what the week cost | BUILT | SKILL.md:66; map.ts:637 | "or that a recommendation saves allowance without a comparison"; "Token counts are not subscription percentages or cost." |
| What we are designing: a router that would pace a week like this one so the allowance is used rather than hit. Design, not built, no result yet. Weeks like this, shared by willing people, help decide whether to build it. | DESIGN | FRAMING.md:4-5, :14 | "gathering data from willing participants"; "to help decide whether the router gets built"; "A DESIGN line never carries a number or a result." |

The three proposal lines are what the current `map.ts` writes for the sample figures; the recorded 0.2.0 run's own proposal text was not opened (site/tm/index.html:50 says that run was skill 0.2.0).

## Stage 6: next step

| On-screen text | Status | Source file:line | Exact words at that line |
|---|---|---|---|
| Help us decide if it is worth building: share your week. | BUILT (the share), DESIGN (what is decided) | FRAMING.md:9 | "Ask on screen: \"Help us decide if it is worth building: share your week.\"" |
| Run the map now and share your week: open the link it prints, check the fields and press Share. Only the week's totals go. | BUILT | SKILL.md:22 | "open the page and press Share there"; "The fields are aggregate counts only" |
| See the shared board: newest first, self-reported, not verified | BUILT | site/maps/index.html:86 | "Newest first, self-reported, not verified" |
| Follow the router work (Design, not built): Next, in rehearsal, not run yet: Jev would pick the cheaper door for the jobs the rules cannot route, so the allowance would be paced and used rather than hit. No result yet. Tracked as issue 236. | DESIGN | issue 236 (OPEN, read with `gh issue view 236`); FRAMING.md:14 | title "TokenMax router: Jev on the jobs rules cannot route"; "(issue 236, \"in rehearsal, not run\"" |
| Understand your TokenMax map (link) | BUILT | site/guide/index.html:25 | "Understand your TokenMax map" |
| Footer: TokenMax is one use case of Jev, and the flagship example for Jev!Jev | BUILT | FRAMING.md:5 | "TokenMax is one use case of Jev and the flagship example for Jev!Jev." |

## Removed or moved in rebuild 2

- User 2's sample figures (2 limit hits, 87% big model, Codex week 15%, 3 proposals) removed from User 2: User 2 is now the design concept and carries no number. The figures stay only in stage 5 (BUILT example) and as User 1's limit time.
- "Never sees where the week went" (User 1) and the stage 5 "Before: User 1 / After: User 2" panel removed: they framed the map as User 2's outcome.
- "Needs Bun" and "The script, readable" link removed from stage 3; Bun install and the longer period moved behind a details control in stage 4.
- The second copy of the command in stage 6 removed: the command appears once, as the last thing in stage 4.
- "Be User 2 this week" heading removed: User 2 is not something the visitor can be today.
- Kept out from round 1: "47 jobs in rehearsal" (site/tm/index.html:145), per-day usage values (not in any file opened), "free" for Bun (no source).
