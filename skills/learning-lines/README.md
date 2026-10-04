# Learning lines

Rehearse your own lines with Jev and with the model you already use, and see on screen how they compare.

You write a question, its choices and a few cases. The skill sends each case to Jev (TypeSafe
`jev-1.13.0`) and to Claude or Codex through your own CLI login, then prints one line per case
(agree or differ) and a short summary: answered, matches with your expected answers, tokens,
estimated cost per 1,000 calls and median latency. The script writes no files; the Claude and Codex
CLIs keep their own state in their home folders as usual.

## Install

Copy this folder into your Claude Code skills folder:

```bash
cp -R learning-lines ~/.claude/skills/
```

Then ask Claude Code for "learning lines on <your cases file>", or run the script yourself.

## Prerequisites

- [Bun](https://bun.sh)
- A TypeSafe API key for Jev from https://console.typesafe.ai, exported as `JEV_API_KEY`
  (or pass `--skip-jev` to try the model arm alone)
- One of: the Claude Code CLI logged in with a Claude subscription (Pro, Max, Team or Enterprise), or the Codex CLI logged in
  using ChatGPT. API-key logins are refused, so no API credits are billed.

## One command

```bash
cd ~/.claude/skills/learning-lines && bun run.ts example-refund.json --limit 2
```

Add `--with codex` for Codex, `--model <id>` for another model. `SKILL.md` has the cases file format.

Limits: model token counts include the CLI's own system prompt, and model cost is a list-price
estimate, not what you pay on a subscription. One CLI call per case; the CLI may retry internally.
Codex runs with its tools switched off but still loads the AGENTS.md in its home folder. Two or forty
cases show a pattern, not proof.

## Feedback

Open an issue at https://github.com/breakoutwithai/jevnotjev/issues.
