# TokenMax framing for the journey prototypes (operator, 2026-10-20)

This file records the operator's product framing so that every prototype's `claims.md` can cite it by line. It is a statement of intent, not evidence that anything beyond the BUILT list exists.

1. Jev is the product. TokenMax is one use case of Jev and the flagship example for Jev!Jev.
2. TokenMax is being designed and might be built if there is enough demand.
3. One line: "a token router that saves you from hitting weekly limits". This line is DESIGN: no prototype says "saves" in the present tense.
4. Through jevnotjev, TokenMax is gathering data from willing participants.
5. The visitor is invited to do one thing: contribute their own week (the map, built today) to help decide whether the router gets built. Ask on screen: "Help us decide if it is worth building: share your week."

## Status words (every claim line in claims.md carries one)

- BUILT: the map (`skills/tokenmax-map/scripts/map.ts`), the share link (map.ts `shareLink`), the shared board (`site/maps/`), the example (the sample card, `site/tm/index.html:31`).
- DESIGN: the router, pacing, Jev picking the cheaper door for the jobs the rules cannot route (issue 236, open; the words "in rehearsal, not run yet" come from `site/tm/index.html:143-145`, not from the issue). A DESIGN line never carries a number or a result.

## Supporting sources in the repo

- `FLOW.md:12`: "Flagship use case: TokenMax, more accepted results from the same token budget."
- `site/index.html:676`: "For people who hit their Claude weekly limit."
- `skills/tokenmax-map/SKILL.md:95`: compare only summaries participants "approved for this audience and purpose".
- Issue 236 (open): "TokenMax router: Jev on the jobs rules cannot route".

## How the visitor runs the map (operator Amendment 3, 2026-10-20)

- The visitor never sees a shell command. Stage 4 offers one plain prompt to paste into the Claude Code or Codex they already use; that agent reads `skills/tokenmax-map/scripts/map.ts` (served at `/tm/map.ts`), says what it reads and sends, runs it on their computer, shows the report and gives the share link, and sends nothing itself.
- The map script and the skill are BUILT. Whether a given agent follows the prompt to the end is TESTED or UNTESTED per tool, recorded in each `claims.md` and in `RESULTS.md` (work item W9).
- The agent is itself a cloud model: `skills/tokenmax-map/SKILL.md:24` says "a desktop assistant itself may use a cloud model. Do not promise that loading a transcript into the assistant keeps its contents on-device." So no prototype says "nothing leaves your computer"; the claim that holds is that the map sends nothing and the week's totals go only when the visitor presses Share.
- What Share sends: the week's totals (the tm-share/1 fields, `skills/tokenmax-map/scripts/map.ts:696-708`) and a short alias the visitor types on the board page (`site/maps/maps.js:386`). Say "your week's totals and a nickname you choose", never "only totals".
