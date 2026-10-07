# Label card

One page for anyone labelling cases in Backstage. 10 cases, about 10 minutes.

## How to label
1. **Calibrate first.** The Rehearsals room starts with 5 practice cases. Pick each one, then compare with the reference label a person approved. Your agreement shows at the end.
2. **Pick blind.** For each of your cases, pick the right answer before you see any answer or Jev's suggestion. Your blind pick is the one that scores the answerers.
3. **Then keep or change.** After your pick, Jev's options appear ranked by probability. Keep your pick or change it; both are recorded, and the change never replaces the blind pick.
4. **Unsure is an answer.** If the case does not give you enough to decide, pick **Unsure**. An unsure case is left unlabelled, never guessed.
5. **Synthetic or redacted cases only.** No real names, emails, phone numbers or order numbers. Rewrite a real message before you use it.
6. **Ten cases, ten minutes.** About a minute a case. If one takes longer, pick Unsure and move on.

## Where a label comes from
Every exported label says who made it: `human` (a person picked it in Backstage), `human_reviewed` (a person approved it but did not pick it in Backstage, such as an AI draft a person checked) or `agent` (an AI made it and nobody reviewed it). An `agent` label is never counted as truth. Labels in an imported case file are `agent` unless its `label_source` column says `human_reviewed`; a file's `human` is stored as `human_reviewed`, because only a pick in Backstage is `human`. Your own call on a case in Backstage replaces its imported label; picking Unsure leaves the case unlabelled.

Case file columns: `case_id,case_input`, then optionally `label` (one of your two answers), `label_source`, `labelled_by` (a handle, never an email) and `labelled_at`.

## The answers, one sentence each
| Question | Answer | Means | Two examples |
|---|---|---|---|
| Shop bot (calibration and P1): can the bot answer from the fact sheet, or must it hand off? | `answer` | Everything asked is on the fact sheet, so the bot can reply without promising stock, a booking or anything unstated. | "Does the full overhaul include a hot wax?"; "Is there a counter at the lift base?" |
| | `hand_off` | It needs live stock, a booking, a fact not on the sheet, a safety call, or it is a complaint, injury or billing problem. | "Can I leave my car in your car park overnight?" (not on the sheet); "The boots gave me blisters and I want my money back." (a refund) |
| P2 Email triage: reply today, or can it wait? | `today` | Someone is blocked, money or a deadline is at risk today, or the sender asks for something before the end of the day. | "Our stand at today's trade fair has no power"; "Please confirm the venue booking by 4pm" |
| | `later` | Information, thanks or a request with no deadline today. | "Here are the notes from last month's meeting"; "Our holiday calendar for next year is attached" |
| P3 Router: can a small, cheap model do this well? | `small` | A short, well-defined task with one obvious answer. | "Sort this list of names alphabetically"; "Turn this sentence into title case" |
| | `large` | It needs reasoning across files or steps, a design choice, unclear debugging, or care about security or data loss. | "Find why the app slows down after a day running"; "Choose how to store passwords for a new sign-up form" |
| P4 Outfit: does it suit the occasion? | `yes` | It fits the dress level, weather and activity. | "Smart dress and flats for a christening"; "A dark suit for a funeral" |
| | `no` | Something clashes: too casual or formal, wrong for the weather, or impractical. | "Ski boots at a dinner party"; "A swimsuit at a job interview" |
| P5 Video check: keep watching, or quiz me? | `keep_watching` | The part watched gave at least one concrete new fact, step or demonstration that matches the title. | "A bread video that has shown the dough weights and the fold sequence"; "A bike-repair video that has named the tool for each step" |
| | `quiz_time` | The part watched was padding: repeated intro, hype, a sponsor read, or a promise in the title not yet delivered. | "A review video that has spent three minutes on its own channel plans"; "A video titled 'five tricks' that has still named none" |
| P6 Morning headline: print it, or spike it? | `print_it` | Recent, on topic, and with a concrete hook a reply could address: a question, a complaint or an announcement. | "Yesterday's post asking how to export a report"; "A launch notice for a plug-in the project supports" |
| | `spike_it` | Older than 7 days, off topic, an advert, a duplicate or spam, or no hook to reply to. | "A two-week-old thread about an old release"; "A discount code for sunglasses" |
| P7 Rubric check: does it pass, or is another lesson needed? | `passes` | The answer has every element the rubric line asks for and states nothing that contradicts it. | "Rubric asks for a cause and an effect, and the answer gives one of each"; "Rubric asks for two units, and the answer converts and names both" |
| | `another_lesson` | The answer leaves out an element the rubric line asks for, or states something wrong. | "Rubric asks for a cause and an effect, and the answer gives only the cause"; "Rubric asks for a unit, and the answer gives a bare number" |
| P8 Event host: seat them, or step in? | `seat_them` | Ordinary event chat: a greeting, a question, a compliment or a normal introduction, with no pressure, abuse or contact details. | "Hello everyone, glad to be here"; "Is the second talk recorded?" |
| | `step_in` | A moderator should act: harassment, a sales push or scam, private contact details, repeated contact after a no, or distress. | "A message that insults another guest"; "A guest posting their home address in the open chat" |

The examples are new and none follows the pattern of a calibration or starter-pack case, so the card does not give away a practice answer.

## Starter packs
Backstage's New Scene room loads eight packs. **P1** to **P4** have 10 cases with their labels. **P1** uses shop-bot messages whose labels a person approved (`human_reviewed`). **P2, P3 and P4** were written and labelled by an AI and nobody has reviewed them yet, so their labels are `agent` until you pick the cases yourself. **P5** to **P8** have 30 cases and no labels at all: you label every case blind. A link such as `/backstage/?pack=p5` loads a pack on arrival, with no model call.
