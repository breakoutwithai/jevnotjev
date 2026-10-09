import { PROMPT_TEMPLATE_VERSION } from "./prompt.ts";
import { CATALOG_VERSION, MODEL_CATALOG } from "./catalog.ts";
import { test, expect } from "bun:test";
import { createHandler } from "./server.ts";
const body = {
  version: "backstage/2",
  revision: "test",
  catalogVersion: CATALOG_VERSION,
  armId: "jev",
  modelId: "jev-1.13.0",
  promptVersion: PROMPT_TEMPLATE_VERSION,
  runId: "run-1",
  caseId: "case-1",
  question: "Keep?",
  choices: [
    { name: "keep", definition: "Suitable" },
    { name: "cut", definition: "Unsuitable" },
  ],
  input: "Example",
  provider: "jev",
  key: "secret-test-key",
};
function request(origin = "http://localhost:3456", data: unknown = body) {
  return new Request("http://localhost:3456/api/backstage/answer", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}
test("[unit] B4 server rejects cross-origin and malformed requests without calling upstream", async () => {
  let calls = 0;
  const handler = createHandler({
    version: "test",
    providerFetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  expect((await handler(request("https://evil.test"))).status).toBe(403);
  expect(
    (
      await handler(
        request("http://localhost:3456", { ...body, input: "x".repeat(8001) }),
      )
    ).status,
  ).toBe(400);
  expect(calls).toBe(0);
});
test("[unit] B8 server health negotiates protocol/version and hardens response headers", async () => {
  const handler = createHandler({ version: "test" });
  const response = await handler(
    new Request("http://localhost:3456/api/backstage/health"),
  );
  expect(await response.json()).toEqual({
    protocol: "backstage/2",
    version: "test",
    catalogVersion: CATALOG_VERSION,
    catalog: MODEL_CATALOG,
    origin: "http://localhost:3456",
    houseKey: false,
    trial: {
      available: false,
      reason: "Trial funding configuration is incomplete.",
    },
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
test("[unit] B4 server bounds concurrency and keeps failures sanitized", async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = createHandler({
    version: "test",
    maxConcurrent: 1,
    providerFetch: async () => {
      await pending;
      return new Response(body.key, { status: 401 });
    },
  });
  const first = handler(request());
  await Bun.sleep(10);
  expect((await handler(request())).status).toBe(503);
  release();
  const response = await first;
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain(body.key);
});
test("[unit] B4 unsupported methods and traversal never serve source files", async () => {
  const handler = createHandler({ version: "test", staticRoot: "site" });
  expect(
    (await handler(new Request("http://localhost:3456/api/backstage/answer")))
      .status,
  ).toBe(405);
  expect(
    (
      await handler(
        new Request("http://localhost:3456/%2e%2e%2fsrc/backstage/server.ts"),
      )
    ).status,
  ).toBe(404);
  expect(
    (await handler(new Request("http://localhost:3456/.env"))).status,
  ).toBe(404);
});

test("[unit] B8 stale browser revision is rejected before paid dispatch", async () => {
  let calls = 0;
  const handler = createHandler({
    version: "new-revision",
    providerFetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  const response = await handler(
    request("http://localhost:3456", { ...body, revision: "old-revision" }),
  );
  expect(response.status).toBe(409);
  expect(calls).toBe(0);
});

test("[unit] B8 runtime cannot relabel a compiled server artifact", async () => {
  const { runtimeVersion } = await import("./server.ts");
  const compiled = "a".repeat(40);
  expect(runtimeVersion(compiled, compiled)).toBe(compiled);
  expect(() => runtimeVersion("b".repeat(40), compiled)).toThrow(
    "compiled server revision",
  );
  expect(() => runtimeVersion(undefined, compiled)).toThrow();
  expect(() => runtimeVersion("test", "test")).toThrow();
});

test("[unit] B1 legacy local pages retain scripts while Backstage keeps strict CSP", async () => {
  const handler = createHandler({ version: "test", staticRoot: "site" });
  const legacy = await handler(new Request("http://localhost:3456/"));
  expect(legacy.status).toBe(200);
  expect(legacy.headers.get("content-security-policy")).toBeNull();
  const backstage = await handler(
    new Request("http://localhost:3456/backstage/"),
  );
  expect(backstage.status).toBe(200);
  expect(backstage.headers.get("content-security-policy")).toContain(
    "script-src 'self';",
  );
  expect(backstage.headers.get("content-security-policy")).not.toContain(
    "unsafe-inline",
  );
});

test("[integration] JO5 configured origin accepts its exact host and rejects other origins before dispatch", async () => {
  let calls = 0;
  const handler = createHandler({
    version: "test",
    origin: "http://127.0.0.1:3456",
    providerFetch: async () => {
      calls++;
      return new Response("Unauthorized", { status: 401 });
    },
  });
  for (const origin of [
    "http://localhost:3456",
    "https://evil.test",
    "http://127.0.0.1:3457",
  ]) {
    const rejected = await handler(request(origin));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({
      error: "Same-origin requests required.",
    });
  }
  expect(calls).toBe(0);
  const accepted = await handler(request("http://127.0.0.1:3456"));
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({
    ok: false,
    code: "http-401",
    provider: "jev",
  });
  expect(calls).toBe(1);
});

test("[integration] JF7 unfunded trial is explicit and makes no provider call", async () => {
  let calls = 0;
  const handler = createHandler({
    version: "test",
    providerFetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  const response = await handler(
    new Request("http://localhost:3456/api/backstage/trial/mint", {
      method: "POST",
      headers: {
        origin: "http://localhost:3456",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "trial-unavailable",
    charge: "none",
    dispatched: false,
  });
  expect(calls).toBe(0);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrialConfig } from "./trial.ts";
import type { BackstageHandler, ServerOptions } from "./server.ts";
function trialRequest(
  path: string,
  data: unknown = {},
  cookie = "",
  extra: Record<string, string> = {},
): Request {
  return new Request(`http://localhost:3456/api/backstage/trial/${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3456",
      "content-type": "application/json",
      cookie,
      ...extra,
    },
    body: JSON.stringify(data),
  });
}
function trialDecision(idempotencyKey = "attempt-1") {
  const { key, ...rest } = body;
  return { ...rest, idempotencyKey };
}
async function withTrial(
  check: (
    handler: BackstageHandler,
    config: TrialConfig,
    create: (overrides?: Partial<ServerOptions>) => BackstageHandler,
  ) => Promise<void>,
  overrides: Partial<ServerOptions> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "backstage-api-trial-"));
  const config: TrialConfig = {
    path: join(dir, "ledger.sqlite"),
    fundedKey: "funded-secret-canary",
    signingSecret: "s".repeat(40),
    pricingVerified: true,
    worstCostMicroUsd: 2753,
    dailyBudgetMicroUsd: 20000,
    dailyMintLimit: 10,
    dailyNetworkMintLimit: 1,
    dailyNetworkAttemptLimit: 2,
  };
  const handlers: BackstageHandler[] = [];
  const create = (extra: Partial<ServerOptions> = {}) => {
    const handler = createHandler({
      version: "test",
      trialConfig: config,
      trialPricingVersion: CATALOG_VERSION,
      providerFetch: async () =>
        Response.json({
          model: "jev-1.13.0",
          answers: { q1: { choice: "keep" } },
          usage: { input_tokens: 100, output_tokens: 1 },
        }),
      ...overrides,
      ...extra,
    });
    handlers.push(handler);
    return handler;
  };
  try {
    await check(create(), config, create);
  } finally {
    for (const handler of handlers) handler.close();
    await rm(dir, { recursive: true, force: true });
  }
}
async function mint(
  handler: BackstageHandler,
  address = "127.0.0.1",
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await handler(trialRequest("mint", {}, "", headers), {
    remoteAddress: address,
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toContain("HttpOnly; SameSite=Strict");
  return cookie?.split(";")[0] ?? "";
}
test("[integration] JF7 trial dispatch stays Jev-only with one durable allowance and no key exposure", async () => {
  await withTrial(async (handler, config, create) => {
    const cookie = await mint(handler);
    const first = await handler(
      trialRequest("answer", trialDecision(), cookie),
    );
    expect(first.status).toBe(200);
    expect(await first.clone().json()).toMatchObject({
      ok: true,
      provider: "jev",
      requestedModel: "jev-1.13.0",
    });
    expect(await first.text()).not.toContain(config.fundedKey);
    const replay = await handler(
      trialRequest("answer", trialDecision(), cookie),
    );
    expect(await replay.json()).toMatchObject({
      code: "trial-replay",
      charge: "none",
      dispatched: false,
    });
    const exhausted = await handler(
      trialRequest("answer", trialDecision("attempt-2"), cookie),
    );
    expect(await exhausted.json()).toMatchObject({ code: "trial-exhausted" });
    handler.close();
    const restarted = create();
    expect(
      (
        await restarted(
          trialRequest("answer", trialDecision("attempt-3"), cookie),
        )
      ).status,
    ).toBe(429);
  });
});
test("[integration] JF7 untrusted forwarded addresses cannot bypass network mint cap", async () => {
  await withTrial(
    async (handler) => {
      await mint(handler, "203.0.113.10", {
        "x-backstage-client-ip": "198.51.100.1",
      });
      const next = await handler(
        trialRequest("mint", {}, "", {
          "x-backstage-client-ip": "198.51.100.2",
        }),
        { remoteAddress: "203.0.113.10" },
      );
      expect(next.status).toBe(429);
    },
    { trustProxy: true },
  );
});
test("[integration] JF7 trusted loopback proxy reads only the overwritten agreed header", async () => {
  await withTrial(
    async (handler) => {
      await mint(handler, "127.0.0.1", {
        "x-backstage-client-ip": "198.51.100.1",
      });
      await mint(handler, "127.0.0.1", {
        "x-backstage-client-ip": "198.51.100.2",
      });
      expect(
        (await handler(trialRequest("mint"), { remoteAddress: "127.0.0.1" }))
          .status,
      ).toBe(503);
    },
    { trustProxy: true },
  );
});
test("[integration] JF7 trial rejects foreign model, oversize input and client key before spending", async () => {
  let calls = 0;
  await withTrial(
    async (handler) => {
      const cookie = await mint(handler);
      for (const data of [
        { ...trialDecision(), input: "x".repeat(1001) },
        { ...trialDecision(), key: "injected-secret" },
        {
          ...trialDecision(),
          armId: "grok-4.7",
          modelId: "grok-4.7",
          provider: "xai",
        },
      ]) {
        const response = await handler(trialRequest("answer", data, cookie));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          charge: "none",
          dispatched: false,
        });
      }
      expect(calls).toBe(0);
    },
    {
      providerFetch: async () => {
        calls++;
        return Response.json({});
      },
    },
  );
});
test("[integration] JF7 all routes share admission and busy requests never consume trial allowance", async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await withTrial(
    async (handler) => {
      const cookie = await mint(handler);
      const inFlight = handler(request());
      await Bun.sleep(5);
      const busy = await handler(
        trialRequest("answer", trialDecision(), cookie),
      );
      expect(busy.status).toBe(503);
      expect(await busy.json()).toMatchObject({
        dispatched: false,
        charge: "none",
      });
      expect(calls).toBe(1);
      release();
      await inFlight;
      expect(
        (await handler(trialRequest("answer", trialDecision(), cookie))).status,
      ).toBe(200);
      expect(calls).toBe(2);
    },
    {
      maxConcurrent: 1,
      providerFetch: async () => {
        calls++;
        await pending;
        return Response.json({
          model: "jev-1.13.0",
          answers: { q1: { choice: "keep" } },
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    },
  );
});
test("[integration] JF7 busy trial blocks BYOK through same admission counter", async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withTrial(
    async (handler) => {
      const cookie = await mint(handler);
      const inFlight = handler(trialRequest("answer", trialDecision(), cookie));
      await Bun.sleep(5);
      expect((await handler(request())).status).toBe(503);
      release();
      await inFlight;
    },
    {
      maxConcurrent: 1,
      providerFetch: async () => {
        await pending;
        return new Response("", { status: 500 });
      },
    },
  );
});
test("[integration] JF7 funding boolean cannot override invalid reserve or stale pricing", async () => {
  await withTrial(async (handler, config, create) => {
    handler.close();
    for (const overrides of [
      { trialConfig: { ...config, worstCostMicroUsd: 1 } },
      { trialPricingVersion: "old" },
    ]) {
      const disabled = create(overrides);
      const response = await disabled(trialRequest("mint"), {
        remoteAddress: "127.0.0.1",
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "trial-unavailable",
      });
    }
  });
});
test("[unit] JF1 old protocol, catalog and unknown model return sanitized explicit predispatch codes", async () => {
  let calls = 0;
  const handler = createHandler({
    version: "test",
    providerFetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  for (const [data, code] of [
    [{ ...body, version: "backstage/1" }, "protocol-mismatch"],
    [{ ...body, catalogVersion: "old" }, "catalog-mismatch"],
    [{ ...body, armId: "unknown" }, "unsupported-arm"],
  ]) {
    const response = await handler(request("http://localhost:3456", data));
    expect(await response.clone().json()).toMatchObject({
      code,
      dispatched: false,
      charge: "none",
    });
    expect(await response.text()).not.toContain(body.key);
  }
  expect(calls).toBe(0);
});
test("[integration] JF7 configured HTTPS origin secures cookie behind HTTP loopback proxy", async () => {
  await withTrial(
    async (handler) => {
      const req = trialRequest("mint", {}, "", {
        origin: "https://own.example",
        "x-backstage-client-ip": "198.51.100.2",
      });
      const response = await handler(req, { remoteAddress: "127.0.0.1" });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("; Secure");
    },
    { origin: "https://own.example", trustProxy: true },
  );
});
test("[unit] JF6 all predispatch method origin and media failures are explicitly uncharged", async () => {
  const handler = createHandler({ version: "test" });
  for (const req of [
    new Request("http://localhost:3456/api/backstage/answer"),
    request("https://evil.test"),
    new Request("http://localhost:3456/api/backstage/answer", {
      method: "POST",
      headers: {
        origin: "http://localhost:3456",
        "content-type": "text/plain",
      },
      body: "secret",
    }),
  ])
    expect(await (await handler(req)).json()).toMatchObject({
      ok: false,
      dispatched: false,
      charge: "none",
    });
});
test("[integration] JF7 funded auth failures trip durable hold and prevent subsequent paid calls", async () => {
  let calls = 0;
  await withTrial(
    async (handler, _config, create) => {
      const cookie = await mint(handler);
      await handler(trialRequest("answer", trialDecision(), cookie));
      handler.close();
      const restarted = create();
      const next = await restarted(trialRequest("mint"), {
        remoteAddress: "203.0.113.2",
      });
      expect(await next.json()).toMatchObject({
        code: "trial-unavailable",
        dispatched: false,
        charge: "none",
      });
      expect(calls).toBe(1);
    },
    {
      providerFetch: async () => {
        calls++;
        return new Response("", { status: 401 });
      },
    },
  );
});
test("[unit] JF2 claimed prompt version mismatch cannot reach inference", async () => {
  let calls = 0;
  const handler = createHandler({
    version: "test",
    providerFetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  const response = await handler(
    request("http://localhost:3456", {
      ...body,
      promptVersion: "invented-version",
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "prompt-mismatch",
    dispatched: false,
    charge: "none",
  });
  expect(calls).toBe(0);
});
test("[integration] JF7 mint replaces a forged shaped cookie but keeps a verified used allowance", async () => {
  await withTrial(async (handler) => {
    const forged = `backstage_trial=${"0".repeat(8)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(12)}.${"0".repeat(64)}`;
    const minted = await handler(trialRequest("mint", {}, forged), {
      remoteAddress: "203.0.113.1",
    });
    expect(minted.status).toBe(200);
    expect(minted.headers.get("set-cookie")).not.toBeNull();
    const cookie = minted.headers.get("set-cookie")?.split(";")[0] ?? "";
    await handler(trialRequest("answer", trialDecision(), cookie));
    const reused = await handler(trialRequest("mint", {}, cookie), {
      remoteAddress: "203.0.113.1",
    });
    expect(reused.status).toBe(200);
    expect(reused.headers.get("set-cookie")).toBeNull();
    expect(
      (await handler(trialRequest("answer", trialDecision("fresh-id"), cookie)))
        .status,
    ).toBe(429);
  });
});
test("[integration] JF7 expired or rotated-signature cookies are replaced through rate-limited mint", async () => {
  for (const change of ["expired", "rotated"])
    await withTrial(async (handler, config, create) => {
      const cookie = await mint(handler);
      handler.close();
      const replacement = create({
        trialConfig: {
          ...config,
          ...(change === "expired"
            ? { now: () => Date.now() + 91 * 86400000 }
            : { signingSecret: "r".repeat(40) }),
        },
      });
      const response = await replacement(trialRequest("mint", {}, cookie), {
        remoteAddress: "198.51.100.2",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).not.toBeNull();
      expect(response.headers.get("set-cookie")).not.toContain(cookie);
    });
});
test("[integration] JF7 health reports durable funding hold after restart", async () => {
  await withTrial(
    async (handler, _config, create) => {
      const cookie = await mint(handler);
      await handler(trialRequest("answer", trialDecision(), cookie));
      handler.close();
      const restarted = create();
      const response = await restarted(
        new Request("http://localhost:3456/api/backstage/health"),
      );
      expect(await response.json()).toMatchObject({
        trial: { available: false },
      });
    },
    { providerFetch: async () => new Response("", { status: 401 }) },
  );
});
