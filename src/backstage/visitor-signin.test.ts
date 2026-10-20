// Visitor sign-in (#307, criteria 1, 2, 6 and 7): a verified Google account that is not in operators.json signs in as a
// visitor with its own cookie (jnj_visitor / __Host-jnj_visitor) and lands on /ask/mine/; it never receives the operator
// session and never opens an operator route. Driven through the mounted handler (createHandler); only Google's HTTP is
// faked, and the fake maps each authorization code to one profile so one handler serves many identities.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_API_ROUTES } from "../guest-intake/admin-api.ts";
import { ADMIN_MCP_PATH } from "../guest-intake/admin-mcp-http.ts";
import { ADMIN_ROUTES } from "../guest-intake/admin-routes.ts";
import { API_V1_ROUTES } from "./api-v1.ts";
import { cookieName, credentialFingerprint, inspectSession, signSession } from "./auth.ts";
import * as server from "./server.ts";
import { createHandler } from "./server.ts";

const ORIGIN = "http://localhost:8787";
const SECURE_ORIGIN = "https://jevnotjev.example";
const SECRET = "v".repeat(48);
const OPERATOR = "op-307@example.test";
const SITE = join(import.meta.dir, "..", "..", "site");
const T0 = Date.parse("2026-10-20T09:00:00.000Z");
const TWELVE_HOURS = 43_200_000;
const ACCESS_MESSAGE = "This Google account cannot sign in here. Ask for access at jev@breakoutwithai.com.";
const ACCESS_ERROR = "/backstage/sign-in?error=google-access";
const GOOGLE_ERROR = "/backstage/sign-in?error=google";
const PLACEHOLDER_ID = "Q-000000000000";
const SERVER_SOURCE = join(import.meta.dir, "server.ts");

/** Runtime-read exports the implementation adds; the type checker cannot see them yet, so they stay `unknown`. */
const serverExports: Readonly<Record<string, unknown>> = server;

type Profile = Record<string, unknown>;

interface Box {
  readonly handler: ReturnType<typeof createHandler>;
  readonly origin: string;
  readonly operatorsPath: string;
  readonly ticketsPath: string | undefined;
  readonly logs: string[];
  /** Every Google code and id_token the fake handed out, for the log scan. */
  readonly secrets: string[];
  readonly register: (profile: Profile) => string;
  readonly failToken: (value: boolean) => void;
  readonly advance: (ms: number) => void;
  readonly now: () => number;
  readonly cleanup: () => void;
}

interface BoxOptions {
  readonly origin?: string;
  readonly tickets?: boolean;
  readonly requireSession?: boolean;
}

/** Set-Cookie lines of every callback this file treated as a visitor outcome (VS14 reads them last). */
const visitorSetCookies: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function box(options: BoxOptions = {}): Box {
  const origin = options.origin ?? ORIGIN;
  const root = mkdtempSync(join(tmpdir(), "visitor-signin-307-"));
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const ticketsPath = options.tickets === false ? undefined : join(state, "tickets.sqlite");
  const operatorsPath = join(root, "operators.json");
  writeFileSync(operatorsPath, JSON.stringify([{ email: OPERATOR, admin: true }]));
  const profiles = new Map<string, Profile>();
  const secrets: string[] = [];
  const logs: string[] = [];
  let tokenFails = false;
  let at = T0;
  let sequence = 0;
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = String(input);
    if (target === "https://oauth2.googleapis.com/token") {
      if (tokenFails) return new Response("token exchange exploded", { status: 500 });
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      return Response.json({ id_token: `idt-${body.get("code") ?? ""}` });
    }
    const idToken = new URL(target).searchParams.get("id_token") ?? "";
    const profile = profiles.get(idToken.replace(/^idt-/, ""));
    return profile ? Response.json(profile) : new Response("unknown token", { status: 400 });
  };
  const handler = createHandler({
    version: "test", origin, staticRoot: SITE, requireSession: options.requireSession ?? true,
    log: (line) => { logs.push(line); },
    tickets: ticketsPath === undefined ? {} : { path: ticketsPath },
    auth: { sessionSecret: SECRET, operatorsPath, googleClientId: "client", googleClientSecret: "secret", fetch: fakeFetch, clock: () => at },
  });
  return {
    handler, origin, operatorsPath, ticketsPath, logs, secrets,
    register: (profile) => {
      sequence += 1;
      const code = `code307x${sequence}x${randomBytes(6).toString("hex")}`;
      profiles.set(code, profile);
      secrets.push(code, `idt-${code}`);
      return code;
    },
    failToken: (value) => { tokenFails = value; },
    advance: (ms) => { at += ms; },
    now: () => at,
    cleanup: () => { handler.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function visitorProfile(n: number | string, overrides: Profile = {}): Profile {
  return { email: `visitor-307-${n}@example.test`, email_verified: true, aud: "client", iss: "https://accounts.google.com", sub: `sub-307-${n}`, ...overrides };
}

function operatorProfile(overrides: Profile = {}): Profile {
  return { email: OPERATOR, email_verified: true, aud: "client", iss: "https://accounts.google.com", sub: "sub-307-operator", ...overrides };
}

function visitorCookieName(origin: string): string {
  return origin.startsWith("https://") ? "__Host-jnj_visitor" : "jnj_visitor";
}

function setCookieLine(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`));
}

function cookieValue(response: Response, name: string): string {
  return setCookieLine(response, name)?.split(";")[0]?.slice(name.length + 1) ?? "";
}

/** True when the response sets either session cookie (operator or visitor) to a non-empty value. */
function setsAnySession(response: Response, origin: string): boolean {
  return cookieValue(response, cookieName(origin, "session")) !== "" || cookieValue(response, visitorCookieName(origin)) !== "";
}

async function startGoogle(b: Box, next = "/backstage/x"): Promise<{ state: string; cookie: string }> {
  const response = await b.handler(new Request(`${b.origin}/api/auth/google?next=${encodeURIComponent(next)}`));
  const location = response.headers.get("location") ?? "";
  if (response.status !== 302 || !location.startsWith("https://accounts.google.com/")) throw new Error(`Google start failed: ${response.status}`);
  const name = cookieName(b.origin, "oauth");
  return { state: new URL(location).searchParams.get("state") ?? "", cookie: `${name}=${cookieValue(response, name)}` };
}

async function callback(b: Box, query: string, oauthCookie: string): Promise<Response> {
  return b.handler(new Request(`${b.origin}/api/auth/google/callback?${query}`, { headers: { cookie: oauthCookie } }));
}

/** One full Google round trip for `profile`. Non-operator outcomes are recorded for VS14. */
async function signIn(b: Box, profile: Profile, next = "/backstage/x"): Promise<Response> {
  const started = await startGoogle(b, next);
  const code = b.register(profile);
  const response = await callback(b, `state=${encodeURIComponent(started.state)}&code=${code}`, started.cookie);
  if (profile.email !== OPERATOR) visitorSetCookies.push(...response.headers.getSetCookie());
  return response;
}

function visitorRequest(b: Box, path: string, value: string, init: { method?: string; sameOrigin?: boolean } = {}): Request {
  const headers: Record<string, string> = { cookie: `${visitorCookieName(b.origin)}=${value}` };
  if (init.sameOrigin) { headers.origin = b.origin; headers["sec-fetch-site"] = "same-origin"; }
  return new Request(`${b.origin}${path}`, { method: init.method ?? "GET", headers });
}

async function me(b: Box, value: string): Promise<Response> {
  return b.handler(visitorRequest(b, "/api/v1/visitor/me", value));
}

async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error("response body is not an object");
  return value;
}

function sqlRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.filter(isRecord);
}

function withDb<T>(path: string | undefined, run: (db: Database) => T): T {
  if (path === undefined) throw new Error("no tickets path");
  const db = new Database(path);
  try { return run(db); } finally { db.close(); }
}

/** A visitor that has signed in, with its cookie value; fails the calling test when the visitor path is absent. */
async function signedInVisitor(b: Box, profile: Profile): Promise<string> {
  const response = await signIn(b, profile);
  expect(response.headers.get("location")).toBe("/ask/mine/");
  const value = cookieValue(response, visitorCookieName(b.origin));
  expect(value).not.toBe("");
  return value;
}

// ---- Operator route inventory (VS11, VS12, VS15) ----

interface OperatorRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly kind: "api" | "page";
  /** The handler checks auth itself, so the route must refuse even with requireSession false. */
  readonly selfChecking: boolean;
}

/** Every "/api/backstage/..." string literal in server.ts that names a route (prefix literals ending in "/" excluded). */
function serverBackstageLiterals(): string[] {
  const text = readFileSync(SERVER_SOURCE, "utf8");
  const found = new Set<string>();
  for (const match of text.matchAll(/"(\/api\/backstage\/[^"]*)"/g)) {
    const literal = match[1];
    if (literal !== undefined && !literal.endsWith("/")) found.add(literal);
  }
  return [...found].sort();
}

/** server.BACKSTAGE_API_ROUTES read at runtime: strings, [method, path] tuples or { method, pattern | path } objects. */
function backstageApiRoutes(): { readonly method: "GET" | "POST" | null; readonly path: string }[] | null {
  const raw = serverExports.BACKSTAGE_API_ROUTES;
  if (!Array.isArray(raw)) return null;
  const out: { method: "GET" | "POST" | null; path: string }[] = [];
  for (const entry of raw) {
    const method = (value: unknown): "GET" | "POST" | null => value === "GET" || value === "POST" ? value : null;
    if (typeof entry === "string") out.push({ method: null, path: entry });
    else if (Array.isArray(entry) && typeof entry[1] === "string") out.push({ method: method(entry[0]), path: entry[1] });
    else if (isRecord(entry)) {
      const path = typeof entry.pattern === "string" ? entry.pattern : typeof entry.path === "string" ? entry.path : null;
      if (path !== null) out.push({ method: method(entry.method), path });
    }
  }
  return out;
}

function operatorRoutes(questionId: string): OperatorRoute[] {
  const fill = (pattern: string): string => pattern.replace("{id}", questionId);
  const routes: OperatorRoute[] = [];
  const add = (route: OperatorRoute): void => {
    if (!routes.some((r) => r.method === route.method && r.path === route.path)) routes.push(route);
  };
  for (const r of ADMIN_ROUTES) add({ method: r.method, path: fill(r.pattern), kind: r.pattern.startsWith("/backstage/") ? "page" : "api", selfChecking: true });
  for (const r of ADMIN_API_ROUTES) add({ method: r.method, path: fill(r.pattern), kind: "api", selfChecking: true });
  add({ method: "POST", path: ADMIN_MCP_PATH, kind: "api", selfChecking: true });
  for (const [method, path] of API_V1_ROUTES) add({ method, path, kind: "api", selfChecking: true });
  add({ method: "GET", path: "/api/auth/session", kind: "api", selfChecking: true });
  const listed = backstageApiRoutes() ?? [];
  const literals = serverBackstageLiterals().map((path) => ({ method: null, path }));
  for (const r of [...listed, ...literals]) {
    const methods: readonly ("GET" | "POST")[] = r.method === null ? ["GET", "POST"] : [r.method];
    for (const method of methods) add({ method, path: fill(r.path), kind: "api", selfChecking: false });
  }
  add({ method: "GET", path: "/backstage/", kind: "page", selfChecking: false });
  add({ method: "GET", path: "/backstage/questions/", kind: "page", selfChecking: true });
  return routes;
}

function operatorRouteRequest(origin: string, route: OperatorRoute, cookie: string): Request {
  const headers: Record<string, string> = { cookie, origin, "sec-fetch-site": "same-origin" };
  if (route.method === "POST") headers["content-type"] = "application/json";
  const body = route.path === ADMIN_MCP_PATH ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) : "{}";
  return new Request(`${origin}${route.path}`, { method: route.method, headers, ...(route.method === "POST" ? { body } : {}) });
}

/** Each route's refusal is checked; the returned list names every route that answered anything else. */
async function refusalFailures(b: Box, cookie: string, questionId: string, onlySelfChecking: boolean): Promise<string[]> {
  const failures: string[] = [];
  for (const route of operatorRoutes(questionId)) {
    if (onlySelfChecking && !route.selfChecking) continue;
    const response = await b.handler(operatorRouteRequest(b.origin, route, cookie));
    const status = response.status;
    const location = response.headers.get("location") ?? "";
    const refused = route.kind === "api"
      ? status === 401 || status === 403
      : status === 401 || status === 403 || (status === 302 && location.startsWith("/backstage/sign-in"));
    if (!refused || (status >= 200 && status < 300)) failures.push(`${route.method} ${route.path} -> ${status}${location ? ` ${location}` : ""}`);
  }
  return failures;
}

/** A real visitor question id when the visitor submit route exists, else the well-formed placeholder. */
async function visitorQuestionId(b: Box, value: string): Promise<string> {
  const response = await b.handler(new Request(`${b.origin}/api/v1/visitor/questions`, {
    method: "POST",
    headers: { cookie: `${visitorCookieName(b.origin)}=${value}`, origin: b.origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ question: "Which desk answers stock questions for visitor 307?", reply_consent: true, request_key: randomBytes(32).toString("base64url").slice(0, 43) }),
  }));
  if (response.status !== 200) return PLACEHOLDER_ID;
  const out = await jsonRecord(response);
  return typeof out.id === "string" && /^Q-[0-9A-F]{12}$/.test(out.id) ? out.id : PLACEHOLDER_ID;
}

// ---- Criterion 1: a verified non-operator signs in as a visitor ----

test("[integration] VS1 a verified non-operator completes Google sign-in as a visitor on /ask/mine/", async () => {
  const b = box();
  try {
    const profile = visitorProfile(1);
    const response = await signIn(b, profile);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/ask/mine/");
    const line = setCookieLine(response, "jnj_visitor") ?? "";
    expect(line).not.toBe("");
    expect(line).toContain("Path=/");
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("Max-Age=43200");
    expect(line).not.toContain("Secure");
    expect(setCookieLine(response, "backstage_oauth")).toContain("Max-Age=0");
    expect(setCookieLine(response, "backstage_session")).toBeUndefined();
    const session = await me(b, cookieValue(response, "jnj_visitor"));
    expect(session.status).toBe(200);
    expect((await jsonRecord(session)).email).toBe(profile.email);
  } finally { b.cleanup(); }
});

test("[integration] VS2 a secure origin issues __Host-jnj_visitor with Secure", async () => {
  const b = box({ origin: SECURE_ORIGIN });
  try {
    const profile = visitorProfile(2);
    const response = await signIn(b, profile);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/ask/mine/");
    const line = setCookieLine(response, "__Host-jnj_visitor") ?? "";
    expect(line).toContain("Path=/");
    expect(line).toContain("; Secure");
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("Max-Age=43200");
    expect(line).not.toContain("Domain=");
    expect(setCookieLine(response, "jnj_visitor")).toBeUndefined();
    expect(setCookieLine(response, "__Host-backstage_session")).toBeUndefined();
    const session = await me(b, cookieValue(response, "__Host-jnj_visitor"));
    expect(session.status).toBe(200);
    expect((await jsonRecord(session)).email).toBe(profile.email);
  } finally { b.cleanup(); }
});

test("[integration] VS3 an operator account signs in exactly as before", async () => {
  const b = box();
  try {
    const response = await signIn(b, operatorProfile(), "/backstage/x");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/backstage/x");
    const value = cookieValue(response, "backstage_session");
    expect(value).not.toBe("");
    expect(setCookieLine(response, "jnj_visitor")).toBeUndefined();
    expect(setCookieLine(response, "backstage_oauth")).toContain("Max-Age=0");
    const page = await b.handler(new Request(`${ORIGIN}/backstage/`, { headers: { cookie: `backstage_session=${value}` } }));
    expect(page.status).toBe(200);
  } finally { b.cleanup(); }
});

test("[integration] VS4 the same Google sub keeps one visitors row and refreshes its email", async () => {
  const b = box();
  try {
    await signedInVisitor(b, visitorProfile(4));
    const renamed = visitorProfile(4, { email: "visitor-307-4-renamed@example.test" });
    const second = await signedInVisitor(b, renamed);
    const rows = withDb(b.ticketsPath, (db) => sqlRows(db.query("SELECT id, email FROM visitors WHERE google_sub = ?").all("sub-307-4")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("visitor-307-4-renamed@example.test");
    expect(String(rows[0]?.id)).toMatch(/^vis_[a-f0-9]{12}$/);
    expect(withDb(b.ticketsPath, (db) => sqlRows(db.query("SELECT COUNT(*) AS n FROM visitors").all())[0]?.n)).toBe(1);
    const session = await me(b, second);
    expect(session.status).toBe(200);
    expect((await jsonRecord(session)).email).toBe("visitor-307-4-renamed@example.test");
  } finally { b.cleanup(); }
});

// ---- Criterion 6: an unverified email is refused with the #306 message ----

test("[integration] VS5 an unverified email is refused with google-access for visitors and operators", async () => {
  const b = box();
  try {
    const unverified: readonly { readonly label: string; readonly verified: Profile }[] = [
      { label: "false", verified: { email_verified: false } },
      { label: "string false", verified: { email_verified: "false" } },
    ];
    const outcomes: string[] = [];
    const accounts: readonly (readonly [string, Profile])[] = [["visitor", visitorProfile(5)], ["operator", operatorProfile()]];
    for (const [who, base] of accounts) {
      const absent: Profile = {};
      for (const [key, value] of Object.entries(base)) if (key !== "email_verified") absent[key] = value;
      for (const { label, profile } of [...unverified.map((u) => ({ label: u.label, profile: { ...base, ...u.verified } })), { label: "absent", profile: absent }]) {
        const response = await signIn(b, profile);
        expect(response.status).toBe(303);
        expect(setCookieLine(response, "backstage_oauth")).toContain("Max-Age=0");
        outcomes.push(`${who}/${label}: ${response.headers.get("location")} session=${setsAnySession(response, ORIGIN)}`);
      }
    }
    expect(outcomes).toEqual([
      `visitor/false: ${ACCESS_ERROR} session=false`,
      `visitor/string false: ${ACCESS_ERROR} session=false`,
      `visitor/absent: ${ACCESS_ERROR} session=false`,
      `operator/false: ${ACCESS_ERROR} session=false`,
      `operator/string false: ${ACCESS_ERROR} session=false`,
      `operator/absent: ${ACCESS_ERROR} session=false`,
    ]);
  } finally { b.cleanup(); }
});

test("[integration] VS6 the sign-in page shows the google-access message and no account email", async () => {
  const b = box();
  try {
    const tester = visitorProfile(6, { email_verified: false });
    await signIn(b, tester);
    const response = await b.handler(new Request(`${ORIGIN}/backstage/sign-in?error=google-access`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(ACCESS_MESSAGE);
    expect(html).not.toContain(String(tester.email));
    expect(html).not.toContain(OPERATOR);
  } finally { b.cleanup(); }
});

test("[integration] VS7 bad state, a provider error and a failed token exchange keep error=google", async () => {
  const b = box();
  try {
    const profile = visitorProfile(7);
    const started = await startGoogle(b);
    const badState = await callback(b, `state=${encodeURIComponent(`${started.state}x`)}&code=${b.register(profile)}`, started.cookie);
    expect(badState.headers.get("location")).toBe(GOOGLE_ERROR);
    expect(setsAnySession(badState, ORIGIN)).toBe(false);
    const again = await startGoogle(b);
    const provider = await callback(b, `state=${encodeURIComponent(again.state)}&error=access_denied`, again.cookie);
    expect(provider.headers.get("location")).toBe(GOOGLE_ERROR);
    expect(setsAnySession(provider, ORIGIN)).toBe(false);
    b.failToken(true);
    const token = await signIn(b, profile);
    expect(token.headers.get("location")).toBe(GOOGLE_ERROR);
    expect(setsAnySession(token, ORIGIN)).toBe(false);
    expect(await token.text()).not.toContain("token exchange exploded");
  } finally { b.cleanup(); }
});

test("[integration] VS8 a missing or empty sub, or no tickets path, is error=google with no cookie", async () => {
  const b = box();
  const noStore = box({ tickets: false });
  try {
    const missing: Profile = {};
    for (const [key, value] of Object.entries(visitorProfile(8))) if (key !== "sub") missing[key] = value;
    for (const profile of [missing, visitorProfile(8, { sub: "" })]) {
      const response = await signIn(b, profile);
      expect(response.headers.get("location")).toBe(GOOGLE_ERROR);
      expect(setsAnySession(response, ORIGIN)).toBe(false);
    }
    const response = await signIn(noStore, visitorProfile("8-store"));
    expect(response.headers.get("location")).toBe(GOOGLE_ERROR);
    expect(setsAnySession(response, ORIGIN)).toBe(false);
  } finally { b.cleanup(); noStore.cleanup(); }
});

test("[integration] VS9 a disabled visitors row is refused at sign-in and ends the earlier session", async () => {
  const b = box();
  try {
    const profile = visitorProfile(9);
    const earlier = await signedInVisitor(b, profile);
    expect((await me(b, earlier)).status).toBe(200);
    withDb(b.ticketsPath, (db) => db.query("UPDATE visitors SET disabled_at = ? WHERE google_sub = ?").run(new Date(b.now()).toISOString(), "sub-307-9"));
    const refused = await signIn(b, profile);
    expect(refused.headers.get("location")).toBe(ACCESS_ERROR);
    expect(setsAnySession(refused, ORIGIN)).toBe(false);
    expect((await me(b, earlier)).status).toBe(401);
  } finally { b.cleanup(); }
});

test("[integration] VS10 MAX_VISITORS refuses a new sub at the cap and still admits an existing one", async () => {
  const visitors: unknown = await import(new URL("../guest-intake/visitors.ts", import.meta.url).href);
  const max = isRecord(visitors) ? visitors.MAX_VISITORS : undefined;
  expect(max).toBe(5000);
  const b = box();
  try {
    await signedInVisitor(b, visitorProfile("10-existing"));
    const seed = (target: number): void => withDb(b.ticketsPath, (db) => {
      const count = sqlRows(db.query("SELECT COUNT(*) AS n FROM visitors").all())[0]?.n;
      const insert = db.query("INSERT INTO visitors (id, google_sub, email, created_at, last_seen_at, generation, disabled_at) VALUES (?, ?, ?, ?, ?, ?, NULL)");
      const at = new Date(b.now()).toISOString();
      db.transaction(() => {
        for (let index = typeof count === "number" ? count : 0; index < target; index++)
          insert.run(`vis_${index.toString(16).padStart(12, "0")}`, `seed-sub-${index}`, `seed-${index}@example.test`, at, at, "0".repeat(64));
      })();
    });
    const total = (): unknown => withDb(b.ticketsPath, (db) => sqlRows(db.query("SELECT COUNT(*) AS n FROM visitors").all())[0]?.n);
    seed(4999);
    await signedInVisitor(b, visitorProfile("10-last-seat"));
    expect(total()).toBe(5000);
    const refused = await signIn(b, visitorProfile("10-over"));
    expect(refused.headers.get("location")).toBe(ACCESS_ERROR);
    expect(setsAnySession(refused, ORIGIN)).toBe(false);
    expect(total()).toBe(5000);
    const existing = await signedInVisitor(b, visitorProfile("10-existing"));
    expect((await me(b, existing)).status).toBe(200);
  } finally { b.cleanup(); }
});

// ---- Criterion 2: a visitor never opens an operator route ----

test("[integration] VS11 a visitor cookie is refused on every operator route", async () => {
  expect(Array.isArray(serverExports.BACKSTAGE_API_ROUTES)).toBe(true);
  for (const requireSession of [true, false]) {
    const b = box({ requireSession });
    try {
      const value = await signedInVisitor(b, visitorProfile(`11-${requireSession}`));
      const questionId = await visitorQuestionId(b, value);
      const cookie = `${visitorCookieName(b.origin)}=${value}`;
      expect(await refusalFailures(b, cookie, questionId, !requireSession)).toEqual([]);
      if (questionId !== PLACEHOLDER_ID) expect(await refusalFailures(b, cookie, PLACEHOLDER_ID, !requireSession)).toEqual([]);
    } finally { b.cleanup(); }
  }
});

test("[integration] VS12 an operator-format session for a non-operator email is refused on every operator route", async () => {
  expect(operatorRoutes(PLACEHOLDER_ID).length).toBeGreaterThanOrEqual(20);
  for (const requireSession of [true, false]) {
    const b = box({ requireSession });
    try {
      const forged = signSession({ email: "forged-307@example.test", auth: "google", iat: b.now(), exp: b.now() + TWELVE_HOURS, sid: randomBytes(24).toString("base64url"), cred: credentialFingerprint("google") }, SECRET);
      const cookie = `${cookieName(b.origin, "session")}=${forged}`;
      expect(await refusalFailures(b, cookie, PLACEHOLDER_ID, !requireSession)).toEqual([]);
    } finally { b.cleanup(); }
  }
});

test("[integration] VS13 visitor and operator tokens are not interchangeable across cookie names", async () => {
  const b = box();
  try {
    const visitorToken = await signedInVisitor(b, visitorProfile(13));
    const operator = await signIn(b, operatorProfile());
    const operatorToken = cookieValue(operator, "backstage_session");
    expect(operatorToken).not.toBe("");
    expect((await me(b, visitorToken)).status).toBe(200);
    expect((await b.handler(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: `backstage_session=${operatorToken}` } }))).status).toBe(204);
    const crossed = await b.handler(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: `backstage_session=${visitorToken}` } }));
    expect(crossed.status).toBe(401);
    expect(inspectSession(visitorToken, SECRET, b.now())).toEqual({ ok: false, reason: "bad-signature" });
    expect((await me(b, operatorToken)).status).toBe(401);
  } finally { b.cleanup(); }
});

test("[integration] VS15 every /api/backstage route literal in server.ts is listed in BACKSTAGE_API_ROUTES", () => {
  const listed = backstageApiRoutes();
  expect(listed).not.toBeNull();
  const paths = new Set((listed ?? []).map((route) => route.path));
  const literals = serverBackstageLiterals();
  expect(literals.length).toBeGreaterThan(0);
  expect(literals.filter((literal) => !paths.has(literal))).toEqual([]);
});

// ---- Visitor session lifecycle ----

test("[integration] VS16 tampered, wrongly signed, expired and signed-out visitor sessions are 401", async () => {
  const b = box();
  try {
    const first = await signedInVisitor(b, visitorProfile(16));
    expect((await me(b, first)).status).toBe(200);
    const [payload = "", signature = ""] = first.split(".");
    const decoded: unknown = (() => { try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; } })();
    const tamperedPayload = isRecord(decoded)
      ? Buffer.from(JSON.stringify({ ...decoded, exp: Number(decoded.exp) + TWELVE_HOURS })).toString("base64url")
      : `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    const otherSecret = createHmac("sha256", "w".repeat(48)).update(`visitor:${payload}`).digest("base64url");
    for (const bad of [`${tamperedPayload}.${signature}`, `${payload}.${flipped}`, `${payload}.${otherSecret}`, payload, ""])
      expect((await me(b, bad)).status).toBe(401);
    expect((await me(b, first)).status).toBe(200);

    const signedOut = await b.handler(visitorRequest(b, "/api/v1/visitor/sign-out", first, { method: "POST", sameOrigin: true }));
    expect(signedOut.status).toBe(204);
    expect(setCookieLine(signedOut, "jnj_visitor")).toContain("Max-Age=0");
    expect((await me(b, first)).status).toBe(401);

    const later = await signedInVisitor(b, visitorProfile(16));
    expect((await me(b, later)).status).toBe(200);
    b.advance(TWELVE_HOURS + 1);
    expect((await me(b, later)).status).toBe(401);
  } finally { b.cleanup(); }
});

// ---- Criterion 7: no secret or identity in a log line ----

test("[integration] VS17 visitor sign-in never logs an email, sub, token, code or cookie value", async () => {
  const b = box();
  try {
    const profile = visitorProfile(17);
    const refusedProfile = visitorProfile("17-unverified", { email_verified: false });
    const value = await signedInVisitor(b, profile);
    await signIn(b, refusedProfile);
    expect((await me(b, value)).status).toBe(200);
    expect((await b.handler(visitorRequest(b, "/api/v1/visitor/sign-out", value, { method: "POST", sameOrigin: true }))).status).toBe(204);
    const joined = b.logs.join("\n");
    const forbidden = [String(profile.email), String(profile.sub), String(refusedProfile.email), String(refusedProfile.sub), value, ...b.secrets];
    expect(forbidden.filter((needle) => needle !== "" && joined.includes(needle))).toEqual([]);
    const ok = b.logs.map((line): unknown => { try { return JSON.parse(line); } catch { return null; } })
      .filter(isRecord).find((line) => line.event === "signin.visitor.ok");
    expect(ok).toBeDefined();
    expect(String(ok?.vid)).toMatch(/^vis_[a-f0-9]{12}$/);
  } finally { b.cleanup(); }
});

// ---- Criterion 2: no visitor outcome ever carries the operator cookie (runs last; reads every outcome above) ----

test("[integration] VS14 no visitor outcome sets the operator session cookie or changes operators.json", async () => {
  const b = box();
  try {
    const before = readFileSync(b.operatorsPath);
    const outcomes: Response[] = [];
    const success = await signIn(b, visitorProfile(14));
    outcomes.push(success);
    const value = cookieValue(success, "jnj_visitor");
    expect(value).not.toBe("");
    outcomes.push(await signIn(b, visitorProfile("14-unverified", { email_verified: "false" })));
    outcomes.push(await signIn(b, visitorProfile("14-empty-sub", { sub: "" })));
    outcomes.push(await me(b, value));
    outcomes.push(await b.handler(visitorRequest(b, "/api/v1/visitor/sign-out", value, { method: "POST", sameOrigin: true })));
    withDb(b.ticketsPath, (db) => db.query("UPDATE visitors SET disabled_at = ? WHERE google_sub = ?").run(new Date(b.now()).toISOString(), "sub-307-14"));
    outcomes.push(await signIn(b, visitorProfile(14)));
    const lines = [...outcomes.flatMap((response) => response.headers.getSetCookie()), ...visitorSetCookies];
    const operatorCookies = lines.filter((line) => /^(__Host-)?backstage_session=[^;]+/.test(line));
    expect(operatorCookies).toEqual([]);
    expect(readFileSync(b.operatorsPath).equals(before)).toBe(true);
  } finally { b.cleanup(); }
});
