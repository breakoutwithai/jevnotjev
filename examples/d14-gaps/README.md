# D14: three planted evidence gaps

Synthetic and fictional, a test fixture only: two support messages, two questions, typed by hand. Nothing here came from a call to Jev or any model.

Three gaps are planted on purpose:
- case `g2`, question `q1`: the `rule` row has no label;
- case `g1`, question `q1`: the `llm` row has no `cost_usd`;
- question `q2` has no `rule` rows, while `q1` has them.

Each gap gives one limitation line, from `src/core/verdict.ts`, in the CSV loader and the result view. The replay page lists only the uc13, tokenmax and d12 runs; for this file the replay model (`parseRun`) produces the same lines:

```
Missing labels: rule 1 row with no label, left out of every pairing.
Missing costs: llm 1 row with no cost, so spend is incomplete.
Uneven cases across methods: llm 2, rule 0, jev 2.
```

The first two are on `q1`, the third on `q2`. Tests: `src/core/verdict.test.ts`, `src/browser/results-loader.dom.test.ts`, `src/evidence/replay.test.ts`.
