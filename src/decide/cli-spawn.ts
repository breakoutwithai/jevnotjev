// The real spawn for the llm arm's claude-cli transport: runs from a fresh empty temp directory (so no CLAUDE.md is
// discovered), prompt on stdin, stdout captured, stderr dropped (it is never echoed into a row). Tests inject a fake.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecideSpawn } from "./llm.ts";

export const CLI_TIMEOUT_MS = 120_000;

const ENV_ALLOW: ReadonlySet<string> = new Set(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SHELL"]);
const ENV_PREFIXES: readonly string[] = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_"];
const ENV_SECRET = /KEY|TOKEN|SECRET/i;

/** The child's environment: an allowlist, so provider keys in the parent (OPENAI_API_KEY, the Jev key, ...) never reach `claude`. */
export function cliEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const allowed = ENV_ALLOW.has(name) || (ENV_PREFIXES.some((p) => name.startsWith(p)) && !ENV_SECRET.test(name));
    if (allowed) out[name] = value;
  }
  return out;
}

export const bunSpawn: DecideSpawn = async (argv, stdin) => {
  const dir = await mkdtemp(join(tmpdir(), "jnj-decide-"));
  try {
    const proc = Bun.spawn([...argv], { cwd: dir, env: cliEnv(process.env), stdin: new Response(stdin), stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), CLI_TIMEOUT_MS);
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { exitCode, stdout };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** The `claude` binary on PATH, or null. */
export function whichClaude(): string | null {
  return Bun.which("claude");
}
