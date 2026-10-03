import { BackstageRun, parseCases, validateSceneKeys } from "./run.ts";
import { PROTOCOL_VERSION } from "./contracts.ts";
import type { Scene } from "./contracts.ts";
import type { Spend, CostPerAccepted } from "../core/metrics.ts";
declare const BACKSTAGE_BUILD_VERSION: string;
function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing ${id}`);
  return value;
}
function field(id: string): HTMLInputElement | HTMLTextAreaElement {
  const value = element(id);
  if (
    !(value instanceof HTMLInputElement) &&
    !(value instanceof HTMLTextAreaElement)
  )
    throw new Error("Invalid field");
  return value;
}
function button(id: string): HTMLButtonElement {
  const value = element(id);
  if (!(value instanceof HTMLButtonElement)) throw new Error("Invalid button");
  return value;
}
function text(id: string, value: string) {
  element(id).textContent = value;
}
function node(tag: string, content: string): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = content;
  return e;
}
let room = 0;
let run: BackstageRun | undefined;
let cardIndex = 0;
let renderEpoch = 0;
let imported: Scene["cases"] | undefined;
function notice(message: string) {
  text("notice", message);
}
function showRoom(next: number) {
  room = Math.max(0, Math.min(5, next));
  for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]"))
    panel.hidden = panel.dataset.panel !== String(room);
  for (const item of document.querySelectorAll<HTMLElement>("[data-room]")) {
    if (item.dataset.room === String(room))
      item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
  button("back").disabled = room === 0;
  button("next").disabled = room === 5;
  text("room-count", `${room + 1} / 6`);
  document.querySelector<HTMLElement>(`[data-panel="${room}"] h2`)?.focus();
  void render();
}
function cases(): Scene["cases"] {
  return (
    imported ??
    field("cases")
      .value.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((input, index) => ({ id: `case-${index + 1}`, input }))
  );
}
function scene(firstOnly: boolean): Scene {
  const all = cases();
  return {
    question: field("question").value.trim(),
    choices: [
      {
        name: field("choice-a").value.trim(),
        definition: field("definition-a").value.trim(),
      },
      {
        name: field("choice-b").value.trim(),
        definition: field("definition-b").value.trim(),
      },
    ],
    acceptance: field("acceptance").value.trim(),
    exclusions: field("exclusions").value.trim(),
    keywords: field("keywords")
      .value.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
    matchChoice: field("choice-a").value.trim(),
    otherwiseChoice: field("choice-b").value.trim(),
    cases: firstOnly ? all.slice(0, 1) : all,
  };
}
function keys() {
  return {
    jev: field("jev-key").value.trim(),
    llm: field("llm-key").value.trim(),
  };
}
function freezeFields(frozen: boolean) {
  for (const id of ["scene-fields", "rule-fields", "case-fields"]) {
    const value = element(id);
    if (value instanceof HTMLFieldSetElement) value.disabled = frozen;
  }
}
async function checkServer() {
  const response = await fetch("/api/backstage/health", { cache: "no-store" });
  if (!response.ok)
    throw new Error("Runner unavailable. Start the matching Backstage server.");
  const health: unknown = await response.json();
  if (
    typeof health !== "object" ||
    health === null ||
    !("protocol" in health) ||
    health.protocol !== PROTOCOL_VERSION ||
    !("version" in health) ||
    health.version !== BACKSTAGE_BUILD_VERSION
  )
    throw new Error("Page and runner versions differ. Reload before running.");
}
let starting = false;
async function start(firstOnly: boolean, retry = false) {
  if (starting || run?.running) return;
  starting = true;
  button("run-one").disabled = true;
  button("run-all").disabled = true;
  button("retry").disabled = true;
  try {
    const supplied = keys();
    if (!supplied.jev || !supplied.llm)
      throw new Error("Enter both provider keys in Casting first.");
    await checkServer();
    if (!retry) {
      if (run)
        throw new Error(
          "This scene is already frozen. Retry unfinished calls or edit as a new scene.",
        );
      const candidate = scene(firstOnly);
      validateSceneKeys(candidate, supplied);
      run = new BackstageRun(candidate);
      cardIndex = 0;
      freezeFields(true);
    }
    const current = run;
    if (!current) return;
    notice("Rehearsing. Calls use your provider accounts.");
    const refresh = () => {
      if (run === current) void render();
    };
    if (retry) await current.retry(supplied, undefined, refresh);
    else await current.start(supplied, undefined, refresh);
    if (run === current)
      notice(
        "Run stopped. Review failures in Learning Lines, then judge answers in Rehearsals.",
      );
  } catch (error) {
    notice(error instanceof Error ? error.message : "Could not start the run.");
  } finally {
    starting = false;
    void render();
  }
}
function money(value: number) {
  return `$${value.toPrecision(3)}`;
}
function spend(value: Spend) {
  return value.kind === "complete"
    ? money(value.usd)
    : `${money(value.knownUsd)} known; ${value.missing} missing`;
}
function cpa(value: CostPerAccepted) {
  return value.kind === "value" ? money(value.usd) : value.reason;
}
function table(headers: string[], rows: string[][]): HTMLElement {
  const wrap = node("div", "");
  wrap.className = "table-wrap";
  const t = document.createElement("table");
  const head = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const label of headers) {
    const th = node("th", label);
    th.setAttribute("scope", "col");
    tr.append(th);
  }
  head.append(tr);
  t.append(head);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const line = document.createElement("tr");
    for (const cell of row) line.append(node("td", cell));
    body.append(line);
  }
  t.append(body);
  wrap.append(t);
  return wrap;
}
async function render() {
  const epoch = ++renderEpoch;
  const current = run;
  const running = current?.running ?? false;
  button("run-one").disabled = starting || !!current;
  button("run-all").disabled = starting || !!current;
  button("stop").disabled = !running;
  button("retry").disabled =
    starting ||
    !current ||
    running ||
    current.completed === current.total ||
    current.revealed;
  button("new-scene").disabled = running || starting;
  button("download-csv").disabled = !current || running || !current.revealed;
  button("download-evidence").disabled =
    !current || running || !current.revealed;
  button("reveal").disabled = !current || running || current.revealed;
  const count = current?.manifest.scene.cases.length ?? cases().length;
  text(
    "run-preview",
    current
      ? `${count} frozen cases. ${current.completed} of ${current.total} provider answers completed.`
      : `${count} cases. Run all makes ${count * 2} paid calls plus the local rule. First case makes 2 paid calls.`,
  );
  const progress = element("progress");
  progress.replaceChildren();
  if (current) {
    progress.append(
      node("p", running ? "Calls in progress..." : "No calls in progress."),
    );
    for (const attempt of current.attempts) {
      progress.append(
        node(
          "p",
          `${attempt.caseId} / ${attempt.provider}: ${attempt.ok ? "answer received" : `${attempt.message} Charge: ${attempt.charge}.`}`,
        ),
      );
    }
  }
  renderCard();
  if (!current) return;
  if (!current.revealed) {
    element("metrics").replaceChildren(
      node(
        "p",
        "Finish your labels in Rehearsals, then reveal results. Revealing locks this labeling pass.",
      ),
    );
    element("verdict").replaceChildren(
      node("p", "Results stay hidden until you reveal them in Rehearsals."),
    );
    return;
  }
  try {
    const report = await current.report();
    if (epoch !== renderEpoch || current !== run) return;
    const metrics = element("metrics");
    metrics.replaceChildren(
      node("h3", "All successful answers"),
      table(
        ["Player", "Kept / labelled", "Unlabelled", "Spend", "Cost / kept"],
        report.metrics.arms.map((a) => [
          a.arm,
          `${a.accepted} / ${a.labelled}`,
          String(a.unlabelled),
          spend(a.spend),
          cpa(a.costPerAccepted),
        ]),
      ),
    );
    for (const pair of [report.metrics.jevVsLlm, report.metrics.jevVsRule]) {
      if (!pair) continue;
      metrics.append(
        node("h3", `Jev vs ${pair.other}`),
        node(
          "p",
          `${pair.n} paired labelled cases; ${pair.excluded} excluded. Both kept ${pair.a}, Jev only ${pair.b}, other only ${pair.c}, neither ${pair.d}.`,
        ),
        table(
          ["Player", "Kept", "Paired spend", "Cost / kept"],
          [pair.jev, pair.otherArm].map((a) => [
            a.arm,
            String(a.accepted),
            spend(a.spend),
            cpa(a.costPerAccepted),
          ]),
        ),
      );
    }
    metrics.append(
      node(
        "p",
        `Additional failed/uncertain attempts: ${money(report.extraSpend.knownUsd)} known, ${report.extraSpend.unknown} with unknown spend. These costs are not included in successful-answer comparisons.`,
      ),
    );
    const result = element("verdict");
    result.replaceChildren(
      node("h3", report.verdict.verdict),
      node("p", `Rule ${report.verdict.rule}: ${report.verdict.reason}`),
    );
    for (const unmet of report.verdict.unmet) result.append(node("p", unmet));
  } catch {
    notice(
      "Cannot calculate this run. Download its evidence before starting a new scene.",
    );
  }
}
function renderCard() {
  const current = run;
  const container = element("blind-card");
  const cards = current && !current.running ? current.cards() : [];
  cardIndex = Math.max(0, Math.min(cardIndex, cards.length - 1));
  const card = cards[cardIndex];
  element("label-actions").hidden = !card || !!current?.revealed;
  button("previous-card").disabled = !card || cardIndex === 0;
  button("next-card").disabled = !card || cardIndex >= cards.length - 1;
  if (!card) {
    container.replaceChildren(
      node(
        "p",
        current?.running
          ? "Let the run stop before labeling."
          : "No answers to judge yet.",
      ),
    );
    return;
  }
  text("rubric", `Keep when: ${current?.manifest.scene.acceptance ?? ""}`);
  container.className = "answer-card";
  const answer = node("p", card.output);
  answer.className = "answer";
  container.replaceChildren(
    node("p", `Answer ${cardIndex + 1} of ${cards.length} / ${card.caseId}`),
    node("h3", current?.manifest.scene.question ?? ""),
    node("p", card.input),
    answer,
    node("p", `Your label: ${card.label ?? "No label"}`),
  );
}
function label(value: "accept" | "reject" | null) {
  const card = run?.cards()[cardIndex];
  if (!card || !run || run.running || run.revealed) return;
  run.label(card.id, value);
  cardIndex = Math.min(cardIndex + 1, run.cards().length - 1);
  void render();
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
for (const item of document.querySelectorAll<HTMLElement>("[data-room]"))
  item.addEventListener("click", () => showRoom(Number(item.dataset.room)));
button("back").onclick = () => showRoom(room - 1);
button("next").onclick = () => showRoom(room + 1);
button("run-one").onclick = () => void start(true);
button("run-all").onclick = () => void start(false);
button("retry").onclick = () => void start(false, true);
button("stop").onclick = () => {
  run?.stop();
  notice(
    "Stopped. In-flight calls may still be charged; completed answers are kept.",
  );
  void render();
};
button("reveal").onclick = () => {
  if (!run || run.running) return;
  if (
    !confirm(
      "Reveal the players and lock your labels? You can leave answers unlabelled. Retry unfinished calls before revealing.",
    )
  )
    return;
  run.reveal();
  notice("Results revealed. Labels and retries are now locked for this run.");
  showRoom(4);
};
button("clear-keys").onclick = () => {
  field("jev-key").value = "";
  field("llm-key").value = "";
  notice(
    "Key fields cleared. Stop any active run to release its request references.",
  );
};
button("new-scene").onclick = () => {
  if (
    run &&
    !confirm(
      "Start a new scene? Download your records and evidence first; this clears the current run.",
    )
  )
    return;
  run?.stop();
  run = undefined;
  cardIndex = 0;
  freezeFields(false);
  element("metrics").replaceChildren(node("p", "No run yet."));
  element("verdict").replaceChildren(node("p", "No run yet."));
  notice("Scene unlocked. Your next run gets a new identity.");
  showRoom(0);
};
button("accept").onclick = () => label("accept");
button("reject").onclick = () => label("reject");
button("unlabel").onclick = () => label(null);
button("previous-card").onclick = () => {
  cardIndex--;
  renderCard();
};
button("next-card").onclick = () => {
  cardIndex++;
  renderCard();
};
button("download-csv").onclick = () => {
  if (run?.revealed)
    download("records.csv", run.csv(), "text/csv;charset=utf-8");
};
button("download-evidence").onclick = () => {
  if (run?.revealed)
    download(
      "backstage-evidence.json",
      JSON.stringify(run.evidence(), null, 2),
      "application/json",
    );
};
field("cases").addEventListener("input", () => {
  imported = undefined;
  void render();
});
field("import-cases").addEventListener("change", async () => {
  const input = field("import-cases");
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 1000000)
      throw new Error("Case CSV must be smaller than 1 MB.");
    imported = parseCases(await file.text());
    field("cases").value = imported
      .map((c) => c.input.replaceAll("\n", " / "))
      .join("\n");
    notice(
      `Imported ${imported.length} cases; original multiline text is preserved.`,
    );
  } catch (error) {
    notice(error instanceof Error ? error.message : "Could not read CSV.");
  }
  void render();
});
button("theme").onclick = () => {
  document.documentElement.dataset.theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
};
if (matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.dataset.theme = "dark";
window.addEventListener("beforeunload", (event) => {
  if (run) {
    event.preventDefault();
    event.returnValue = "";
  }
});
showRoom(0);
