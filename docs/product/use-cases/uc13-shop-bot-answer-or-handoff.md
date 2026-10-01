# UC13: Shop bot, answer or hand off

**User story:** As a small shop owner running a website and phone bot, I want the bot to answer what its configured facts cover and hand everything else to staff, so customers never hear an invented price, stock level or booking.

**Prompted by:** a community builder making website and phone bots for a winter ski and snowboard rental shop, who wants the bot to follow its written rules on availability and bookings. The test set below uses a synthetic shop: one fact sheet and customer messages we wrote ourselves.

## Jev or not
Split. Looking up a configured price, the no-answer timer before the bot takes a call, and the pause-recording button are code: **!Jev**. Deciding whether one customer message can be answered from the fact sheet, or must go to staff, is a fixed choice on one short text: **Jev could help**.

| Decision (typed question) | Answers | State (what Jev reads) | Code does with each answer | Mark | Simple rule to beat |
|---|---|---|---|---|---|
| Can the bot answer this from the fact sheet? | answer / hand_off | the fact sheet plus one customer message | answer goes to the reply step; hand_off sends a summary to staff | Jev could help (test set below) | keyword list: any stock, availability, booking, policy, injury or safety word goes to hand off |
| Does this bot reply claim a confirmed booking? | yes / no | one bot reply | yes blocks the reply and hands off | Needs a test | regex on "booked", "confirmed", "reserved" |
| Is this a safety question the bot must not answer alone? | answer from facts / escalate | one customer message | escalate goes to staff | Needs a test | safety keyword list (avalanche, injury, conditions) |
| Which topic is this question? | pricing / returns / hours / service / stock / safety / booking / retail | one customer message | picks the fact section the reply step reads | Jev could help | keyword list per topic |
| Is this enquiry ready for staff now? | escalate now / bot continues | the conversation so far | escalate sends dates, gear and contact to staff | Needs a test | escalate once dates and a contact are both present |

## The !Jev half
- **Price and rate maths.** A lookup in the shop's data and a fixed discount rule; exact and free.
- **The takeover timer and the recording pause.** Events, not judgements.
- **The phone path, until latency is measured.** A phone bot needs to start speaking quickly; any extra model call on that path adds delay. Test Jev on chat first.
- **Whether a booking actually exists.** That is the booking system's answer, not a judgement on text.

## Test set for the first decision
Prepared 2026-10-01, before any arm ran.

| Part | What it is |
|---|---|
| Fact sheet | One synthetic winter rental shop: locations, hours, six rental items with daily prices, a 15% multi-day discount, three tuning services with a drop-off cutoff, four guarantees (fast pickup, free condition swaps, boot fit, binding testing). Its last line lists what the sheet does not cover: live stock or availability, bookings, deposits, damage charges, cancellations and refunds, junior size ranges, retail products, forecasts |
| Messages | 40 customer messages, written against the fact sheet, in a fixed shuffled order (`m01` to `m40`). About half are answerable from the sheet; the rest need staff. Hard cases on purpose: answerable messages that contain a rule word ("avalanche gear, how much?", a 4pm drop-off for first chair "tomorrow"), and hand-off messages with no rule word (helmets, snowshoes, a group rate, a price match, a complaint) |
| Acceptance rule | **answer:** everything asked is covered by the fact sheet, so the bot can reply without promising stock, availability, a booking, or anything the sheet does not state. **hand_off:** the message needs live stock or availability, a booking or reservation, a policy or fact not on the sheet, a safety judgement, or a complaint, injury or billing problem |
| Simple rule | Case-insensitive match at a word start on: available, availability, in stock, stock, left, book, booked, booking, reserve, reservation, hold, confirm, confirmed, cancel, refund, deposit, damage, broke, broken, charged, hurt, injur, avalanche, safe, danger, this weekend, saturday, sunday, tomorrow. A match answers `hand_off`, otherwise `answer` |

## The three arms
Same 40 messages, same question, one call per message per arm. Output is one `jnj-record/1` CSV: `run_id` `run-shopbot-2026-10-01`, `prompt_version` `shop-bot-handoff.v1`, `question_id` `q1`, `answer_set` `answer|hand_off`.

| Arm | `answerer` / `answerer_model` | What it gets | Cost source |
|---|---|---|---|
| What you do now | `llm` / the model id Claude reports (Haiku requested) | `claude -p --model haiku --output-format json`, a system prompt with the bot's rules (unknown availability stays unknown, an enquiry is not a booking, state only sheet facts), the fact sheet, both answer definitions, and "reply with exactly one word"; the message as the user turn | `total_cost_usd`; tokens from `usage`, cache tokens included |
| A simple rule | `rule` / `keywords.v1` | the message and the term list above | 0 |
| Jev decides | `jev` / `jev-1.13.0` | one request per message, shown below | input tokens x $0.042 per million, output free (published price, not yet checked against a bill) |

Jev request, per message (`POST https://api.typesafe.ai/v1/systemone`):

```json
{
  "state": "Fact sheet:\n<the fact sheet>\n\nCustomer message:\n<the message>",
  "model": "jev-1.13.0",
  "questions": {
    "q1": {
      "type": "choice",
      "instructions": { "question": "Can the bot answer this customer message using only the fact sheet, or must it hand off to staff?" },
      "criteria": { "answer": "<acceptance rule, answer>", "hand_off": "<acceptance rule, hand_off>" }
    }
  }
}
```

The run fails loudly if the response model is not `jev-1.13.0`. The Jev key is read from the operator's keychain at run time and never written anywhere.

## Labels and result
- One correct answer per message (answer / hand_off), set by a person on a page that shows only the fact sheet, the acceptance rule and the message, never any arm's output. Each arm's row is then `accept` when its output equals that answer, else `reject`, with `label_source` `human`.
- Result: right answers and cost per right answer per arm (D07 metrics, `src/core/metrics.ts`), Jev against the LLM and against the rule on paired cases, and the verdict from [verdict-rules.md](../../decision/verdict-rules.md).
- Misses are listed by direction, **answered when it should have handed off** first: those include every unknown-stock and booking message an arm got wrong, and one miss there matters more than the overall rate. Handed off when it could have answered comes second.

Files: the synthetic shop in [examples/uc13-shop-bot/](../../../examples/uc13-shop-bot/), the run in [docs/product/runs/2026-10-01-uc13-shop-bot/](../runs/2026-10-01-uc13-shop-bot/).

Commands (TypeScript on Bun, from the repo root):

```
bun scripts/uc13/run-arms.ts run --dry   # rule arm only, no network; prints, writes nothing
bun scripts/uc13/run-arms.ts run         # rule, Jev and the LLM
bun scripts/uc13/run-arms.ts page        # build the labelling page
bun scripts/uc13/run-arms.ts label       # merge labels.csv into the records
bun run validate docs/product/runs/2026-10-01-uc13-shop-bot/records.csv
```

## Run status (2026-10-01)
| Step | State |
|---|---|
| Fact sheet, 40 messages, acceptance rule, simple rule | written, before any arm ran |
| Rule arm | run: 13 hand_off, 27 answer, cost 0 |
| Jev arm | run: 40 calls, all `jev-1.13.0`; 22 hand_off, 18 answer; $0.001302 at the published price |
| LLM arm | run: 40 calls, all `claude-haiku-4-5-20251001`; 22 hand_off, 18 answer; $0.103167 from `total_cost_usd` |
| Labels | none yet |
| Verdict | none |

## Not established
- Anything about Jev's accuracy or cost on this decision; nothing has been measured yet.
- Whether the keyword rule already gets every unknown-stock and booking case right; if it does, Jev has nothing to add on the first decision.
- Whether Haiku with these rules stands in for a real shop bot's prompt and model.
- Whether 40 messages we wrote resemble what real customers send.
- Whether one label set from us matches the shop owner's own call.
- How long a Jev call takes compared with a phone bot's response target.
