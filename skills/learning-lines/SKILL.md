---
name: learning-lines
description: "Rehearse your own choice-question cases with Jev (TypeSafe jev-1.13.0) and with the model you already use (Claude Code or Codex on your own subscription login), and see side by side on screen where they agree, where they differ, tokens, estimated cost and latency. Writes no files. Use for 'learning lines <cases.json>', 'try Jev on my cases', 'compare Jev with Claude on <file>', 'compare Jev with Codex on <file>'."
argument-hint: "<cases.json> [--with claude|codex] [--model <id>] [--limit N] [--skip-jev]"
user-invocable: true
allowed-tools: Read, Bash
---

# /learning-lines

Learning lines: you write the lines (your cases), Jev and your usual model read them, and the
screen shows how each one delivered them. One cases file in, a table on screen out. Nothing is
saved.

## Run

Use the folder this SKILL.md sits in:

```bash
bun run.ts example-refund.json --limit 2            # 2 Jev calls + 2 Claude calls
bun run.ts <cases.json>                             # Jev + claude-sonnet-5-5
bun run.ts <cases.json> --with codex                # Jev + gpt-6-sol
bun run.ts <cases.json> --model claude-opus-5-5     # explicit model ids only
bun run.ts <cases.json> --skip-jev                  # model arm only, no Jev key needed
```

- Jev needs `JEV_API_KEY` in the environment (a TypeSafe key from https://console.typesafe.ai).
  The key is sent only in the request header; it is never printed or passed on a command line.
- Claude runs through your own `claude` CLI and must be logged in with a Claude subscription (Pro, Max, Team or Enterprise).
  Codex runs through your own `codex` CLI and must be logged in using ChatGPT. API-key logins are
  refused, and API keys are stripped from the CLI's environment, so no API credits are billed.
- Codex models: `gpt-6-luna`, `gpt-6-sol` (default), `gpt-6-astra`.
- Calls run one at a time, no retries. The first error stops the run with a message naming the case.

## Cases file

```json
{
  "question": "Does the customer explicitly request a refund or their money back?",
  "choices": [{"name": "yes", "definition": "..."}, {"name": "no", "definition": "..."}],
  "cases": [{"id": "refund-1-1", "text": "Please refund my payment.", "expected": "yes"}],
  "workflow": "optional: where this decision sits",
  "acceptance": "optional: what would make you ship it"
}
```

`expected` is optional and is your own answer. "Matches expected" is agreement with you, not proven accuracy.

## Reading the numbers

- Jev cost: $0.042 per million input tokens, output free (published price).
- Model tokens in include the CLI's own system prompt, so they are higher than a bare API call.
  Model cost is a list-price estimate (Claude: the CLI's own `costUSD`; Codex: OpenAI list prices),
  not what you pay on a subscription.

## Feedback

Open an issue at https://github.com/breakoutwithai/jevnotjev/issues.
