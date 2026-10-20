# Claim register

| On-screen text | Status | Source (repo-root path:line) | Exact words at that line |
|---|---|---|---|
| Hit your Claude limit? | BUILT | `site/index.html:676` | `For people who hit their Claude weekly limit.` |
| See your week. | BUILT | `skills/tokenmax-map/SKILL.md:20-22` | `writes the two reports into a new folder`; `sessions ... cap episodes by window ... the Opus share ... the last Codex weekly-window reading` |
| Help shape a tool to pace it. | DESIGN | `prototype/tm-journey/FRAMING.md:6-7` | `TokenMax is being designed and might be built if there is enough demand.` |
| LIMIT | BUILT | `skills/tokenmax-map/SKILL.md:62` | `You've hit your limit` |
| DESIGN; blank gauge and dial | DESIGN | `prototype/tm-journey/FRAMING.md:14` | `DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route` |
| Help us decide if it is worth building: share your week. | DESIGN | `prototype/tm-journey/FRAMING.md:9` | `Ask on screen: "Help us decide if it is worth building: share your week."` |
| Map sends nothing. | BUILT | `skills/tokenmax-map/SKILL.md:20-22` | `sends nothing`; `The script itself sends nothing.` |
| Your week's totals and a nickname you choose go only when you press Share. | BUILT | `skills/tokenmax-map/SKILL.md:22`; `site/maps/maps.js:380-387` | `The link carries the fields after #m=, a part of the address that never reaches a server until you open the page and press Share there.`; `var aliasValue = sentAlias !== null ? sentAlias : alias.value;`; `postJson("/api/maps", { payload: payload, alias: aliasValue` |
| Paste a prompt into Claude Code or Codex | BUILT | `prototype/tm-journey/FRAMING.md:23-26`; `skills/tokenmax-map/SKILL.md:20-24` | `The visitor never sees a shell command. Stage 4 offers one plain prompt to paste into the Claude Code or Codex they already use`; `The map script and the skill are BUILT. Whether a given agent follows the prompt to the end is TESTED or UNTESTED per tool, recorded in each claims.md and in RESULTS.md (work item W9).` W9 completion: Claude Code UNTESTED; Codex UNTESTED. |
| Sessions 3,993 | BUILT | `scripts/tm.dom.test.ts:22`; `site/tm/index.html:47` | `sessions: 515 + 3478`; `sessions 515 Claude and 3,478 Codex (line 32, sum 3,993)` |
| Recorded limit hits 2; Wed 14 Oct, 16:20 UTC | BUILT | `scripts/tm.dom.test.ts:24`; `site/tm/index.html:48-49` | `caps: { short: 1, weekly: 0, unknown: 1 }`; `2 cap hits`; `all on 2026-10-14 from 16:20 UTC` |
| Big-model 87% | BUILT | `scripts/tm.dom.test.ts:26`; `site/tm/index.html:49-50` | `opus_share_pct: 87`; `Opus-class 87%` |
| Codex 15% | BUILT | `scripts/tm.dom.test.ts:27`; `site/tm/index.html:50` | `codex_weekly_pct: 15`; `Codex week 15%` |
| Sample | BUILT | `site/tm/index.html:31,36` | `See a sample card`; `One builder's real week (16 Oct 2026). Run it to see yours.` |
| Run the map and share your week | BUILT | `prototype/tm-journey/FRAMING.md:13`; `skills/tokenmax-map/SKILL.md:22` | `BUILT: the map ... the share link ... the shared board`; `--share also prints the share fields ... and a link.` |
| Follow the pacing work; Next, in rehearsal, not run yet | DESIGN | `prototype/tm-journey/FRAMING.md:14,20` | `DESIGN: the router, pacing`; `the words "in rehearsal, not run yet"`  |

Guidance and presentation copy:
- `Example`, `Copy the prompt`, `See the prompt`, `Copied`, `Guide`, and the six figure captions guide navigation or explain the illustration.
- The two paths are illustrative. Stage 5 uses one builder's recorded week; the design receipt has no figures or outcome.
- The design door names issue 236 in its accessible figure label as plain text.
- The exact stage 4 prompt is an instruction for an assistant, not a claim that an assistant has completed it. W9 is UNTESTED for both agents here.
