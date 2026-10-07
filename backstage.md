# Backstage Pass

A live BYOK rehearsal for one binary decision. Open six rooms, write the question and acceptance rule, enter a TypeSafe API key, add your cases, and run. **Jev only is the default:** no Anthropic key is needed, and only Jev makes paid calls. Its actual answer and returned confidence for a case appear in Learning Lines once you have picked that case blind in Rehearsals, or after judging finishes. Confidence is the model's score, not measured accuracy.

In Casting, opt into comparisons and select individual models from Anthropic, OpenAI, Google or xAI. Supply one key per selected provider. Missing or rejected competitor keys fail only their arms; Jev and valid competitors continue. The local keyword rule is separately optional. Comparison identities stay hidden until judging finishes. The cast and scene freeze together at run start. Change either by starting a new scene.

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

The application does not intentionally persist provider keys; deployed infrastructure and provider retention require separate verification. Clear keys stops future dispatch; an already sent request may still be charged. Reload clears the application run. No product demo mode exists. Calls use the selected entries from the versioned catalog; requested and returned model identities are recorded separately. An invalid selected key fails visibly. No automatic retry; Stop and explicit retry preserve attempt evidence and possible charges.

In comparison mode, the literal keyword rule selects the first answer if any keyword appears, case-insensitively; otherwise the second. Selecting the rule requires at least one non-empty keyword. The rule never executes in Jev-only mode. Import multiline cases with exactly `case_id,case_input` CSV columns. A first-case pilot is a distinct frozen run; edit as a new scene for a full run.

Cost estimates use returned usage and the dated per-model catalog. Unmapped usage or rates stay unknown; those comparisons are accuracy-only until costs are established. Failed/retried spend appears separately from successful-answer comparisons. Human labels are never generated. At least 30 paired labelled cases are needed for the shared comparative verdict. Jev-only runs show a summary without a comparative recommendation.

## Judging and downloads

Finish any retries, then choose **Open judging and lock retries** in Rehearsals (or **Open blind judging and lock retries** for comparison). Each case shows its question, input and the two choices, and no answer: pick the right one, or **Unsure**. That blind pick is made once. Then Jev's ranking for the case appears: its options ordered by Jev's probabilities (when Jev returned none, its choice first and the rest unranked), with its confidence. Keep your pick or change it; the final pick is recorded beside the blind one. The ranking reuses the run's own Jev answer (no new call); when the run has none for the case, **Ask Jev with your key** makes one paid call on the Jev key in Casting, never a funded key, or the case says "No suggestion yet". Every case may stay unpicked. Choose **Finish judging and unlock downloads** for Jev only, or **Reveal results and lock labels** for comparison. This locks labels and unlocks the CSV and evidence downloads (both hold every answer, so they wait for this step in Jev-only runs too). Comparison identities remain hidden until reveal, except that Jev's ranking for a case shows once you pick it.

The CSV is `jnj-record/1.1` (`format/README.md` "Label provenance" and "Blind and final picks": a pick labels every answer of its case, accept when the answer equals the blind pick, with `label_source` `human`, `labelled_by` `backstage-operator`, `labelled_at`, `label_blind` `true`, and `label_final` and `suggestion_shown` once the final pick is made; arms are scored on the blind pick only) and contains successful answers only, separated into a deterministic cohort per competitor. The evidence JSON includes each individual comparison CSV and its original attempt mapping. Jev observations are reused across cohorts: never sum cohort costs. Total actual spend counts every successful and failed attempt once. Identical answers for one case share a human label. Verdicts are per-pair, uncorrected for multiple comparisons; there is no overall winner. Download the evidence JSON alongside it: `manifest.mode` and `manifest.arms` distinguish a Jev-only run from a comparison with missing answers. The JSON also retains failed and uncertain attempts. Unlabelled answers stay unlabelled. If every call fails, evidence downloads remain available without judging; the CSV then contains only its header and is explicitly not a valid non-empty evaluation dataset.

## Copy and optional funded trial

Copy the exact first case, question and definitions for the [TypeSafe Playground](https://console.typesafe.ai/playground), or copy a CLI command containing `$TYPESAFE_API_KEY` instead of your entered key. Contact [jev@breakoutwithai.com](mailto:jev@breakoutwithai.com) for help.

The one-case Jev trial is unavailable unless server funding, durable quotas and explicit limits are configured. When available it uses a browser cookie and network limits; reload can lose the answer without restoring the allowance. No automatic call or automatic trial retry occurs. This feature does not imply funded credentials have been provisioned or a live trial accepted.

## Verification and rollout

Run `.agents/scripts/test-green`, `.agents/scripts/validate` and `.agents/scripts/deploy-test`. Adapter doubles are confined to tests; they do not prove live provider acceptance. A real browser/API run with tester keys and human labels remains the separate live acceptance check.

[Deployment contract](docs/backstage-deploy.md) packages frontend/backend together off-host, requires a merged PR, and documents the one-time service/proxy setup plus paired rollback. This build does not deploy itself.
