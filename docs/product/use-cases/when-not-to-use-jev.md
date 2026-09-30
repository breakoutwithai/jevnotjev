# When not to use Jev

Jev answers a typed question about one text with one of a fixed set of answers, and code acts on the answer. Many tempting tasks do not have that shape. These eight patterns came up again and again when candidate tasks from nine use-case ideas were checked for fit.

## Recurring patterns

| Pattern | Example | What does it instead |
|---|---|---|
| The answer is a presence, count or exit-code test on an artifact, not a judgement on text | a requirement counts as met when its check script exits 0 and prints PASS; a PR body's test count against the gate output | A script or grep that compares numbers and exit codes |
| An existing hard control already decides it exactly, so a probabilistic layer only adds risk | "is this generated SQL safe to run" is decided by a parse check, a read-only database role and row-level security | Keep the hard control; use Jev only in front of it for friendlier routing, never in place of it |
| The input is a diff, a PR, a plan or a document bundle, not one text | a PR that adds config rows, changes a hook and downloads an installer | Path rules, schema validators and secret scanners over the changed files |
| A wrong answer at high confidence is not survivable (security, live host, real money, corrupted knowledge base) | auto-merging a PR that touches a live-host guard; writing a wrong "reinforces" link into a knowledge base | Human merge or review, with a stop-list script as the floor |
| Retrieval or lookup comes first: the hard part is finding the right passage, note or record | finding the trusted source passage for a rule line; finding the existing note a new fact matches | SQL query, grep, search or vector retrieval; classify only after |
| The output has to be text (a rewrite, an extraction, an explanation), which Jev cannot write | rewording a rules file; extracting typed facts from a meeting transcript | An LLM that writes text, then a person or script that checks it |
| Too few items to need automation (runs once, or tens of items) | about 10 replies to a community post; a one-off refresh of hard-coded model names | A person reads them, or a one-off script |
| The real signal is not text: images, votes, reactions, or a rule the owner already stated | which of five page designs looks best; a data-versus-code policy the owner stated in one sentence | A vote count, or writing the owner's rule down as a path rule or hook |

## Worked !Jev example: pick the winning page concept

- **Task someone would hand Jev:** "which of these five single-page app concepts works best for community engagement?"
- **Why it is not Jev:** the things being judged are five screenshots, and Jev reads text only. It is decided once, so nothing runs often. No code acts on the answer. Engagement is a count of real reactions, not a label on one text.
- **What does it instead:** post the five screenshots, count reactions and replies per concept, and read each reply.
- **Where Jev could still sit (Needs a test):** tag each reply with the concept it backs (concept-1 to concept-5 / none) or its kind (praise / critique / feature ask / confusion / off-topic). Rule to beat: keyword match on the concept names. At about 10 replies a person reading them is enough, so the test needs 10 or more labelled replies before any claim, and a real case for Jev needs many more.
- **Patterns it matches:** "The real signal is not text" and "Too few items to need automation".

## Where these came from
Each pattern was proposed by an LLM acting as a sceptic reviewer, then Jev answered the fit questions (fixed answers, one text, code acts, runs often, wrong answer survivable, text out) on each tempting task. See [Evidence status](README.md#evidence-status) for what that does and does not prove.
