import {
  BackstageRun,
  CaseImportState,
  checkRunnerHealth,
  validateSceneKeys,
  trialTransport,
} from "./run.ts";
import { MODEL_CATALOG, CATALOG_CHECKED_DATE, JEV_ARM_ID } from "./catalog.ts";
import { copyDecision } from "./copy.ts";
import {
  confirmPanel,
  resolveConfirm,
  CONFIRM_STEPS,
  type ConfirmStep,
} from "./confirm.ts";
import type { Scene, RunMode, Provider, ProviderKeys } from "./contracts.ts";
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
const imports = new CaseImportState();
let startup: AbortController | undefined;
function notice(message: string) {
  text("notice", message);
}
// Stable ids of the buttons that open each confirm panel; focus returns there on Cancel.
const confirmOpener: Record<ConfirmStep, string> = {
  judging: "open-judging",
  reveal: "reveal",
  "new-scene": "new-scene",
};
let openConfirmStep: ConfirmStep | undefined;
function fillConfirm(step: ConfirmStep, current: BackstageRun) {
  const panel = confirmPanel(step, current);
  text(panel.id + "-title", panel.title);
  text(panel.id + "-message", panel.message);
}
function openConfirm(step: ConfirmStep, current: BackstageRun) {
  for (const other of CONFIRM_STEPS)
    element("confirm-" + other).hidden = other !== step;
  fillConfirm(step, current);
  openConfirmStep = step;
  element("confirm-" + step).focus();
}
function closeConfirm(step: ConfirmStep, restoreFocus: boolean) {
  element("confirm-" + step).hidden = true;
  if (openConfirmStep === step) openConfirmStep = undefined;
  if (restoreFocus) document.getElementById(confirmOpener[step])?.focus();
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
function mode(): RunMode {
  const input = field("compare");
  return input instanceof HTMLInputElement && input.checked
    ? "compare"
    : "jev-only";
}
const providerNames: Record<Provider, string> = {
  jev: "Jev",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
};
const providers: readonly Provider[] = [
  "jev",
  "anthropic",
  "openai",
  "google",
  "xai",
];
function keys(): ProviderKeys {
  const values: ProviderKeys = {};
  for (const provider of providers)
    values[provider] = field(provider + "-key").value.trim();
  return values;
}
function selectedArms(): string[] {
  return [
    JEV_ARM_ID,
    ...(mode() === "compare"
      ? Array.from(
          document.querySelectorAll<HTMLInputElement>("[data-arm]:checked"),
        ).map((input) => input.dataset.arm ?? "")
      : []),
    ...(mode() === "compare" && checked("include-rule") ? ["rule"] : []),
  ];
}
function checked(id: string): boolean {
  const value = field(id);
  return value instanceof HTMLInputElement && value.checked;
}
function mountCatalog() {
  const container = element("model-options");
  const keyContainer = element("provider-keys");
  for (const provider of providers.filter((p) => p !== "jev")) {
    const group = document.createElement("fieldset");
    group.append(node("legend", providerNames[provider]));
    for (const entry of MODEL_CATALOG.filter((e) => e.provider === provider)) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.arm = entry.id;
      input.disabled = !entry.enabled;
      input.addEventListener("change", () => void render());
      label.append(
        input,
        document.createTextNode(
          " " +
            entry.label +
            (entry.pricing ? "" : " — price unverified") +
            (entry.preview ? " — preview" : ""),
        ),
      );
      group.append(label);
    }
    container.append(group);
    const article = document.createElement("article");
    article.id = provider + "-key-player";
    article.hidden = true;
    const label = document.createElement("label");
    label.append(document.createTextNode(providerNames[provider] + " API key"));
    const input = document.createElement("input");
    input.id = provider + "-key";
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    label.append(input);
    article.append(
      label,
      node("p", "Only selected models from this provider use this key."),
    );
    keyContainer.append(article);
  }
  text(
    "catalog-note",
    "Catalog checked " +
      CATALOG_CHECKED_DATE +
      ". Account access is checked only when you run. Prices are estimates; unmapped usage stays unknown.",
  );
}
let activeKeys: ProviderKeys = {};
function freezeFields(frozen: boolean) {
  for (const id of [
    "scene-fields",
    "rule-fields",
    "case-fields",
    "mode-fields",
    "model-fields",
  ]) {
    const value = element(id);
    if (value instanceof HTMLFieldSetElement) value.disabled = frozen;
  }
}
let starting = false;
let trialAvailable = false;
async function start(firstOnly: boolean, retry = false, funded = false) {
  if (starting || run?.running) return;
  if (imports.pending) {
    notice("Wait for the case import or edit the cases to cancel it.");
    return;
  }
  starting = true;
  const controller = new AbortController();
  startup = controller;
  try {
    activeKeys = keys();
    let current = run;
    if (!retry) {
      if (current)
        throw new Error(
          "This scene is already frozen. Retry unfinished calls or edit as a new scene.",
        );
      // Capture and validate before the first asynchronous operation: Run authorizes these exact inputs.
      const candidate = scene(firstOnly);
      const selectedMode = mode();
      if (!funded) validateSceneKeys(candidate, activeKeys, selectedMode);
      current = new BackstageRun(candidate, BACKSTAGE_BUILD_VERSION, {
        arms: funded ? [JEV_ARM_ID] : selectedArms(),
      });
      imports.invalidate();
      freezeFields(true);
    } else if (!current || current.labeling)
      throw new Error("Retries are locked once blind judging begins.");
    void render();
    await checkRunnerHealth(BACKSTAGE_BUILD_VERSION, controller.signal);
    if (controller.signal.aborted) return;
    if (!retry) {
      run = current;
      cardIndex = 0;
    }
    if (!current) return;
    notice(
      funded
        ? "Running one funded Jev query. The allowance stays consumed after a dispatched call."
        : "Rehearsing. Calls use your provider accounts.",
    );
    const refresh = () => {
      if (run === current) void render();
    };
    if (funded) await current.startTrial(trialTransport(), refresh);
    else if (retry) await current.retry(() => activeKeys, undefined, refresh);
    else await current.start(() => activeKeys, undefined, refresh);
    if (run === current)
      notice(
        current.manifest.mode === "compare"
          ? "Calls stopped. Decide whether to retry unfinished calls, then open blind judging in Rehearsals."
          : "Calls stopped. Jev answers appear below. Retry unfinished calls or open judging in Rehearsals to label and export.",
      );
  } catch (error) {
    notice(error instanceof Error ? error.message : "Could not start the run.");
  } finally {
    activeKeys = {};
    starting = false;
    startup = undefined;
    if (!run) freezeFields(false);
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
function answerTable(current: BackstageRun): HTMLElement {
  return table(
    ["Case", "Model", "Answer", "Returned confidence"],
    current
      .results()
      .map((answer) => [
        answer.caseId,
        answer.armId,
        answer.output,
        answer.confidence === null ? "Not returned" : String(answer.confidence),
      ]),
  );
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
  if (openConfirmStep) {
    if (current) fillConfirm(openConfirmStep, current);
    else closeConfirm(openConfirmStep, false);
  }
  const running = current?.running ?? false;
  const comparison = (current?.manifest.mode ?? mode()) === "compare";
  element("llm-player").hidden = !comparison;
  element("rule-fields").hidden = !(current
    ? current.manifest.arms.includes("rule")
    : comparison && checked("include-rule"));
  const arms = current?.manifest.arms ?? selectedArms();
  for (const provider of providers.filter((p) => p !== "jev"))
    element(provider + "-key-player").hidden = !arms.some(
      (id) => MODEL_CATALOG.find((e) => e.id === id)?.provider === provider,
    );
  element("comparison-note").hidden = !comparison;
  text(
    "judging-direction",
    comparison
      ? "Judge the answer before you learn who gave it."
      : "Judge Jev’s answer against your acceptance rule.",
  );
  text(
    "judging-note",
    comparison
      ? "Player, model, confidence, cost and timing are hidden here. Order is shuffled. Labels are yours; no model grades itself."
      : "This run contains Jev only. Confidence is the model’s score, not measured accuracy. Your labels are optional and remain separate.",
  );
  button("run-trial").disabled =
    !trialAvailable || starting || !!current || imports.pending;
  button("run-one").disabled = starting || imports.pending || !!current;
  button("run-all").disabled = starting || imports.pending || !!current;
  button("stop").disabled = !running && !starting;
  button("retry").disabled =
    starting ||
    !current ||
    running ||
    current.pending === 0 ||
    current.labeling ||
    current.funded;
  button("new-scene").disabled = running || starting;
  button("download-csv").disabled =
    !current?.exportable || (!current.revealed && current.cards().length > 0);
  button("download-evidence").disabled =
    !current?.exportable ||
    (current.manifest.mode === "compare" &&
      !current.revealed &&
      current.cards().length > 0);
  button("reveal").textContent = comparison
    ? "Reveal results and lock labels"
    : "Finish judging and unlock downloads";
  button("reveal").disabled =
    !current || running || starting || !current.labeling || current.revealed;
  const count = current?.manifest.scene.cases.length ?? cases().length;
  text(
    "run-preview",
    current
      ? `${count} frozen cases. ${current.completed} of ${current.total} selected case/model cells processed; ${current.pending} have no answer.`
      : `${count} cases. Run all requests up to ${count * arms.filter((id) => id !== "rule").length} paid calls; first case up to ${arms.filter((id) => id !== "rule").length}. Missing competitor keys skip only those models.`,
  );
  const progress = element("progress");
  progress.replaceChildren();
  if (current) {
    progress.append(
      node("p", running ? "Calls in progress..." : "No calls in progress."),
    );
    if (!current.revealed) {
      const extra = current.extraSpend();
      progress.append(
        node(
          "p",
          `${current.pending} selected calls have no answer. Failed attempts: ${money(extra.knownUsd)} known spend, ${extra.unknown} with unknown charges. ${comparison ? "Provider details stay hidden until results are revealed." : "Completed Jev answers and returned confidence appear below."}`,
        ),
      );
    }
    if (!current.revealed)
      for (const message of current.retryAdvice())
        progress.append(node("p", message));
    for (const attempt of current.revealed ? current.attempts : []) {
      progress.append(
        node(
          "p",
          `${attempt.caseId} / ${attempt.armId}: ${attempt.ok ? "answer received" : `${attempt.message} Charge: ${attempt.charge}.`}`,
        ),
      );
    }
  }
  if (
    current?.manifest.mode === "jev-only" &&
    !current.revealed &&
    current.results().length
  ) {
    progress.append(node("h3", "Jev answers"), answerTable(current));
  }
  renderCard();
  if (!current) return;
  if (!current.revealed && current.cards().length > 0) {
    element("metrics").replaceChildren(
      node(
        "p",
        "Finish your labels in Rehearsals, then reveal results. Revealing locks this labeling pass.",
      ),
    );
    element("verdict").replaceChildren(
      node(
        "p",
        comparison
          ? "Results stay hidden until you reveal them in Rehearsals."
          : "Jev answers are visible in Learning Lines. Finish judging in Rehearsals to unlock the summary and downloads; labels are optional.",
      ),
    );
    return;
  }
  try {
    const report = await current.report();
    if (epoch !== renderEpoch || current !== run) return;
    const metrics = element("metrics");
    metrics.replaceChildren(node("h3", "Results by comparison"));
    metrics.append(
      node(
        "p",
        "Total actual attempts: " +
          money(report.totalSpend.knownUsd) +
          " known; " +
          report.totalSpend.unknown +
          " unknown charges. Shared Jev answers are billed once here.",
      ),
    );
    const result = element("verdict");
    result.replaceChildren();
    for (const pair of report.pairs) {
      metrics.append(
        node("h3", pair.armId),
        table(
          [
            "Player",
            "Kept / labelled",
            "Unlabelled",
            "Answers-only spend",
            "Cost / kept",
          ],
          pair.metrics.arms.map((a) => [
            a.arm,
            a.accepted + " / " + a.labelled,
            String(a.unlabelled),
            spend(a.spend),
            cpa(a.costPerAccepted),
          ]),
        ),
      );
      for (const sample of [pair.metrics.jevVsLlm, pair.metrics.jevVsRule])
        if (sample)
          metrics.append(
            node(
              "p",
              sample.n +
                " paired labelled cases; " +
                sample.excluded +
                " excluded. Jev-only wins " +
                sample.b +
                ", other-only wins " +
                sample.c +
                ".",
            ),
          );
      if (pair.verdict) {
        result.append(
          node("h3", pair.armId + " — " + pair.verdict.verdict),
          node("p", "Per-pair, uncorrected comparison. " + pair.verdict.reason),
        );
        for (const unmet of pair.verdict.unmet) result.append(node("p", unmet));
      }
    }
    if (!report.pairs.some((pair) => pair.verdict))
      result.append(
        node(
          "h3",
          report.metrics.arms.length
            ? "Jev-only rehearsal"
            : "No successful answers",
        ),
        node(
          "p",
          "No comparative recommendation. Export records and attempt evidence below.",
        ),
      );
    metrics.append(answerTable(current));
    if (report.pairs.length > 1)
      result.append(
        node(
          "p",
          "Each comparator is assessed separately. No overall winner is selected; do not sum pair spend.",
        ),
      );
  } catch {
    notice(
      "Cannot calculate this run. Download its evidence before starting a new scene.",
    );
  }
}
function renderCard() {
  const current = run;
  const container = element("blind-card");
  const cards =
    current && !current.running && current.labeling ? current.cards() : [];
  cardIndex = Math.max(0, Math.min(cardIndex, cards.length - 1));
  const card = cards[cardIndex];
  button("unlabel").removeAttribute("aria-pressed");
  for (const [id, value] of [
    ["accept", "accept"],
    ["reject", "reject"],
  ])
    if (id)
      button(id).setAttribute(
        "aria-pressed",
        String(!!card && card.label === value),
      );
  element("label-actions").hidden = !card || !!current?.revealed;
  button("previous-card").disabled = !card || cardIndex === 0;
  button("next-card").disabled = !card || cardIndex >= cards.length - 1;
  if (!card) {
    container.replaceChildren(
      node(
        "p",
        current?.running
          ? "Let the run stop before judging."
          : current?.manifest.mode === "jev-only"
            ? "Complete your retry decisions before opening judging. You may leave every answer unlabelled; finishing this step unlocks exports."
            : "Complete your retry decisions before opening blind judging. After that, this set of answers cannot change.",
      ),
    );
    if (
      current?.started &&
      !current.running &&
      !current.labeling &&
      current.cards().length > 0 &&
      !starting
    ) {
      const begin = document.createElement("button");
      begin.type = "button";
      begin.id = confirmOpener.judging;
      begin.setAttribute("aria-controls", "confirm-judging");
      begin.textContent =
        current.manifest.mode === "compare"
          ? "Open blind judging and lock retries"
          : "Open judging and lock retries";
      begin.onclick = () => openConfirm("judging", current);
      container.append(begin);
    }
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
  if (!card || !run || run.running || !run.labeling || run.revealed) return;
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
  startup?.abort();
  run?.stop();
  notice(
    run?.running
      ? "Stopped. In-flight calls may still be charged; completed answers are kept."
      : "Runner check cancelled. No new provider calls were started.",
  );
  void render();
};
function confirmJudging() {
  const current = run;
  closeConfirm("judging", false);
  if (!current) return;
  try {
    resolveConfirm("judging", "yes", current);
    void render();
    element("rehearsal-title").focus();
  } catch (error) {
    notice(
      error instanceof Error
        ? error.message
        : "Could not open blind judging. Start a new scene.",
    );
  }
}
button("reveal").onclick = () => {
  if (!run || run.running || !run.labeling) return;
  openConfirm("reveal", run);
};
function confirmReveal() {
  closeConfirm("reveal", false);
  if (!run || run.running || !run.labeling) return;
  resolveConfirm("reveal", "yes", run);
  notice("Results revealed. Labels and retries are now locked for this run.");
  showRoom(4);
}
button("clear-keys").onclick = () => {
  activeKeys = {};
  startup?.abort();
  run?.stop();
  for (const provider of providers) field(provider + "-key").value = "";
  notice(
    "Keys cleared and further calls stopped. Already dispatched calls may still be charged.",
  );
};
button("new-scene").onclick = () => {
  if (run) openConfirm("new-scene", run);
  else clearScene();
};
function confirmNewScene() {
  closeConfirm("new-scene", false);
  if (run && resolveConfirm("new-scene", "yes", run).kind !== "cleared") return;
  clearScene();
}
const confirmYes: Record<ConfirmStep, () => void> = {
  judging: confirmJudging,
  reveal: confirmReveal,
  "new-scene": confirmNewScene,
};
for (const step of CONFIRM_STEPS) {
  button(`confirm-${step}-yes`).onclick = () => confirmYes[step]();
  button(`confirm-${step}-no`).onclick = () => closeConfirm(step, true);
  element(`confirm-${step}`).addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeConfirm(step, true);
  });
}
function clearScene() {
  startup?.abort();
  imports.invalidate();
  run?.stop();
  run = undefined;
  cardIndex = 0;
  freezeFields(false);
  element("metrics").replaceChildren(node("p", "No run yet."));
  element("verdict").replaceChildren(node("p", "No run yet."));
  notice("Scene unlocked. Your next run gets a new identity.");
  showRoom(0);
}
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
  if (run?.exportable && (run.revealed || run.cards().length === 0))
    download("records.csv", run.csv(), "text/csv;charset=utf-8");
};
button("download-evidence").onclick = () => {
  if (
    run?.exportable &&
    (run.manifest.mode !== "compare" ||
      run.revealed ||
      run.cards().length === 0)
  )
    download(
      "backstage-evidence.json",
      JSON.stringify(run.evidence(), null, 2),
      "application/json",
    );
};
field("cases").addEventListener("input", () => {
  imports.invalidate();
  imported = undefined;
  void render();
});
field("import-cases").addEventListener("change", async () => {
  const input = field("import-cases");
  if (!(input instanceof HTMLInputElement) || starting || run) return;
  imports.invalidate();
  const file = input.files?.[0];
  if (!file) {
    void render();
    return;
  }
  try {
    if (file.size > 1000000)
      throw new Error("Case CSV must be smaller than 1 MB.");
    const reading = imports.read(file.text());
    void render();
    const loaded = await reading;
    if (!loaded || starting || run) return;
    imported = loaded;
    field("cases").value = loaded
      .map((c) => c.input.replaceAll("\n", " / "))
      .join("\n");
    notice(
      `Imported ${loaded.length} cases; original multiline text is preserved.`,
    );
  } catch (error) {
    notice(error instanceof Error ? error.message : "Could not read CSV.");
  } finally {
    void render();
  }
});
field("include-rule").addEventListener("change", () => void render());
field("compare").addEventListener("change", () => void render());
button("theme").onclick = () => {
  document.documentElement.dataset.theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
};
for (const [id, kind] of [
  ["copy-case", "playground"],
  ["copy-cli", "cli"],
]) {
  if (!id || (kind !== "playground" && kind !== "cli")) continue;
  button(id).onclick = async () => {
    try {
      await navigator.clipboard.writeText(
        copyDecision(run?.manifest.scene ?? scene(true), keys(), kind),
      );
      notice(
        kind === "cli"
          ? "Own-key CLI copied. Set TYPESAFE_API_KEY locally; no key was copied."
          : "Question, choices and first case copied for Playground.",
      );
    } catch (error) {
      notice(error instanceof Error ? error.message : "Copy failed.");
    }
  };
}
button("run-trial").onclick = () => void start(true, false, true);
async function loadTrialAvailability() {
  try {
    const response = await fetch("/api/backstage/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const health: unknown = await response.json();
    if (
      typeof health !== "object" ||
      !health ||
      !("trial" in health) ||
      typeof health.trial !== "object" ||
      !health.trial ||
      !("available" in health.trial) ||
      health.trial.available !== true
    )
      return;
    trialAvailable = true;
    text(
      "trial-status",
      "One small funded Jev query is available. A browser cookie and network limits prevent repeats. Reloading may lose the answer without restoring the allowance. Prefer your own key or Playground.",
    );
    void render();
  } catch {
    text(
      "trial-status",
      "Could not check funded trial availability. Bring your Jev key or use Playground.",
    );
  }
}
void loadTrialAvailability();
mountCatalog();
if (matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.dataset.theme = "dark";
window.addEventListener("beforeunload", (event) => {
  if (run) {
    event.preventDefault();
    event.returnValue = "";
  }
});
showRoom(0);
