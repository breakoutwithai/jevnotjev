# D12: three methods per case, by hand

Synthetic and fictional: four support messages, one question, the current setup (`llm`), the simple baseline (`rule`) and Jev routing (`jev`). Nothing here was produced by a call to Jev or any model; the outputs and costs are typed in, which is the manual-results path: run each method however you can, then write one row per method and case into a `jnj-record/1` CSV ([format](../../format/README.md)).

Two things are missing on purpose:
- case `d04` has no `rule` row;
- case `d02` has no `cost_usd` for `llm`.

Check the file:

```
bun src/format/cli.ts examples/d12-three-methods/records.csv
```

Expected output (exit code 0: gaps do not make the file invalid):

```
GAP line 5: cost_usd missing (d02, q1, llm)
GAP case d04 (question q1, run run-d12, prompt delivery-q.v1): no rule result
jev: rows=4 labelled=4 accepted=4 cost=$0.000008
llm: rows=4 labelled=4 accepted=4 cost=incomplete
rule: rows=3 labelled=3 accepted=2 cost=$0.000000
VALID rows=11 cases=4 errors=0 gaps=2
```

The result view (`renderResultView` in [scripts/result-view.ts](../../scripts/result-view.ts)) lays out every case with all three methods. A method with no row reads `missing`, a blank cost reads `cost missing` and a blank label reads `unlabelled`. For this file the per-case table holds:

| Case | Current LLM | Simple keyword rule | Jev |
|---|---|---|---|
| d01 | yes, $0.000330 | yes, $0.000000 | yes, $0.000002 |
| d02 | no, cost missing | no, $0.000000 | no, $0.000002 |
| d03 | no, $0.000360 | yes, $0.000000 | no, $0.000002 |
| d04 | yes, $0.000310 | missing | yes, $0.000002 |
