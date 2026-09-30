# Jev side of the evidence for the D05 decision note

> **Research record, 2026-09-29.** Kept as written, apart from private file paths replaced with a note. Where it describes a routing question (trivial / ordinary / hard prompts sent to Haiku, Sonnet or Opus), that premise was dropped on 2026-09-28 and is history, not a plan: see `docs/decision/verdict-rules.md` and `FLOW.md` for the current method. Prices were re-checked on 2026-09-30 against first-party pages and three price lists: 12 of 12 listed models unchanged.


Compiled 2026-09-29. Read from jevnotjev at e062636 plus private working notes (not published).
Labels: measured = our run, opened by me; published = vendor docs fetched 2026-09-29; community = member claim in the harvested threads; UNVERIFIED = no primary source opened.
Vendor: TypeSafe AI (docs.typesafe.ai). Endpoint `POST https://api.typesafe.ai/v1/systemone`.

## 1. Pricing and limits

| Figure | Value | Source | Status |
|---|---|---|---|
| Input price | $0.042 per million tokens ($42 per billion) | https://docs.typesafe.ai/models (fetched 2026-09-29) | published |
| Output price | free (no charge) | same page | published |
| Per-call fee | none stated; cost is tokens only | docs.typesafe.ai/models and /api.md list no per-call fee | published (absence, docs pages only) |
| Free tier | not mentioned | docs.typesafe.ai/models, /api.md, llms.txt index shows no pricing or billing page | UNVERIFIED (vendor account/billing page not checked) |
| Rate limit | 250,000 tokens per second and 1,200 requests per minute, "dynamic adjustments noted" | docs.typesafe.ai/models | published |
| Context limit | 64k tokens per request; 32k for `state` plus longest question | docs.typesafe.ai/models | published |
| Model names | `jev-1.13.0` (current), `jev-latest` alias, `jev-preview` alias (same as latest today) | docs.typesafe.ai/models | published |
| Errors | 401, 422, 429 (rate limit), 529 (overloaded); retry with exponential backoff | docs.typesafe.ai/api.md | published |
| Max questions per call | no hard limit stated | docs.typesafe.ai/models | published (absence) |
| Billed against a real invoice | never checked; our scripts hardcode the price | `~/.agents/skills/jev-not-jev/scripts/jnj_score.py:31` `PRICE_PER_M = 0.042  # BRIEF.md:9, UNVERIFIED against a bill` | UNVERIFIED |
| Third-party listings (OpenRouter, Requesty, Opper) | exist for Jev 1.13; prices not opened | web search 2026-09-29 result titles only | UNVERIFIED |

## 2. Our measured runs (all `jev-1.13.0`, response `model` field checked by the script)

Source A: `jevnotjev/docs/benchmarks/2026-09-27-grading-speed-cost.md` and a private timing results file (not published). Task: grade 90 short developer answers accept/reject. Set is synthetic; expected labels written by an AI. One run per mode. Cost = usage.input_tokens x $0.042/M, output free.

| Mode | Calls | Wall | Cost | Cost per item | Tokens in / out | Matches AI label |
|---|---|---|---|---|---|---|
| Jev single | 1 | 0.3 s | $0.000016 | $0.000016 | 392 / 32 | 1/1 |
| Jev seq10 (one call per item) | 10 | 3.5 s | $0.0002 | $0.000017 | 3,985 / 320 | 10/10 |
| Jev seq90 (one call per item) | 90 | 29.4 s (327 ms/item) | $0.0015 | $0.000017 | 36,147 / 2,880 | 80/90 |
| Jev batch10 (10 questions, 1 call) | 1 | 0.3 s | $0.0001 | $0.000008 | 1,893 / 313 | 10/10 |
| Jev batch90 (90 questions, 1 call) | 1 | 0.4 s | $0.0006 | $0.000007 | 15,255 / 2,793 | 86/90 |

Comparison arms, same items, same file (measured, `claude -p`, cost from `total_cost_usd`, times include CLI start-up):

| Arm | seq90 cost | seq90 correct | batch90 cost | batch90 correct |
|---|---|---|---|---|
| Haiku 4.5 | $0.3395 | 87/90 | $0.0629 | 87/90 |
| Sonnet 5 | $0.1721 | 86/90 (1 unparsed) | $0.0901 | 86/90 |
| Opus 5.5 | $0.4960 | 83/90 (3 unparsed) | $0.1047 | 88/90 |

Derived by me from those rows (arithmetic, not new measurement): per item seq90, Jev $0.000017 vs Sonnet $0.001912 (about 112x cheaper) and Haiku $0.003772 (about 222x). Batch90 per item, Jev $0.000007 vs Haiku $0.000699 (about 100x). Accuracy at 90: Jev 80/90 = 88.9% (single calls) and 86/90 = 95.6% (batched); LLMs 83 to 88 of 90.

Source B: D04 three-layer run, `docs/delivery/jev-runs/2026-09-28-d04/report.md` and `layer{1,2,3}-response.json`, script `scripts/jev_d04_layers.py:88-98` (cost line computed as input_tokens x 0.042 / 1e6).

| Call | Questions | Tokens in / out | Cost | Seconds |
|---|---|---|---|---|
| Layer 1 | 6 | 1,893 / 224 | $0.00007951 | 0.38 |
| Layer 2 | 3 | 809 / 127 | $0.00003398 | 0.39 |
| Layer 3 | 2 | 558 / 73 | $0.00002344 | 0.44 |

Total $0.00013693 for 3 calls (sum of the three, mine). No labels: these are opinions on one D04 answer, not scored.

How calls return usage: response JSON has `model`, `answers.<id>.{choice, confidence, probabilities}`, `usage.{input_tokens, output_tokens}` (layer1-response.json; docs /api.md agrees). The call helper is `call_jev` in `~/.agents/skills/jev-not-jev/scripts/jnj_score.py` (URL at line 29, POST at lines 124-134, timeout 60 s). Key comes from keychain via `read_key`; I did not run or read it.

## 3. Accuracy and calibration claims

| Claim | Value | Source | Status |
|---|---|---|---|
| Model "trained with RLCD to return calibrated decisions"; English is where accuracy is best | qualitative | docs.typesafe.ai/models | published, no numbers |
| Confidence definition | statistic from the answer's probability spread; for 3 options (3 x max prob - 1) / 2; 1.0 all on one option | docs.typesafe.ai/confidence | published |
| Vendor guidance | thresholds not one number; example 0.5 floor and 0.9 for high stakes; no accuracy data given | docs.typesafe.ai/confidence | published |
| Vendor calibration evidence | 60 SEC filings, cutoff 0.9 splits them in half: 30 high-confidence 27/30 correct (90%), 30 low-confidence 12/30 (40%) | docs.typesafe.ai/cookbooks/classification_using_confidence.md | published, one 75-way task, n=60 |
| Known weaknesses | not reliable at counting or numeric precision; reads dates as text; accuracy falls when state has unrelated content; not hostile-input safe; cannot generate text | docs.typesafe.ai/model-jaggedness/jev-1.13.md | published |
| Speed claim | 70 to 500 ms; 40x to 200x faster than frontier LLMs | search summary, DataCamp/MindStudio result titles, pages not opened | UNVERIFIED |
| Landsteiner benchmark | 37/40 calls with both labels right vs Terra 39/40; median 319 ms vs 1.48 s | `docs/artifacts/jev-community-threads.html` lines 139-140 (thread introducing-jev) | community, 40 synthetic EN/DE calls, AI-made reference |
| Confidence vs correctness | one wrong answer carried 93% confidence | same file line 141 and 281 | community, single anecdote |
| Fannin production data | most accurate setup 2 of 3 facts right, finds 4 in 10; sentence by sentence 7 in 10 found, one third right; LLM reviewer caught 0 wrong answers | same file, accuracy table | community, answer key mostly AI-built |
| Mark: lead qualification sub-1% error | stated, no test shown | same file | community, UNVERIFIED |
| Mark: set confidence cutoff from your own hand-labelled sample; no universal threshold | guidance | same file | community |

Does confidence track correctness? Vendor: yes on one task (90% vs 40% across a 0.9 cutoff, n=60). Community: contradicted by a 93% wrong answer. Ours: not yet measured (see gaps).

## 4. Gaps (not measured)

1. Accuracy against HUMAN labels. All our accuracy numbers use AI-written expected labels (results.md "Not proven"; benchmark "Not established").
2. Confidence vs correctness on our items. Confidence values exist per answer in the raw results but no calibration table (accuracy above vs below a cutoff) has been produced. The raw timing data was not opened, so cannot say whether the fields were saved. UNVERIFIED.
3. Variance: one run per mode. Unexplained gap: 80/90 one-by-one vs 86/90 batched, same items.
4. The actual TokenMax decision (trivial / ordinary / hard prompt difficulty) has never been asked of Jev. Every measured run is a grading task or a D04 self-assessment, not arm C routing.
5. Cost per accepted result end to end. Arm C cost = Jev picker cost + the routed model's cost + fallback calls; none of that is measured. Jev picker cost alone is about $0.000017 per case at 1 question.
6. Long or messy inputs: only short developer answers tested; vendor says accuracy falls with unrelated state.
7. Free tier, billing, real invoice vs computed cost.
8. Rate limit behaviour in practice (429 counts). Our 90 sequential calls ran at about 3 calls per second, far under 1,200 per minute (20 per second) so no test of the limit.

## 5. Smallest live run that closes gaps 2, 3, 4 (proposal, not run)

Script: extend `scripts/jev_d04_layers.py` pattern into `scripts/jev_difficulty_run.py` (dry-run flag first, same `call_jev`, model check, request and response saved).
- Input: 30 coding prompts the operator has already labelled trivial / ordinary / hard (human labels, written before the run), plus a 400-character rule arm at zero spend.
- Jev: 1 question (choice: trivial / ordinary / hard) per prompt, one call per prompt = 30 calls, then the same 30 repeated once = 60 calls total (gives repeat variance). Also 1 batched call of all 30 questions to test the 80 vs 86 gap.
- Record per call: choice, confidence, probabilities, usage, wall seconds.
- Output: agreement with human labels, accuracy above and below cutoffs 0.5 and 0.9, repeat disagreement count, cost.
- Expected spend: about 60 x 400 input tokens x $0.042/M = about $0.001 (my estimate from the 392-token single call, UNVERIFIED until run). Total 61 paid calls, no LLM calls needed for the Jev side.
- Arm A/B costs come from a dated price table applied to token counts, as FLOW.md specifies.
