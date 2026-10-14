# Tester checklist for one complete Backstage run

Test one decision with two possible answers, from question to verdict. Use synthetic or redacted inputs and keep your keys, cases and answers private. You will run Jev, one LLM and a keyword rule, then judge their answers. This tests a fixed decision, not a chat conversation.

## Before you start

- Open https://jevnotjev.breakoutwithai.com/backstage/ and sign in using the invitation instructions. A laptop gives you more room to read; phone use is also worth testing.
- Bring a TypeSafe API key for Jev (from https://console.typesafe.ai/playground) and a key for one model provider for the LLM comparison. Jev-only mode needs only the TypeSafe key; the optional Question coach and case drafting need a model key. Calls and retries are billed to your own accounts. Time and spend depend on your cases, provider and retries; record what you actually observe.
- Use made-up or redacted cases only. No names, emails, account numbers or customer data.
- A shared verdict needs at least 30 paired labelled cases, explained in step 4. Reaching 30 does not guarantee a decisive verdict: missing costs, uncertain differences or other evidence limits can still give "not enough evidence".
- Ready packs P1 to P4 contain 10 cases each: enough to rehearse, below the shared-verdict minimum. P1 labels were approved by a person; P2 to P4 labels were drafted by an agent and need your review. P5 to P8 contain 30 synthetic cases each with no labels. Pick each case yourself to test blind judging. Adding cases or selecting Unsure may leave fewer than 30 eligible pairs.

## Step 1: Write the decision and judging rule

- [ ] Write one question with two possible answers, and the rule you will use to decide which answer is right.
- Where: the setup workspace, `Your question` <!-- source: site/backstage/index.html -->, under `What do you want to decide?` <!-- source: site/backstage/index.html -->.
- Fill in `One question` <!-- source: site/backstage/index.html -->, `First answer` <!-- source: site/backstage/index.html -->, `Second answer` <!-- source: site/backstage/index.html -->, `What the first answer means` <!-- source: site/backstage/index.html -->, `What the second answer means` <!-- source: site/backstage/index.html --> and `Judging rule (required)` <!-- source: site/backstage/index.html -->. Both meanings are required; a run will not start without them.
- **You see:** your question, meanings and judging rule together. `Who answers` <!-- source: site/backstage/index.html --> and `Your cases` <!-- source: site/backstage/index.html --> are on the same setup workspace. A missing input shows a reason beside Run; the Fix action focuses its field.

## Step 2: Add your cases

- [ ] Add your cases, one per line, or import a CSV. If using a ready pack, check its case count before running.
- Where: the section `Your cases` <!-- source: site/backstage/index.html -->. Type into `Cases, one per line` <!-- source: site/backstage/index.html -->, use `Draft starter cases` <!-- source: site/backstage/index.html --> (it needs a `Model provider` <!-- source: site/backstage/index.html --> and `Your model key` <!-- source: site/backstage/index.html --> in the optional Question coach disclosure), or `Import cases CSV` <!-- source: site/backstage/index.html -->.
- **You see:** the line under the cases changes from `No cases yet.` <!-- source: site/backstage/index.html --> to a count of your cases. Pasted starter JSON offers Add with its case count and resulting total, or Replace with its count. Replace asks for confirmation before discarding existing cases and imported labels; Cancel preserves them. Repeated text is kept and reported.

## Step 3: Run Jev, an LLM and a rule on every case

- [ ] Choose Jev, one current LLM and a simple keyword rule, then run every case.
- Where: in `Who answers` <!-- source: site/backstage/index.html --> paste your `TypeSafe API key` <!-- source: site/backstage/index.html -->, tick `Choose optional comparisons` <!-- source: site/backstage/index.html -->, tick one model under `Optional models` <!-- source: site/backstage/index.html --> and enter its provider key in the field that appears. Tick `Include a local keyword rule` <!-- source: site/backstage/index.html --> and enter words in `Literal keywords, one per line` <!-- source: site/backstage/index.html -->.
- Then in `Your cases` <!-- source: site/backstage/index.html --> press Run all with the displayed case count. For a smaller first trial, press `Try first case` <!-- source: site/backstage/index.html -->, then Run remaining with its displayed count. Continuing preserves the first attempt and does not call it again; retries are separate paid actions.
- **You see:** `No calls in progress.` <!-- source: src/backstage/main.ts --> and the run line ending in 0 `have no answer.` <!-- source: src/backstage/main.ts -->. If that number is above 0, some calls remain missing: finish any untouched cases first, then decide whether to press `Retry unfinished calls` <!-- source: site/backstage/index.html --> for failed attempts. Retrying may add charges. If missing answers remain, report a blocker for step 3 before locking retries.

## Step 4: Review the answers blind

- [ ] Pick the right answer for each case yourself, before you see the models' answers.
- Where: the section `Judge the answers` <!-- source: site/backstage/index.html -->. The section `Calibrate first: 5 practice cases` <!-- source: site/backstage/index.html --> contains five shop examples, separate from your question. The screen recommends practice first, but practice is optional and does not block judging: pick an answer or Unsure, read the reference feedback, then press `Next practice case` <!-- source: site/backstage/index.html -->. These picks do not count toward your run or its 30-case minimum.
- The button `Open blind judging and lock retries` <!-- source: src/backstage/main.ts --> appears only after your run has stopped and there are answers to judge; completing practice does not unlock it. Finish retry decisions, press it, then confirm `Finish retrying and judge this fixed set of answers?` <!-- source: site/backstage/index.html -->. You cannot retry after this lock.
- For each run case, press the button with the answer name you chose in step 1. Then press `Next case` <!-- source: site/backstage/index.html --> and repeat. `Unsure` <!-- source: site/backstage/index.html --> records no label for that case and does not count toward the paired minimum; it also replaces any imported label for that case.
- A paired case counts only when both Jev and the comparison have answered that same case and each answer is labelled accepted or rejected. Rejected answers count too. Missing answers and missing labels do not count. Your human picks and imported labels approved by a person can count. Unreviewed agent labels do not count; make your own picks for this test. The Jev-versus-LLM and Jev-versus-rule paired counts can differ.
- When you have reviewed your cases, press `Finish judging and lock labels` <!-- source: site/backstage/index.html -->. You may leave cases unlabelled, but they reduce the paired count.
- **You see:** `Show who answered and lock your labels?` <!-- source: site/backstage/index.html -->; after you confirm, `Cost and downloads` <!-- source: site/backstage/index.html --> shows `Results by comparison` <!-- source: src/backstage/main.ts -->.
<!-- Behavioral provenance: src/backstage/main.ts renderCard; src/backstage/calibration-view.ts mountCalibration; src/backstage/run.ts #importedCall; src/core/metrics.ts paired; src/labels/starter-packs.ts STARTER_PACKS. -->

## Step 5: Reach a verdict

- [ ] Open results and read the verdict.
- Where: `Results and downloads` <!-- source: site/backstage/index.html -->, beside cost and downloads.
- **You see:** a heading for each comparison, with its comparison name followed by a verdict word and a reason. A `Jev-only test` <!-- source: src/backstage/main.ts --> heading means no comparison verdict: it is not a completed three-method run. Return to step 3 with an LLM and rule selected in a new scene.
- Verdict words: `use Jev` <!-- source: src/core/verdict.ts -->, `don't use Jev` <!-- source: src/core/verdict.ts -->, `not enough evidence` <!-- source: src/core/verdict.ts -->.
- "not enough evidence" is a finished comparison run, not necessarily a failure. Read its reason: it may ask for more paired labels or identify another evidence limit. Report that outcome as shown.

## What to send us

Email jev@breakoutwithai.com with only this completion evidence. Use plain text where possible:

- Which steps worked, by step number; where you stopped, if any; browser/device and actual elapsed time.
- Each comparison name and its verdict heading and reason. If you see Jev-only test instead, report that as an incomplete comparison test.
- From `Results by comparison` <!-- source: src/backstage/main.ts -->, copy each method's `Kept / labelled` <!-- source: src/backstage/main.ts --> and `Unlabelled` <!-- source: src/backstage/main.ts --> counts, plus each comparison's `paired labelled cases` <!-- source: src/backstage/main.ts --> and excluded count. Include the method names so we know which numbers belong together.
- The `Cost / kept` <!-- source: src/backstage/main.ts --> figures, one per method, exactly as shown, including unavailable values.
- Spend is optional: copy `Answers-only spend` <!-- source: src/backstage/main.ts --> per method and `Total actual attempts` <!-- source: src/backstage/main.ts --> with both known spend and unknown charges. These are different measures; do not add repeated Jev figures from separate comparisons together.

## Never send

- Any API key, password or account details.
- Your question, case text, private inputs or the models' answers.
- Crop screenshots to exclude the question, case text and key fields, including any revealed answers. Prefer copying the safe headings and counts as text.
- The downloads `Download records.csv` <!-- source: site/backstage/index.html --> or `Download run evidence` <!-- source: site/backstage/index.html -->: both hold your case text. Keep them for yourself.

## Report a blocker

If a step does not work, or you cannot tell whether it worked:

1. Email jev@breakoutwithai.com with the step number and what you saw, with values redacted. Still no keys, passwords, question, case text or model answers.
2. If you prefer a public report, use the [tester-blocker issue template](https://github.com/breakoutwithai/jevnotjev/issues/new?template=tester-blocker.md). Give the step number and redacted screen text; replace values with &lt;value&gt;. GitHub issues are public. Apply the screenshot restrictions above.
<!-- Template provenance: .github/ISSUE_TEMPLATE/tester-blocker.md -->
