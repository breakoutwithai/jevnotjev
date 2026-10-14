# Tester checklist for one complete Backstage run

Use this to test Jev!Jev on one decision of your own, from question to verdict. Each step says what you see on screen when it worked. When you finish, send us only what "What to send us" lists. You keep your keys, your cases and your answers.

Quoted labels come from the Backstage source; each is followed by the source file and line in brackets so we can keep this page in step with the app. A test (`src/docs/tester-checklist.test.ts`) fails if a label moves or changes.

## Before you start

- Backstage is at https://jevnotjev.breakoutwithai.com/backstage/ and needs a sign-in; we tell you how when we invite you.
- Bring your own TypeSafe API key for Jev and, for the LLM comparison, your own key for one model provider. Calls are billed to your own accounts.
- Use made-up or redacted cases only. No names, emails, account numbers or customer data.
- A full verdict needs 30 cases that you label yourself: `A shared verdict needs 30 paired` (`site/backstage/index.html:90`). Fewer cases still run and end in "not enough evidence".

## Step 1: Write the decision and acceptance rule

- [ ] Write one question with two possible answers, and the rule you will use to decide which answer is right.
- Where: the first room, `Your question` (`site/backstage/index.html:42`), under `What do you want to decide?` (`site/backstage/index.html:21`).
- Fill in `One question` (`site/backstage/index.html:25`), `First answer` (`site/backstage/index.html:47`), `Second answer` (`site/backstage/index.html:52`), `What the first answer means` (`site/backstage/index.html:57`), `What the second answer means` (`site/backstage/index.html:63`) and `Keep an answer when...` (`site/backstage/index.html:71`). Both meanings are required; a run will not start without them.
- **You see:** your question and both answers filled in, and `Next room` (`site/backstage/index.html:468`) takes you to `Who answers` (`site/backstage/index.html:151`).

## Step 2: Add your cases

- [ ] Add your cases, one per line, or import a CSV.
- Where: the room `Your cases` (`site/backstage/index.html:251`). Type into `Cases, one per line` (`site/backstage/index.html:261`), use `Draft starter cases` (`site/backstage/index.html:268`) (it needs a `Model provider` (`site/backstage/index.html:102`) and `Your model key` (`site/backstage/index.html:103`) in the Question coach in the first room), or `Import cases CSV` (`site/backstage/index.html:290`).
- **You see:** the line under the cases changes from `No cases yet.` (`site/backstage/index.html:297`) to a count of your cases.

## Step 3: Run Jev, an LLM and a rule on every case

- [ ] Choose Jev, one current LLM and a simple keyword rule, then run every case.
- Where: in `Who answers` (`site/backstage/index.html:151`) paste your `TypeSafe API key` (`site/backstage/index.html:171`), tick `Choose optional` (`site/backstage/index.html:158`) comparisons, tick one model under `Optional models` (`site/backstage/index.html:196`) and enter its key (`A key field appears below for each provider` (`site/backstage/index.html:192`)), and tick `Include a local` (`site/backstage/index.html:199`) keyword rule with words in `Literal keywords, one per line` (`site/backstage/index.html:237`).
- Then in `Your cases` press `Run all cases` (`site/backstage/index.html:321`).
- **You see:** `No calls in progress.` (`src/backstage/main.ts:548`) and the run line ending in 0 `have no answer.` (`src/backstage/main.ts:541`). If that number is above 0, some calls failed: press `Retry unfinished calls` (`site/backstage/index.html:324`) once, and if it stays above 0, report a blocker for step 3.

## Step 4: Review the answers blind

- [ ] Pick the right answer for each case yourself, before you see the models' answers.
- Where: the room `Judge the answers` (`site/backstage/index.html:335`). Start with `Calibrate first: 5 practice cases` (`site/backstage/index.html:338`). Then press `Open blind judging and lock retries` (`src/backstage/main.ts:725`) and confirm `Finish retrying and judge this fixed set of answers?` (`site/backstage/index.html:372`).
- For each case, press the button that carries your answer name (`card?.choices[0]` (`src/backstage/main.ts:692`) for the first answer, and the second answer beside it). Then press `Next case` (`site/backstage/index.html:393`) and repeat until the last case.
- When every case has your pick, press `Finish judging and lock labels` (`site/backstage/index.html:399`) and confirm.
- **You see:** the question `Show who answered and lock your labels?` (`site/backstage/index.html:411`); after you confirm, `Cost and downloads` (`site/backstage/index.html:430`) shows `Results by comparison` (`src/backstage/main.ts:601`).

## Step 5: Reach a verdict

- [ ] Open the last room and read the verdict.
- Where: the room `Verdict` (`site/backstage/index.html:452`).
- **You see:** one heading per comparison that ends in the verdict word, `pair.verdict.verdict` (`src/backstage/main.ts:651`): `use Jev`, `don't use Jev` or `not enough evidence` (the possible values of `VerdictName` (`src/core/verdict.ts:21`)), with the reason under it.
- Verdict words: `use Jev`, `don't use Jev`, `not enough evidence`.
- "not enough evidence" is a finished run, not a failure. It usually means fewer than 30 labelled cases: `30 paired, human-labelled cases` (`site/backstage/index.html:460`).

## What to send us

- A screenshot of the verdict heading, or the verdict line copied as text.
- The `Cost / kept` (`src/backstage/main.ts:623`) figures from `Results by comparison`, one per method.
- Which steps above worked, by step number, and how long the run took.

## Never send

- Any API key, password or account details, including a screenshot that shows a key field.
- Case text, the private details behind your question, or the models' answers.
- The downloads `Download records.csv` (`site/backstage/index.html:434`) or `Download run evidence` (`site/backstage/index.html:436`): both hold your case text (`Treat case text` (`site/backstage/index.html:447`)). Keep them for yourself.

## Report a blocker

If a step does not work, or you cannot tell whether it worked:

1. Open a GitHub issue with the template `.github/ISSUE_TEMPLATE/tester-blocker.md` (label `tester-blocker`) at https://github.com/breakoutwithai/jevnotjev/issues/new?template=tester-blocker.md. Give the step number from this page and what you saw. Replace any value from your cases with `<value>`. GitHub issues are public.
2. For anything private, email `jev@breakoutwithai.com` (`site/backstage/index.html:227`) instead, with the step number. Still no keys, passwords or case text.
