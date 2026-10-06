import { expect, test } from "bun:test";
import { createHandler } from "./server.ts";
import { cookieName, credentialFingerprint, signSession } from "./auth.ts";
import { createHash, createHmac, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = "http://localhost:8787";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "backstage-auth-"));
  const path = join(directory, "operators.json");
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync("correct-password", salt, 64).toString("hex")}`;
  writeFileSync(path, JSON.stringify([{ email: "a@example.com", password_hash: passwordHash }, { email: "google@example.com" }]));
  return { path, passwordHash, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function form(email: string, password: string, next = "/backstage/"): Request {
  return new Request(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password, next }) });
}
function addressedForm(email: string, password: string, address: string): Request {
  const request = form(email, password);
  request.headers.set("x-backstage-client-ip", address);
  return request;
}
function sessionRequest(path: string, value?: string): Request {
  return new Request(`${ORIGIN}${path}`, value ? { headers: { cookie: `backstage_session=${value}` } } : undefined);
}
function responseCookie(response: Response, name: string): string {
  return response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1) ?? "";
}

test("[integration] AR1 configured auth gates page and API without Basic challenge", async () => {
  const handler = createHandler({ version: "test", origin: "http://localhost:8787", requireSession: true, auth: { sessionSecret: "s".repeat(32) } });
  const page = await handler(new Request("http://localhost:8787/backstage/"));
  expect(page.status).toBe(302);
  expect(page.headers.get("location")).toBe("/backstage/sign-in?next=/backstage/");
  const api = await handler(new Request("http://localhost:8787/api/backstage/health"));
  expect(api.status).toBe(401);
  expect(await api.text()).toBe('{"code":"unauthenticated"}');
  expect(api.headers.has("www-authenticate")).toBe(false);
  expect(await (await handler(new Request(`${ORIGIN}/api/auth/session`))).text()).toBe('{"code":"unauthenticated","signIn":"ready"}');
});

test("[integration] AR1 rollout switch and decoded path rejection", async () => {
  const withoutGate = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: "s".repeat(32) } });
  expect((await withoutGate(new Request(`${ORIGIN}/api/backstage/health`))).status).toBe(200);
  withoutGate.close();
  const gate = createHandler({ version: "test", origin: ORIGIN, requireSession: true, auth: { sessionSecret: "short" } });
  expect(await (await gate(new Request(`${ORIGIN}/api/auth/session`))).text()).toBe('{"code":"unauthenticated","signIn":"unconfigured"}');
  expect((await gate(new Request(`${ORIGIN}/backstage/`))).status).toBe(302);
  expect((await gate(new Request(`${ORIGIN}/api/backstage/health`))).status).toBe(401);
  const cases: readonly (readonly [string, number])[] = [["/%62ackstage/", 302], ["/%62ackstage/index.html", 302], ["//backstage/", 404], ["/backstage/./x", 302], ["/backstage/%2e%2e/x", 404], ["/api/%62ackstage/health", 401], ["/api/auth/..\\..\\%62ackstage/", 302]];
  for (const [path, status] of cases) {
    const response = await gate(new Request(`${ORIGIN}${path}`));
    expect(response.status).toBe(status);
    if (status === 302) expect(response.headers.get("location")).toStartWith("/backstage/sign-in?next=");
  }
  gate.close();
});

test("[integration] AR12 nginx header enables the app gate during the rollout", async () => {
  const handler = createHandler({ version: "test", origin: ORIGIN, staticRoot: "site", auth: { sessionSecret: randomBytes(32).toString("hex") } });
  try {
    expect((await handler(sessionRequest("/api/backstage/health"))).status).toBe(200);
    expect((await handler(new Request(`${ORIGIN}/api/backstage/health`, { headers: { "x-backstage-gate": "other" } }))).status).toBe(200);
    expect((await handler(new Request(`${ORIGIN}/api/backstage/health`, { headers: { "x-backstage-gate": "session" } }))).status).toBe(401);
    expect((await handler(new Request(`${ORIGIN}/backstage/`, { headers: { "x-backstage-gate": "session" } }))).status).toBe(302);
  } finally { handler.close(); }
});

test("[integration] AR13 mixed case Backstage aliases are 404 before static routing", async () => {
  const handler = createHandler({ version: "test", origin: ORIGIN, staticRoot: "site", requireSession: true, auth: { sessionSecret: randomBytes(32).toString("hex") } });
  try {
    for (const path of ["/Backstage/index.html", "/BACKSTAGE/", "/API/backstage/health", "/api/Backstage/health"])
      expect((await handler(sessionRequest(path))).status).toBe(404);
  } finally { handler.close(); }
});

test("[integration] AR14 a failed revocation write returns JSON failure and keeps the cookie refused", async () => {
  const data = fixture();
  const secret = randomBytes(32).toString("hex");
  const handler = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: secret, operatorsPath: data.path } });
  try {
    const value = signSession({ email: "a@example.com", auth: "password", iat: 1000, exp: Date.now() + 60_000, sid: randomBytes(24).toString("hex"), cred: credentialFingerprint(data.passwordHash) }, secret);
    mkdirSync(join(data.path, "..", "revoked-sessions.json"));
    const response = await handler(new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { cookie: `backstage_session=${value}` } }));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"code":"signout-failed"}');
    expect(response.headers.has("location")).toBe(false);
    expect((await handler(sessionRequest("/api/auth/session", value))).status).toBe(401);
  } finally { handler.close(); data.cleanup(); }
});

test("[integration] AR15 corrupt revocation state refuses old sessions and logs once", async () => {
  const data = fixture();
  const secret = randomBytes(32).toString("hex");
  const warnings: string[] = [];
  const original = console.warn;
  writeFileSync(join(data.path, "..", "revoked-sessions.json"), "{");
  console.warn = (message: string) => { warnings.push(message); };
  let now = 1000;
  const handler = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: secret, operatorsPath: data.path, clock: () => now } });
  try {
    const cred = credentialFingerprint(data.passwordHash);
    const old = signSession({ email: "a@example.com", auth: "password", iat: 999, exp: 2000, sid: "old", cred }, secret);
    const fresh = signSession({ email: "a@example.com", auth: "password", iat: 1000, exp: 2000, sid: "fresh", cred }, secret);
    expect((await handler(sessionRequest("/api/auth/session", old))).status).toBe(401);
    expect((await handler(sessionRequest("/api/auth/session", fresh))).status).toBe(204);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(secret);
    now = 1001;
  } finally { handler.close(); console.warn = original; data.cleanup(); }
});

test("[integration] AR2 session matrix checks signature, expiry, revocation and operator removal", async () => {
  const data = fixture();
  let now = 1000;
  const secret = randomBytes(32).toString("hex");
  const handler = createHandler({ version: "test", origin: ORIGIN, staticRoot: "site", requireSession: true, auth: { sessionSecret: secret, operatorsPath: data.path, clock: () => now } });
  try {
    const cred = credentialFingerprint(data.passwordHash);
    const valid = signSession({ email: "a@example.com", auth: "password", iat: 1000, exp: 2000, sid: "good", cred }, secret);
    expect((await handler(sessionRequest("/api/auth/session", valid))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", valid))).status).toBe(200);
    expect((await handler(sessionRequest("/api/backstage/health", valid))).status).toBe(200);
    const invalidJson = Buffer.from("not json").toString("base64url");
    const invalidJsonSignature = createHmac("sha256", secret).update(invalidJson).digest("base64url");
    for (const bad of [undefined, "nodot", "%broken", `${invalidJson}.${invalidJsonSignature}`, valid.slice(0, -1) + "x", `${Buffer.from(JSON.stringify({ email: "other@example.com", auth: "password", iat: 1000, exp: 2000, sid: "good", cred })).toString("base64url")}.${valid.split(".")[1]}`, signSession({ email: "a@example.com", auth: "password", iat: 1000, exp: 2000, sid: "wrong-secret", cred }, "wrong"), signSession({ email: "a@example.com", auth: "password", iat: 0, exp: 999, sid: "expired", cred }, secret)]) {
      expect((await handler(sessionRequest("/api/auth/session", bad))).status).toBe(401);
      expect((await handler(sessionRequest("/backstage/", bad))).status).toBe(302);
      const api = await handler(sessionRequest("/api/backstage/health", bad));
      expect(api.status).toBe(401);
      expect(api.headers.has("www-authenticate")).toBe(false);
    }
    const signedOut = await handler(new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { cookie: `backstage_session=${valid}` } }));
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await handler(sessionRequest("/api/auth/session", valid))).status).toBe(401);
    expect((await handler(sessionRequest("/backstage/", valid))).status).toBe(302);
    expect((await handler(sessionRequest("/api/backstage/health", valid))).status).toBe(401);
    const restarted = createHandler({ version: "test", origin: ORIGIN, requireSession: true, auth: { sessionSecret: secret, operatorsPath: data.path, clock: () => now } });
    expect((await restarted(sessionRequest("/api/auth/session", valid))).status).toBe(401);
    expect((await restarted(sessionRequest("/backstage/", valid))).status).toBe(302);
    expect((await restarted(sessionRequest("/api/backstage/health", valid))).status).toBe(401);
    restarted.close();
    const another = signSession({ email: "a@example.com", auth: "password", iat: 1000, exp: 2000, sid: "other", cred }, secret);
    writeFileSync(data.path, JSON.stringify([{ email: "a@example.com", password_hash: "scrypt$" + "0".repeat(32) + "$" + "0".repeat(128) }]));
    expect((await handler(sessionRequest("/api/auth/session", another))).status).toBe(401);
    expect((await handler(sessionRequest("/backstage/", another))).status).toBe(302);
    expect((await handler(sessionRequest("/api/backstage/health", another))).status).toBe(401);
    writeFileSync(data.path, "[]");
    expect((await handler(sessionRequest("/api/auth/session", another))).status).toBe(401);
    expect((await handler(sessionRequest("/backstage/", another))).status).toBe(302);
    expect((await handler(sessionRequest("/api/backstage/health", another))).status).toBe(401);
    now = 2000;
  } finally { data.cleanup(); handler.close(); }
});

test("[integration] AR10 without proxy trust public socket addresses share no lock bucket", async () => {
  const data = fixture();
  const handler = createHandler({ version: "test", origin: ORIGIN, requireSession: true, auth: { sessionSecret: "s".repeat(32), operatorsPath: data.path } });
  try {
    for (let index = 0; index < 20; index++) await handler(form(`missing${index}@example.com`, "wrong"), { remoteAddress: "203.0.113.10" });
    const response = await handler(form("a@example.com", "correct-password"), { remoteAddress: "203.0.113.10" });
    expect(response.headers.get("location")).toBe("/backstage/");
    const value = responseCookie(response, "backstage_session");
    expect((await handler(sessionRequest("/api/auth/session", value))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", value))).status).toBe(200);
  } finally { data.cleanup(); handler.close(); }
});

test("[integration] AR11 ninth concurrent scrypt returns busy without a failure", async () => {
  const data = fixture();
  const handler = createHandler({ version: "test", origin: ORIGIN, requireSession: true, auth: { sessionSecret: "s".repeat(32), operatorsPath: data.path } });
  try {
    for (let index = 0; index < 99; index++) expect((await handler(form("a@example.com", "wrong"))).headers.get("location")).toBe("/backstage/sign-in?error=signin");
    const responses = await Promise.all(Array.from({ length: 9 }, () => handler(form("a@example.com", "correct-password"))));
    expect(responses.filter((response) => response.headers.get("location") === "/backstage/sign-in?error=busy")).toHaveLength(1);
    const minted = responses.find((response) => response.headers.get("location") === "/backstage/");
    expect(minted).toBeDefined();
    const value = minted ? responseCookie(minted, "backstage_session") : "";
    expect((await handler(sessionRequest("/api/auth/session", value))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", value))).status).toBe(200);
    const later = await handler(form("a@example.com", "correct-password"));
    expect(later.headers.get("location")).toBe("/backstage/");
  } finally { data.cleanup(); handler.close(); }
});

test("[integration] AR3 password responses, cookie, Basic, CSRF and lockout", async () => {
  const data = fixture();
  const secret = randomBytes(32).toString("hex");
  const handler = createHandler({ version: "test", origin: ORIGIN, requireSession: true, trustProxy: true, auth: { sessionSecret: secret, operatorsPath: data.path } });
  try {
    const success = await handler(form(" A@Example.com ", "correct-password", "/backstage/x/y"));
    expect(success.status).toBe(303);
    expect(success.headers.get("location")).toBe("/backstage/x/y");
    expect(success.headers.get("set-cookie")).toStartWith("backstage_session=");
    expect(success.headers.get("set-cookie")).toContain("Path=/; HttpOnly; SameSite=Lax; Max-Age=43200");
    const cookieValue = success.headers.get("set-cookie")?.split(";")[0]?.split("=")[1] ?? "";
    expect((await handler(sessionRequest("/api/auth/session", cookieValue))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", cookieValue))).status).toBe(200);
    const failures = [form("a@example.com", "wrong"), form("missing@example.com", "wrong"), form("google@example.com", "wrong"), form("", "")];
    const outputs = [];
    for (const request of failures) { const response = await handler(request); outputs.push(`${response.status}:${response.headers.get("location")}:${await response.text()}`); }
    expect(new Set(outputs).size).toBe(1);
    writeFileSync(data.path, JSON.stringify([{ email: "a@example.com", password_hash: "$apr1$abc" }]));
    expect((await handler(form("a@example.com", "correct-password"))).headers.get("location")).toBe("/backstage/sign-in?error=signin");
    writeFileSync(data.path, JSON.stringify([{ email: "a@example.com", password_hash: "$2y$abc" }]));
    expect((await handler(form("a@example.com", "correct-password"))).headers.get("location")).toBe("/backstage/sign-in?error=signin");
    writeFileSync(data.path, JSON.stringify([{ email: "a@example.com", password_hash: data.passwordHash }]));
    const basic = Buffer.from("a@example.com:correct-password").toString("base64");
    const minted = await handler(new Request(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { authorization: `Basic ${basic}` } }));
    expect(minted.status).toBe(303);
    expect(minted.headers.get("location")).toBe("/backstage/");
    const mintedCookie = responseCookie(minted, "backstage_session");
    expect((await handler(sessionRequest("/api/auth/session", mintedCookie))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", mintedCookie))).status).toBe(200);
    expect((await handler(new Request(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { "sec-fetch-site": "cross-site", authorization: `Basic ${basic}` } }))).status).toBe(403);
    expect((await handler(new Request(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { origin: "https://evil.test", authorization: `Basic ${basic}` } }))).status).toBe(403);
    for (let index = 0; index < 5; index++) await handler(addressedForm("a@example.com", "wrong", "203.0.113.1"), { remoteAddress: "127.0.0.1" });
    const lockedKnown = await handler(addressedForm("a@example.com", "correct-password", "203.0.113.1"), { remoteAddress: "127.0.0.1" });
    expect(lockedKnown.headers.get("location")).toBe("/backstage/sign-in?error=locked");
    for (let index = 0; index < 5; index++) await handler(addressedForm("absent@example.com", "wrong", "203.0.113.4"), { remoteAddress: "127.0.0.1" });
    const lockedUnknown = await handler(addressedForm("absent@example.com", "wrong", "203.0.113.4"), { remoteAddress: "127.0.0.1" });
    expect(`${lockedUnknown.status}:${lockedUnknown.headers.get("location")}:${await lockedUnknown.text()}`).toBe(`${lockedKnown.status}:${lockedKnown.headers.get("location")}:${await lockedKnown.text()}`);
    const otherAddress = await handler(addressedForm("a@example.com", "correct-password", "203.0.113.2"), { remoteAddress: "127.0.0.1" });
    expect(otherAddress.headers.get("location")).toBe("/backstage/");
    const otherCookie = responseCookie(otherAddress, "backstage_session");
    expect((await handler(sessionRequest("/api/auth/session", otherCookie))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", otherCookie))).status).toBe(200);
    expect((await handler(new Request(`${ORIGIN}/api/auth/sign-out`))).status).toBe(405);
    const crossSiteSignOut = await handler(new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { "sec-fetch-site": "cross-site", cookie: `backstage_session=${cookieValue}` } }));
    expect(crossSiteSignOut.status).toBe(403);
  } finally { data.cleanup(); handler.close(); }
});

test("[integration] AR4 Google start and callback validates profile and state", async () => {
  const data = fixture();
  const secret = randomBytes(32).toString("hex");
  const calls: string[] = [];
  let profile: unknown = { email: "google@example.com", email_verified: "true", aud: "client", iss: "https://accounts.google.com" };
  let tokenStatus = 200;
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(String(input));
    expect(init?.signal).toBeDefined();
    if (String(input).endsWith("/token")) return Response.json({ id_token: "id-token" }, { status: tokenStatus });
    return Response.json(profile);
  };
  const handler = createHandler({ version: "test", origin: ORIGIN, requireSession: true, auth: { sessionSecret: secret, operatorsPath: data.path, googleClientId: "client", googleClientSecret: "secret", fetch: fakeFetch } });
  const start = async () => {
    const response = await handler(new Request(`http://evil.test/api/auth/google?next=/backstage/x`, { headers: { host: "evil.test", "x-forwarded-host": "evil.test" } }));
    const target = new URL(response.headers.get("location") ?? "https://example.com");
    const state = target.searchParams.get("state") ?? "";
    return { response, target, state, cookie: `${cookieName(ORIGIN, "oauth")}=${responseCookie(response, cookieName(ORIGIN, "oauth"))}` };
  };
  try {
    const started = await start();
    expect(started.response.status).toBe(302);
    expect(started.target.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(started.response.headers.get("set-cookie")).toContain("Max-Age=600");
    expect((await handler(new Request(`${ORIGIN}/api/auth/google/callback?state=${started.state}&code=code`))).headers.get("location")).toBe("/backstage/sign-in?error=google");
    const good = await start();
    const callback = await handler(new Request(`${ORIGIN}/api/auth/google/callback?state=${good.state}&code=code`, { headers: { cookie: good.cookie } }));
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/backstage/x");
    expect(callback.headers.getSetCookie().length).toBe(2);
    expect(callback.headers.getSetCookie().join(" ")).toContain("Max-Age=0");
    const googleCookie = responseCookie(callback, "backstage_session");
    expect((await handler(sessionRequest("/api/auth/session", googleCookie))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", googleCookie))).status).toBe(200);
    expect(calls[0]).toBe("https://oauth2.googleapis.com/token");
    expect(calls[1]).toContain("https://oauth2.googleapis.com/tokeninfo?id_token=id-token");
    for (const invalid of [
      { email: "google@example.com", email_verified: false, aud: "client", iss: "https://accounts.google.com" },
      { email: "google@example.com", email_verified: "false", aud: "client", iss: "https://accounts.google.com" },
      { email: "google@example.com", email_verified: true, aud: "wrong", iss: "https://accounts.google.com" },
      { email: "google@example.com", email_verified: true, aud: "client", iss: "evil" },
      { email: "absent@example.com", email_verified: true, aud: "client", iss: "https://accounts.google.com" },
    ]) {
      profile = invalid;
      const next = await start();
      expect((await handler(new Request(`${ORIGIN}/api/auth/google/callback?state=${next.state}&code=code`, { headers: { cookie: next.cookie } }))).headers.get("location")).toBe("/backstage/sign-in?error=google");
    }
    tokenStatus = 500;
    const failed = await start();
    expect((await handler(new Request(`${ORIGIN}/api/auth/google/callback?state=${failed.state}&code=code`, { headers: { cookie: failed.cookie } }))).headers.get("location")).toBe("/backstage/sign-in?error=google");
  } finally { data.cleanup(); handler.close(); }
});

test("[integration] AR5 sign-in page is standalone and sanitizes next and messages", async () => {
  const handler = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: "s".repeat(32) } });
  for (const { query, message } of [{ query: "signed-out=1", message: "You are signed out" }, { query: "error=signin", message: "Sign-in failed" }, { query: "error=locked", message: "Too many attempts" }, { query: "error=busy", message: "Sign-in is busy" }, { query: "error=google", message: "Google sign-in failed" }]) {
    const response = await handler(new Request(`${ORIGIN}/backstage/sign-in?${query}&next=%2Fbackstage%2F..%2F%3Cscript%3E`));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(message);
    expect(html).toContain('action="/api/auth/password" method="post"');
    expect(html).toContain('name="next" value="/backstage/"');
    expect(html).toContain("Google sign-in is not configured.");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    expect(response.headers.get("content-security-policy")).toMatch(/style-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(response.headers.get("content-security-policy")).toContain(`'sha256-${createHash("sha256").update(style).digest("base64")}'`);
  }
  handler.close();
});

test("[integration] AR6 short secret fails closed and HTTPS cookie is host only", async () => {
  const data = fixture();
  try {
    const short = createHandler({ version: "test", origin: ORIGIN, requireSession: true, auth: { sessionSecret: "short", operatorsPath: data.path } });
    expect((await short(sessionRequest("/api/auth/session"))).status).toBe(401);
    expect((await short(sessionRequest("/backstage/"))).status).toBe(302);
    expect((await short(sessionRequest("/api/backstage/health"))).status).toBe(401);
    short.close();
    const absent = createHandler({ version: "test", origin: ORIGIN, requireSession: true, auth: { operatorsPath: data.path } });
    expect((await absent(sessionRequest("/api/backstage/health"))).status).toBe(401);
    absent.close();
    const secureOrigin = "https://backstage.example.test";
    const secure = createHandler({ version: "test", origin: secureOrigin, requireSession: true, auth: { sessionSecret: "s".repeat(32), operatorsPath: data.path } });
    const response = await secure(new Request(`${secureOrigin}/api/auth/password`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "a@example.com", password: "correct-password" }) }));
    expect(response.headers.get("location")).toBe("/backstage/");
    expect(response.headers.get("set-cookie")).toStartWith("__Host-backstage_session=");
    expect(response.headers.get("set-cookie")).toContain("; Secure;");
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
    const secureCookie = `__Host-backstage_session=${responseCookie(response, "__Host-backstage_session")}`;
    expect((await secure(new Request(`${secureOrigin}/api/auth/session`, { headers: { cookie: secureCookie } }))).status).toBe(204);
    expect((await secure(new Request(`${secureOrigin}/backstage/`, { headers: { cookie: secureCookie } }))).status).toBe(200);
    secure.close();
  } finally { data.cleanup(); }
});

test("[integration] AR7 client address lock crosses emails and success clears email failures", async () => {
  const data = fixture();
  let now = 0;
  const handler = createHandler({ version: "test", origin: ORIGIN, trustProxy: true, auth: { sessionSecret: "s".repeat(32), operatorsPath: data.path, clock: () => now } });
  const context = { remoteAddress: "127.0.0.1" };
  const withAddress = (email: string, password: string, address: string) => new Request(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-backstage-client-ip": address }, body: new URLSearchParams({ email, password }) });
  try {
    for (let index = 0; index < 4; index++) await handler(withAddress("a@example.com", "wrong", "10.0.0.1"), context);
    const firstSuccess = await handler(withAddress("a@example.com", "correct-password", "10.0.0.1"), context);
    expect(firstSuccess.status).toBe(303);
    expect(firstSuccess.headers.get("location")).toBe("/backstage/");
    const firstCookie = responseCookie(firstSuccess, "backstage_session");
    expect((await handler(sessionRequest("/api/auth/session", firstCookie))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", firstCookie))).status).toBe(200);
    for (let index = 0; index < 4; index++) await handler(withAddress("a@example.com", "wrong", "10.0.0.1"), context);
    const resetSuccess = await handler(withAddress("a@example.com", "correct-password", "10.0.0.1"), context);
    expect(resetSuccess.headers.get("location")).toBe("/backstage/");
    const resetCookie = responseCookie(resetSuccess, "backstage_session");
    expect((await handler(sessionRequest("/api/auth/session", resetCookie))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", resetCookie))).status).toBe(200);
    for (let index = 0; index < 20; index++) await handler(withAddress(`unknown${index}@example.com`, "wrong", "10.0.0.2"), context);
    expect((await handler(withAddress("a@example.com", "correct-password", "10.0.0.2"), context)).headers.get("location")).toBe("/backstage/sign-in?error=locked");
    now = 60_000;
    const unlocked = await handler(withAddress("a@example.com", "correct-password", "10.0.0.2"), context);
    expect(unlocked.headers.get("location")).toBe("/backstage/");
    const unlockedCookie = responseCookie(unlocked, "backstage_session");
    expect((await handler(sessionRequest("/api/auth/session", unlockedCookie))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", unlockedCookie))).status).toBe(200);
  } finally { data.cleanup(); handler.close(); }
});

test("[integration] AR8 Google callback rejects state and exchange failures without details", async () => {
  const data = fixture();
  let now = 0;
  let mode = "ok";
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).endsWith("/token")) return mode === "token-error" ? new Response("secret exception detail", { status: 503 }) : Response.json(mode === "no-id" ? {} : { id_token: "id-token" });
    return mode === "info-error" ? new Response("secret exception detail", { status: 503 }) : Response.json({ email: "google@example.com", email_verified: true, aud: "client", iss: "accounts.google.com" });
  };
  const handler = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: "s".repeat(32), operatorsPath: data.path, googleClientId: "client", googleClientSecret: "secret", googleFetch: fakeFetch, clock: () => now } });
  const start = async () => {
    const response = await handler(new Request(`${ORIGIN}/api/auth/google`));
    return { state: new URL(response.headers.get("location") ?? "https://example.com").searchParams.get("state") ?? "", nonce: responseCookie(response, "backstage_oauth") };
  };
  const callback = async (state: string, cookieState: string, extra = "&code=code") => handler(new Request(`${ORIGIN}/api/auth/google/callback?state=${state}${extra}`, { headers: { cookie: `backstage_oauth=${cookieState}` } }));
  try {
    expect((await callback("missing", "missing")).headers.get("location")).toBe("/backstage/sign-in?error=google");
    const mismatch = await start();
    expect((await callback(mismatch.state, "wrong")).headers.get("location")).toBe("/backstage/sign-in?error=google");
    expect((await callback(mismatch.state + "x", mismatch.nonce)).headers.get("location")).toBe("/backstage/sign-in?error=google");
    expect((await handler(new Request(`${ORIGIN}/api/auth/google/callback?code=code`, { headers: { cookie: `backstage_oauth=${mismatch.nonce}` } }))).headers.get("location")).toBe("/backstage/sign-in?error=google");
    const errorState = await start();
    expect((await callback(errorState.state, errorState.nonce, "&error=access_denied")).headers.get("location")).toBe("/backstage/sign-in?error=google");
    const expired = await start();
    now = 600_000;
    expect((await callback(expired.state, expired.nonce)).headers.get("location")).toBe("/backstage/sign-in?error=google");
    for (const failure of ["token-error", "no-id", "info-error"]) {
      mode = failure;
      const state = await start();
      const response = await callback(state.state, state.nonce);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/backstage/sign-in?error=google");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(await response.text()).not.toContain("secret exception detail");
    }
  } finally { data.cleanup(); handler.close(); }
});

test("[integration] AR9 Google unavailable and anonymous start flood has no cap", async () => {
  const noGoogle = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: "s".repeat(32) } });
  expect((await noGoogle(new Request(`${ORIGIN}/api/auth/google`))).status).toBe(503);
  noGoogle.close();
  const handler = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: "s".repeat(32), googleClientId: "client", googleClientSecret: "secret" } });
  for (let index = 0; index < 5000; index++) expect((await handler(new Request(`${ORIGIN}/api/auth/google`))).status).toBe(302);
  expect((await handler(new Request(`${ORIGIN}/api/auth/google`))).status).toBe(302);
  handler.close();
});
