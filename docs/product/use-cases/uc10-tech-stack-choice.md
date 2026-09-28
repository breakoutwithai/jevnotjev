# UC10: Tech stack choice

**User story:** As a user I want Jev to decide on my tech stack for my project.

**Prompted by:** the community post "Comparing Supabase vs Convex for Your Tools/Apps" (2026-09-24), a walkthrough of when to use one database platform over the other.

## Jev or not
"Decide my tech stack" is open design work: it needs reasoning and a written answer, so as asked it is **Jev probably not**. Around it sit small decisions with fixed answers, where Jev can help.

| Decision (typed question) | Answers | State (what Jev reads) | Code does with each answer | Mark | Simple rule to beat |
|---|---|---|---|---|---|
| Does this project need each property? (realtime updates, relational queries and joins, row-level access rules, self-hosting, offline-first, heavy file storage) | yes / no per property | the builder's project description | turns the answers into a requirements list | Jev could help | a keyword list per property |
| Given those answers, which option fits? (e.g. Supabase / Convex / either) | one of the listed options | the requirements list | picks the option from a written mapping table the builder can read and change | Needs a test | the mapping table alone, with no Jev call |
| Is this stack question one we can answer from the description, or does it need a person? | answerable / needs a human | the description | answerable goes on; the rest goes to a person or an LLM to discuss | Jev could help | description length or missing keywords |

The final choice comes from the mapping table, not from asking Jev "which stack". That keeps the reasoning visible, and follows the community guidance to decide the route in code.

## How TokenMax tests it
- Cases: 20 or more real project descriptions (with consent) or synthetic ones, each labelled by hand with the properties it needs and the stack a person would pick.
- Arms: what you do now (ask an LLM "which stack should I use?"), a simple rule (keyword list plus the mapping table), Jev decides (Jev answers the property questions, then the mapping table).
- Accepted result: a property answer the builder agrees with, and a final pick the builder would actually use.

## Not established
- Whether one paragraph of project text carries enough signal for the property questions.
- The mapping table itself; it needs someone who knows both platforms to write and check it.
