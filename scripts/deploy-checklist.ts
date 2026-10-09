// The release checklist question ship.sh asks Jev before any module deploys.
//
//   bun scripts/deploy-checklist.ts --checklist <file> [--env-file <.env.local>]
//
// <file> holds the mechanical results ship.sh assembled, one item per line. The script prints the
// checklist, asks Jev one noul (yes/no) question through the repo's own client (src/decide/jev.ts,
// pinned model, answer checked by src/jev-answer.ts), and prints Jev's answer.
// Exit 0 on yes; 1 on no, an unreachable API, an invalid answer or no key; 2 on usage.
//
// Key: JEV_API_KEY, else TYPESAFE_API_KEY (keysFromEnv) from the process env; else the same two
// names from --env-file; else JEV_API_KEY_JAYLO from --env-file (the name that file carries,
// ~/.claude/scripts/jaylo-jev.sh). Only the variable NAME is ever printed.
import { readFileSync } from "node:fs";
import { keysFromEnv } from "../src/decide/cli-args.ts";
import { JEV_URL, jevBody, jevHeaders, parseJev } from "../src/decide/jev.ts";
import { JEV_PIN } from "../src/jev-answer.ts";
import type { DecideFetch, QuestionSpec } from "../src/decide/types.ts";

export const READY_QUESTION: QuestionSpec = {
  name: "ready",
  type: "noul",
  instructions:
    "This is the pre-deploy checklist for a production release. Is the release ready to deploy given this checklist? Answer yes only when every check passed and nothing in it blocks the deploy.",
};

export const JAYLO_KEY_ENV = "JEV_API_KEY_JAYLO";
const TIMEOUT_MS = 60_000;

export type KeySource = { readonly key: string; readonly source: string };

/**
 * Parses KEY=VALUE lines (optional `export `). A value opening with a quote runs to the matching
 * quote, keeping any `#` inside; anything after it (a ` # comment`) is dropped. An unquoted value
 * ends at whitespace followed by `#`, and is trimmed. An unterminated quote is kept as written.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m === null) continue;
    const name = m[1];
    if (name === undefined) continue;
    const rest = (m[2] ?? "").trimStart();
    const quote = rest[0];
    const end = quote === '"' || quote === "'" ? rest.indexOf(quote, 1) : -1;
    if (end > 0) {
      out[name] = rest.slice(1, end);
    } else {
      const comment = rest.search(/(^|\s)#/);
      out[name] = (comment === -1 ? rest : rest.slice(0, comment)).trim();
    }
  }
  return out;
}

/** The Jev key and the name of the variable it came from; null when none is set. */
export function resolveKey(env: Readonly<Record<string, string | undefined>>, envFile: string | null): KeySource | null {
  const fromEnv = keysFromEnv(env).jev;
  if (fromEnv !== undefined) return { key: fromEnv, source: env.JEV_API_KEY ? "JEV_API_KEY (process env)" : "TYPESAFE_API_KEY (process env)" };
  if (envFile === null) return null;
  const file = parseEnvFile(envFile);
  const fromFile = keysFromEnv(file).jev;
  if (fromFile !== undefined) return { key: fromFile, source: file.JEV_API_KEY ? "JEV_API_KEY (env file)" : "TYPESAFE_API_KEY (env file)" };
  const jaylo = file[JAYLO_KEY_ENV];
  if (jaylo !== undefined && jaylo !== "") return { key: jaylo, source: `${JAYLO_KEY_ENV} (env file)` };
  return null;
}

export type ChecklistResult = { readonly code: 0 | 1; readonly lines: readonly string[] };

/** Asks Jev whether the release is ready. Never throws; never puts the key in `lines`. */
export async function askReady(checklist: string, key: KeySource | null, doFetch: DecideFetch): Promise<ChecklistResult> {
  const items = checklist.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  const lines: string[] = ["Release checklist:", ...items.map((l) => `  ${l}`)];
  if (items.length === 0) return { code: 1, lines: [...lines, "jev: not asked (the checklist is empty)"] };
  if (key === null) {
    return { code: 1, lines: [...lines, "jev: not asked (no key: set JEV_API_KEY or TYPESAFE_API_KEY, or pass --env-file; --no-jev skips the question)"] };
  }
  const body = jevBody(`Release checklist:\n${items.join("\n")}`, [READY_QUESTION]);
  let http: number;
  let response: unknown;
  try {
    const res = await doFetch(JEV_URL, { method: "POST", headers: jevHeaders(key.key), body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    http = res.status;
    response = await res.json().catch(() => null);
  } catch (e) {
    const reason = e instanceof Error ? e.name : "error";
    return { code: 1, lines: [...lines, `jev: unreachable (${reason}); key from ${key.source}`] };
  }
  const result = parseJev(http, response, body, [READY_QUESTION]).results[0];
  if (result === undefined || result.outcome !== "answered") {
    return { code: 1, lines: [...lines, `jev: no valid answer (${result?.reason ?? "no result"}); key from ${key.source}`] };
  }
  const p = typeof result.probability === "number" ? result.probability.toFixed(3) : "?";
  const answer = result.output === "yes" ? "yes" : "no";
  return { code: answer === "yes" ? 0 : 1, lines: [...lines, `jev: ${answer} (p(yes)=${p}, ${JEV_PIN}); key from ${key.source}`] };
}

export type Args = { readonly checklist: string; readonly envFile: string | null };

export function parseCliArgs(argv: readonly string[]): Args | string {
  let checklist: string | null = null;
  let envFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if ((a === "--checklist" || a === "--env-file") && (v === undefined || v === "")) return `${a} needs a path`;
    if (a === "--checklist" && v !== undefined) { checklist = v; i++; }
    else if (a === "--env-file" && v !== undefined) { envFile = v; i++; }
    else return `unknown argument: ${a ?? ""}`;
  }
  if (checklist === null) return "--checklist <file> is required";
  return { checklist, envFile };
}

function readOptional(path: string | null): string | null {
  if (path === null) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(`deploy-checklist: ${args}\nusage: bun scripts/deploy-checklist.ts --checklist <file> [--env-file <.env.local>]`);
    return 2;
  }
  const checklist = readOptional(args.checklist);
  if (checklist === null) {
    console.error(`deploy-checklist: cannot read ${args.checklist}`);
    return 1;
  }
  const doFetch: DecideFetch = (url, init) =>
    fetch(url, { method: init.method, headers: { ...init.headers }, body: init.body, ...(init.signal !== undefined ? { signal: init.signal } : {}) });
  const result = await askReady(checklist, resolveKey(process.env, readOptional(args.envFile)), doFetch);
  for (const line of result.lines) console.log(line);
  return result.code;
}

if (import.meta.main) process.exit(await main());
