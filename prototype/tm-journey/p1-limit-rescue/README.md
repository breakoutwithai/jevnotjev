# p1 Limit-hit rescue

The page opens on the moment of pain: User 1 stops mid-task at the limit, with the real cap-hit time from one builder's week, and beside them User 2 shows what TokenMax is being designed to do (the same week, paced), marked "Design, not built" and carrying the one ask: "Help us decide if it is worth building: share your week." The real figures live in the example the visitor can open (stage 5), and the command waits until the last line of stage 4.

Files: `index.html` (self-contained, offline), `claims.md` (every on-screen number and promise with its status, BUILT or DESIGN, and its source line), `shot-390x844.png`, `shot-1440x900.png`, and the two after-one-scroll shots written by `prototype-shots.ts --scroll`.

## The six stages, as they appear

1. **Arrive in pain** (`#pain`, at least one screen tall): marquee "Your limit ran out mid-task", one plain sentence (TokenMax is a tool we are designing that would pace your Claude Code and Codex use so you do not hit your weekly limit; not built yet), then the split stage. Left, User 1 "today": "You've hit your limit", 2 limit hits, Wed 14 Oct from 16:20 UTC, and a link to the example week. Right, User 2, "Design, not built", "What we are designing": the same week, paced, no numbers, nothing has run; the ask button. Below: the map is made on your own computer and sends nothing, only totals leave when you press Share; a "Built today" line (map, share link, board, example); the illustrative-weeks note.
2. **Understand what this is** (`#what`): "Jev is the product: TokenMax is one use of it"; three doors: the router (Design, not built, issue 236, in rehearsal, not run), the map (Built today), the share link and the board (Built today); why your week matters; what the map shows and does not.
3. **Decide to try** (`#try`): "Should you share your week?", an Admit One ticket, what it asks of you, what stays yours, and a link to the example. No command, no tool names.
4. **Run it with reassurance** (`#run`): "Make your map": what the line does and what leaves, in plain words; three details controls (no Bun yet, more than a week, read it first); then "Open a terminal...", a Copy button, and the command as the last element.
5. **Read your result** (`#example`, Built today): a cream playbill of the example week laid out like `private-report.md` (Limits, Claude Code, Codex, helper work, Proposals (not measured savings), Not covered) and the sample card link from `site/tm/index.html:31`.
6. **Next step** (`#next`): the ask again, then two ways forward: run the map now and share your week (Built today), or follow the router work (Design, not built).

## Cost to ship as the real /tm/

What would change in `site/tm`: `index.html` is replaced by this page's markup. The page uses `../page.css` for the house tokens, so the inline token block shrinks to the few `tm.css` additions. `tm.css` drops the scroll-story rules (the sticky 900vh track, the curtain halves, the `.motion .intro` hiding at line 49) and gains the hero, split, status badge, details, playbill, ticket and command rules from this file (about 210 lines in place of today's 367). `tm.js` is reduced to the copy button, about 20 lines in place of today's 235-line scroll engine. The web-font `<link>` can stay on the real page; this prototype only uses local fallbacks because it must load nothing.

Tests touched: `scripts/tm.dom.test.ts` asserts the scroll story (terminal lines, `#openCard`, `#term .bar`, `#sceneB`, two `a[href="/maps/"]` links, motion and reduced-motion runs). Most of those selectors go away, so the file is rewritten around this page: six `data-stage` sections in order, a jargon-free first viewport at 390 and 1440, no command text before stage 4 and the command as stage 4's last element, the sample link equal to `shareLink(REAL)` plus `&sample`, the command text equal to SKILL.md's line, a "Design, not built" badge on every router or pacing block with no digits inside it except the issue id, and no horizontal scroll at 390. `scripts/uat/prototype-shots.ts` can be pointed at `site/tm` as an extra gate. Any site-wide link or OG test that reads `/tm/` titles needs its expected strings updated.

Rough size: one PR, about 460 changed lines in `site/tm` plus about 260 in the rewritten DOM test; no change to `skills/tokenmax-map` or the map script.
