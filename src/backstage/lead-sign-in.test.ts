import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialFingerprint, inspectSession, sanitizeNextPath, signSession } from "./auth.ts";
import type { MailMessage } from "./mailer.ts";
import { createHandler } from "./server.ts";

const ORIGIN = "http://localhost:8787";
const SECRET = "s".repeat(32);
const EMAIL = "lead@example.com";
const KEY = "request-key-123456789";

function setup(config: { mail?: boolean; dailyLimit?: number; domainDailyLimit?: number; response?: () => Promise<Response>; now?: number; google?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lead-signin-"));
  const path = join(dir, "tickets.sqlite");
  const operatorsPath = join(dir, "operators.json");
  const salt = "a".repeat(32);
  const passwordHash = `scrypt$${salt}$${scryptSync("password", salt, 64).toString("hex")}`;
  writeFileSync(operatorsPath, JSON.stringify([{ email: "operator@example.com", password_hash: passwordHash }, { email: "google-operator@example.com" }]));
  let now = config.now ?? Date.now();
  const sends: MailMessage[] = [];
  const logs: string[] = [];
  let profile: unknown = { email: EMAIL, email_verified: true, aud: "client", iss: "https://accounts.google.com" };
  const handler = createHandler({
    version: "test", origin: ORIGIN, requireSession: true,
    tickets: { path }, log: (line) => logs.push(line),
    mail: { smtpUser: config.mail === false ? undefined : "hub@example.com", smtpPass: "mail-test-app-password", from: "Jev!Jev <jev@example.com>", dailyLimit: config.dailyLimit, domainDailyLimit: config.domainDailyLimit,
      send: async (message) => { sends.push(message); const answer = config.response ? await config.response() : new Response("{}", { status: 200 }); if (!answer.ok) throw new Error(`smtp ${answer.status}`); } },
    auth: { sessionSecret: SECRET, operatorsPath, clock: () => now,
      googleClientId: config.google ? "client" : undefined, googleClientSecret: config.google ? "secret" : undefined,
      fetch: async (input) => String(input).includes("tokeninfo") ? Response.json(profile) : Response.json({ id_token: "fake-id-token" }) },
  });
  const db = new Database(path);
  const rows = () => db.query<{ n: number }, []>("SELECT count(*) n FROM sign_in_links").get()?.n ?? 0;
  const unused = () => db.query<{ n: number }, []>("SELECT count(*) n FROM sign_in_links WHERE used = 0").get()?.n ?? 0;
  const verified = (email = EMAIL) => db.query<{ n: number }, [string]>("SELECT count(*) n FROM verified_leads WHERE email = ?").get(email)?.n ?? 0;
  const addLead = (email = EMAIL) => db.query("INSERT INTO tickets (id, created_at, kind, show, email, website, idea, consent, follow_up) VALUES (?, ?, 'backstage', NULL, ?, NULL, NULL, 1, 0)").run(randomBytes(6).toString("hex"), new Date(now).toISOString(), email);
  const afterResponse = async (result: Promise<Response>): Promise<Response> => { const answer = await result; await new Promise((resolve) => setTimeout(resolve, 0)); return answer; };
  const ticket = (email = EMAIL, requestKey = randomBytes(12).toString("base64url"), nickname = "", ip = "203.0.113.1") => afterResponse(handler(new Request(`${ORIGIN}/api/tickets`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", host: "evil.example" }, body: JSON.stringify({ kind: "backstage", email, consent: true, nickname, request_key: requestKey }) }), { remoteAddress: ip }));
  const request = (email = EMAIL, ip = "203.0.113.1", headers: Record<string, string> = {}) => afterResponse(handler(new Request(`${ORIGIN}/api/auth/link/request`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ email }) }), { remoteAddress: ip }));
  const token = () => { const match = sends.at(-1)?.text.match(/\/api\/auth\/link\?t=([A-Za-z0-9_-]+)/); return match?.[1] ?? ""; };
  const post = (t: string, headers: Record<string, string> = {}) => handler(new Request(`${ORIGIN}/api/auth/link`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ t }) }));
  const session = (cookie: string) => handler(new Request(`${ORIGIN}/api/backstage/health`, { headers: { cookie } }));
  const oauth = async () => { const started = await handler(new Request(`${ORIGIN}/api/auth/google`)); const state = new URL(started.headers.get("location") ?? "", ORIGIN).searchParams.get("state") ?? ""; const cookie = started.headers.get("set-cookie")?.split(";")[0] ?? ""; return handler(new Request(`${ORIGIN}/api/auth/google/callback?state=${encodeURIComponent(state)}&code=fake`, { headers: { cookie } })); };
  return { handler, db, path, sends, logs, rows, unused, verified, addLead, ticket, request, token, post, session, oauth,
    setProfile: (value: unknown) => { profile = value; }, setNow: (value: number) => { now = value; },
    close: () => { db.close(); handler.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("[integration] lead L1 issued ticket mints one link and sends configured origin", async () => {
  const x = setup(); try { const r = await x.ticket(); expect(r.status).toBe(200); expect((await r.json()).signIn).toBe("email-link"); expect(x.rows()).toBe(1); expect(x.sends).toHaveLength(1); expect(x.sends[0]?.to).toBe("lead@example.com"); expect(x.sends[0]?.from).toBe("Jev!Jev <jev@example.com>"); expect(x.sends[0]?.subject).toBe("Your Jev!Jev Backstage sign-in link"); expect(x.sends[0]?.text).toContain(`${ORIGIN}/api/auth/link?t=`); expect(x.token()).toHaveLength(43); expect(JSON.stringify(x.sends[0])).toContain(`${ORIGIN}/api/auth/link?t=`); expect(x.logs.join("\n")).toContain('"event":"link.sent"'); } finally { x.close(); }
});
test("[integration] lead L2 ticket replay does not send a second link", async () => { const x = setup(); try { await x.ticket(EMAIL, KEY); const r = await x.ticket(EMAIL, KEY, "", "203.0.113.2"); expect((await r.json()).replay).toBe(true); expect(x.sends).toHaveLength(1); } finally { x.close(); } });
test("[integration] lead L3 honeypot sends no link", async () => { const x = setup(); try { await x.ticket(EMAIL, KEY, "bot"); expect(x.rows()).toBe(0); expect(x.sends).toHaveLength(0); } finally { x.close(); } });
test("[integration] lead L4 mail off stores no link and says Google only", async () => { const x = setup({ mail: false }); try { const r = await x.ticket(); expect((await r.json()).signIn).toBe("google"); expect(x.rows()).toBe(0); expect(x.sends).toHaveLength(0); expect(await (await x.handler(new Request(`${ORIGIN}/backstage/sign-in`))).text()).toContain("Sign in with Google using this email"); } finally { x.close(); } });
test("[integration] lead L5 fourth email request within hour does not send", async () => { const x = setup(); try { x.addLead(); for (let i = 0; i < 4; i++) await x.request(EMAIL, `203.0.113.${i + 1}`); expect(x.sends).toHaveLength(3); } finally { x.close(); } });
test("[integration] lead L5 failed sends still count against the email limit", async () => { const x = setup({ response: async () => new Response("oops", { status: 503 }) }); try { x.addLead(); for (let i = 0; i < 4; i++) await x.request(EMAIL, `203.0.113.${i + 1}`); expect(x.sends).toHaveLength(3); expect(x.rows()).toBe(3); expect(x.unused()).toBe(0); } finally { x.close(); } });
test("[integration] lead L6 per-address mint limit refuses sixth request", async () => { const x = setup(); try { for (let i = 0; i < 6; i++) { const email = `lead${i}@example.com`; x.addLead(email); await x.request(email); } expect(x.sends).toHaveLength(5); } finally { x.close(); } });
test("[integration] lead L7 global daily cap refuses next send", async () => { const x = setup({ dailyLimit: 2 }); try { for (let i = 0; i < 3; i++) { const email = `lead${i}@example.com`; x.addLead(email); await x.request(email, `203.0.113.${i + 1}`); } expect(x.sends).toHaveLength(2); } finally { x.close(); } });
test("[integration] lead L7 failed sends still count against the daily cap", async () => { const x = setup({ dailyLimit: 2, response: async () => new Response("oops", { status: 503 }) }); try { for (let i = 0; i < 3; i++) { const email = `lead${i}@example.com`; x.addLead(email); await x.request(email, `203.0.113.${i + 1}`); } expect(x.sends).toHaveLength(2); expect(x.rows()).toBe(2); } finally { x.close(); } });
test("[integration] lead L8 provider errors keep ticket and no unused orphan", async () => { for (const response of [async () => new Response("oops", { status: 503 }), async (): Promise<Response> => { throw new Error("timeout"); }]) { const x = setup({ response }); try { const r = await x.ticket(); expect(r.status).toBe(200); expect((await r.json()).signIn).toBe("email-link"); expect(x.unused()).toBe(0); expect(x.sends).toHaveLength(1); } finally { x.close(); } } });
test("[integration] lead L9 non-lead request has identical response bytes", async () => { const x = setup(); try { x.addLead(); const lead = await x.request(); const unknown = await x.request("stranger@example.com", "203.0.113.2"); expect(unknown.status).toBe(lead.status); expect([...unknown.headers]).toEqual([...lead.headers]); expect(await unknown.text()).toBe(await lead.text()); expect(x.sends).toHaveLength(1); } finally { x.close(); } });
test("[integration] lead L9 slow mail cannot delay a known-email response", async () => { let resolveMail: ((response: Response) => void) | undefined; const pending = new Promise<Response>((resolve) => { resolveMail = resolve; }); const x = setup({ response: () => pending }); try { x.addLead(); const answer = await Promise.race([x.request().then(() => "returned"), new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100))]); expect(answer).toBe("returned"); expect(x.sends).toHaveLength(1); resolveMail?.(new Response("{}", { status: 200 })); await new Promise((resolve) => setTimeout(resolve, 0)); expect(x.unused()).toBe(1); } finally { resolveMail?.(new Response("{}", { status: 200 })); x.close(); } });
test("[integration] lead L10 email case normalizes against ticket row", async () => { const x = setup(); try { x.addLead("lead@x.com"); await x.request("Lead@X.com"); expect(x.sends).toHaveLength(1); } finally { x.close(); } });

test("[integration] lead C1 GET confirms masked address without consumption", async () => { const x = setup(); try { await x.ticket(); const r = await x.handler(new Request(`${ORIGIN}/api/auth/link?t=${x.token()}`)); expect(r.status).toBe(200); const html = await r.text(); expect(html).toContain("Confirm sign-in"); expect(html).toContain("l***@example.com"); expect(x.unused()).toBe(1); } finally { x.close(); } });
test("[integration] lead C2 POST consumes, verifies, sets cookie and redirects", async () => { const x = setup(); try { await x.ticket(); const r = await x.post(x.token()); expect(r.status).toBe(303); expect(r.headers.get("location")).toBe("/backstage/"); expect(r.headers.get("set-cookie")).toContain("backstage_session="); const value = r.headers.get("set-cookie")?.split(";")[0]?.split("=")[1] ?? ""; const checked = inspectSession(value, SECRET, Date.now()); expect(checked.ok && checked.session.auth).toBe("link"); expect(x.verified()).toBe(1); expect(x.unused()).toBe(0); expect(x.logs.join("\n")).toContain('"event":"link.ok"'); } finally { x.close(); } });
test("[integration] lead C3 used token gives generic error without cookie", async () => { const x = setup(); try { await x.ticket(); await x.post(x.token()); const r = await x.post(x.token()); expect(r.status).toBe(400); expect(await r.text()).toContain("This sign-in link is invalid or expired."); expect(r.headers.has("set-cookie")).toBe(false); } finally { x.close(); } });
test("[integration] lead C4 expired token gives generic error", async () => { const x = setup({ now: 1000 }); try { await x.ticket(); x.setNow(1000 + 15 * 60_000); const r = await x.post(x.token()); expect(r.status).toBe(400); expect(await r.text()).toContain("This sign-in link is invalid or expired."); } finally { x.close(); } });
test("[integration] lead C5 unknown or tampered token gives same error", async () => { const x = setup(); try { await x.ticket(); const token = x.token(); const bad = await x.post(token.slice(0, -1) + (token.endsWith("x") ? "y" : "x")); const unknown = await x.post(randomBytes(32).toString("base64url")); expect(bad.status).toBe(400); expect(unknown.status).toBe(400); expect(await bad.text()).toBe(await unknown.text()); expect(bad.headers.has("set-cookie")).toBe(false); } finally { x.close(); } });
test("[integration] lead C6 cross-origin POST is forbidden", async () => { const x = setup(); try { await x.ticket(); expect((await x.post(x.token(), { origin: "https://evil.example" })).status).toBe(403); expect(x.unused()).toBe(1); } finally { x.close(); } });
test("[integration] lead C7 concurrent consumes mint exactly one session", async () => { const x = setup(); try { await x.ticket(); const responses = await Promise.all([x.post(x.token()), x.post(x.token())]); expect(responses.filter((r) => r.headers.has("set-cookie"))).toHaveLength(1); expect(x.verified()).toBe(1); } finally { x.close(); } });
test("[integration] lead C8 raw token appears in no stored column or log", async () => { const x = setup(); try { await x.ticket(); const raw = x.token(); await x.post(raw); const stored = JSON.stringify(x.db.query("SELECT * FROM sign_in_links").all()); expect(stored).not.toContain(raw); expect(x.logs.join("\n")).not.toContain(raw); } finally { x.close(); } });

test("[integration] lead S1 existing operator password and Google sessions work", async () => { const x = setup({ google: true }); try { await x.ticket(); expect(x.sends).toHaveLength(1); const password = await x.handler(new Request(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "operator@example.com", password: "password" }) })); expect((await x.session(password.headers.get("set-cookie")?.split(";")[0] ?? "")).status).toBe(200); x.setProfile({ email: "google-operator@example.com", email_verified: true, aud: "client", iss: "https://accounts.google.com" }); const google = await x.oauth(); expect((await x.session(google.headers.getSetCookie().at(-1)?.split(";")[0] ?? "")).status).toBe(200); } finally { x.close(); } });
test("[integration] lead S2 verified lead session passes health gate", async () => { const x = setup(); try { await x.ticket(); const r = await x.post(x.token()); expect((await x.session(r.headers.get("set-cookie")?.split(";")[0] ?? "")).status).toBe(200); } finally { x.close(); } });
test("[integration] lead S3 deleting lead row revokes next request", async () => { const x = setup(); try { await x.ticket(); const r = await x.post(x.token()); const cookie = r.headers.get("set-cookie")?.split(";")[0] ?? ""; expect((await x.session(cookie)).status).toBe(200); x.db.query("DELETE FROM tickets WHERE email = ?").run(EMAIL); expect((await x.session(cookie)).status).toBe(401); } finally { x.close(); } });
test("[integration] lead S4 sign-out revokes lead session", async () => { const x = setup(); try { await x.ticket(); const r = await x.post(x.token()); const cookie = r.headers.get("set-cookie")?.split(";")[0] ?? ""; expect((await x.session(cookie)).status).toBe(200); expect((await x.handler(new Request(`${ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { origin: ORIGIN, cookie } }))).status).toBe(303); expect((await x.session(cookie)).status).toBe(401); } finally { x.close(); } });
test("[integration] lead S5 next open redirects stay on site", async () => { for (const path of ["https://evil.example/", "//evil.example", "/backstage/..//evil", "/backstage/%2f%2fevil"]) expect(sanitizeNextPath(path)).toBe("/backstage/"); const x = setup(); try { await x.ticket(); const r = await x.handler(new Request(`${ORIGIN}/api/auth/link`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: x.token(), next: "https://evil.example/" }) })); expect(r.headers.get("location")).toBe("/backstage/"); } finally { x.close(); } });

test("[integration] lead G1 verified Google lead gets session and verified row", async () => { const x = setup({ google: true }); try { x.addLead(); const r = await x.oauth(); expect(r.status).toBe(303); expect(x.verified()).toBe(1); expect((await x.session(r.headers.getSetCookie().at(-1)?.split(";")[0] ?? "")).status).toBe(200); } finally { x.close(); } });
test("[integration] lead G2 unverified Google lead denied", async () => { const x = setup({ google: true }); try { x.addLead(); x.setProfile({ email: EMAIL, email_verified: false, aud: "client", iss: "https://accounts.google.com" }); const r = await x.oauth(); expect(r.headers.get("location")).toBe("/backstage/sign-in?error=google"); expect(x.verified()).toBe(0); } finally { x.close(); } });
test("[integration] lead G3 unknown Google email denied not-allowlisted", async () => { const x = setup({ google: true }); try { const r = await x.oauth(); expect(r.headers.get("location")).toBe("/backstage/sign-in?error=google"); expect(x.logs.join("\n")).toContain("not-allowlisted"); expect(x.verified()).toBe(0); } finally { x.close(); } });
test("[integration] lead G4 operator Google remains allowed", async () => { const x = setup({ google: true }); try { x.setProfile({ email: "google-operator@example.com", email_verified: true, aud: "client", iss: "https://accounts.google.com" }); const r = await x.oauth(); expect(r.headers.getSetCookie()).toHaveLength(2); expect(x.verified("google-operator@example.com")).toBe(0); } finally { x.close(); } });
test("[integration] lead I1 invalid CR LF or quote email never reaches mail", async () => { const x = setup(); try { for (const email of ["bad\r\nBcc:evil@example.com", 'bad"@example.com']) await x.request(email); expect(x.sends).toHaveLength(0); expect(x.rows()).toBe(0); } finally { x.close(); } });
test("[integration] lead I2 configured origin wins over forged Host", async () => { const x = setup(); try { await x.ticket(); expect(JSON.stringify(x.sends)).toContain(ORIGIN); expect(JSON.stringify(x.sends)).not.toContain("evil.example"); } finally { x.close(); } });

test("[integration] lead B1 prior requests cannot change a ticket response by lead status", async () => {
  const responses: string[] = [];
  for (const known of [false, true]) {
    const x = setup();
    try {
      if (known) x.addLead("victim@example.com");
      for (let i = 0; i < 5; i++) await x.request("victim@example.com", `203.0.113.${i + 1}`);
      const answer = await x.ticket("throwaway@other.example", undefined, "", "203.0.113.20");
      responses.push(await answer.text());
    } finally { x.close(); }
  }
  expect(responses[0]?.replace(/JNJ-[A-F0-9]+/, "JNJ-ID")).toBe(responses[1]?.replace(/JNJ-[A-F0-9]+/, "JNJ-ID"));
});

test("[integration] lead B1 exhausted recipient gets the same ticket bytes as an eligible recipient", async () => {
  const responses: string[] = [];
  for (const known of [false, true]) {
    const x = setup();
    try {
      if (known) x.addLead();
      for (let i = 0; i < 3; i++) await x.request(EMAIL, `203.0.113.${i + 1}`);
      const answer = await x.ticket(EMAIL, KEY, "", "203.0.113.20");
      responses.push(await answer.text());
    } finally { x.close(); }
  }
  // The random ticket id differs, but every authentication field is fixed configuration state.
  const authFields = responses.map((body) => { const value: unknown = JSON.parse(body); return typeof value === "object" && value !== null && "signIn" in value ? value.signIn : null; });
  expect(authFields).toEqual(["email-link", "email-link"]);
  expect(responses[0]?.replace(/JNJ-[A-F0-9]+/, "JNJ-ID")).toBe(responses[1]?.replace(/JNJ-[A-F0-9]+/, "JNJ-ID"));
  expect(responses.every((body) => !/"link"|"sent"|"failed"|"not-sent"/.test(body))).toBe(true);
});

test("[integration] lead B2 aliases share the three per-hour recipient slots", async () => {
  const x = setup();
  try {
    x.addLead("victim+0@gmail.com");
    for (let i = 1; i < 5; i++) x.addLead(`victim+${i}@gmail.com`);
    x.addLead("v.i.c.t.i.m@googlemail.com");
    for (let i = 0; i < 5; i++) await x.request(`victim+${i}@gmail.com`, `203.0.113.${i + 1}`);
    await x.request("v.i.c.t.i.m@googlemail.com", "203.0.113.6");
    expect(x.sends).toHaveLength(3);
  } finally { x.close(); }
});

test("[integration] lead B2 IPv6 /64, domain and global admissions cap delivery", async () => {
  const ipv6 = setup();
  try {
    for (let i = 0; i < 6; i++) { const email = `person${i}@example.com`; ipv6.addLead(email); await ipv6.request(email, `2001:db8:abcd:1234::${i + 1}`); }
    expect(ipv6.sends).toHaveLength(5);
  } finally { ipv6.close(); }
  const domain = setup({ domainDailyLimit: 2 });
  try {
    for (let i = 0; i < 3; i++) { const email = `person${i}@small.example`; domain.addLead(email); await domain.request(email, `203.0.113.${i + 1}`); }
    expect(domain.sends).toHaveLength(2);
  } finally { domain.close(); }
  const global = setup({ dailyLimit: 2 });
  try {
    for (let i = 0; i < 3; i++) { const email = `person${i}@domain${i}.example`; global.addLead(email); await global.request(email, `203.0.113.${i + 1}`); }
    expect(global.sends).toHaveLength(2);
  } finally { global.close(); }
});

test("[integration] lead B3 documented deletion and re-enrollment keep the old cookie revoked", async () => {
  const x = setup();
  try {
    await x.ticket();
    const first = await x.post(x.token());
    const oldCookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await x.session(oldCookie)).status).toBe(200);
    x.db.exec("BEGIN; DELETE FROM sign_in_links WHERE email = 'lead@example.com'; DELETE FROM verified_leads WHERE email = 'lead@example.com'; DELETE FROM tickets WHERE lower(trim(email)) = 'lead@example.com'; COMMIT;");
    expect((await x.session(oldCookie)).status).toBe(401);
    await x.ticket(EMAIL, "new-request-key-123456789");
    const second = await x.post(x.token());
    expect((await x.session(second.headers.get("set-cookie")?.split(";")[0] ?? "")).status).toBe(200);
    expect((await x.session(oldCookie)).status).toBe(401);
  } finally { x.close(); }
});

test("[integration] lead B6 link request rejects cross-origin and missing-Origin before mint", async () => {
  const x = setup();
  try {
    x.addLead();
    for (const headers of [{ origin: "https://evil.example" }, {}]) {
      const answer = await x.handler(new Request(`${ORIGIN}/api/auth/link/request`, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: EMAIL }) }));
      expect(answer.status).toBe(403);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(x.rows()).toBe(0);
    expect(x.sends).toHaveLength(0);
  } finally { x.close(); }
});

test("[integration] lead B1 request returns before eligibility lookup and mint", async () => {
  const x = setup();
  try {
    x.addLead();
    const answer = await x.handler(new Request(`${ORIGIN}/api/auth/link/request`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: EMAIL }) }));
    expect(answer.status).toBe(303);
    expect(x.rows()).toBe(0);
    expect(x.sends).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(x.rows()).toBe(1);
    expect(x.sends).toHaveLength(1);
  } finally { x.close(); }
});

test("[integration] lead O2 link confirmation rejects missing Origin without consuming", async () => {
  const x = setup();
  try {
    await x.ticket();
    const answer = await x.handler(new Request(`${ORIGIN}/api/auth/link`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: x.token() }) }));
    expect(answer.status).toBe(403);
    expect(x.unused()).toBe(1);
  } finally { x.close(); }
});

test("[integration] lead B6 credential and auth type confusion reject mismatched sessions", async () => {
  const x = setup();
  try {
    await x.ticket();
    const confirmed = await x.post(x.token());
    const raw = confirmed.headers.get("set-cookie")?.split(";")[0]?.split("=")[1] ?? "";
    const inspected = inspectSession(raw, SECRET, Date.now());
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    const issue = (email: string, auth: "link" | "password" | "google", cred: string) => `backstage_session=${signSession({ ...inspected.session, email, auth, sid: randomBytes(24).toString("base64url"), cred }, SECRET)}`;
    const leadCred = inspected.session.cred;
    expect((await x.session(issue(EMAIL, "link", credentialFingerprint("wrong")))).status).toBe(401);
    expect((await x.session(issue("operator@example.com", "link", leadCred))).status).toBe(401);
    expect((await x.session(issue(EMAIL, "password", leadCred))).status).toBe(401);
    expect((await x.session(issue(EMAIL, "google", credentialFingerprint("wrong")))).status).toBe(401);
    x.addLead("operator@example.com");
    const password = await x.handler(new Request(`${ORIGIN}/api/auth/password`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "operator@example.com", password: "password" }) }));
    expect((await x.session(password.headers.get("set-cookie")?.split(";")[0] ?? "")).status).toBe(200);
  } finally { x.close(); }
});

test("[integration] lead B6 SQLite consumes a link once across separate connections", async () => {
  const x = setup();
  try {
    await x.ticket();
    const first = new Database(x.path);
    const second = new Database(x.path);
    const digest = x.db.query<{ token_sha256: string }, []>("SELECT token_sha256 FROM sign_in_links LIMIT 1").get()?.token_sha256 ?? "";
    const sql = "UPDATE sign_in_links SET used = 1 WHERE token_sha256 = ? AND used = 0 AND expires > ?";
    expect(first.query(sql).run(digest, Date.now()).changes).toBe(1);
    expect(second.query(sql).run(digest, Date.now()).changes).toBe(0);
    first.close(); second.close();
  } finally { x.close(); }
});

test("[integration] lead P1 blocked address probes cannot consume shared delivery budgets", async () => {
  const x = setup({ dailyLimit: 6, domainDailyLimit: 6 });
  try {
    for (let i = 0; i < 200; i++) await x.request(`unknown${i}@example.com`, "203.0.113.1");
    x.addLead();
    await x.request(EMAIL, "203.0.113.2");
    expect(x.sends).toHaveLength(1);
    expect(x.rows()).toBe(1);
  } finally { x.close(); }
});

test("[integration] lead P2 changing verification method preserves existing lead sessions", async () => {
  for (const firstMethod of ["link", "google"]) {
    const x = setup({ google: true });
    try {
      x.addLead();
      await x.request();
      const first = firstMethod === "link" ? await x.post(x.token()) : await x.oauth();
      const oldCookie = first.headers.getSetCookie().find((cookie) => cookie.startsWith("backstage_session="))?.split(";")[0] ?? "";
      expect((await x.session(oldCookie)).status).toBe(200);
      const second = firstMethod === "link" ? await x.oauth() : await x.post(x.token());
      const newCookie = second.headers.getSetCookie().find((cookie) => cookie.startsWith("backstage_session="))?.split(";")[0] ?? "";
      expect((await x.session(newCookie)).status).toBe(200);
      expect((await x.session(oldCookie)).status).toBe(200);
      expect(x.db.query<{ method: string }, []>("SELECT method FROM verified_leads").get()?.method).toBe(firstMethod === "link" ? "google" : "link");
    } finally { x.close(); }
  }
});

test("[integration] lead B6 mailbox delivery cannot reveal whether earlier probes named a lead", async () => {
  const deliveries: number[] = [];
  for (const known of [false, true]) {
    const x = setup({ dailyLimit: 20, domainDailyLimit: 20 });
    try {
      if (known) x.addLead("victim@example.com");
      x.addLead("attacker@example.com");
      for (let i = 0; i < 5; i++) await x.request("victim@example.com", "203.0.113.1");
      const before = x.sends.length;
      await x.request("attacker@example.com", "203.0.113.1");
      deliveries.push(x.sends.length - before);
    } finally { x.close(); }
  }
  expect(deliveries).toEqual([0, 0]);
});
