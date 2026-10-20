# p1 limit rescue: claims

Every on-screen product claim, its status and the line it rests on. Paths are from the tree root (`/Users/breakout/projects/jevnotjev-wt/20261020-tm-journey-prototypes`, branch `feat/tm-journey-prototypes`, tree read at HEAD `8ec469b`).

| On-screen text | Status | Source (repo-root path:line) | Exact words at that line |
|---|---|---|---|
| One prompt maps your Claude Code and Codex week (first viewport) | BUILT (map.ts, SKILL.md); agent completion: Claude Code UNTESTED, Codex UNTESTED (W9: the harness refused the headless run) | skills/tokenmax-map/SKILL.md:20 | The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory, and sends nothing. |
| (example) (link to the stage 5 sample week, first viewport) | BUILT | prototype/tm-journey/FRAMING.md:13 | the example (the sample card, `site/tm/index.html:31`) |
| DESIGN: pacing (label on User 2's picture, first viewport); DESIGN, pacing (stage 2) | DESIGN | prototype/tm-journey/FRAMING.md:7 and :14 | :7 "This line is DESIGN: no prototype says "saves" in the present tense." :14 "DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route" |
| in rehearsal, not run (first viewport, stage 2, stage 6 DESIGN door) | DESIGN | prototype/tm-journey/FRAMING.md:14; site/tm/index.html:145 | :14 "the words "in rehearsal, not run yet" come from `site/tm/index.html:143-145`, not from the issue"; :145 `<p class="big">47 jobs in rehearsal, <span>not run yet</span></p>` |
| Help decide: share your week. (beside User 2, first viewport; the verbatim ask is in stage 2) | BUILT | prototype/tm-journey/FRAMING.md:9 | contribute their own week (the map, built today) to help decide whether the router gets built. Ask on screen: "Help us decide if it is worth building: share your week." |
| Help us decide if it is worth building: share your week. (stage 2 caption, links to stage 4) | BUILT | prototype/tm-journey/FRAMING.md:9 | Ask on screen: "Help us decide if it is worth building: share your week." |
| LIMIT sign (first viewport); Wed 14 Oct, 16:20 UTC (stage 1) | BUILT | site/tm/index.html:87 | `<p><b>2</b> cap hits, Wed 14 Oct 16:20 UTC</p>` |
| You've hit your limit (laptop screen, stage 1) | BUILT | skills/tokenmax-map/SKILL.md:62 | its only text is the cap notice, for example `You've hit your session limit · resets 10:10pm (Europe/Warsaw)` or `You've hit your limit · resets ...` |
| BUILT (tag on the map, stage 2) | BUILT | skills/tokenmax-map/SKILL.md:20 | The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory, and sends nothing. |
| The map sends nothing. (stage 3) | BUILT | skills/tokenmax-map/SKILL.md:22 | The script itself sends nothing. |
| Only Share sends (stage 3) | BUILT | skills/tokenmax-map/SKILL.md:22 | The link carries the fields after `#m=`, a part of the address that never reaches a server until you open the page and press Share there. |
| your week's totals (stage 3) | BUILT | skills/tokenmax-map/scripts/map.ts:696 | The public share payload. Key order is the contract order; aggregate counts only, no names, paths, ids or times. |
| a nickname you choose (stage 3) | BUILT | site/maps/maps.js:387; site/maps/index.html:41 | :387 `alias: aliasValue`; :41 `<label for="mapAlias">Alias on the board</label>` |
| Open Claude Code or Codex, paste this, press Enter. (stage 4) | BUILT | prototype/tm-journey/FRAMING.md:25 | Stage 4 offers one plain prompt to paste into the Claude Code or Codex they already use |
| The prompt (stage 4, whole text) | BUILT (map.ts, SKILL.md); agent completion: Claude Code UNTESTED, Codex UNTESTED (W9: the harness refused the headless run) | prototype/tm-journey/FRAMING.md:25-26 | that agent reads `skills/tokenmax-map/scripts/map.ts` (served at `/tm/map.ts`), says what it reads and sends, runs it on their computer, shows the report and gives the share link, and sends nothing itself. |
| Prompt: "First read https://jevnotjev.breakoutwithai.com/tm/map.ts" (stage 4) | BUILT | site/tm/index.html:190 | `<li class="k1"><a id="note1" href="/tm/map.ts">the script, readable</a></li>` |
| Prompt: "Map my last 7 days" (stage 4) | BUILT | skills/tokenmax-map/SKILL.md:14 | Anyone with Bun can map their last 7 days without installing anything: |
| Prompt: "If Bun is missing, tell me how to install it and wait." (stage 4) | BUILT | skills/tokenmax-map/SKILL.md:20 | No Bun yet: `curl -fsSL https://bun.sh/install \| bash`. |
| Prompt: "with its --share option ... give me the share link it prints" (stage 4) | BUILT | skills/tokenmax-map/SKILL.md:22 | `--share` also prints the share fields (format tm-share/1) and a link. |
| SAMPLE WEEK (label on the stage 5 picture, links to the sample card) | BUILT | site/tm/index.html:31; prototype/tm-journey/FRAMING.md:13 | :31 `<a href="https://jevnotjev.breakoutwithai.com/maps/#m=...&sample">See a sample card</a>`; :13 "the example (the sample card, `site/tm/index.html:31`)" |
| 2 recorded limit hits (stage 5) | BUILT | scripts/tm.dom.test.ts:24 | `caps: { short: 1, weekly: 0, unknown: 1 },` |
| 3,993 sessions (stage 5) | BUILT | scripts/tm.dom.test.ts:22 | `sessions: 515 + 3478,` |
| 87% Claude output: big model (stage 5) | BUILT | scripts/tm.dom.test.ts:26; skills/tokenmax-map/SKILL.md:22 | :26 `opus_share_pct: 87,`; :22 "the Opus share of Claude output tokens" |
| Codex week 15% used (stage 5) | BUILT | scripts/tm.dom.test.ts:27; skills/tokenmax-map/SKILL.md:22 | :27 `codex_weekly_pct: 15,`; :22 "the last Codex weekly-window reading" |
| Guide (link `#tokenmaxGuide` to /guide/#tokenmax, stage 5) | BUILT | site/guide/index.html:25 | `<h2 id="tokenmax-title">Understand your TokenMax map</h2>` |
| BUILT (plaque); Run the map, share your week (door, stage 6) | BUILT | prototype/tm-journey/FRAMING.md:13 | BUILT: the map (`skills/tokenmax-map/scripts/map.ts`), the share link (map.ts `shareLink`), the shared board (`site/maps/`) |
| DESIGN; Follow the router design (issue 236) (door, stage 6, plain text) | DESIGN | prototype/tm-journey/FRAMING.md:14 and :21 | :14 "DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route (issue 236, open"; :21 "Issue 236 (open): "TokenMax router: Jev on the jobs rules cannot route"." |
| one builder's real week, 16 Oct 2026 (footer) | BUILT | site/tm/index.html:36 | One builder's real week (16 Oct 2026). Run it to see yours. |

## Guidance and notes (not product claims)

- **Native prompt:** the map script and the skill exist (`site/tm/map.ts` is byte-identical to `skills/tokenmax-map/scripts/map.ts` by `cmp` on this tree). Whether Claude Code or Codex follows the prompt to the end is UNTESTED for both (W9, FRAMING.md:26). The W9 reason (the harness refused the headless run) is recorded as given in the round 2 fix brief; `prototype/tm-journey/RESULTS.md` does not exist on this tree.
- **Issue 236:** `gh issue view 236 -R breakoutwithai/jevnotjev` returned OPEN, title "TokenMax router: Jev on the jobs rules cannot route" (2026-10-20). It is about the router; the word "pacing" is the operator's framing (FRAMING.md:7, :14), so no pacing line cites issue 236 alone. The page shows no result, number or chart for the design.
- **"Hit your limit?"** is the audience, not a claim: site/index.html:676 "For people who hit their Claude weekly limit."
- **"working..."** (stage 1) is illustrative. The notice beside it uses the real Claude Code wording from SKILL.md:62, without its reset clause.
- **Copy status** (stage 4) reads "Copied." or "Copy by hand." (page script only, not a product claim); with either, stage 4 measures 16 or 18 words.
- **The people are illustrative** (footer, I4). User 1 shows only the recorded moment from the sample (Wed 14 Oct, 16:20 UTC); no stopped days or timeline are drawn. User 2 shows no number, result or outcome: the gauge and dial carry "DESIGN: pacing" and "in rehearsal, not run" as HTML text.
- **Stage 3 wording** is the round 2 sentence exactly, on screen and in the aria-label; it follows FRAMING.md:27-28: never "nothing leaves your computer", never "only totals".
- **Visitor words** (limit, ran out, week, pacing) come from the person hypothesis in the concept brief, not from a measurement.
- **Not shown, by budget:** the date in stage 5 (stage 1 carries it), "1 short window, 1 unknown" (figure aria-label only), output token counts, 444 helper sessions, the report's proposals, and the first-viewport ask in full (it is verbatim in stage 2).
