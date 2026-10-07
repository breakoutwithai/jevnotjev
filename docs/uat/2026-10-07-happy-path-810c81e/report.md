# Fresh-clone happy path

Base: http://localhost:3476
Version: 810c81e3f253308cc01e660b3cdc3c60261ff3d3
Clone SHA: 810c81e3f253308cc01e660b3cdc3c60261ff3d3
Run time: 2026-10-07T19:00:24.530Z
Model ids: jev-1.13.0, gpt-6-luna, keywords-v1
Case count: 40
Labels: none (agents never label)
Scanned: --out (all files)
Rule: Backstage keyword rule (substring match, cap 20), not rule.md's word-start rule: 20 of 29 rule.md terms; redundant under substring match: in stock, booked, booking, confirmed, broken; left out: this weekend, saturday, sunday, tomorrow
Screenshots: keys are typed only into password fields; screenshot pixels are not scanned.
Verdict: gpt-6-luna — not enough evidence  Per-pair, uncorrected comparison. not enough evidence: 0 paired Jev and LLM cases, fewer than 30; add 30 more labelled cases
Records check: pass

| # | Room | Step | Result | Detail | Screenshot |
|---:|---|---|---|---|---|
| 1 | Build | pin | PASS | completed | [image](01-build-pin.jpg) |
| 2 | New Scene | open | PASS | completed | [image](02-new-scene-open.jpg) |
| 3 | New Scene | set decision | PASS | completed | [image](03-new-scene-set-decision.jpg) |
| 4 | Casting | open | PASS | completed | [image](04-casting-open.jpg) |
| 5 | Casting | select players | PASS | rule: 20 literals (Backstage cap 20); redundant under substring match: in stock, booked, booking, confirmed, broken; left out of rule.md: this weekend, saturday, sunday, tomorrow | [image](05-casting-select-players.jpg) |
| 6 | Casting | provider keys | PASS | completed | [image](06-casting-provider-keys.jpg) |
| 7 | Learning Lines | open | PASS | completed | [image](07-learning-lines-open.jpg) |
| 8 | Learning Lines | import 40 cases | PASS | completed | [image](08-learning-lines-import-40-cases.jpg) |
| 9 | Learning Lines | run all | PASS | completed | [image](09-learning-lines-run-all.jpg) |
| 10 | Learning Lines | complete all arms | PASS | completed | [image](10-learning-lines-complete-all-arms.jpg) |
| 11 | Rehearsals | open | PASS | completed | [image](11-rehearsals-open.jpg) |
| 12 | Rehearsals | open judging | PASS | completed | [image](12-rehearsals-open-judging.jpg) |
| 13 | Rehearsals | reveal | PASS | completed | [image](13-rehearsals-reveal.jpg) |
| 14 | Dress Rehearsal | open | PASS | completed | [image](14-dress-rehearsal-open.jpg) |
| 15 | Dress Rehearsal | download-csv | PASS | completed | [image](15-dress-rehearsal-download-csv.jpg) |
| 16 | Dress Rehearsal | download-evidence | PASS | completed | [image](16-dress-rehearsal-download-evidence.jpg) |
| 17 | Opening Night | verdict | PASS | completed | [image](17-opening-night-verdict.jpg) |

