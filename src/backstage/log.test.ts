import { test, expect } from "bun:test";
import { createHandler } from "./server.ts";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_VERSION } from "./catalog.ts";
import { PROMPT_TEMPLATE_VERSION } from "./prompt.ts";
import { credentialFingerprint, signSession } from "./auth.ts";
import { createEventLogger } from "./log.ts";
import { LoginLimiter } from "./auth.ts";

test("[unit] L0 default sink handles stdout errors and clock failures", () => {
  const before = process.stdout.listeners("error");
  const logger = createEventLogger(() => { throw new Error("clock unavailable"); });
  createEventLogger(() => 0);
  const added = process.stdout.listeners("error").filter((listener) => !before.includes(listener));
  try {
    expect(added.length).toBeLessThanOrEqual(1);
    expect(process.stdout.listeners("error").length).toBeGreaterThan(0);
    expect(() => logger.auth({ event: "signin.password.fail", email: "unknown", ip: "unknown", rid: "rid" })).not.toThrow();
    expect(() => logger.run({ event: "run.start", rid: "rid", provider: "jev", model: "jev-1.13.0" })).not.toThrow();
    expect(process.stdout.listeners("error")).toHaveLength(before.length + added.length);
    expect(() => process.stdout.emit("error", new Error("EPIPE"))).not.toThrow();
  } finally { for (const listener of added) process.stdout.removeListener("error", listener); }
});

test("[integration] L1 password failure emits one bounded JSON line", async () => {
  const lines: string[] = [];
  const handler = createHandler({ version: "test", log: (line) => lines.push(line), auth: { sessionSecret: "s".repeat(32) } });
  try {
    await handler(new Request("http://localhost:3456/api/auth/password", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=missing%40example.com&password=PWMARK" }));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ event: "signin.password.fail", email: "unknown" });
  } finally { handler.close(); }
});

test("[integration] L3 all captured auth and run output contains only contracted fields and no secrets", async () => {
  const captured: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const methods = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  const consoleMethods: ("log" | "info" | "warn" | "error" | "debug")[] = ["log", "info", "warn", "error", "debug"];
  for (const name of consoleMethods) console[name] = (...args: unknown[]) => { captured.push(JSON.stringify(args)); };
  const directory = mkdtempSync(join(tmpdir(), "backstage-log-"));
  const path = join(directory, "operators.json");
  const password = "PWMARK-password";
  const wrong = "PWMARK2-wrong";
  const salt = randomBytes(16).toString("hex");
  const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  writeFileSync(path, JSON.stringify([{ email: "Operator@Example.com", password_hash: hash }]));
  const secret = "SESSIONSECRETMARK" + "s".repeat(32);
  let now = 1000;
  let googleMode = "ok";
  let providerMode = "error";
  const profile = { email: "Operator@Example.com", email_verified: true, aud: "client", iss: "https://accounts.google.com" };
  const handler = createHandler({ version: "test", trustProxy: true, auth: { sessionSecret: secret, operatorsPath: path, googleClientId: "client", googleClientSecret: "CLIENTSECRETMARK", clock: () => now, fetch: async (input) => {
    if (googleMode === "throw") throw new Error("OAUTHCODEMARK");
    if (String(input).endsWith("/token")) return googleMode === "token-error" ? new Response("", { status: 500 }) : Response.json({ access_token: "ACCESSTOKENMARK", id_token: "IDTOKENMARK", refresh_token: "REFRESHMARK" });
    if (googleMode === "info-error") return new Response("", { status: 500 });
    return Response.json(googleMode === "unverified" ? { ...profile, email_verified: false } : googleMode === "missing" ? { ...profile, email: "" } : googleMode === "aud" ? { ...profile, aud: "wrong" } : googleMode === "unknown" ? { ...profile, email: "absent@example.com" } : profile);
  } }, providerFetch: async (_url, init) => providerMode === "ok" ? Response.json({ model: "jev-1.13.0", answers: { q1: { choice: "keep" } }, usage: { input_tokens: 100, output_tokens: 1 } }) : new Response(String(init?.body ?? ""), { status: 401 }) });
  const events: string[][] = [];
  const records: Record<string, unknown>[][] = [];
  const send = async (request: Request): Promise<Response> => {
    const before = captured.length;
    const response = await handler(request, { remoteAddress: "127.0.0.1" });
    const lines = captured.slice(before).join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    for (const line of lines) {
      const keys = Object.keys(line);
      expect(keys).toEqual(line.event.startsWith("run.") ? ["ts", "event", "rid", "provider", "model"] : line.event === "session.rejected" || line.event === "signin.google.denied" ? ["ts", "event", "email", "ip", "rid", "reason"] : ["ts", "event", "email", "ip", "rid"]);
      expect(line.ts).toBe(new Date(now).toISOString());
      expect(line.rid).toMatch(/^[a-f0-9-]{36}$/);
      if (!line.event.startsWith("run.")) expect(line.ip).toBe("198.51.100.7");
    }
    if (lines.length > 1) expect(new Set(lines.map((line) => line.rid)).size).toBe(1);
    events.push(lines.map((line) => line.event));
    records.push(lines);
    return response;
  };
  const headers = { "x-backstage-client-ip": "198.51.100.7" };
  const form = (email: string, pass: string, extra: Record<string, string> = {}) => new Request("http://localhost:3456/api/auth/password", { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded", ...extra }, body: new URLSearchParams({ email, password: pass }) });
  const sessionRequest = (cookie = "") => new Request("http://localhost:3456/api/auth/session", { headers: { ...headers, cookie } });
  const callback = (query: string, nonce = "") => new Request(`http://localhost:3456/api/auth/google/callback?${query}`, { headers: { ...headers, cookie: `backstage_oauth=${nonce}` } });
  try {
    console.error("CONTROL-MARK");
    const good = await send(form("Operator@Example.com", password));
    const mintedCookie = good.headers.get("set-cookie")?.split(";")[0] ?? "";
    const mintedValue = mintedCookie.split("=")[1] ?? "";
    await send(form("Operator@Example.com", wrong));
    await send(form("absent@example.com", wrong));
    await send(form(password, wrong));
    await send(new Request("http://localhost:3456/api/auth/password", { method: "POST", headers: { ...headers, authorization: `Basic ${Buffer.from("absent@example.com:PWMARK-basic").toString("base64")}` } }));
    await send(new Request("http://localhost:3456/api/auth/password", { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "PWMARK-bad-type" }));
    await send(form("", ""));
    for (let i = 0; i < 5; i++) await send(form("locked@example.com", wrong));
    await send(form("locked@example.com", wrong));
    await send(new Request("http://localhost:3456/api/auth/password", { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body: "" }));
    await send(new Request("http://localhost:3456/api/auth/password", { headers }));
    await send(sessionRequest());
    await send(sessionRequest("backstage_session=COOKIEMARK.forged"));
    const cred = credentialFingerprint(hash);
    const expired = signSession({ email: "operator@example.com", auth: "password", iat: 0, exp: 999, sid: "expired", cred }, secret);
    await send(sessionRequest(`backstage_session=${expired}`));
    await send(sessionRequest(mintedCookie));
    await send(new Request("http://localhost:3456/api/auth/sign-out", { method: "POST", headers: { ...headers, cookie: mintedCookie } }));
    await send(sessionRequest(mintedCookie));
    await send(new Request("http://localhost:3456/api/auth/sign-out", { method: "POST", headers }));
    await send(callback("state=bad&code=OAUTHCODEMARK"));
    const start = await send(new Request("http://localhost:3456/api/auth/google", { headers }));
    const state = new URL(start.headers.get("location") ?? "http://localhost/").searchParams.get("state") ?? "";
    const nonce = start.headers.get("set-cookie")?.split(";")[0]?.split("=")[1] ?? "";
    await send(callback(`state=${encodeURIComponent(state)}&error=access_denied`, nonce));
    for (const mode of ["token-error", "info-error", "throw", "missing", "aud", "unverified", "unknown", "ok"]) {
      googleMode = mode;
      await send(callback(`state=${encodeURIComponent(state)}&code=OAUTHCODEMARK`, nonce));
    }
    const runBody = { version: "backstage/2", revision: "test", catalogVersion: CATALOG_VERSION, armId: "gpt-6.1-sol", modelId: "gpt-6.1-sol", promptVersion: PROMPT_TEMPLATE_VERSION, runId: "run-1", caseId: "case-1", question: "QUESTIONMARK", choices: [{ name: "keep", definition: "CASETEXTMARK" }, { name: "cut", definition: "Other" }], input: "CASETEXTMARK", provider: "openai", key: "APIKEYMARK" };
    const run = (data: unknown, extra: Record<string, string> = {}) => new Request("http://localhost:3456/api/backstage/answer", { method: "POST", headers: { ...headers, origin: "http://localhost:3456", "content-type": "application/json", ...extra }, body: JSON.stringify(data) });
    await send(run(runBody));
    await send(run({ ...runBody, modelId: "APIKEYMARK" }));
    await send(run(runBody, { origin: "https://evil.test" }));
    providerMode = "ok";
    await send(run({ ...runBody, armId: "jev", modelId: "jev-1.13.0", provider: "jev" }));
    const trialHandler = createHandler({ version: "test", trialPricingVersion: CATALOG_VERSION, trialConfig: { path: join(directory, "ledger.sqlite"), fundedKey: "TRIALKEYMARK", signingSecret: "t".repeat(40), pricingVerified: true, worstCostMicroUsd: 2753, dailyBudgetMicroUsd: 20000, dailyMintLimit: 10, dailyNetworkMintLimit: 1, dailyNetworkAttemptLimit: 2 }, providerFetch: async () => Response.json({ model: "jev-1.13.0", answers: { q1: { choice: "keep" } }, usage: { input_tokens: 100, output_tokens: 1 } }) });
    try {
      const mint = await send(new Request("http://localhost:3456/api/backstage/trial/mint", { method: "POST", headers: { origin: "http://localhost:3456", "content-type": "application/json" }, body: "{}" }));
      // The default handler above has no funding; mint through the funded handler.
      expect(mint.status).toBe(503);
      const before = captured.length;
      const fundedMint = await trialHandler(new Request("http://localhost:3456/api/backstage/trial/mint", { method: "POST", headers: { origin: "http://localhost:3456", "content-type": "application/json" }, body: "{}" }), { remoteAddress: "198.51.100.7" });
      expect(captured.slice(before)).toEqual([]);
      const trialCookie = fundedMint.headers.get("set-cookie")?.split(";")[0] ?? "";
      const decision = { ...runBody, armId: "jev", modelId: "jev-1.13.0", provider: "jev", idempotencyKey: "trial-1" };
      const { key: _key, ...trialDecision } = decision;
      const trialBefore = captured.length;
      await trialHandler(new Request("http://localhost:3456/api/backstage/trial/answer", { method: "POST", headers: { origin: "http://localhost:3456", "content-type": "application/json", cookie: trialCookie }, body: JSON.stringify(trialDecision) }), { remoteAddress: "198.51.100.7" });
      const trialLines = captured.slice(trialBefore).join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(trialLines.map((line) => line.event)).toEqual(["run.start", "run.done"]);
      for (const line of trialLines) expect(Object.keys(line)).toEqual(["ts", "event", "rid", "provider", "model"]);
    } finally { trialHandler.close(); }
    expect(events[0]).toEqual(["signin.password.ok"]);
    expect(events[1]).toEqual(["signin.password.fail"]);
    for (const index of [2, 3, 4, 5, 6]) {
      expect(events[index]).toEqual(["signin.password.fail"]);
      expect(records[index]?.[0]?.email).toBe("unknown");
    }
    expect(records[1]?.[0]?.email).toBe("operator@example.com");
    expect(events[11]).toEqual(["signin.password.fail", "signin.lockout"]);
    expect(events[12]).toEqual(["signin.lockout"]);
    for (const index of [11, 12]) expect(records[index]?.find((line) => line.event === "signin.lockout")?.email).toBe("unknown");
    expect(events[13]).toEqual([]);
    expect(events[14]).toEqual([]);
    expect(events[15]).toEqual([]);
    expect(events[16]).toEqual(["session.rejected"]);
    expect(events[17]).toEqual(["session.rejected"]);
    expect(events[20]).toEqual(["session.rejected"]);
    expect(records[16]?.[0]?.reason).toBe("bad-signature");
    expect(records[17]?.[0]?.reason).toBe("expired");
    expect(records[20]?.[0]?.reason).toBe("revoked");
    expect(events[19]).toEqual(["signout"]);
    expect(events[21]).toEqual(["signout"]);
    expect(events[22]).toEqual(["signin.google.denied"]);
    expect(records[22]?.[0]?.reason).toBe("bad-state");
    expect(events[23]).toEqual([]);
    expect(events[24]).toEqual(["signin.google.denied"]);
    expect(records[24]?.[0]?.reason).toBe("provider-error");
    for (const index of [25, 26, 27]) expect(records[index]?.[0]?.reason).toBe("provider-error");
    expect(records[28]?.[0]?.reason).toBe("invalid-token");
    expect(records[29]?.[0]?.reason).toBe("invalid-token");
    expect(records[30]?.[0]?.reason).toBe("unverified-email");
    expect(records[30]?.[0]?.email).toBe("unknown");
    expect(records[31]?.[0]?.reason).toBe("not-allowlisted");
    expect(records[31]?.[0]?.email).toBe("unknown");
    for (const index of [22, 24, 25, 26, 27, 28, 29, 30, 31]) expect(events[index]).toEqual(["signin.google.denied"]);
    expect(events[32]).toEqual(["signin.google.ok"]);
    expect(events[33]).toEqual(["run.start", "run.error"]);
    expect(records[33]?.[0]?.model).toBe("gpt-6.1-sol");
    expect(events[34]).toEqual([]);
    expect(events[35]).toEqual([]);
    expect(events[36]).toEqual(["run.start", "run.done"]);
    expect(records[17]?.[0]?.email).toBe("operator@example.com");
    const all = captured.join("");
    expect(all).toContain("CONTROL-MARK");
    // Ported from clearance-dealmarket-v1 route.unit.spec.ts:1027: search the entire captured output.
    for (const value of [password, wrong, "PWMARK-basic", "absent@example.com", "locked@example.com", secret, mintedValue, "COOKIEMARK", "CLIENTSECRETMARK", "OAUTHCODEMARK", state, nonce, "ACCESSTOKENMARK", "IDTOKENMARK", "REFRESHMARK", "APIKEYMARK", "TRIALKEYMARK", "QUESTIONMARK", "CASETEXTMARK"]) expect(all).not.toContain(value);
  } finally {
    handler.close();
    rmSync(directory, { recursive: true, force: true });
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    Object.assign(console, methods);
  }
});

test("[unit] L4 a failed sink cannot change password, session, or run responses", async () => {
  const handler = createHandler({ version: "test", log: () => { throw new Error("sink unavailable"); }, auth: { sessionSecret: "s".repeat(32) }, providerFetch: async () => new Response("provider rejected", { status: 401 }) });
  try {
    const password = await handler(new Request("http://localhost:3456/api/auth/password", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=absent%40example.com&password=wrong" }));
    expect(password.status).toBe(303);
    const session = await handler(new Request("http://localhost:3456/api/auth/session", { headers: { cookie: "backstage_session=forged.cookie" } }));
    expect(session.status).toBe(401);
    const run = await handler(new Request("http://localhost:3456/api/backstage/answer", { method: "POST", headers: { origin: "http://localhost:3456", "content-type": "application/json" }, body: JSON.stringify({ version: "backstage/2", revision: "test", catalogVersion: CATALOG_VERSION, armId: "jev", modelId: "jev-1.13.0", promptVersion: PROMPT_TEMPLATE_VERSION, runId: "run", caseId: "case", question: "Question?", choices: [{ name: "keep", definition: "Keep" }, { name: "cut", definition: "Cut" }], input: "Case", provider: "jev", key: "secret-test-key" }) }));
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ ok: false });
  } finally { handler.close(); }
});

test("[integration] L5 pre-dispatch rejections emit no run line", async () => {
  const lines: string[] = [];
  const input = { version: "backstage/2", revision: "test", catalogVersion: CATALOG_VERSION, armId: "jev", modelId: "jev-1.13.0", promptVersion: PROMPT_TEMPLATE_VERSION, runId: "run", caseId: "case", question: "Question?", choices: [{ name: "keep", definition: "Keep" }, { name: "cut", definition: "Cut" }], input: "Case", provider: "jev", key: "secret-test-key" };
  const request = (data: unknown, headers: Record<string, string> = {}) => new Request("http://localhost:3456/api/backstage/answer", { method: "POST", headers: { origin: "http://localhost:3456", "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
  const handler = createHandler({ version: "test", maxConcurrent: 0, log: (line) => lines.push(line) });
  try {
    expect((await handler(request(input, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await handler(request(input, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await handler(request(input))).status).toBe(503);
    expect(lines).toEqual([]);
  } finally { handler.close(); }
  const ordinary = createHandler({ version: "test", log: (line) => lines.push(line) });
  try {
    expect((await ordinary(request({ ...input, revision: "old" }))).status).toBe(409);
    expect((await ordinary(request(input, { "content-length": "65537" }))).status).toBe(413);
    expect((await ordinary(request({ ...input, modelId: "unlisted-model" }))).status).toBe(409);
    expect(lines).toEqual([]);
  } finally { ordinary.close(); }
});

test("[integration] L6 rejected sessions are emitted at most once per gated request", async () => {
  const lines: string[] = [];
  const handler = createHandler({ version: "test", requireSession: true, auth: { sessionSecret: "s".repeat(32) }, log: (line) => lines.push(line) });
  try {
    const response = await handler(new Request("http://localhost:3456/api/backstage/health", { headers: { cookie: "backstage_session=COOKIEMARK.forged" } }));
    expect(response.status).toBe(401);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ event: "session.rejected", email: "unknown", reason: "bad-signature" });
    expect(lines.join("")).not.toContain("COOKIEMARK");
  } finally { handler.close(); }
});

test("[integration] L7 rejected cookies preserve only a trusted operator and socket address", async () => {
  const directory = mkdtempSync(join(tmpdir(), "backstage-log-"));
  const path = join(directory, "operators.json");
  writeFileSync(path, "[]");
  const secret = "s".repeat(32);
  const lines: Record<string, unknown>[] = [];
  const handler = createHandler({ version: "test", trustProxy: true, log: (line) => lines.push(JSON.parse(line)), auth: { sessionSecret: secret, operatorsPath: path, clock: () => 1000 } });
  const request = (value: string | undefined, header = "203.0.113.8") => new Request("http://localhost:3456/api/auth/session", { headers: { ...(value === undefined ? {} : { cookie: value }), "x-backstage-client-ip": header } });
  const check = async (value: string | undefined, remoteAddress?: string, header?: string) => {
    const before = lines.length;
    await handler(request(value, header), remoteAddress === undefined ? undefined : { remoteAddress });
    return lines.slice(before);
  };
  try {
    expect(await check(undefined, "127.0.0.1")).toEqual([]);
    for (const value of ["backstage_session", "backstage_session=", "backstage_session=%not-valid"]) {
      expect(await check(value, "127.0.0.1")).toMatchObject([{ event: "session.rejected", email: "unknown", reason: "bad-signature" }]);
    }
    expect(await check("backstage_session=forged.cookie", "198.51.100.9", "203.0.113.8")).toMatchObject([{ ip: "198.51.100.9", email: "unknown" }]);
    expect(await check("backstage_session=forged.cookie")).toMatchObject([{ ip: "unknown", email: "unknown" }]);
    expect(await check("backstage_session=forged.cookie", "127.0.0.1", "not-an-ip")).toMatchObject([{ ip: "unknown", email: "unknown" }]);
    const cred = credentialFingerprint("removed-operator");
    const expired = signSession({ email: "removed@example.com", auth: "password", iat: 0, exp: 999, sid: "expired", cred }, secret);
    const revoked = signSession({ email: "removed@example.com", auth: "password", iat: 0, exp: 2000, sid: "revoked", cred }, secret);
    expect(await check(`backstage_session=${expired}`, "127.0.0.1")).toMatchObject([{ event: "session.rejected", email: "unknown", reason: "expired" }]);
    expect(await check(`backstage_session=${revoked}`, "127.0.0.1")).toMatchObject([{ event: "session.rejected", email: "unknown", reason: "revoked" }]);
  } finally { handler.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("[integration] L8 Google denials prefer bad state and never attribute unverified email", async () => {
  const directory = mkdtempSync(join(tmpdir(), "backstage-log-"));
  const path = join(directory, "operators.json");
  writeFileSync(path, JSON.stringify([{ email: "operator@example.com" }]));
  const lines: Record<string, unknown>[] = [];
  let profileEmail = "operator@example.com";
  const handler = createHandler({ version: "test", log: (line) => lines.push(JSON.parse(line)), auth: { sessionSecret: "s".repeat(32), operatorsPath: path, googleClientId: "client", googleClientSecret: "secret", clock: () => 1000, fetch: async (input) => String(input).endsWith("/token") ? Response.json({ id_token: "token" }) : Response.json({ email: profileEmail, email_verified: false, aud: "client", iss: "accounts.google.com" }) } });
  const callback = (query: string, nonce = "") => new Request(`http://localhost:3456/api/auth/google/callback?${query}`, { headers: { cookie: `backstage_oauth=${nonce}` } });
  try {
    await handler(callback("state=bad&error=access_denied"));
    expect(lines.splice(0)).toMatchObject([{ event: "signin.google.denied", email: "unknown", reason: "bad-state" }]);
    const missingCodeStart = await handler(new Request("http://localhost:3456/api/auth/google"));
    const missingCodeState = new URL(missingCodeStart.headers.get("location") ?? "http://localhost/").searchParams.get("state") ?? "";
    const missingCodeNonce = missingCodeStart.headers.get("set-cookie")?.split(";")[0]?.split("=")[1] ?? "";
    await handler(callback(`state=${encodeURIComponent(missingCodeState)}`, missingCodeNonce));
    expect(lines.splice(0)).toMatchObject([{ event: "signin.google.denied", email: "unknown", reason: "bad-state" }]);
    for (const email of ["operator@example.com", "absent@example.com"]) {
      profileEmail = email;
      const start = await handler(new Request("http://localhost:3456/api/auth/google"));
      const state = new URL(start.headers.get("location") ?? "http://localhost/").searchParams.get("state") ?? "";
      const nonce = start.headers.get("set-cookie")?.split(";")[0]?.split("=")[1] ?? "";
      await handler(callback(`state=${encodeURIComponent(state)}&code=code`, nonce));
      expect(lines.splice(0)).toMatchObject([{ event: "signin.google.denied", email: "unknown", reason: "unverified-email" }]);
    }
  } finally { handler.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("[integration] L9 busy password paths do not print an unlisted email", async () => {
  const lines: Record<string, unknown>[] = [];
  const handler = createHandler({ version: "test", log: (line) => lines.push(JSON.parse(line)), auth: { sessionSecret: "s".repeat(32) } });
  const request = () => new Request("http://localhost:3456/api/auth/password", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=busy-absent%40example.com&password=wrong" });
  try {
    const responses = await Promise.all(Array.from({ length: 16 }, () => handler(request())));
    expect(responses.some((response) => response.headers.get("location") === "/backstage/sign-in?error=busy")).toBe(true);
    expect(lines.every((line) => line.email === "unknown")).toBe(true);
    lines.length = 0;
    const original = LoginLimiter.prototype.canAttempt;
    LoginLimiter.prototype.canAttempt = () => false;
    try {
      const response = await handler(request());
      expect(response.headers.get("location")).toBe("/backstage/sign-in?error=busy");
      expect(lines).toMatchObject([{ event: "signin.password.fail", email: "unknown" }]);
    } finally { LoginLimiter.prototype.canAttempt = original; }
  } finally { handler.close(); }
});
