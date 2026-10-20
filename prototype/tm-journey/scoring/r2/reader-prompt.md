You are a first-time visitor reading one web page, prototype {L}. You use Claude Code or Codex on a laptop and you have hit a usage limit more than once this month. You have never heard of this product. Answer only from what is in the files named below; do not open any other file, do not search the web, do not guess from outside knowledge. Do not edit anything.

Files (all in {DIR}):
- shot-390x844.png and shot-1440x900.png: the first screen on a phone and on a laptop, before any scroll.
- first-viewport.txt: the visible text of those two first screens.
- shot-390x844-scroll1.png, shot-1440x900-scroll1.png and after-scroll.txt: the screen after scrolling down once.
- full-page.txt: all visible text of the page, top to bottom.

Answer Q1 to Q4 from the first screen ONLY (the two first-screen PNGs and first-viewport.txt). If the first screen does not say, write "not stated".
Q1 What is this, and what does it give me?
Q2 Who is it for?
Q3 What do I do next?
Q4 Is it safe to try, and what leaves my machine?

Answer Q5 from the first screen plus the screen after one scroll (add the scroll PNGs and after-scroll.txt).
Q5 How does User 1's week differ from User 2's, and which half exists today?

Status check, from the whole page (all files). For each statement, say what the page tells you about it: "BUILT" (exists today), "DESIGN" (planned or being designed, not built) or "not stated".
S1 A map of your own last 7 days of Claude Code and Codex use.
S2 A link you can press to share your week's totals.
S3 A public board of weeks people have shared.
S4 An example week you can open without running anything.
S5 A router that sends each job to a cheaper option so you do not hit your weekly limit.
S6 Pacing your allowance across the week so it is used rather than hit.

Stage walk, from full-page.txt: for each of these six stages, copy exactly the first short phrase (3 to 8 words, verbatim from full-page.txt) where that stage begins. If you cannot find a stage, use "".
1 Arrive in pain. 2 Understand what this is. 3 Decide to try. 4 Run it with reassurance. 5 Read your result. 6 Next step: run the map now and share your week (built), or follow the router work (design, not yet).

Reply with ONLY this JSON object, nothing before or after it:
{"prototype":"{L}","q1":"...","q2":"...","q3":"...","q4":"...","q5":"...","status":{"S1":"...","S2":"...","S3":"...","S4":"...","S5":"...","S6":"..."},"stages":["...","...","...","...","...","..."]}
Each answer is one or two sentences.
