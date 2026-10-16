# Run note

One dated note per fresh run, from setup to verdict. Keep the filled note private: never commit it to this repository.

## Run details

- **Date (YYYY-MM-DD):**
- **Run by (handle only):**
- **Site and served build (`/DEPLOYED_SHA` value):**
- **Browser and device:**
- **Start time:**
- **End time:**
- **Sample data used (synthetic only):**

## Steps

One row per step of [the tester checklist](tester-checklist.md).

| Step | Title | Worked (Y/N) | What you saw (no question, case text or answers) | Issue (values replaced with `<value>`) |
|---|---|---|---|---|
| 1 | Write the decision and judging rule |  |  |  |
| 2 | Add your cases |  |  |  |
| 3 | Run Jev, an LLM and a rule on every case |  |  |  |
| 4 | Review the answers blind |  |  |  |
| 5 | Reach a verdict |  |  |  |

## Verdict

Copy each comparison as shown on the Verdict room.

- **Comparison name:**
- **Verdict word:**
- **Reason, as shown:**

## Issues

Each issue names the step it breaks.

1. Step N:

## Before sharing

- Run `bun scripts/uat/scan-run-note.ts <your-note.md>`. It must report 0 findings. It does not detect names, so use handles.
- Check the note against the [Never send](tester-checklist.md#never-send) list in the checklist.
