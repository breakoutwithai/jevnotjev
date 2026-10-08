// src/backstage/api-tokens.ts minting: concurrent mints from separate processes all persist (a lock file serialises the
// read-modify-write), the write is atomic by rename, and an existing directory and file are tightened to 0700 and 0600.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mintToken, parseTokenFile } from "./api-tokens.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "jnj-tokens-"));
  dirs.push(d);
  return d;
}

test("[integration] API-TOKENS-LOCK concurrent mints from separate processes all persist, and no lock or temp file is left", async () => {
  const path = join(temp(), "state", "api-tokens.json");
  const procs = 6;
  const each = 25;
  // Every process spins until the same instant, then mints in a tight loop, so the read-modify-writes overlap.
  const startAt = Date.now() + 1500;
  const code = [
    `import { mintToken } from ${JSON.stringify(join(import.meta.dir, "api-tokens.ts"))};`,
    `while (Date.now() < ${startAt}) {}`,
    `for (let i = 0; i < ${each}; i++) mintToken(${JSON.stringify(path)}, "proc");`,
  ].join("\n");
  const children = Array.from({ length: procs }, () => Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }));
  const codes = await Promise.all(children.map((c) => c.exited));
  expect(codes).toEqual(Array.from({ length: procs }, () => 0));
  const file = parseTokenFile(readFileSync(path, "utf8"));
  expect(file.tokens).toHaveLength(procs * each);
  expect(new Set(file.tokens.map((t) => t.id)).size).toBe(procs * each);
  expect(readdirSync(dirname(path))).toEqual(["api-tokens.json"]);
}, 30_000);

test("[integration] API-TOKENS-MODE minting into an existing 0755 directory and 0644 file tightens them to 0700 and 0600", () => {
  const dir = join(temp(), "state");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const path = join(dir, "api-tokens.json");
  writeFileSync(path, JSON.stringify({ format: "jnj-api-tokens/1", tokens: [] }), { mode: 0o644 });
  chmodSync(path, 0o644);
  mintToken(path, "mode-test");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(parseTokenFile(readFileSync(path, "utf8")).tokens).toHaveLength(1);
});

test("[integration] API-TOKENS-STALE a stale lock is taken over; a fresh lock held past the wait is an error and the file is untouched", () => {
  const dir = join(temp(), "state");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "api-tokens.json");
  const lock = `${path}.lock`;
  writeFileSync(lock, "999999\n");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  mintToken(path, "after-stale", new Date(), { waitMs: 200, staleMs: 10_000 });
  expect(parseTokenFile(readFileSync(path, "utf8")).tokens).toHaveLength(1);
  writeFileSync(lock, "999999\n");
  expect(() => mintToken(path, "blocked", new Date(), { waitMs: 100, staleMs: 10_000 })).toThrow(/locked/);
  expect(parseTokenFile(readFileSync(path, "utf8")).tokens).toHaveLength(1);
  rmSync(lock);
});
