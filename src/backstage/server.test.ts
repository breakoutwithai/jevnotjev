import { test, expect } from "bun:test";
import { createHandler } from "./server.ts";
const body = {
  version: "backstage/1",
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
test("[unit] B67 server rejects cross-origin and malformed requests without calling upstream", async () => {
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
test("[unit] B67 server health negotiates protocol/version and hardens response headers", async () => {
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
test("[unit] B67 server bounds concurrency and keeps failures sanitized", async () => {
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
test("[unit] B67 unsupported methods and traversal never serve source files", async () => {
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
