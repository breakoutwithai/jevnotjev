# Jev use cases

UC1 to UC8 come from one scenario: an AI coding agent takes a small client request through PR, checks, merge and deploy, reporting to one operator. They are separate use cases: each has its own user, its own data and its own test. Every one is a candidate, tested the Jev!Jev way: LLM only vs a simple rule vs Jev on labelled cases, verdict use Jev / don't / not enough evidence.

| ID | Use case | Who it serves | Decision | Answer shape | Data to label | Simple rule to beat |
|---|---|---|---|---|---|---|
| UC1 | Scope guard | reviewer, client | Does the change stay within what was requested? | yes / no | request text + PR diff summary | diff only touches files named in the request |
| UC2 | Check-failure triage | developer | Why did the check run fail? | this change / dependency / flaky / config | failing check logs | failing check's name in a known list |
| UC3 | Evidence grader | operator, reviewer | Is this status claim verified on the current commit, inferred, or unverified? | verified / indirect / unverified | agent status messages, sentence by sentence | commit id in the claim equals the head commit |
| UC4 | Autonomy gate | agent builder | Can the agent take the next step alone? | continue / needs operator | end-of-turn messages | next step appears in a list of outward actions (merge, deploy, send) |
| UC5 | Repeat-question detector | operator | Has this question already been asked in this conversation? | yes / no | the conversation's questions to the operator | text similarity above a cutoff |
| UC6 | Request completeness | client-facing team | Is the client's message complete enough to act on? | complete / missing field | inbound client messages | required fields present |
| UC7 | Client message routing | client-facing team | What kind of message is this? | data to enter / question / change request / other | inbound client messages | keyword list |
| UC8 | PR description check | reviewer | Does the PR description match what the diff does? | matches / overstates / understates | PR body + diff summary | none (LLM only vs Jev) |
| UC9 | Website slop roast ([detail](uc9-website-slop-roast.md)) | website builder | Does this page show each AI-slop sign? | yes / no or 0 / 1 / 2 per check | page text, CSS, screenshots | CSS and DOM lint |
| UC10 | Tech stack choice ([detail](uc10-tech-stack-choice.md)) | builder starting a project | Does the project need each property (realtime, relational, access rules, self-hosting)? | yes / no per property; a mapping table picks the stack | project description | keyword list plus the mapping table |
| UC11 | CV against a job ad ([detail](uc11-cv-vs-job-ad.md)) | hiring manager | Does the CV meet this line of the ad? One question per ad line | yes / no | CVs, labelled per ad line | keyword match per line |
| UC12 | Requirement evidence check ([detail](uc12-requirement-evidence-check.md)) | builder, reviewer | Does this evidence excerpt support this requirement? | met / partly met / not met | requirement and evidence pairs from a public README | named check exits 0 and prints PASS |
| UC13 | Shop bot, answer or hand off ([detail](uc13-shop-bot-answer-or-handoff.md)) | small shop owner, bot builder | Can the bot answer this from the fact sheet? | answer / hand_off | 40 customer messages against one synthetic fact sheet | keyword list: stock, availability, booking, policy, injury or safety word goes to hand off |

## Grouped by where they run
- **Inside the agent loop** (every turn, volume, cheap wins): UC3, UC4, UC5.
- **At the PR and check gate**: UC1, UC2, UC8.
- **At the client front door**: UC6, UC7.
- **On a builder's shipped site**: UC9.
- **Before a builder starts**: UC10.

## Suggested first test
UC4 and UC3 share one data source (the agent's own status messages), so one labelled set of 30 to 50 messages tests both. UC4 matches the end-of-turn check other builders in the community are already trying with Jev.

## Added use cases and extensions
UC11 is the **TokenMax** flagship use case: more accepted results from the same token budget. Its worked hand calculation is [`examples/d06-tiny/`](../../../examples/d06-tiny/). UC12 includes the half where a script, not Jev, decides.

**UC4, merge case: green PR, can the agent merge or does a human still need to?** Every check has passed; the question is whether the merge is routine or touches something a person must own.

| Decision | Answers | State | Simple rule to beat | Mark |
|---|---|---|---|---|
| Which merge route does this green PR take? | auto-merge / security review then auto-merge / human merge | PR title, body and list of changed paths | any change under hooks, naming the live host, or touching `.env` files goes to a human; else auto | Needs a test |

The !Jev half: "CI is green and the PR is mergeable" is read from the platform, not judged. Anything on a written stop list (secrets, live hosts, real money) goes to a human by script, whatever Jev says; Jev only routes what the stop list lets through. A labelled history of 12 to 20 merged PRs is enough to start.

**Question gate in front of text-to-SQL or any agent tool call** (extends UC7's routing to user questions sent to an agent).

| Decision | Answers | State | Simple rule to beat | Mark |
|---|---|---|---|---|
| What kind of question is this, before any SQL or tool call is made? | normal / instruction override / write or delete request / bulk data grab | the user's typed question | phrase list: ignore previous, delete, drop, update, all rows, every record, credentials | Needs a test |
| Does this question need a person before it is answered? | yes / no | the user's typed question | yes when a pay or HR keyword matches | Needs a test |

Jev sits in front of the hard controls (a parse check on the SQL, a read-only database role, row-level security), never in place of them. Those decide what is safe to run exactly; Jev only picks a friendlier route or refusal before they are reached.

**When not to use Jev:** eight recurring patterns and a worked example are in [when-not-to-use-jev.md](when-not-to-use-jev.md).

## Evidence status
Everything in UC11, UC12, the extensions above and the when-not patterns is a candidate until a labelled test runs. What exists so far: candidate decisions and not-fit tasks were proposed by Sonnet acting as review hats, so those labels are one LLM's opinion, not ground truth. Jev's fit pass was run on task descriptions, not on real items, so it measures agreement with Sonnet on descriptions only. The Jev price used in that pass ($0.042 per million input tokens) is not yet checked against a bill.
