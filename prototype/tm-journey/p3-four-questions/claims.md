# Claims behind the p3 picture-card story

Tree: /Users/breakout/projects/jevnotjev-wt/20261020-tm-journey-prototypes, branch feat/tm-journey-prototypes. Source paths are relative to the tree root. Status: BUILT exists on origin/main (the map, the share link, the shared board, the sample card, the guide). DESIGN is the pacing tool (issue 236, "in rehearsal, not run yet"); a DESIGN row carries no number and no "saves".

| On-screen text | Status | Source (path:line) | Exact words at that line |
|---|---|---|---|
| We are designing a tool that paces it. (stage 1 caption) | DESIGN | prototype/tm-journey/FRAMING.md:6-7 | ":6 TokenMax is being designed and might be built if there is enough demand."; ":7 \"a token router that saves you from hitting weekly limits\". This line is DESIGN" (page says "paces", never "saves") |
| DESIGN (tag on the dial, stage 2) | DESIGN | prototype/tm-journey/FRAMING.md:14 | "DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route (issue 236, open ..." |
| Next, in rehearsal, not run yet (stage 2 ribbon, stage 6 caption) | DESIGN | prototype/tm-journey/FRAMING.md:14; site/tm/index.html:143-145 | "the words \"in rehearsal, not run yet\" come from `site/tm/index.html:143-145`"; html line 143 `Next: #236`, line 145 `47 jobs in rehearsal, <span>not run yet</span>` (the 47 is not used) |
| A gauge that fills slowly and a dial (User 2 picture, stage 2) | DESIGN | prototype/tm-journey/FRAMING.md:7, :14 | Pacing is DESIGN. The gauge carries no figure and no label, and the loop is decoration, not output |
| Help us decide if it is worth building: share your week. (stage 2 caption) | BUILT (the share is the map plus the link) | prototype/tm-journey/FRAMING.md:9 | "Ask on screen: \"Help us decide if it is worth building: share your week.\"" |
| The map sends nothing. (stage 3) | BUILT | skills/tokenmax-map/SKILL.md:20, :22 | ":20 ... and sends nothing."; ":22 The script itself sends nothing." |
| Only Share sends your week's totals and a chosen nickname. (stage 3) | BUILT | skills/tokenmax-map/SKILL.md:22; site/maps/maps.js:380, :387; prototype/tm-journey/FRAMING.md:28 | ":22 The link carries the fields after `#m=`, a part of the address that never reaches a server until you open the page and press Share there."; maps.js line 380 `the alias must be 3 to 24 lowercase letters, digits or hyphens.`, line 387 `postJson("/api/maps", { payload: payload, alias: aliasValue, ...`; FRAMING line 28 "Say \"your week's totals and a nickname you choose\", never \"only totals\"" (the brief cites maps.js:386, which is the `mapNotSent` hide; the alias send is line 387) |
| Chip "Map sends nothing." (stage 4 default) | BUILT | skills/tokenmax-map/SKILL.md:20 | "... and sends nothing." |
| Chip "Reads both histories." (Tool card) | BUILT | skills/tokenmax-map/SKILL.md:20; skills/tokenmax-map/scripts/map.ts:847-848 | ":20 The script reads the Claude Code and Codex logs in your home folder"; line 847 `claude: src("--claude", join(env.home, ".claude", "projects")),`, line 848 `codex: src("--codex", join(env.home, ".codex", "sessions")),` |
| Chip "Plan not read." (Plan card) | BUILT | skills/tokenmax-map/scripts/map.ts:690-708 | SharePayload lists v, skill, days, sources, sessions, subagent_sessions, caps, output_tokens, opus_share_pct, codex_weekly_pct; no plan field |
| Chip "Shows recorded hits." (Day card) | BUILT | skills/tokenmax-map/scripts/map.ts:585; skills/tokenmax-map/SKILL.md:72 | line 585 `## Limits` table with `Short`, `Weekly`, `Unknown` columns; SKILL.md line 72 "The default metadata mode can miss limits recorded only in message text." (hence "recorded") |
| Chip "It explains first." (Prompt card) | BUILT (the prompt asks for it); agent compliance UNTESTED | prototype/tm-journey/FRAMING.md:25 | "that agent reads `skills/tokenmax-map/scripts/map.ts` ..., says what it reads and sends, runs it on their computer, shows the report and gives the share link" |
| Paste a prompt into Claude Code or Codex (native prompt route, stage 4) | BUILT because map.ts and the skill exist. Whether each agent completes the prompt is recorded by W9 as TESTED or UNTESTED per tool; this prototype is UNTESTED (no RESULTS.md exists in the tree) | prototype/tm-journey/FRAMING.md:25-26; skills/tokenmax-map/SKILL.md:17 | ":26 The map script and the skill are BUILT. Whether a given agent follows the prompt to the end is TESTED or UNTESTED per tool"; SKILL.md line 17 is the one-line command the prompt replaces |
| Open Claude Code or Codex, paste this, press Enter. (stage 4) | BUILT | prototype/tm-journey/FRAMING.md:25 | "Stage 4 offers one plain prompt to paste into the Claude Code or Codex they already use" |
| Copy the prompt; See the prompt; the prompt text (stage 4) | BUILT | prototype/tm-journey/FRAMING.md:25; site/tm/index.html:190; skills/tokenmax-map/SKILL.md:20, :22 | html line 190 is the link "the script, readable" to /tm/map.ts (the map is served there); SKILL.md line 22 "`--share` also prints the share fields (format tm-share/1) and a link"; line 20 "No Bun yet: ..." (the prompt's Bun line) |
| 2 recorded limit hits, Wed 14 Oct, 16:20 UTC (stage 5 caption) | BUILT | site/tm/index.html:87, :49; scripts/tm.dom.test.ts:24 | html line 87 `<p><b>2</b> cap hits, Wed 14 Oct 16:20 UTC</p>`; line 49 "all on 2026-10-14 from 16:20 UTC (line 39)"; test line 24 `caps: { short: 1, weekly: 0, unknown: 1 },` (page says "recorded limit hits") |
| 1 short window, 1 unknown (stage 5 picture, one solid and one dashed hit, spoken in the aria-label and not printed) | BUILT | scripts/tm.dom.test.ts:24 | `caps: { short: 1, weekly: 0, unknown: 1 },` |
| 3,993 sessions (stage 5) | BUILT | scripts/tm.dom.test.ts:22; site/tm/index.html:123 | test line 22 `sessions: 515 + 3478,`; html line 123 `<dt>Sessions</dt><dd>3,993</dd>` |
| 87% big model (stage 5; the aria-label says "of Claude output") | BUILT | scripts/tm.dom.test.ts:26; site/tm/index.html:98 | test line 26 `opus_share_pct: 87,`; html line 98 `<p><b>87%</b> of Claude output, Opus-class</p>` |
| Codex week 15% (stage 5; the aria-label says "used") | BUILT | scripts/tm.dom.test.ts:27; site/tm/index.html:109 | test line 27 `codex_weekly_pct: 15,`; html line 109 `<p><b>15%</b> of the Codex week used</p>` |
| The sample card link (stage 5 card) | BUILT | site/tm/index.html:31 | `href="https://jevnotjev.breakoutwithai.com/maps/#m=eyJ2Ijoi...&sample"`, copied byte for byte (checked with grep -F) |
| Guide (stage 5 link, #tokenmaxGuide) | BUILT | site/guide/index.html:25; site/tm/index.html:194 | guide line 25 heading text "Understand your TokenMax map"; tm line 194 `<a id="tokenmaxGuide" class="guide-link" href="/guide/#tokenmax">` |
| Run the map and share your week (stage 6 door) | BUILT | prototype/tm-journey/FRAMING.md:13 | "BUILT: the map (`skills/tokenmax-map/scripts/map.ts`), the share link (map.ts `shareLink`), the shared board (`site/maps/`)" |
| Follow the pacing work, #236 (stage 6 door, no link) | DESIGN | prototype/tm-journey/FRAMING.md:21 | "Issue 236 (open): \"TokenMax router: Jev on the jobs rules cannot route\"." (no public page to follow is sourced, so the door is not a link) |
| The numbers are one builder's real week (footer) | BUILT | site/tm/index.html:130 | `<p class="note">One builder's real week, 16 Oct 2026.</p>` |

## Not product claims

- Hit your Claude limit again? (stage 1 headline), the LIMIT sign, the empty meter, the work stopped mid-sentence and the lit sign are illustration. Only the recorded hits in stage 5 are sample figures.
- Tool, Plan, Day, Prompt (card captions) are the four questions. The Plan card changes one reassurance chip only ("Plan not read."). Nothing is plan-specific.
- The two weeks are illustrative (footer, I4). No person is quoted; no testimonial, no user counts.
- User 2's gauge and dial loop under prefers-reduced-motion no-preference only. They carry no number, no saving and no result.
- The chip sits in stage 4, not stage 3, so stage 3 stays at 18 words with the required privacy sentence. Tapping a card changes only that line.

## Removed or not shown

- The "1 short window, 1 unknown" split is not printed (the 18-word stage 5 budget). It is drawn (solid and dashed hit) and spoken in the aria-label.
- No proposals, "live TokenMax band", cost, savings, runtime promise, "free" for Bun, "every limit hit" or 444 helper sessions appear.
- Door B has no link because no public follow page exists in the sources.
- "A nickname you choose" is shortened to "a chosen nickname" to fit 18 words in stage 3.
