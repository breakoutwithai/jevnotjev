# On-screen claims and sources

The paths are illustrative. The limit time and receipt figures come from one builder's real week. Stage labels and ticket language are presentation copy. BUILT names existing map, link, board or sample behavior. DESIGN names intended behavior without a measured result.

| On-screen text | Status | Source file:line | Exact words at that line |
|---|---|---|---|
| "Map your Claude Code and Codex week to see your sessions, limit hits and how much of the week you used" | BUILT | skills/tokenmax-map/SKILL.md:20-22 | "reads the Claude Code and Codex logs"; "sessions ... cap episodes by window ... the last Codex weekly-window reading" |
| "Limit reached"; "The task stops here" | BUILT | skills/tokenmax-map/SKILL.md:62 | "You've hit your limit" |
| "2 hits / Wed 14 Oct / From 16:20 UTC"; "The limit time comes from one builder's real week" | BUILT | site/tm/index.html:48-49 | "2 cap hits"; "all on 2026-10-14 from 16:20 UTC" |
| "A planned tool would pace the work across the week, so the allowance is used rather than hit"; "The week keeps moving"; "the paced path is a concept" | DESIGN | prototype/tm-journey/FRAMING.md:6-7,14 | "TokenMax is being designed and might be built"; "DESIGN: the router, pacing" |
| "Jev is the product. TokenMax is the flagship Jev!Jev use case" | DESIGN | prototype/tm-journey/FRAMING.md:5 | "Jev is the product. TokenMax is one use case of Jev and the flagship example for Jev!Jev." |
| "a token router we are designing that would pace Claude Code and Codex work across a weekly allowance" | DESIGN | prototype/tm-journey/FRAMING.md:6-7,14 | "TokenMax is being designed"; "a token router that saves you from hitting weekly limits"; "DESIGN: the router, pacing" |
| "Rules would handle the clear choices. Jev would pick the cheaper door for jobs those rules cannot route. This is in rehearsal, not run yet" | DESIGN | prototype/tm-journey/FRAMING.md:14 | "Jev picking the cheaper door for the jobs the rules cannot route (issue 236, 'in rehearsal, not run')" |
| "Help us decide if it is worth building: share your week." | DESIGN | prototype/tm-journey/FRAMING.md:8-9 | "gathering data from willing participants"; "Ask on screen: 'Help us decide if it is worth building: share your week.'" |
| "The TokenMax map is built"; "Your week can have a receipt" | BUILT | prototype/tm-journey/FRAMING.md:13 | "BUILT: the map ... the share link ... the shared board ... the example" |
| "It reads your Claude Code and Codex history and makes a private statement of sessions, observed limit hits, big-model share and the last Codex weekly reading" | BUILT | skills/tokenmax-map/SKILL.md:20-22 | "reads the Claude Code and Codex logs"; "sessions ... cap episodes by window ... the Opus share ... and the last Codex weekly-window reading" |
| "The private report also offers proposals to test; they are not measured savings" | BUILT | skills/tokenmax-map/scripts/map.ts:627,630-634 | "## Proposals (not measured savings)"; "test whether routine subagent work holds quality on a smaller model" |
| "The shared board"; "People who choose to share can put their week's totals on the board"; "self-reported and not verified" | BUILT | site/maps/index.html:18-19,86 | "TokenMax map board"; "Builders share a map"; "self-reported, not verified" |
| "Run this on your computer to read your Claude Code and Codex history, write a private report and make a review link" | BUILT | skills/tokenmax-map/SKILL.md:20-22 | "reads the Claude Code and Codex logs in your home folder, writes the two reports"; "also prints ... a link" |
| "Nothing leaves your computer until you open that link and press Share. Only the week's totals are shared" | BUILT | skills/tokenmax-map/SKILL.md:20-22 | "sends nothing"; "The fields are aggregate counts only"; "never reaches a server until you open the page and press Share there" |
| "Install Bun first from bun.sh/install"; "The line below maps your recent week"; "For a longer period, see the map guide" | BUILT | skills/tokenmax-map/SKILL.md:14,20,28 | "map their last 7 days"; "No Bun yet: curl -fsSL https://bun.sh/install"; "offer a longer period only if the user asks" |
| Exact command at the end of the run panel | BUILT | skills/tokenmax-map/SKILL.md:16-18 | "curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts" piped to "bun run - --share" |
| "An example from a real week"; "one builder's week, 16 Oct 2026"; "Open the sample card" | BUILT | site/tm/index.html:31,36 | "See a sample card" with the same sample href; "One builder's real week (16 Oct 2026)" |
| "Claude Code 515"; "Codex 3,478"; "Total 3,993"; "Sessions with helper work 444" | BUILT | site/tm/index.html:47-48 | "sessions 515 Claude and 3,478 Codex (line 32, sum 3,993)"; "sum 444" |
| "Claude output tokens 9,977,232"; "Codex output tokens 7,503,143" | BUILT | scripts/tm.dom.test.ts:25 | "output_tokens: { claude: 9977232, codex: 7503143 }" |
| "Claude output on Opus 87%"; "Last Codex weekly reading 15% used" | BUILT | scripts/tm.dom.test.ts:26-27 | "opus_share_pct: 87"; "codex_weekly_pct: 15" |
| "Observed limit hits 2 / Wed 14 Oct from 16:20 UTC" | BUILT | site/tm/index.html:48-49 | "2 cap hits"; "all on 2026-10-14 from 16:20 UTC" |
| "The statement records use; it does not explain what caused a limit" | BUILT | skills/tokenmax-map/SKILL.md:66 | "Do not claim that work before a cap caused the cap" |
| "Run the built map and choose whether to share your week's totals on the built board" | BUILT | prototype/tm-journey/FRAMING.md:9,13 | "contribute their own week (the map, built today)"; "BUILT: the map ... the shared board" |
| "follow the TokenMax router work while it is still in design"; "Design: next, in rehearsal, not run yet" | DESIGN | prototype/tm-journey/FRAMING.md:6,14 | "TokenMax is being designed and might be built"; "DESIGN: the router, pacing ... 'in rehearsal, not run'" |
