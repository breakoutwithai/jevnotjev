# Is my website AI slop? Turning a roast into ten questions Jev can answer

## The question
A website builder wants to know whether their site reads as AI slop, fix what it finds, and put something award-worthy in front of people. The obvious move is to ask a model "roast my site". The question for Jev!Jev is whether Jev can do that job better, or cheaper, or not at all.

## What we found
1. "Is this AI slop?" is an open question. Jev is a classifier: it answers questions with a fixed set of answers (yes or no, pick one, or a score), each with a confidence. So as asked, it's the wrong tool.
2. The fix is to stop asking one big question. We split it into ten small ones, each with a fixed answer ([UC9](../product/use-cases/uc9-website-slop-roast.md)):
   - does the hero use a purple-to-blue gradient, is everything centred, are emoji doing the job of section markers;
   - is the headline generic filler, does the copy say anything specific (scored 0, 1 or 2);
   - does the page scroll sideways on a phone, is focus visible, is the contrast readable, does dark mode work.
3. Jev answers each check. Code adds the weighted answers up into a 0 to 100 slop score, so the number comes from a rule anyone can read, not from a model's mood. Every check that fires comes with its fix.
4. It slots into the same comparison as the rest of the project ([FLOW.md](../../FLOW.md)): what you do now (ask an LLM for a roast), a simple rule (automated checks on the page's HTML and CSS), and Jev answering the checklist. The verdict is still use Jev, don't use Jev, or not enough evidence.
5. An accepted result here is a flagged problem the builder agrees is real and fixes. So cost per accepted result means cost per real fix.

## The evidence
| Claim | Source |
|---|---|
| UC9 defines ten checks with fixed answers and a code-computed score | [uc9-website-slop-roast.md](../product/use-cases/uc9-website-slop-roast.md) |
| The three arms and the verdict rule | [FLOW.md](../../FLOW.md) |
| The change is proposed in the open | [PR #3](https://github.com/breakoutwithai/jevnotjev/pull/3) |

## What changed
- New use case UC9 in the [use-case list](../product/use-cases/README.md), grouped under "on a builder's shipped site".

## Not established
- Whether Jev can judge the visual checks at all. It reads text, so a screenshot may need turning into page text, CSS or a description first.
- The weights, and where "award-worthy" sits on the score. Both need a labelled set of real sites before any score is published.
- Whether a simple lint already catches most of this for free. That's what the comparison is for.

## Next
Collect ten real sites (with the owners' consent), label each check by hand, and run the three arms.

## Post kit (for the operator, not for pasting)
- Fact: "Is this AI slop?" can't go to Jev as asked; ten yes/no or 0 to 2 checks can. Link: [UC9](https://github.com/breakoutwithai/jevnotjev/pull/3)
- Fact: the score is computed by code from the answers, so it can be read and argued with.
- Fact: every flagged check comes with its fix; a "result" counts only when the builder agrees and fixes it.
- Hook question: "Which AI-slop tell on a website annoys you most? I'll add it as check 11."
- Do not claim: that Jev can judge screenshots, or any accuracy number. Neither is measured yet.
