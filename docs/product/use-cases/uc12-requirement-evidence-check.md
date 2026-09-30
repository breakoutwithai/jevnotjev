# UC12: Requirement evidence check

**User story:** As a builder before a demo I want each requirement in my spec checked against the evidence I hold for it, so I know which ones are met, partly met or not met without rereading everything.

**Prompted by:** a builder preparing a client demo with about 20 requirements, each already paired with an evidence excerpt (test output, a grep result, a log line). The client spec is private, so the public version uses any project README's requirements list.

## Jev or not
Split two ways. Where the evidence is an exit code or a PASS line, a script decides "met" exactly: **!Jev**. Where the evidence is prose or partial output that a person has to read, the call is a fixed choice on one short text: **Jev could help**.

| Decision (typed question) | Answers | State (what Jev reads) | Code does with each answer | Mark | Simple rule to beat |
|---|---|---|---|---|---|
| Does this evidence excerpt support this requirement? | met / partly met / not met | one requirement line plus one evidence excerpt | met passes; partly met and not met go on the demo-risk list | Jev could help | met when a named check command exits 0 and its PASS line is present, else not met |
| Should this unmet requirement be raised before the demo or held? | raise / hold | the requirement line and its section | raise goes on the call agenda | Needs a test | raise every unmet item from the top sections, hold the rest |

## The !Jev half
- **The check has a machine answer.** If a named test or check script exists for the requirement, its exit code and PASS line decide "met". That is exact and free; a probabilistic layer only adds risk.
- **The go / no-go on the demo itself.** The input is a summary across many sources, it is decided once, and a confident wrong "go" has a client-facing cost. A person reads the check results.
- **Finding which requirements are unbuilt.** That is a search over the repo (grep, a script), a presence test, not a judgement on one text.

Jev only earns a place on the rows where no check exists and someone would otherwise read the excerpt by hand.

## How Jev!Jev tests this use case
- Cases: 20 or more requirement and evidence pairs from a public project README, each labelled met / partly met / not met by hand. "Partly met" needs a written definition before labelling, or the labels will not agree.
- Arms: what you do now (an LLM reads the pair and answers), a simple rule (exit code plus PASS line), Jev decides.
- Accepted result: an answer the builder agrees with. Score the rule only on pairs where a check exists, and report how many pairs have none.

## Not established
- Whether prose evidence is common enough to matter; if most requirements have a check script, the rule covers them and Jev has little to do.
- Whether "partly met" can be labelled consistently.
