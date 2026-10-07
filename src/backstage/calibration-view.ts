/**
 * The calibration step at the top of the Rehearsals room (labelling loop M3): five practice cases picked before the
 * tester's own. A case's reference label is put on the page only after its pick; the agreement is
 * src/labels/calibration.ts. The picks stay on this page: they are not a run's labels and are never exported as one.
 */
import { calibrationAgreement, type CalibrationSet } from "../labels/calibration.ts";

const SOURCE_TEXT: Readonly<Record<string, string>> = {
  human: "human: a person picked it",
  human_reviewed: "human_reviewed: drafted by AI, approved by a person",
};

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
}
function paragraph(content: string): HTMLElement {
  const p = document.createElement("p");
  p.textContent = content;
  return p;
}

export function mountCalibration(set: CalibrationSet): void {
  const picks = new Map<string, string | null>();
  let index = 0;
  const names = set.choices.map((c) => c.name);
  const actions = byId("calibration-actions");
  const feedback = byId("calibration-feedback");
  const next = byId("calibration-next");
  const result = byId("calibration-result");
  byId("calibration-first").textContent = set.choices[0].name;
  byId("calibration-second").textContent = set.choices[1].name;

  function showResult() {
    const agreement = calibrationAgreement(set.cases, names, picks);
    if (!agreement.done) {
      result.textContent = "";
      return;
    }
    const rate = agreement.rate === null ? "no case picked with a choice" : `${Math.round(agreement.rate * 100)}%`;
    const differs = agreement.disagreed.length ? ` Differed on ${agreement.disagreed.join(", ")}.` : "";
    result.textContent =
      `You agreed with the reference on ${agreement.agreed} of ${agreement.compared} picked cases (${rate}); ${agreement.unsure} unsure.` +
      differs +
      " Now pick your own cases below.";
  }
  function show() {
    const c = set.cases[index];
    const card = byId("calibration-case");
    feedback.textContent = "";
    next.hidden = true;
    if (c === undefined) {
      card.replaceChildren(paragraph("Calibration done."));
      actions.hidden = true;
      showResult();
      return;
    }
    actions.hidden = false;
    card.replaceChildren(
      paragraph(`Practice case ${index + 1} of ${set.cases.length}`),
      paragraph(set.question),
      ...set.choices.map((choice) => paragraph(`${choice.name}: ${choice.definition}`)),
      paragraph(`Fact sheet: ${set.context}`),
      paragraph(`Case: ${c.input}`),
    );
  }
  function pick(choice: string | null) {
    const c = set.cases[index];
    if (c === undefined || picks.has(c.id)) return;
    picks.set(c.id, choice);
    actions.hidden = true;
    const yours = choice === null ? "You picked Unsure." : `You picked ${choice}.`;
    const source = SOURCE_TEXT[c.source] ?? c.source;
    feedback.textContent = `${yours} Reference label: ${c.truth} (${source}, ${c.labelledAt}).`;
    next.hidden = false;
    // The focused pick button is now hidden: move focus to the next control so keyboard users are not dropped.
    next.focus();
  }
  byId("calibration-first").onclick = () => pick(set.choices[0].name);
  byId("calibration-second").onclick = () => pick(set.choices[1].name);
  byId("calibration-unsure").onclick = () => pick(null);
  next.onclick = () => {
    index++;
    show();
    byId(set.cases[index] === undefined ? "calibration-result" : "calibration-case").focus();
  };
  show();
}
