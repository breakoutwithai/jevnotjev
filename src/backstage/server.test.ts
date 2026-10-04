import { test, expect } from "bun:test";
import { createHandler } from "./server.ts";
const body = {
  version: "backstage/1",
  revision: "test",
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
    protocol: "backstage/1",
    version: "test",
    models: { jev: "jev-1.13.0", llm: "claude-haiku-4-5-20251001" },
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
