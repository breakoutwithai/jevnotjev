# p3 Four questions: claims (rebuild for Amendment 2)

Tree: /Users/breakout/projects/jevnotjev-wt/20261020-tm-journey-prototypes, branch feat/tm-journey-prototypes. Paths are relative to the tree root. Row format: on-screen text | status | source file:line | the exact words at that line.

Status: BUILT = exists on origin/main (the map, the share link, the shared board, the example). DESIGN = the router, pacing, Jev picking the cheaper door (issue 236, "in rehearsal, not run"); a DESIGN row carries no figure and no result, and the page never says "saves" in the present tense. Framing source: prototype/tm-journey/FRAMING.md (cited by line below).

## Framing and the ask

| On-screen text | Status | Source | Exact words at that line |
|---|---|---|---|
| Help us decide if it is worth building: share your week. (stage 1 User 2, stage 6) | BUILT (the share is the map plus the share link) | FRAMING.md:9 | "Ask on screen: \"Help us decide if it is worth building: share your week.\"" |
| We are designing a tool that would pace that use so you do not hit your weekly limit | DESIGN | FRAMING.md:7 | "\"a token router that saves you from hitting weekly limits\". This line is DESIGN: no prototype says \"saves\" in the present tense." (page says "would pace", never "saves") |
| It might be built if enough people want it | DESIGN | FRAMING.md:6 | "TokenMax is being designed and might be built if there is enough demand." |
| Through jevnotjev, TokenMax is gathering weeks from willing people; each week shared helps decide whether the router gets built | BUILT (the gathering: share link and board); the decision itself is DESIGN | FRAMING.md:8-9 | ":8 Through jevnotjev, TokenMax is gathering data from willing participants."; ":9 contribute their own week (the map, built today) to help decide whether the router gets built." |
| TokenMax is one use of Jev, the flagship example for Jev!Jev | BUILT (a statement of framing, not a feature) | FRAMING.md:5 | "Jev is the product. TokenMax is one use case of Jev and the flagship example for Jev!Jev." |
| What we are designing: a token router ... plain rules first, and Jev picking the cheaper door for the jobs the rules cannot route | DESIGN | FRAMING.md:14; issue 236 | ":14 DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route (issue 236, \"in rehearsal, not run\")"; issue 236 title "TokenMax router: Jev on the jobs rules cannot route" (FRAMING.md:21) |
| Next, in rehearsal, not run yet (stage 2 design box, stage 6 right door) | DESIGN | FRAMING.md:14 | "in rehearsal, not run" |
| No result yet. No number yet. (stage 2, stage 6) | DESIGN | issue 236 (open); brief invariant I1 | Planned, not run; the page shows no figure for it |
| The same week, paced so it is used, not hit (User 2, tagged "What we are designing") | DESIGN | FRAMING.md:14 | Pacing is DESIGN. User 2 shows no number, no chart and no before/after figure; it is a concept, not a result |
| Design, not built / What we are designing / User 2 is a design, not a result (tags and notes) | DESIGN | FRAMING.md:14 | Status words as defined in FRAMING.md:11-14 |
| Follow the router work: watch issue 236 on the jevnotjev repository | DESIGN | FRAMING.md:21 | "Issue 236 (open): \"TokenMax router: Jev on the jobs rules cannot route\"." |
| Your allowance would be paced and used rather than hit (stage 6) | DESIGN | FRAMING.md:7, :14 | "would", never "saves"; no number |

## Sample week (the only numbers on the page; all BUILT, from the map's output)

| On-screen text | Status | Source | Exact words at that line |
|---|---|---|---|
| User 1: 2 limit hits, Wed 14 Oct, from 16:20 UTC | BUILT | site/tm/index.html:49, :87 | ":87 `<p><b>2</b> cap hits, Wed 14 Oct 16:20 UTC</p>`"; ":49 all on 2026-10-14 from 16:20 UTC (line 39)" |
| 1 short window, 1 window the notice does not name (stage 5) | BUILT | scripts/tm.dom.test.ts:24; site/tm/index.html:49 | ":24 `caps: { short: 1, weekly: 0, unknown: 1 },`" |
| 515 sessions (Claude Code), 3,478 (Codex), 3,993 in all (stage 5) | BUILT | scripts/tm.dom.test.ts:22; site/tm/index.html:123 | ":22 `sessions: 515 + 3478,`"; ":123 `<dd>3,993</dd>`" |
| 444 had helper work inside them (stage 5) | BUILT | scripts/tm.dom.test.ts:23 (subagent_sessions); site/tm/index.html:48 | ":23 `subagent_sessions: 68 + 376,`" (page says "helper work") |
| Output 9,977,232 (Claude) and 7,503,143 (Codex) (stage 5) | BUILT | scripts/tm.dom.test.ts:25; site/tm/index.html:125-126 | ":25 `output_tokens: { claude: 9977232, codex: 7503143 },`" |
| 87% of Claude output ran on the big model (Opus) (stage 5) | BUILT | scripts/tm.dom.test.ts:26; site/tm/index.html:98, :127 | ":26 `opus_share_pct: 87,`"; ":98 `<b>87%</b> of Claude output, Opus-class`" |
| 15% of the Codex week used (stage 5) | BUILT | scripts/tm.dom.test.ts:27; site/tm/index.html:109 | ":27 `codex_weekly_pct: 15,`"; ":109 `<b>15%</b> of the Codex week used`" |
| One builder's real week, 16 Oct 2026; the week behind User 1's limit hits | BUILT | site/tm/index.html:36, :130 | ":130 `One builder's real week, 16 Oct 2026.`"; the same sample's 2 hits at :87 |
| Share card rows (Sessions, Limit hits, Claude output, Codex output, Big-model share, Codex week used) | BUILT | site/tm/index.html:123-128 | "Sessions / Cap hits / Claude output tokens / Codex output tokens / Opus-class share / Codex week used" (labels reworded to plain words; values identical) |
| Open the sample card (link) | BUILT | site/tm/index.html:31; scripts/tm.dom.test.ts:34 | href copied byte for byte from :31 (the brief's earlier ":30" was wrong: line 30 is the skip link to /maps/); ends `&sample`; test :34 expects `/maps/#m=...&sample$` |

## What the map does (stages 1, 2, 4, 5; all BUILT)

| On-screen text | Status | Source | Exact words at that line |
|---|---|---|---|
| A map of your own last week of Claude Code and Codex use, drawn on your own computer | BUILT | skills/tokenmax-map/SKILL.md:14, :20 | ":14 Anyone with Bun can map their last 7 days without installing anything"; ":20 The script reads the Claude Code and Codex logs in your home folder" |
| Nothing leaves until you press Share; only the week's totals are shared | BUILT | SKILL.md:20, :22 | ":20 ... and sends nothing."; ":22 a part of the address that never reaches a server until you open the page and press Share there. The script itself sends nothing."; ":22 The fields are aggregate counts only" |
| When you hit a limit: short, weekly or a window the notice does not name | BUILT | SKILL.md:22; skills/tokenmax-map/scripts/map.ts:585-588 | ":22 cap episodes by window (short, weekly, unknown)"; map.ts:585 "## Limits" table with Short / Weekly / Unknown columns |
| Sessions, how much each tool wrote, big-model share, Codex week used | BUILT | map.ts:554, :569, :690-708 | ":554 ## Claude Code usage ... Model / Output"; ":569 ## Codex usage"; ":705-707 output_tokens, opus_share_pct, codex_weekly_pct" |
| Up to three proposals; proposals, not measured savings | BUILT | SKILL.md:80; map.ts:627, :637 | ":80 Up to three recommendations ... Label each recommendation as a proposal, not measured savings."; map.ts:627 "## Proposals (not measured savings)" |
| No folder names, project names or times | BUILT | SKILL.md:22 | "No paths, project names, alias, ids or timestamps appear, even with `--by-project` or `--alias`." |
| It does not say why you hit a limit | BUILT | SKILL.md:66 | "Do not claim that work before a cap caused the cap" |
| It does not read your plan, or show cost or savings | BUILT | map.ts:690-708 (no plan field in tm-share/1); SKILL.md:66; map.ts:637 | share type lists no plan; ":66 Token counts are not subscription percentages or billed cost."; ":637 Token counts are not subscription percentages or cost." |
| It can miss a limit that appears only in message text | BUILT | SKILL.md:72 | "The default metadata mode can miss limits recorded only in message text." |
| Reads the history your tools already keep in your home folder; writes a private report in a new folder | BUILT | SKILL.md:20; map.ts:852 | ":20 writes the two reports into a new folder in the current directory"; ":852 `tokenmax-report-${stamp}`" |
| Reads both tools whenever their history is on this computer | BUILT | map.ts:847-848 | ":847 `claude: src(\"--claude\", join(env.home, \".claude\", \"projects\")),`", ":848 codex likewise; src() returns null when the folder is absent (:836-845)" |
| The map does not read your plan (Q2 note) | BUILT | map.ts:690-708 | SharePayload has v, skill, days, sources, sessions, subagent_sessions, caps, output_tokens, opus_share_pct, codex_weekly_pct; no plan field |
| Proposal 1: "2 limit episodes ... put must-deliver work early in the window and queue optional work for after the reset reading." | BUILT | map.ts:630 | "`${s.episodes.length} cap episode(s) in the period: put must-deliver work early in the window and queue optional work for after the reset reading.`" |
| Proposal 2: "1 episode has no named window: the live TokenMax band can tell the five-hour from the weekly window" | BUILT | map.ts:631 | "`${unknownCaps} episode(s) have no named window: the live TokenMax band (...) can tell the five-hour from the weekly window when the cap fires.`" (path in parentheses left off) |
| Proposal 3: "The big model wrote 87% of Claude output: test whether routine helper work holds quality on a smaller model before moving it." | BUILT | map.ts:634 | "`Opus-class models produced ${share(opus, allOut)} of Claude output tokens: test whether routine subagent work holds quality on a smaller model before moving it.`" (reworded) |
| Look here first (Limits / Claude Code usage / Codex usage rows) | BUILT | map.ts:585, :554, :569 | The three report sections named on the page exist at these lines |

## Steps and reassurance (stage 4; all BUILT)

| On-screen text | Status | Source | Exact words at that line |
|---|---|---|---|
| You paste one line; it prints a link | BUILT | SKILL.md:17; site/tm/index.html:70-71 | ":17 the one-line command"; ":70-71 \"Open this link to review and share:\" followed by the link" |
| The line (curl ... \| bun run - --share), the last thing in stage 4 and the only place the command appears | BUILT | SKILL.md:17; site/tm/index.html:188 | ":17 `curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts \| bun run - --share`" |
| Bun, a free tool; if not found paste curl -fsSL https://bun.sh/install \| bash (behind "It says Bun is not found") | BUILT | SKILL.md:20 | "No Bun yet: `curl -fsSL https://bun.sh/install \| bash`." ("a free tool" is author wording, not a product claim) |
| Reads the last 7 days by default; add --days 30 for a month, up to 90 days for a shared map (behind "I want to look back further") | BUILT | site/tm/index.html:187 | "It reads the last 7 days by default; add `--days 30` to the end of the command for a month, up to 90 days for a shared map." |
| Open the script, readable (link to /tm/map.ts) | BUILT | site/tm/index.html:190 | `<a id="note1" href="/tm/map.ts">the script, readable</a>` |
| The link it prints carries your totals after a # sign ... never reaches a server until you open the page and press Share | BUILT | SKILL.md:22 | "The link carries the fields after `#m=`, a part of the address that never reaches a server until you open the page and press Share there." |
| The link shows your totals first; press Share only if you want your week on the board | BUILT | site/tm/index.html:70-71; site/maps/index.html:19, :44 | ":70 \"Open this link to review and share:\""; maps ":19 To add yours, run the mapper with `--share` and open the link it prints." ":44 `<button type=\"button\" id=\"mapShare\">Share</button>`" |
| Lines starting "wrote" naming the private report and share draft | BUILT | site/tm/index.html:60-61 | "wrote /home/you/tokenmax-report-20261016-091208/private-report.md" and "wrote .../share-draft.md (scan: clean)" |
| New folder named tokenmax-report plus the date and time, in the folder you ran it from | BUILT | map.ts:852; SKILL.md:20 | ":852 `join(env.cwd, \`tokenmax-report-${stamp}\`)`" |
| The last thing it prints is a link | BUILT | site/tm/index.html:70-71 | "Open this link to review and share:" then the link, the final line of the sample output |
| Open a terminal ... On a Mac, press Command and Space, type Terminal, press Enter | none | none (general computer guidance, not a TokenMax claim) | Author's guidance for the "never typed" answer; not sourced in the repo |
| If this is a work computer, check with whoever looks after it first | none | none (author's advice, not a product claim) | Advice only |
| It only reads history already on this computer | BUILT | SKILL.md:20 | "reads the Claude Code and Codex logs in your home folder ... and sends nothing" |
| If even 30 days shows no limit hits, the limit may sit only in message text | BUILT | SKILL.md:72 | "The default metadata mode can miss limits recorded only in message text." |
| For Claude Code: sessions, limit hits, table of models and how much each wrote | BUILT | map.ts:554 | "## Claude Code usage ... `\| Model \| Messages \| Input \| Output \| Cache write \| Cache read \|`" |
| For Codex: last reading of the weekly window as a percent used | BUILT | map.ts:592-595 | "Last Codex window reading: ... `${r.usedPercent}% used`, window_minutes ..." |

## The board and guide (stage 6; BUILT)

| On-screen text | Status | Source | Exact words at that line |
|---|---|---|---|
| See the shared board: newest first, self-reported, not verified | BUILT | site/maps/index.html:86 | "Newest first, self-reported, not verified" |
| Understand your TokenMax map (link to /guide/#tokenmax) | BUILT | site/guide/index.html:25 | `<h2 id="tokenmax-title">Understand your TokenMax map</h2>` |

## Page-authored statements (no product claim)

| On-screen text | Status | Source | Note |
|---|---|---|---|
| Two illustrative weeks; User 1's figure is one builder's real week; User 2 is a design, not a result (stage 1 note, footer) | BUILT (the figure) | I4; site/tm/index.html:130 | User 1 and User 2 are illustrative; no person is quoted |
| Hits the limit mid-task and stops; STOP sign | none | brief story spine | Illustrative; only the 2 hits and the time are sample figures |
| Built today (tags on stage 2 lede, stage 5 lede, stage 6 left door) | BUILT | FRAMING.md:13 | "BUILT: the map, the share link, the shared board, the example (the sample card, `site/tm/index.html:31`)" |
| Question 3 maps Today and This week to the default 7 days and Weeks ago to --days 30 | BUILT | site/tm/index.html:187 | as above; question 2 changes only the reassurance sentence; question 1 only the highlighted report rows and the "what you will see" lines |

## Removed or changed in this rebuild

- Removed: the 87% and 15% figures from User 2 (they are the BUILT example's figures and now sit only in stage 5); User 2 carries no figure at all.
- Removed: the command from stages 1 to 3 and from the stage 6 door; it now appears once, last in stage 4. The Bun install line and the longer-period note moved behind `<details>` in stage 4.
- Removed earlier as unsourced: a claim that running the map costs no allowance (SKILL.md:14-22 does not say it); any Windows instruction for opening a terminal (no repo source).
