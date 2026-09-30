# TokenMax: builder time and effort (D05 research)

> **Research record, 2026-09-29.** Kept as written, apart from private file paths replaced with a note. Where it describes a routing question (trivial / ordinary / hard prompts sent to Haiku, Sonnet or Opus), that premise was dropped on 2026-09-28 and is history, not a plan: see `docs/decision/verdict-rules.md` and `FLOW.md` for the current method. Prices were re-checked on 2026-09-30 against first-party pages and three price lists: 12 of 12 listed models unchanged.


Sources opened 2026-09-29. `FLOW.md` and `format/README.md` read from `origin/main` of jevnotjev.
Labels: MEASURED = number in a file I opened (cited). UNVERIFIED = my estimate, basis stated.
Results file cited as `timing:` = a private timing results file (not published; the public summary is `docs/benchmarks/2026-09-27-grading-speed-cost.md`).
Benchmark cited as `bench:` = jevnotjev `docs/benchmarks/2026-09-27-grading-speed-cost.md` (origin/main).

## 1. Builder journey, minutes per step (FLOW.md:13-18)
Assumes short text cases (prompt-length), a local runner script already exists, one decision, 3 arms.
Ambient assumption: a person labels an output in about 20 s under a written rule (UNVERIFIED, see below).

| Step (FLOW.md line) | n=20 | n=50 | Status and basis |
|---|---|---|---|
| 1. Describe decision and answer set (:14) | 5 | 5 | UNVERIFIED. One question, 3 answers (trivial/ordinary/hard, FLOW.md:8). |
| 2a. Write or collect cases (:15) | 15 | 30 | UNVERIFIED. 45 s per case if pasted from real logs, more if invented. Synthetic or redacted only (FLOW.md:11). |
| 2b. Write the simple rule before results (:15) | 5 | 5 | UNVERIFIED. One line, e.g. under 400 chars to Haiku (FLOW.md:25). |
| 3a. Runner setup, keys, mapping, cutoff (:16) | 15 | 15 | UNVERIFIED. First run only; arm C needs question, answer set, mapping, cutoff (FLOW.md:25). Zero if the tool ships the runner. |
| 3b. Run arms | 2 | 4 | Derived from MEASURED per-item latency: Jev 327 ms/item sequential, LLM 3.1 to 7.6 s/item (timing:20-37). 20 cases: Jev 7 s, one LLM arm 1 to 2.5 min; 50 cases: 16 s and 2.6 to 6.3 min. LLM figures include `claude -p` start-up (timing:50). |
| 4. Label every picked output (:17) | 20 | 50 | UNVERIFIED. Rows to label up to 3 x n (60 / 150); picks that repeat across arms need labelling once per distinct output. 20 s each, no dedupe: 20 min / 50 min. Dedupe would cut this by an unmeasured amount. |
| 5. Load CSV, read verdict (:18) | 2 | 2 | UNVERIFIED. Local page, one file. |
| Total, first run | 64 | 111 | Sum of the above. |
| Total, tool ships runner (3a = 0) | 49 | 96 | Sum. |

Labelling is 31% of the total at n=20 and 45% at n=50. Case writing is the second largest.
Human labelling time is NOT measured anywhere: timing:53-54 says "Part B (human judgement): Not run. B1 and B10 need the operator and a stopwatch."
Verdict rule needs at least 10 labelled cases (FLOW.md:46), so n=20 already clears the floor by 2x.

## 2. Our measured timings
| Fact | Value | Cite |
|---|---|---|
| Jev, one call, one item | 0.3 s, $0.000016 | timing:20 |
| Jev, 10 sequential calls | 3.5 s (351 ms/item) | timing:21 |
| Jev, 90 sequential calls | 29.4 s (327 ms/item), $0.0015, $0.000017/item | timing:22 |
| Jev, 90 items in one call | 0.4 s, $0.0006 | timing:24, bench:8 |
| Haiku 4.5, single / seq90 | 5.3 s / 683.4 s (7,593 ms/item), $0.002441 / $0.003772 per item | timing:25,27 |
| Sonnet 5, single / seq90 | 3.6 s / 280.6 s (3,118 ms/item), $0.001454 / $0.001912 per item | timing:30,32 |
| Opus 5.5, single / seq90 | 2.6 s / 273.9 s (3,043 ms/item), $0.005144 / $0.005511 per item | timing:35,37 |
| Batch of 90, LLMs | Haiku 93.0 s, Sonnet 52.6 s, Opus 17.3 s | timing:8-14 |
| Grading accuracy vs AI-written labels, batch90 | Jev 86/90, Haiku 87/90, Sonnet 86/90, Opus 88/90 | timing:9-13 |
| Jev one by one | 80/90 (lower than batched 86/90; cause not established) | timing:24,43 |

Caveats stated in the source: labels AI-written, one run per mode, LLM times include CLI start-up, short inputs only (timing:47-51).
These are GRADING timings (accept/reject a given answer), not the TokenMax arm task (typed routing decision plus the picked model call).
The routing question's own latency and the picked model's call are not measured. Jev and LLM arm times above are a proxy.
`docs/benchmarks/` on origin/main holds one file only (`git ls-tree`: `2026-09-27-grading-speed-cost.md`); it repeats the same numbers (bench:5-19).

## 3. Comparable tools (fetched 2026-09-29; fetched through a summarising fetch tool, so wording is a summary, not verbatim)
| Tool | Default sample size | How labels are collected | LLM-as-judge pre-label | Cost display | URL |
|---|---|---|---|---|---|
| promptfoo | No default; you define cases (YAML, CSV, JSON, JSONL, XLSX, scripts). `generate dataset` (beta): 5 personas x 3 cases = 15 default | Assertions; page did not mention a human rating UI | `llm-rubric` returns JSON with reason, score, pass; default grader by available key (gpt-5, claude-sonnet-5, gemini-2.5-pro, mistral-large-latest) | Not stated on pages read | promptfoo.dev/docs/configuration/test-cases/ ; .../expected-outputs/model-graded/llm-rubric/ ; promptfoo.dev/docs/usage/command-line/ |
| OpenAI Evals | No minimum stated | JSONL with `ideal` answers; "choice labels" (human annotations) used to validate model-graded evals | Model-graded eval templates | Not stated | github.com/openai/evals/blob/main/docs/build-eval.md |
| Braintrust | Not stated on pages read | Review panel, inline playground annotation, production user feedback; categorical (0 to 100%), continuous slider, free text | LLM-as-a-judge scorers in offline and online evals; pre-fill of human review not addressed | Not stated on pages read | braintrust.dev/docs/guides/human-review ; braintrust.dev/docs/evaluate |
| LangSmith | Not stated on pages read | Annotation queues and human feedback (named, no detail on page) | LLM-as-judge evaluators, pairwise | Not stated on page read | docs.langchain.com/langsmith/evaluation (redirect from docs.smith.langchain.com) |
| DeepEval | Not stated | Metrics not human labels; "classifiers for categorical labeling" | 30+ LLM-judge metrics; `Synthesizer` makes goldens from documents | Not stated | deepeval.com/docs/evaluation-introduction (redirect from docs.confident-ai.com) |

Findings across the five:
- None of the pages read state a default or recommended n, except promptfoo's generator (15 cases). UNVERIFIED for any hidden guidance on other pages.
- All five put the judge on the LLM side and treat human labels as a separate, heavier workflow; none of the pages read described a "judge pre-fills, human confirms" flow. TokenMax's FLOW.md:10 rule (Jev pre-grade may pre-fill, a person confirms) is not seen in these pages. Not proven absent in product UIs.
- None of the pages read showed cost per accepted result. Cost per kept answer is TokenMax's own metric (FLOW.md:37).
- Not fetched: pricing pages, product UIs, changelogs. Fetch-tool summaries can omit features, so "not stated" is not "absent".

## 4. Builder time versus API dollars
Time value is an assumption: USD 50 per hour (UNVERIFIED, stand-in for a builder; change it and the ratio scales linearly).
API cost uses MEASURED per-item grading costs as a proxy for per-item call cost (timing:22,27,32,37); the picked-model call may cost more or less.

| | n=20 | n=50 |
|---|---|---|
| Jev arm API cost (USD 0.000017 x n) | 0.00034 | 0.00085 |
| Sonnet arm (0.001912 x n) | 0.038 | 0.096 |
| Opus arm, priciest proxy (0.005511 x n) | 0.110 | 0.276 |
| All three arms, worst case (Jev + Opus + Opus-priced current LLM) | about 0.22 | about 0.55 |
| Builder time, first run (64 / 111 min at USD 50/h) | 53 | 93 |
| Labelling alone (20 / 50 min) | 17 | 42 |
| Ratio, time to worst-case API | about 240x | about 170x |

- Even labelling alone is 80x to 150x the worst-case API bill for all arms (17 / 0.22, 42 / 0.55).
- The costs per call are fractions of a cent (Jev USD 0.000017, LLM USD 0.0015 to 0.0055 per item), so cost per accepted result will be dominated in the builder's real budget by their time.
- Honest framing: TokenMax's metric excludes labelling time (FLOW.md:41 "reported, not added to spend"). Correct for a per-call comparison; incomplete for the builder's decision whether the test is worth running.
- If time per label were 5 s (confirm a pre-filled label, UNVERIFIED), labelling at n=50 is 12.5 min, cutting the total to about 74 min. That is the main lever and is unmeasured.

## 5. Top 3 friction points and what to automate first
1. Labelling (20 to 50 min of 64 to 111). Automate: pre-fill labels with a grader (Jev batch grading measured at 0.4 s and USD 0.0006 for 90, timing:8-9), dedupe identical outputs so each is labelled once, show blind to arm (FLOW.md:10), keyboard accept/reject with one written rule pinned on screen, and default the rows whose arms agree. Measure human seconds per label with a stopwatch first (timing:53-54 is the gap).
2. Writing cases (15 to 30 min). Automate: import from a pasted log or CSV column, redaction check, and suggest rule candidates. Do not synthesize cases with an LLM silently; FLOW.md:11 requires synthetic or redacted cases and claims hold for the builder's set only.
3. Runner setup and running three arms outside the tool (15 min setup, first run only, FLOW.md:16). Automate: ship the runner that writes `jnj-record/1` directly (18 columns, format/README.md:29-47), including `tokens_in`, `cost_usd`, `latency_ms`, so no hand-copied usage numbers; batch Jev calls (timing:42).
Order: 1, then 3, then 2. Reason: 1 is the largest block and scales with n, 3 removes a fixed cost and the error-prone hand entry of costs (a missing cost turns an arm to `cost=incomplete`, format/README.md:50-52), 2 is partly the builder's own domain knowledge and hard to automate safely.

## Implication for how many cases to ask for
- n=20 fits a 90-minute session even on a first run (64 min UNVERIFIED); n=50 does not unless the runner ships and labels are pre-filled.
- Suggested ask: 20 cases as default, 10 as the floor (FLOW.md:46), 50 only as an opt-in second round. UNVERIFIED: no source gives the n needed for a stable verdict; with 20 cases one label flip is 5 percentage points of accept rate.

## Not proven
- Human seconds per case and per label: unmeasured.
- Routing-task latency and picked-model call cost: unmeasured; grading timings used as proxy.
- Competitor docs: summaries from a fetch tool over selected pages, not full product review.
