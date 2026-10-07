# UC9: Website slop roast

**User story:** As a website builder I want to use Jev!Jev to roast and score my website as AI slop so that I can fix it and win awards for awesome web apps.

## Jev or not
"Is this AI slop?" is an open question, which Jev handles badly: as asked, **Jev probably not**. Broken into a checklist, each item becomes a typed decision with a fixed answer set: yes / no, or a 0 / 1 / 2 score, each with a confidence. Code adds the weighted checks into the score, so the number never comes from a model's opinion. That shape is **Jev could help**.

## Checks (v1 draft)
| # | Check | Answer | Evidence the builder supplies |
|---|---|---|---|
| S1 | Hero uses a purple-to-blue gradient | yes / no | screenshot or CSS |
| S2 | Everything is centred | yes / no | screenshot |
| S3 | Emoji used as section markers or bullets | yes / no | page text |
| S4 | Default "safe" font pairing (e.g. Inter everywhere) | yes / no | CSS |
| S5 | Uniform rounded cards with an accent rail | yes / no | screenshot |
| S6 | Headline is generic marketing filler ("Unlock the power of...") | 0 / 1 / 2 | page text |
| S7 | Copy says nothing specific: no numbers, names or concrete outcomes | 0 / 1 / 2 | page text |
| S8 | Broken rendering: horizontal scroll, overlap, garbled characters | yes / no | screenshot at 390 px and 1440 px |
| S9 | Invisible focus state or unreadable contrast | yes / no | page |
| S10 | Dark mode missing or broken | yes / no | screenshot in dark mode |

## The three arms
| Arm | What it does |
|---|---|
| What you do now | Ask an LLM "roast my site" and read the prose |
| A simple rule | Deterministic checks: CSS and DOM lint for gradients, fonts, emoji, scroll width, contrast |
| Jev decides | Jev answers each check; code weights the answers into a 0 to 100 slop score and lists the fixes for every "yes" |

Accepted result: a flagged item the builder agrees is real and fixes. Cost per accepted result = spend / fixes the builder accepts.

## Output
A slop score, the checks that fired with the evidence for each, one fix per check, and the verdict for the arm comparison: use Jev, don't use Jev, or not enough evidence.

## Not established
- Whether Jev can judge a screenshot; it is text-only in the community research page, so visual checks may need page text, CSS or a model's description of the screenshot first.
- The weights and the award bar; set them from a labelled set of real sites before any score is published.
