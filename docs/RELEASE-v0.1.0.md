# Jev!Jev v0.1.0 release draft

**Draft, not released.** No tag, GitHub release or published package is associated with this document.

Jev!Jev compares one typed decision in a workflow across Jev, an LLM, the Decisions API and a simple rule. It records each answer and its cost in a `jnj-record/1.2` CSV, then uses human labels to calculate cost per accepted result and a cautious verdict: use Jev, don't use Jev, or not enough evidence. This draft covers the command line and stdio MCP interfaces described in [the API guide](api.md).

## Requirements and install

- Git and Bun. `package.json` declares `bun@latest`; the release check was exercised with Bun 1.4.2 (`bun --version`).
- Network access to clone and install dependencies on the first run. The release check uses a local clone and recorded fixtures, and makes no provider calls.

Clone the public repository, enter the new `jevnotjev` directory, then install the locked dependencies:

```sh
git clone https://github.com/breakoutwithai/jevnotjev.git
cd jevnotjev
bun install --frozen-lockfile
```

Run the remaining commands from that directory.

## CLI quick use

These commands are exercised by the fresh-clone release check. `arms`, `validate` and `verdict` spend nothing.

```sh
bun run decide --help
bun run decide arms
bun run decide validate examples/d08-verdicts/r3-use-jev.csv
bun run decide verdict examples/d08-verdicts/r3-use-jev.csv
```

The final command exits 0 for the labelled example. Other examples in `examples/d08-verdicts/` exercise exit 3 (don't use Jev) and exit 4 (not enough evidence). See [the CLI contract](api.md#exit-codes) for every code and [the API guide](api.md#command-line) for live `estimate`, `ask` and `run` inputs.

## MCP setup

The stdio server is `bun src/mcp/server.ts` and exposes `arms`, `estimate`, `ask`, `run`, `validate` and `verdict`. Use an absolute path to `src/mcp/server.ts` in client configuration. Provider credentials are optional for read-only tools; for provider calls the server reads `JEV_API_KEY` (or `TYPESAFE_API_KEY`), `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from its environment. Keep actual values out of repository files.

For Claude Code, add the server from the shell, following [the API guide](api.md#mcp). This configuration snippet names variables from the current shell; Claude Code stores their expanded values in local configuration:

```sh
claude mcp add jnj-decide -e JEV_API_KEY="$JEV_API_KEY" -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -- bun /absolute/path/to/jevnotjev/src/mcp/server.ts
```

Or use a project `.mcp.json` configuration snippet. Claude Code expands the variable references from its environment. The `:-` empty default keeps an unset variable empty rather than passing a literal variable reference to the server:

```json
{
  "mcpServers": {
    "jnj-decide": {
      "command": "bun",
      "args": ["/absolute/path/to/jevnotjev/src/mcp/server.ts"],
      "env": {
        "JEV_API_KEY": "${JEV_API_KEY:-}",
        "OPENAI_API_KEY": "${OPENAI_API_KEY:-}",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY:-}"
      }
    }
  }
}
```

For Codex, add this configuration snippet to `~/.codex/config.toml`. Stdio MCP servers get a filtered environment, so provider tools need these variable names forwarded from Codex's environment. The snippet contains no credential values:

```toml
[mcp_servers.jnj-decide]
command = "bun"
args = ["/absolute/path/to/jevnotjev/src/mcp/server.ts"]
env_vars = ["JEV_API_KEY", "TYPESAFE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
```

## Verify

```sh
bun scripts/release-check.ts
```

The check clones the public repository at a named ref, so a commit that exists only on one machine cannot pass. Run it as `bun scripts/release-check.ts --repo https://github.com/breakoutwithai/jevnotjev.git --ref <candidate sha or tag> --url https://jevnotjev.breakoutwithai.com`. `--repo` is the repository URL, `--ref` the commit or tag to check, and `--url` the public app; without `--url` the `served sha` item prints `NOT RUN`, and without `--repo` the script clones this checkout, which is for development only. It runs 22 items: `fresh clone` and `frozen install`; five guide steps that make no provider call (`guide prepare`, `guide question`, `guide rule`, `guide cases`, `guide estimate`); ten CLI items (`cli help`, `cli arms`, `cli estimate`, `cli validate valid`, `cli validate invalid`, `cli verdict use`, `cli verdict insufficient`, `cli verdict reject`, `cli fixture run`, `cli validate fixture records`); three stdio MCP items (`mcp tools/list`, `mcp validate`, `mcp verdict`); `served sha`, which compares the static site's `/DEPLOYED_SHA` to the candidate commit; and `limits text`, which requires a non-empty `docs/LIMITS.md` at the candidate commit. Each item prints `PASS`, `FAIL` or `NOT RUN`, and the final line is `release-check: PASS 22/22` only when every item passes (exit 0). A `NOT RUN` is not a pass. The full item table and exit codes are in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md). The temporary clone and records are removed after a normal exit.

## Known limits

- The release check proves packaging and local CLI/MCP behavior. It uses a recorded Jev response for `run` and makes no paid provider call.
- The check does not exercise the HTTP surface or a hosted deployment.
- Verdicts apply only to the labelled cases supplied. The verdict rules need at least 30 paired labelled cases before they can use the evidence path.
- Version 1 inputs are text cases. See [the API guide](api.md) for the full input, key and output contracts.
- Google sign-in for Backstage and paid comparisons are deferred beyond v0.
- The admin page, the admin API and the admin MCP connector have been exercised only by the operator and by scripted tests, not by an outside user.
- No consented outside user's own run from start to verdict is documented yet; the next step is to invite one and document it.
- The full list of known limits is in [LIMITS.md](LIMITS.md).
