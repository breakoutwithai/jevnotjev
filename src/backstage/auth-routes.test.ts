import { expect, test } from "bun:test";
import { createHandler } from "./server.ts";
import { cookieName, signSession } from "./auth.ts";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
function sessionRequest(path: string, value?: string): Request {
  return new Request(`${ORIGIN}${path}`, value ? { headers: { cookie: `backstage_session=${value}` } } : undefined);
}

test("[integration] AR1 configured auth gates page and API without Basic challenge", async () => {
  const handler = createHandler({ version: "test", origin: "http://localhost:8787", auth: { sessionSecret: "s".repeat(32) } });
  const page = await handler(new Request("http://localhost:8787/backstage/"));
  expect(page.status).toBe(302);
  expect(page.headers.get("location")).toBe("/backstage/sign-in?next=/backstage/");
  const api = await handler(new Request("http://localhost:8787/api/backstage/health"));
  expect(api.status).toBe(401);
  expect(await api.text()).toBe('{"code":"unauthenticated"}');
  expect(api.headers.has("www-authenticate")).toBe(false);
});

test("[integration] AR2 session matrix checks signature, expiry, revocation and operator removal", async () => {
  const data = fixture();
  let now = 1000;
  const secret = randomBytes(32).toString("hex");
  const handler = createHandler({ version: "test", origin: ORIGIN, staticRoot: "site", auth: { sessionSecret: secret, operatorsPath: data.path, clock: () => now } });
  try {
    const valid = signSession({ email: "a@example.com", auth: "password", iat: 1000, exp: 2000, sid: "good" }, secret);
    expect((await handler(sessionRequest("/api/auth/session", valid))).status).toBe(204);
    expect((await handler(sessionRequest("/backstage/", valid))).status).toBe(200);
    expect((await handler(sessionRequest("/api/backstage/health", valid))).status).toBe(200);
    for (const bad of [undefined, "nodot", "%broken", valid.slice(0, -1) + "x", signSession({ email: "a@example.com", auth: "password", iat: 1000, exp: 2000, sid: "wrong-secret" }, "wrong"), signSession({ email: "a@example.com", auth: "password", iat: 0, exp: 999, sid: "expired" }, secret)]) {
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
    const another = signSession({ email: "a@example.com", auth: "password", iat: 1000, exp: 2000, sid: "other" }, secret);
    writeFileSync(data.path, "[]");
    expect((await handler(sessionRequest("/api/auth/session", another))).status).toBe(401);
    now = 2000;
  } finally { data.cleanup(); handler.close(); }
});

test("[integration] AR3 password responses, cookie, Basic, CSRF and lockout", async () => {
  const data = fixture();
  const secret = randomBytes(32).toString("hex");
  const handler = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: secret, operatorsPath: data.path } });
  try {
    const success = await handler(form(" A@Example.com ", "correct-password", "/backstage/x/y"));
    expect(success.status).toBe(303);
    expect(success.headers.get("location")).toBe("/backstage/x/y");
    expect(success.headers.get("set-cookie")).toStartWith("backstage_session=");
    expect(success.headers.get("set-cookie")).toContain("Path=/; HttpOnly; SameSite=Lax; Max-Age=43200");
    const cookieValue = success.headers.get("set-cookie")?.split(";")[0]?.split("=")[1] ?? "";
    expect((await handler(sessionRequest("/api/auth/session", cookieValue))).status).toBe(204);
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
    expect((await handler(new Request(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { authorization: `Basic ${basic}` } }))).status).toBe(303);
    expect((await handler(new Request(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { "sec-fetch-site": "cross-site", authorization: `Basic ${basic}` } }))).status).toBe(403);
    expect((await handler(new Request(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { origin: "https://evil.test", authorization: `Basic ${basic}` } }))).status).toBe(403);
    for (let index = 0; index < 5; index++) await handler(form("lock@example.com", "wrong"));
    expect((await handler(form("lock@example.com", "correct-password"))).headers.get("location")).toBe("/backstage/sign-in?error=locked");
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
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    if (String(input).endsWith("/token")) return Response.json({ id_token: "id-token" }, { status: tokenStatus });
    return Response.json(profile);
  };
  const handler = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: secret, operatorsPath: data.path, googleClientId: "client", googleClientSecret: "secret", fetch: fakeFetch } });
  const start = async () => {
    const response = await handler(new Request(`${ORIGIN}/api/auth/google?next=/backstage/x`, { headers: { host: "evil.test", "x-forwarded-host": "evil.test" } }));
    const target = new URL(response.headers.get("location") ?? "https://example.com");
    const state = target.searchParams.get("state") ?? "";
    return { response, target, state, cookie: `${cookieName(ORIGIN, "oauth")}=${state}` };
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
    expect((await handler(new Request(`${ORIGIN}/api/auth/google/callback?state=${good.state}&code=code`, { headers: { cookie: good.cookie } }))).headers.get("location")).toBe("/backstage/sign-in?error=google");
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
  for (const { query, message } of [{ query: "signed-out=1", message: "You are signed out" }, { query: "error=signin", message: "Sign-in failed" }, { query: "error=locked", message: "Too many attempts" }, { query: "error=google", message: "Google sign-in failed" }]) {
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
    const short = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: "short", operatorsPath: data.path } });
    expect((await short(sessionRequest("/api/auth/session"))).status).toBe(401);
    expect((await short(sessionRequest("/backstage/"))).status).toBe(302);
    expect((await short(sessionRequest("/api/backstage/health"))).status).toBe(401);
    short.close();
    const absent = createHandler({ version: "test", origin: ORIGIN, auth: { operatorsPath: data.path } });
    expect((await absent(sessionRequest("/api/backstage/health"))).status).toBe(401);
    absent.close();
    const secureOrigin = "https://backstage.example.test";
    const secure = createHandler({ version: "test", origin: secureOrigin, auth: { sessionSecret: "s".repeat(32), operatorsPath: data.path } });
    const response = await secure(new Request(`${secureOrigin}/api/auth/password`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "a@example.com", password: "correct-password" }) }));
    expect(response.headers.get("set-cookie")).toStartWith("__Host-backstage_session=");
    expect(response.headers.get("set-cookie")).toContain("; Secure;");
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
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
    expect((await handler(withAddress("a@example.com", "correct-password", "10.0.0.1"), context)).status).toBe(303);
    expect((await handler(withAddress("a@example.com", "correct-password", "10.0.0.1"), context)).headers.get("location")).toBe("/backstage/");
    for (let index = 0; index < 20; index++) await handler(withAddress(`unknown${index}@example.com`, "wrong", "10.0.0.2"), context);
    expect((await handler(withAddress("a@example.com", "correct-password", "10.0.0.2"), context)).headers.get("location")).toBe("/backstage/sign-in?error=locked");
    now = 60_000;
    expect((await handler(withAddress("a@example.com", "correct-password", "10.0.0.2"), context)).status).toBe(303);
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
    return new URL(response.headers.get("location") ?? "https://example.com").searchParams.get("state") ?? "";
  };
  const callback = async (state: string, cookieState: string, extra = "&code=code") => handler(new Request(`${ORIGIN}/api/auth/google/callback?state=${state}${extra}`, { headers: { cookie: `backstage_oauth=${cookieState}` } }));
  try {
    expect((await callback("missing", "missing")).headers.get("location")).toBe("/backstage/sign-in?error=google");
    const mismatch = await start();
    expect((await callback(mismatch, "wrong")).headers.get("location")).toBe("/backstage/sign-in?error=google");
    const errorState = await start();
    expect((await callback(errorState, errorState, "&error=access_denied")).headers.get("location")).toBe("/backstage/sign-in?error=google");
    const expired = await start();
    now = 600_000;
    expect((await callback(expired, expired)).headers.get("location")).toBe("/backstage/sign-in?error=google");
    for (const failure of ["token-error", "no-id", "info-error"]) {
      mode = failure;
      const state = await start();
      const response = await callback(state, state);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/backstage/sign-in?error=google");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(await response.text()).not.toContain("secret exception detail");
    }
  } finally { data.cleanup(); handler.close(); }
});

test("[integration] AR9 Google unavailable and state cap are explicit", async () => {
  const noGoogle = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: "s".repeat(32) } });
  expect((await noGoogle(new Request(`${ORIGIN}/api/auth/google`))).status).toBe(503);
  noGoogle.close();
  const handler = createHandler({ version: "test", origin: ORIGIN, auth: { sessionSecret: "s".repeat(32), googleClientId: "client", googleClientSecret: "secret" } });
  for (let index = 0; index < 1000; index++) expect((await handler(new Request(`${ORIGIN}/api/auth/google`))).status).toBe(302);
  expect((await handler(new Request(`${ORIGIN}/api/auth/google`))).status).toBe(429);
  handler.close();
});
