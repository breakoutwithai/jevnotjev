## Scope update: Jev first, comparison optional

Operator instruction on 2026-10-04: quick Jev-only fix for sibling retesting, then continue the full build. This supersedes the original mandatory three-arm entry flow and the exclusion of additional providers for subsequent work.

### Immediate slice

Invariant: a visitor with a valid Jev key and no competitor key can complete a Jev-only browser run, see the actual answer and returned confidence, label it and export records. Only selected arms execute. Selection is frozen with run identity; changing selection cannot mix cohorts or silently trigger additional billed calls. Existing comparison mode remains available explicitly.

Smallest wrong fix: merely remove key validation while the scheduler still calls Anthropic, emits rule rows, expects three answers per case, or displays a comparative verdict for a solo run. Regression tests must positively assert the executed arm set, finished state, export contents and solo result presentation.

Readers/writers: src/backstage/run.ts (validation, manifest, scheduler, cards, report/export); contracts.ts (types); main.ts and site/backstage/index.html (selection, progress, labels, results); their existing tests. Backend already handles one provider per request. Preserve request validation, secret filtering, model pins and same-origin protection.

Origin report: matching 127.0.0.1 requests failed while localhost succeeded. Inspect runner configuration before changing security policy. Retest a preview on its exact configured origin; do not broadly allow arbitrary origins to hide a configuration mismatch.

Acceptance and RED tests:
- JO1 run.test.ts: Jev-only selected with empty llm key executes exactly one Jev transport call per case, zero llm calls and zero rule rows; succeeds, labels and exports validate. Current fixed arm list fails this.
- JO2 run.test.ts: explicitly selected comparison retains Jev/rule/llm behavior; missing selected competitor key fails before provider calls. Unselected keys are not required.
- JO3 run.test.ts: selection is immutable within a run; retry/stop never add unselected arms; report does not produce a comparative recommendation from a solo cohort.
- JO4 page/browser check: default Jev-only path shows relevant inputs and actual answer/confidence; no required Anthropic field blocks it; compare opt-in is clear. Keep theatre style and mobile controls.
- JO5 server/preview checks: configured origin is accepted, mismatched/untrusted origins rejected. Build identity and retest URL recorded; live provider success stays a separate sibling UAT criterion.

Decisions: quick slice defaults to Jev alone; existing Claude/rule comparison is explicit opt-in. No funded trial or new provider adapter is needed to unblock this retest. Governing issue remains #67; no production deploy authorization.

### Following slices

Optional current-model choices for Anthropic/OpenAI/Google/xAI with per-provider keys; call only selected arms. Verify vendor model IDs and adapters before claiming support. Add copyable Playground/CLI handoff and prominent privacy/contact guidance. Publish only key-retention statements established by implementation/infrastructure evidence. Funded no-key trial needs an explicit configured credential and allowance/spend controls; do not embed or reuse a private burner key.

Sibling evidence: pinned build 2064b28 backend returned a Jev answer, but browser UAT stopped at mandatory LLM-key preflight. This is partial evidence, not browser acceptance. The private planning workspace retains the report and product feedback; no private transcript or key is copied here.
