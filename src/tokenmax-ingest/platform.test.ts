import { expect, test } from "bun:test";
import { createPlatformChecks } from "./platform.ts";
import { ingestDraft, samples } from "./ingest.ts";
function sample() { const text = samples()[0]?.text; if (!text) throw Error("sample"); const r = ingestDraft(text); if (!r.ok) throw Error(r.error); return r.value; }
const policy = { approved: true, recipient: "TypeSafe", content: "allowlisted-aggregate-only", maxCalls: 1, maxInputBytes: 16384, spendCeilingUsd: 0.01, reservedPerCallUsd: 0.01 };
test("[integration] TM-P1 platform approval and key are required before any provider call", async () => {
  let calls = 0;
  const checks = createPlatformChecks({ key: "", policy, fetch: async () => { calls++; throw Error("must not call"); } });
  expect((await checks.check(sample())).status).toBe("review"); expect(calls).toBe(0);
  const denied = createPlatformChecks({ key: "test-key", policy: { ...policy, approved: false }, fetch: async () => { calls++; throw Error("must not call"); } });
  expect((await denied.check(sample())).status).toBe("review"); expect(calls).toBe(0);
});
test("[integration] TM-P2 independent typed checks share one pinned request and enforce call ceiling", async () => {
  let calls = 0;
  const checks = createPlatformChecks({ key: "test-key", policy, fetch: async (_url, init) => {
    calls++; const body: unknown = JSON.parse(init.body); expect(JSON.stringify(body)).toContain('"model":"jev-1.13.0"'); expect(JSON.stringify(body)).toContain('"privacy"'); expect(JSON.stringify(body)).toContain('"consistency"');
    return Response.json({ model: "jev-1.13.0", answers: { privacy: { type: "choice", choice: "safe", confidence: 1 }, consistency: { type: "choice", choice: "consistent", confidence: 1 } } });
  } });
  expect((await checks.check(sample())).status).toBe("accepted");
  expect((await checks.check(sample())).status).toBe("review"); expect(calls).toBe(1);
});
test("[integration] TM-P3 wrong model, missing answers, review and timeouts fail closed", async () => {
  for (const response of [ { model: "wrong", answers: {} }, { model: "jev-1.13.0", answers: {} }, { model: "jev-1.13.0", answers: { privacy: { choice: "review", confidence: 1 }, consistency: { choice: "consistent", confidence: 1 } } } ]) {
    const checks = createPlatformChecks({ key: "test", policy, fetch: async () => Response.json(response) });
    expect((await checks.check(sample())).status).toBe("review");
  }
  const hanging = createPlatformChecks({ key: "test", policy, timeoutMs: 5, fetch: async () => new Promise<Response>(() => {}) });
  expect((await hanging.check(sample())).status).toBe("review");
});
test("[unit] TM-P4 spend reservation, recipient and input limits prevent calls", async () => {
  let calls = 0;
  for (const p of [ { ...policy, spendCeilingUsd: 0 }, { ...policy, reservedPerCallUsd: 0 }, { ...policy, recipient: "other" }, { ...policy, maxInputBytes: 1 }, { ...policy, maxCalls: 0 } ]) {
    const checks = createPlatformChecks({ key: "test", policy: p, fetch: async () => { calls++; throw Error("not authorized"); } });
    expect((await checks.check(sample())).status).toBe("review");
  }
  expect(calls).toBe(0);
});
test("[unit] TM-P5 caller mutation cannot expand a platform approval after construction", async () => {
  let calls = 0;
  const mutable = {...policy};
  const checks = createPlatformChecks({key: "test-key",policy:mutable,fetch:async()=>{calls++;return Response.json({model:"jev-1.13.0",answers:{privacy:{type:"choice",choice:"safe",confidence:1},consistency:{type:"choice",choice:"consistent",confidence:1}}});}});
  expect((await checks.check(sample())).status).toBe("accepted");
  mutable.maxCalls=2;mutable.spendCeilingUsd=0.02;
  expect((await checks.check(sample())).status).toBe("review");
  expect(calls).toBe(1);
});
