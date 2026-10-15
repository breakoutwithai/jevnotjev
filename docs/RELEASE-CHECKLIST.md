# Release checklist

One command checks a release candidate from a fresh clone and prints one line per item.

```sh
bun scripts/release-check.ts --repo https://github.com/breakoutwithai/jevnotjev.git --ref <candidate sha or tag> --url https://jevnotjev.breakoutwithai.com
```

- `--repo` is the public repository URL. The public code must hold the candidate: with a local path, a commit or tag that exists only on this machine would pass. Without `--repo` the script clones this checkout, which is for development only.
- `--ref` is the commit or tag to check. The script clones the repository into a temporary directory, checks that ref out, and prints `candidate: <40-hex sha>` once the ref resolves. Pass the tag to prove the tag target.
- `--url` is the public app. Without it the served-version item is reported as `NOT RUN`.
- The clone and its files are deleted when the check ends. The environment handed to every step is `PATH` and `HOME`, plus a fixture file and a fake key for the recorded run only, so no real provider key reaches any step and no paid call is made.
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
| `guide estimate` | The step exits 0 and its output has the right case and call counts. | `# guide: estimate` block, i.e. `bun run decide estimate ...` |
| `cli help`, `cli arms` | The CLI starts and lists the documented arms. | `bun run decide --help`, `bun run decide arms` |
| `cli estimate` | Estimate counts cases and calls correctly. | `bun run decide estimate` |
| `cli validate valid`, `cli validate invalid` | A good record file validates and a broken one is refused. | `bun run decide validate <file>` |
| `cli verdict use`, `insufficient`, `reject` | The three verdict exits and names. | `bun run decide verdict examples/d08-verdicts/<file>` |
| `cli fixture run`, `cli validate fixture records` | A recorded-fixture run writes valid records. | `bun run decide run` with `JNJ_DECIDE_FIXTURES` |
| `mcp tools/list`, `mcp validate`, `mcp verdict` | The stdio MCP server lists its six tools and answers two calls. | `bun src/mcp/server.ts` |
| `served sha` | The public static site serves the candidate commit. | `GET <url>/DEPLOYED_SHA` |
| `limits text` | The candidate commit holds a `docs/LIMITS.md` with text beyond its headings. | `git show <candidate sha>:docs/LIMITS.md` |

Only the guide steps `prepare`, `question`, `rule`, `cases` and `estimate` run. The guard fails closed: it refuses any of those steps that could call a provider or the network, and reports that step as `FAIL`. Refused are any `decide` or `cli.ts` token not followed by `estimate`, `claude` anywhere, `curl`, `wget`, `nc`, `bunx`, `npx`, `bun add`, `fetch(`, `node:http`, `node:https`, `node:net`, `node:tls` and `_API_KEY`. The steps that run the arms (`without-jev`, `with-jev`) can spend money and are never run here.

`served sha` checks the static site's `/DEPLOYED_SHA` only. The trimmed body must be exactly 40 hex characters equal to the candidate sha (case-insensitive); a short prefix fails. A non-2xx answer, a timeout after 10 seconds, a network error or an HTML page served with status 200 all fail. It does not check the backend or any other module of the stack.

`limits text` reads the file from the candidate commit, not from the working files. It fails when `docs/LIMITS.md` is absent from the commit or when every non-blank line is a heading.

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
