import { describe, expect, test, spyOn } from "bun:test";
import {
  BackstageRun,
  CaseImportState,
  checkRunnerHealth,
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
    revision: r.revision,
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
  test("[unit] B2 validates and freezes inputs, rejects duplicate cases", () => {
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
  test("[unit] B7 executes actual transport, blind labels, exact CSV core parity", async () => {
    const run = new BackstageRun(scene());
    await run.start(keys, success);
    expect(run.cards()).toHaveLength(6);
    expect(run.cards().every((c) => !("provider" in c))).toBe(true);
    const order = run.cards().map((c) => c.id);
    run.beginLabeling();
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
  test("[unit] B2 double-run prevented; stop keeps unknown attempt and discards late result", async () => {
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
  test("[unit] B5 retry never recharges success and retains known failed spend", async () => {
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
  test("[unit] B4 rejects stale identity, off-model and hostile echoed fields without leaking keys", async () => {
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
  test("[unit] B6 missing cost stays incomplete; no implicit human labels", async () => {
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
  test("[unit] B4 both keys are excluded from scene and cross-provider response evidence", async () => {
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
  test("[unit] B5 stop before dispatch makes no provider request", async () => {
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
  test("[unit] B5 backend hyphenated failure codes preserve no-charge evidence", async () => {
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
  test("[unit] B7 CSV case import preserves quoted multiline text and rejects extra columns", () => {
    expect(parseCases('case_id,case_input\na,"hello\nworld"\n')).toEqual([
      { id: "a", input: "hello\nworld" },
    ]);
    expect(() => parseCases("case_id,case_input,x\na,b,c\n")).toThrow();
  });
});

test("[unit] B4 secret rejection blocks exports including escaped keys and retry evidence", async () => {
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
test("[unit] B6 reveal irreversibly locks labels and retries", async () => {
  const run = new BackstageRun(scene());
  expect(() => run.reveal()).toThrow();
  await run.start(keys, success);
  const card = run.cards()[0];
  if (!card) throw new Error("missing card");
  run.beginLabeling();
  run.label(card.id, "accept");
  run.reveal();
  expect(run.revealed).toBe(true);
  expect(() => run.label(card.id, "reject")).toThrow();
  await expect(run.retry(keys, success)).rejects.toThrow();
  expect(run.cards()[0]?.label).toBe("accept");
});
test("[unit] B4 choice names have the same strict bounds as backend", () => {
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

test("[unit] B4 controls and malformed keys fail before calls", async () => {
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
test("[unit] B5 confirmed local rejections are uncharged, unknown HTTP failures stay uncertain", async () => {
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

test("[unit] B5 first progress callback enables stopping before initial call", async () => {
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

test("[unit] B7 quoted combined CSV header is not two columns", () => {
  expect(() => parseCases('"case_id,case_input"\na,b\n')).toThrow();
});
test("[unit] B6 labeling locks retry decisions before first card judgment", async () => {
  const run = new BackstageRun(scene());
  await run.start(keys, success);
  const card = run.cards()[0];
  if (!card) throw new Error("missing card");
  expect(() => run.label(card.id, "accept")).toThrow();
  run.beginLabeling();
  expect(run.labeling).toBe(true);
  run.label(card.id, "accept");
  await expect(run.retry(keys, success)).rejects.toThrow();
});
test("[unit] B8 stale backend revision cannot enter frozen run", async () => {
  const run = new BackstageRun(scene(), "release-a");
  await run.start(keys, async (request) => ({
    ...(await success(request)),
    revision: "release-b",
  }));
  expect(run.completed).toBe(0);
  expect(run.extraSpend().unknown).toBe(4);
});

test("[unit] B8 health deadline and stop cover stalled response body", async () => {
  const signal = new AbortController();
  const stalled = () =>
    Promise.resolve(
      new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" },
      }),
    );
  await expect(
    checkRunnerHealth("test", signal.signal, stalled, 5),
  ).rejects.toThrow();
  const controller = new AbortController();
  const waiting = checkRunnerHealth(
    "test",
    controller.signal,
    () => new Promise(() => {}),
  );
  controller.abort();
  await expect(waiting).rejects.toThrow();
  await expect(
    checkRunnerHealth("test", signal.signal, async () =>
      Response.json({ protocol: "backstage/1", version: "test" }),
    ),
  ).resolves.toBeUndefined();
});
test("[unit] B2 import generations ignore stale files and edits", async () => {
  const state = new CaseImportState();
  let first: ((text: string) => void) | undefined;
  const stale = state.read(
    new Promise((resolve) => {
      first = resolve;
    }),
  );
  expect(state.pending).toBe(true);
  const latest = await state.read(
    Promise.resolve("case_id,case_input\nnew,latest\n"),
  );
  expect(latest?.[0]?.id).toBe("new");
  first?.("case_id,case_input\nold,stale\n");
  expect(await stale).toBeUndefined();
  let editing: ((text: string) => void) | undefined;
  const prior = state.read(
    new Promise((resolve) => {
      editing = resolve;
    }),
  );
  state.invalidate();
  editing?.("case_id,case_input\nold,stale\n");
  expect(await prior).toBeUndefined();
  expect(state.pending).toBe(false);
});

test("[unit] B2 frozen scene cannot change while handshake is pending", async () => {
  const original = { ...scene(), cases: [{ id: "x", input: "before" }] };
  const run = new BackstageRun(original, "revision");
  original.question = "changed";
  const item = original.cases[0];
  if (item) item.input = "after";
  const received: string[] = [];
  await run.start(keys, async (request) => {
    received.push(request.question + ":" + request.input);
    return success(request);
  });
  expect(received).toEqual(["Qualified?:before", "Qualified?:before"]);
});

test("[unit] B7 rejects malformed quoted CSV without repairing cases", () => {
  for (const csv of [
    'case_id,case_input\na,"unfinished',
    'case_id,case_input\na,"finished"trailing\n',
    'case_id,case_input\na,stray"quote\n',
  ])
    expect(() => parseCases(csv)).toThrow();
  expect(
    parseCases('case_id,case_input\r\na,"a ""quote""\r\nnext line"\r\n'),
  ).toEqual([{ id: "a", input: 'a "quote"\r\nnext line' }]);
});
test("[unit] B5 retry advice is actionable without provider or answer mapping", async () => {
  const run = new BackstageRun(scene());
  await run.start(keys, async (request) => ({
    ...(await success(request)),
    ok: false,
    code: request.provider === "jev" ? "http-401" : "http-429",
    message: "sensitive failure details",
    charge: "none",
    costUsd: null,
  }));
  const advice = run.retryAdvice();
  expect(advice).toHaveLength(2);
  expect(advice.some((message) => message.includes("keys"))).toBe(true);
  expect(advice.some((message) => message.includes("Wait"))).toBe(true);
  expect(advice.join(" ")).not.toMatch(/jev|llm|c1|c2|sensitive|yes|no choice/);
  expect(run.labeling).toBe(false);
  await run.retry(keys, success);
  expect(run.retryAdvice()).toEqual([]);
});
test("[unit] B4 unsafe run cannot enter judging and gives recovery guidance", async () => {
  const run = new BackstageRun(scene());
  await run.start(keys, success);
  await expect(
    run.retry({ jev: "Qualified?", llm: keys.llm }, success),
  ).rejects.toThrow();
  expect(() => run.beginLabeling()).toThrow("Start a new scene");
});

test("[integration] JO1 Jev-only runs without competitor key and exports only actual Jev answers", async () => {
  const run = new BackstageRun(scene(), "test", "jev-only");
  const calls: string[] = [];
  await run.start({ jev: keys.jev, llm: "" }, async (request) => {
    calls.push(request.provider);
    return { ...(await success(request)), confidence: 0.87 };
  });
  expect(calls).toEqual(["jev", "jev"]);
  expect(run.total).toBe(2);
  expect(run.completed).toBe(2);
  expect(run.running).toBe(false);
  expect(run.cards()).toHaveLength(2);
  expect(
    run.results().map((answer) => [answer.output, answer.confidence]),
  ).toEqual([
    ["yes", 0.87],
    ["yes", 0.87],
  ]);
  run.beginLabeling();
  for (const card of run.cards()) run.label(card.id, "accept");
  run.reveal();
  const parsed = validate(run.csv());
  expect(parsed.errors).toEqual([]);
  expect(parsed.rows).toHaveLength(2);
  expect(run.evidence().labels.map((row) => row.provider)).toEqual([
    "jev",
    "jev",
  ]);
  expect(run.evidence().manifest.mode).toBe("jev-only");
  expect(Object.isFrozen(run.manifest.arms)).toBe(true);
  expect(run.manifest.arms).toEqual(["jev"]);
  expect((await run.report()).verdict).toBeNull();
  expect(
    run.attempts.every((attempt) => attempt.ok && attempt.confidence === 0.87),
  ).toBe(true);
});
test("[integration] JO2 explicit comparison requires competitor key before any calls", async () => {
  const run = new BackstageRun(scene(), "test", "compare");
  let calls = 0;
  await expect(
    run.start({ jev: keys.jev, llm: "" }, async (request) => {
      calls++;
      return success(request);
    }),
  ).rejects.toThrow("llm key");
  expect(calls).toBe(0);
  expect(run.cards()).toHaveLength(0);
  await run.start(keys, success);
  expect(run.cards()).toHaveLength(6);
  expect(run.manifest.arms).toEqual(["rule", "jev", "llm"]);
  expect(run.results()).toEqual([]);
  expect((await run.report()).verdict).not.toBeNull();
});
test("[integration] JO3 stop and retry retain solo selection and never add unselected arms", async () => {
  const run = new BackstageRun(scene(), "test", "jev-only");
  const calls: string[] = [];
  await run.start({ jev: keys.jev, llm: "" }, async (request) => {
    calls.push(request.provider);
    run.stop();
    return success(request);
  });
  expect(run.completed).toBe(0);
  expect(run.cards()).toHaveLength(0);
  await run.retry({ jev: keys.jev, llm: "" }, async (request) => {
    calls.push(request.provider);
    return success(request);
  });
  expect(calls).toEqual(["jev", "jev", "jev"]);
  expect(run.completed).toBe(run.total);
  expect(run.manifest.mode).toBe("jev-only");
  expect(run.evidence().labels.every((row) => row.provider === "jev")).toBe(
    true,
  );
});

test("[unit] JO1 unused rule fields cannot block a solo scene with custom choices", () => {
  const custom: Scene = {
    ...scene(),
    choices: [
      { name: "keep", definition: "Keep" },
      { name: "cut", definition: "Cut" },
    ],
    matchChoice: "",
    otherwiseChoice: "",
    keywords: ["x".repeat(201)],
  };
  const run = new BackstageRun(custom, "test", "jev-only");
  expect(run.manifest.scene.choices.map((choice) => choice.name)).toEqual([
    "keep",
    "cut",
  ]);
  expect(run.manifest.scene.keywords).toEqual([]);
  expect(() => new BackstageRun(custom, "test", "compare")).toThrow("rule");
});
