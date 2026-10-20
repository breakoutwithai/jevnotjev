# Claim register

Provenance: every source below was read in the tree `/Users/breakout/projects/jevnotjev-wt/20261020-tm-journey-prototypes` at commit `8ec469b987a235599db1dab5da85fbadcdb664b9`; line numbers are repo-root paths at that commit.

| On-screen text | Status | Source (repo-root path:line) | Exact words at that line |
|---|---|---|---|
| Map your Claude week: one prompt. | BUILT | `skills/tokenmax-map/SKILL.md:20-22`; `prototype/tm-journey/FRAMING.md:25` | `writes the two reports into a new folder`; `Stage 4 offers one plain prompt to paste into the Claude Code or Codex they already use` |
| DESIGN; in rehearsal, not run | DESIGN | `prototype/tm-journey/FRAMING.md:14`; `site/tm/index.html:145` | `DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route`; `47 jobs in rehearsal, <span>not run yet</span>` (the words only; the 47 is not shown) |
| Help us decide if pacing is worthwhile. | DESIGN | `prototype/tm-journey/FRAMING.md:7,14,9` | `a token router that saves you from hitting weekly limits` (line 7, source of the word "pacing" with line 14: `the router, pacing`); `Ask on screen: "Help us decide if it is worth building: share your week."` (line 9, shortened here to fit the stage 1 budget; stage 2 carries the verbatim ask) |
| Help us decide if it is worth building: share your week. | DESIGN | `prototype/tm-journey/FRAMING.md:9` | `Ask on screen: "Help us decide if it is worth building: share your week."` |
| The map sends nothing. Only Share sends your week's totals and a nickname you choose. | BUILT | `skills/tokenmax-map/SKILL.md:22`; `site/maps/maps.js:387`; `site/maps/index.html:41,44` | `The script itself sends nothing.`; `postJson("/api/maps", { payload: payload, alias: aliasValue,`; `<label for="mapAlias">Alias on the board</label>`; `<button type="button" id="mapShare">Share</button>` |
| Paste a prompt into Claude Code or Codex (stage 4 caption "Open Claude Code or Codex, paste this, press Enter.") | BUILT (map.ts, SKILL.md); agent completion: Claude Code UNTESTED, Codex UNTESTED (W9: the harness refused the headless run) | `prototype/tm-journey/FRAMING.md:25-26`; `skills/tokenmax-map/SKILL.md:20-24` | `The visitor never sees a shell command. Stage 4 offers one plain prompt to paste into the Claude Code or Codex they already use`; `The map script and the skill are BUILT. Whether a given agent follows the prompt to the end is TESTED or UNTESTED per tool` |
| SAMPLE WEEK | BUILT | `site/tm/index.html:36` | `One builder's real week (16 Oct 2026). Run it to see yours.` |
| 3,993 sessions | BUILT | `scripts/tm.dom.test.ts:22`; `site/tm/index.html:47` | `sessions: 515 + 3478`; `sessions 515 Claude and 3,478 Codex (line 32, sum 3,993)` |
| 2 limit hits | BUILT | `scripts/tm.dom.test.ts:24`; `site/tm/index.html:48-49` | `caps: { short: 1, weekly: 0, unknown: 1 }`; `2 cap hits (line 37: 1 unknown window, 1 short), all on 2026-10-14 from 16:20 UTC` |
| 87% Claude output: big model | BUILT | `scripts/tm.dom.test.ts:26`; `skills/tokenmax-map/SKILL.md:22`; `site/tm/index.html:49` | `opus_share_pct: 87`; `the Opus share of Claude output tokens`; `Opus-class 87%` |
| Codex week 15% used | BUILT | `scripts/tm.dom.test.ts:27`; `skills/tokenmax-map/SKILL.md:64`; `site/tm/index.html:50` | `codex_weekly_pct: 15`; `used_percent`; `Codex week 15%` |
| Sample | BUILT | `site/tm/index.html:31,36` | `See a sample card`; `One builder's real week (16 Oct 2026). Run it to see yours.` |
| Guide | BUILT | `site/guide/index.html:24-26` | `Understand your TokenMax map`; `Sharing a map is optional: you review the fields before pressing Share.` |
| BUILT; Run the map, share your week | BUILT | `prototype/tm-journey/FRAMING.md:13`; `skills/tokenmax-map/SKILL.md:22` | `BUILT: the map ... the share link ... the shared board`; `--share also prints the share fields ... and a link.` |
| DESIGN; in rehearsal, not run; Follow the router design (issue 236) | DESIGN | `prototype/tm-journey/FRAMING.md:14,21` | `DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route (issue 236, open`; `Issue 236 (open): "TokenMax router: Jev on the jobs rules cannot route".` Issue 236 is the router; the word "pacing" is the operator's framing (FRAMING.md:7,14), not the issue's. |

Guidance and presentation copy:
- `Example` (masthead link to the stage 5 receipt), `Copy the prompt`, `See the prompt`, `Copied.`, `Copy by hand.` and the stage 2, 3 and 4 captions guide navigation or explain the illustration.
- No limit notice is shown on screen: the stage 1 left picture draws an empty gauge and a torn stub without words, so there is no invented limit message. The real notice wording is `You've hit your limit` (`skills/tokenmax-map/SKILL.md:62`) if one is ever added.
- The stage 1 ask is shortened from the verbatim ask to fit 18 words beside the DESIGN labels; the verbatim ask is stage 2's caption.
- The two stage 1 paths are illustrative. Stage 5 uses one builder's recorded week; the design receipt has no figures or outcome. The padlock on the stage 3 arrow shows Share as the gate (`site/maps/index.html:36,44`: `Nothing sent until you choose a send button.`; the Share button).
- The design door names issue 236 as plain text, not a link; the stage 6 BUILT door links to the stage 4 prompt.
- The exact stage 4 prompt is an instruction for an assistant, not a claim that an assistant has completed it. W9 is UNTESTED for both agents here: the harness refused the headless run.
