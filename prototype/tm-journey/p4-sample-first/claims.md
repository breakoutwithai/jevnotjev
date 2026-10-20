# On-screen claims and sources

The two seats are illustrative. User 1's limit figures come from one builder's recorded week. User 2 is a design concept, with no measured outcome. Every product promise and displayed figure is listed here.

| On-screen text | Status | Source file:line | Exact words at that line |
| --- | --- | --- | --- |
| Jev is the product; TokenMax is its flagship use case here. | DESIGN | `prototype/tm-journey/FRAMING.md:5` | "Jev is the product. TokenMax is one use case of Jev and the flagship example for Jev!Jev." |
| TokenMax is still being designed and may be built if enough people want it. | DESIGN | `prototype/tm-journey/FRAMING.md:6` | "TokenMax is being designed and might be built if there is enough demand." |
| A tool that would pace Claude Code and Codex use so you do not hit your weekly limit; User 2 uses the week instead of hitting the limit. | DESIGN | `prototype/tm-journey/FRAMING.md:7`, `prototype/tm-journey/FRAMING.md:14` | "a token router that saves you from hitting weekly limits" / "DESIGN: the router, pacing" |
| Help us decide if it is worth building: share your week. Willing people can contribute a week. | DESIGN | `prototype/tm-journey/FRAMING.md:8-9` | "Through jevnotjev, TokenMax is gathering data from willing participants." / "Help us decide if it is worth building: share your week." |
| What we are designing: rules first, then Jev would pick the cheaper door for jobs the rules cannot route; in rehearsal, not run yet. | DESIGN | `prototype/tm-journey/FRAMING.md:14`, `site/tm/index.html:140-147` | "DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route" / "Rules first, Jev for the rest" / "not run yet" |
| The map, share link, shared board and example exist today. | BUILT | `prototype/tm-journey/FRAMING.md:13` | "BUILT: the map (`skills/tokenmax-map/scripts/map.ts`), the share link (map.ts `shareLink`), the shared board (`site/maps/`), the example (the sample card, `site/tm/index.html:31`)." |
| Map your Claude Code and Codex history on your computer and see usage and limit hits in a private report. | BUILT | `skills/tokenmax-map/SKILL.md:20`, `skills/tokenmax-map/scripts/map.ts:537-637` | "The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory, and sends nothing." / "## Limits" |
| Nothing leaves until the visitor opens the review link and presses Share; only week's aggregate totals, without paths, project names or chat text. | BUILT | `skills/tokenmax-map/SKILL.md:22` | "The fields are aggregate counts only" / "No paths, project names, alias, ids or timestamps appear" / "until you open the page and press Share there. The script itself sends nothing." |
| The standard map covers seven days; Bun is needed. | BUILT | `skills/tokenmax-map/SKILL.md:14`, `skills/tokenmax-map/SKILL.md:20` | "Anyone with Bun can map their last 7 days without installing anything" / "No Bun yet" |
| Exact run command. | BUILT | `skills/tokenmax-map/SKILL.md:16-18` | "curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts \| bun run - --share" |
| Sample card link. | BUILT | `site/tm/index.html:31` | "See a sample card" |
| One builder's recorded week, 16 Oct 2026. | BUILT | `site/tm/index.html:36` | "One builder's real week (16 Oct 2026). Run it to see yours." |
| Two limit hits, Wed 14 Oct from 16:20 UTC, one short and one unknown. | BUILT | `site/tm/index.html:48-50`, `scripts/tm.dom.test.ts:24` | "2 cap hits" / "all on 2026-10-14 from 16:20 UTC" / "caps: { short: 1, weekly: 0, unknown: 1 }" |
| 87% of Claude output on the big model. | BUILT | `scripts/tm.dom.test.ts:26`, `site/tm/index.html:40` | "opus_share_pct: 87" / "Opus-class 87%" |
| 15% last recorded Codex weekly-window reading. | BUILT | `scripts/tm.dom.test.ts:27`, `skills/tokenmax-map/scripts/map.ts:592-595` | "codex_weekly_pct: 15" / "Last Codex window reading" |
| 3,993 sessions across Claude Code and Codex. | BUILT | `scripts/tm.dom.test.ts:22`, `site/tm/index.html:47` | "sessions: 515 + 3478" / "sum 3,993" |
| The private report shows coverage, usage, limits, evidence, proposals and what was not covered. | BUILT | `skills/tokenmax-map/scripts/map.ts:537-637` | "## Coverage" / "## Claude Code usage" / "## Codex usage" / "## Limits" / "## Evidence index" / "## Proposals (not measured savings)" / "## Not covered" |
| The map records limits without establishing their cause. | BUILT | `skills/tokenmax-map/SKILL.md:66` | "Do not claim that work before a cap caused the cap" |
| Shared board is available now; newest first, self-reported and not verified. | BUILT | `site/maps/index.html:18-19`, `site/maps/index.html:85-86` | "Builders share a map of their Claude Code and Codex use." / "Newest first, self-reported, not verified" |
