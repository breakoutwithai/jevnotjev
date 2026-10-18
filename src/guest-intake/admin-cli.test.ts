import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBackstage } from "../../scripts/backstage-build.ts";
import { runQuestionAdmin } from "./admin-cli.ts";
import { QuestionStore } from "./store.ts";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const KEY = "C".repeat(43);

interface Box { readonly state: string; readonly path: string; readonly env: Record<string, string>; readonly store: QuestionStore }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), "question-admin-"));
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const path = join(state, "tickets.sqlite");
  const store = new QuestionStore(path);
  return { state, path, env: { STATE_DIRECTORY: state }, store };
}

function run(b: Box, args: string[], now = NOW): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runQuestionAdmin(args, b.env, { out: (s) => out.push(s), err: (s) => err.push(s) }, () => now);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function seed(b: Box, at = NOW, key = KEY, question = "Which help desk should this go to?"): string {
  const r = b.store.submit("public", { email: "seeded-q4@example.test", question, replyConsent: true, marketingConsent: false, requestKey: key }, at);
  if (r.status !== "issued") throw new Error(`seed failed: ${r.status}`);
  return r.id;
}

function messageFile(b: Box, text: string): string {
  const file = join(b.state, `msg-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

describe("host permissions", () => {
  test("[unit] GI-14b the CLI refuses a state directory wider than 0700 or a store file wider than 0600", () => {
    const b = box();
    seed(b);
    expect(run(b, ["list"]).code).toBe(0);
    chmodSync(b.state, 0o755);
    const wideDir = run(b, ["list"]);
    expect(wideDir.code).toBe(1);
    expect(wideDir.err).toContain("0700");
    expect(wideDir.out).toBe("");
    chmodSync(b.state, 0o700);
    chmodSync(b.path, 0o644);
    const wideFile = run(b, ["list"]);
    expect(wideFile.code).toBe(1);
    expect(wideFile.err).toContain("0600");
    chmodSync(b.path, 0o600);
    expect(run(b, ["list"]).code).toBe(0);
  });

  test("[unit] GI-14b a missing store or unset state directory is refused, never created", () => {
    const b = box();
    rmSync(b.path);
    expect(run(b, ["list"]).code).toBe(1);
    expect(existsSync(b.path)).toBe(false);
    const out: string[] = [];
    expect(runQuestionAdmin(["list"], {}, { out: (s) => out.push(s), err: () => {} }, () => NOW)).toBe(1);
  });

  test("[unit] GI-14b an unknown command prints usage and exits 2", () => {
    const b = box();
    const r = run(b, ["drop-everything"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage");
  });
});

describe("review commands", () => {
  test("[unit] GI-9b list hides contact and text; show prints the row with terminal control characters escaped", () => {
    const b = box();
    const id = seed(b, NOW, KEY, "Pick a desk \u001b[2J\u001b]0;owned\u0007 now");
    const listed = run(b, ["list"]);
    expect(listed.out).toContain(id);
    expect(listed.out).toContain("pending_review");
    expect(listed.out).not.toContain("seeded-q4@example.test");
    expect(listed.out).not.toContain("Pick a desk");
    const shown = run(b, ["show", id]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("seeded-q4@example.test");
    expect(shown.out).toContain("Pick a desk \\u001b[2J\\u001b]0;owned\\u0007 now");
    expect(shown.out).not.toContain("\u001b");
    expect(run(b, ["show", "Q-000000000000"]).code).toBe(1);
  });

  test("[unit] GI-9b needs_info takes a message file; back to pending_review is an operator transition with a version check", () => {
    const b = box();
    const id = seed(b);
    expect(run(b, ["transition", id, "needs_info", "--version", "1"]).code).toBe(1);
    expect(run(b, ["transition", id, "needs_info", "--version", "1", "--file", messageFile(b, "Please send two fictional examples.")]).code).toBe(0);
    expect(b.store.publicStatus(id, KEY)?.response).toBe("Please send two fictional examples.");
    const stale = run(b, ["transition", id, "pending_review", "--version", "1"]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("stale-version");
    expect(run(b, ["transition", id, "pending_review", "--version", "2"]).code).toBe(0);
    expect(b.store.show(id)?.state).toBe("pending_review");
  });

  test("[unit] GI-9a answer needs an approved row, a source and a non-empty message within the limit", () => {
    const b = box();
    const id = seed(b);
    const file = messageFile(b, "Here is a prompt to try in your own assistant.");
    expect(run(b, ["answer", id, "--version", "1", "--source", "human_reviewed", "--file", file]).code).toBe(1);
    expect(run(b, ["transition", id, "approved", "--version", "1"]).code).toBe(0);
    expect(run(b, ["answer", id, "--version", "2", "--source", "jev", "--file", file]).code).toBe(2);
    expect(run(b, ["answer", id, "--version", "2", "--source", "template", "--file", messageFile(b, "   ")]).code).toBe(1);
    expect(run(b, ["answer", id, "--version", "2", "--source", "template", "--file", messageFile(b, "x".repeat(8001))]).code).toBe(1);
    expect(run(b, ["answer", id, "--version", "2", "--source", "template", "--file", file]).code).toBe(0);
    expect(b.store.publicStatus(id, KEY)).toMatchObject({ state: "answered", response_source: "template" });
  });
});

describe("delete and purge", () => {
  test("[unit] GI-10a delete works on an answered row and leaves only the tombstone", () => {
    const b = box();
    const id = seed(b);
    run(b, ["transition", id, "approved", "--version", "1"]);
    run(b, ["answer", id, "--version", "2", "--source", "human_reviewed", "--file", messageFile(b, "Reply.")]);
    const r = run(b, ["delete", id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(id);
    expect(b.store.counts()).toEqual({ questions: 0, events: 0, tombstones: 1 });
    expect(run(b, ["delete", id]).code).toBe(1);
  });

  test("[unit] GI-10d purge --retention refuses without an approved policy file, and purges by it when present", () => {
    const b = box();
    const old = seed(b, Date.parse("2026-09-01T00:00:00.000Z"));
    const recent = seed(b, NOW, "D".repeat(43));
    const missing = run(b, ["purge", "--retention"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("intake-policy.json");
    const policy = join(b.state, "intake-policy.json");
    for (const bad of ["{}", '{"retentionDays":0}', '{"retentionDays":1.5}', '{"retentionDays":"30"}', "not json"]) {
      writeFileSync(policy, bad, { mode: 0o600 });
      expect([bad, run(b, ["purge", "--retention"]).code]).toEqual([bad, 1]);
    }
    writeFileSync(policy, '{"retentionDays":30}', { mode: 0o600 });
    chmodSync(policy, 0o644);
    expect(run(b, ["purge", "--retention"]).code).toBe(1);
    chmodSync(policy, 0o600);
    expect(b.store.counts().questions).toBe(2);
    const dry = run(b, ["purge", "--retention", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(old);
    expect(dry.out).toContain("1 row");
    expect(b.store.counts().questions).toBe(2);
    expect(run(b, ["purge", "--retention"]).code).toBe(0);
    expect(b.store.list().map((r) => r.id)).toEqual([recent]);
  });

  test("[unit] GI-10d purge --before takes an ISO date and refuses anything else", () => {
    const b = box();
    const old = seed(b, Date.parse("2026-09-01T00:00:00.000Z"));
    expect(run(b, ["purge", "--before", "last month"]).code).toBe(2);
    expect(run(b, ["purge", "--before", "2026-10-01T00:00:00.000Z"]).out).toContain(old);
    expect(b.store.counts()).toEqual({ questions: 0, events: 0, tombstones: 1 });
  });
});

describe("bundled mode", () => {
  test("[integration] GI-14c the built server.js runs --question-admin against private state and binds no port", async () => {
    const root = join(import.meta.dir, "..", "..");
    const out = await buildBackstage(root, false);
    try {
      const b = box();
      const id = seed(b);
      const free = await new Promise<number>((resolve) => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => {
          const address = s.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          s.close(() => resolve(port));
        });
      });
      const shim = mkdtempSync(join(tmpdir(), "model-shim-"));
      const called = join(shim, "called");
      for (const name of ["claude", "codex"]) {
        writeFileSync(join(shim, name), `#!/bin/sh\necho "$0" >> "${called}"\n`, { mode: 0o755 });
      }
      const proc = Bun.spawn(["bun", join(out, "server.js"), "--question-admin", "list"], {
        env: { PATH: `${shim}:${process.env.PATH ?? ""}`, HOME: b.state, STATE_DIRECTORY: b.state, PORT: String(free), JEV_API_KEY: "jev-fake-1", OPENAI_API_KEY: "sk-fake-1", ANTHROPIC_API_KEY: "sk-ant-fake-1", BACKSTAGE_TRIAL_KEY: "trial-fake-1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const killer = setTimeout(() => proc.kill(), 20_000);
      const code = await proc.exited;
      clearTimeout(killer);
      const stdout = await new Response(proc.stdout).text();
      expect([code, await new Response(proc.stderr).text()]).toEqual([0, ""]);
      expect(stdout).toContain(id);
      expect(stdout).not.toContain("listening");
      const bound = await new Promise<boolean>((resolve) => {
        const s = createServer();
        s.once("error", () => resolve(true));
        s.listen(free, "127.0.0.1", () => s.close(() => resolve(false)));
      });
      expect(bound).toBe(false);
      expect(existsSync(called)).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
