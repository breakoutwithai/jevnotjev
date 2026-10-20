# W9 RESULT: native prompt, Claude Code and Codex

Tree: <primary checkout>-wt/20261020-tm-journey-prototypes (branch feat/tm-journey-prototypes), read-only. Work dir: <scratch>/w9/

## Verdicts

| Tool | Verdict | Reason |
|---|---|---|
| Claude Code | UNTESTED | The launch command was refused by the harness before it ran. No model turn happened. |
| Codex | UNTESTED | Not launched. Same shape of command (agent with shell and network, real CODEX_HOME), so not attempted after the first refusal. |

## Fixture and direct mapper run (exit 0)

Fixture at w9/home/ (generator: w9/gen.py):
- `.claude/projects/fixture-proj/11111111-2222-4333-8444-555555555555.jsonl`: 3 assistant records (2026-10-17, -18, -19; claude-opus-5-5 x2, claude-sonnet-5-5 x1) plus one cap record (`isApiErrorMessage: true`, `error: "rate_limit"`, `message.model: "<synthetic>"`, text `You've hit your session limit · resets 10:10pm (UTC)`).
- `.codex/sessions/2026/10/18/rollout-x.jsonl`: session meta record, a turn_context (gpt-6-sol), two token_count events.

Command, run from the tree root:
`HOME=w9/home bun skills/tokenmax-map/scripts/map.ts --share --out w9/direct-run` -> exit 0, stderr empty.

Stdout (w9/direct.out):
```
claude sessions 1, codex sessions 1, cap hits 1
tm-share/1 fields: sessions 2, caps.short 1, output_tokens.claude 1150, output_tokens.codex 900, opus_share_pct 78, codex_weekly_pct 30
Open this link to review and share:
https://jevnotjev.breakoutwithai.com/maps/#m=eyJ2IjoidG0tc2hhcmUvMSIsInNraWxsIjoiMC4zLjAiLCJkYXlzIjo3LCJzb3VyY2VzIjoiY2xhdWRlK2NvZGV4Iiwic2Vzc2lvbnMiOjIsInN1YmFnZW50X3Nlc3Npb25zIjowLCJjYXBzIjp7InNob3J0IjoxLCJ3ZWVrbHkiOjAsInVua25vd24iOjB9LCJvdXRwdXRfdG9rZW5zIjp7ImNsYXVkZSI6MTE1MCwiY29kZXgiOjkwMH0sIm9wdXNfc2hhcmVfcGN0Ijo3OCwiY29kZXhfd2Vla2x5X3BjdCI6MzB9
```
Also wrote w9/direct-run/private-report.md and share-draft.md (scan: clean). This proves the fixture and the mapper, not the prompt.

## Claude Code launch (blocked on the single attempt)

Command attempted, from w9/run-claude/:
`HOME=<w9/home> CLAUDE_CONFIG_DIR=$HOME_REAL/.claude claude -p "<prompt, saved at w9/prompt.txt>" --model claude-sonnet-5-5 --output-format json --permission-mode acceptEdits --allowedTools "Bash WebFetch Read" > w9/claude.json 2> w9/claude.err`

Result: the Bash call was denied by the Claude Code auto-mode classifier, reason `[Data Exfiltration]`. The process never started: w9/claude.json and w9/claude.err do not exist, w9/run-claude/ is empty, there is no modelUsage evidence. No credits were spent.

Likely trigger (inference, not confirmed): the command gives a Bash-capable, network-enabled agent the real `CLAUDE_CONFIG_DIR` (credentials and the real `projects/` history). The brief's own rule is that neither run may reach the real history, and the classifier read it as exposure. The brief's "one corrected attempt" covers an auth error before a model turn, not a harness refusal, and the refusal text says not to work around it, so no second attempt was made (no copied credentials, no alternate config dir).

## Codex launch

Not launched, same reason. w9/run-codex/ is empty; no codex.log, no codex-last.md.

## Per-step evidence

| Step | Claude Code | Codex |
|---|---|---|
| Read map.ts, stated what it reads/sends | not run | not run |
| Ran mapper on fixture (tokenmax-report-* in run dir) | not run | not run |
| Showed report | not run | not run |
| Printed share link | not run | not run |
| Sent anything itself | not run | not run |

## To unblock (operator decision)

Either (a) approve this specific launch (a permission rule for the `claude -p` and `codex exec` commands with the real config dirs), or (b) choose a safer isolation: a throwaway config dir holding only a copy of the sign-in file (needs the operator to name the file and approve copying credentials), or run the prompt interactively in a terminal the operator controls. Rerunning the same commands from a terminal the operator controls needs no change to the brief.

Edits to the tree: none by this run. `git status` in the tree shows modified and untracked files (tm-journey scripts, fixtures, a deleted prototype file) that predate and are unrelated to this run.
