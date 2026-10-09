# Run your own workflow

Run these commands from the repository root with Bun and the dependencies installed. Use synthetic or redacted cases: selected provider arms receive their text. The worked example reuses the 40 fictional ski-shop messages in [UC13](../examples/uc13-shop-bot/). Replace its question, cases and rule with your own before spending money.

## 1. Describe the decision

Pick one point in your workflow with a fixed answer set. Write what each answer means and when you would keep it before looking at any arm's output. Here the question is whether a ski-shop bot can answer a customer message from its [fact sheet](../examples/uc13-shop-bot/fact-sheet.md). `answer` means the sheet covers everything asked; `hand_off` means staff must check live stock, a booking, a policy, safety, or a complaint. Keep the same question and rule across all cases. The CLI's keyword rule matches case-insensitive substrings and only works with a two-choice question.

```sh
# guide: prepare
mkdir -p guide-work
printf 'guide-work ready\n'
```

```sh
# guide: question
bun -e '
const sheet = (await Bun.file("examples/uc13-shop-bot/fact-sheet.md").text()).trim();
const question = {
  name: "routing",
  type: "choice",
  instructions: `Fact sheet:\n${sheet}\n\nFor this fictional ski-shop message, can the bot answer from the fact sheet alone?`,
  choices: [
    { name: "answer", definition: "Everything asked is on the fact sheet; the bot can reply without promising an unstated fact." },
    { name: "hand_off", definition: "Staff must check live stock, a booking, a policy, safety, a complaint or another fact not on the sheet." },
  ],
};
await Bun.write("guide-work/question.json", JSON.stringify(question, null, 2) + "\n");
console.log("routing question ready");
'
```

Write the simple baseline before seeing model answers. This example sends any message containing one of these substrings to staff and answers the rest.

```sh
# guide: rule
tee guide-work/rule.json <<'JSON'
{
  "keywords": ["available", "stock", "book", "reserv", "hold", "confirm", "cancel", "refund", "deposit", "damage", "broke", "broken", "charged", "hurt", "injur", "avalanche", "safe", "danger", "weekend", "saturday", "sunday", "tomorrow"],
  "match": "hand_off",
  "otherwise": "answer"
}
JSON
```

## 2. Write 30+ cases

Each input case is JSONL with `id` and text `input`. Give every case a stable unique ID and include easy, hard and ambiguous examples. The existing UC13 file holds the same 40 fictional messages as `case_id` and `case_input`; this command changes only those field names for the decide CLI. For your own workflow, write your own JSONL instead. The [record format](../format/README.md) explains the output CSV and label columns.

```sh
# guide: cases
bun -e '
const lines = (await Bun.file("examples/uc13-shop-bot/cases.jsonl").text()).trim().split("\n");
const cases = lines.map((line) => {
  const item = JSON.parse(line);
  return { id: item.case_id, input: item.case_input };
});
if (cases.length < 30) throw new Error("Need at least 30 cases");
await Bun.write("guide-work/cases.jsonl", cases.map((item) => JSON.stringify(item)).join("\n") + "\n");
console.log(`${cases.length} cases ready`);
'
```

The verdict needs at least **30 paired labelled cases** for Jev versus the LLM. A case without either answer or its human label does not count toward that pair; 30 cases alone do not guarantee a decision.

## 3. Price it first

`estimate` makes no provider call. It shows an estimated price and how many paired labelled cases the verdict needs. Its price is an upper bound for API calls; the local `claude` CLI fallback has no output cap, so its cost can exceed that estimate. The [price table](api.md#price-table-read-2026-10-08), read on 2026-10-08, lists Jev at $0.042 per million input tokens with free output, Claude Haiku 5.5 at $0.10 input and $0.50 output per million below its 100,000-input-token tier, and the rule at $0. Check that dated table before a real run.

```sh
# guide: estimate
bun run decide estimate --questions guide-work/question.json --cases guide-work/cases.jsonl --arms jev,llm,rule --rule guide-work/rule.json
```

## 4. Run the arms

The first run needs no Jev key: `--arms llm,rule` selects the pinned LLM model from [the API guide](api.md) and the local rule. The LLM uses `ANTHROPIC_API_KEY` from your environment, or the local `claude` binary when that variable is absent. Check which transport you intend to pay for. Both paid commands set a $0.05 budget to stop before further calls once the projected spend would exceed it; the `claude` CLI can overshoot by one call because it has no output cap. Real LLM and Jev runs spend money; the commands below are replayed from test fixtures only in the automated guide test.

```sh
# guide: without-jev
bun run decide run --questions guide-work/question.json --cases guide-work/cases.jsonl --arms llm,rule --rule guide-work/rule.json --budget 0.05 --run-id guide-no-jev --out guide-work/no-jev.csv
```

For the three-arm comparison, set `JEV_API_KEY` (or `TYPESAFE_API_KEY`) in your shell, then run this command. The key is read from the environment, never a CLI flag or the CSV. It also uses the same LLM transport as the first run. `decisions` is a separate optional fourth arm and is outside this three-arm comparison.

```sh
# guide: with-jev
bun run decide run --questions guide-work/question.json --cases guide-work/cases.jsonl --arms jev,llm,rule --rule guide-work/rule.json --budget 0.05 --run-id guide-with-jev --out guide-work/with-jev.csv
```

## 5. Label blind

Keep any records files closed while judging the cases. For this UC13 example, open the local labelling page below. It shows the 40 messages and the fact sheet. Pick `answer` or `hand_off` for each message **before** its Jev suggestion appears; use `unsure` when you cannot decide. Click **Download labels.csv**, then save that download as `guide-work/labels.csv`. The `truth` column is your first blind pick; the later `final` column does not replace it. This page is specific to UC13. For your own cases, make a `case_id,truth,final,suggestion_shown,labelled_at` CSV from blind human judgments before reviewing the arm outputs; each `truth` value must be a choice name in your question. The Backstage judging room at `/backstage/` also supports blind picks when you run a scene there; its records export belongs to that Backstage run and is not an import of the CLI CSV.

```sh
# guide: label-page
open site/label/index.html
```

`open` is the macOS command. On Linux use `xdg-open site/label/index.html`; on Windows use `start site/label/index.html` in Command Prompt.

Once the truth file is saved, set `SOURCE`, `BY` and `BLIND` at the top of this script to describe how its labels were made. Use `human` and `true` for a blind human pick, `human` and `false` when a person saw the outputs, `human_reviewed` and `false` for an AI draft approved by a person, or `agent` and `false` for unreviewed AI. `BY` is the labeller's own handle (or the agent's model id). Only a blind human pick can judge Jev. This command compares each answered row to the chosen truth and writes labelled copies for whichever run files exist. A refused or errored row stays unlabelled.

```sh
# guide: merge-labels
bun -e '
import { readDictRows, formatRows } from "./src/format/csv.ts";
// Set these to the actual label provenance before running this script.
// Blind human: human,true; saw outputs: human,false; approved AI: human_reviewed,false; unreviewed AI: agent,false.
const SOURCE = "human";
const BY = "operator";
const BLIND = "true";
const labels = readDictRows(await Bun.file("guide-work/labels.csv").text());
const column = (header, name) => {
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`Missing ${name}`);
  return index;
};
if (!labels.header) throw new Error("Empty labels file");
const idAt = column(labels.header, "case_id");
const truthAt = column(labels.header, "truth");
const dateAt = column(labels.header, "labelled_at");
const question = JSON.parse(await Bun.file("guide-work/question.json").text());
const answers = new Set(question.choices.map((choice) => choice.name));
const truth = new Map();
for (const { fields } of labels.rows) {
  const id = fields[idAt];
  const pick = fields[truthAt];
  if (truth.has(id)) throw new Error(`Duplicate label ${id}`);
  if (!answers.has(pick)) throw new Error(`Invalid truth for ${id}`);
  truth.set(id, { pick, date: fields[dateAt] });
}
if (truth.size < 30) throw new Error("Need at least 30 blind truth picks");
const names = [];
const known = new Set();
for (const name of ["no-jev", "with-jev"]) {
  if (!(await Bun.file(`guide-work/${name}.csv`).exists())) continue;
  names.push(name);
  const records = readDictRows(await Bun.file(`guide-work/${name}.csv`).text());
  if (!records.header) throw new Error(`Empty ${name} records`);
  const caseAt = column(records.header, "case_id");
  for (const { fields } of records.rows) known.add(fields[caseAt]);
}
if (names.length === 0) throw new Error("Run no-jev or with-jev before merging labels");
for (const id of truth.keys()) {
  if (!known.has(id)) throw new Error(`Unknown label case_id ${id}`);
}
for (const name of names) {
  const source = readDictRows(await Bun.file(`guide-work/${name}.csv`).text());
  if (!source.header) throw new Error(`Empty ${name} records`);
  const header = source.header;
  const at = (name) => column(header, name);
  const caseAt = at("case_id");
  const outputAt = at("output");
  const outcomeAt = at("outcome");
  let labelled = 0;
  const rows = source.rows.map(({ fields }) => {
    const cells = [...fields];
    const picked = truth.get(cells[caseAt]);
    if (picked && cells[outcomeAt] === "answered") {
      cells[at("label")] = cells[outputAt] === picked.pick ? "accept" : "reject";
      cells[at("label_source")] = SOURCE;
      cells[at("labelled_by")] = BY;
      cells[at("labelled_at")] = picked.date;
      cells[at("label_blind")] = BLIND;
      labelled++;
    }
    return cells;
  });
  await Bun.write(`guide-work/${name}-labelled.csv`, formatRows([header, ...rows]));
  console.log(`${name}: labelled ${labelled} rows`);
}
'
```

## 6. Load the file

Validate each labelled file you made. With only the no-Jev run, use `guide-work/no-jev-labelled.csv`; with the three-arm run, use `guide-work/with-jev-labelled.csv`. A `VALID` result can still list unlabelled gaps; fix those before expecting 30 pairs. Then open the local results page and use **Load your own script (CSV)** to choose either labelled file. The page reads the file in your browser, shows the arm costs and verdict, and limits files to 5 MB.

```sh
# guide: validate
for file in guide-work/*-labelled.csv; do bun run decide validate "$file"; done
```

```sh
# guide: result-page
open site/index.html
```

`open` is the macOS command. On Linux use `xdg-open site/index.html`; on Windows use `start site/index.html` in Command Prompt.

## 7. Read the verdict

The CLI scores the labelled CSV for `routing`. Run the no-Jev command when you have only `no-jev-labelled.csv`; it says **not enough evidence** because it has no Jev rows, even with 40 labelled LLM cases. Run the with-Jev command when you have `with-jev-labelled.csv`, then read the reason, pair counts, cost per accepted answer and limitations. The three possible verdicts are **use Jev** (exit 0), **don't use Jev** (exit 3) and **not enough evidence** (exit 4). Invalid input exits 2. A verdict applies to your labelled test set only. See the full [verdict rules](decision/verdict-rules.md).

```sh
# guide: verdict-no-jev
bun run decide verdict guide-work/no-jev-labelled.csv --question routing
```

```sh
# guide: verdict-with-jev
bun run decide verdict guide-work/with-jev-labelled.csv --question routing
```
