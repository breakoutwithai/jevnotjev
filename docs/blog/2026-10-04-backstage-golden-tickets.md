# Backstage is open: five golden tickets for a guided tour

## The question
Up to now the stage has only shown runs I recorded myself: Little Shop of Snow Gear, 40 made-up customer messages, three players. The question for this week was whether someone else could bring their own decision, run Jev on it, judge the answers and walk away with the evidence, without me in the loop and without their keys or private data ending up anywhere they shouldn't.

## What we found
1. It works end to end, and it lives in one place: [Backstage](https://jevnotjev.breakoutwithai.com/backstage/). For now it sits behind a tester login, which is why this post is an invite rather than a link.
2. A run goes through six rooms ([index.html:33-39](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/site/backstage/index.html#L33-L39)):
   - **New Scene**: you write one question, two answers, what each answer means, and the rule a kept answer has to meet ("Keep an answer when...") plus anything you're leaving out ([index.html:86-94](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/site/backstage/index.html#L86-L94)).
   - **Casting**: Jev takes the stage first. Other models can join the line-up if you want a comparison, each with your own key.
   - **Learning Lines**: your cases, made up or redacted.
   - **Rehearsals**: you judge every answer blind, before you know who said it, and the rule you wrote sits on every card as "Keep when: ..." ([main.ts:601](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/src/backstage/main.ts#L601)).
   - **Dress Rehearsal**: you download `records.csv` and the evidence file. They're yours ([index.html:359-360](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/site/backstage/index.html#L359-L360)).
   - **Opening Night**: the verdict. Use Jev for this call, don't, or run more cases.
3. The key stays out of the script. It has its own password field ([index.html:157](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/site/backstage/index.html#L157)), and if it turns up in the question, the answers or a case, the request is refused ([providers.ts:169](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/src/backstage/providers.ts#L169)).
4. One thing I didn't expect. The three steps you can't undo (opening judging, revealing the results, starting a new scene) used the browser's own pop-up to ask "are you sure?". That pop-up freezes any agent driving the page and never shows up in a screenshot, so I couldn't record a walkthrough. [PR 90](https://github.com/breakoutwithai/jevnotjev/pull/90) swapped them for panels on the page. Same locks, same order, but now they show how many answers are in and how many are missing before you commit.
5. Everything above shipped together as the first tagged release of the whole stack, [v2026.10.04.1](https://github.com/breakoutwithai/jevnotjev/releases/tag/v2026.10.04.1). The site and Backstage both serve the same commit, `5bfb5b6`.

## The golden tickets
Think of it less like a demo and more like the factory tour. There are five golden tickets. Each one is a guided tour of Backstage with me, using a yes or no call from your own project. We write the scene together, run a handful of your cases through Jev, you judge the answers blind, and you leave with the verdict and the files.

What I'd ask you to bring:
- One decision your project makes over and over, with a fixed set of answers.
- A few example cases, made up or redacted. Nothing private goes on stage.
- Your own Jev key if you have one. If not, we can still write the scene together.

To claim one, reply to my post in the community. Five tickets, first come.

## The evidence
| Claim | Source |
|---|---|
| Six rooms | [index.html:33-39](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/site/backstage/index.html#L33-L39) |
| Acceptance rule and exclusions in the scene | [index.html:86-94](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/site/backstage/index.html#L86-L94) |
| Rule shown on every judging card | [main.ts:601](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/src/backstage/main.ts#L601) |
| Key in its own field, refused if it appears in the question, answers or cases | [index.html:157](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/site/backstage/index.html#L157), [providers.ts:169](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/src/backstage/providers.ts#L169) |
| Downloads | [index.html:359-360](https://github.com/breakoutwithai/jevnotjev/blob/5bfb5b6/site/backstage/index.html#L359-L360) |
| Browser pop-ups replaced with panels on the page | [PR 90](https://github.com/breakoutwithai/jevnotjev/pull/90) |
| Whole stack released at `5bfb5b6` | [v2026.10.04.1](https://github.com/breakoutwithai/jevnotjev/releases/tag/v2026.10.04.1) |

## What changed
- [PR 90](https://github.com/breakoutwithai/jevnotjev/pull/90): in-page confirm panels for the three irreversible steps.
- [v2026.10.04.1](https://github.com/breakoutwithai/jevnotjev/releases/tag/v2026.10.04.1): first tagged release of the site and Backstage together.

## Not established
- Whether Jev suits any particular builder's decision. That's what the tour is for, and the answer can be "don't use Jev".
- Any accuracy or cost figure for a builder's own cases. None has been run yet.
- A recorded walkthrough of the new panels. The scripted browser run hasn't been done ([#88](https://github.com/breakoutwithai/jevnotjev/issues/88) stays open until it is).

## Next
Run the first guided tour and publish what it found, whichever way the verdict goes.

## Post kit (for the operator, not for pasting)
- Fact: Backstage has six rooms, from New Scene to Opening Night. Link: [the release](https://github.com/breakoutwithai/jevnotjev/releases/tag/v2026.10.04.1)
- Fact: you write the acceptance rule before you see any answer, and it sits on every card while you judge blind.
- Fact: the key has its own field and a request is refused if it shows up in the question, answers or cases.
- Fact: three browser pop-ups became panels on the page so an agent can drive and record a run (PR 90).
- Fact: five golden tickets, each a guided tour with one decision from the reader's own project.
- Hook question: "What's one yes or no call your project makes a hundred times a day?"
- Link to share: https://github.com/breakoutwithai/jevnotjev/blob/main/docs/blog/2026-10-04-backstage-golden-tickets.md (after merge)
- Do not claim: that Jev fits their project, any accuracy or cost number, or that Backstage is open to the public (it's behind a tester login).
