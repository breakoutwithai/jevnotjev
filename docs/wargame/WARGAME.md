# Jev!Jev delivery and test wargame

Status: draft for review. Repository state read at `origin/main` `8781d23` (`breakoutwithai/jevnotjev`). Every `path:line` below is at that commit unless it says otherwise. Anything not read from a file or a live probe is marked UNVERIFIED. Unresolved inputs are written as `(variable)` and collected in the ledger at the end.

## Cold start (read this first if you have no context)

- **Product.** Jev!Jev compares three ways of answering one typed decision on a builder's own cases: their current LLM (`llm`), a simple rule written in advance (`rule`) and Jev (`jev`). A person marks each answer accept or reject, blind to which method gave it, and the tool reports cost per accepted answer and a verdict: use Jev, don't use Jev, or not enough evidence (`FLOW.md:3`, `FLOW.md:11`, `FLOW.md:28-32`).
- **Verdict law.** `docs/decision/verdict-rules.md:53-69`. Fewer than 30 paired labelled cases is always "not enough evidence" (`verdict-rules.md:58`). At 30 cases "not enough evidence" is the most common outcome by design (`verdict-rules.md:94`).
- **Two surfaces on the live site.**
  - The Stage (`/`): public, loads a `jnj-record/1` CSV in the browser, no key, 5 MB cap (`src/browser/results-loader.ts:14`, `FLOW.md:23`).
  - Backstage (`/backstage/`): behind a tester sign-in; bring-your-own-key runner. Jev only is the default; comparisons with Anthropic, OpenAI, Google or xAI models are opt-in, one key per provider; an optional keyword rule; blind labelling; CSV and evidence JSON download (`backstage.md:3-5`, `backstage.md:24-32`).
- **Deploy.** `.deploy/ship.sh`, two modules (static, backstage), each with its own verify and rollback (`.deploy/ship.sh:5-25`, `docs/DEPLOY.md:24-25`). Run from a clean worktree pinned to `origin/main` (`docs/DEPLOY.md:160-167`). Live checks are seams S1 (served SHA equals main, release tag), S2 (gate security) and S3 (co-tenants unchanged) (`docs/DEPLOY.md:197-199`).
- **Test gate.** `bun scripts/gate.ts` runs every Bun and shell suite and fails if any file passes fewer tests than its committed floor (`scripts/gate.ts:1-7`). Floors at `8781d23`: 68 files, 1,394 tests (`.deploy/tests/expected-counts.json`, summed).
- **Today's position (probed 2026-10-07, read-only HTTP).**

| Fact | Evidence |
|---|---|
| Served static build is `96f5b14`, three merges behind main (`df2892b` #112, `655f60a` #114, `8781d23` #113) | `curl /DEPLOYED_SHA` returned `96f5b149b18374d437988bb330b3ef54a27884d0`; `git log 96f5b14..8781d23` |
| The pending diff touches both modules: `src/backstage`, `site/backstage`, `src/core`, `src/browser`, `site` (37 files) | `git diff --stat 96f5b14 8781d23` |
| Public paths `/`, `/label/`, `/little-shop/`, `/results-loader.js` answer 200; `/backstage/` 302; `/api/backstage/health` 401 | curl status codes, matching S2 (`docs/DEPLOY.md:198`) |
| No verdict has yet come from labels a person made blind on a real workflow. The shop-bot run's labels were drafted by three AI labellers and approved by a person; the TokenMax run is unlabelled at 5 paired cases | `docs/product/runs/2026-10-01-uc13-shop-bot/LABELS.md:5-8`; `docs/product/runs/2026-10-03-tokenmax/README.md:9` |
| No outside builder has run a comparison end to end | UNVERIFIED as a negative: no run folder under `docs/product/runs/` other than the two above |
| No browser automation is committed | `git grep -l "playwright\|puppeteer\|chromium\|happy-dom"` at `8781d23` returned nothing; the loader DOM test uses fakes, "no browser" (`src/browser/results-loader.dom.test.ts:1-2`); open decision D4 (`docs/spec/spec.md:160`) |

## Destination

A real builder, unaided, takes one typed yes/no decision from their own project, has Jev, a simple rule and their current LLM answer the same cases, labels the answers blind, and gets a verdict with its numbers and limitations. The team can prove that with executed, repeatable tests on the served build.

## Milestones

| Milestone | Capability green when |
|---|---|
| M0 - Gate stable on main | `bun scripts/gate.ts` prints `gate: PASS` with files and tests at or above floor on 5 consecutive full runs of the main SHA (closes #115) |
| M1 - Served build equals main | `ship.sh --verify <main SHA>` exits 0; S1, S2, S3 all PASS; release tag on origin is on the main SHA |
| M2 - Rollback rehearsed | each module rolled back to the previous verified release and forward again, `--verify` exit 0 after each step |
| M3 - Production UAT executed on the served SHA | scripted browser run on the live URL passes every positive check and every negative control fails as designed; report names the served SHA |
| M4 - Live provider traces | one Backstage comparison run with real keys: requested vs returned model ids, usage, cost and failed-attempt spend recorded in the evidence JSON; an invalid-key control fails only its arm |
| M5 - First blind human-labelled verdict | 30 or more paired cases labelled by a person blind to arm, no AI pre-drafting; verdict, numbers and limitations reproduce from the downloaded CSV in `bun run validate` and the Stage loader |
| M6 - A team member's own workflow, unaided | a team member who did not build Backstage runs one decision from their own project end to end without help; friction log committed |
| M7 - Outside builder run, unaided | a builder outside the team completes the journey on the live site and returns CSV and evidence JSON that reproduce the verdict |
| M8 - Release | release tag on the SHA that passed M3 to M7; definition of done (below) all true |

Order rationale, with the edge each one rests on:

- M1 before M3: UAT must run on the build users get. Today served (`96f5b14`) differs from main (`8781d23`), so a UAT now tests code that main no longer holds.
- M2 before M6 and M7: a release in front of real users needs a rehearsed way back.
- M5 is independent of M6 and M7 in code. It comes first because it is the first time the verdict meets real labels, and a surprise there should be found by the team, not by a visitor.
- M0 is parallel to everything; it gates M8 only. No milestone depends on #109/#110 (training data), #77 (Google sign-in), #11 or #18/#19.

## Moves

Each move: action, expected observation, what failure looks like, likely reaction, counteraction, forks.

### M0 - Gate stable

**Move 0.1 Run the full gate 5 times on main.**
- Action: `bun scripts/gate.ts` in a clean worktree on the main SHA, five times in a row, nothing else running.
- Success looks like: five `gate: PASS files=<n> tests=<n>` lines, n at or above 68 files and 1,394 tests.
- Failure looks like: `scripts/backstage-package.test.ts: 39 passed, floor 40` on some runs (#115).
- Likely reaction: a test exceeds Bun's default 5 s timeout under load (#115, cause UNVERIFIED).
- Counteraction: find the slow test with `bun test scripts/backstage-package.test.ts --timeout 60000` and timing output; give it an explicit timeout or make it faster in its own PR; re-run 5 full gates.
- Fork: if it only fails with concurrent gates, record "gate requires an idle machine" in the gate header and add a check; if it fails idle, it is a real defect and blocks M8.
- Never: lower the floor to pass.

### M1 - Deploy main

**Move 1.1 Read the whole deploy path before the first attempt.**
- Action: read `.deploy/ship.sh`, `.deploy/deploy.sh`, `.deploy/backstage-deploy.sh`, `.deploy/verify-lib.sh`, `docs/DEPLOY.md`, `docs/backstage-deploy.md` end to end.
- Expected: a list of every gate the deploy will hit, written down before running anything.

**Move 1.2 Status and dry run from a clean worktree.**
- Action: `git fetch origin main --no-tags`, a detached worktree at `origin/main`, then `.deploy/ship.sh --status` and `.deploy/ship.sh --dry-run` (`docs/DEPLOY.md:160-167`).
- Expected: `--status` exits 3 (drift) for both modules, served `96f5b14`, main `8781d23` (`ship.sh:61`); the dry run prints the plan and the tag it would create.
- Predicted reaction (grounded): the Backstage module refuses. `.deploy/backstage-deploy.sh:41` requires a merged main PR for HEAD whose body matches `#67`. HEAD `8781d23` came from PR #113, whose body does not contain `#67` (checked with `gh pr view 113`). Issue #91 records the same refusal for an earlier PR.
- Counteraction, route A (preferred): fix #91 in its own PR (require a merged main PR, drop the fixed issue number, with the test in #91's acceptance table), merge, then deploy the new main.
- Counteraction, route B (fast, used once before per #91): add `Refs #67` to the body of the PR that produced HEAD. Choose B only if A cannot land before the deploy is needed; open nothing else.
- Fork: if `--status` shows only one module drifting, deploy only that module with `--module`.

**Move 1.3 Deploy.**
- Action: `.deploy/ship.sh` (all modules) from the clean worktree.
- Expected: exit 0; the closing verify prints PASS for every S1 and S2 assertion; `/DEPLOYED_SHA` and `/api/backstage/health` `version` both return the main SHA; a new `vYYYY.MM.DD.N` tag on origin (`docs/DEPLOY.md:197`).
- Failure looks like: exit 4 (partial deploy refused), 5 (deployed, tag failed, recovery command printed) or 6 (live verify failed) (`ship.sh:61-62`).
- Counteraction per code: 5, run the printed recovery command, nothing else; 6, read the FAIL lines, then decide between fix-forward and Move 2.x rollback; 4, read why and do not force.
- Never: trust exit 0 alone. Done means the served SHA equals what you shipped.

**Move 1.4 Co-tenant check.**
- Action: confirm S3 passed (no other `server_name` on the host changed status across the deploy, `docs/DEPLOY.md:199`).
- Likely reaction: a neighbour changes status. Setup re-probes neighbours and restores the vhost on a change (`docs/backstage-deploy.md:48`).
- Counteraction: if the neighbour was already failing before the deploy (compare with the pre-deploy probe), record it and continue; if it changed because of the deploy, roll back the module (Move 2.1) and stop.
- Abort: any co-tenant down after a rollback. Escalate to the host owner; do not restart services to recover.

### M2 - Rollback rehearsal

**Move 2.1 Roll each module back and forward.**
- Action: `.deploy/ship.sh --module static --rollback --dry-run`, then without `--dry-run`; `.deploy/ship.sh --module backstage --rollback <full 40-char SHA of the previous verified release>` (`docs/DEPLOY.md:24-25`, `ship.sh:111-117`). Then roll forward by re-promoting main the same way: `.deploy/ship.sh --module backstage --rollback <main SHA>` (a fresh deploy of an already verified release is refused, `.deploy/backstage-deploy.sh:77`, `.deploy/backstage-lib.sh:71`), and redeploy static (Move 1.3).
- Expected: after rollback, `--verify` passes with the old SHA; after roll-forward, with main.
- Failure looks like: no previous verified release on the host; or the session gate refuses the target because it does not declare `"gate": "session"` (`docs/DEPLOY.md:40`).
- Counteraction: if the previous release predates the session gate, it is not a valid rollback target for the Backstage module. Record the oldest valid target and test rollback to it instead. Rolling back past the session gate would reopen the old gate and is an abort, not a workaround.
- Second-order: a static rollback alone leaves the Stage and Backstage on different SHAs. Both must be checked with `--status` after every rollback.

### M3 - Production UAT on the served SHA

**Move 3.1 Decide the browser tool (open decision D4, `docs/spec/spec.md:160`).**
- Fork A: adopt a headless browser as a dev dependency for a scripted UAT. Repeatable; adds a dependency.
- Fork B: keep `bun test` with DOM fakes plus a manual run with screenshots. No new dependency; not repeatable by a machine.
- Recommendation: A, scoped to a `uat/` script that only reads the live site and never runs in the gate. Only A meets "executed, repeatable tests on the served build". `(variable) BROWSER_UAT_TOOL`.

**Move 3.2 Commit the UAT evidence convention (#101).**
- Action: land `docs/uat/README.md` and the `/_evidence/uat/` ignore line with a test that fails on a tracked file under `_evidence/` (#101 acceptance). The README is untracked in the primary checkout today and not on main.
- Why first: outside testers' returned files need a home that cannot be committed by accident.

**Move 3.3 Stage loader UAT, served SHA pinned.**
- Action: the script first reads `/DEPLOYED_SHA` and refuses to run unless it equals the SHA under test. Then it loads files and asserts the page.
- Positive checks (expected values come from committed fixtures and `docs/spec/spec.md`, never from the page):
  - The format example loads VALID with its committed gap count (`README.md:41`).
  - A 30-plus-case fixture gives each of the three verdicts, and the page shows the rule that fired, the numbers it read and the "this test set only" sentence (`spec.md:68-72`, R7).
  - Loading a second file replaces every number from the first (R12.c, `spec.md:96`).
- Negative controls (each must fail visibly, or the check is broken):
  - An empty file, a header-only file and a non-CSV file each show a named error and no result (R12.a).
  - A file over 5 MB is refused before parsing (`results-loader.ts:14`).
  - A file with only rule rows reads "not enough evidence: no Jev results", never "don't use Jev" (R12.b, `verdict-rules.md:84`).
  - Network log during load: zero requests carry file content (R2.c, `spec.md:32`).
  - A mutated fixture (one accept flipped to reject) must change the numbers. Unchanged numbers mean the page is showing a cached sample (R7.d, `spec.md:72`).
- Success looks like: a report with served SHA, browser and version, viewport, each check PASS/FAIL, and screenshots stored under the evidence folder.

**Move 3.4 Backstage UAT, served SHA pinned.**
- Action: sign in as a test account; record `/api/backstage/health` `version` (the page does not show it yet, #100; the health endpoint is enough today).
- Positive: write a question, add cases by CSV import (`case_id,case_input`, `backstage.md:24`), run Jev only, open labelling, label, finish, download CSV and evidence JSON; load the CSV in the Stage and get the same numbers.
- Negative controls: anonymous `/backstage/` 302 and API 401 (S2); a tampered cookie still 302/401 (`docs/DEPLOY.md:198`); a malformed case CSV names line, problem and fix (`src/backstage/run.test.ts:933`); a run with every call failing still allows evidence download and the CSV holds only its header (`backstage.md:32`); after sign-out, Back does not show keys.
- Fork: if the downloaded CSV and the Stage disagree on any number, stop M3 and file a defect. The two surfaces share `src/core`, so a disagreement means one of them is not running the code you think.

### M4 - Live provider traces

**Move 4.1 One small comparison run with real keys.**
- Action: Backstage, comparison mode, Jev plus one LLM provider plus the keyword rule, the first-case pilot first, then 5 cases (`backstage.md:24`). Keys are the operator's, typed into the key field only (`docs/backstage-deploy.md:53`).
- Expected: the evidence JSON holds requested and returned model ids separately, usage tokens, cost from the dated catalog, and failed-attempt spend apart from answer spend (`backstage.md:22`, `backstage.md:26`, `FLOW.md:52-53`).
- Failure looks like: a returned model id differs from the requested one; cost shown as unknown (unmapped rate, `backstage.md:26`); a provider rate limit or 5xx.
- Counteraction: a model id mismatch is recorded as is and the arm is labelled with the returned id; never relabel it to match the request. Unknown cost makes that comparison accuracy-only; record it and add the rate to the catalog in a PR. A provider error is retried by hand only (there is no automatic retry, `backstage.md:22`), and its possible charge stays in the evidence.
- Negative control: a deliberately invalid key for the second provider fails only its arm; Jev and the rule continue (`backstage.md:5`).
- Second-order: the Jev price ($0.042 per million input tokens, output free) is a published price not yet checked against a bill (`docs/product/runs/2026-10-03-tokenmax/README.md:25`). Compare the run's computed spend with the provider dashboards after M4. A gap above `(variable) COST_TOLERANCE` blocks any "use Jev" claim on cost until it is explained.

**Move 4.2 Key-handling canary.**
- Action: run once with a unique, invalid canary key per provider, then search the Backstage service log and the proxy logs on the host for the canary strings (read-only).
- Expected: zero matches.
- Failure: any match means a key reached a log. Abort condition A3.

### M5 - First blind human-labelled verdict

**Move 5.1 Fix the test before seeing any answer.**
- Action: pick one yes/no decision (`(variable) M5_DECISION`; default: one TokenMax question over 30 or more fictional CVs, the smallest slice of #60). Write the acceptance rule, the keyword rule and 30 or more cases, commit them with a SHA-256 of the inputs before any arm runs.
- Likely reaction: cases written with the answer key in view, or keywords tuned after labels, so the run validates and is biased towards the rule (#60, "smallest change that passes while wrong").
- Counteraction: cases written by someone who cannot see answers; the rule is frozen in the same commit as the cases; the input hash is in the evidence JSON.

**Move 5.2 Label blind.**
- Action: one person labels every answer in Backstage blind labelling, which hides comparison identities until reveal (`backstage.md:30`). No AI draft, no pre-fill. Time the session.
- Expected: 30 or more paired labelled cases, labelling time recorded (open at `verdict-rules.md:101`).
- Failure: the labeller can tell arms apart by style (Jev returns a short typed answer; an LLM may add prose).
- Counteraction: the labeller writes, before reveal, which arm they believe each answer came from on a sample of 10; if they are right on 8 or more, blinding failed for that run and the verdict is recorded as "labels not blind".

**Move 5.3 Reproduce the verdict three ways.**
- Action: Backstage reveal, the Stage loader on the downloaded CSV, and a command-line verdict on the same CSV. Prerequisite: `bun run validate` reports format, counts and costs only (`src/format/cli.ts:31`) and `scripts/result-view.ts` reads a fixed file, so a CLI that prints the verdict for a given CSV is built first (UNVERIFIED until it exists).
- Expected: same verdict, same paired n, same intervals on all three (resampling is seeded from file content, R13.a, `spec.md:99`).
- Fork: if the verdict is "not enough evidence" (the most likely result at 30, `verdict-rules.md:94`), that is a valid outcome. Publish it with the unmet condition. Grow to `(variable) M5_SCALE_N` cases only if the operator decides to, and never re-label to move a verdict.
- Second-order: record the observed Jev to LLM outcome correlation, which the minimums assume to be 0.5 (`verdict-rules.md:100`). If it differs a lot, re-run the simulation before trusting the 30-case setting.

### M6 - A team member's own workflow

**Move 6.1 Unaided run on their own decision.**
- Action: a team member who did not build Backstage takes one typed decision from their own project, redacted, and runs the whole journey from the public README to verdict with no help. An observer writes down every hesitation and does not speak.
- Expected: a verdict and a friction log; each friction item becomes an issue.
- Likely reaction: they cannot turn their decision into a yes/no question with a fixed answer set, or their decision is out of scope (`SCOPE.md:18`).
- Counteraction: that is a finding about onboarding, not a run to rescue. Record it; fix copy or the guide (R16, `spec.md:111-113`), then repeat with a fresh person.

### M7 - Outside builder

**Move 7.1 Recruit and provision.**
- Action: one builder outside the team (`(variable) OUTSIDE_TESTER`) gets a tester login. They need their own Jev key and their own LLM key (`backstage.md:3-5`).
- Likely reaction: no Jev key. The one-case funded trial is off unless funding and quotas are configured (`backstage.md:38`).
- Fork A: they get a Jev key; full run. Fork B: no Jev key; the verdict reads "not enough evidence: no Jev results" (`FLOW.md:70`). That is correct behaviour but does not meet the destination; with consent the team runs the Jev arm on their redacted cases (`FLOW.md:70`), and the run is recorded as assisted, not unaided.
- Per-tester logins are tracked in #76 (open). Whether separate accounts can be issued today is UNVERIFIED; resolve before recruiting.

**Move 7.2 The run.**
- Action: the builder follows the public README only. They return the CSV, the evidence JSON and a one-paragraph account of what confused them. Originals go under the evidence folder (Move 3.2), never in git.
- Expected: the team reproduces their verdict from the returned CSV (Move 5.3 method).
- Privacy check before anything is published: cases are synthetic or redacted (`site/backstage/index.html:234`). If a case holds personal data, abort condition A4.

### M8 - Release

**Move 8.1 Tag and publish.**
- Action: confirm `ship.sh --status` exit 0 (no drift) and `--verify <SHA>` exit 0 on the SHA that passed M3; the release tag exists; release notes list what M3 to M7 proved and what they did not.
- Fork: if any code changed after M3, M3 re-runs on the new served SHA before M8.

## Failure trees

### F1 Labels
- Labels not blind (arm guessable by style) leads to a biased verdict. Detect with the guess test in Move 5.2. Counter: record "labels not blind"; normalise answer display if the product can.
- AI-drafted labels presented as human. Detect: `label_source` is `human` even when AI drafted it (`docs/product/runs/2026-10-01-uc13-shop-bot/LABELS.md:10`). Counter: M5 uses no drafting; the release notes say which runs had drafting.
- Labeller fatigue on large sets. Detect: labelling time per answer rises late in the session. Counter: split sessions; no labelling time is known yet (`verdict-rules.md:101`).
- Labels edited after reveal. Prevented in the product: reveal locks labels (`backstage.md:30`). A UAT negative control checks that the lock holds.

### F2 Live providers and keys
- Invalid or revoked key: only that arm fails (`backstage.md:5`); UAT control in Move 4.1.
- Returned model differs from requested: record both; never relabel (Move 4.1).
- Rate limit or outage mid-run: manual retry only, spend kept (`backstage.md:22`). If one arm stays down, the run continues and the gap reaches the verdict as missing rows.
- Price drift: the catalog is dated; Jev's price is unchecked against a bill. Counter: dashboard comparison after M4; #42 records which price table produced a cost.
- Key exposure: canary test (Move 4.2). The app does not intentionally persist keys; infrastructure and provider retention are not yet verified (`backstage.md:22`).

### F3 Deploy and co-tenants
- Deploy refused by the `#67` body check (grounded for the current HEAD, Move 1.2).
- Exit code without effect: the deploy is done only when the served SHA equals the shipped SHA (S1).
- Neighbour site changes status: S3 detects it; setup restores the vhost (`docs/backstage-deploy.md:48`); rollback if caused by the deploy.
- Failed logins and the host's intrusion jail: #99 says sign-out logged a failed login that might count towards a ban. `docs/backstage-deploy.md:55` says sign-out now POSTs to `/api/auth/sign-out` and creates no auth failure. Whether #99 is now stale, and whether wrong passwords at the sign-in page count towards a jail, is UNVERIFIED. Counter: a read-only check of the host's jail list before M7 recruits anyone, then close or keep #99. A tester banned at the shared host is also banned from every other site on it.

### F4 Data privacy
- A tester pastes real personal data. The page asks for synthetic or redacted cases only (`site/backstage/index.html:234`), but nothing enforces it (UNVERIFIED: no detector found in what was read). Counter: the outside-tester brief repeats the rule; the team reviews returned files before anything is committed; personal data found triggers abort A4.
- Run data stored for training (#109, #110): open enhancements, not built (UNVERIFIED by issue state only). Hold them out of the release that outside builders use unless consent and redaction are in place.
- Evidence files committed by accident: the ignore line and test from #101 (Move 3.2).

### F5 The verdict is wrong or unconvincing
- Arithmetic wrong: covered by the Newcombe oracle (`verdict-rules.md:99`) and hand-checked fixtures. Strong evidence for the maths, none for real accuracy.
- Settings wrong for real data: the 30-case minimum and 10% margin come from a simulation with an assumed 0.5 correlation (`verdict-rules.md:10-11`, `verdict-rules.md:100`). Counter: measure the correlation in M5.
- Several comparisons in one run: verdicts are per pair, uncorrected for multiple comparisons, and there is no overall best method (`backstage.md:32`). Counter: the release notes say so; a reader who compares four LLMs against Jev sees four separate verdicts.
- "Not enough evidence" read as product failure. At 30 cases it is the most common result (`verdict-rules.md:94`). Counter: the page shows the unmet condition; the guide sets that expectation before the first run.
- Rule tuned after labels: Move 5.1 freezes the rule with a hash.

## Test strategy per surface

| Surface | Test | Can prove | Cannot prove |
|---|---|---|---|
| Format validator | `bun test` unit tests, `bun run validate` | every row rule; gap counting; same verdict input on every machine | that a valid file is honest |
| Core maths and verdict | unit tests with the Newcombe oracle and hand-worked fixtures; the gate with per-file floors | intervals and rule order match the written rules; no test file silently dropped (`scripts/gate.ts:1-5`) | that the settings suit real data |
| Stage loader | DOM-fake tests over real validator and verdict (`results-loader.dom.test.ts:1-2`); scripted browser UAT on the served SHA (M3) | the shipped page computes from the loaded file, refuses bad input, sends no file over the network | anything about Backstage or providers |
| Backstage | unit and DOM tests with adapter doubles; scripted UAT with a test account (M3) | gate behaviour, import errors, labelling locks, downloads | live provider acceptance: doubles "do not prove live provider acceptance" (`backstage.md:42`) |
| Deploy | shell suites for S1 to S3 from fixtures (`docs/DEPLOY.md:203-205`); `--verify` live | served SHA, gate security literals, neighbours unchanged | behaviour of the app beyond the probed paths |
| Live providers | M4 trace run with real keys, evidence JSON | requested vs returned model, real usage and cost at the time of the run | stable prices or model behaviour later |
| Human acceptance | M5 blind labels, M6 and M7 unaided runs | a person can get from their decision to a verdict; the verdict reproduces | that Jev is better in general; the verdict covers that test set only (`verdict-rules.md:5`) |

Every scripted UAT run names the served SHA it ran against and refuses to run when the served SHA is not the one under test. Every positive check is paired with a negative control that must fail; a negative that passes means the check is broken, not the product.

## Abort conditions (stop and escalate)

- **A1** A co-tenant site on the shared host is down or changed after a deploy or rollback and the module rollback did not restore it.
- **A2** `ship.sh --verify` fails after a rollback (no known-good state is serving).
- **A3** A provider key, or a canary standing in for one, appears in any log, file or response.
- **A4** Personal data appears in a case, a returned file or a commit.
- **A5** The Stage, `bun run validate` and Backstage give different numbers for the same CSV.
- **A6** Fixing anything would require lowering a test floor, editing a label after reveal, or changing a verdict rule to move a verdict. Verdict-rule changes take the full pipeline path (`docs/spec/spec.md:164`).
- **A7** A tester is locked out of the shared host by an intrusion jail.

## Definition of done (all must be true)

1. `ship.sh --status` exits 0 and `ship.sh --verify <SHA>` exits 0 for the release SHA; S1, S2, S3 PASS.
2. The gate prints PASS at or above floor on 5 consecutive runs of that SHA.
3. A scripted browser UAT report exists for that served SHA, with every positive check PASS and every negative control failing as designed.
4. Both modules have been rolled back and forward on the live host with `--verify` PASS after each step.
5. One evidence JSON from a live comparison run records requested and returned model ids, usage, cost and failed-attempt spend; the invalid-key control failed only its arm; the key canary search found nothing.
6. One run with 30 or more paired cases was labelled blind by a person with no AI drafting; its verdict, numbers and limitations reproduce identically in Backstage, `bun run validate` and the Stage loader.
7. A team member and a builder outside the team each completed the journey unaided on their own decision, and each verdict reproduces from the returned CSV.
8. No abort condition fired, or each one that fired is closed with its fix merged.
9. The release notes state what was proven and what was not, including that verdicts cover the tester's own cases only.

## Ledger: unresolved inputs

| Variable | Needed by | Default until decided |
|---|---|---|
| `(variable) BROWSER_UAT_TOOL` | M3 | Fork A, a headless browser in a read-only `uat/` script outside the gate |
| `(variable) M5_DECISION` | M5 | one TokenMax yes/no question over 30 or more fictional CVs |
| `(variable) M5_SCALE_N` | M5 fork | none; stay at 30 unless the operator decides |
| `(variable) COST_TOLERANCE` | M4 | to be set by the operator; no default |
| `(variable) OUTSIDE_TESTER` | M7 | none; a person, so the operator chooses |
| `(variable) JEV_KEY_FOR_TESTER` | M7 | Fork B: assisted Jev arm, recorded as assisted |
| `(variable) PER_TESTER_LOGIN` | M7 | resolve #76: can a separate login be issued today |
| `(variable) JAIL_STATE` | M7 | read-only check of the host's jail list; keep #99 open until done |

## Executor

A cheaper model can run M0 to M4 from this document: Opus at low effort or Sonnet for deploy and rollback moves (one command at a time, read the output before the next), Sonnet for writing the UAT script, Haiku for re-running the gate and the verify. M5 to M7 need people: labels and unaided runs are not delegated to a model.
