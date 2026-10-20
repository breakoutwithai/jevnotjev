# p3 Four questions

A theatre-styled page that puts the plain explanation and the two-person split screen on stage in the first viewport: User 1 hits the limit and stops (the sample's 2 limit hits, Wed 14 Oct from 16:20 UTC), and User 2 is a picture of what we are designing, the same week paced so it is used rather than hit, with no numbers. The one ask, "Help us decide if it is worth building: share your week.", sits with User 2; four questions (tool, plan, when it ran out, how used to typing a command) then rewrite the exact steps, and the map never reads the plan, so the plan answer only changes one reassurance sentence.

Without JavaScript the four questions are a plain list and all six stages, the default steps and the example still read top to bottom.

Status words, on screen and in claims.md: BUILT is the map, the share link, the shared board and the example; DESIGN is the router, pacing and Jev picking the cheaper door (issue 236, "in rehearsal, not run"), always marked "What we are designing" or "Design, not built", with no number and no result. Framing source: prototype/tm-journey/FRAMING.md.

## The six stages as they appear

1. **Arrive in pain:** "Hit your Claude Code or Codex limit again?", what is built today (a map of your own week, nothing leaves until Share, only totals), what we are designing (a tool that would pace your use, might be built if enough people want it), the control "See an example, no setup" (to stage 5), and the split stage: User 1 stops with 2 limit hits; User 2 is "What we are designing", the ask and the button "Share your week". No command, no jargon word, in the first viewport.
2. **Understand what this is:** what the map shows (three tickets), what leaves your computer, what the map does not do, then the dashed "Design, not built" box: the token router, "Next, in rehearsal, not run yet", why weeks are being gathered, TokenMax as one use of Jev.
3. **Decide to try:** the four questions as one-at-a-time ticket choices with Back, Next and "Skip, show the default steps". No command here.
4. **Run it with reassurance:** a plain paragraph of what the line does and what leaves the computer, four steps, the reassurance box, "What you will see", two `<details>` (Bun not found; look back further than a week), and the exact command as the last thing, with a Copy button.
5. **Read your result:** the built example: the sample private report and share card from one builder's real week (87% big model, 15% Codex week, 3,993 sessions); rows matching the tool answer get "Look here first"; the sample card link (site/tm/index.html:31).
6. **Next step:** "Run the map now and share your week" (built; points back to stage 4, the board, the guide) beside "Follow the router work" (design, not built: "Next, in rehearsal, not run yet", no result, no number, issue 236).

## Checks (run 2026-10-20, from the tree root)

- `bun scripts/uat/prototype-shots.ts prototype/tm-journey/p3-four-questions --scroll --full`: jargon none at both sizes, stages 1 to 6, no blocked requests, no page errors.
- `grep -niE 'curl|--share|--days|bun run|terminal'` hits only inside data-stage="4" and the script after stage 6.
- No horizontal scroll at 390 px with or without JavaScript (scrollWidth 390 of 390). Stepper run in Chromium through all four questions: the line gains `--days 30` for "Weeks ago", reassurance changes with the plan, two report rows highlighted for "Claude Code".

## Cost to ship as the real /tm/

Replace `site/tm/index.html` (204 lines) and `site/tm/tm.css` (367 lines) with this page's markup and inline or split styles, and replace `site/tm/tm.js` (235 lines, the scroll story) with the roughly 100 line stepper script here. `scripts/tm.dom.test.ts` (713 lines) is built around the scroll story (curtain, scenes, ticket, wires), so most of it is rewritten: keep the sample-link test (VP-6) and the figure test against `renderShareBlock()`, replace the scene and motion tests with tests of the stepper (answers change the command and the reassurance), the static fallback, the six `data-stage` markers and the rule that the command appears once, last in stage 4. The page makes no remote font request, which also removes the Google Fonts links in today's head. Rough size: one PR of about 750 lines of page, 150 of script, and 300 to 400 lines of test churn. The `/tm/map.ts` copy and its parity test are untouched.
