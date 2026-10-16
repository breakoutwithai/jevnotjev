# TokenMax collection execution

Prompt-Id: tokenmax-collection-with-without-jev
Governing issue: https://github.com/breakoutwithai/jevnotjev/issues/242
Worktree: sibling container `jevnotjev-wt/20261016-tokenmax-collection`
Branch: feat/tokenmax-collection
Base: fresh origin/main a72614eea024911b93a6838139e97d623fb5fa99 (2026-10-16)

## Pipeline

current_stage: verify
why: supplied detailed build prompt; live ownership and contract inspected
missing_gate: full gate, final pinned reviews and PR
next_entrypoint: authoritative gate and final review pin
confidence: high for base and ownership; live acceptance pending
CPR: no CPR tools exposed in this session; skipped gracefully.

## Ownership and evidence

- Live GitHub issue/PR inventory: #238 map/story remains open PR #241 (feat/tokenmax-map); #236 router budget/labels distinct; #240 shell isolation open; #239 player separate.
- Main checkout unchanged. New worktree created by wt helper from fetched origin/main.
- Read sibling src/backstage/maps.ts: allowlisted tm-share/1 cannot accept required collection coverage or provenance fields. Use an explicit adapter, never silently post a new envelope to that receiver.
- Base AGENTS.md and scripts/gate.ts: authoritative command is `bun scripts/gate.ts`, not missing scripts/ci-check.sh. No .github/workflows directory in base. Test floors required for each new test file.
- Known #240 warning: full gate includes .deploy/tests/ship.test.sh, currently exports FAKE_REPO to real root. Inspect isolation before full gate; do not run unsafe test against real worktree.

## Checklist

- [x] S1 design, source credit, reviewed contract and exact paths
- [x] S2 RED then GREEN shared collector/adapters/ingestion
- [x] S3 synthetic fixture journeys, privacy/preservation contract tests, samples, browser evidence and honest evaluation record
- [ ] S4 authoritative gate, independent reviews and dedicated PR

## Processing and budget

Only synthetic fixtures permitted in inference tests. No live paid call authorized. No private logs read for this implementation. Live Jev acceptance and human-labelled quality/savings remain pending; injected responses prove transport contract only. No merge/deploy/publication.

## Criteria correction

C1: `test -s docs/product/tokenmax-collection-design.md && test -s docs/product/tokenmax-collection-credit.md`
C2: `bash docs/product/runs/tokenmax-collection/verify.sh`
C3: `bun scripts/gate.ts` (actual repository gate read above); additionally `bun run typecheck`.

## Resume

Read this log, verify branch/HEAD/status, resume first unchecked milestone. Do not recreate this worktree or take over siblings.

## Implemented checkpoint

S1 design/credit: nonempty files verified; independent fresh specification review first requested explicit projection/platform ownership, then APPROVED after the concrete contract section and receiver evidence were added. The approved scope is adapter/fixture integration against unmerged PR #241, not a second `/api/maps` implementation.

S2 paths: `src/tokenmax-collection/{metadata,collector}.ts`, `scripts/tokenmax-collection/{run.ts,collect.mjs}`, `src/tokenmax-ingest/{ingest,platform,main}.ts`, `src/backstage/server.ts` preview route, and `site/collect/`. RED artifacts cover HTTP missing route, simultaneous concurrency, typed module absence, invalid provenance, missing processing approval and fork identity. GREEN focused runner: 44 tests across 7 files, 0 failures; actual names/counts in verification.txt. Both generated artifacts byte-match their source builds. Typecheck passed.

S3: 4/4 provider/mode contract journeys pass actual ingestion; three samples pass the same path; actual sibling validator accepts three projected payloads and rejects envelopes (receiver-compatibility.txt). Synthetic browser evidence covers 390px and desktop, edit/rejection recovery and no automatic requests. Node v26.3.0 executes the standalone bundle against fixtures with a network trap. Native TypeScript on Node is unsupported; older Node/Windows support is unverified. No private history or paid/live inference ran. M2 quality rates and M3 real model timings/usage/cost remain NOT RUN, as explained in evaluation.md.

Independent code/security/architecture review reproduced two P1 issues: missing local Jev processing-policy approval and copied-parent Codex fork metadata collapsing identities. Both were fixed with failing-then-passing regressions. The fork test expects 150 tokens across three sessions in either file order. Fresh reviewer re-read fixes and APPROVED pending final SHA content match. Root also fixed a reproduced concurrent-body-read race and contradictory model provenance validation. CI reviewer independently verified seven floors, minFiles 132, no metadata workflows and both generated bundle parities; full-gate/head pin pending.

Public scan: raw error source snippets and machine prefixes are kept locally; public evidence removes those snippets/prefixes while retaining failure names, expected/actual results and counts. The public Codex record type is constructed from its semantic parts to distinguish it from private IDs, consistent with the existing mapper convention. No private participant logs are in these records.

Full repository gate runs in an independent disposable git copy with Git-state environment overrides cleared, containing #240's known fixture mutation risk. This changes no test selection and no shell test source. The initial gate snapshot precedes review fixes and cannot establish final-head GREEN. Final current-content gate and submitted-head confirmation remain necessary.

## Full-gate diagnosis

The first disposable gate run exited nonzero. Targeted reruns established two causes: Chromium launch failed with EPERM under restricted execution, and `site/collect/collect.js` contained a raw dash forbidden by existing site-content assertions. The latter was an implementation regression, fixed in browser source and regenerated output; all 11 existing site-content tests now pass. A current-content full gate was restarted with browser-launch permission, unchanged test selection and independent Git storage. Earlier red runs are not treated as final verification.

Current focused verification: 44 tests, seven files, 0 failures; browser/Node generated parity PASS; three sample JSON files validate and four saved participant prompts match the visible UI instructions. Public-content scan: 54 files, 0 hits. Screenshots refreshed from synthetic browser flows only. No changes to sibling branches or their gate scripts.

Receiver pin correction: later status inspection confirmed active uncommitted edits in the #241 sibling. The compatibility check was rerun against `git show` of its named commit, not the live working file, and still passed all three cases. The committed receiver artifact SHA256 is recorded in receiver-compatibility.txt. No sibling changes were overwritten or adopted.

## Final implementation additions

The browser-capable full snapshot gate passed: `gate: PASS files=132 tests=2806`. This is evidence for that snapshot, not the final rebased head. Independent architecture review approved. Separate security review reproduced mutable platform approval limits; `createPlatformChecks` now snapshots policy/key/transport/timeout, and TM-P5 passes (5 platform tests). Six-zone arithmetic is now implemented from actual observed subscription-window readings in `zone.ts`, returned privately and included in local review output; it never uses token-to-quota conversion. Four arithmetic tests plus a collection integration regression prove six zones and unknown/invalid behavior. Current focused total is 50 tests across eight files; the gate floor gains the zone test file. The legacy public aggregate contract is unchanged.

Main advanced during execution through merged #239 and #230. Reconcile the manifest with their current floors before the final exact-head gate. No sibling uncommitted changes are included. The final PR remains subject to the exact-head gate and review hash confirmation.

Final provider-coverage regression: empty selected Codex directories previously defaulted to a Claude source because no file supplied a provider. A failing runner test demonstrated this; collection now rejects absent source evidence before creating output. Code reviewer approved the guard and four runner tests passed. Current complete focused suite: 51 tests across eight files. Final submitted-head gate must follow this fix; earlier exact-head gate evidence remains tied to its named earlier commit.
