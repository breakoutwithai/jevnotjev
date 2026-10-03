# Backstage Pass

A live BYOK rehearsal for one binary decision. Open six rooms, write the question and acceptance rule, enter TypeSafe and Anthropic API keys, add your cases, and run. Label actual answers blind, then download the exact CSV and attempt evidence used for the shared-core verdict.

## Local use

```
bun install
bun run backstage:build
BACKSTAGE_VERSION=$(git rev-parse HEAD) BACKSTAGE_STATIC_ROOT=dist/backstage/site bun run backstage:start
```

Open http://localhost:3456/backstage/. The service binds to loopback. Keys remain in session/request memory; reload clears them and the run. No product demo mode exists. Calls use pinned jev-1.13.0 and claude-haiku-4-5-20251001. An invalid key fails visibly. No automatic retry; Stop and explicit retry preserve attempt evidence and possible charges.

The literal keyword rule selects the first answer if any keyword appears, case-insensitively; otherwise the second. No keywords means the second answer always. Import multiline cases with exactly `case_id,case_input` CSV columns. A first-case pilot is a distinct frozen run; edit as a new scene for a full run.

Cost estimates use returned usage and list prices checked 2026-10-03: [TypeSafe models](https://docs.typesafe.ai/models), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing). Missing usage stays unknown. Failed/retried spend appears separately from successful-answer comparisons. Human labels are never generated. At least 30 paired labelled cases are needed for the shared verdict.

## Verification and rollout

Run `.agents/scripts/test-green`, `.agents/scripts/validate` and `.agents/scripts/deploy-test`. Adapter doubles are confined to tests; they do not prove live provider acceptance. A real browser/API run with tester keys and human labels remains the separate live acceptance check.

[Deployment contract](docs/backstage-deploy.md) packages frontend/backend together off-host, requires a merged PR, and documents the one-time service/proxy setup plus paired rollback. This build does not deploy itself.

Rehearsals conceal player metadata. When ready, choose **Reveal results and lock labels**. This unlocks provider comparisons and downloads, and ends the blind pass. Finish retries before revealing. No label stays missing.
