# Jev!Jev: agent guidance

What the product is: [README.md](README.md). Scope and metrics: [FLOW.md](FLOW.md). Spec, plan and tasks: [docs/spec/](docs/spec/).

## Stack: TypeScript on Bun, no Python
- Product code, scripts and tests are TypeScript run with [Bun](https://bun.sh) (Node-compatible). Strict types; no `any`, `as`, `@ts-ignore` or `@ts-expect-error`; named exports.
- No Python: no `.py` files, pytest, pip, venv or requirements files. A new need is written in TypeScript. `src/docs/stack.test.ts` fails on a tracked `.py` file or a doc that names the old stack.
- Keep it simple: Node built-ins and Bun first; add a dependency only when the built-ins cannot do the job.
- `bun install`, then `bun test` (every tier) and `bun run typecheck`. Test titles start with the tier in brackets (`[smoke]`, `[unit]`, `[integration]`), then the criterion id.

## History
The validator and loader were ported from Python in #25 (59 fixtures, 0 differences); the research scripts behind the verdict rules and the parity harness were removed afterwards and are in history at cd8397f. Their recorded outputs stay: `docs/decision/sim_out.txt` and `docs/decision/newcombe-table3.json`.
