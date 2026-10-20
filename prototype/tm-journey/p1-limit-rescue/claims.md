# p1 limit rescue: claims

Every on-screen product claim, its status and the line it rests on. Paths are from the tree root (`/Users/breakout/projects/jevnotjev-wt/20261020-tm-journey-prototypes`, branch `feat/tm-journey-prototypes`, HEAD `c0790bf`).

| On-screen text | Status | Source (repo-root path:line) | Exact words at that line |
|---|---|---|---|
| We're designing a tool that paces it. (first viewport) | DESIGN | prototype/tm-journey/FRAMING.md:6 | 2. TokenMax is being designed and might be built if there is enough demand. |
| DESIGN (tag on the gauge and dial, first viewport and stage 2) | DESIGN | prototype/tm-journey/FRAMING.md:14 | DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route |
| Help us decide if it is worth building: share your week. (beside User 2, first viewport) | BUILT | prototype/tm-journey/FRAMING.md:9 | contribute their own week (the map, built today) to help decide whether the router gets built. Ask on screen: "Help us decide if it is worth building: share your week." |
| LIMIT sign; Wed 14 Oct, 16:20 UTC (stage 1) | BUILT | site/tm/index.html:87 | `<p><b>2</b> cap hits, Wed 14 Oct 16:20 UTC</p>` |
| BUILT; A map shows where your week went. (stage 2) | BUILT | skills/tokenmax-map/SKILL.md:20 | The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory, and sends nothing. |
| pace it; Next, in rehearsal, not run yet (stage 2) | DESIGN | prototype/tm-journey/FRAMING.md:14 | pacing, Jev picking the cheaper door for the jobs the rules cannot route (issue 236, open; the words "in rehearsal, not run yet" come from `site/tm/index.html:143-145` |
| The map sends nothing. (stage 3) | BUILT | skills/tokenmax-map/SKILL.md:22 | The script itself sends nothing. |
| go only when you press Share (stage 3) | BUILT | skills/tokenmax-map/SKILL.md:22 | The link carries the fields after `#m=`, a part of the address that never reaches a server until you open the page and press Share there. |
| Your week's totals (stage 3) | BUILT | skills/tokenmax-map/scripts/map.ts:696 | The public share payload. Key order is the contract order; aggregate counts only, no names, paths, ids or times. |
| a nickname you choose (stage 3) | BUILT | site/maps/maps.js:387 | `postJson("/api/maps", { payload: payload, alias: aliasValue, request_key: requestKey, nickname: el("mapTrap").value })` |
| Paste a prompt into Claude Code or Codex: "Open Claude Code or Codex, paste this, press Enter." (stage 4) | BUILT | prototype/tm-journey/FRAMING.md:25 | Stage 4 offers one plain prompt to paste into the Claude Code or Codex they already use |
| Prompt: "First read https://jevnotjev.breakoutwithai.com/tm/map.ts" (stage 4) | BUILT | site/tm/index.html:190 | `<li class="k1"><a id="note1" href="/tm/map.ts">the script, readable</a></li>` |
| Prompt: "Map my last 7 days" and "If Bun is missing" (stage 4) | BUILT | skills/tokenmax-map/SKILL.md:14 | Anyone with Bun can map their last 7 days without installing anything: |
| Prompt: "with its --share option ... give me the share link it prints" (stage 4) | BUILT | skills/tokenmax-map/SKILL.md:22 | `--share` also prints the share fields (format tm-share/1) and a link. |
| 2 recorded limit hits (stage 5) | BUILT | scripts/tm.dom.test.ts:24 | `caps: { short: 1, weekly: 0, unknown: 1 },` |
| 14 Oct 16:20 UTC (stage 5) | BUILT | site/tm/index.html:87 | `<p><b>2</b> cap hits, Wed 14 Oct 16:20 UTC</p>` |
| 3,993 sessions (stage 5) | BUILT | scripts/tm.dom.test.ts:22 | `sessions: 515 + 3478,` |
| 87% big model (stage 5) | BUILT | scripts/tm.dom.test.ts:26 | `opus_share_pct: 87,` |
| Codex 15% (stage 5, week meter) | BUILT | scripts/tm.dom.test.ts:27 | `codex_weekly_pct: 15,` |
| Sample week (link, stage 5) | BUILT | site/tm/index.html:31 | `<a href="https://jevnotjev.breakoutwithai.com/maps/#m=eyJ2IjoidG0tc2hhcmUvMSIsInNraWxsIjoiMC4zLjAiLCJkYXlzIjo3LCJzb3VyY2VzIjoiY2xhdWRlK2NvZGV4Iiwic2Vzc2lvbnMiOjM5OTMsInN1YmFnZW50X3Nlc3Npb25zIjo0NDQsImNhcHMiOnsic2hvcnQiOjEsIndlZWtseSI6MCwidW5rbm93biI6MX0sIm91dHB1dF90b2tlbnMiOnsiY2xhdWRlIjo5OTc3MjMyLCJjb2RleCI6NzUwMzE0M30sIm9wdXNfc2hhcmVfcGN0Ijo4NywiY29kZXhfd2Vla2x5X3BjdCI6MTV9&sample">See a sample card</a>` |
| Guide (link `#tokenmaxGuide` to /guide/#tokenmax, stage 5) | BUILT | site/guide/index.html:25 | `<h2 id="tokenmax-title">Understand your TokenMax map</h2>` |
| Run the map and share your week (door, stage 6) | BUILT | prototype/tm-journey/FRAMING.md:13 | BUILT: the map (`skills/tokenmax-map/scripts/map.ts`), the share link (map.ts `shareLink`), the shared board (`site/maps/`) |
| Follow the pacing work; Next, in rehearsal, not run yet (door, stage 6) | DESIGN | prototype/tm-journey/FRAMING.md:14 | DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route |
| #236 (names the issue, stage 6) | BUILT | prototype/tm-journey/FRAMING.md:21 | Issue 236 (open): "TokenMax router: Jev on the jobs rules cannot route". |
| one builder's real week, 16 Oct 2026 (footer) | BUILT | site/tm/index.html:36 | One builder's real week (16 Oct 2026). Run it to see yours. |

## Guidance and notes (not product claims)

- **Native prompt:** the map script and the skill exist (`site/tm/map.ts` is byte-identical to `skills/tokenmax-map/scripts/map.ts` by `cmp` on this tree). Whether Claude Code or Codex follows the prompt to the end is UNTESTED for both in this folder; W9 records it as TESTED or UNTESTED per tool (FRAMING.md:26). `prototype/tm-journey/RESULTS.md` does not exist on this tree yet.
- **#236 row:** BUILT means only that the issue exists and is open (`gh issue view 236 -R breakoutwithai/jevnotjev`: OPEN, 2026-10-20). The work it tracks is DESIGN (row above it); the page shows no result, number or chart for it.
- **"Hit your Claude limit again?"** is the audience, not a claim: site/index.html:676 "For people who hit their Claude weekly limit."
- **"working..." / "usage limit reached"** (stage 1) is an illustrative two-panel meme, not a quote of either product's message.
- **The people are illustrative** (footer, I4). User 1 shows only the recorded moment from the sample (Wed 14 Oct, 16:20 UTC); no stopped days or timeline are drawn. User 2 shows no number, result or outcome: the gauge and dial carry DESIGN and "Next, in rehearsal, not run yet".
- **Stage 3 wording** follows FRAMING.md:27-28: never "nothing leaves your computer", never "only totals".
- **Visitor words** (limit, ran out, week, pace it) come from the person hypothesis in the concept brief, not from a measurement.
- **Not shown, by budget:** "Wed" before 14 Oct in stage 5 (stage 1 carries it), "1 short window, 1 unknown" (figure aria-label only), output token counts, 444 helper sessions, the report's proposals. Stage 6 shows no BUILT or DESIGN word: the lit door versus the dashed, scaffolded door carries the split, and the figure's aria-label states it.
