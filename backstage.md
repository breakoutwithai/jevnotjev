# Backstage Pass

A live BYOK rehearsal for one binary decision. Open six rooms, write the question and acceptance rule, enter a TypeSafe API key, add your cases, and run. **Jev only is the default:** no Anthropic key is needed, and only Jev makes paid calls. Its actual answer and returned confidence appear in Learning Lines as answers arrive. Confidence is the model's score, not measured accuracy.

In Casting, optionally select **Compare with Claude Haiku and a local rule** and enter an Anthropic key. Comparison runs send the same cases to both providers and run the local rule; player details stay hidden until judging finishes. The cast and scene freeze together at run start. Change either by starting a new scene.

## Local use

```
bun install
bun run backstage:start
```

Open http://localhost:3456/backstage/. The service binds to loopback and defaults to that exact origin. `localhost` and `127.0.0.1` are different origins. To use another host or port, configure the origin explicitly and open the matching URL:

```
PORT=3460 BACKSTAGE_ORIGIN=http://localhost:3460 bun run backstage:start
```

Open http://localhost:3460/backstage/ for that command. For a `127.0.0.1` URL, set `BACKSTAGE_ORIGIN=http://127.0.0.1:3460` instead. Mismatched origins remain rejected. `/api/backstage/health` reports the build version; record it with the exact URL when retesting.

Keys remain in session/request memory; reload clears them and the run. No product demo mode exists. Calls use pinned jev-1.13.0 and, only when comparison is selected, claude-haiku-4-5-20251001. An invalid selected key fails visibly. No automatic retry; Stop and explicit retry preserve attempt evidence and possible charges.

In comparison mode, the literal keyword rule selects the first answer if any keyword appears, case-insensitively; otherwise the second. No keywords means the second answer always. The rule never executes in Jev-only mode. Import multiline cases with exactly `case_id,case_input` CSV columns. A first-case pilot is a distinct frozen run; edit as a new scene for a full run.

Cost estimates use returned usage and list prices checked 2026-10-03: [TypeSafe models](https://docs.typesafe.ai/models), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing). Missing usage stays unknown. Failed/retried spend appears separately from successful-answer comparisons. Human labels are never generated. At least 30 paired labelled cases are needed for the shared comparative verdict. Jev-only runs show a summary without a comparative recommendation.

## Judging and downloads

Finish any retries, then choose **Open judging and lock retries** in Rehearsals (or **Open blind judging and lock retries** for comparison). Label answers if desired; every answer may remain unlabelled. Choose **Finish judging and unlock downloads** for Jev only, or **Reveal results and lock labels** for comparison. This locks labels and unlocks the CSV and evidence downloads. Solo answers are visible before this step; comparison identities remain hidden until reveal.

The CSV preserves the existing `jnj-record/1` schema and contains successful answers only. Download the evidence JSON alongside it: `manifest.mode` and `manifest.arms` distinguish a Jev-only run from a comparison with missing answers. The JSON also retains failed and uncertain attempts. You can finish judging and download evidence even when every call failed; the CSV then contains its header and no answer rows. `manifest.arms` is authoritative: rule-related scene fields are inert in Jev-only mode. Unlabelled answers stay unlabelled.

## Verification and rollout

Run `.agents/scripts/test-green`, `.agents/scripts/validate` and `.agents/scripts/deploy-test`. Adapter doubles are confined to tests; they do not prove live provider acceptance. A real browser/API run with tester keys and human labels remains the separate live acceptance check.

[Deployment contract](docs/backstage-deploy.md) packages frontend/backend together off-host, requires a merged PR, and documents the one-time service/proxy setup plus paired rollback. This build does not deploy itself.
