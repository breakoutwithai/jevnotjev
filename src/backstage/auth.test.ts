import { expect, test } from "bun:test";
import { cookie, cookieName, GoogleStates, isSameOrigin, LoginLimiter, OperatorStore, parseCookie, sanitizeNextPath, signSession, verifyPasswordHash, verifySession } from "./auth.ts";
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

test("[unit] AU3 password hash verifies scrypt only and dummy handles unknown", () => {
  const salt = randomBytes(16).toString("hex");
  const hash = `scrypt$${salt}$${scryptSync("correct-pass", salt, 64).toString("hex")}`;
  expect(verifyPasswordHash("correct-pass", hash)).toBe(true);
  expect(verifyPasswordHash("wrong", hash)).toBe(false);
  for (const invalid of [undefined, "$apr1$abc", "$2y$abc", "scrypt$bad$abc"]) expect(verifyPasswordHash("correct-pass", invalid)).toBe(false);
});

test("[unit] AU4 session signature expiry and malformed cookie fail closed", () => {
  const payload: Session = { email: "a@example.com", auth: "password", iat: 100, exp: 200, sid: "sid" };
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
  for (let index = 0; index < 5; index++) { expect(limiter.locked("a@example.com", "127.0.0.1")).toBe(false); limiter.fail("a@example.com", "127.0.0.1"); }
  expect(limiter.locked("a@example.com", "127.0.0.1")).toBe(true);
  now = 60_000;
  for (let index = 0; index < 5; index++) limiter.fail("a@example.com", "127.0.0.1");
  expect(limiter.locked("a@example.com", "127.0.0.1")).toBe(true);
  now = 120_000;
  expect(limiter.locked("a@example.com", "127.0.0.1")).toBe(true);
  now = 180_000;
  limiter.success("a@example.com");
  expect(limiter.locked("a@example.com", "127.0.0.1")).toBe(false);
  for (let index = 0; index < 20; index++) limiter.fail(`other${index}@example.com`, "127.0.0.1");
  expect(limiter.locked("fresh@example.com", "127.0.0.1")).toBe(true);
});

test("[unit] AU8 Google state is single use, expires and is capped", () => {
  let now = 0;
  const states = new GoogleStates(() => now, 1);
  const state = states.start("/backstage/x");
  expect(state).not.toBeNull();
  expect(states.start("/backstage/")).toBeNull();
  expect(states.take(state ?? "", "wrong")).toBeNull();
  expect(states.take(state ?? "", state ?? "")).toBeNull();
  const second = states.start("/backstage/");
  now = 600_000;
  expect(states.take(second ?? "", second ?? "")).toBeNull();
});
