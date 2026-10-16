import { test, expect } from "bun:test";
import { createHandler } from "./server.ts";
import { samples } from "../tokenmax-ingest/ingest.ts";
const origin = "http://localhost:3456";
function request(body: string, from = origin, contentType = "application/json"): Request {
  return new Request(`${origin}/api/tokenmax/preview`, { method: "POST", headers: { origin: from, "content-type": contentType }, body });
}
function sample(): string { const first = samples()[0]; if (!first) throw new Error("missing sample"); return first.text; }
test("[integration] TM-H1 preview receives validates and generates map without publication or ambient inference", async () => {
  const handler = createHandler({ version: "test", origin });
  try {
    const response = await handler(request(sample()));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.platform).toBe("pending");
    expect(result.publication).toBe("synthetic-excluded");
    expect(result.stages).toEqual(["received", "validated", "platform-pending", "map-generated"]);
    expect(result.draft).toBeUndefined();
  } finally { handler.close(); }
});
test("[integration] TM-H2 preview rejects before provider processing and does not echo or log private input", async () => {
  const logs: string[] = [];
  const handler = createHandler({ version: "test", origin, log: line => logs.push(line) });
  try {
    const response = await handler(request('{"secret":"SecretCanary@example.test"}'));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("SecretCanary");
    expect(logs.join("\n")).not.toContain("SecretCanary");
    expect((await handler(request(sample(), "https://evil.test"))).status).toBe(403);
    expect((await handler(request(sample(), origin, "text/plain"))).status).toBe(415);
    expect((await handler(request("x".repeat(16385)))).status).toBe(413);
    expect((await handler(new Request(`${origin}/api/tokenmax/preview`))).status).toBe(405);
  } finally { handler.close(); }
});
test("[integration] TM-H3 platform checks receive only validated aggregates and bounded work returns busy", async () => {
  let calls = 0;
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const handler = createHandler({ version: "test", origin, maxConcurrent: 1, tokenmaxChecks: { check: async value => { calls++; expect(value.v).toBe("tm-collection/1"); await blocked; return { status: "accepted", reason: "synthetic transport" }; } } });
  try {
    expect((await handler(request('{"private":"canary"}'))).status).toBe(400);
    expect(calls).toBe(0);
    const first = handler(request(sample()));
    const busy = await handler(request(sample()));
    expect(busy.status).toBe(429);
    unblock?.();
    const result = await (await first).json();
    expect(result.platform).toBe("accepted");
    expect(result.stages).toEqual(["received", "validated", "platform-checking", "platform-accepted", "map-generated"]);
    expect(calls).toBe(1);
  } finally { unblock?.(); handler.close(); }
});
