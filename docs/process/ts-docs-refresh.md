# Docs refresh for the TypeScript and Bun code

Every mention of the old Python stack on the #25 head (fbc2cf8), found with `grep -niE 'python|pytest|\.py\b|pip install|venv|requirements\.txt'` over tracked files, and what this change did with it. Line numbers are at fbc2cf8.

Classes:
- **CURRENT**: an instruction or claim about the code today. Rewritten for TypeScript on Bun.
- **HISTORY**: a dated record. Kept as written.
- **LEGIT**: correct as it stands: the two research scripts in `docs/decision/` stay Python (#22), the parity tooling runs the pre-port code until parity is retired, and code comments explain output that copies the original byte for byte.

`src/docs/stack.test.ts` fails if a tracked `.md` outside its allowlist names the old stack, so CURRENT mentions cannot come back.

## CURRENT (27 lines, all rewritten)
| File | Line | Action |
|---|---|---|
| `README.md` | 35 | research scripts described as outside the Bun build, linked to how to run them |
| `db/README.md` | 53 | parity command described as the pre-port originals against the port |
| `db/README.md` | 55 | "each pre-port test" |
| `docs/process/pipeline.md` | 33 | `run bun test` |
| `docs/process/pipeline.md` | 92 | `bun test` collects every tracked `*.test.ts` (#25) |
| `docs/process/pipeline.md` | 108 | blocker tests now in `src/db/tests/blockers.test.ts` |
| `docs/spec/spec.md` | 8 | validator is `src/format/validate.ts`, runner is `bun test` |
| `docs/spec/spec.md` | 18 | test ids only in `bun test` titles |
| `docs/spec/spec.md` | 36 | R3.a names `src/format/validate.ts` |
| `docs/spec/spec.md` | 37 | R3.b marked met in #25 with the parity result |
| `docs/spec/spec.md` | 43 | R4.a cites `src/format/validate.ts:156-165` |
| `docs/spec/spec.md` | 122 | R18.a names `bun run load` and `bun run export` |
| `docs/spec/plan.md` | 8 | parity done in #25; `src/format/` tests are the reference |
| `docs/spec/plan.md` | 23 | cites `src/format/validate.ts:156-165` |
| `docs/spec/plan.md` | 35 | tested by `validate.test.ts` and `scripts/parity.sh` |
| `docs/spec/plan.md` | 41 | CLI is `src/format/cli.ts`, `bun run validate` |
| `docs/spec/plan.md` | 63 | gate runs `bun test` only; research scripts run by hand |
| `docs/spec/plan.md` | 64 | `bun test` collects every `*.test.ts` |
| `docs/spec/plan.md` | 66 | parity done in #25 via `scripts/parity.sh` |
| `docs/spec/tasks.md` | 5 | test names are `bun test` titles only |
| `docs/spec/tasks.md` | 26 | T0 marked done in #25, verified by `scripts/parity.sh` |
| `docs/spec/tasks.md` | 27 | T1 gate runs `bun test` only |
| `docs/spec/tasks.md` | 33 | T7 generator is `make.ts` |
| `docs/spec/tasks.md` | 43 | planned work, not code today: T17 re-planned as `scripts/hand-check.ts` in the gate, citing the #22 decision that supersedes `pipeline-review.md:149`; the Newcombe values in `docs/decision/newcombe_check.py` stay the oracle |
| `docs/spec/tasks.md` | 66 | R5.h test file `scripts/hand-check.test.ts` |
| `docs/spec/tasks.md` | 80 | `bun test` is the only runner |
| `.gitignore` | 2 | `.venv/` removed: nothing creates it (`scripts/parity.sh` builds its venv in a temp dir) |

Also changed without a grep hit: `tasks.md:61` (R3.b test is `scripts/parity.sh`), and the duplicated `## Tasks` heading at `tasks.md:20-22`.

## LEGIT (59 lines, kept)
| File | Lines | Why |
|---|---|---|
| `docs/spec/spec.md` | 53 | path to the Newcombe research script, the R5.e oracle |
| `docs/spec/plan.md` | 65 | same path |
| `docs/spec/tasks.md` | 31 | same path |
| `docs/decision/verdict-rules.md` | 87, 99 | how to run the two research scripts |
| `docs/decision/newcombe_check.py` | 1, 2, 8 | research script |
| `db/migrations/0001_records.sql` | 120, 127 | comments inside an applied migration: its sha256 is in `jnj_schema_migration`, so editing it would stop `bun run migrate` on every existing database |
| `scripts/parity.sh` | 2, 9, 19, 21, 22, 24, 27, 28, 29, 30, 32, 35 | runs the pre-port code; stays until parity is retired |
| `scripts/parity.ts` | 1, 11, 12, 30, 94, 123, 256, 266, 271, 275, 318, 322, 340, 350, 353, 363 | same |
| `src/format/csv.ts` | 1, 2 | explains output copied from the original |
| `src/format/pyrepr.ts` | 1, 10 | same |
| `src/format/pyrepr.test.ts` | 1, 7, 31 | same |
| `src/format/schema.ts` | 2, 50, 79, 102, 103, 128 | same |
| `src/format/validate.ts` | 2, 15, 38, 64 | same |
| `src/db/decimal.ts` | 1, 28 | same |
| `src/db/tests/support.ts` | 80, 189 | same |

`.gitignore` keeps `__pycache__/`: running the research scripts can write one.

## HISTORY (111 lines, kept)
| File | Lines | Why |
|---|---|---|
| `docs/process/py-to-ts-test-map.md` | 100 lines | the port's test mapping; its header table is labelled "before" and "after" |
| `docs/process/pipeline-review.md` | 42, 43, 48, 53, 59, 99, 143, 149 | the round-1 review of PR 21 at 5e80a84, verdict line first |
| `docs/research/2026-09-29-verdict-minimums/README.md` | 1 line | dated research |
| `docs/research/2026-09-29-verdict-minimums/stats.md` | 2 lines | dated research |

`docs/blog/` and `docs/benchmarks/` have no mention. `pipeline-review.md` gets a dated note at the top, because `pipeline.md` sends readers to its response section and its T17 and T1 resolutions are superseded. No other HISTORY file reads as current guidance.
