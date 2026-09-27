# Jev use cases from one agent delivery loop

Source scenario: an AI coding agent takes a small client request through PR, checks, merge and deploy, reporting to one operator. It holds several separate use cases: each has its own user, its own data and its own test. Every one is a candidate, tested the TokenMax way: LLM only vs a simple rule vs Jev on labelled cases, verdict use Jev / don't / not enough evidence.

| ID | Use case | Who it serves | Decision | Answer shape | Data to label | Simple rule to beat |
|---|---|---|---|---|---|---|
| UC1 | Scope guard | reviewer, client | Does the change stay within what was requested? | yes / no | request text + PR diff summary | diff only touches files named in the request |
| UC2 | Check-failure triage | developer | Why did the check run fail? | this change / dependency / flaky / config | failing check logs | failing check's name in a known list |
| UC3 | Evidence grader | operator, reviewer | Is this status claim verified on the current commit, inferred, or unverified? | verified / indirect / unverified | agent status messages, sentence by sentence | commit id in the claim equals the head commit |
| UC4 | Autonomy gate | agent builder | Can the agent take the next step alone? | continue / needs operator | end-of-turn messages | next step appears in a list of outward actions (merge, deploy, send) |
| UC5 | Repeat-question detector | operator | Has this question already been asked in the session? | yes / no | the session's questions to the operator | text similarity above a cutoff |
| UC6 | Request completeness | client-facing team | Is the client's message complete enough to act on? | complete / missing field | inbound client messages | required fields present |
| UC7 | Client message routing | client-facing team | What kind of message is this? | data to enter / question / change request / other | inbound client messages | keyword list |
| UC8 | PR description check | reviewer | Does the PR description match what the diff does? | matches / overstates / understates | PR body + diff summary | none (LLM only vs Jev) |

## Grouped by where they run
- **Inside the agent loop** (every turn, volume, cheap wins): UC3, UC4, UC5.
- **At the PR and check gate**: UC1, UC2, UC8.
- **At the client front door**: UC6, UC7.

## Suggested first test
UC4 and UC3 share one data source (the agent's own status messages), so one labelled set of 30 to 50 messages tests both. UC4 matches the end-of-turn check other builders in the community are already trying with Jev.
