# Issue 71: focused sibling retest

Purpose: verify fixes to the existing four persona-UAT findings. Reuse the earlier personas and cases; do not repeat the full exploratory study. No provider calls or production changes are needed.

## Identify the session

Record the preview URL, UTC start/end, browser/version, viewport, tester identity (agent or human) and the full revision returned by `/api/backstage/health`. Store the response and confirm the served label/shop assets match that revision's build. Use a new SHA-named evidence session; keep the historical unverified session unchanged.

Before resetting anything, download any existing labels and preserve existing shop calls. A fresh browser profile or separate preview port gives an isolated origin. For a deliberate reset on that test origin, remove only `jnj.uc13.labels.v1` for labels and `jnj.little-shop.call.v1.*` for shop calls. Do not clear unrelated site data or discard another tester's session.

## Retest and capture

| Finding | Steps | Expected result and evidence |
|---|---|---|
| F1 / U1 | Label message 1 Hand off and message 2 Answer. Go Back to message 2. Reload. Go Back to message 1, revise to Answer, reload again. | Two labels and the current position survive; revision changes one choice without increasing count. Capture before/after, save status and exported rows. |
| F4 / U4 | Return to each labelled message with Back/Next and keyboard arrows. Revise with A/H. | The selected button has `aria-pressed=true`, the other false; unlabelled messages have both false. Capture accessibility state, not only color. |
| F2 / U2 | In Little Shop call A1 Hand off and A2 Hand off. Reopen A1 and choose Answer. Reload and reopen both. | A1 changes, A2 stays Hand off, counter remains 6/120, scoring updates; both survive reload. Capture the changed controls and results. |
| F3 / U3 | Finish all 40 shop calls, reload, then reopen a seat. | 120/120; completion text directs review/change or verdict. Completed seats remain reviewable and editable; no instruction to choose an empty seat. |
| Export / U5 | Download after two labels, then after all 40. Revise one choice and download again. | Actually obtain files. Inspect `case_id,truth`, 2/40 data rows respectively, unique ordered case IDs, only answer/hand_off, and the revised choice. Save reviewed CSVs and hashes. A download-tool timeout remains inconclusive. |
| Storage failure / U1 | In an isolated test context, deny storage or force a write failure, then label and download. | Labels remain usable in the open tab; visible status says changes are not saved; export contains current choices. |

For storage-disabled testing, retain the exact browser mechanism used. Unit/controller regression tests cover malformed state, changed inputs and write failure; do not claim these were browser-tested unless exercised here.

Use desktop and one narrow viewport for the changed controls. Record failures individually; label untouched checks as not rerun. Agent-generated labels remain test data, not human ground truth or blind comparative evidence.

## Repeatable local checks

```sh
bun test scripts/uat-controllers.test.ts scripts/little-shop-seating.test.ts scripts/uc13/stage-demo.test.ts
bun scripts/uc13/stage-demo.ts --check
```

The controller tests run shipped JavaScript with a minimal DOM/storage adapter and inspect the real generated CSV Blob. They do not prove browser download delivery, layout, focus or screen-reader behavior; the sibling retest owns that evidence. The full repository gate remains `test-green` plus `validate`.
