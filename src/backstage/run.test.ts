import { describe, expect, test, spyOn } from "bun:test";
import {
  BackstageRun,
  inputFingerprint,
  parseCases,
  validateSceneKeys,
} from "./run.ts";
import {
  MODELS,
  type AnswerRequest,
  type AnswerSuccess,
  type Scene,
} from "./contracts.ts";
import { validate } from "../format/validate.ts";
import { cohortMetrics } from "../core/metrics.ts";
import { fileSeed } from "../core/calc.ts";
import { verdict } from "../core/verdict.ts";
function scene(): Scene {
  return {
    question: "Qualified?",
    choices: [
      { name: "yes", definition: "Qualified" },
      { name: "no", definition: "Not qualified" },
    ],
    acceptance: "Correct decision",
    exclusions: "None",
    keywords: ["typescript"],
    matchChoice: "yes",
    otherwiseChoice: "no",
    cases: [
      { id: "c1", input: "TypeScript builder" },
      { id: "c2", input: "other" },
    ],
  };
}
const keys = { jev: "test-secret-jev", llm: "test-secret-llm" };
async function success(r: AnswerRequest): Promise<AnswerSuccess> {
  return {
    ok: true,
    runId: r.runId,
    caseId: r.caseId,
    provider: r.provider,
    attemptId: crypto.randomUUID(),
    fingerprint: await inputFingerprint(r),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    latencyMs: 10,
    model: MODELS[r.provider],
    tokensIn: 20,
    tokensOut: 1,
    costUsd: 0.001,
    priceVersion: "2026-10-03",
    output: "yes",
    confidence: null,
  };
}
describe("Backstage run", () => {
  test("[unit] B67 validates and freezes inputs, rejects duplicate cases", () => {
    const s = scene();
    const run = new BackstageRun(s);
    expect(Object.isFrozen(run.manifest.scene.cases)).toBe(true);
    expect(
      () =>
        new BackstageRun({
          ...s,
          cases: [
            { id: "x", input: "a" },
            { id: "x", input: "b" },
          ],
        }),
    ).toThrow();
    expect(
      new BackstageRun({ ...s, keywords: [] }).manifest.scene.keywords,
    ).toEqual([]);
  });
  test("[unit] B67 executes actual transport, blind labels, exact CSV core parity", async () => {
    const run = new BackstageRun(scene());
    await run.start(keys, success);
    expect(run.cards()).toHaveLength(6);
    expect(run.cards().every((c) => !("provider" in c))).toBe(true);
    const order = run.cards().map((c) => c.id);
    for (const c of run.cards()) run.label(c.id, "accept");
    expect(run.cards().map((c) => c.id)).toEqual(order);
    const report = await run.report();
    expect(validate(report.csv).errors).toEqual([]);
    expect(report.metrics).toEqual(
      cohortMetrics(validate(report.csv).rows, run.manifest),
    );
    expect(report.verdict).toEqual(
      verdict(report.metrics, await fileSeed(report.csv)),
    );
    expect(JSON.stringify(run.evidence())).not.toContain("test-secret");
  });
  test("[unit] B67 double-run prevented; stop keeps unknown attempt and discards late result", async () => {
    const run = new BackstageRun(scene());
    let release: ((v: AnswerSuccess) => void) | undefined;
    let request: AnswerRequest | undefined;
    let began: (() => void) | undefined;
    const dispatched = new Promise<void>((resolve) => {
      began = resolve;
    });
    const pending = run.start(keys, (r) => {
      request = r;
      began?.();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    await dispatched;
    await expect(run.start(keys, success)).rejects.toThrow();
    run.stop();
    await pending;
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]?.ok).toBe(false);
    if (request && release) release(await success(request));
    await Promise.resolve();
    expect(run.cards()).toHaveLength(2);
    await run.retry(keys, success);
    expect(run.cards()).toHaveLength(6);
    expect(run.attempts).toHaveLength(5);
  });
  test("[unit] B67 retry never recharges success and retains known failed spend", async () => {
    const run = new BackstageRun(scene());
    let count = 0;
    await run.start(keys, async (r) => {
      count++;
      const answer = await success(r);
      return count === 1
        ? {
            ...answer,
            ok: false,
            code: "invalid_output",
            message: "Invalid answer",
            charge: "known",
          }
        : answer;
    });
    expect(run.cards()).toHaveLength(5);
    await run.retry(keys, success);
    expect(run.attempts).toHaveLength(5);
    expect((await run.report()).extraSpend).toEqual({
      knownUsd: 0.001,
      unknown: 0,
    });
  });
  test("[unit] B67 rejects stale identity, off-model and hostile echoed fields without leaking keys", async () => {
    const run = new BackstageRun(scene());
    await run.start(keys, async (r) => ({
      ...(await success(r)),
      model: "wrong",
      message: r.key,
      secret: r.key,
    }));
    expect(run.cards()).toHaveLength(2);
    expect(JSON.stringify(run.evidence())).not.toContain("test-secret");
    expect((await run.report()).extraSpend.unknown).toBe(4);
  });
  test("[unit] B67 missing cost stays incomplete; no implicit human labels", async () => {
    const run = new BackstageRun(scene());
    await run.start(keys, async (r) => ({
      ...(await success(r)),
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
    }));
    const report = await run.report();
    expect(report.metrics.arms.find((a) => a.arm === "jev")?.spend.kind).toBe(
      "incomplete",
    );
    expect(report.metrics.arms.every((a) => a.labelled === 0)).toBe(true);
  });
  test("[unit] B67 both keys are excluded from scene and cross-provider response evidence", async () => {
    const s = scene();
    await expect(
      new BackstageRun({ ...s, acceptance: keys.llm }).start(keys, success),
    ).rejects.toThrow();
    const run = new BackstageRun(s);
    await run.start(keys, async (r) => ({
      ...(await success(r)),
      priceVersion: keys[r.provider === "jev" ? "llm" : "jev"],
    }));
    expect(run.cards()).toHaveLength(2);
    expect(JSON.stringify(run.evidence())).not.toContain("test-secret");
  });
  test("[unit] B67 stop before dispatch makes no provider request", async () => {
    const run = new BackstageRun(scene());
    let calls = 0;
    const promise = run.start(keys, async (r) => {
      calls++;
      return success(r);
    });
    run.stop();
    await promise;
    expect(calls).toBe(0);
    expect(run.attempts).toHaveLength(0);
  });
  test("[unit] B67 backend hyphenated failure codes preserve no-charge evidence", async () => {
    const run = new BackstageRun(scene());
    await run.start(keys, async (r) => ({
      ...(await success(r)),
      ok: false,
      code: "http-401",
      message: "Provider rejected the key.",
      charge: "none",
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    }));
    expect(run.attempts.every((a) => !a.ok && a.code === "http-401")).toBe(
      true,
    );
    expect(run.extraSpend()).toEqual({ knownUsd: 0, unknown: 0 });
  });
  test("[unit] B67 CSV case import preserves quoted multiline text and rejects extra columns", () => {
    expect(parseCases('case_id,case_input\na,"hello\nworld"\n')).toEqual([
      { id: "a", input: "hello\nworld" },
    ]);
    expect(() => parseCases("case_id,case_input,x\na,b,c\n")).toThrow();
  });
});

test("[unit] B67 secret rejection blocks exports including escaped keys and retry evidence", async () => {
  const escaped = { jev: 'secret"with\\escape', llm: "other-secret" };
  const run = new BackstageRun({ ...scene(), acceptance: escaped.jev });
  await expect(run.start(escaped, success)).rejects.toThrow();
  expect(() => run.csv()).toThrow();
  expect(() => run.evidence()).toThrow();
  await expect(run.start(keys, success)).rejects.toThrow();
  const retryRun = new BackstageRun(scene());
  await retryRun.start(keys, success);
  await expect(
    retryRun.retry({ jev: "Qualified?", llm: keys.llm }, success),
  ).rejects.toThrow();
  expect(() => retryRun.evidence()).toThrow();
});
test("[unit] B67 reveal irreversibly locks labels and retries", async () => {
  const run = new BackstageRun(scene());
  expect(() => run.reveal()).toThrow();
  await run.start(keys, success);
  const card = run.cards()[0];
  if (!card) throw new Error("missing card");
  run.label(card.id, "accept");
  run.reveal();
  expect(run.revealed).toBe(true);
  expect(() => run.label(card.id, "reject")).toThrow();
  await expect(run.retry(keys, success)).rejects.toThrow();
  expect(run.cards()[0]?.label).toBe("accept");
});
test("[unit] B67 choice names have the same strict bounds as backend", () => {
  const s = scene();
  for (const name of ["x".repeat(65), " yes", "yes ", "yes\t", "yes\0"]) {
    expect(
      () =>
        new BackstageRun({
          ...s,
          choices: [{ name, definition: "test" }, s.choices[1]],
          matchChoice: name,
        }),
    ).toThrow();
  }
});

test("[unit] B67 controls and malformed keys fail before calls", async () => {
  for (const control of ["\0", "\b", "\v", "\f", "\x1f"]) {
    const s = scene();
    expect(
      () => new BackstageRun({ ...s, question: control + "question" }),
    ).toThrow();
    expect(
      () =>
        new BackstageRun({
          ...s,
          cases: [{ id: "x", input: "input" + control }],
        }),
    ).toThrow();
    expect(
      () =>
        new BackstageRun({
          ...s,
          choices: [{ name: "yes", definition: "def" + control }, s.choices[1]],
        }),
    ).toThrow();
  }
  await expect(
    new BackstageRun(scene()).start({ jev: "tiny", llm: keys.llm }, success),
  ).rejects.toThrow();
});
test("[unit] B67 confirmed local rejections are uncharged, unknown HTTP failures stay uncertain", async () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  try {
    for (let i = 0; i < 2; i++)
      fetchSpy.mockResolvedValueOnce(
        Response.json(
          { error: "Runner busy. Retry explicitly when ready." },
          { status: 503 },
        ),
      );
    const run = new BackstageRun({
      ...scene(),
      cases: [{ id: "x", input: "test" }],
    });
    await run.start(keys);
    expect(run.extraSpend()).toEqual({ knownUsd: 0, unknown: 0 });
    for (let i = 0; i < 2; i++)
      fetchSpy.mockResolvedValueOnce(
        new Response("upstream proxy failure", { status: 503 }),
      );
    const uncertain = new BackstageRun({
      ...scene(),
      cases: [{ id: "x", input: "test" }],
    });
    await uncertain.start(keys);
    expect(uncertain.extraSpend()).toEqual({ knownUsd: 0, unknown: 2 });
  } finally {
    fetchSpy.mockRestore();
  }
});

test("[unit] B67 first progress callback enables stopping before initial call", async () => {
  const run = new BackstageRun(scene());
  let calls = 0;
  const states: boolean[] = [];
  await run.start(
    keys,
    async (request) => {
      calls++;
      return success(request);
    },
    () => {
      states.push(run.running);
      if (run.running) run.stop();
    },
  );
  expect(states).toEqual([true, false]);
  expect(calls).toBe(0);
  expect(run.attempts).toHaveLength(0);
});
