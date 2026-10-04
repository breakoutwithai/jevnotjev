import { describe, expect, test } from "bun:test";
import { BackstageRun, inputFingerprint } from "./run.ts";
import { type AnswerRequest, type Scene } from "./contracts.ts";
import { getModelEntry } from "./catalog.ts";
import {
  confirmBlocked,
  confirmPanel,
  resolveConfirm,
  CONFIRM_STEPS,
  type ConfirmStep,
} from "./confirm.ts";

const compareSelection = { arms: ["jev", "claude-haiku-4-5-20251001"] };
const keys = { jev: "test-secret-jev", anthropic: "test-secret-llm" };
function scene(): Scene {
  return {
    question: "Qualified?",
    choices: [
      { name: "yes", definition: "Qualified" },
      { name: "no", definition: "Not qualified" },
    ],
    acceptance: "Correct decision",
    exclusions: "None",
    keywords: [],
    matchChoice: "yes",
    otherwiseChoice: "no",
    cases: [
      { id: "c1", input: "TypeScript builder" },
      { id: "c2", input: "other" },
      { id: "c3", input: "third" },
    ],
  };
}
async function answer(r: AnswerRequest): Promise<unknown> {
  if (r.caseId === "c3") throw new Error("network down");
  return {
    ok: true,
    runId: r.runId,
    revision: r.revision,
    caseId: r.caseId,
    provider: r.provider,
    attemptId: crypto.randomUUID(),
    fingerprint: await inputFingerprint(r),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    latencyMs: 10,
    model: r.modelId,
    armId: r.armId,
    catalogVersion: r.catalogVersion,
    promptVersion: r.promptVersion,
    requestedModel: r.modelId,
    returnedModel: r.modelId,
    parameters: getModelEntry(r.armId)?.parameters ?? {},
    tokensIn: 20,
    tokensOut: 1,
    costUsd: 0.001,
    priceVersion: "2026-10-03",
    output: "yes",
    confidence: null,
  };
}
async function stoppedRun(compare: boolean): Promise<BackstageRun> {
  const run = new BackstageRun(
    scene(),
    "test",
    compare ? compareSelection : { arms: ["jev"] },
  );
  await run.start(keys, answer);
  return run;
}
function snapshot(run: BackstageRun) {
  return {
    started: run.started,
    running: run.running,
    labeling: run.labeling,
    revealed: run.revealed,
    pending: run.pending,
    completed: run.completed,
    exportable: run.exportable,
    cards: run.cards(),
  };
}

describe("Backstage in-page confirm panels", () => {
  test("[unit] I88 three steps with stable panel ids", () => {
    expect(CONFIRM_STEPS).toEqual(["judging", "reveal", "new-scene"]);
  });

  test("[unit] I88 panels show answered and missing counts from the run", async () => {
    const run = await stoppedRun(true);
    expect(run.total).toBe(6);
    expect(run.pending).toBe(2);
    for (const step of CONFIRM_STEPS) {
      const panel = confirmPanel(step, run);
      expect(panel.id).toBe(`confirm-${step}`);
      expect(panel.answered).toBe(4);
      expect(panel.missing).toBe(2);
      expect(panel.message).toContain("4 of 6 answered, 2 missing");
    }
  });

  test("[unit] I88 judging panel keeps the existing lock wording", async () => {
    const panel = confirmPanel("judging", await stoppedRun(false));
    expect(panel.title).toBe(
      "Finish retrying and judge this fixed set of answers?",
    );
    expect(panel.message).toContain("unfinished calls will remain missing");
    expect(panel.message).toContain("cannot retry after opening judging");
    expect(panel.message).toContain("2 of 3 answered, 1 missing");
  });

  test("[unit] I88 reveal wording differs for compare and solo runs", async () => {
    const compare = confirmPanel("reveal", await stoppedRun(true));
    expect(compare.title).toBe("Reveal the players and lock your labels?");
    expect(compare.message).toContain("leave answers unlabelled");
    expect(compare.message).toContain("Unfinished calls remain missing");
    const solo = confirmPanel("reveal", await stoppedRun(false));
    expect(solo.title).toBe("Finish judging and unlock downloads?");
    expect(solo.message).toContain("Labels and retries will lock");
    expect(solo.message).toContain("Unfinished calls remain missing");
    expect(solo.message).not.toContain("players");
  });

  test("[unit] I88 new-scene wording keeps the download-first warning", async () => {
    const panel = confirmPanel("new-scene", await stoppedRun(false));
    expect(panel.title).toBe("Start a new scene?");
    expect(panel.message).toContain("Download your records and evidence first");
    expect(panel.message).toContain("clears the current run");
  });

  test("[unit] I88 Cancel leaves the run unchanged at every step", async () => {
    const atJudging = await stoppedRun(true);
    const before = snapshot(atJudging);
    expect(resolveConfirm("judging", "no", atJudging, false)).toEqual({
      kind: "cancelled",
    });
    expect(snapshot(atJudging)).toEqual(before);

    const atReveal = await stoppedRun(true);
    atReveal.beginLabeling();
    const beforeReveal = snapshot(atReveal);
    expect(resolveConfirm("reveal", "no", atReveal, false)).toEqual({
      kind: "cancelled",
    });
    expect(snapshot(atReveal)).toEqual(beforeReveal);

    const atNew = await stoppedRun(false);
    const beforeNew = snapshot(atNew);
    expect(resolveConfirm("new-scene", "no", atNew, false)).toEqual({
      kind: "cancelled",
    });
    expect(snapshot(atNew)).toEqual(beforeNew);
  });

  test("[unit] I88 Confirm at judging applies exactly beginLabeling", async () => {
    const run = await stoppedRun(true);
    const before = snapshot(run);
    expect(resolveConfirm("judging", "yes", run, false)).toEqual({ kind: "locked" });
    expect(snapshot(run)).toEqual({ ...before, labeling: true });
    await expect(run.retry(keys, answer)).rejects.toThrow(
      "Retries are locked",
    );
  });

  test("[unit] I88 Confirm at reveal applies exactly reveal", async () => {
    const run = await stoppedRun(false);
    run.beginLabeling();
    const before = snapshot(run);
    expect(resolveConfirm("reveal", "yes", run, false)).toEqual({ kind: "locked" });
    expect(snapshot(run)).toEqual({ ...before, revealed: true });
    const card = run.cards()[0];
    if (!card) throw new Error("expected a card");
    expect(() => run.label(card.id, "accept")).toThrow("Labels are locked");
  });

  test("[unit] I88 Confirm at new scene clears without touching run labels", async () => {
    const run = await stoppedRun(false);
    const before = snapshot(run);
    expect(resolveConfirm("new-scene", "yes", run, false)).toEqual({
      kind: "cleared",
    });
    expect(snapshot(run)).toEqual(before);
  });

  test("[unit] I88 Confirm at reveal before judging opens is blocked, not applied", async () => {
    const run = await stoppedRun(true);
    const before = snapshot(run);
    const outcome = resolveConfirm("reveal", "yes", run, false);
    expect(outcome.kind).toBe("blocked");
    expect(snapshot(run)).toEqual(before);
  });
});

function spyTarget(state: {
  running: boolean;
  labeling: boolean;
  revealed: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    target: {
      ...state,
      beginLabeling() {
        calls.push("beginLabeling");
      },
      reveal() {
        calls.push("reveal");
      },
    },
  };
}
// The lock state each step is legitimately confirmed from.
const idle: Record<
  ConfirmStep,
  { running: boolean; labeling: boolean; revealed: boolean }
> = {
  judging: { running: false, labeling: false, revealed: false },
  reveal: { running: false, labeling: true, revealed: false },
  "new-scene": { running: false, labeling: false, revealed: false },
};

describe("Backstage confirm guard while calls start or run", () => {
  for (const step of CONFIRM_STEPS) {
    test(`[unit] I88 ${step} Confirm is blocked while a run is starting`, () => {
      const state = { ...idle[step], starting: true };
      const notice = confirmBlocked(step, state);
      expect(notice).toBeString();
      expect(notice?.length).toBeGreaterThan(0);
      const spy = spyTarget(idle[step]);
      expect(resolveConfirm(step, "yes", spy.target, true)).toEqual({
        kind: "blocked",
        notice: notice ?? "",
      });
      expect(spy.calls).toEqual([]);
    });

    test(`[unit] I88 ${step} Confirm is blocked while calls are running`, () => {
      const state = { ...idle[step], running: true };
      const notice = confirmBlocked(step, { ...state, starting: false });
      expect(notice).toBeString();
      const spy = spyTarget(state);
      expect(resolveConfirm(step, "yes", spy.target, false)).toEqual({
        kind: "blocked",
        notice: notice ?? "",
      });
      expect(spy.calls).toEqual([]);
    });

    test(`[unit] I88 ${step} Confirm is allowed when idle`, () => {
      expect(confirmBlocked(step, { ...idle[step], starting: false })).toBe(
        null,
      );
      const spy = spyTarget(idle[step]);
      expect(resolveConfirm(step, "yes", spy.target, false).kind).not.toBe(
        "blocked",
      );
    });
  }

  test("[unit] I88 judging Confirm during a retry's runner check never calls beginLabeling", async () => {
    const run = await stoppedRun(true);
    const calls: string[] = [];
    const target = {
      get running() {
        return run.running;
      },
      get labeling() {
        return run.labeling;
      },
      get revealed() {
        return run.revealed;
      },
      beginLabeling() {
        calls.push("beginLabeling");
        run.beginLabeling();
      },
      reveal() {
        run.reveal();
      },
    };
    const before = snapshot(run);
    expect(resolveConfirm("judging", "yes", target, true).kind).toBe(
      "blocked",
    );
    expect(calls).toEqual([]);
    expect(snapshot(run)).toEqual(before);
    await run.retry(keys, answer);
    expect(run.labeling).toBe(false);
  });

  test("[unit] I88 Cancel is never blocked", () => {
    for (const step of CONFIRM_STEPS) {
      const spy = spyTarget({ ...idle[step], running: true });
      expect(resolveConfirm(step, "no", spy.target, true)).toEqual({
        kind: "cancelled",
      });
      expect(spy.calls).toEqual([]);
    }
  });
});
