import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes, scryptSync } from "node:crypto";
import { createHandler } from "./server.ts";
import { credentialFingerprint, signSession } from "./auth.ts";
import { findCredentials } from "./export-check.ts";

const ROOT = "site/backstage/downloads";
const FILES = ["jev-or-not/SKILL.md", "prompts.md", "requests/choice.json", "requests/noul.json", "requests/score.json", "SOURCES.md"];

async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : [relative(ROOT, path)];
  }));
  return nested.flat().sort();
}

export function downloadSafety(text: string): string[] {
  const forbidden = [/\/Users\//i, /~\//, /_reference/i, /challenge/i, /leaderboard/i, /jaylo/i, /keychain/i, /[\u2013\u2014]/];
  return [...forbidden.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source), ...findCredentials(text)];
}

test("[unit] downloads index lists every shipped file and no absent file", async () => {
  const html = await readFile(join(ROOT, "index.html"), "utf8");
  const links = [...html.matchAll(/href="([^"]+\.(?:md|json))"/g)].map((match) => match[1] ?? "").sort();
  expect(links).toEqual(FILES.slice().sort());
  expect(await filesIn(ROOT)).toEqual(["index.html", ...FILES].sort());
});

test("[unit] downloads are public-safe and safety scan detects a planted private marker", async () => {
  for (const path of await filesIn(ROOT)) expect(downloadSafety(await readFile(join(ROOT, path), "utf8"))).toEqual([]);
  const copy = await readFile(join(ROOT, "prompts.md"), "utf8");
  expect(downloadSafety(`${copy}\n_reference`)).not.toEqual([]);
});

test("[unit] downloads Jev bodies parse and contain no credential fields", async () => {
  for (const type of ["choice", "noul", "score"]) {
    const raw = await readFile(join(ROOT, "requests", `${type}.json`), "utf8");
    const body: unknown = JSON.parse(raw);
    expect(JSON.stringify(body)).not.toMatch(/"(?:key|authorization)"\s*:/i);
    expect(JSON.stringify(body)).toContain(`"type":"${type}"`);
  }
});

test("[integration] downloads require a session and serve Markdown and JSON with safe types", async () => {
  const dir = mkdtempSync(join(tmpdir(), "downloads-auth-"));
  const salt = randomBytes(16).toString("hex");
  const hash = `scrypt$${salt}$${scryptSync("password", salt, 64).toString("hex")}`;
  const operatorsPath = join(dir, "operators.json");
  writeFileSync(operatorsPath, JSON.stringify([{ email: "operator@example.com", password_hash: hash }]));
  const secret = randomBytes(32).toString("hex");
  const handler = createHandler({ version: "test", staticRoot: "site", origin: "http://localhost:8787", requireSession: true, auth: { sessionSecret: secret, operatorsPath } });
  try {
    const cookie = signSession({ email: "operator@example.com", auth: "password", iat: Date.now(), exp: Date.now() + 60_000, sid: randomBytes(24).toString("hex"), cred: credentialFingerprint(hash) }, secret);
    for (const path of ["/backstage/downloads/", "/backstage/downloads/jev-or-not/SKILL.md", "/backstage/downloads/requests/choice.json"]) {
      const out = await handler(new Request(`http://localhost:8787${path}`));
      expect([302, 401]).toContain(out.status);
      const inside = await handler(new Request(`http://localhost:8787${path}`, { headers: { cookie: `backstage_session=${cookie}` } }));
      expect(inside.status).toBe(200);
      expect(inside.headers.get("x-content-type-options")).toBe("nosniff");
      expect(inside.headers.get("content-security-policy")).toContain("default-src 'self'");
      if (path.endsWith(".md")) expect(inside.headers.get("content-type")).toContain("text/markdown");
      if (path.endsWith(".json")) expect(inside.headers.get("content-type")).toContain("application/json");
    }
  } finally { handler.close(); rmSync(dir, { recursive: true, force: true }); }
});
