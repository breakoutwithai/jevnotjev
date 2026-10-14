# Sample prompts and decision questions

Use synthetic or redacted input. These are starter questions to adapt, not measured Jev results. Give Jev a state containing the item being classified, then make code act on the answer.

## Choice: pick exactly one listed answer

1. "Which queue should receive this support message?" Answers: `billing` = payment or invoice issue; `technical` = product failure or error; `account` = sign-in or profile access; `none` = no listed queue fits, send to a person.
2. "What kind of appointment request is this?" Answers: `book` = asks for a new time; `change` = asks to move an existing time; `cancel` = asks to remove an existing time; `none` = another request, route to staff.
3. "Which document bucket fits this upload?" Answers: `invoice` = bill requesting payment; `receipt` = proof of completed payment; `contract` = agreement to sign or review; `none` = none fits, hold for review.

## Noul: one condition, chance of yes

1. "Does this support message explicitly ask for a refund?" Answers: `yes` = a refund is requested; `no` = no refund request is stated. Code chooses a cutoff and flags yes for the billing team.
2. "Does this booking message ask to cancel an existing reservation?" Answers: `yes` = cancellation requested; `no` = otherwise. Code sends yes to the cancellation workflow.
3. "Does this uploaded document contain a due date?" Answers: `yes` = a due date is present; `no` = no due date is found. Code asks for review when no.

## Score: ordered, concrete levels

1. "How urgent is this support message?" Levels, low to high: `routine` = general question with no deadline; `blocked` = one task blocked but a workaround exists; `critical` = the whole team is blocked today. Code sets a response window.
2. "How complete is this intake form?" Levels: `missing` = contact details absent; `partial` = contact details present but required request details absent; `complete` = both are present. Code requests missing fields or continues.
3. "How severe is the reported delivery problem?" Levels: `minor` = cosmetic issue, item usable; `limited` = item partly usable; `unusable` = item cannot be used. Code sets a review priority.

## From a plain question to a Jev request

1. Write the fixed answers and what each means. Add a `none` choice when no listed answer may fit. For a score, write 2 to 10 ordered situations, lowest first. For a noul, state exactly one yes/no condition.
2. Put the item itself in `state`; do not put a secret there. Set `model` to `jev-1.13.0` and place the question under a stable name in `questions`.
3. For choice, set `type: "choice"`, `instructions.question`, and `criteria` mapping answer names to meanings. For noul, set `type: "noul"` and `instructions.question`. For score, set `type: "score"`, `instructions.question`, and `criteria` as ordered descriptions.
4. Start with [choice](requests/choice.json), [noul](requests/noul.json), or [score](requests/score.json). Compare answers on labelled cases against a simple rule before using them to route real work.

All three JSON files are unrun direct Jev `/v1/systemone` body examples that follow the documented request shapes. Their state, question text, and criteria are synthetic. To try one, set `JEV_API_KEY` in your shell and run:

```sh
curl -sS https://api.typesafe.ai/v1/systemone -H "Authorization: Bearer ${JEV_API_KEY}" -H 'Content-Type: application/json' --data-binary @requests/choice.json
```

Change the filename for another type. The JSON files contain no key.
