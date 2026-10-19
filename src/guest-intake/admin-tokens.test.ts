// src/guest-intake/tokens.ts, operator side (#282): the jna_ admin token lifecycle. Mint, verify, expiry, revoke, rotate,
// private file state, and separation from guest jng_ and decide jnj_ tokens in both directions. Synthetic state only.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiTokenStore, mintToken } from "../backstage/api-tokens.ts";
import { ADMIN_SCOPES, AdminTokenStore, DEFAULT_ADMIN_TTL_MS, GuestTokenStore, MAX_ADMIN_TTL_MS, MIN_ADMIN_TTL_MS } from "./tokens.ts";

const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
const TOKEN = /^jna_[A-Za-z0-9_-]{43}$/;
const dirs: string[] = [];
const closers: { close: () => void }[] = [];

afterEach(() => {
  for (const s of closers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "jnj-admin-tokens-"));
  chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}

function admin(path: string, clock: () => number = () => T0): AdminTokenStore {
  const s = new AdminTokenStore(path, clock);
  closers.push(s);
  return s;
}

function guest(path: string, clock: () => number = () => T0): GuestTokenStore {
  const s = new GuestTokenStore(path, clock);
  closers.push(s);
  return s;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("[unit] AT-1 admin TTL bounds are 7 days by default, 1 hour minimum, 30 days maximum; scope is questions:admin only", () => {
  expect(DEFAULT_ADMIN_TTL_MS).toBe(7 * 24 * 60 * 60_000);
  expect(MIN_ADMIN_TTL_MS).toBe(60 * 60_000);
  expect(MAX_ADMIN_TTL_MS).toBe(30 * 24 * 60 * 60_000);
  expect([...ADMIN_SCOPES]).toEqual(["questions:admin"]);
  const store = admin(join(temp(), "tickets.sqlite"));
  for (const ttlMs of [MIN_ADMIN_TTL_MS - 1, MAX_ADMIN_TTL_MS + 1, 1.5, Number.NaN]) expect(() => store.mint("Operator", { ttlMs })).toThrow(/ttl/);
  expect(store.mint("Operator", { ttlMs: MAX_ADMIN_TTL_MS }).record.expires).toBe(new Date(T0 + MAX_ADMIN_TTL_MS).toISOString());
});

test("[integration] AT-2 mint returns one jna_ token with an atk_ id; verify gives the admin principal until expiry", () => {
  const clock = { now: T0 };
  const store = admin(join(temp(), "tickets.sqlite"), () => clock.now);
  const minted = store.mint("Craig laptop");
  expect(minted.token).toMatch(TOKEN);
  expect(minted.record).toMatchObject({ label: "Craig laptop", created: new Date(T0).toISOString(), expires: new Date(T0 + DEFAULT_ADMIN_TTL_MS).toISOString(), revokedAt: null, scopes: ["questions:admin"] });
  expect(minted.record.id).toMatch(/^atk_[a-f0-9]{12}$/);
  expect(store.verify(`Bearer ${minted.token}`)).toEqual({ tokenId: minted.record.id, scopes: ["questions:admin"] });
  clock.now = T0 + DEFAULT_ADMIN_TTL_MS - 1;
  expect(store.verify(`Bearer ${minted.token}`)?.tokenId).toBe(minted.record.id);
  clock.now = T0 + DEFAULT_ADMIN_TTL_MS;
  expect(store.verify(`Bearer ${minted.token}`)).toBeNull();
  for (const header of [null, "", minted.token, `bearer ${minted.token}`, `Bearer ${minted.token} `, `Bearer jna_${"A".repeat(43)}`]) expect(store.verify(header)).toBeNull();
});

test("[integration] AT-3 revoke applies to the next verify, even from another store instance; rotate keeps the id and kills the old secret", () => {
  const path = join(temp(), "tickets.sqlite");
  const a = admin(path);
  const b = admin(path);
  const one = a.mint("One");
  const two = a.mint("Two");
  expect(b.verify(`Bearer ${one.token}`)).not.toBeNull();
  expect(b.revoke(one.record.id)?.revokedAt).toBe(new Date(T0).toISOString());
  expect(a.verify(`Bearer ${one.token}`)).toBeNull();
  expect(() => a.rotate(one.record.id)).toThrow(/revoked/);
  const rotated = a.rotate(two.record.id);
  expect(rotated.record.id).toBe(two.record.id);
  expect(b.verify(`Bearer ${two.token}`)).toBeNull();
  expect(b.verify(`Bearer ${rotated.token}`)?.tokenId).toBe(two.record.id);
  expect(a.list().map((r) => r.id)).toEqual([one.record.id, two.record.id].sort((x, y) => (x < y ? -1 : 1)));
  expect(() => a.revoke("gtk_aaaaaaaaaaaa")).toThrow(/id/);
  expect(a.revoke("atk_ffffffffffff")).toBeNull();
});

test("[integration] AT-4 only the sha256 is stored; the token is absent from SQLite bytes, list output and errors", () => {
  const dir = temp();
  const path = join(dir, "tickets.sqlite");
  const store = admin(path);
  const minted = store.mint("Operator");
  const bytes = readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("\n");
  expect(bytes).toContain(sha256(minted.token));
  expect(bytes).not.toContain(minted.token.slice(4));
  expect(JSON.stringify(store.list())).not.toContain(minted.token.slice(4));
});

test("[integration] AT-5 the state directory and file must be private, as for guest tokens", () => {
  const dir = temp();
  const path = join(dir, "tickets.sqlite");
  const store = admin(path);
  const { token } = store.mint("Operator");
  chmodSync(path, 0o644);
  expect(() => store.verify(`Bearer ${token}`)).toThrow(/mode/);
  chmodSync(path, 0o600);
  chmodSync(dir, 0o755);
  expect(() => new AdminTokenStore(path)).toThrow(/mode/);
  chmodSync(dir, 0o700);
  expect(() => new AdminTokenStore("tickets.sqlite")).toThrow(/absolute/);
});

test("[integration] AT-SEPARATION jna_ never passes the guest or decide stores; jng_ and jnj_ never pass the admin store, even with their hash stored", () => {
  const dir = temp();
  const path = join(dir, "tickets.sqlite");
  const admins = admin(path);
  const guests = guest(path);
  const apiPath = join(dir, "api", "api-tokens.json");
  const decide = mintToken(apiPath, "decide");
  const api = new ApiTokenStore(apiPath);
  const operator = admins.mint("Operator");
  const visitor = guests.mint("Guest A");
  // Positive controls: each store accepts its own kind.
  expect(admins.verify(`Bearer ${operator.token}`)).not.toBeNull();
  expect(guests.verify(`Bearer ${visitor.token}`)).not.toBeNull();
  expect(api.verify(`Bearer ${decide.token}`)).toBe(decide.id);
  // Admin into guest and decide.
  expect(guests.verify(`Bearer ${operator.token}`)).toBeNull();
  expect(api.verify(`Bearer ${operator.token}`)).toBeNull();
  // Guest and decide into admin.
  expect(admins.verify(`Bearer ${visitor.token}`)).toBeNull();
  expect(admins.verify(`Bearer ${decide.token}`)).toBeNull();
  // With the foreign token's own hash written into admin_tokens, the admin pattern still refuses it.
  const db = new Database(path);
  const insert = db.query("INSERT INTO admin_tokens (id, label, sha256, created_at, expires_at, revoked_at, last_used_at, scopes) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'questions:admin')");
  insert.run("atk_aaaaaaaaaaaa", "guest", sha256(visitor.token), T0, T0 + DEFAULT_ADMIN_TTL_MS);
  insert.run("atk_bbbbbbbbbbbb", "decide", sha256(decide.token), T0, T0 + DEFAULT_ADMIN_TTL_MS);
  // And the admin token's hash written into guest_tokens: the guest pattern refuses it.
  db.query("INSERT INTO guest_tokens (id, label, sha256, created_at, expires_at, revoked_at, last_used_at, scopes) VALUES ('gtk_cccccccccccc', 'admin', ?, ?, ?, NULL, NULL, 'questions:submit questions:read-own')").run(sha256(operator.token), T0, T0 + DEFAULT_ADMIN_TTL_MS);
  db.close();
  expect(admins.verify(`Bearer ${visitor.token}`)).toBeNull();
  expect(admins.verify(`Bearer ${decide.token}`)).toBeNull();
  expect(guests.verify(`Bearer ${operator.token}`)).toBeNull();
  expect(admins.verify(`Bearer jna_${visitor.token.slice(4)}`)).toBeNull();
});

test("[integration] AT-6 the guest_tokens schema text is unchanged, so an existing tickets.sqlite still opens", () => {
  const path = join(temp(), "tickets.sqlite");
  guest(path).mint("Before");
  const db = new Database(path);
  const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'guest_tokens'").get()?.sql ?? "";
  db.close();
  // The text the first release (origin/main 642c0ba, tokens.ts TABLE) wrote; the constructor refuses any other.
  expect(sql).toBe(`CREATE TABLE guest_tokens (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 16 AND substr(id, 1, 4) = 'gtk_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 64),
  sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at > created_at),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR typeof(revoked_at) = 'integer'),
  last_used_at INTEGER CHECK(last_used_at IS NULL OR typeof(last_used_at) = 'integer'),
  scopes TEXT NOT NULL CHECK(scopes = 'questions:submit questions:read-own')
)`);
  admin(path).mint("After");
  expect(guest(path).list().map((r) => r.label)).toEqual(["Before"]);
});
