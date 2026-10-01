/*
 * Stage-door demo data. The UI (stage-door.js) reads only this shape:
 *
 * window.UC13_DEMO = {
 *   schema: "jnj-uc13-demo/1",
 *   mode: "sample" | "pending" | "labelled",
 *   note: string,                         shown under the demo title
 *   source: string,                       where the rows came from
 *   cases_total: number,                  messages in the full run
 *   fact_sheet: { title: string, lines: string[] },
 *   arms: [{ key: string, name: string, model: string }],
 *   messages: [{ id: string, text: string, label: "answer" | "hand_off" | null,
 *                outputs: { [arm key]: { output: "answer" | "hand_off", verdict: "accept" | "reject" | "pending" } } }],
 *   tally: { [arm key]: { answer: number, hand_off: number, cost_usd: number, labelled: number,
 *            accept: number | null, answered_should_hand_off: number | null, handed_off_could_answer: number | null } },
 *   label_page: string | null             link for "label these yourself", or null
 * };
 *
 * This file is a SAMPLE placeholder of that shape. A generator replaces it with the recorded run.
 */
window.UC13_DEMO = {
  "schema": "jnj-uc13-demo/1",
  "mode": "sample",
  "note": "SAMPLE DATA: a placeholder shaped like the recorded run. The real messages and answers arrive with the data update.",
  "source": "placeholder",
  "cases_total": 4,
  "fact_sheet": {
    "title": "Sample shop fact sheet",
    "lines": [
      "Sample line: opening hours.",
      "Sample line: daily prices for rental items.",
      "Not on this sheet: live stock, bookings, refunds."
    ]
  },
  "arms": [
    { "key": "llm", "name": "What you do now", "model": "sample" },
    { "key": "rule", "name": "A simple rule", "model": "sample" },
    { "key": "jev", "name": "Jev decides", "model": "sample" }
  ],
  "messages": [
    { "id": "s1", "text": "Sample message: a price the sheet covers.", "label": null,
      "outputs": { "llm": { "output": "answer", "verdict": "pending" }, "rule": { "output": "answer", "verdict": "pending" }, "jev": { "output": "answer", "verdict": "pending" } } },
    { "id": "s2", "text": "Sample message: is it in stock this weekend?", "label": null,
      "outputs": { "llm": { "output": "hand_off", "verdict": "pending" }, "rule": { "output": "hand_off", "verdict": "pending" }, "jev": { "output": "hand_off", "verdict": "pending" } } },
    { "id": "s3", "text": "Sample message: a question with no rule word that still needs staff.", "label": null,
      "outputs": { "llm": { "output": "hand_off", "verdict": "pending" }, "rule": { "output": "answer", "verdict": "pending" }, "jev": { "output": "hand_off", "verdict": "pending" } } },
    { "id": "s4", "text": "Sample message: a rule word, but the sheet answers it.", "label": null,
      "outputs": { "llm": { "output": "answer", "verdict": "pending" }, "rule": { "output": "hand_off", "verdict": "pending" }, "jev": { "output": "answer", "verdict": "pending" } } }
  ],
  "tally": {
    "llm": { "answer": 2, "hand_off": 2, "cost_usd": 0, "labelled": 0, "accept": null, "answered_should_hand_off": null, "handed_off_could_answer": null },
    "rule": { "answer": 2, "hand_off": 2, "cost_usd": 0, "labelled": 0, "accept": null, "answered_should_hand_off": null, "handed_off_could_answer": null },
    "jev": { "answer": 2, "hand_off": 2, "cost_usd": 0, "labelled": 0, "accept": null, "answered_should_hand_off": null, "handed_off_could_answer": null }
  },
  "label_page": null
};
