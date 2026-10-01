---
prompt_id: jnj-stage-theatre-uc13-demo
title: Stage page theatre pass with UC13 stage-door demo
version: 2.0.0
created: 2026-10-01
owner: operator
status: ready-not-run
prompt_type: build
task_class: code
executor:
  model: claude-opus-5-5
  runtime: main session (Chrome MCP screenshots are main-session only)
  effort: high
deliverables:
  - site/index.html (theatre pass: closed curtains, ticket banner, scroll-driven reveal, stage-door note, UC13 demo, easter eggs)
  - site/data.js (new `uc13_demo` block, SAMPLE DATA)
  - scripts/site-content.test.sh (content gate, see Metrics)
  - docs/artifacts/stage-theatre/shot-1440.png and shot-390.png (one per reveal beat at each width)
  - one PR against main, linked to a GitHub issue
scope:
  in:
    - "Opening state: curtains fully closed over the page, with a Broadway-style marquee banner or an entrance ticket (ADMIT ONE, seat, act) centred on the curtain"
    - "Scroll beat 1: curtains part, revealing the Act I ask line with the input EMPTY (no placeholder text)"
    - "Scroll beat 2: the example question writes itself into the line, is struck through in red (screenshot 2), then the Act I dialogue (YOU / JEV!JEV / ASIDE) plays as in screenshot 3"
    - "Scroll beat 3: a stage-door note slides in beside the title (screenshot 4 position); clicking it runs the UC13 shop-bot demo"
    - "UC13 demo: plays 8 messages chosen from the recorded 40-message public run (fact sheet card, three arms answer / hand_off, accept or reject vs the human label), plus the full-run tally with unknown-stock and booking misses reported separately"
    - "Very subtle easter eggs nodding to other challenge projects (no person names)"
  out:
    - "Deploy to jevnotjev.breakoutwithai.com (owned by .deploy/deploy.sh, run separately from a clean origin/main worktree per docs/DEPLOY.md)"
    - "A live Jev call or a real ask input (the page states the live check has not shipped)"
    - "prototype/spa-concepts/* (throwaway concepts; site/ is the live page)"
    - "Producing the UC13 run itself: inputs, runner, labels and records (separate branch and PR per the sibling session's move plan)"
    - "The builder's real-shop run (kept in _reference/, shared only with consent)"
    - "Other acts' content beyond adding easter eggs"
facts:
  - claim: "The live page is the committed site/ folder served as static files"
    source: "docs/DEPLOY.md:3 'The site is the committed `site/` folder, served as static files by nginx'"
  - claim: "site/index.html is the Stage concept promoted to the landing page"
    source: "git log -- site: 5726c8b 'feat: Stage mockup as the jevnotjev landing page'"
  - claim: "Act I markup: section#act1, form#askForm, input#askInput (disabled), div#dialogue"
    source: "site/index.html:427, 433, 435, 440"
  - claim: "Motion is gated on prefers-reduced-motion and IntersectionObserver"
    source: "site/index.html:514-515 and 731-750"
  - claim: "The 'decide if my agent should continue' example carries mark 'Jev could help', why 'Two answers, every turn, cheap', rule 'list of outward actions'"
    source: "site/data.js:681-700"
  - claim: "UC13 decision answer set is answer / hand_off; simple rule is a keyword list"
    source: "docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md:12 and :32"
  - claim: "Test set: one synthetic winter rental shop fact sheet and 40 messages m01 to m40"
    source: "docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md:29-30"
  - claim: "An arm row is accept when its output equals the human label, else reject"
    source: "docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md:62"
  - claim: "Run status 2026-10-01: rule arm run (40 rows; 13 hand_off, 27 answer); Jev arm, LLM arm, labels and verdict not run"
    source: "docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md:77-85"
  - claim: "Public repo rule: tickets and assets never name or quote community members"
    source: "docs/wayfinder/ten-organic-shares/map.md:14"
  - claim: "Operator chose project nods with no person names (2026-10-01, this session)"
    source: "operator answer to the names question: 'Nods, no names'"
depends_on:
  - prompt: "UC13 public run recorded at docs/product/runs/2026-10-01-uc13-shop-bot/ (records.csv, raw.json, result.md) with the synthetic shop in examples/uc13-shop-bot/"
    edge: "the demo renders rows from records.csv; uc13...md:81-84 shows Jev arm, LLM arm and labels not run as of 2026-10-01"
    fallback: "Build everything else (M1-M4, M5, M6); the demo reads a clearly marked SAMPLE DATA placeholder shaped like records.csv; report the demo as blocked on the run"
unverified:
  - claim: "The run folder path docs/product/runs/2026-10-01-uc13-shop-bot/ and examples/uc13-shop-bot/ are final"
    settle_by: "ls of both paths on origin/main at run start"
  - claim: "The fact sheet in the run is the synthetic shop, not the builder's real shop (name, phone, locker code)"
    settle_by: "read examples/uc13-shop-bot/ fact sheet; any real shop detail is a stop"
  - claim: "Screenshot 2 (red strike-through over the example question) is the intended beat between the empty line and the dialogue"
    settle_by: "operator review of the beat-2 screenshot in the PR"
  - claim: "The UC13 community builder is the person the stage-door note is aimed at"
    settle_by: "operator; irrelevant to the build because the note names no one"
constraints:
  - "Never write a person's name from the leaderboard into site/, the PR, the issue or commit messages. Project nods only (map.md:14, operator decision)."
  - "Easter eggs: at most one per act, woven into existing copy, prop or tooltip; no new visible section, no link to a contestant's work, nothing that reads as a joke at a project's expense."
  - "The leaderboard file is outside this public repo; read it, never copy it or quote its rows."
  - "Every UC13 demo number comes from the recorded run's records.csv, labelled '40 messages we wrote about a made-up shop'; no hand-typed result and no claim beyond that run (UC13 'Not established' section). The fallback placeholder carries SAMPLE DATA."
  - "Never use the builder's real shop name, phone number or locker code anywhere in site/; if the run inputs contain them, stop."
  - "prefers-reduced-motion: curtains start open, no typewriter, demo results render immediately."
  - "Keyboard and screen reader: the ticket/curtain never traps focus; a visible 'Skip the overture' control opens the curtains; the stage-door note is a button with an accessible name."
  - "No horizontal scroll at 390px or 1440px; light and dark themes keep working; no em or en dash glyphs (use &mdash; entity only if needed)."
  - "Vanilla HTML/CSS/JS, no new dependencies, Google Fonts only external request."
  - "Tests assert behaviour and content; do not hard-code values to pass them (G11)."
  - "Code change: own worktree from fresh origin/main via `wt new feat/stage-theatre --task-kind code --slug stage-theatre`, feature branch, PR."
metrics:
  - id: M1
    name: Person names from the leaderboard present in site/
    baseline: "0"
    target: "== 0"
    measure: "scripts/site-content.test.sh: extracts the Builder column from the leaderboard at runtime and greps site/ case-insensitively; prints the count checked (> 0) and the hit count"
  - id: M2
    name: Reveal beats reachable by scroll
    baseline: "0 of 4 (page opens on Act I)"
    target: ">= 4/4 (closed curtain + ticket, empty line, struck example + dialogue, stage-door note)"
    measure: "Chrome MCP at 1440x900: screenshot after each scroll step; each beat's element visible per getBoundingClientRect"
  - id: M3
    name: UC13 demo rows matching records.csv
    baseline: "0"
    target: "8 rows rendered, each arm's answer and accept/reject equal to records.csv for that message (8/8); tally totals equal records.csv over all 40"
    measure: "scripts/site-content.test.sh: reads records.csv and the uc13_demo block in site/data.js, prints rows compared and mismatches"
  - id: M4
    name: Horizontal overflow at 390px and 1440px
    baseline: "0 px (current page)"
    target: "== 0 px at both widths, at every beat"
    measure: "document.documentElement.scrollWidth - innerWidth via javascript_tool"
  - id: M5
    name: Em/en dash glyphs in site/
    baseline: "0"
    target: "== 0"
    measure: "scripts/site-content.test.sh grep for U+2013 and U+2014 in site/"
  - id: M6
    name: Easter eggs placed
    baseline: "0"
    target: ">= 3 and <= 5, each listed in the PR body with its location"
    measure: "PR body table of nod / project it references / file:line"
changelog:
  - version: 2.0.0
    date: 2026-10-01
    change: "Demo reads the recorded UC13 public run (8 of 40 shown) instead of invented sample data; facts re-pointed to the updated UC13 (answer / hand_off); depends_on the run; real-shop details banned"
tags: [jevnotjev, site, theatre, uc13, prototype]
reuse:
  - path: "~/.agents/skills/wt/scripts/wt.sh"
    use: "create the worktree"
  - path: "frontend-design:frontend-design skill"
    use: "design direction for the marquee/ticket so it does not read as templated"
  - path: "responsive-design-review skill"
    use: "390px and 1440px check before the PR"
  - path: "multi-hat-pr-review skill (/mh)"
    use: "PR readiness gate after create"
sources:
  primary:
    - "site/index.html, site/data.js (read 2026-10-01)"
    - "docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md"
    - "/Users/breakout/projects/30-day-challenge/_reference/community/leaderboard-d07.md (private, outside repo)"
    - "/private/tmp/claude-501/-Users-breakout-projects-jevnotjev/0d0b09a7-3b79-476a-828e-9b31e23afb6c/images/1.png to 4.png (operator screenshots; may be gone, ask if unreadable)"
  secondary:
    - "prototype/spa-concepts/BRIEF.md (technical rules the Stage concept was built under)"
    - "docs/DEPLOY.md"
operator_decisions:
  - decision: "Stage-door note copy"
    default: "\"Running a shop bot? Step through the stage door.\" (no name)"
  - decision: "Ticket vs marquee as the opening prop"
    default: "Entrance ticket (ADMIT ONE / Act I / Seat J-EV) pinned on the closed curtain, marquee bulbs around the title strip"
  - decision: "Merge"
    default: "await an explicit instruction naming the PR unless a session grant is active (rule 08)"
prompting_notes: [G1, G2, G4, G5, G6, G11, G12, G14, G15, C1, C2, C3]
---

# Stage page theatre pass with UC13 stage-door demo

## Goal
The landing page at jevnotjev.breakoutwithai.com is a five-act play you scroll through, but it opens straight on Act I with everything visible, so there is no overture and nothing rewards scrolling. Make the opening feel like taking a seat: curtains closed with a ticket or marquee, scroll to raise them, watch the question get asked and answered, then a stage-door note invites a shop-bot builder into a short UC13 demo. Small nods to other projects in the 30 Day Challenge reward people who know the cohort, without naming anyone, because this repo and site are public and must not name community members.

## Read first
1. `site/index.html` - the live page; Act I is lines 427-445, motion gating 514-515, lighting cues 731-750.
2. `site/data.js` - `ask_examples` (681-700) and the existing SAMPLE DATA conventions.
3. `docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md` - the decision, arms, simple rule and accepted-result rule the demo dramatises.
4. `/Users/breakout/projects/30-day-challenge/_reference/community/leaderboard-d07.md` - project names for the nods; person names are for the M1 test only.
5. The four screenshots in `sources.primary` - the opening layout, the struck-through example, the dialogue, and the stage-door note position (top right of the title block).
6. `prototype/spa-concepts/BRIEF.md` technical rules section.

## Steps
| M | Capability | Evidence that closes it |
|---|---|---|
| 1 | Issue + worktree | `gh issue view <n>` open; `git -C <wt> rev-parse --abbrev-ref HEAD` = `feat/stage-theatre`, base = `origin/main` SHA |
| 2 | RED content gate | `scripts/site-content.test.sh` written; run against a temp copy of site/ with a planted leaderboard name and a planted U+2014, exits non-zero naming both; checked count > 0 |
| 3 | Overture | page loads with curtains closed and the ticket/marquee; "Skip the overture" opens them; reduced-motion loads open. Screenshot beat 1 at both widths |
| 4 | Scroll reveal | curtains part on scroll to an empty ask line; example writes in, red strike-through, dialogue plays. Screenshots beats 2-3 |
| 5 | Stage-door note + UC13 demo | note appears on scroll beside the title (stacks below it at 390px); click plays the demo: fact sheet card, 8 of the 40 messages one by one (include at least one rule-word answerable case and one no-rule-word hand_off case from uc13...md:30), three arm answers with accept/reject, then the 40-message tally with unknown-stock and booking misses separate. `uc13_demo` in data.js is generated from records.csv, not typed. M3 8/8 |
| 6 | Easter eggs | 3-5 nods placed per constraints; listed in the PR body |
| 7 | Gate + PR | content gate GREEN with counts; M2-M5 measured; PR opened; `/mh <PR>` run |

Easter-egg shape, for direction only (pick your own from the leaderboard projects): a seat number or row on the ticket, a line in the programme notes, an understudy credit, a prop on the curtain call, a tooltip on House lights. Each should read as natural theatre copy to someone outside the cohort.

## Autonomy and stop conditions
- Proceed without asking: worktree, branch, edits to the deliverables, local tests, screenshots, issue and PR creation.
- Confirm first: any deploy, any merge without a session grant, any change outside `site/`, `scripts/site-content.test.sh` and `docs/artifacts/stage-theatre/`.
- Stop and report only when: the screenshots are unreadable and the beat order cannot be settled from this prompt, or the leaderboard file is missing.
- Do not stop after a summary or offer to continue; finish every milestone, then report (C3).
- Scope rule: pre-existing problems outside scope are reported as follow-ups, not fixed.

## Output
A report with: issue and PR links, branch and head SHA, the metrics table filled with measured numbers, the easter-egg table (nod, project referenced, file:line), screenshot paths, and the open operator decisions with the defaults used.

## Metrics
| ID | Name | Baseline | Target | How measured |
|---|---|---|---|---|
| M1 | Leaderboard person names in site/ | 0 | == 0 | site-content.test.sh, checked count > 0 |
| M2 | Reveal beats reachable by scroll | 0/4 | >= 4/4 | Chrome MCP screenshots + bounding rects |
| M3 | UC13 demo rows matching records.csv | 0 | 8/8, tally equals 40-row totals | site-content.test.sh |
| M4 | Horizontal overflow | 0 px | == 0 px at 390 and 1440, every beat | scrollWidth - innerWidth |
| M5 | Em/en dashes in site/ | 0 | == 0 | site-content.test.sh |
| M6 | Easter eggs placed | 0 | 3 to 5, tabled | PR body |

## Definition of done
- [ ] `scripts/site-content.test.sh` failed on the planted name and dash (RED seen), then passes on site/ with names checked > 0 and 0 hits
- [ ] Screenshots exist for all 4 beats at 1440x900 and 390 wide under `docs/artifacts/stage-theatre/`
- [ ] Reduced-motion load verified: curtains open, demo renders without animation (screenshot)
- [ ] UC13 demo: 8/8 rows and the 40-row tally match records.csv (or, if the run is absent, the fallback is in place and the demo is reported blocked)
- [ ] M4 == 0 px at both widths at every beat
- [ ] `grep -ri` for every leaderboard person name across the PR title, body, issue and commit messages returns 0
- [ ] PR open against main with the easter-egg table; `/mh` gate result posted on the head SHA
- [ ] Every metric reported as a number against its target
- [ ] Every `unverified` item resolved or restated with what settles them
