# Jev!Jev: agent guidance

What the product is: [README.md](README.md). Scope and metrics: [FLOW.md](FLOW.md). Spec, plan and tasks: [docs/spec/](docs/spec/).

## Stack: TypeScript on Bun, no Python
- Product code, scripts and tests are TypeScript run with [Bun](https://bun.sh) (Node-compatible). Strict types; no `any`, `as`, `@ts-ignore` or `@ts-expect-error`; named exports.
- No Python: no `.py` files, pytest, pip, venv or requirements files. A new need is written in TypeScript. `src/docs/stack.test.ts` fails on a tracked `.py` file or a doc that names the old stack.
- Keep it simple: Node built-ins and Bun first; add a dependency only when the built-ins cannot do the job.
- `bun install`, then `bun test` (every tier) and `bun run typecheck`. Test titles start with the tier in brackets (`[smoke]`, `[unit]`, `[integration]`), then the criterion id.

## History
The code moved to TypeScript on Bun in #25 (validator, loader, exporter and migrator; 59 fixtures, 0 differences against the code it replaced, output quoted on #25), and the docs followed in #26. Those PRs and git history are the port record; the earlier research scripts are in history at cd8397f. `docs/decision/newcombe-table3.json` is the Newcombe Table III oracle read by `src/core/calc.test.ts`; `docs/decision/sim_out.txt` is the recorded simulation output, whose generator is being ported to TypeScript in #45 (for #38).
