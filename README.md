# Jev!Jev

Find where Jev fits a workflow, where it doesn't, and prove the difference.

Run your own workflow: [docs/GUIDE.md](docs/GUIDE.md).

Built in public. **Jev!Jev** is a small web tool, live at [jevnotjev.breakoutwithai.com](https://jevnotjev.breakoutwithai.com), that compares one decision in a workflow across an LLM-only setup, a simple baseline and Jev, and reports cost per accepted result with a verdict: use Jev, don't (!Jev), or not enough evidence. Its flagship use case is **TokenMax**: more accepted results from the same token budget. Other use cases show when to use Jev and when not to.

| Doc | What |
|---|---|
| [FLOW.md](FLOW.md) | Scope, journey, the three arms, and the source of every metric |
| [docs/product/flow/comparison.html](docs/product/flow/comparison.html) | The comparison flow diagram |
| [format/](format/README.md) | Eval record format: cases, answers, labels, cost; schema, sample, validator |
| [src/core/](src/core) | The tested maths: accepted counts and cost per accepted result per arm (`metrics.ts`), confidence intervals (`calc.ts`), and the verdict with its plain-language reason (`verdict.ts`) |
| [docs/product/result-views/result-d06.html](docs/product/result-views/result-d06.html) | The result view, a local artifact (not on the site): the three methods side by side on the example dataset, the verdict, the numbers it computed, and the limits |
| [docs/spec/](docs/spec/) | Requirements and architecture plan |
| [src/](src) | TypeScript on Bun: the validator (`src/format`, no Node APIs, so the site can use it) and the Postgres loader and exporter (`src/db`, see [db/README.md](db/README.md)) |
| [docs/benchmarks/](docs/benchmarks/) | Measurements |
| [docs/product/user-stories.md](docs/product/user-stories.md) | User journeys and stories |
| [docs/product/use-cases/](docs/product/use-cases/) | Jev use cases to test |
| [docs/product/jev-in-jevnotjev.md](docs/product/jev-in-jevnotjev.md) | Where Jev could help build this project |

## See a result
Needs [Bun](https://bun.sh).
```
git clone https://github.com/breakoutwithai/jevnotjev
cd jevnotjev
open docs/product/result-views/result-d06.html   # macOS; any browser works, no server needed
bun install
bun scripts/result-view.ts       # regenerates the page from examples/d06-tiny/records.csv
```
The page compares the current LLM, a keyword rule and Jev on five fictional CVs. On the first question Jev costs $0.000025 per accepted answer against the LLM's $0.002 (Jev 4 of 5 accepted, LLM 5 of 5), and the verdict is still "not enough evidence": 5 paired cases, and the rules need 30. The data and the Jev and LLM costs are invented; see [examples/d06-tiny/expected.md](examples/d06-tiny/expected.md).

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
Stack: TypeScript run with Bun only ([AGENTS.md](AGENTS.md)).
