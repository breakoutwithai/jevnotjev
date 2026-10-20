# Claims and evidence

| On-screen text | Status | Source (repo-root path:line) | Exact words at that line |
| --- | --- | --- | --- |
| We are designing a tool to pace your week. | DESIGN | `prototype/tm-journey/FRAMING.md:6-7` | "TokenMax is being designed and might be built if there is enough demand." "a token router that saves you from hitting weekly limits" |
| LIMIT; 2 recorded hits; Wed 14 Oct, 16:20 UTC | BUILT | `site/tm/index.html:48-50` | "2 cap hits"; "all on 2026-10-14 from 16:20 UTC" |
| One short window; one unknown. | BUILT | `scripts/tm.dom.test.ts:24` | "caps: { short: 1, weekly: 0, unknown: 1 }" |
| DESIGN; Next, in rehearsal, not run yet; Follow the pacing work | DESIGN | `prototype/tm-journey/FRAMING.md:14` | "DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route"; "in rehearsal, not run yet" |
| Help us decide if it is worth building: share your week. | DESIGN | `prototype/tm-journey/FRAMING.md:9` | "Help us decide if it is worth building: share your week." |
| The map sends nothing. | BUILT | `skills/tokenmax-map/SKILL.md:20-22` | "The script ... sends nothing." "The script itself sends nothing." |
| Week totals and your chosen nickname go when you press Share. | BUILT | `skills/tokenmax-map/SKILL.md:22`; `site/maps/maps.js:380-387` | "The fields are aggregate counts only"; "postJson(\"/api/maps\", { payload: payload, alias: aliasValue" |
| Paste a prompt into Claude Code or Codex | BUILT | `prototype/tm-journey/FRAMING.md:25-26` | "Stage 4 offers one plain prompt to paste into the Claude Code or Codex they already use"; "The map script and the skill are BUILT." |
| 3,993 sessions | BUILT | `scripts/tm.dom.test.ts:22`; `site/tm/index.html:47` | "sessions: 515 + 3478"; "sum 3,993" |
| 87% big model | BUILT | `scripts/tm.dom.test.ts:26`; `site/tm/index.html:49-50` | "opus_share_pct: 87"; "Opus-class 87%" |
| 15% Codex week | BUILT | `scripts/tm.dom.test.ts:27` | "codex_weekly_pct: 15" |
| Open the sample card | BUILT | `site/tm/index.html:31` | "See a sample card" with the `&sample` share link. |
| Guide | BUILT | `site/guide/index.html:25` | "Understand your TokenMax map" |
| Run the map and share your week | BUILT | `prototype/tm-journey/FRAMING.md:13`; `skills/tokenmax-map/SKILL.md:22` | "BUILT: the map ... the share link ... the shared board"; "until you open the page and press Share there" |

Guidance and framing:

- The two seats are illustrative. The sample numbers come from one builder's recorded week, as documented in `site/tm/index.html:45-51`.
- The seven-day strip marks only the recorded Wednesday limit moment; it makes no claim about other days. The map reports limit hits, not their cause (`skills/tokenmax-map/SKILL.md:66`).
- "Issue 236" is a plain-text tracker reference, not a measured design outcome (`prototype/tm-journey/FRAMING.md:14,21`).
- The native prompt is an instruction to an agent. Successful execution by Claude Code and Codex remains UNTESTED in this prototype pending W9 (`prototype/tm-journey/FRAMING.md:26`); no completion claim is made.
