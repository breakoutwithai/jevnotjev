# Try one decision in Jev!Jev

Use this handoff to try one small decision test and identify where the instructions or interface become unclear. You can decline or stop at any point. Sharing results is optional, and so is feedback.

## Your task

Test one question with two possible answers using made-up cases. Follow the [tester checklist](https://github.com/breakoutwithai/jevnotjev/blob/main/docs/uat/tester-checklist.md) for the detailed steps and observable results. The [live guide](https://jevnotjev.breakoutwithai.com/guide/) explains the workspace.

1. Write your question, both answer meanings and the rule you will use to judge answers. If you need a synthetic example: “Does this message explicitly ask for a refund or money back?” Answer yes for explicit refund requests, including conditional requests; answer no for policy questions, exchanges, complaints without a request and statements declining a refund.
2. Add synthetic cases, check the case count and select Jev. For a comparison verdict, also select one model and the local keyword rule. These are optional for a first-case rehearsal.
3. Choose a first-case rehearsal or a full run, then check the estimate before starting. For the rehearsal, run the first case and check that the cells processed count reaches the selected total, 0 calls have no answer, and “No calls in progress.” appears; otherwise note the visible error or missing-answer count. Stop there. The answer stays hidden until you make a blind pick for that case; opening judging is optional for this rehearsal. For a full run, run all cases. A completed first-case rehearsal is not a completed full run. If you later choose a fresh full run, preserve any evidence you want to keep first and expect new paid calls, including the first case again. Stop if the controls or charges are unclear; reporting a blocker is optional.
4. Finish any retry decisions, then judge each case yourself before revealing which method answered. An uncertain pick is allowed. A comparison verdict needs at least 30 paired, person-reviewed cases; fewer cases can still test the workflow.
5. Reveal the results and read the verdict and its reason. “Not enough evidence” is a valid outcome. A Jev-only rehearsal does not produce a comparison verdict. Keep downloads private.

## Time and what to bring

Expected time: 60 minutes. This is a planning estimate, not a measured completion time: no outside tester has timed a full run yet. You may choose only the first-case rehearsal; the full comparison is optional. Note the time you actually spend if you choose to give feedback.

Bring a browser, one binary decision and synthetic or redacted cases. Bring your own TypeSafe API key for Jev from the [TypeSafe Playground](https://console.typesafe.ai/playground). A model comparison, question coaching or model-generated starter cases additionally needs a model provider key. The local keyword rule needs no provider key.

Calls and retries are charged to your own accounts. Choose your own spending limit before starting, check the estimate and stop if it exceeds that limit. Estimates are not an invoice or a guaranteed cap. Enter credentials only in the workspace's key fields; do not send them to us.

## Get access before starting

Open the [workspace](https://jevnotjev.breakoutwithai.com/backstage/) using the maintainer's access instructions. An operator must approve your address and tell you which sign-in method to use: email and password, or Continue with Google for an invited address. This handoff does not grant access.

If you have not received access instructions, ask the maintainer before setting up paid calls. The public guide also describes the access-request form on the sample page; submitting that request does not grant access or mean you have agreed to test. With your consent, that form stores your email, optional website and idea, and ticket details in a database on our server. Do not put private case text or provider keys in the request form.

## Keep your data private

Use synthetic or redacted data only: no real names, emails, account numbers, personal data or customer data. Your cases, question, definitions and provider key pass through our server to each selected model provider; the server reads the key in memory to relay the call and does not save it. The local keyword rule makes no provider call. If you use the question coach, your question and coach key go through our server to Anthropic or OpenAI, whichever you choose. Generating starter cases sends the scene question, both answer names and their meanings, and your coach key to that chosen provider through our server. Providers and infrastructure may retain data under their own policies.

Backstage does not save cases, questions, answers, runs or provider keys to server files or databases. That does not mean nothing is recorded: account/session details, operational logs and other data described in [How we handle data](https://jevnotjev.breakoutwithai.com/privacy/) can be kept. The web server may buffer requests briefly, and provider retention is not guaranteed by this application.

The unfinished question and cases are saved in this browser tab's storage and can survive a reload. The active run and keys are in page memory; reloading or closing the page loses the run. To remove the draft, sign out or close the tab. Downloaded files remain your own copies. Do not submit private data to test these boundaries.

## If you get stuck or want to share feedback

Sharing results is optional, and so is feedback. You can stop without sending anything. If you choose to report a blocker, email jev@breakoutwithai.com with the checklist step or task you attempted, what you expected, the redacted message you saw, and your browser/device. This does not require completing the test.

For a public report, the [tester-blocker template](https://github.com/breakoutwithai/jevnotjev/issues/new?template=tester-blocker.md) asks for the same safe details. GitHub issues are public.

Never send keys, passwords, account details, your question, case text, model answers or raw exports. Crop screenshots to remove those fields; plain redacted text is safer. If you choose to report completion, send the checklist step outcomes, browser/device and actual elapsed time, comparison verdict headings/reasons and aggregate counts/cost availability as described in the checklist. Keep records and run-evidence downloads to yourself.
