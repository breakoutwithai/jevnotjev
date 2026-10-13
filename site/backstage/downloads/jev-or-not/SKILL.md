---
name: jev-or-not
description: Decide whether a fixed-answer decision is a good candidate for Jev, choose its question type, and name a simple comparison test.
allowed-tools: Read
---

# Jev or not

Use this skill when someone asks whether Jev could help with a task. Jev answers fixed-answer questions about one state, such as a message, page text, JSON record, or chat log. It does not write prose. This assessment makes no API call. One live answer proves nothing.

If no decision is named, ask one question: "Where does something get sorted, checked, or routed today, and what are the options?" Use the user's answer. If still vague, assume one common decision and mark it `Needs a test`; tell the user it was an assumption. If a task is already named, proceed. Use one to three rows. For a broader request, ask that one question first.

## Five conditions

A row is Jev-shaped only if all five hold:

1. Answers can be listed in advance: yes/no, one of N, or ordered levels.
2. One state goes in as it is: a string, object, or array. Do not flatten a record or chat log to text.
3. Code acts on each answer: route, block, retry, or flag.
4. The decision runs often or must be fast.
5. A wrong answer is survivable: cheap, caught later, or sent to a fallback.

## Marks

- `Jev could help`: all five hold and a simple rule is plausibly weak.
- `Needs a test`: all five hold, but a simple rule may be enough or the answers are not agreed.
- `Jev probably not`: any of conditions 1 to 3 fails, or the output is free text.

For open generation such as writing, summarizing, or explaining, mark the text step `Jev probably not` with type `none, text out`. Look for a separate decision around it, such as a gate or route.

## Pick the type per row

Choose by what the answer means, rather than the wording of the question.

| Answer needed | Type | Rule |
|---|---|---|
| Does one condition hold? | `noul` | Chance of yes from 0 to 1; no confidence value. Code sets the cutoff: 0.5 when both errors cost the same, higher when a false yes costs more, lower when a miss costs more. A middle band can go to a person. Ask one condition per noul. |
| Exactly one of a set | `choice` | List the options. If none may fit, add `none` and say what code does with it. Returns the selected option, a chance per option, and confidence. |
| A degree on ordered levels | `score` | Give 2 to 10 concrete levels, lowest first, with one dimension per score. Returns a position that can fall between levels, a chance per level, and confidence. |

- If several labels can apply at once, use one `noul` per label. Show them as one row with type `noul per label` and list the labels.
- If a yes/no phrase asks for intensity or rank, use `score`. A noul gives the chance of yes, not how much. Keep `noul` for a real cut, such as whether to escalate.
- A spectrum with no useful middle steps is a `choice` or several `noul` questions.
- Independent questions about the same state can share one request, even across types. Add a `Calls:` line when two or more rows share a state. A changed state or a question dependent on an earlier answer needs another call.

## Answer format

```text
You asked: <one line>
Read as: <the underlying job, one line>

| # | Decision Jev would answer | Type | Answers | Goes in (state) | Code does | Mark |
|---|---|---|---|---|---|---|

Calls: <only when multiple rows share a state>

Simple rule to beat:
1. <zero-cost rule, written before the test>

One test that settles it:
1. Label <at least 10> real <items>. Run the rule and Jev on the same items. Use Jev only if it gets more right at a cost you accept.

Not for Jev: <text output or open reasoning, and what handles it>
```

Use plain English. Define each type once where it appears. Give every row answers a builder could type today. Name the labelled item count and the correct answers to check. Do not promise a result or write the user's output for them.

Public references: [TypeSafe introduction](https://docs.typesafe.ai/introduction), [Jev!Jev API shapes](https://github.com/breakoutwithai/jevnotjev/blob/main/docs/api.md), and [when to use Jev](https://github.com/breakoutwithai/jevnotjev/blob/main/docs/product/use-cases/when-not-to-use-jev.md).
