# Jev!Jev v0.1.0 release draft

**Draft, not released.** No tag, GitHub release or published package is associated with this document.

Jev!Jev compares one typed decision in a workflow across Jev, an LLM, the Decisions API and a simple rule. It records each answer and its cost in a `jnj-record/1.2` CSV, then uses human labels to calculate cost per accepted result and a cautious verdict: use Jev, don't use Jev, or not enough evidence. This draft covers the command line and stdio MCP interfaces described in [the API guide](api.md).

## Requirements and install

- Git and Bun. `package.json` declares `bun@latest`; the release check was exercised with Bun 1.4.2 (`bun --version`).
- Network access to clone and install dependencies on the first run. The release check uses a local clone and recorded fixtures, and makes no provider calls.

Clone the public repository, enter the new `jevnotjev` directory, then install the locked dependencies:

```sh
git clone --no-local --quiet https://github.com/breakoutwithai/jevnotjev.git jevnotjev
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

Or use a project `.mcp.json` configuration snippet. Claude Code expands the variable references from its environment:

```json
{
  "mcpServers": {
    "jnj-decide": {
      "command": "bun",
      "args": ["/absolute/path/to/jevnotjev/src/mcp/server.ts"],
      "env": {
        "JEV_API_KEY": "${JEV_API_KEY}",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

For Codex, add this configuration snippet to `~/.codex/config.toml`. Start Codex with the provider variables in its environment when using provider tools. The snippet contains no credential values:

```toml
[mcp_servers.jnj-decide]
command = "bun"
args = ["/absolute/path/to/jevnotjev/src/mcp/server.ts"]
```

## Verify

```sh
bun scripts/release-check.ts
```

The check clones local `HEAD` into a fresh temporary directory, runs `bun install --frozen-lockfile`, exercises CLI help, arms, estimate, validation, three verdict exits and a recorded-fixture run, then connects to the stdio MCP server to list and call tools. It prints `PASS` or `FAIL` for each check and a final `release-check: PASS n/n` only when every check passes. `--ref <git-ref>` and `--repo <local-path-or-URL>` select another source. The temporary clone and records are removed after the check.

## Known limits

- The release check proves packaging and local CLI/MCP behavior. It uses a recorded Jev response for `run` and makes no paid provider call.
- The check does not exercise the HTTP surface or a hosted deployment.
- Verdicts apply only to the labelled cases supplied. The verdict rules need at least 30 paired labelled cases before they can use the evidence path.
- Version 1 inputs are text cases. See [the API guide](api.md) for the full input, key and output contracts.
