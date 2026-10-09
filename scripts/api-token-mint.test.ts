// scripts/api-token-mint.ts and src/backstage/api-tokens.ts: an operator-minted token is printed once and stored only as
// its sha256, in a 0600 file; the store accepts it, rejects anything else, and sees a new token without a restart.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_TOKENS_ENV, ApiTokenStore, apiTokensPath, hashToken, isInside, parseTokenFile } from "../src/backstage/api-tokens.ts";
import { mintMain } from "./api-token-mint.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "jnj-mint-"));
  dirs.push(d);
  return d;
}

function mint(env: Record<string, string>, label = "ci-bot"): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = mintMain(["--label", label], env, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

test("[integration] API-MINT-1 prints the token once on stdout; the 0600 state file holds its sha256 and never the token", () => {
  const path = join(temp(), "state", "api-tokens.json");
  const done = mint({ [API_TOKENS_ENV]: path });
  expect(done.code).toBe(0);
  expect(done.out).toHaveLength(1);
  const token = done.out[0] ?? "";
  expect(token).toMatch(/^jnj_[A-Za-z0-9_-]{43}$/);
  expect(done.err.join("\n")).not.toContain(token);
  const text = readFileSync(path, "utf8");
  expect(text).not.toContain(token);
  expect(text).not.toContain(token.slice(4));
  const file = parseTokenFile(text);
  expect(file.tokens).toHaveLength(1);
  expect(file.tokens[0]?.sha256).toBe(hashToken(token));
  expect(file.tokens[0]?.label).toBe("ci-bot");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(path, "..")).mode & 0o077).toBe(0);
});

test("[integration] API-MINT-2 the store accepts each minted token, rejects others, and sees a new token without a restart", () => {
  const path = join(temp(), "api-tokens.json");
  const store = new ApiTokenStore(path);
  const first = mint({ [API_TOKENS_ENV]: path }).out[0] ?? "";
  expect(store.verify(`Bearer ${first}`)).toMatch(/^tok_[a-f0-9]{12}$/);
  const second = mint({ [API_TOKENS_ENV]: path }, "second").out[0] ?? "";
  expect(store.verify(`Bearer ${second}`)).not.toBe(store.verify(`Bearer ${first}`));
  expect(store.verify(`Bearer ${second}`)).not.toBeNull();
  // The altered last character must differ from the real one: a token ending in "A" made "...A" the valid token (1 in 64).
  const altered = `${first.slice(0, -1)}${first.endsWith("A") ? "B" : "A"}`;
  expect(altered).not.toBe(first);
  for (const bad of [null, "", first, `Bearer ${altered}`, `bearer ${first}`, `Bearer ${hashToken(first)}`, `Bearer jnj_${"A".repeat(43)}`]) {
    expect(store.verify(bad)).toBeNull();
  }
  expect(new ApiTokenStore(null).verify(`Bearer ${first}`)).toBeNull();
  writeFileSync(path, "{broken");
  expect(store.verify(`Bearer ${first}`)).toBeNull();
});

test("[unit] API-MINT-3 usage errors, a bad label, and the default state path outside the repo", () => {
  const path = join(temp(), "api-tokens.json");
  expect(mintMain([], { [API_TOKENS_ENV]: path }, { out: () => {}, err: () => {} })).toBe(2);
  expect(mintMain(["--label"], { [API_TOKENS_ENV]: path }, { out: () => {}, err: () => {} })).toBe(2);
  expect(mint({ [API_TOKENS_ENV]: path }, "bad/label").code).toBe(1);
  expect(apiTokensPath({ [API_TOKENS_ENV]: "/srv/x/tokens.json" })).toBe("/srv/x/tokens.json");
  expect(apiTokensPath({ STATE_DIRECTORY: "/var/lib/backstage" })).toBe("/var/lib/backstage/api-tokens.json");
  const fallback = apiTokensPath({});
  expect(fallback.endsWith(join(".jevnotjev", "api-tokens.json"))).toBe(true);
  expect(isInside(fallback, join(import.meta.dir, ".."))).toBe(false);
  expect(isInside("/a/site/t.json", "/a/site")).toBe(true);
  expect(isInside("/a/site-other/t.json", "/a/site")).toBe(false);
});
