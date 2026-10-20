# p5 Before and after: claims (round 3, comic strip)

Every visible line of `index.html` that states a fact, a number or a promise. Sources were read in tree `feat/tm-journey-prototypes` at 467a54f. Status follows `prototype/tm-journey/FRAMING.md:13-14`. A DESIGN row carries no number and no "saves".

| On-screen text | Status | Source (repo-root path:line) | Exact words at that line |
|---|---|---|---|
| Hit your Claude Code limit? (cover) | BUILT | site/index.html:676 | "For people who hit their Claude weekly limit." |
| We're designing a pacing tool. (cover) | DESIGN | prototype/tm-journey/FRAMING.md:6 | "TokenMax is being designed and might be built if there is enough demand." |
| Help us decide if it is worth building: share your week. (cover, beside User 2) | DESIGN | prototype/tm-journey/FRAMING.md:9 | "Ask on screen: \"Help us decide if it is worth building: share your week.\"" |
| Example week (cover control, in-page link to stage 5) | BUILT | prototype/tm-journey/FRAMING.md:13 | "the example (the sample card, `site/tm/index.html:31`)" |
| LIMIT (lit sign, cover and stage 1) | BUILT | site/tm/index.html:87 | "<p><b>2</b> cap hits, Wed 14 Oct 16:20 UTC</p>" |
| DESIGN (stamp, cover and stage 2) | DESIGN | prototype/tm-journey/FRAMING.md:14 | "DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route (issue 236, open; ...)" |
| User 1 ran out: 2 recorded limit hits, Wed 14 Oct from 16:20 UTC. (stage 1) | BUILT | site/tm/index.html:87; site/tm/index.html:49; scripts/tm.dom.test.ts:24 | ":87 \"2 cap hits, Wed 14 Oct 16:20 UTC\"; :49 \"all on 2026-10-14 from 16:20 UTC\"; :24 \"caps: { short: 1, weekly: 0, unknown: 1 },\"" |
| Next, in rehearsal, not run yet (stage 2 banner) | DESIGN | site/tm/index.html:143, :145; prototype/tm-journey/FRAMING.md:14 | ":143 \"Next: #236\"; :145 \"in rehearsal, <span>not run yet</span>\" (the number on that line is not shown); FRAMING:14 \"the words \\\"in rehearsal, not run yet\\\" come from `site/tm/index.html:143-145`\"" |
| User 2: a tool that would pace the week. Not built. (stage 2) | DESIGN | prototype/tm-journey/FRAMING.md:14; issue 236 | "DESIGN: the router, pacing, ..."; `gh issue view 236` read 2026-10-20: state OPEN, title "TokenMax router: Jev on the jobs rules cannot route" |
| The map sends nothing. (stage 3) | BUILT | skills/tokenmax-map/SKILL.md:20 | "The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory, and sends nothing." |
| Your week's totals and a nickname you choose go only when you press Share. (stage 3) | BUILT | skills/tokenmax-map/SKILL.md:22; site/maps/maps.js:387; prototype/tm-journey/FRAMING.md:28 | SKILL:22 "The fields are aggregate counts only ... never reaches a server until you open the page and press Share there. The script itself sends nothing."; maps.js:387 "postJson(\"/api/maps\", { payload: payload, alias: aliasValue, ..."; FRAMING:28 "Say \"your week's totals and a nickname you choose\", never \"only totals\"." |
| BUILT (stamp on the prompt card, stage 4) | BUILT | prototype/tm-journey/FRAMING.md:13 | "BUILT: the map (`skills/tokenmax-map/scripts/map.ts`), the share link (map.ts `shareLink`), the shared board (`site/maps/`), ..." |
| Paste a prompt into Claude Code or Codex (stage 4: "Open Claude Code or Codex, paste this, press Enter.") | BUILT | prototype/tm-journey/FRAMING.md:25-26; skills/tokenmax-map/SKILL.md:10 | FRAMING:26 "The map script and the skill are BUILT. Whether a given agent follows the prompt to the end is TESTED or UNTESTED per tool"; SKILL:10 "The site serves a byte-identical copy of `scripts/map.ts` at https://jevnotjev.breakoutwithai.com/tm/map.ts" |
| Prompt: "... with its --share option, show me the report, and give me the share link it prints." | BUILT | skills/tokenmax-map/SKILL.md:22 | "`--share` also prints the share fields (format tm-share/1) and a link." |
| Prompt: "If Bun is missing, tell me how to install it and wait." | BUILT | skills/tokenmax-map/SKILL.md:20 | "No Bun yet: `curl -fsSL https://bun.sh/install \| bash`." |
| 3,993 sessions (stage 5 card) | BUILT | scripts/tm.dom.test.ts:22 | "sessions: 515 + 3478," |
| 87% big model (stage 5 card) | BUILT | scripts/tm.dom.test.ts:26 | "opus_share_pct: 87," |
| Codex week 15% (stage 5 card) | BUILT | scripts/tm.dom.test.ts:27 | "codex_weekly_pct: 15," |
| 2 recorded limit hits, Wed 14 Oct from 16:20 UTC. (stage 5 caption) | BUILT | site/tm/index.html:87; site/tm/index.html:49 | ":87 \"2 cap hits, Wed 14 Oct 16:20 UTC\"; :49 \"all on 2026-10-14 from 16:20 UTC\"" |
| The card is the sample-card link (`#sampleCard`) | BUILT | site/tm/index.html:31 | the `href="https://jevnotjev.breakoutwithai.com/maps/#m=...&sample"`; `diff` of the two hrefs is empty |
| BUILT: Run the map and share your week (stage 6 door, links to stage 4) | BUILT | skills/tokenmax-map/SKILL.md:14; :22 | ":14 \"Anyone with Bun can map their last 7 days without installing anything\"; :22 \"open the page and press Share there\"" |
| DESIGN: Follow the pacing work, issue 236 (stage 6 door, plain text) | DESIGN | prototype/tm-journey/FRAMING.md:21 | "Issue 236 (open): \"TokenMax router: Jev on the jobs rules cannot route\"." |
| The map guide (`#tokenmaxGuide`, href `/guide/#tokenmax`) | BUILT | site/guide/index.html:25 | "<h2 id=\"tokenmax-title\">Understand your TokenMax map</h2>" |
| Two illustrative users; the figures are one builder's real week, 16 Oct 2026. (footer) | BUILT | site/tm/index.html:36 | "One builder's real week (16 Oct 2026). Run it to see yours." |

Notes, not product claims:

- The native prompt row: map.ts and the skill are BUILT; whether Claude Code and Codex each complete the prompt is recorded by W9 as TESTED or UNTESTED (`FRAMING.md:26`). This prototype did not run the prompt in either agent, so here it is UNTESTED.
- Speech bubbles "working..." and "again?" are illustration, not data. User 1 and User 2 are illustrative; only the sample week's figures are real.
- "1 short window, 1 unknown" is in the stage 5 figure's aria-label only (source `scripts/tm.dom.test.ts:24`); it was cut from visible text to hold the 18-word stage budget.
- Stage 6 door B carries "DESIGN" and "issue 236" but not the full "Next, in rehearsal, not run yet" line: with the two verbatim door texts, the issue and the guide link, the 18-word budget had no room. That phrase is on the stage 2 picture.
- Removed from round 2 as unsourceable or over budget: per-day pills, the three report proposals, output token totals, "444 helper sessions", the shared-board link, the "Only the week's totals go" wording (replaced per `FRAMING.md:28`).
- `FRAMING.md:28` cites `site/maps/maps.js:386` for the alias; in this tree the `alias: aliasValue` send is on line 387.
