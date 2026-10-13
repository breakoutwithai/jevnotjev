import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes, scryptSync } from "node:crypto";
import { createHandler } from "./server.ts";
import { credentialFingerprint, signSession } from "./auth.ts";
import { findCredentials } from "./export-check.ts";
import { JEV_PIN, specsFromRequest } from "../jev-answer.ts";
import { jevBody } from "../decide/jev.ts";
import type { QuestionSpec } from "../decide/types.ts";

const ROOT = "site/backstage/downloads";
const FILES = ["jev-or-not/SKILL.md", "prompts.md", "requests/choice.json", "requests/noul.json", "requests/score.json", "SOURCES.md"];
const PUBLIC_SKILL_PATH = ".claude/skills/jev-or-not/SKILL.md";
const REQUESTS: readonly { readonly name: string; readonly state: string; readonly spec: QuestionSpec }[] = [
  {
    name: "choice",
    state: "Customer message: I cannot sign in to my account after resetting my password.",
    spec: { name: "queue", type: "choice", instructions: "Which queue should receive this support message?", choices: [
      { name: "billing", definition: "Payment, invoice, or refund issue." },
      { name: "technical", definition: "Product failure or error unrelated to account access." },
      { name: "account", definition: "Sign-in or profile access issue." },
      { name: "none", definition: "No listed queue fits; send to a person." },
    ] },
  },
  {
    name: "noul",
    state: "Customer message: Please refund my duplicate payment for order 1042.",
    spec: { name: "refund_requested", type: "noul", instructions: "Does this support message explicitly ask for a refund?" },
  },
  {
    name: "score",
    state: "Support message: Our whole team cannot use the checkout today. Please help now.",
    spec: { name: "urgency", type: "score", instructions: "How urgent is this support message?", levels: [
      { label: "routine", description: "General question with no deadline." },
      { label: "blocked", description: "One task is blocked but a workaround exists." },
      { label: "critical", description: "The whole team is blocked today." },
    ] },
  },
];

async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : [relative(ROOT, path)];
  }));
  return nested.flat().sort();
}

export function downloadSafety(text: string): string[] {
  const forbidden = [/\/Users\//i, /~\//, /_reference/i, /challenge/i, /leaderboard/i, /ranking/i, /winning/i, /buddy/i, /skool/i, /\/skills\//i, /operator/i, /jaylo/i, /keychain/i, /[\u2013\u2014]/];
  const scanned = text.replaceAll(PUBLIC_SKILL_PATH, "");
  return [...forbidden.filter((pattern) => pattern.test(scanned)).map((pattern) => pattern.source), ...findCredentials(text)];
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
  for (const marker of ["ranking", "winning", "buddy", "skool", "/skills/private/", "operator"]) {
    expect(downloadSafety(`${copy}\n${marker}`)).not.toEqual([]);
  }
  expect(copy).toContain("${JEV_API_KEY}");
  expect(copy).not.toMatch(/Bearer\s+(?!\$)\S/i);
});

test("[unit] downloads Jev bodies match the production builder and parser", async () => {
  for (const { name, state, spec } of REQUESTS) {
    const raw = await readFile(join(ROOT, "requests", `${name}.json`), "utf8");
    const body: unknown = JSON.parse(raw);
    expect(JSON.stringify(body)).not.toMatch(/"(?:key|authorization)"\s*:/i);
    expect(body).toHaveProperty("model", JEV_PIN);
    expect(specsFromRequest(body).ok).toBe(true);
    expect(body).toEqual(jevBody(state, [spec]));
  }
});

test("[unit] downloads parser rejects a choice body with choices instead of criteria", async () => {
  const raw = await readFile(join(ROOT, "requests/choice.json"), "utf8");
  const changed: unknown = JSON.parse(raw.replace('"criteria":', '"choices":'));
  expect(specsFromRequest(changed)).toEqual({ ok: false, questionId: "queue", reason: "criteria" });
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
    for (const path of ["/backstage/downloads/", ...FILES.map((file) => `/backstage/downloads/${file}`)]) {
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
