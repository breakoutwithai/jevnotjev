import type { RunMode } from "./contracts.ts";

// In-page confirmation for Backstage's three irreversible steps. The panel's
// content and the Confirm/Cancel transition live here so they can be tested
// without a DOM; main.ts only shows the panel and moves focus.
export type ConfirmStep = "judging" | "reveal" | "new-scene";
export const CONFIRM_STEPS: readonly ConfirmStep[] = [
  "judging",
  "reveal",
  "new-scene",
];
export type ConfirmChoice = "yes" | "no";

export interface ConfirmSource {
  readonly manifest: { readonly mode: RunMode };
  readonly total: number;
  readonly pending: number;
}
export interface ConfirmLockState {
  readonly running: boolean;
  readonly labeling: boolean;
  readonly revealed: boolean;
}
export interface ConfirmGuardState extends ConfirmLockState {
  readonly starting: boolean;
}
export interface ConfirmTarget extends ConfirmLockState {
  beginLabeling(): void;
  reveal(): void;
}

export interface ConfirmPanel {
  readonly step: ConfirmStep;
  readonly id: `confirm-${ConfirmStep}`;
  readonly title: string;
  readonly message: string;
  readonly answered: number;
  readonly missing: number;
}
export type ConfirmOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "locked" }
  | { readonly kind: "cleared" }
  | { readonly kind: "blocked"; readonly notice: string };

// A panel can stay open while the page moves on (a Run or Retry starts from another
// room). Checked at Confirm time: null allows the step, otherwise the notice to show.
export function confirmBlocked(
  step: ConfirmStep,
  state: ConfirmGuardState,
): string | null {
  if (state.starting || state.running)
    return step === "new-scene"
      ? "Stop the run before starting a new scene. Nothing was cleared."
      : "Let the calls stop before locking this run. Nothing was locked.";
  if (step === "judging" && state.labeling)
    return "Judging is already open for this run.";
  if (step === "reveal" && (!state.labeling || state.revealed))
    return state.revealed
      ? "Results are already revealed for this run."
      : "Open judging before revealing results. Nothing was locked.";
  return null;
}

function wording(
  step: ConfirmStep,
  mode: RunMode,
): { title: string; detail: string } {
  if (step === "judging")
    return {
      title: "Finish retrying and judge this fixed set of answers?",
      detail:
        "Any unfinished calls will remain missing. You cannot retry after opening judging.",
    };
  if (step === "reveal")
    return mode === "compare"
      ? {
          title: "Reveal the players and lock your labels?",
          detail:
            "You can leave answers unlabelled. Unfinished calls remain missing.",
        }
      : {
          title: "Finish judging and unlock downloads?",
          detail:
            "Labels and retries will lock. You can leave answers unlabelled. Unfinished calls remain missing.",
        };
  return {
    title: "Start a new scene?",
    detail:
      "Download your records and evidence first; this clears the current run.",
  };
}

export function confirmPanel(
  step: ConfirmStep,
  run: ConfirmSource,
): ConfirmPanel {
  const missing = Math.max(0, run.pending);
  const answered = Math.max(0, run.total - missing);
  const { title, detail } = wording(step, run.manifest.mode);
  return {
    step,
    id: `confirm-${step}`,
    title,
    message: `${answered} of ${run.total} answered, ${missing} missing. ${detail}`,
    answered,
    missing,
  };
}

// Confirm runs exactly the lock the old native dialog guarded; Cancel touches nothing.
// New scene returns "cleared" so the page drops its reference to the run.
// "blocked" means nothing was applied; the page shows the notice.
export function resolveConfirm(
  step: ConfirmStep,
  choice: ConfirmChoice,
  run: ConfirmTarget,
  starting: boolean,
): ConfirmOutcome {
  if (choice === "no") return { kind: "cancelled" };
  const notice = confirmBlocked(step, {
    starting,
    running: run.running,
    labeling: run.labeling,
    revealed: run.revealed,
  });
  if (notice !== null) return { kind: "blocked", notice };
  if (step === "judging") {
    run.beginLabeling();
    return { kind: "locked" };
  }
  if (step === "reveal") {
    run.reveal();
    return { kind: "locked" };
  }
  return { kind: "cleared" };
}
