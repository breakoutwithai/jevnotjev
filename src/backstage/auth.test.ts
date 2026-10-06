import { expect, test } from "bun:test";
import { cookie, cookieName, GoogleStates, isSameOrigin, LoginLimiter, OperatorStore, parseCookie, RevokedSessions, sanitizeNextPath, signSession, verifyPasswordHash, verifySession, credentialFingerprint } from "./auth.ts";
import type { Session } from "./auth.ts";
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("[unit] AU1 next accepts only Backstage paths", () => {
  expect(sanitizeNextPath("/backstage/x/y")).toBe("/backstage/x/y");
  expect(sanitizeNextPath("//evil")).toBe("/backstage/");
  expect(sanitizeNextPath("/backstage/../x")).toBe("/backstage/");
});

test("[unit] AU2 next rejects all unsafe shapes", () => {
  for (const value of ["/backstage", "/\\evil", "https://evil", "/other", "/backstage/%2e%2e/x", "/backstage/a\n", "/backstage//x", "/backstage/.hidden/../x"]) expect(sanitizeNextPath(value)).toBe("/backstage/");
  expect(sanitizeNextPath("/backstage/")).toBe("/backstage/");
});

test("[unit] AU3 password hash verifies scrypt only and dummy handles unknown", async () => {
  const salt = randomBytes(16).toString("hex");
  const hash = `scrypt$${salt}$${scryptSync("correct-pass", salt, 64).toString("hex")}`;
  expect(await verifyPasswordHash("correct-pass", hash)).toBe(true);
  expect(await verifyPasswordHash("wrong", hash)).toBe(false);
  for (const invalid of [undefined, "$apr1$abc", "$2y$abc", "scrypt$bad$abc"]) expect(await verifyPasswordHash("correct-pass", invalid)).toBe(false);
});

test("[unit] AU4 session signature expiry and malformed cookie fail closed", () => {
  const payload: Session = { email: "a@example.com", auth: "password", iat: 100, exp: 200, sid: "sid", cred: credentialFingerprint("hash") };
  const value = signSession(payload, "s".repeat(32));
  expect(verifySession(value, "s".repeat(32), 199)?.sid).toBe("sid");
  for (const bad of [value.slice(0, -1) + "x", "nodot", "%%.abc", "e30.abc"]) expect(verifySession(bad, "s".repeat(32), 100)).toBeNull();
  expect(verifySession(value, "wrong", 100)).toBeNull();
  expect(verifySession(value, "s".repeat(32), 200)).toBeNull();
  expect(parseCookie("backstage_session=%not-valid", "backstage_session")).toBeUndefined();
  const badJson = Buffer.from("not json").toString("base64url");
  const signature = createHmac("sha256", "s".repeat(32)).update(badJson).digest("base64url");
  expect(verifySession(`${badJson}.${signature}`, "s".repeat(32), 100)).toBeNull();
});

test("[unit] AU5 cookie flags and same-origin signals", () => {
  expect(cookieName("https://example.com", "session")).toBe("__Host-backstage_session");
  expect(cookie("https://example.com", "session", "v", 43200)).toBe("__Host-backstage_session=v; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200");
  expect(cookie("http://localhost:8787", "oauth", "v", 600)).toBe("backstage_oauth=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=600");
  expect(isSameOrigin(new Request("https://example.com", { headers: { "sec-fetch-site": "cross-site" } }), "https://example.com")).toBe(false);
  expect(isSameOrigin(new Request("https://example.com", { headers: { origin: "https://evil.com" } }), "https://example.com")).toBe(false);
  expect(isSameOrigin(new Request("https://example.com"), "https://example.com")).toBe(true);
});

test("[unit] AU6 operators reload on mtime and missing or invalid means none", () => {
  const directory = mkdtempSync(join(tmpdir(), "backstage-operators-"));
  const path = join(directory, "operators.json");
  try {
    const store = new OperatorStore(path);
    expect(store.get("a@example.com")).toBeUndefined();
    writeFileSync(path, JSON.stringify([{ email: " A@Example.com ", displayName: "A" }]));
    expect(store.get("a@example.com")?.displayName).toBe("A");
    writeFileSync(path, "invalid JSON with another size");
    expect(store.get("a@example.com")).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("[unit] AU7 lockout thresholds, backoff and success reset", () => {
  let now = 0;
  const limiter = new LoginLimiter(() => now);
  for (let index = 0; index < 5; index++) { expect(limiter.locked("a@example.com", "203.0.113.1")).toBe(false); limiter.fail("a@example.com", "203.0.113.1"); }
  expect(limiter.locked("a@example.com", "203.0.113.1")).toBe(true);
  expect(limiter.locked("a@example.com", "203.0.113.2")).toBe(false);
  now = 60_000;
  for (let index = 0; index < 5; index++) limiter.fail("a@example.com", "203.0.113.1");
  expect(limiter.locked("a@example.com", "203.0.113.1")).toBe(true);
  now = 120_000;
  expect(limiter.locked("a@example.com", "203.0.113.1")).toBe(true);
  now = 180_000;
  limiter.success("a@example.com", "203.0.113.1");
  expect(limiter.locked("a@example.com", "203.0.113.1")).toBe(false);
  for (let index = 0; index < 4; index++) limiter.fail("a@example.com", "203.0.113.1");
  expect(limiter.locked("a@example.com", "203.0.113.1")).toBe(false);
  for (let index = 0; index < 20; index++) limiter.fail(`other${index}@example.com`, "203.0.113.1");
  expect(limiter.locked("fresh@example.com", "203.0.113.1")).toBe(true);
  const decay = new LoginLimiter(() => now);
  for (let index = 0; index < 5; index++) decay.fail("decay@example.com", "203.0.113.8");
  now += 86_400_001;
  for (let index = 0; index < 5; index++) decay.fail("decay@example.com", "203.0.113.8");
  expect(decay.locked("decay@example.com", "203.0.113.8")).toBe(true);
  now += 60_000;
  expect(decay.locked("decay@example.com", "203.0.113.8")).toBe(false);
});

test("[unit] AU8 Google state is signed, expires and has no storage cap", () => {
  let now = 0;
  const states = new GoogleStates(() => now, "s".repeat(32));
  const { state, nonce } = states.start("/backstage/x");
  expect(states.take(state, "wrong")).toBeNull();
  expect(states.take(state + "x", nonce)).toBeNull();
  expect(states.take(state, nonce)).toBe("/backstage/x");
  for (let index = 0; index < 5000; index++) expect(states.start("/backstage/").state).toBeTruthy();
  const second = states.start("/backstage/");
  now = 600_000;
  expect(states.take(second.state, second.nonce)).toBeNull();
});

test("[unit] AU9 limiter skips untrusted address, bounds records and logs one redacted lock", () => {
  let now = 0;
  const limiter = new LoginLimiter(() => now);
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    for (let index = 0; index < 20; index++) limiter.fail(`a${index}@example.com`, null);
    expect(limiter.locked("fresh@example.com", null)).toBe(false);
    for (let index = 0; index < 5; index++) limiter.fail("secret@example.com", "203.0.113.9");
    expect(limiter.locked("secret@example.com", "203.0.113.9")).toBe(true);
    expect(limiter.locked("secret@example.com", "203.0.113.9")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^backstage auth: lock pair address=203\.0\.113\.9 email=[a-f0-9]{8}$/);
    for (let index = 0; index < 20_000; index++) limiter.fail(`${randomBytes(8).toString("hex")}@example.com`, null);
    expect(limiter.sizes().emails).toBeLessThanOrEqual(10_000);
    now = 86_400_001;
    expect(limiter.locked("secret@example.com", "203.0.113.9")).toBe(false);
    limiter.fail("fresh@example.com", null);
    expect(limiter.sizes().emails).toBe(1);
  } finally { console.warn = original; }
});

test("[unit] AU10 unknown email runs the dummy scrypt derivation", async () => {
  let calls = 0;
  const result = await verifyPasswordHash("candidate", undefined, async (_password, _salt, length) => {
    calls++;
    return Buffer.alloc(length);
  });
  expect(result).toBe(false);
  expect(calls).toBe(1);
});

test("[unit] AU11 distributed failures reach only the one minute email ceiling", () => {
  let now = 0;
  const limiter = new LoginLimiter(() => now);
  const original = console.warn;
  console.warn = () => {};
  try {
    for (let index = 0; index < 100; index++) limiter.fail("a@example.com", `198.51.100.${index + 1}`);
    expect(limiter.locked("a@example.com", "203.0.113.1")).toBe(true);
    now = 60_000;
    expect(limiter.locked("a@example.com", "203.0.113.1")).toBe(false);
    for (let index = 0; index < 99; index++) limiter.fail("a@example.com", null);
    expect(limiter.locked("a@example.com", null)).toBe(false);
    limiter.fail("a@example.com", null);
    expect(limiter.locked("a@example.com", null)).toBe(true);
    now = 120_000;
    expect(limiter.locked("a@example.com", null)).toBe(false);
  } finally { console.warn = original; }
});

test("[unit] AU12 revoked session store caps entries and keeps a failed write revoked in memory", () => {
  const store = new RevokedSessions(() => 1000);
  for (let index = 0; index < 10_000; index++) store.revoke(`sid-${index}`, 2000);
  expect(() => store.revoke("overflow", 2000)).toThrow();
  expect(store.has("sid-0", 1000)).toBe(true);
  expect(store.has("overflow", 1000)).toBe(true);
});

test("[unit] AU13 limiter retains a lock level through the 15 minute sweep", () => {
  let now = 0;
  const limiter = new LoginLimiter(() => now);
  const original = console.warn;
  console.warn = () => {};
  try {
    for (let index = 0; index < 5; index++) limiter.fail("victim@example.com", "203.0.113.1");
    now = 900_001;
    for (let index = 0; index < 256; index++) limiter.fail(`sweep${index}@example.com`, null);
    for (let index = 0; index < 5; index++) limiter.fail("victim@example.com", "203.0.113.1");
    now += 60_000;
    expect(limiter.locked("victim@example.com", "203.0.113.1")).toBe(true);
    now += 60_000;
    expect(limiter.locked("victim@example.com", "203.0.113.1")).toBe(false);
  } finally { console.warn = original; }
});

test("[unit] AU14 a full limiter refuses new records without evicting a locked victim", () => {
  let now = 0;
  const limiter = new LoginLimiter(() => now);
  const original = console.warn;
  console.warn = () => {};
  try {
    for (let index = 0; index < 5; index++) limiter.fail("victim@example.com", "203.0.113.1");
    expect(limiter.locked("victim@example.com", "203.0.113.1")).toBe(true);
    for (let index = 0; index < 9_999; index++) limiter.fail(`random${index}@example.com`, `198.51.${Math.floor(index / 256)}.${index % 256}`);
    expect(limiter.sizes().emails).toBe(10_000);
    expect(limiter.sizes().pairs).toBe(10_000);
    expect(limiter.canAttempt("overflow@example.com", "203.0.113.2")).toBe(false);
    expect(limiter.fail("overflow@example.com", "203.0.113.2")).toBe(false);
    expect(limiter.sizes().pairs).toBe(10_000);
    expect(limiter.locked("victim@example.com", "203.0.113.1")).toBe(true);
    now = 60_000;
    for (let index = 0; index < 5; index++) limiter.fail("victim@example.com", "203.0.113.1");
    now = 120_000;
    expect(limiter.locked("victim@example.com", "203.0.113.1")).toBe(true);
    expect(limiter.canAttempt("overflow@example.com", null)).toBe(false);
    now = 900_001;
    expect(limiter.canAttempt("overflow@example.com", null)).toBe(true);
  } finally { console.warn = original; }
});

test("[unit] AU15 limiter reserves the last slot before password verification", () => {
  const limiter = new LoginLimiter(() => 0);
  for (let index = 0; index < 9_999; index++) limiter.fail(`random${index}@example.com`, null);
  expect(limiter.canAttempt("first@example.com", null)).toBe(true);
  expect(limiter.canAttempt("second@example.com", null)).toBe(false);
  expect(limiter.sizes().emails).toBe(10_000);
});

test("[unit] AU16 revocation startup counts only unexpired entries against the cap", () => {
  const directory = mkdtempSync(join(tmpdir(), "backstage-revoked-"));
  const path = join(directory, "operators.json");
  const rows: Record<string, number> = {};
  for (let index = 0; index < 10_001; index++) rows[`expired-${index}`] = 999;
  rows.active = 2000;
  writeFileSync(join(directory, "revoked-sessions.json"), JSON.stringify(rows));
  try {
    const store = new RevokedSessions(() => 1000, path);
    expect(store.has("active", 999)).toBe(true);
    expect(store.has("unlisted", 999)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
