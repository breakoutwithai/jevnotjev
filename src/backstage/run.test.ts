import { describe, expect, test, spyOn } from "bun:test";
import {
  BackstageRun,
  trialTransport,
  CaseImportState,
  checkRunnerHealth,
  inputFingerprint,
  parseCases,
  validateSceneKeys,
} from "./run.ts";
import {
  type AnswerRequest,
  type AnswerSuccess,
  type Scene,
} from "./contracts.ts";
import { getModelEntry, CATALOG_VERSION } from "./catalog.ts";
import { validate } from "../format/validate.ts";
import { cohortMetrics } from "../core/metrics.ts";
import { fileSeed } from "../core/calc.ts";
import { verdict } from "../core/verdict.ts";
const compareSelection = { arms: ["jev", "claude-haiku-4-5-20251001", "rule"] };
function evidenceAfterReveal(run: BackstageRun) {
  if (run.manifest.mode === "compare" && !run.revealed && run.cards().length) {
    if (!run.labeling) run.beginLabeling();
    run.reveal();
  }
  return run.evidence();
}
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
const keys = { jev: "test-secret-jev", anthropic: "test-secret-llm" };
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
    model: r.modelId,
    armId: r.armId,
    catalogVersion: r.catalogVersion,
    promptVersion: r.promptVersion,
    requestedModel: r.modelId,
    returnedModel: r.modelId,
    parameters: getModelEntry(r.armId)!.parameters,
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
    const run = new BackstageRun(s, "test", compareSelection);
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
    const run = new BackstageRun(scene(), "test", compareSelection);
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
    expect(JSON.stringify(evidenceAfterReveal(run))).not.toContain(
      "test-secret",
    );
  });
  test("[unit] B2 double-run prevented; stop keeps unknown attempt and discards late result", async () => {
    const run = new BackstageRun(scene(), "test", compareSelection);
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
    expect(run.attempts).toHaveLength(4);
    expect(
      run.attempts.filter((a) => !a.ok && a.charge === "none"),
    ).toHaveLength(3);
    expect(run.attempts[0]?.ok).toBe(false);
    if (request && release) release(await success(request));
    await Promise.resolve();
    expect(run.cards()).toHaveLength(2);
    await run.retry(keys, success);
    expect(run.cards()).toHaveLength(6);
    expect(run.attempts).toHaveLength(8);
  });
  test("[unit] B5 retry never recharges success and retains known failed spend", async () => {
    const run = new BackstageRun(scene(), "test", compareSelection);
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
    const run = new BackstageRun(scene(), "test", compareSelection);
    await run.start(keys, async (r) => ({
      ...(await success(r)),
      model: "wrong",
      message: r.key,
      secret: r.key,
    }));
    expect(run.cards()).toHaveLength(2);
    expect(JSON.stringify(evidenceAfterReveal(run))).not.toContain(
      "test-secret",
    );
    expect((await run.report()).extraSpend.unknown).toBe(4);
  });
  test("[unit] B6 missing cost stays incomplete; no implicit human labels", async () => {
    const run = new BackstageRun(scene(), "test", compareSelection);
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
      new BackstageRun({ ...s, acceptance: keys.anthropic }).start(
        keys,
        success,
      ),
    ).rejects.toThrow();
    const run = new BackstageRun(s, "test", compareSelection);
    await run.start(keys, async (r) => ({
      ...(await success(r)),
      priceVersion: keys[r.provider === "jev" ? "anthropic" : "jev"],
    }));
    expect(run.cards()).toHaveLength(2);
    expect(JSON.stringify(evidenceAfterReveal(run))).not.toContain(
      "test-secret",
    );
  });
  test("[unit] B5 stop before dispatch makes no provider request", async () => {
    const run = new BackstageRun(scene(), "test", compareSelection);
    let calls = 0;
    const promise = run.start(keys, async (r) => {
      calls++;
      return success(r);
    });
    run.stop();
    await promise;
    expect(calls).toBe(0);
    expect(run.attempts).toHaveLength(4);
    expect(run.attempts.every((a) => !a.ok && a.charge === "none")).toBe(true);
  });
  test("[unit] B5 backend hyphenated failure codes preserve no-charge evidence", async () => {
    const run = new BackstageRun(scene(), "test", compareSelection);
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
    expect(
      run.attempts.every(
        (a) =>
          !a.ok && (a.code === "http-401" || a.code === "provider-blocked"),
      ),
    ).toBe(true);
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
  const escaped = { jev: 'secret"with\\escape', anthropic: "other-secret" };
  const run = new BackstageRun({ ...scene(), acceptance: escaped.jev });
  await expect(run.start(escaped, success)).rejects.toThrow();
  expect(() => run.csv()).toThrow();
  expect(() => run.evidence()).toThrow();
  await expect(run.start(keys, success)).rejects.toThrow();
  const retryRun = new BackstageRun(scene(), "test", compareSelection);
  await retryRun.start(keys, success);
  await expect(
    retryRun.retry({ jev: "Qualified?", anthropic: keys.anthropic }, success),
  ).rejects.toThrow();
  expect(() => retryRun.evidence()).toThrow();
});
test("[unit] B6 reveal irreversibly locks labels and retries", async () => {
  const run = new BackstageRun(scene(), "test", compareSelection);
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
    new BackstageRun(scene(), "test", compareSelection).start(
      { jev: "tiny", anthropic: keys.anthropic },
      success,
    ),
  ).rejects.toThrow();
});
test("[unit] B5 confirmed local rejections are uncharged, unknown HTTP failures stay uncertain", async () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  try {
    for (let i = 0; i < 2; i++)
      fetchSpy.mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            dispatched: false,
            code: "busy",
            charge: "none",
            error: "Runner busy. Retry explicitly when ready.",
          },
          { status: 503 },
        ),
      );
    const run = new BackstageRun(
      {
        ...scene(),
        cases: [{ id: "x", input: "test" }],
      },
      "test",
      compareSelection,
    );
    await run.start(keys);
    expect(run.extraSpend()).toEqual({ knownUsd: 0, unknown: 0 });
    for (let i = 0; i < 2; i++)
      fetchSpy.mockResolvedValueOnce(
        new Response("upstream proxy failure", { status: 503 }),
      );
    const uncertain = new BackstageRun(
      {
        ...scene(),
        cases: [{ id: "x", input: "test" }],
      },
      "test",
      compareSelection,
    );
    await uncertain.start(keys);
    expect(uncertain.extraSpend()).toEqual({ knownUsd: 0, unknown: 2 });
  } finally {
    fetchSpy.mockRestore();
  }
});

test("[unit] B5 first progress callback enables stopping before initial call", async () => {
  const run = new BackstageRun(scene(), "test", compareSelection);
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
  expect(states[0]).toBe(true);
  expect(states.at(-1)).toBe(false);
  expect(calls).toBe(0);
  expect(run.attempts).toHaveLength(4);
  expect(run.attempts.every((a) => !a.ok && a.charge === "none")).toBe(true);
});

test("[unit] B7 quoted combined CSV header is not two columns", () => {
  expect(() => parseCases('"case_id,case_input"\na,b\n')).toThrow();
});
test("[unit] B6 labeling locks retry decisions before first card judgment", async () => {
  const run = new BackstageRun(scene(), "test", compareSelection);
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
  expect(run.pending).toBe(run.total);
  expect(run.extraSpend().unknown).toBe(2);
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
      Response.json({
        protocol: "backstage/2",
        version: "test",
        catalogVersion: CATALOG_VERSION,
      }),
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
  expect(received).toEqual(["Qualified?:before"]);
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
  const run = new BackstageRun(scene(), "test", compareSelection);
  await run.start(keys, async (request) => ({
    ...(await success(request)),
    ok: false,
    code: request.provider === "jev" ? "http-401" : "http-429",
    message: "sensitive failure details",
    charge: "none",
    costUsd: null,
  }));
  const advice = run.retryAdvice();
  // Key rejection, later provider-blocked cells, and rate limiting have distinct recovery advice.
  expect(advice).toHaveLength(3);
  expect(advice.some((message) => message.includes("keys"))).toBe(true);
  expect(advice.some((message) => message.includes("Wait"))).toBe(true);
  expect(advice.join(" ")).not.toMatch(/jev|llm|c1|c2|sensitive|yes|no choice/);
  expect(run.labeling).toBe(false);
  await run.retry(keys, success);
  expect(run.retryAdvice()).toEqual([]);
});
test("[unit] B4 unsafe run cannot enter judging and gives recovery guidance", async () => {
  const run = new BackstageRun(scene(), "test", compareSelection);
  await run.start(keys, success);
  await expect(
    run.retry({ jev: "Qualified?", anthropic: keys.anthropic }, success),
  ).rejects.toThrow();
  expect(() => run.beginLabeling()).toThrow("Start a new scene");
});

test("[integration] JF1 Jev-only runs without competitor key and exports only actual Jev answers", async () => {
  const run = new BackstageRun(scene(), "test", { arms: ["jev"] });
  const calls: string[] = [];
  await run.start({ jev: keys.jev, anthropic: "" }, async (request) => {
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
test("[integration] JF1 missing competitor key fails its arms while Jev completes", async () => {
  const run = new BackstageRun(scene(), "test", compareSelection);
  const calls: string[] = [];
  await run.start({ jev: keys.jev }, async (request) => {
    calls.push(request.provider);
    return success(request);
  });
  expect(calls).toEqual(["jev", "jev"]);
  expect(run.cards()).toHaveLength(4);
  expect(run.pending).toBe(2);
  expect(run.attempts.filter((a) => !a.ok && a.charge === "none")).toHaveLength(
    2,
  );
  await run.retry(keys, success);
  expect(run.cards()).toHaveLength(6);
});
test("[integration] JF7 stop and retry retain solo selection and never add unselected arms", async () => {
  const run = new BackstageRun(scene(), "test", { arms: ["jev"] });
  const calls: string[] = [];
  await run.start({ jev: keys.jev, anthropic: "" }, async (request) => {
    calls.push(request.provider);
    run.stop();
    return success(request);
  });
  expect(run.pending).toBe(run.total);
  expect(run.cards()).toHaveLength(0);
  await run.retry({ jev: keys.jev, anthropic: "" }, async (request) => {
    calls.push(request.provider);
    return success(request);
  });
  expect(calls).toEqual(["jev", "jev", "jev"]);
  expect(run.completed).toBe(run.total);
  expect(run.manifest.mode).toBe("jev-only");
  expect((await run.report()).verdict).toBeNull();
  expect(run.results().map((answer) => answer.confidence)).toEqual([
    null,
    null,
  ]);
  expect(run.evidence().labels.every((row) => row.provider === "jev")).toBe(
    true,
  );
});

test("[unit] JF1 unused rule fields cannot block a solo scene with custom choices", () => {
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
  const run = new BackstageRun(custom, "test", { arms: ["jev"] });
  expect(run.manifest.scene.choices.map((choice) => choice.name)).toEqual([
    "keep",
    "cut",
  ]);
  expect(run.manifest.scene.keywords).toEqual([]);
  expect(() => new BackstageRun(custom, "test", compareSelection)).toThrow(
    "rule",
  );
});

test("[integration] JF2 same-provider models stay distinct and missing competitor keys do not block Jev", async () => {
  const run = new BackstageRun(scene(), "test", {
    arms: ["jev", "claude-sonnet-5-5", "claude-opus-5-5"],
  });
  const called: string[] = [];
  await run.start({ jev: keys.jev }, async (request) => {
    called.push(request.armId);
    return success(request);
  });
  expect(called).toEqual(["jev", "jev"]);
  expect(run.completed).toBe(6);
  expect(run.pending).toBe(4);
  await run.retry(
    { jev: keys.jev, anthropic: "test-anthropic-key" },
    async (request) => {
      called.push(request.armId);
      return success(request);
    },
  );
  expect(called.filter((id) => id === "claude-sonnet-5-5")).toHaveLength(2);
  expect(called.filter((id) => id === "claude-opus-5-5")).toHaveLength(2);
  expect(run.exports()).toHaveLength(2);
  for (const output of run.exports())
    expect(validate(output.csv).errors).toEqual([]);
});

test("[integration] JF3 401 suppresses only provider siblings and explicit retry resets suppression", async () => {
  const run = new BackstageRun(scene(), "test", {
    arms: ["jev", "claude-sonnet-5-5", "claude-opus-5-5", "gpt-6-luna"],
  });
  const calls: string[] = [];
  const allKeys = { ...keys, openai: "test-openai-key" };
  await run.start(allKeys, async (request) => {
    calls.push(request.armId);
    const answer = await success(request);
    return request.provider === "anthropic"
      ? {
          ...answer,
          ok: false,
          code: "http-401",
          message: "Denied",
          charge: "none",
          costUsd: 0,
        }
      : answer;
  });
  expect(calls.filter((id) => id.startsWith("claude"))).toHaveLength(1);
  expect(calls.filter((id) => id === "jev")).toHaveLength(2);
  expect(calls.filter((id) => id === "gpt-6-luna")).toHaveLength(2);
  await run.retry(allKeys, success);
  expect(run.pending).toBe(0);
  expect(
    run.attempts.filter((a) => a.ok && a.provider === "anthropic"),
  ).toHaveLength(4);
});

test("[integration] JF4 labels share identical outputs and exports preserve separate model cohorts", async () => {
  const run = new BackstageRun(scene(), "test", {
    arms: ["jev", "claude-sonnet-5-5", "claude-opus-5-5"],
  });
  await run.start(keys, success);
  run.beginLabeling();
  const card = run.cards().find((c) => c.caseId === "c1");
  if (!card) throw Error("missing card");
  run.label(card.id, "accept");
  expect(
    run
      .cards()
      .filter((c) => c.caseId === "c1")
      .every((c) => c.label === "accept"),
  ).toBe(true);
  const report = await run.report();
  expect(report.pairs).toHaveLength(2);
  expect(new Set(report.pairs.map((p) => p.runId)).size).toBe(2);
  expect(report.totalSpend.knownUsd).toBeCloseTo(0.006);
  expect(
    report.pairs.reduce(
      (sum, p) =>
        sum +
        p.metrics.arms.reduce(
          (n, a) => n + (a.spend.kind === "complete" ? a.spend.usd : 0),
          0,
        ),
      0,
    ),
  ).toBeCloseTo(0.008);
  expect(validate(run.csv()).errors).toEqual([]);
  expect(report.verdict).toBeNull();
});

test("[integration] JF4 total spend counts paid failures once after retry and excludes them from answer pairs", async () => {
  const run = new BackstageRun(scene(), "test", {
    arms: ["jev", "claude-sonnet-5-5"],
  });
  let first = true;
  await run.start(keys, async (request) => {
    const answer = await success(request);
    if (first) {
      first = false;
      return {
        ...answer,
        ok: false,
        code: "invalid-answer",
        message: "Invalid",
        charge: "known",
      };
    }
    return answer;
  });
  await run.retry(keys, success);
  const report = await run.report();
  expect(report.totalSpend).toEqual({ knownUsd: 0.005, unknown: 0 });
  expect(report.extraSpend).toEqual({ knownUsd: 0.001, unknown: 0 });
  expect(
    report.pairs[0]?.metrics.arms.reduce(
      (sum, a) => sum + (a.spend.kind === "complete" ? a.spend.usd : 0),
      0,
    ),
  ).toBeCloseTo(0.004);
});

test("[integration] JF5 all-failed solo exports attempt evidence and header-only records", async () => {
  const run = new BackstageRun(scene());
  await run.start(keys, async () => {
    throw Error("offline");
  });
  expect(run.exportable).toBe(true);
  expect(run.cards()).toHaveLength(0);
  const report = await run.report();
  expect(report.metrics.arms).toHaveLength(0);
  expect(report.verdict).toBeNull();
  expect(run.evidence().attempts).toHaveLength(2);
  expect(validate(run.csv()).rows).toHaveLength(0);
  expect(run.csv().trim().split("\n")).toHaveLength(1);
});

test("[integration] JF5 clearing mutable keys stops dispatch without erasing in-flight charge evidence", async () => {
  const run = new BackstageRun(scene(), "test", {
    arms: ["jev", "claude-sonnet-5-5"],
  });
  let holder: import("./contracts.ts").ProviderKeys = { ...keys };
  let calls = 0;
  await run.start(
    () => holder,
    async (request) => {
      calls++;
      holder = {};
      run.stop();
      return success(request);
    },
  );
  expect(calls).toBe(1);
  expect(
    run.attempts.filter((a) => !a.ok && a.charge === "unknown"),
  ).toHaveLength(1);
  expect(run.attempts.filter((a) => !a.ok && a.charge === "none")).toHaveLength(
    3,
  );
  expect(JSON.stringify(evidenceAfterReveal(run))).not.toContain("test-secret");
});

test("[unit] JF1 selection limits and rule configuration fail before dispatch", () => {
  expect(
    () =>
      new BackstageRun({ ...scene(), keywords: [] }, "test", {
        arms: ["jev", "rule"],
      }),
  ).toThrow("keyword");
  expect(
    () => new BackstageRun(scene(), "test", { arms: ["jev", "jev"] }),
  ).toThrow();
  expect(
    () => new BackstageRun(scene(), "test", { arms: ["jev", "unknown-model"] }),
  ).toThrow();
});

test("[integration] JF6 trial executes only one Jev case without browser credentials and cannot retry", async () => {
  const run = new BackstageRun({
    ...scene(),
    cases: [{ id: "one", input: "Please refund" }],
  });
  let calls = 0;
  await run.startTrial(async (request) => {
    calls++;
    expect(request.key).toBe("");
    expect(request.armId).toBe("jev");
    return success(request);
  });
  expect(calls).toBe(1);
  expect(run.funded).toBe(true);
  expect(run.evidence().funding).toBe("trial");
  await expect(run.retry(keys, success)).rejects.toThrow("cannot be retried");
});

test("[integration] JF6 oversized or multi-arm funded trial is rejected before transport", async () => {
  const run = new BackstageRun(scene());
  let calls = 0;
  await expect(
    run.startTrial(async (request) => {
      calls++;
      return success(request);
    }),
  ).rejects.toThrow("Trial limits");
  expect(calls).toBe(0);
  expect(run.started).toBe(false);
});

test("[unit] JF4 empty report permits only generated header-only records, not corrupt exports", async () => {
  const run = new BackstageRun(scene());
  await run.start(keys, async () => {
    throw Error("offline");
  });
  const original = run.exports.bind(run);
  run.exports = () =>
    original().map((output) => ({ ...output, csv: "broken,header\n" }));
  await expect(run.report()).rejects.toThrow("failed validation");
});

test("[integration] JF6 failed mint is definitely uncharged and cannot dispatch a trial answer", async () => {
  const run = new BackstageRun({
    ...scene(),
    cases: [{ id: "one", input: "refund" }],
  });
  const urls: string[] = [];
  await run.startTrial(
    trialTransport(async (url) => {
      urls.push(url);
      throw Error("offline mint");
    }),
  );
  expect(urls).toEqual(["/api/backstage/trial/mint"]);
  expect(run.extraSpend()).toEqual({ knownUsd: 0, unknown: 0 });
  expect(run.attempts[0]?.ok).toBe(false);
});

test("[integration] JF5 comparison evidence cannot reveal identities before judging is locked", async () => {
  const run = new BackstageRun(scene(), "test", {
    arms: ["jev", "claude-sonnet-5-5"],
  });
  await run.start(keys, success);
  expect(() => run.evidence()).toThrow("Reveal");
  run.beginLabeling();
  expect(() => run.evidence()).toThrow("Reveal");
  run.reveal();
  expect(run.evidence().attempts).toHaveLength(4);
});

test("[integration] JF5 key getter is re-read after keys clear without Stop", async () => {
  const run = new BackstageRun(scene(), "test", {
    arms: ["jev", "claude-sonnet-5-5"],
  });
  let holder: import("./contracts.ts").ProviderKeys = { ...keys };
  let calls = 0;
  await run.start(
    () => holder,
    async (request) => {
      calls++;
      holder = {};
      return success(request);
    },
  );
  expect(calls).toBe(1);
  expect(
    run.attempts.filter(
      (attempt) =>
        !attempt.ok &&
        attempt.code === "missing-key" &&
        attempt.charge === "none",
    ),
  ).toHaveLength(3);
  expect(run.attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
});

test("[integration] JF7 local key and version failures give specific no-charge recovery", async () => {
  const missing = new BackstageRun(scene(), "test", {
    arms: ["jev", "claude-sonnet-5-5"],
  });
  await missing.start({ jev: keys.jev }, success);
  expect(missing.retryAdvice().join(" ")).toContain("not charged");
  expect(missing.retryAdvice().join(" ")).not.toContain("unknown charges");
  const stale = new BackstageRun(scene());
  await stale.start(keys, async (request) => ({
    ...(await success(request)),
    ok: false,
    code: "prompt-mismatch",
    message: "Mismatch",
    charge: "none",
    costUsd: 0,
  }));
  expect(stale.retryAdvice().join(" ")).toContain("Reload");
  expect(stale.retryAdvice().join(" ")).not.toContain("unknown charges");
});

test("[integration] JF5 failed-only comparison evidence remains available without revealing", async () => {
  const run = new BackstageRun(scene(), "test", {
    arms: ["jev", "claude-sonnet-5-5"],
  });
  await run.start(keys, async () => {
    throw Error("offline");
  });
  expect(run.cards()).toHaveLength(0);
  expect(run.evidence().attempts).toHaveLength(4);
});

test("[unit] D11 three cases load from CSV and malformed input names the problem", () => {
  expect(
    parseCases("case_id,case_input\nc1,first\nc2,second\nc3,third\n").map(
      (c) => c.id,
    ),
  ).toEqual(["c1", "c2", "c3"]);
  const errors: [string, string][] = [
    ["id,text\nc1,a\n", "Use exactly the CSV columns case_id,case_input."],
    ["case_id,case_input\nc1,a\nc2,b,extra\n", "Invalid case CSV at line 3."],
    ['case_id,case_input\nc1,"open\n', "quoted field was not closed"],
    ["case_id,case_input\nc1,a\nc1,b\n", "Case IDs must be unique"],
    ["case_id,case_input\n", "Add between 1 and 100 cases."],
  ];
  for (const [csv, message] of errors)
    expect(() => parseCases(csv)).toThrow(message);
});
