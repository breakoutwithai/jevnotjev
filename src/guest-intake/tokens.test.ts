// src/guest-intake/tokens.ts: the guest token lifecycle (#255, for #253 PR 2). Mint, verify, expiry, revoke, rotate,
// separation from the decide token store, private file state, and other tables in tickets.sqlite left alone.
// Synthetic state only: every store lives in a fresh temp directory.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiTokenStore, mintToken } from "../backstage/api-tokens.ts";
import { TicketStore } from "../backstage/tickets.ts";
import { DEFAULT_GUEST_TTL_MS, GUEST_SCOPES, GuestTokenStore, MAX_GUEST_TTL_MS, MIN_GUEST_TTL_MS } from "./tokens.ts";

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0);
const TOKEN = /^jng_[A-Za-z0-9_-]{43}$/;
const dirs: string[] = [];
const stores: GuestTokenStore[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "jnj-guest-tokens-"));
  chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}

function open(path: string, clock: () => number = () => T0): GuestTokenStore {
  const s = new GuestTokenStore(path, clock);
  stores.push(s);
  return s;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function errorText(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  throw new Error("expected a throw");
}

/** Every byte of the SQLite database and its WAL and shared-memory files, as latin1 text for substring search. */
function sqliteBytes(path: string, dir: string): string {
  const name = path.slice(dir.length + 1);
  return readdirSync(dir)
    .filter((f) => f.startsWith(name))
    .map((f) => readFileSync(join(dir, f)).toString("latin1"))
    .join("\n");
}

function childEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "" };
}

test("[unit] GT-MINT mint returns a jng_ token once with metadata, fixed scopes and a 14-day default expiry", () => {
  const dir = temp();
  const store = open(join(dir, "tickets.sqlite"));
  const minted = store.mint("Ada Guest");
  expect(minted.token).toMatch(TOKEN);
  expect(minted.record).toEqual({
    id: expect.stringMatching(/^gtk_[a-f0-9]{12}$/),
    label: "Ada Guest",
    created: new Date(T0).toISOString(),
    expires: new Date(T0 + DEFAULT_GUEST_TTL_MS).toISOString(),
    revokedAt: null,
    lastUsedAt: null,
    scopes: ["questions:submit", "questions:read-own"],
  });
  expect(DEFAULT_GUEST_TTL_MS).toBe(14 * 24 * 60 * 60_000);
  expect(GUEST_SCOPES).toEqual(["questions:submit", "questions:read-own"]);
  expect(store.list()).toEqual([minted.record]);
  const second = store.mint("Bo Guest", { ttlMs: MIN_GUEST_TTL_MS });
  expect(second.token).not.toBe(minted.token);
  expect(second.record.id).not.toBe(minted.record.id);
  expect(second.record.expires).toBe(new Date(T0 + MIN_GUEST_TTL_MS).toISOString());
});

test("[unit] GT-VERIFY a valid bearer returns a frozen principal and records last use; a failed verify records nothing", () => {
  const dir = temp();
  let now = T0;
  const store = open(join(dir, "tickets.sqlite"), () => now);
  const a = store.mint("Ada");
  const b = store.mint("Bo");
  now = T0 + 5_000;
  const principal = store.verify(`Bearer ${a.token}`);
  expect(principal).toEqual({ tokenId: a.record.id, scope: `guest:${a.record.id}`, scopes: ["questions:submit", "questions:read-own"] });
  if (principal === null) throw new Error("expected a principal");
  expect(Object.isFrozen(principal)).toBe(true);
  expect(Object.isFrozen(principal.scopes)).toBe(true);
  expect(Reflect.set(principal, "tokenId", b.record.id)).toBe(false);
  expect(Reflect.set(principal, "scope", `guest:${b.record.id}`)).toBe(false);
  expect(principal.tokenId).toBe(a.record.id);
  // A second token is a second, isolated principal.
  expect(store.verify(`Bearer ${b.token}`)?.tokenId).toBe(b.record.id);
  const byId = new Map(store.list().map((r) => [r.id, r]));
  expect(byId.get(a.record.id)?.lastUsedAt).toBe(new Date(T0 + 5_000).toISOString());
  store.revoke(b.record.id);
  now = T0 + 9_000;
  expect(store.verify(`Bearer ${b.token}`)).toBeNull();
  expect(store.list().find((r) => r.id === b.record.id)?.lastUsedAt).toBe(new Date(T0 + 5_000).toISOString());
});

test("[unit] GT-CHECK check accepts what verify accepts and writes nothing; revoked, rotated-away and expired tokens are null", () => {
  const dir = temp();
  let now = T0;
  const path = join(dir, "tickets.sqlite");
  const store = open(path, () => now);
  const a = store.mint("Ada", { ttlMs: MIN_GUEST_TTL_MS });
  const b = store.mint("Bo");
  const c = store.mint("Cy");
  now = T0 + 5_000;
  expect(store.check(`Bearer ${a.token}`)).toEqual(store.verify(`Bearer ${a.token}`));
  expect(store.check(`Bearer ${b.token}`)?.tokenId).toBe(b.record.id);
  expect(store.list().find((r) => r.id === b.record.id)?.lastUsedAt).toBeNull();
  // Inside another connection's write transaction, check reads and returns at once.
  const other = new Database(path, { strict: true });
  try {
    other.exec("BEGIN IMMEDIATE");
    expect(store.check(`Bearer ${b.token}`)?.tokenId).toBe(b.record.id);
    other.exec("ROLLBACK");
  } finally {
    other.close();
  }
  store.revoke(b.record.id);
  store.rotate(c.record.id);
  now = T0 + MIN_GUEST_TTL_MS;
  for (const token of [a.token, b.token, c.token]) expect(store.check(`Bearer ${token}`)).toBeNull();
});

test("[unit] GT-EXPIRY a token is valid from created up to but not at expires, and not before created", () => {
  const dir = temp();
  let now = T0;
  const ttl = 2 * 60 * 60_000;
  const store = open(join(dir, "tickets.sqlite"), () => now);
  const { token, record } = store.mint("Ada", { ttlMs: ttl });
  expect(record.expires).toBe(new Date(T0 + ttl).toISOString());
  expect(store.verify(`Bearer ${token}`)?.tokenId).toBe(record.id);
  now = T0 + ttl - 1;
  expect(store.verify(`Bearer ${token}`)?.tokenId).toBe(record.id);
  now = T0 + ttl;
  expect(store.verify(`Bearer ${token}`)).toBeNull();
  now = T0 + ttl + 86_400_000;
  expect(store.verify(`Bearer ${token}`)).toBeNull();
  now = T0 - 1;
  expect(store.verify(`Bearer ${token}`)).toBeNull();
  // An expired token stays listed until the operator revokes it.
  expect(store.list().map((r) => r.id)).toEqual([record.id]);
});

test("[unit] GT-INPUT label, TTL, option keys and clock are validated strictly and a refused mint stores nothing", () => {
  const dir = temp();
  const store = open(join(dir, "tickets.sqlite"));
  const badLabels = ["", " Ada", "Ada ", "a".repeat(65), "Adé", "Ada\nBo", "Ada\u0000", "<script>", "Ada;DROP"];
  for (const label of badLabels) expect(() => store.mint(label)).toThrow(/label/);
  for (const ttlMs of [MIN_GUEST_TTL_MS - 1, MAX_GUEST_TTL_MS + 1, 1.5 * MIN_GUEST_TTL_MS + 0.5, Number.NaN, Number.POSITIVE_INFINITY, -MIN_GUEST_TTL_MS]) {
    expect(() => store.mint("Ada", { ttlMs })).toThrow(/ttl/);
  }
  const widened = { ttlMs: MIN_GUEST_TTL_MS, scopes: ["questions:delete"] };
  expect(() => store.mint("Ada", widened)).toThrow(/option/);
  expect(store.list()).toEqual([]);
  expect(store.mint("a".repeat(64), { ttlMs: MAX_GUEST_TTL_MS }).record.expires).toBe(new Date(T0 + MAX_GUEST_TTL_MS).toISOString());
  expect(store.mint("ada.guest@example.com_1-2").record.label).toBe("ada.guest@example.com_1-2");
  for (const bad of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
    const skewed = open(join(dir, "tickets.sqlite"), () => bad);
    expect(() => skewed.mint("Ada")).toThrow(/clock/);
    expect(() => skewed.verify("Bearer jng_" + "A".repeat(43))).toThrow(/clock/);
  }
  expect(store.list()).toHaveLength(2);
});

test("[unit] GT-HEADER malformed Authorization headers return null without touching state", () => {
  const dir = temp();
  const store = open(join(dir, "tickets.sqlite"));
  const { token, record } = store.mint("Ada");
  const body = token.slice(4);
  const bad: (string | null)[] = [
    null,
    "",
    "Bearer",
    "Bearer ",
    token,
    `bearer ${token}`,
    `BEARER ${token}`,
    `Basic ${token}`,
    `Bearer  ${token}`,
    `Bearer ${token} `,
    ` Bearer ${token}`,
    `Bearer\t${token}`,
    `Bearer ${token}\n`,
    `Bearer ${token},${token}`,
    `Bearer ${token} ${token}`,
    `Bearer ${token.slice(0, -1)}`,
    `Bearer ${token}A`,
    `Bearer jnj_${body}`,
    `Bearer JNG_${body}`,
    `Bearer jng-${body}`,
    `Bearer ${body}`,
    `Bearer jng_${body.slice(0, 42)}=`,
    `Bearer jng_${body.slice(0, 42)}é`,
    `Bearer ${"x".repeat(10_000)}`,
  ];
  for (const header of bad) expect(store.verify(header)).toBeNull();
  expect(store.list()[0]?.lastUsedAt).toBeNull();
  expect(store.verify(`Bearer ${token}`)?.tokenId).toBe(record.id);
});

test("[integration] GT-REVOKE a revoke by one instance applies on the next verify of another open instance and survives reopen", () => {
  const dir = temp();
  const path = join(dir, "tickets.sqlite");
  let now = T0;
  const a = open(path, () => now);
  const b = open(path, () => now);
  const { token, record } = a.mint("Ada");
  const other = a.mint("Bo");
  expect(b.verify(`Bearer ${token}`)?.tokenId).toBe(record.id);
  now = T0 + 1_000;
  const revoked = a.revoke(record.id);
  expect(revoked?.revokedAt).toBe(new Date(T0 + 1_000).toISOString());
  expect(b.verify(`Bearer ${token}`)).toBeNull();
  expect(a.verify(`Bearer ${token}`)).toBeNull();
  // Idempotent: a second revoke keeps the first time. Unknown ids are null; malformed ids are refused.
  now = T0 + 2_000;
  expect(b.revoke(record.id)?.revokedAt).toBe(new Date(T0 + 1_000).toISOString());
  expect(a.revoke("gtk_000000000000")).toBeNull();
  expect(() => a.revoke("tok_abc")).toThrow(/id/);
  expect(() => a.revoke(`gtk_000000000000' OR 1=1 --`)).toThrow(/id/);
  // The other token is untouched.
  expect(b.verify(`Bearer ${other.token}`)?.tokenId).toBe(other.record.id);
  a.close();
  b.close();
  const c = open(path, () => now);
  expect(c.verify(`Bearer ${token}`)).toBeNull();
  expect(c.list().find((r) => r.id === record.id)?.revokedAt).toBe(new Date(T0 + 1_000).toISOString());
  expect(c.verify(`Bearer ${other.token}`)?.tokenId).toBe(other.record.id);
});

test("[integration] GT-PROCESS a revoke from a separate process applies to this process's open store on the next request", async () => {
  const dir = temp();
  const path = join(dir, "tickets.sqlite");
  const store = open(path, Date.now);
  const { token, record } = store.mint("Ada");
  expect(store.verify(`Bearer ${token}`)?.tokenId).toBe(record.id);
  const code = [
    `import { GuestTokenStore } from ${JSON.stringify(join(import.meta.dir, "tokens.ts"))};`,
    `const s = new GuestTokenStore(${JSON.stringify(path)});`,
    `const r = s.revoke(${JSON.stringify(record.id)});`,
    `s.close();`,
    `process.exit(r === null ? 2 : 0);`,
  ].join("\n");
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", env: childEnv() });
  expect(await child.exited).toBe(0);
  expect(store.verify(`Bearer ${token}`)).toBeNull();
}, 30_000);

test("[unit] GT-ROTATE rotate keeps the id and principal, invalidates the old secret and renews expiry; revoked tokens cannot rotate", () => {
  const dir = temp();
  let now = T0;
  const store = open(join(dir, "tickets.sqlite"), () => now);
  const first = store.mint("Ada", { ttlMs: MIN_GUEST_TTL_MS });
  now = T0 + MIN_GUEST_TTL_MS + 1;
  expect(store.verify(`Bearer ${first.token}`)).toBeNull();
  const rotated = store.rotate(first.record.id);
  expect(rotated.token).toMatch(TOKEN);
  expect(rotated.token).not.toBe(first.token);
  expect(rotated.record).toEqual({ ...first.record, expires: new Date(now + DEFAULT_GUEST_TTL_MS).toISOString() });
  expect(store.verify(`Bearer ${first.token}`)).toBeNull();
  expect(store.verify(`Bearer ${rotated.token}`)).toEqual({ tokenId: first.record.id, scope: `guest:${first.record.id}`, scopes: [...GUEST_SCOPES] });
  expect(store.list()).toHaveLength(1);
  store.revoke(first.record.id);
  const message = errorText(() => store.rotate(first.record.id));
  expect(message).toMatch(/revoked/);
  expect(message).not.toContain(rotated.token.slice(4));
  expect(store.verify(`Bearer ${rotated.token}`)).toBeNull();
  expect(() => store.rotate("gtk_ffffffffffff")).toThrow(/not found/);
  expect(() => store.rotate("nope")).toThrow(/id/);
});

test("[integration] GT-SEPARATION a guest token never passes the decide ApiTokenStore, and a jnj_ token never passes the guest store", () => {
  const dir = temp();
  const guest = open(join(dir, "tickets.sqlite"));
  const { token: guestToken } = guest.mint("Ada");
  // The real decide store, with a real minted token as the positive control.
  const apiPath = join(dir, "api", "api-tokens.json");
  const decide = mintToken(apiPath, "decide");
  const api = new ApiTokenStore(apiPath);
  expect(api.verify(`Bearer ${decide.token}`)).toBe(decide.id);
  expect(api.verify(`Bearer ${guestToken}`)).toBeNull();
  // Even with the guest token's own hash written into a well-formed decide file, the decide verifier refuses it.
  const injected = { format: "jnj-api-tokens/1", tokens: [{ id: "tok_guest", label: "injected", sha256: sha256(guestToken), created: new Date(T0).toISOString() }] };
  writeFileSync(apiPath, JSON.stringify(injected), { mode: 0o600 });
  const reloaded = new ApiTokenStore(apiPath);
  expect(reloaded.verify(`Bearer ${guestToken}`)).toBeNull();
  // The reverse: a decide token is refused by the guest store, even when its hash sits in guest_tokens.
  expect(guest.verify(`Bearer ${decide.token}`)).toBeNull();
  const db = new Database(join(dir, "tickets.sqlite"));
  db.query("INSERT INTO guest_tokens (id, label, sha256, created_at, expires_at, revoked_at, last_used_at, scopes) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)").run(
    "gtk_aaaaaaaaaaaa",
    "decide",
    sha256(decide.token),
    T0,
    T0 + DEFAULT_GUEST_TTL_MS,
    "questions:submit questions:read-own",
  );
  db.close();
  expect(guest.verify(`Bearer ${decide.token}`)).toBeNull();
  expect(guest.verify(`Bearer jng_${decide.token.slice(4)}`)).toBeNull();
});

test("[integration] GT-SECRET the raw token is absent from SQLite bytes, stringified metadata and thrown errors", () => {
  const dir = temp();
  const path = join(dir, "tickets.sqlite");
  const store = open(path);
  const minted = store.mint("Ada");
  const rotated = store.mint("Bo");
  expect(store.verify(`Bearer ${minted.token}`)).not.toBeNull();
  const secrets = [minted.token, minted.token.slice(4), rotated.token, rotated.token.slice(4)];
  const bytes = sqliteBytes(path, dir);
  expect(bytes).toContain(sha256(minted.token));
  for (const s of secrets) expect(bytes).not.toContain(s);
  const metadata = JSON.stringify([minted.record, rotated.record, store.list(), store.verify(`Bearer ${minted.token}`), store.revoke(rotated.record.id)]);
  for (const s of [...secrets, sha256(minted.token), sha256(rotated.token)]) expect(metadata).not.toContain(s);
  chmodSync(path, 0o644);
  const errors = [errorText(() => store.verify(`Bearer ${minted.token}`)), errorText(() => store.rotate(rotated.record.id)), errorText(() => new GuestTokenStore(path))];
  chmodSync(path, 0o600);
  for (const e of errors) for (const s of secrets) expect(e).not.toContain(s);
  expect(errors[0]).toMatch(/permission|mode/);
});

test("[integration] GT-PERMS state is created 0600 in a 0700 directory, and unsafe modes, symlinks and relative paths are refused", () => {
  const dir = temp();
  const path = join(dir, "tickets.sqlite");
  const store = open(path);
  const { token, record } = store.mint("Ada");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o077).toBe(0);
  // A mode widened after open fails closed on the next request, and recovers once fixed.
  chmodSync(path, 0o640);
  expect(() => store.verify(`Bearer ${token}`)).toThrow(/mode/);
  chmodSync(path, 0o600);
  chmodSync(dir, 0o750);
  expect(() => store.list()).toThrow(/mode/);
  chmodSync(dir, 0o700);
  expect(store.verify(`Bearer ${token}`)?.tokenId).toBe(record.id);

  const wide = temp();
  chmodSync(wide, 0o755);
  expect(() => new GuestTokenStore(join(wide, "tickets.sqlite"))).toThrow(/mode/);
  expect(readdirSync(wide)).toEqual([]);

  const readable = temp();
  closeSync(openSync(join(readable, "tickets.sqlite"), "w", 0o644));
  chmodSync(join(readable, "tickets.sqlite"), 0o644);
  expect(() => new GuestTokenStore(join(readable, "tickets.sqlite"))).toThrow(/mode/);

  const linked = temp();
  symlinkSync(path, join(linked, "tickets.sqlite"));
  expect(() => new GuestTokenStore(join(linked, "tickets.sqlite"))).toThrow(/symlink/);

  const parent = temp();
  const real = join(parent, "real");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(parent, "alias"));
  expect(() => new GuestTokenStore(join(parent, "alias", "tickets.sqlite"))).toThrow(/symlink/);
  expect(readdirSync(real)).toEqual([]);

  expect(() => new GuestTokenStore("tickets.sqlite")).toThrow(/absolute/);
  expect(() => new GuestTokenStore(join(dir, "missing", "tickets.sqlite"))).toThrow();
});

test("[integration] GT-TABLES the tickets table and an unrelated table keep their DDL and rows, and TicketStore reopens the file", () => {
  const dir = temp();
  const path = join(dir, "tickets.sqlite");
  const tickets = new TicketStore(path);
  const issued = tickets.issue({ kind: "backstage", show: null, email: "ada@example.com", website: null, idea: "an idea", followUp: false, requestKey: "k".repeat(20) }, T0);
  if (issued.status !== "issued") throw new Error("expected an issued ticket");
  tickets.close();
  const raw = new Database(path);
  raw.exec("CREATE TABLE unrelated (k TEXT PRIMARY KEY, v TEXT); INSERT INTO unrelated VALUES ('a', 'one');");
  const schemaBefore = raw.query<{ name: string; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE name IN ('tickets', 'unrelated') ORDER BY name").all();
  const rowsBefore = raw.query("SELECT * FROM tickets").all();
  raw.close();

  const store = open(path);
  const { token, record } = store.mint("Ada");
  store.close();

  const reopened = new TicketStore(path);
  expect(reopened.count()).toBe(1);
  expect(reopened.issue({ kind: "backstage", show: null, email: "ada@example.com", website: null, idea: "an idea", followUp: false, requestKey: "k".repeat(20) }, T0 + 1)).toEqual({ ...issued, status: "replay" });
  reopened.close();
  const after = new Database(path);
  expect(after.query<{ name: string; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE name IN ('tickets', 'unrelated') ORDER BY name").all()).toEqual(schemaBefore);
  expect(after.query("SELECT * FROM tickets").all()).toEqual(rowsBefore);
  expect(after.query("SELECT * FROM unrelated").all()).toEqual([{ k: "a", v: "one" }]);
  after.close();
  expect(open(path).verify(`Bearer ${token}`)?.tokenId).toBe(record.id);
});

test("[integration] GT-MALFORMED a foreign guest_tokens schema, a non-SQLite file and a malformed row all fail closed", () => {
  const foreign = temp();
  const foreignPath = join(foreign, "tickets.sqlite");
  closeSync(openSync(foreignPath, "w", 0o600));
  const db = new Database(foreignPath);
  db.exec("CREATE TABLE guest_tokens (id TEXT PRIMARY KEY, sha256 TEXT)");
  db.close();
  chmodSync(foreignPath, 0o600);
  expect(() => new GuestTokenStore(foreignPath)).toThrow(/schema/);

  const garbage = temp();
  writeFileSync(join(garbage, "tickets.sqlite"), "not a database, just text that is long enough to read as a header", { mode: 0o600 });
  expect(() => new GuestTokenStore(join(garbage, "tickets.sqlite"))).toThrow();

  const dir = temp();
  const path = join(dir, "tickets.sqlite");
  const store = open(path);
  const good = store.mint("Ada");
  const forged = "jng_" + "Q".repeat(43);
  const raw = new Database(path);
  raw.exec("PRAGMA ignore_check_constraints = ON");
  raw.query("INSERT INTO guest_tokens (id, label, sha256, created_at, expires_at, revoked_at, last_used_at, scopes) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)").run(
    "gtk_bbbbbbbbbbbb",
    "forged",
    sha256(forged),
    T0,
    "never",
    "questions:*",
  );
  raw.close();
  expect(store.verify(`Bearer ${forged}`)).toBeNull();
  expect(() => store.list()).toThrow(/malformed/);
  expect(store.verify(`Bearer ${good.token}`)?.tokenId).toBe(good.record.id);
});

test("[integration] GT-CONCURRENT concurrent mints from separate processes persist distinct identities that all verify", async () => {
  const dir = temp();
  const path = join(dir, "tickets.sqlite");
  const store = open(path, Date.now);
  const procs = 4;
  const each = 20;
  const startAt = Date.now() + 1500;
  const code = [
    `import { GuestTokenStore } from ${JSON.stringify(join(import.meta.dir, "tokens.ts"))};`,
    `const s = new GuestTokenStore(${JSON.stringify(path)});`,
    `while (Date.now() < ${startAt}) {}`,
    `const out = [];`,
    `for (let i = 0; i < ${each}; i++) out.push(s.mint("proc").token);`,
    `s.close();`,
    `console.log(JSON.stringify(out));`,
  ].join("\n");
  const children = Array.from({ length: procs }, () => Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", env: childEnv() }));
  expect(await Promise.all(children.map((c) => c.exited))).toEqual(Array.from({ length: procs }, () => 0));
  const outputs = await Promise.all(children.map((c) => new Response(c.stdout).text()));
  const tokens = outputs.flatMap((o) => {
    const parsed: unknown = JSON.parse(o);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  });
  expect(new Set(tokens).size).toBe(procs * each);
  const records = store.list();
  expect(records).toHaveLength(procs * each);
  expect(new Set(records.map((r) => r.id)).size).toBe(procs * each);
  const principals = tokens.map((t) => store.verify(`Bearer ${t}`)?.tokenId);
  expect(new Set(principals).size).toBe(procs * each);
  expect(principals.every((id) => id !== undefined && records.some((r) => r.id === id))).toBe(true);
}, 30_000);

test("[unit] GT-BOUNDARY the module imports only SQLite and Node built-ins, and makes no network call or spawn", () => {
  const source = readFileSync(join(import.meta.dir, "tokens.ts"), "utf8");
  const imports = [...source.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
  expect(imports).toEqual(["bun:sqlite", "node:crypto", "node:fs", "node:path"]);
  expect(source).not.toMatch(/\bfetch\s*\(|Bun\.spawn|child_process|process\.env/);
});
