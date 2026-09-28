# Jev!Jev

Find where Jev fits a workflow, where it doesn't, and prove the difference.

Built in public for the Early AI-dopters 30 Day Challenge. The day-30 goal is **TokenMax**: a small web tool that compares one workflow across an LLM-only setup, a simple baseline and Jev routing, and reports cost per accepted result with a verdict: use Jev, don't (!Jev), or not enough evidence.

| Doc | What |
|---|---|
| [FLOW.md](FLOW.md) | Scope, journey, the three arms, and the source of every metric |
| [docs/product/flow/comparison.html](docs/product/flow/comparison.html) | The comparison flow diagram |
| [format/](format/README.md) | Eval record format: cases, answers, labels, cost; schema, sample, validator |
| [docs/benchmarks/](docs/benchmarks/) | Measurements |
| [docs/product/user-stories.md](docs/product/user-stories.md) | User journeys and stories |
| [docs/product/use-cases/](docs/product/use-cases/) | Jev use cases to test |
| [docs/product/jev-in-jevnotjev.md](docs/product/jev-in-jevnotjev.md) | Where Jev could help build this project |

## Try the record format
```
git clone https://github.com/breakoutwithai/jevnotjev
cd jevnotjev
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python format/validate.py format/example-v1.csv
```
Expected last line: `VALID rows=9 cases=3 errors=0 gaps=2`. Edit a cell (answer `maybe`, confidence `1.5`) and run it again to see the file rejected. Spec: [format/README.md](format/README.md).
