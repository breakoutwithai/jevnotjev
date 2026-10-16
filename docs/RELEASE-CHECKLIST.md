# Release checklist

One command checks a release candidate from a fresh clone and prints one line per item.

```sh
bun scripts/release-check.ts --repo https://github.com/breakoutwithai/jevnotjev.git --ref <candidate sha or tag> --url https://jevnotjev.breakoutwithai.com
```

- `--repo` is the public repository URL. The public code must hold the candidate: with a local path, a commit or tag that exists only on this machine would pass. Without `--repo` the script clones this checkout, which is for development only.
- `--ref` is the commit or tag to check. The script clones the repository into a temporary directory, checks that ref out, and prints `candidate: <40-hex sha>` once the ref resolves. Pass the tag to prove the tag target.
- `--url` is the public app. Without it the served-version item is reported as `NOT RUN`.
- Temporary files are removed on a normal exit; an interrupted run can leave the `jnj-release-check-*` temp directory behind.
- Environment: guide steps get `PATH` and an empty temporary `HOME`; files stay readable by absolute path. The install, CLI and MCP items use the real `HOME`, and the MCP server also receives `LOGNAME`, `SHELL`, `TERM` and `USER` from its SDK. The recorded CLI run gets a fixture file and a fake key. No provider key is passed to any item. Network access is not blocked.
- A bad flag prints `FAIL arguments` and then every item as `NOT RUN`.

## Results and exit codes

| Result | Meaning |
|---|---|
| `PASS` | The item ran and held. |
| `FAIL` | The item ran and did not hold. The reason follows the name. |
| `NOT RUN` | The item could not run. The reason follows the name. |

Every one of the 22 items prints exactly one of the three. When an item fails, each later item that was not reached prints `NOT RUN: not reached after <first failed item>`. Before the summary line the script prints `elapsed: <seconds> s`; the summary is always the last line.

| Exit code | Summary line | When |
|---|---|---|
| 0 | `release-check: PASS n/n` | Every item passed. |
| 1 | `release-check: FAIL f/n` (plus `, k not run`) | At least one item failed, or nothing ran. |
| 2 | `release-check: NOT RUN k/n` | Nothing failed, but k items did not run. |

A `NOT RUN` is not a pass. A release candidate is clear only on exit 0.

## Automated items

| Item (check name) | What it proves | Command or file it uses |
|---|---|---|
| `fresh clone` | The candidate ref exists and checks out in a clean directory. | `git clone --no-local`, then `git checkout --detach <ref>` |
| `frozen install` | The lockfile installs without changes. | `bun install --frozen-lockfile` |
| `guide prepare` | The step exits 0 from a fresh clone. | `# guide: prepare` block in `docs/GUIDE.md` |
| `guide question` | The step exits 0. | `# guide: question` block |
| `guide rule` | The step exits 0. | `# guide: rule` block |
| `guide cases` | The step exits 0. | `# guide: cases` block |
| `guide estimate` | The safe sample: exit 0, JSON with `cases` an integer of 30 or more, `calls` an integer above 0 and a positive finite `costUsd`. | `# guide: estimate` block, i.e. `bun run decide estimate ...` |
| `cli help`, `cli arms` | The CLI starts and lists the documented arms. | `bun run decide --help`, `bun run decide arms` |
| `cli estimate` | Estimate counts cases and calls correctly. | `bun run decide estimate` |
| `cli validate valid`, `cli validate invalid` | A good record file validates and a broken one is refused. | `bun run decide validate <file>` |
| `cli verdict use`, `cli verdict insufficient`, `cli verdict reject` | The three verdict exits and names. | `bun run decide verdict examples/d08-verdicts/<file>` |
| `cli fixture run`, `cli validate fixture records` | A recorded-fixture run writes valid records. | `bun run decide run` with `JNJ_DECIDE_FIXTURES` |
| `mcp tools/list`, `mcp validate`, `mcp verdict` | The stdio MCP server lists its six tools and answers two calls. | `bun src/mcp/server.ts` |
| `served sha` | The public static site serves the candidate commit. | `GET <url>/DEPLOYED_SHA` |
| `limits text` | The candidate commit holds a `docs/LIMITS.md` that is present and non-empty. Reading it is the manual item. | `git show <candidate sha>:docs/LIMITS.md` |

Only 5 of the guide's 13 steps run: `prepare`, `question`, `rule`, `cases` and `estimate`, the ones that make no provider call. The steps that run arms (`without-jev`, `with-jev`) can spend money, so this script never runs them; the repo test suite replays them from fixtures. `guide estimate` is the safe sample.

Each step runs with `bash -e -o pipefail`: a failing simple command or pipeline fails the step. A failure inside a command substitution or an `&&`/`||` list does not, per the bash errexit rules.

What is and is not prevented: a pattern guard catches the known provider and network commands in the guide text and reports that step as `FAIL`. It is not a sandbox. The steps still have network access, and a step written to evade the patterns would run. What bounds a step is its environment: `PATH` and an empty temporary `HOME`, no provider key. The patterns refuse any `decide` or `cli.ts` token not followed by `estimate`, `claude` anywhere, `curl`, `wget`, `nc`, `bunx`, `npx`, `bun add`, `fetch(`, `node:http`, `node:https`, `node:net`, `node:tls` and `_API_KEY`.

`served sha` checks the static site's `/DEPLOYED_SHA` only. `--url` may carry a path (`https://host/app/` requests `/app/DEPLOYED_SHA`) but not a query or fragment; either is a usage error. The trimmed body must be exactly 40 hex characters equal to the candidate sha (case-insensitive); a short prefix fails. A redirect, a non-2xx answer, a timeout after 10 seconds (the body read included), a network error or an HTML page served with status 200 all fail. It does not check the backend or any other module of the stack.

`limits text` reads the file from the candidate commit, not from the working files. It fails with `docs/LIMITS.md missing` when the file is absent from the commit and with `docs/LIMITS.md is empty` when it holds only whitespace. It does not judge the content; that is the manual item below.

## Manual items

| Item | Command or action |
|---|---|
| Full automated test suite | `bun scripts/gate.ts` in the candidate checkout; it must print PASS with a non-zero test count |
| Read the limits text | Open `docs/LIMITS.md` and confirm it says what the tool cannot do, in words a new user understands |
| Typecheck | `bun run typecheck` |

## Record for this release

Copy the table, one row per item above, and fill it in for the candidate.

Candidate: `<sha or tag>` Date: `<date>` Run by: `<name>`

| Item | Result (PASS/FAIL/NOT RUN) | Release-blocking (yes/no) | Owner | Fix or defer |
|---|---|---|---|---|
| | | | | |
