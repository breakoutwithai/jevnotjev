# Round 1 scoring (SIMULATED, rubric version 1)

Prototypes scored: the as-built round 1 commits f826a59 (p1) to f6937a6 (p5). They were then rebuilt under operator Amendments 3 and 4, so these scores describe superseded pages and are kept as the record.

- Shuffle: mulberry32 Fisher-Yates over the sorted folder names, seed in `mapping.json`.
- Readers, blind, letters only: claude-opus-5-5 (fresh Task subagent), gpt-6-sol and gpt-6-astra (`codex exec -m <id>`, read-only, the four PNGs attached). Answers in `answers/`, prompt in `reader-prompt.md`.
- Grader for Q1 to Q5: claude-sonnet-5-5 (fresh Task subagent, saw only the key and the answers with readers anonymised as R1 to R3), `grades.json`, prompt in `grader-prompt.md`.
- Stage walk and status check: mechanical, `stagewalk.json` and `tally.json`.
