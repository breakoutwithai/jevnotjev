import { expect, test } from "bun:test";
import { CATALOG_VERSION, MODEL_CATALOG } from "./catalog.ts";
import { PROMPT_TEMPLATE_VERSION } from "./prompt.ts";
import { createHandler, houseJevKeyFromEnvironment } from "./server.ts";

const HOUSE = "house-key-canary-0123456789";
const PASTED = "pasted-key-canary-9876543210";
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
  key: "",
};
function post(data: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3456/api/backstage/answer", {
    method: "POST",
    headers: { origin: "http://localhost:3456", "content-type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
}
function recorder() {
  const authorizations: string[] = [];
  const providerFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json({
      model: "jev-1.13.0",
      answers: { q1: { choice: "keep" } },
      usage: { input_tokens: 100, output_tokens: 1 },
    });
  };
  return { authorizations, providerFetch };
}

test("[unit] HK1 the house key serves the Jev arm when the request carries no key", async () => {
  const { authorizations, providerFetch } = recorder();
  const handler = createHandler({ version: "test", providerFetch, houseJevKey: HOUSE });
  for (const data of [body, { ...body, key: undefined }]) {
    const response = await handler(post(data));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok?: boolean }).ok).toBe(true);
  }
  expect(authorizations).toEqual([`Bearer ${HOUSE}`, `Bearer ${HOUSE}`]);
});

test("[unit] HK2 a key the tester pasted wins over the house key", async () => {
  const { authorizations, providerFetch } = recorder();
  const handler = createHandler({ version: "test", providerFetch, houseJevKey: HOUSE });
  expect((await handler(post({ ...body, key: PASTED }))).status).toBe(200);
  expect(authorizations).toEqual([`Bearer ${PASTED}`]);
});

test("[unit] HK3 the house key never appears in a response, header, log line or error", async () => {
  const lines: string[] = [];
  const echo = async () => new Response(`bad key ${HOUSE}`, { status: 401 });
  const ok = recorder();
  const surfaces: string[] = [];
  for (const providerFetch of [ok.providerFetch, echo]) {
    const handler = createHandler({ version: "test", providerFetch, houseJevKey: HOUSE, log: (line) => lines.push(line) });
    for (const request of [
      post(body),
      post({ ...body, input: `leak ${HOUSE}` }),
      post({ ...body, armId: "nope" }),
      new Request("http://localhost:3456/api/backstage/health"),
    ]) {
      const response = await handler(request);
      surfaces.push(await response.text(), JSON.stringify([...response.headers]));
    }
  }
  expect(surfaces.length).toBe(16);
  expect(lines.length).toBeGreaterThan(0);
  for (const surface of [...surfaces, ...lines]) expect(surface).not.toContain(HOUSE);
});

test("[unit] HK4 health exposes only the boolean", async () => {
  const health = async (houseJevKey?: string) => {
    const handler = createHandler({ version: "test", ...(houseJevKey ? { houseJevKey } : {}) });
    const response = await handler(new Request("http://localhost:3456/api/backstage/health"));
    return (await response.json()) as Record<string, unknown>;
  };
  expect((await health(HOUSE)).houseKey).toBe(true);
  expect((await health()).houseKey).toBe(false);
  expect(JSON.stringify(await health(HOUSE))).not.toContain(HOUSE);
});

test("[unit] HK5 only the Jev arm: another provider with no key is still refused before dispatch", async () => {
  const { authorizations, providerFetch } = recorder();
  const handler = createHandler({ version: "test", providerFetch, houseJevKey: HOUSE });
  const other = MODEL_CATALOG.find((entry) => entry.provider !== "jev" && entry.enabled);
  if (!other) throw new Error("no non-Jev catalog entry");
  const response = await handler(post({ ...body, armId: other.id, provider: other.provider, modelId: other.modelId }));
  expect(response.status).toBe(400);
  expect(authorizations).toEqual([]);
});

test("[unit] HK6 with the session gate on, an unsigned request never reaches the house key", async () => {
  const { authorizations, providerFetch } = recorder();
  const handler = createHandler({ version: "test", providerFetch, houseJevKey: HOUSE, requireSession: true });
  expect((await handler(post(body))).status).toBe(401);
  expect(authorizations).toEqual([]);
});

test("[unit] HK7 startup refuses the house key unless origin and bind are loopback", () => {
  const env = { BACKSTAGE_HOUSE_JEV_KEY: HOUSE };
  expect(houseJevKeyFromEnvironment({}, "https://jevnotjev.example", "127.0.0.1")).toBeUndefined();
  for (const origin of ["http://localhost:3456", "http://127.0.0.1:3456", "http://[::1]:3456"])
    expect(houseJevKeyFromEnvironment(env, origin, "127.0.0.1")).toBe(HOUSE);
  const refusals: Array<[string, string]> = [
    ["https://backstage.example", "127.0.0.1"],
    ["http://192.168.1.5:3456", "127.0.0.1"],
    ["http://localhost:3456", "0.0.0.0"],
    ["http://localhost:3456", "10.0.0.4"],
  ];
  for (const [origin, host] of refusals) {
    expect(() => houseJevKeyFromEnvironment(env, origin, host)).toThrow("BACKSTAGE_HOUSE_JEV_KEY");
    try { houseJevKeyFromEnvironment(env, origin, host); } catch (error) { expect(String(error)).not.toContain(HOUSE); }
  }
  expect(() => houseJevKeyFromEnvironment({ BACKSTAGE_HOUSE_JEV_KEY: "short" }, "http://localhost:3456", "127.0.0.1")).toThrow("BACKSTAGE_HOUSE_JEV_KEY");
  expect(() => createHandler({ version: "test", origin: "https://backstage.example", houseJevKey: HOUSE })).toThrow("BACKSTAGE_HOUSE_JEV_KEY");
});
