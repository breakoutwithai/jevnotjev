# Jev!Jev

Find where Jev fits a workflow, where it doesn't, and prove the difference.

Built in public for the Early AI-dopters 30 Day Challenge. The day-30 goal is **Jev!Jev**: a small web tool, live at [jevnotjev.breakoutwithai.com](https://jevnotjev.breakoutwithai.com), that compares one decision in a workflow across an LLM-only setup, a simple baseline and Jev, and reports cost per accepted result with a verdict: use Jev, don't (!Jev), or not enough evidence. Its flagship use case is **TokenMax**: more accepted results from the same token budget. Other use cases show when to use Jev and when not to.

| Doc | What |
|---|---|
| [FLOW.md](FLOW.md) | Scope, journey, the three arms, and the source of every metric |
| [docs/product/flow/comparison.html](docs/product/flow/comparison.html) | The comparison flow diagram |
| [format/](format/README.md) | Eval record format: cases, answers, labels, cost; schema, sample, validator |
| [src/](src) | TypeScript on Bun: the validator (`src/format`, no Node APIs, so the site can use it) and the Postgres loader and exporter (`src/db`, see [db/README.md](db/README.md)) |
| [docs/benchmarks/](docs/benchmarks/) | Measurements |
| [docs/product/user-stories.md](docs/product/user-stories.md) | User journeys and stories |
| [docs/product/use-cases/](docs/product/use-cases/) | Jev use cases to test |
| [docs/product/jev-in-jevnotjev.md](docs/product/jev-in-jevnotjev.md) | Where Jev could help build this project |

## Try the record format
Needs [Bun](https://bun.sh).
```
git clone https://github.com/breakoutwithai/jevnotjev
cd jevnotjev
bun install
bun run validate format/example-v1.csv
```
Expected last line: `VALID rows=9 cases=3 errors=0 gaps=2`. Edit a cell (answer `maybe`, confidence `1.5`) and run it again to see the file rejected. Spec: [format/README.md](format/README.md).

## Develop
```
bun install
bun test                  # all tiers; integration tests need a local Postgres, see db/README.md
bun test -t '\[unit\]'     # one tier: smoke, unit or integration
bun run typecheck
```
The research scripts in [docs/decision/](docs/decision/) stay Python (`python3 docs/decision/sim_min_n.py`, needs numpy).
