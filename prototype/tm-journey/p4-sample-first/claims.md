# Claims and evidence

Provenance: sources read in `/Users/breakout/projects/jevnotjev-wt/20261020-tm-journey-prototypes` at commit `8ec469b987a235599db1dab5da85fbadcdb664b9`, tree `7c588f1c23175985fc7ba9b059c5a7a017ff182d`; the cited `site/`, `skills/` and `FRAMING.md` files have no working-tree changes against that commit.

| On-screen text | Status | Source (repo-root path:line) | Exact words at that line |
| --- | --- | --- | --- |
| Hit your Claude limit? | BUILT | `site/tm/index.html:49` | "all on 2026-10-14 from 16:20 UTC": the sample builder did hit a limit. |
| We are designing a pacing tool. Worth building? | DESIGN | `prototype/tm-journey/FRAMING.md:6,14` | "TokenMax is being designed and might be built if there is enough demand."; "DESIGN: the router, pacing". "Pacing" is the operator's framing (FRAMING.md:7, :14), not the wording of issue 236. |
| Map your Claude Code or Codex week with one prompt. | BUILT | `prototype/tm-journey/FRAMING.md:25-26` | "Stage 4 offers one plain prompt to paste into the Claude Code or Codex they already use"; "The map script and the skill are BUILT." |
| LIMIT (sign) | BUILT | `site/tm/index.html:48-49` | "2 cap hits"; "all on 2026-10-14 from 16:20 UTC" |
| Fri 9; Fri 16 (strip axis) | BUILT | `site/tm/index.html:46` | "period 2026-10-09 to 2026-10-16 (line 24)" (9 Oct 2026 and 16 Oct 2026 are Fridays). |
| Wed 14 Oct: 2 recorded limit hits, 16:20 UTC | BUILT | `site/tm/index.html:48-49` | "2 cap hits"; "all on 2026-10-14 from 16:20 UTC" |
| Fri 9 Oct (and each other day except Wed): no recorded limit hit | BUILT | `site/tm/index.html:48-49` | "2 cap hits ... all on 2026-10-14 from 16:20 UTC": no other day is recorded as a hit. This reports what the sources record, not a claim that no limit occurred. |
| One short window; one unknown. | BUILT | `scripts/tm.dom.test.ts:24` | "caps: { short: 1, weekly: 0, unknown: 1 }" |
| DESIGN; in rehearsal, not run (User 2 panel) | DESIGN | `prototype/tm-journey/FRAMING.md:14` | "the words \"in rehearsal, not run yet\" come from `site/tm/index.html:143-145`"; the panel carries no value. |
| Help us decide if it is worth building: share your week. | DESIGN | `prototype/tm-journey/FRAMING.md:9` | "Help us decide if it is worth building: share your week." |
| The map sends nothing. Only Share sends your week's totals and a nickname you choose. | BUILT | `prototype/tm-journey/FRAMING.md:27-28`; `skills/tokenmax-map/SKILL.md:20-22`; `site/maps/maps.js:387` | "the map sends nothing and the week's totals go only when the visitor presses Share"; "Say \"your week's totals and a nickname you choose\""; `alias: aliasValue` |
| Share (picture label) | BUILT | `site/maps/index.html:41` | "Alias on the board" is the field where the nickname is typed on the board page before Share. |
| Open Claude Code or Codex, paste this, press Enter. Copy the prompt. See the prompt. Copied. Copy by hand. | BUILT (map.ts, SKILL.md); agent completion: Claude Code UNTESTED, Codex UNTESTED (W9: the harness refused the headless run) | `prototype/tm-journey/FRAMING.md:25-26` | "Stage 4 offers one plain prompt to paste into the Claude Code or Codex they already use"; "Whether a given agent follows the prompt to the end is TESTED or UNTESTED per tool". |
| Nickname the visitor chooses | BUILT | `site/maps/maps.js:387`; `site/maps/index.html:41` | `alias: aliasValue`; "Alias on the board". The honeypot field named `nickname` in the same request (`maps.js:387`) is not the visitor's nickname. |
| SAMPLE WEEK | BUILT | `site/tm/index.html:45-46` | "the builder's own run log"; "period 2026-10-09 to 2026-10-16". |
| 2 recorded limit hits | BUILT | `site/tm/index.html:48` | "2 cap hits (line 37: 1 unknown window, 1 short)" |
| 3,993 sessions | BUILT | `scripts/tm.dom.test.ts:22`; `site/tm/index.html:47` | "sessions: 515 + 3478"; "sum 3,993" |
| 87% Claude output: big model | BUILT | `scripts/tm.dom.test.ts:26`; `site/tm/index.html:49` | "opus_share_pct: 87"; "Opus-class 87% (line 40)" |
| Codex week 15% used | BUILT | `scripts/tm.dom.test.ts:27`; `site/tm/index.html:49-50` | "codex_weekly_pct: 15"; "Codex week 15% (line 41)" |
| Open the sample card | BUILT | `site/tm/index.html:31` | "See a sample card" with the `&sample` share link. |
| Guide | BUILT | `site/guide/index.html:25` | "Understand your TokenMax map" |
| BUILT; Run the map, share your week | BUILT | `prototype/tm-journey/FRAMING.md:13`; `skills/tokenmax-map/SKILL.md:22` | "BUILT: the map ... the share link ... the shared board"; "until you open the page and press Share there" |
| DESIGN; in rehearsal, not run; Follow the router design (issue 236) | DESIGN | `prototype/tm-journey/FRAMING.md:14,21` | "DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route (issue 236, open"; "Issue 236 (open): \"TokenMax router: Jev on the jobs rules cannot route\"". Plain text, not a link. |

Guidance and framing:

- The two seats are illustrative. The sample numbers come from one builder's recorded week, as documented in `site/tm/index.html:45-51`.
- The strip marks only the recorded Wednesday limit moment. Every other day reads "no recorded limit hit", which is what the same line supports (`site/tm/index.html:49`), not a claim that no limit occurred. The map reports limit hits, not their cause (`skills/tokenmax-map/SKILL.md:66`).
- "Issue 236" is a plain-text tracker reference about the router, not a measured design outcome and not the source of the word "pacing" (`prototype/tm-journey/FRAMING.md:7,14,21`).
- The native prompt is an instruction to an agent. Successful execution by Claude Code and Codex remains UNTESTED in this prototype pending W9 (`prototype/tm-journey/FRAMING.md:26`); no completion claim is made.
