# TokenMax research: what the "other models" cost

> **Research record, 2026-09-29.** Kept as written, apart from private file paths replaced with a note. Where it describes a routing question (trivial / ordinary / hard prompts sent to Haiku, Sonnet or Opus), that premise was dropped on 2026-09-28 and is history, not a plan: see `docs/decision/verdict-rules.md` and `FLOW.md` for the current method. Prices were re-checked on 2026-09-30 against first-party pages and three price lists: 12 of 12 listed models unchanged.


Fetched 2026-09-29. USD. "Opened" = I fetched the page this session. Anything else is UNVERIFIED.

Sections 1 and 3 below are the first pass; section 0 supersedes them where they differ (gpt-6.1-sol, grok-4.7, Jev added).

## 0. Current lineup and per-call cost, refreshed 2026-09-29

Pages opened 2026-09-29 by the main session. OpenAI, Google, xAI and TypeSafe pages were read through a page-summary tool, not verbatim.

| Vendor | Current models (per vendor page) | Source |
|---|---|---|
| Anthropic | Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5. Sonnet 5 is under "Legacy models (still available)"; Sonnet 5.5 retirement "Not sooner than September 28, 2027" | https://platform.claude.com/docs/en/about-claude/models/overview |
| OpenAI | gpt-6-astra, gpt-6.1-sol (new: cached input $0.10), gpt-6-sol, gpt-6-luna; gpt-5.6 and older still priced | https://developers.openai.com/api/docs/pricing |
| Google | gemini-3.8-flash (intro price "through December 31, 2026"), 3.5-flash-lite, 3.1-flash-lite stable; gemini-3.1-pro-preview is the only Pro and is Preview | https://ai.google.dev/gemini-api/docs/pricing |
| xAI | grok-4.7, "the most capable model we've built" | https://docs.x.ai/docs/models |
| TypeSafe (Jev) | jev-1.13.0 (jev-latest and jev-preview alias it): "$42 / $0.042" per Btok / Mtok, "Output tokens are free", 1,200 requests/min, 64k context, no free tier mentioned | https://docs.typesafe.ai/models |

Worked cost, list price, no caching, batch or reasoning tokens. cost = (in x in_price + out x out_price) / 1e6.

| Model | Vendor | in / out $/M | 400/5 per 1,000 calls | 2,000/50 per 1,000 calls | x Jev (400/5) |
|---|---|---|---|---|---|
| Jev jev-1.13.0 | TypeSafe | 0.042 / 0 | $0.0168 | $0.0840 | 1x |
| gpt-6-luna | OpenAI | 0.1 / 0.5 | $0.0425 | $0.2250 | 3x |
| gemini-3.1-flash-lite | Google | 0.25 / 1.5 | $0.1075 | $0.5750 | 6x |
| gemini-3.5-flash-lite | Google | 0.3 / 2.5 | $0.1325 | $0.7250 | 8x |
| gemini-3.8-flash (intro to 2026-12-31) | Google | 0.75 / 3.75 | $0.3188 | $1.6875 | 19x |
| Claude Haiku 4.5 | Anthropic | 1 / 5 | $0.4250 | $2.2500 | 25x |
| grok-4.7 (<200k) | xAI | 2 / 6 | $0.8300 | $4.3000 | 49x |
| Claude Sonnet 5.5 | Anthropic | 2 / 10 | $0.8500 | $4.5000 | 51x |
| gpt-6.1-sol | OpenAI | 2 / 10 | $0.8500 | $4.5000 | 51x |
| gpt-6-sol | OpenAI | 2 / 10 | $0.8500 | $4.5000 | 51x |
| gemini-3.1-pro-preview | Google | 2 / 12 | $0.8600 | $4.6000 | 51x |
| Claude Opus 5.5 | Anthropic | 4 / 20 | $1.7000 | $9.0000 | 101x |
| Claude Fable 5.1 | Anthropic | 10 / 50 | $4.2500 | $22.5000 | 253x |
| gpt-6-astra | OpenAI | 10 / 50 | $4.2500 | $22.5000 | 253x |

- Sonnet 5.5 costs the same as Sonnet 5 ($2 / $10, pricing page footnote 3), so dollar figures measured on Sonnet 5 hold; its speed and accuracy on our tasks are unmeasured.
- The D03 grading run measured Sonnet 5 at $0.001912 per item vs Jev $0.000017 (about 110x, private timing results); that run used more tokens per item than the 400/5 case, which is why it differs from 51x.
- Claude 4.7+ tokenizer "produces approximately 30% more tokens for the same text" (pricing page), so Claude rows understate cost for equal text vs other vendors.

## 1. API prices (per 1M tokens)

| Model | Input | Cached input (read) | Output | Source (opened) |
|---|---|---|---|---|
| Claude Fable 5.1 | 10 | 0.25 | 50 | A |
| Claude Opus 5.5 | 4 | 0.20 | 20 | A |
| Claude Sonnet 5.5 | 2 | 0.20 | 10 | A |
| Claude Haiku 4.5 | 1 | 0.10 | 5 | A |
| GPT-6 Astra (top) | 10 | 1.00 | 50 | B |
| GPT-6 Sol | 2 | 0.20 | 10 | B |
| GPT-6 Luna (cheapest GPT-6) | 0.10 | 0.01 | 0.50 | B |
| GPT-5.4-mini | 0.75 | 0.075 | 4.50 | B |
| GPT-5.4-nano | 0.20 | 0.02 | 1.25 | B |
| Gemini 3.1 Pro Preview (<=200k) | 2.00 | 0.20 | 12.00 | C |
| Gemini 3.8 Flash (to 2026-12-31) | 0.75 | 0.075 | 3.75 | C |
| Gemini 3.5 Flash | 1.50 | 0.15 | 9.00 | C |

- A = https://platform.claude.com/docs/en/about-claude/pricing (Anthropic table, fetched 2026-09-29).
- B = https://developers.openai.com/api/docs/pricing (fetched 2026-09-29). The page-summary tool listed GPT-6 Astra/Sol/Luna, GPT-5.6 Sol (4/0.40/20), GPT-5.4-mini/nano and older minis. Which is "flagship" is my reading: Astra is the highest-priced, Sol the mid-tier. UNVERIFIED as OpenAI's own label.
- C = https://ai.google.dev/gemini-api/docs/pricing and .../models (fetched 2026-09-29). Gemini 3.1 Pro is the only Pro listed and is Preview status. Flash 3.8 price rises to 1.50 in / 7.50 out (cache 0.15) from 2027-01-01. Pro >200k context: 4.00 in / 18.00 out.
- Anthropic notes (A): Fable 5.1 cache read is 0.025x input; Opus 5.5 is 0.05x; others 0.1x. Claude 4.7+ tokenizer "produces approximately 30% more tokens for the same text", so equal text costs more on Opus 5.5, Sonnet 5.5, Fable 5.1 than the table implies. Haiku 4.5 uses the older tokenizer (Sonnet 4.6 and earlier are stated; Haiku 4.5 not stated explicitly, UNVERIFIED).
- Sonnet 5.5 at 2/10 matches the Sonnet 5 note: the $3/$15 September 2026 increase "will not occur" (A).

## 2. Subscriptions

| Plan | Price / month | Vendor wording on limits | Source |
|---|---|---|---|
| Claude Pro | $20 ($17 annual, $200 upfront) | "at least 5x more per 5-hour session" than Free; "How much you can do depends on the length and complexity of your conversations, the model you choose, and the features you use." | https://claude.com/pricing |
| Claude Max 5x / 20x | from $100 | "choose 5x or 20x more usage than Pro" per 5-hour session; usage resets "on a rolling five-hour session window"; paid plans add weekly limits; "we may limit your usage in other ways, such as weekly and monthly caps or model and feature usage, at our discretion." | https://claude.com/pricing |
| Claude Max 20x price | UNVERIFIED (page said "From $100"; 20x price not shown) | | |
| ChatGPT Plus | $20 | "may include usage limits such as message caps, especially during high demand" | search snippet of help.openai.com; page itself returned 403, UNVERIFIED |
| ChatGPT Pro $100 / $200 | $100 / $200 | "Pro $100 unlocks 5x higher usage than Plus, while Pro $200 unlocks 20x usage than Plus"; $200 tier paused for new sign-ups from 2026-09-10 | search snippet only, UNVERIFIED |
| Google AI Plus / Pro | USD UNVERIFIED (Polish page: zl23.99 / zl97.99) | Plus "2x", Pro "4x" the limits of no AI plan; "Your limit refreshes every 5 hours until you reach your weekly limit." Limits are "compute-based", factoring "the complexity of your prompt, the models and features you use, and the length of your chat." | https://support.google.com/gemini/answer/16275805 |
| Google AI Ultra | $100 (5x Pro) and $200 (20x Pro) | "We're launching a $100/month AI Ultra plan"; Ultra price cut "from $250 to $200" | https://blog.google/products-and-platforms/products/google-one/google-ai-subscriptions/ |

No vendor publishes a message count per window. All three publish relative multipliers (5x, 20x) and a 5-hour window plus weekly cap. Builders therefore cannot convert allowance to dollars from vendor data alone.

## 3. Worked cost per typed-decision call

cost = (in_tokens x in_price + out_tokens x out_price) / 1,000,000. No caching, no batch, no reasoning tokens.
Case 1: 400 in / 5 out. Case 2: 2,000 in / 50 out.

| Model | in/out $/M | Case 1 per call | Case 1 per 1,000 | Case 2 per call | Case 2 per 1,000 |
|---|---|---|---|---|---|
| Fable 5.1 | 10 / 50 | $0.004250 | $4.25 | $0.022500 | $22.50 |
| GPT-6 Astra | 10 / 50 | $0.004250 | $4.25 | $0.022500 | $22.50 |
| Opus 5.5 | 4 / 20 | $0.001700 | $1.70 | $0.009000 | $9.00 |
| Sonnet 5.5 | 2 / 10 | $0.000850 | $0.85 | $0.004500 | $4.50 |
| GPT-6 Sol | 2 / 10 | $0.000850 | $0.85 | $0.004500 | $4.50 |
| Gemini 3.1 Pro | 2 / 12 | $0.000860 | $0.86 | $0.004600 | $4.60 |
| Haiku 4.5 | 1 / 5 | $0.000425 | $0.43 | $0.002250 | $2.25 |
| GPT-5.4-mini | 0.75 / 4.50 | $0.000323 | $0.32 | $0.001725 | $1.73 |
| Gemini 3.8 Flash | 0.75 / 3.75 | $0.000319 | $0.32 | $0.001688 | $1.69 |
| GPT-5.4-nano | 0.20 / 1.25 | $0.0000863 | $0.09 | $0.000463 | $0.46 |
| GPT-6 Luna | 0.10 / 0.50 | $0.0000425 | $0.04 | $0.000225 | $0.23 |

Example (Sonnet 5.5, case 1): (400 x 2 + 5 x 10) / 1e6 = (800 + 50) / 1e6 = $0.00085.
Cost per ACCEPTED result = cost per call / acceptance rate (e.g. 90% accepted: $0.00085 / 0.9 = $0.00094). Acceptance rates are TokenMax inputs, not vendor data.
Caveats: reasoning/thinking models emit hidden output tokens billed as output, so 5 visible output tokens can cost far more (not measured here). The 30% tokenizer inflation on Claude 4.7+ models could raise case 1 input from 400 to about 520 for the same text (Anthropic's figure, applied by me).

## 4. Discounts that change the per-call figure

| Lever | Effect | Source |
|---|---|---|
| Anthropic Batch API | 50% off input and output (Sonnet 5.5 batch 1/5, Opus 5.5 2/10, Haiku 4.5 0.50/2.50, Fable 5.1 5/25) | A |
| OpenAI Batch | "Batch discount: 50%" on every model listed | B |
| Gemini Batch | 50% (3.8 Flash 0.375 in / 1.875 out; 3.1 Pro 1.00 / 6.00) | C |
| Anthropic cache read | 0.1x input (Fable 5.1 0.025x, Opus 5.5 0.05x); 5m write 1.25x, 1h write 2x | A |
| OpenAI cached input | 10% of input on GPT-6 and 5.4 rows (e.g. Sol 0.20 vs 2.00) | B |
| Gemini context caching | 10% of input (3.8 Flash 0.075 vs 0.75) | C |
| Stacking | Anthropic: cache multipliers "stack with other pricing modifiers, including the Batch API discount" | A |
| US-only inference (Claude 4.6+) | 1.1x on all token prices | A |

Effect on the 400/5 case: caching only helps the shared prefix (system prompt/schema). Minimum cacheable prefix length was not checked, so it is UNVERIFIED that a 400-token prompt can be cached at all. Batch halves the figure: Sonnet 5.5 case 1 becomes $0.000425 per call, $0.425 per 1,000, but adds asynchronous latency (not suited to live workflow calls).

## 5. What we could not confirm

- OpenAI official pricing at openai.com/api/pricing and chatgpt.com/pricing, help.openai.com: HTTP 403. OpenAI API figures come from developers.openai.com, opened via a summarising fetch tool, not read verbatim.
- OpenAI "flagship" and "mini" labels (Astra/Sol/Luna, 5.4-mini) are my classification.
- ChatGPT Plus/Pro limit wording and prices: search-result snippets only.
- Google AI Pro and Plus USD price (only PLN seen); Claude Max 20x price.
- OpenRouter cross-check: its models endpoint returned no prices and model pages showed none, so no independent price confirmation.
- Tokenizer difference for Haiku 4.5 and for GPT/Gemini tokenizers on our prompts (token counts assumed as given).
- Hidden reasoning-token counts for a 5-token answer, per model.
- Minimum cacheable prompt size per vendor.
- Fable 5.1 is not "current Opus/Sonnet", listed as asked; Mythos 5.x is invite-only (A) and excluded.
