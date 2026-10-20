You are grading answers from a usability study against a fixed answer key. You do not see the pages, only the answers. Grade each question 0 or 1 strictly by the key. Do not open any file; everything you need is below.

Questions:
Q1 What is this, and what does it give me?
Q2 Who is it for?
Q3 What do I do next?
Q4 Is it safe to try, and what leaves my machine?
Q5 How does User 1's week differ from User 2's, and which half exists today?
Q6 (glance test, from the six stage pictures and captions only) What story do these pictures tell?

Answer key:
- **Q1 = 1** when the answer names both (a) TokenMax as a token router (or tool) that is being designed, not yet built, to keep the visitor from hitting weekly limits, and (b) that it asks people to share their week (or gathers weeks from willing people) to decide whether it is worth building. An answer that describes the router as working today scores 0. Source: `prototype/tm-journey/FRAMING.md` lines 5 to 9 (operator framing, Amendment 2) and issue 236 (open: the router run is planned, not run).
- **Q2 = 1** when the answer says people who use Claude Code or Codex on their own computer. Naming the limit-hit situation is enough if it names one of those tools. Generic "developers" or "AI users" scores 0.
- **Q3 = 1** when the answer says the next thing to do is paste a prompt into Claude Code or Codex (the tool the visitor already uses), for example to map or share their week. Opening an example alone, "scroll" or "learn more" scores 0. Source: operator Amendment 3 (2026-10-20), recorded in `FRAMING.md`; the prompt runs `skills/tokenmax-map/scripts/map.ts`.
- **Q4 = 1** when the answer states all of: (a) the map runs on the visitor's own computer and sends nothing by itself; (b) sharing is optional, a separate choice; (c) what leaves the machine when they do share: only totals or counts for the week. Source, `skills/tokenmax-map/SKILL.md` line 20: "The script reads the Claude Code and Codex logs in your home folder, writes the two reports into a new folder in the current directory, and sends nothing." Source, line 22: "The fields are aggregate counts only" and "The link carries the fields after `#m=`, a part of the address that never reaches a server until you open the page and press Share there. The script itself sends nothing." "not stated" scores 0.
- **Q5 = 1** when the answer states all three: User 1 stops (runs out) at the limit; User 2 is what the router is meant to do, a design that is not built; what exists today is the map the visitor can run and share. An answer that treats User 2's pacing as working, or that cannot say which half exists, scores 0. Source: `prototype/tm-journey/FRAMING.md` lines 13 to 14 (BUILT and DESIGN) and issue 236.
- **Q6 = 1** under the Q5 key applied to the glance answer: User 1 stops at the limit; User 2 is pictured pacing the week as a design that is not built; and the pictures carry the ask to share a week. All three are needed.

Answers (id = reader-prototype):
### R1-A
Q1: A pacing tool for Claude usage limits that is still being designed; the only concrete offer on screen is a link to map your Claude Code or Codex week with one prompt.
Q2: People who hit their Claude limit, specifically Claude Code or Codex users.
Q3: Press 'See sample', or follow the 'Map your Claude Code or Codex week with one prompt' link.
Q4: not stated
Q5: The page never names User 1 or User 2; after one scroll it shows a timeline of a past week with recorded limit hits (Wed 14 Oct: 2 hits) beside a gauge labelled 'DESIGN in rehearsal, not run', so the recorded-week map appears to exist and the pacing gauge does not.
Q6: You keep slamming into a usage limit on your laptop, so this tool replays your week on a timeline and pinpoints when the limit hits happened (e.g. 2 on Wed 14 Oct), with a usage gauge that is only a design and has not been run. You run it by pasting a prompt into Claude Code or Codex; the map stays on your machine and only a Share button sends your week's totals under a nickname. A sample week shows the kind of numbers you get (2 limit hits, 3,993 sessions, 87% big-model output, Codex 15% used), and the last picture separates what is built today (run the map, share your week) from a router that is still a design (issue 236).

### R1-B
Q1: A single prompt that maps your Claude Code and Codex week; the makers also ask whether a pacing feature, shown as DESIGN 'in rehearsal, not run', is worth building.
Q2: People who use Claude Code and Codex.
Q3: Press 'Example week'.
Q4: not stated
Q5: User 1 runs out and hits the limit (2 recorded limit hits, Wed 14 Oct from 16:20 UTC), while the second figure is paced by a gauge marked 'DESIGN, Pacing, in rehearsal, not run yet'; User 1's recorded week is the half that exists today and the paced week is only a design.
Q6: A developer is working along happily until the meter empties and they hit LIMIT again (2 limit hits on Wed 14 Oct); a pacing feature that would prevent this is only a design, and they ask you to share your week to help decide whether to build it. The working part today is a map you run by pasting a prompt into Claude Code or Codex; it stays on your laptop and only Share sends your week's totals with a nickname, producing a sample-week card (3,993 sessions, 87% big-model output, Codex 15% used). The ending splits what you can do now (share your week, read the map guide) from what is still a design (a router, issue 236).

### R1-C
Q1: Something called Jev!Jev that maps your Claude week from one prompt; a pacing gauge beside it is marked DESIGN, 'in rehearsal, not run', and they ask whether pacing is worthwhile.
Q2: Not stated directly; 'your Claude week' implies Claude users.
Q3: Click the 'Example' link at the top right.
Q4: not stated
Q5: The page never names User 1 or User 2; the first screen shows a person at a laptop with a nearly empty battery beside a pacing gauge stamped DESIGN, 'in rehearsal, not run', and the next screen adds only that pacing is DESIGN and the map sends nothing, so I infer the mapped week exists and the paced week does not.
Q6: Someone at a laptop with a nearly empty battery-style meter sees a pacing gauge that is only a design, not yet run, and the page asks you to share your week to help decide whether pacing is worth building. You paste a prompt into Claude Code or Codex to produce a private map of your usage (it sends nothing; only Share sends totals and a nickname), and you get a receipt-like sample week (3,993 sessions, 2 limit hits, 87% big-model output, Codex 15% used). It ends with two doors: one built (run the map, share your week) and one still a design (a router, issue 236).

### R1-D
Q1: For people who hit their limit: one prompt maps your Claude Code and Codex week; a pacing feature is shown as 'DESIGN: pacing, in rehearsal, not run'.
Q2: People who hit their limit in Claude Code and Codex.
Q3: Open the '(example)' link, or share your week via 'Help decide: share your week.'
Q4: not stated
Q5: The page never names User 1 or User 2; one person works until 'You've hit your limit' (Wed 14 Oct, 16:20 UTC) while the other is paced by a gauge, and after the scroll the limit-hit side is tagged BUILT and the pacing side DESIGN, so the mapped limit-hit week exists today and pacing does not.
Q6: You are mid-task when the screen says "You've hit your limit" (Wed 14 Oct, 16:20 UTC); a built usage dashboard exists, while a pacing feature is only a design and you are asked to share your week to help decide whether to build it. You paste a prompt into Claude Code or Codex to get a usage map that stays locked on your machine, with only Share sending your week's totals and a nickname, and a sample week shows 2 limit hits, 3,993 sessions, 87% big-model output and Codex 15% used. It closes on an open built door (run the map, share your week) beside a scaffolded design still in rehearsal (the router, issue 236).

### R1-E
Q1: A single prompt that maps your Claude Code and Codex week; a pacing tool shown beside it is labelled DESIGN, 'in rehearsal, not run'.
Q2: People who use Claude Code and Codex.
Q3: Press 'Example'.
Q4: not stated
Q5: The page never names User 1 or User 2; the first screen shows a person at a laptop with an empty gauge and an alert sign, and after the scroll a paced gauge is tagged DESIGN, 'Next, in rehearsal, not run yet', so I infer the limit-hit week is what can be mapped today and the paced week is only a design.
Q6: Someone at a laptop on stage watches a meter run low under a warning sign, and a pacing tool meant to help is only a design, so the page asks you to share your week to help decide whether it is worth building. You pick questions about your usage and paste a prompt into Claude Code or Codex to run a map that stays locked on your machine, with only Share sending your week's totals and a nickname; a sample week shows 2 limit hits, 3,993 sessions, 87% big-model output and Codex 15% used. It ends with two doors: the built one (run the map, share your week) and a design still in rehearsal (the router, issue 236).

### R3-A
Q1: A pacing tool being designed, with a sample to view. The page also offers to map my Claude Code or Codex week with one prompt.
Q2: People who have hit their Claude limit and people using Claude Code or Codex.
Q3: Press “See sample” or follow “Map your Claude Code or Codex week with one prompt.”
Q4: not stated
Q5: The difference between User 1 and User 2 is not stated. One view shows two recorded limit hits and another is labelled “DESIGN in rehearsal, not run”; which half exists today is not stated.
Q6: I’ve hit a usage limit, and this product offers a map of my week to show where my Claude Code or Codex usage went and whether I have capacity left elsewhere. I run it by pasting something into my coding assistant, then choose whether to share my weekly totals and a nickname. The map is available now, but the router that might help me use that spare capacity is still a design, not something running.

### R3-B
Q1: One prompt maps your Claude Code and Codex week. What the map contains is not stated.
Q2: People who use Claude Code and Codex.
Q3: Open “Example week.”
Q4: not stated
Q5: User 1 ran out, with two recorded limit hits on Wed 14 Oct from 16:20 UTC; the other half shows pacing in rehearsal, without an actual User 2 result. The map and sharing exist today; pacing is design, not run yet.
Q6: I keep hitting usage limits, and this page offers a way to map my Claude Code and Codex usage by pasting something into either tool. The map stays private unless I choose to share my week's totals and a nickname, which helps them decide whether to build a pacing or routing tool. The usage map and sharing are built, but the tool that might help prevent limits is still only a design.

### R3-C
Q1: It offers to map your Claude week with one prompt. What the map gives me is not stated.
Q2: not stated
Q3: There is an Example link. How to run the map is not stated.
Q4: not stated
Q5: The difference between User 1's and User 2's weeks is not stated. Pacing is marked DESIGN and described as potentially worth building; which half exists today is not stated.
Q6: They’re asking me to run a usage map in Claude Code or Codex to see my week’s activity, limit hits, and how much I use each tool. The map keeps things local unless I choose to share my totals and a nickname, helping them decide whether to build something that paces or routes my usage. The mapping tool is built, but the pacing/router idea is still a design.

### R3-D
Q1: One prompt maps my Claude Code and Codex week. What the map contains is not stated.
Q2: Claude Code and Codex users who hit usage limits.
Q3: Share my week to help decide, or open the example. How to run the prompt is not stated.
Q4: not stated
Q5: How User 1's week differs from User 2's is not stated. The left half is labelled BUILT; the right half is DESIGN pacing, in rehearsal, not run.
Q6: You hit a usage limit mid-work, and this product offers a tool you can run in Claude Code or Codex to map your week’s usage and limit hits. The map stays private unless you choose to share your totals and a nickname, helping them decide whether to build a pacing or routing feature. The mapping tool is built, but the feature meant to help manage those limits is still only a design.

### R3-E
Q1: A way to map your Claude Code and Codex week with one prompt. What the map contains is not stated.
Q2: People who use Claude Code and Codex.
Q3: Press “Example.”
Q4: not stated
Q5: The difference between User 1's and User 2's weeks is not stated. The pacing tool is labelled DESIGN and “in rehearsal, not run”; which half exists today is not stated.
Q6: These pictures invite me to run a tool in Claude Code or Codex that maps my week's usage and limit hits, then optionally share the totals and a nickname. The map is available now, while a tool to help pace or route my usage is still a design; sharing my week helps them decide whether to build it.

### R2-A
Q1: It presents a pacing tool being designed for people hitting Claude limits and offers to map a Claude Code or Codex week with one prompt. What the map gives you is not stated.
Q2: People who use Claude Code or Codex and hit usage limits.
Q3: Press “See sample.” The page also invites you to map your week with one prompt.
Q4: not stated
Q5: The screens show one example with 2 recorded limit hits on Wed 14 Oct at 16:20 UTC; they do not identify User 1 or User 2 or compare their weeks. The DESIGN half is labeled “in rehearsal, not run”; whether the other half exists today is not stated on these screens.
Q6: It starts with a usage limit, then shows a map that records when limits hit and summarizes a sample week. You can run it through Claude Code or Codex, and it says only pressing Share sends your weekly totals and chosen nickname; some features are built while the router design is still in rehearsal.

### R2-B
Q1: It offers a prompt to map your Claude Code and Codex week. The first screen does not say what the map contains.
Q2: People who use Claude Code or Codex, especially those who hit usage limits.
Q3: Press “Example week.”
Q4: not stated
Q5: User 1 had two recorded limit hits and ran out on Wednesday 14 Oct at 16:20 UTC. The other half shows pacing as a DESIGN in rehearsal; it does not give User 2’s week, and pacing does not run today.
Q6: Someone keeps hitting usage limits while working in Claude Code or Codex. The page invites them to share a week of usage to help decide whether to build a pacing tool, shows a sample summary, and says the proposed router is still only a design.

### R2-C
Q1: It offers to map your Claude week with one prompt. The first screen does not say what the map shows.
Q2: not stated
Q3: not stated
Q4: not stated
Q5: User 1’s and User 2’s weeks are not compared. The scroll calls pacing DESIGN and says the map sends nothing, but does not explicitly say which half exists today.
Q6: The page shows a built usage map and a separate pacing feature that is still a design. It asks me to run the map in Claude Code or Codex and share my week’s totals so the makers can decide whether pacing is worth building. The map sends nothing by itself; sharing sends the totals and a nickname I choose.

### R2-D
Q1: It presents a prompt that maps your Claude Code and Codex week, with an example shown.
Q2: People who use Claude Code or Codex and hit usage limits.
Q3: Share your week to help decide what to build.
Q4: not stated
Q5: User 1 hits a limit mid-sentence. User 2's path shows a built map and pacing that is still in design; the map exists today.
Q6: You hit a Claude Code or Codex limit mid-sentence, and this page offers a way to map your usage by pasting a prompt into your coding tool. The map stays private unless you choose to share your week’s totals and a nickname; those shared results may help decide whether to build a proposed pacing feature.

### R2-E
Q1: It offers a way to map your Claude Code and Codex week with one prompt. What the map gives you is not stated.
Q2: People who use Claude Code or Codex.
Q3: The first screen offers an Example; how to run the map is not stated.
Q4: not stated
Q5: How User 1’s week differs from User 2’s is not stated. The pacing tool is marked DESIGN and described as not run yet; whether the map exists today is not stated on these screens.
Q6: A proposed pacing tool asks you to map your Claude Code or Codex usage and share a week’s totals to help decide whether it is worth building. You can explore questions privately, then paste a prompt into your coding tool to get a usage summary; the final picture separates the usable map from a router design still in rehearsal.

Reply with ONLY a JSON object mapping each id to its grades and a short reason for every 0, e.g.
{"R1-A":{"q1":1,"q2":0,"q3":1,"q4":1,"q5":0,"q6":1,"why0":{"q2":"...","q5":"..."}}, ...}