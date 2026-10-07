import {
  BACKSTAGE_BLIND_PICK,
  BackstageRun,
  CaseImportState,
  checkRunnerHealth,
  validateSceneKeys,
  trialTransport,
  type PickCard,
} from "./run.ts";
import { rankJevOptions, type JevSuggestion } from "../labels/rank.ts";
import { MODEL_CATALOG, CATALOG_CHECKED_DATE, JEV_ARM_ID } from "./catalog.ts";
import { copyDecision } from "./copy.ts";
import {
  KEY_FIELD_NAMES,
  estimateRange,
  estimateSpend,
  runBlockers,
} from "./run-gate.ts";
import { signOut, signOutRequest } from "./signout.ts";
import {
  SCENE_DRAFT_FIELDS,
  clearSceneDraft,
  draftStatusText,
  importedDisplay,
  judgingRules,
  loadSceneDraft,
  saveSceneDraft,
  type DraftStatus,
  type DraftStorage,
} from "./scene-draft.ts";
import {
  confirmPanel,
  resolveConfirm,
  CONFIRM_STEPS,
  type ConfirmStep,
} from "./confirm.ts";
import type { Scene, RunMode, Provider, ProviderKeys } from "./contracts.ts";
import type { Spend, CostPerAccepted } from "../core/metrics.ts";
// Labelling loop M3: imported labels, calibration and starter packs.
import { importedLabelSummary, parseCaseImport, type ImportedLabel } from "./run.ts";
import { mountCalibration } from "./calibration-view.ts";
import { UC13_CALIBRATION } from "../labels/calibration-set.ts";
import { STARTER_PACKS, starterPackCsv, type StarterPack } from "../labels/starter-packs.ts";
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
/** Labels that came with the imported cases; held in memory only, so a reload drops them (the cases survive). */
let importedLabels: readonly ImportedLabel[] = [];
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
const ROOM_TITLES: readonly string[] = [
  "scene-title",
  "casting-title",
  "lines-title",
  "rehearsal-title",
  "dress-title",
  "opening-title",
];
const ROOM_LINES: readonly string[] = [
  "Set the scene before the first call.",
  "Pick who answers, and add a key for each provider you pick.",
  "Add your test cases, check the estimate, then run.",
  "Judge each answer against your rule.",
  "Check the cost, then download your records and evidence.",
  "Read the result for this question and these cases.",
];
// A control that cannot act stays focusable (aria-disabled) and names why in its described-by text.
function gate(ids: readonly string[], reasonId: string, reason: string) {
  for (const id of ids)
    button(id).setAttribute("aria-disabled", String(reason !== ""));
  text(reasonId, reason);
}
// Focus moves to the heading only when the user changes room, never on first load (#125).
function showRoom(next: number, moveFocus = true) {
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
  text("room-line", ROOM_LINES[room] ?? "");
  element("skip-link").setAttribute("href", `#${ROOM_TITLES[room] ?? ""}`);
  if (moveFocus)
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
      input.id = "arm-" + entry.id;
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
    label.append(document.createTextNode(KEY_FIELD_NAMES[provider]));
    const input = document.createElement("input");
    input.id = provider + "-key";
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.addEventListener("input", () => void render());
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
let signingOut = false;
let trialAvailable = false;
async function start(firstOnly: boolean, retry = false, funded = false) {
  if (starting || run?.running || signingOut) return;
  if (imports.pending) {
    notice("Wait for the case import or edit the cases to cancel it.");
    return;
  }
  // A pending confirmation must not outlive a run start.
  if (openConfirmStep) closeConfirm(openConfirmStep, false);
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
      current = new BackstageRun(
        candidate,
        BACKSTAGE_BUILD_VERSION,
        { arms: funded ? [JEV_ARM_ID] : selectedArms() },
        imported ? importedLabels.filter((l) => candidate.cases.some((c) => c.id === l.caseId)) : [],
      );
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
          : "Calls stopped. Each Jev answer shows here once you pick its case blind in Rehearsals. Retry unfinished calls or open judging in Rehearsals to label and export.",
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
// Why Run cannot start now; empty when it can. Read live, so a click never trusts a stale render.
function runReason(): string {
  if (starting || run?.running) return "Calls are in progress.";
  if (run)
    return "This scene already ran. Retry unfinished calls, or edit as a new scene to run again.";
  if (imports.pending) return "Wait for the case import to finish.";
  return runBlockers({
    caseCount: cases().length,
    armIds: selectedArms(),
    keys: keys(),
  }).join(" ");
}
function revealReason(): string {
  const current = run;
  if (!current) return "Run your cases and open judging first.";
  if (current.revealed) return "Results are revealed; labels are locked.";
  if (current.running || starting) return "Let the run stop, then open judging.";
  if (!current.labeling) return "Open judging above first.";
  return "";
}
function downloadReasons(): { csv: string; evidence: string } {
  const current = run;
  if (!current)
    return {
      csv: "Run your cases first. Downloads unlock when the run has answers to export.",
      evidence:
        "Run your cases first. Downloads unlock when the run has answers to export.",
    };
  if (!current.exportable) {
    const reason = current.running
      ? "Let the run stop first."
      : "This run cannot be exported. Start a new scene.";
    return { csv: reason, evidence: reason };
  }
  const judging = !current.revealed && current.cards().length > 0;
  if (!judging) return { csv: "", evidence: "" };
  // Evidence holds every answer, so it waits for the reveal in both modes.
  const reason = "Finish judging in Rehearsals to unlock downloads.";
  return { csv: reason, evidence: reason };
}
function previewText(arms: readonly string[]): string {
  const full = scene(false);
  if (full.cases.length === 0) return "No cases yet.";
  const all = estimateSpend(full, arms);
  const first = estimateSpend(scene(true), arms);
  const calls = (n: number) => `up to ${n} paid call${n === 1 ? "" : "s"}`;
  const unknown = all.unpriced.map(
    (label) => ` ${label}: price unknown, not in the estimate.`,
  );
  return (
    `${full.cases.length} case${full.cases.length === 1 ? "" : "s"}. ` +
    `Run all: ${calls(all.calls)}, ${estimateRange(all)}. ` +
    `First case: ${calls(first.calls)}, ${estimateRange(first)}.` +
    unknown.join("")
  );
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
  for (const provider of providers.filter((p) => p !== "jev")) {
    const player = element(provider + "-key-player");
    const shown = arms.some(
      (id) => MODEL_CATALOG.find((e) => e.id === id)?.provider === provider,
    );
    if (shown && player.hidden && !current)
      notice(`${KEY_FIELD_NAMES[provider]} field added below the models.`);
    player.hidden = !shown;
  }
  element("comparison-note").hidden = !comparison;
  text(
    "judging-direction",
    "Pick the right answer for each case before you see any answer. Then Jev’s ranking appears: keep your pick or change it.",
  );
  text(
    "judging-note",
    (comparison
      ? "Every player’s answer is scored against your first pick, made blind. "
      : "Jev’s answer is scored against your first pick, made blind. ") +
      "Your final pick is recorded beside it, never instead of it. Confidence is the model’s score, not measured accuracy. Labels are optional; unsure leaves a case unlabelled. A case you do not pick keeps its imported human_reviewed label, if it has one, and is scored on it; an imported agent label is never scored.",
  );
  button("run-trial").disabled =
    !trialAvailable || starting || !!current || imports.pending;
  gate(["run-one", "run-all"], "run-reason", runReason());
  button("stop").disabled = !running && !starting;
  button("retry").disabled =
    starting ||
    !current ||
    running ||
    current.pending === 0 ||
    current.labeling ||
    current.funded;
  button("new-scene").disabled = running || starting;
  const downloads = downloadReasons();
  describeDownload("download-csv", downloads.csv, "csv-note");
  describeDownload("download-evidence", downloads.evidence, "");
  text("download-reason", downloads.csv || downloads.evidence);
  gate(["reveal"], "reveal-reason", revealReason());
  text(
    "run-preview",
    current
      ? `${current.manifest.scene.cases.length} frozen cases. ${current.completed} of ${current.total} selected case/model cells processed; ${current.pending} have no answer.`
      : previewText(arms),
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
          `${current.pending} selected calls have no answer. Failed attempts: ${money(extra.knownUsd)} known spend, ${extra.unknown} with unknown charges. ${comparison ? "Provider details stay hidden until results are revealed; Jev's ranking for a case shows after you pick it." : "Each Jev answer and its returned confidence appear below once you pick its case blind in Rehearsals."}`,
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
          : "Jev answers appear in Learning Lines as you pick each case blind. Finish judging in Rehearsals to unlock the summary and downloads; labels are optional.",
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
    current && !current.running && current.labeling ? current.pickCards() : [];
  cardIndex = Math.max(0, Math.min(cardIndex, cards.length - 1));
  const card = cards[cardIndex];
  element("pick-actions").hidden = !card || card.picked || !!current?.revealed;
  button("pick-first").textContent = card?.choices[0] ?? "First choice";
  button("pick-second").textContent = card?.choices[1] ?? "Second choice";
  element("suggestion").replaceChildren();
  button("previous-card").disabled = !card || cardIndex === 0;
  button("next-card").disabled = !card || cardIndex >= cards.length - 1;
  // No active card (no run, new scene, still running): nothing from an earlier scene may stay on screen.
  const rules = judgingRules(card ? current?.manifest.scene : undefined);
  text("rubric", rules.keep);
  text("leave-out", rules.leaveOut);
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
  container.className = "answer-card";
  container.replaceChildren(
    node("p", `Case ${cardIndex + 1} of ${cards.length} / ${card.caseId}`),
    node("h3", current?.manifest.scene.question ?? ""),
    node("p", card.input),
    node(
      "p",
      card.picked
        ? `Your blind pick: ${card.blind ?? "unsure"}`
        : "Pick before you see any answer.",
    ),
  );
  // Blind integrity: nothing of Jev's answer for this case is built until its blind pick is committed.
  if (current && card.picked) renderSuggestion(current, card);
}
function rankingLines(card: PickCard, answer: JevSuggestion): HTMLElement[] {
  const ranking = rankJevOptions(card.choices, answer);
  const lines = ranking.options.map((o) =>
    node(
      "li",
      (o.rank === null ? "unranked " : `#${o.rank} `) +
        o.option +
        (o.probability === null ? "" : ` ${Math.round(o.probability * 100)}%`) +
        (o.jevChoice ? " (Jev's choice)" : ""),
    ),
  );
  const list = document.createElement("ol");
  list.append(...lines);
  return [
    node("h3", "Jev's ranking"),
    list,
    node(
      "p",
      ranking.ranked
        ? "Ordered by Jev's probability for each option."
        : "Jev returned no probabilities: its choice first, the rest unranked.",
    ),
    node(
      "p",
      answer.confidence === null
        ? "Jev's confidence: not returned."
        : `Jev's confidence: ${answer.confidence}`,
    ),
  ];
}
function finalButton(card: PickCard, choice: string): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = "final-" + choice;
  b.className = "secondary";
  b.textContent = choice === card.blind ? `Keep ${choice}` : `Change to ${choice}`;
  b.setAttribute("aria-pressed", String(card.final === choice));
  b.onclick = () => finalPick(card.caseId, choice);
  return b;
}
function renderSuggestion(current: BackstageRun, card: PickCard) {
  const panel = element("suggestion");
  const suggestion = current.knownSuggestion(card.caseId);
  const shown = suggestion.kind !== "none";
  const parts: HTMLElement[] = shown ? rankingLines(card, suggestion.answer) : [];
  if (!shown)
    parts.push(
      node(
        "p",
        suggestion.reason === "call-failed"
          ? "No suggestion yet: the call on your key did not return a usable answer."
          : "No suggestion yet: this run has no Jev answer for this case.",
      ),
    );
  if (!shown && suggestion.reason === "no-key" && keys().jev && !current.revealed) {
    const ask = document.createElement("button");
    ask.type = "button";
    ask.id = "ask-jev";
    ask.className = "secondary";
    ask.textContent = "Ask Jev with your key (one paid call)";
    ask.onclick = () => askJev(current, card.caseId);
    parts.push(ask);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  if (card.blind === null) parts.push(node("p", "Unsure: no label is recorded for this case."));
  else if (current.revealed) parts.push(node("p", `Your final pick: ${card.final ?? "not made"}`));
  else if (shown) actions.append(...card.choices.map((choice) => finalButton(card, choice)));
  else actions.append(finalButton(card, card.blind));
  panel.replaceChildren(...parts, actions);
}
function askJev(current: BackstageRun, caseId: string) {
  if (current !== run || current.revealed) return;
  void current.suggestion(caseId, keys().jev ?? null).then(
    () => {
      if (current === run) void render();
    },
    (error: unknown) => notice(error instanceof Error ? error.message : "Could not ask Jev."),
  );
}
function pickBlind(choice: string | null) {
  const current = run;
  const card = current?.pickCards()[cardIndex];
  if (!current || !card || card.picked || current.running || !current.labeling || current.revealed) return;
  current.pickBlind(card.caseId, choice, BACKSTAGE_BLIND_PICK);
  void render();
}
function finalPick(caseId: string, choice: string) {
  const current = run;
  if (!current || current.running || !current.labeling || current.revealed) return;
  current.pickFinal(caseId, choice);
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
function runClicked(firstOnly: boolean) {
  if (signingOut) return;
  const reason = runReason();
  if (reason) {
    notice(reason);
    return;
  }
  void start(firstOnly);
}
button("run-one").onclick = () => runClicked(true);
button("run-all").onclick = () => runClicked(false);
element("skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  element(ROOM_TITLES[room] ?? "scene-title").focus();
});
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
    const outcome = resolveConfirm("judging", "yes", current, starting);
    if (outcome.kind === "blocked") {
      notice(outcome.notice);
      return;
    }
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
  const reason = revealReason();
  if (reason) {
    notice(reason);
    return;
  }
  if (!run || run.running || !run.labeling) return;
  openConfirm("reveal", run);
};
function confirmReveal() {
  closeConfirm("reveal", false);
  if (!run) return;
  const outcome = resolveConfirm("reveal", "yes", run, starting);
  if (outcome.kind === "blocked") {
    notice(outcome.notice);
    return;
  }
  notice("Results revealed. Labels and retries are now locked for this run.");
  showRoom(4);
}
function clearKeys() {
  activeKeys = {};
  startup?.abort();
  run?.stop();
  for (const provider of providers) field(provider + "-key").value = "";
}
button("clear-keys").onclick = () => {
  clearKeys();
  notice(
    "Keys cleared and further calls stopped. Already dispatched calls may still be charged.",
  );
  void render();
};
// A download button is described by the lock reason only while it is locked.
function describeDownload(id: string, reason: string, note: string) {
  button(id).setAttribute("aria-disabled", String(reason !== ""));
  const describedBy = [reason ? "download-reason" : "", note]
    .filter(Boolean)
    .join(" ");
  if (describedBy) button(id).setAttribute("aria-describedby", describedBy);
  else button(id).removeAttribute("aria-describedby");
}
button("sign-out").onclick = () => {
  if (signingOut) return;
  signingOut = true;
  const control = button("sign-out");
  control.disabled = true;
  void signOut({
    clear: () => { clearKeys(); clearScene(); removeDraft(); },
    request: () => signOutRequest(fetch),
    navigate: (url) => {
      removeDraft();
      location.replace(url);
    },
    notice,
  }).then((success) => {
    if (!success) {
      signingOut = false;
      control.disabled = false;
    }
  });
};
button("new-scene").onclick = () => {
  if (run) openConfirm("new-scene", run);
  else clearScene();
};
function confirmNewScene() {
  closeConfirm("new-scene", false);
  if (run) {
    const outcome = resolveConfirm("new-scene", "yes", run, starting);
    if (outcome.kind === "blocked") notice(outcome.notice);
    if (outcome.kind !== "cleared") return;
  }
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
button("pick-first").onclick = () => {
  if (run) pickBlind(run.manifest.scene.choices[0].name);
};
button("pick-second").onclick = () => {
  if (run) pickBlind(run.manifest.scene.choices[1].name);
};
button("pick-unsure").onclick = () => pickBlind(null);
button("previous-card").onclick = () => {
  cardIndex--;
  renderCard();
};
button("next-card").onclick = () => {
  cardIndex++;
  renderCard();
};
button("download-csv").onclick = () => {
  const reason = downloadReasons().csv;
  if (reason) notice(reason);
  else if (run?.exportable && (run.revealed || run.cards().length === 0))
    download("records.csv", run.csv(), "text/csv;charset=utf-8");
};
button("download-evidence").onclick = () => {
  const reason = downloadReasons().evidence;
  if (reason) {
    notice(reason);
    return;
  }
  if (
    run?.exportable &&
    (run.revealed || run.cards().length === 0)
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
  if (importedLabels.length > 0)
    notice(`Editing the cases dropped ${importedLabels.length} imported labels. Import the file or load the pack again to keep them.`);
  importedLabels = [];
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
    const reading = imports.readImport(file.text());
    void render();
    const loaded = await reading;
    if (!loaded || starting || run) return;
    imported = loaded.cases;
    importedLabels = loaded.labels;
    field("cases").value = importedDisplay(loaded.cases);
    persistDraft();
    notice(
      `Imported ${loaded.cases.length} cases; original multiline text is preserved. ${importedLabelSummary(loaded.labels)}`.trim(),
    );
  } catch (error) {
    notice(error instanceof Error ? error.message : "Could not read CSV.");
  } finally {
    void render();
  }
});
field("include-rule").addEventListener("change", () => void render());
field("compare").addEventListener("change", () => void render());
field("jev-key").addEventListener("input", () => void render());
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
      response.status === 401 &&
      typeof health === "object" &&
      health !== null &&
      "code" in health &&
      health.code === "unauthenticated"
    ) {
      const surface = element("notice");
      surface.textContent = "Your sign-in has expired. ";
      const link = node("a", "Sign in again.");
      link.setAttribute("href", "/backstage/sign-in");
      surface.append(link);
      return;
    }
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
  if (run && !signingOut) {
    event.preventDefault();
    event.returnValue = "";
  }
});
// Scene text only, kept for this tab so a reload before a run does not lose it. Key fields are never read here.
// Every storage outcome (saved, save failed, clear failed) goes through this one status line, which later notices cannot overwrite.
function showDraftStatus(status: DraftStatus) {
  text("draft-status", draftStatusText(status));
}
function persistDraft() {
  // Once sign-out starts nothing may recreate the draft it removed.
  if (signingOut) return;
  showDraftStatus(
    saveSceneDraft(draftStorage(), (name) => field(name).value, imported),
  );
}
function removeDraft() {
  if (!clearSceneDraft(draftStorage())) showDraftStatus("clear-failed");
}
function draftStorage(): DraftStorage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}
const savedDraft = loadSceneDraft(draftStorage());
for (const id of SCENE_DRAFT_FIELDS) {
  const saved = savedDraft.fields[id];
  if (saved !== undefined) field(id).value = saved;
  field(id).addEventListener("input", persistDraft);
}
imported = savedDraft.imported;
// Starter packs (labelling loop M3): a pack goes through the same CSV import as a tester's file, labels included.
function loadStarterPack(pack: StarterPack) {
  if (starting || run || signingOut) {
    notice("This scene is frozen. Start a new scene to load a starter pack.");
    return;
  }
  imports.invalidate();
  const loaded = parseCaseImport(starterPackCsv(pack));
  const values: Record<string, string> = {
    question: pack.question,
    "choice-a": pack.choices[0].name,
    "choice-b": pack.choices[1].name,
    "definition-a": pack.choices[0].definition,
    "definition-b": pack.choices[1].definition,
    acceptance: pack.acceptance,
    exclusions: pack.exclusions,
    keywords: pack.keywords.join("\n"),
  };
  for (const [id, value] of Object.entries(values)) field(id).value = value;
  imported = loaded.cases;
  importedLabels = loaded.labels;
  field("cases").value = importedDisplay(loaded.cases);
  persistDraft();
  notice(`Loaded ${pack.title}: ${loaded.cases.length} cases. ${importedLabelSummary(loaded.labels)}`.trim());
  void render();
}
for (const pack of STARTER_PACKS) {
  const choice = document.createElement("button");
  choice.id = "starter-" + pack.id;
  choice.setAttribute("type", "button");
  choice.className = "secondary";
  choice.textContent = pack.title;
  choice.title = pack.persona;
  choice.onclick = () => loadStarterPack(pack);
  element("starter-pack-buttons").append(choice);
}
mountCalibration(UC13_CALIBRATION);
showRoom(0, false);
