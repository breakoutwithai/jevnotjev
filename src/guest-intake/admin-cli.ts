// Operator CLI for the guest question queue (#253). It ships inside the Backstage bundle, so on the host it runs as
//
//   sudo -u jevnotjev-backstage env STATE_DIRECTORY=/var/lib/jevnotjev-backstage \
//     /usr/local/bin/bun /var/www/jevnotjev-backstage-current/server.js --question-admin <command>
//
// server.ts dispatches here before it reads any server configuration, so this mode binds no port and reads no key.
// It refuses to run unless the state directory is 0700 and the store file 0600, both owned by the running user, and it
// never creates the store. A Backstage session is not an admin; this CLI is the only review surface.
//
//   list                                                     ids, states, versions; no contact or question text
//   show <id>                                                one row, control characters escaped
//   transition <id> <state> --version <n> [--file <message>] [--source human_reviewed|template]
//   answer <id> --version <n> --source human_reviewed|template --file <message>
//   delete <id>                                              any state; leaves only a tombstone
//   purge --before <ISO time> [--dry-run]
//   purge --retention [--dry-run]                            needs intake-policy.json {"retentionDays": n} (0600)
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isQuestionState, isResponseSource, QUESTION_ID, type ResponseSource } from "./contract.ts";
import { QuestionStore } from "./store.ts";

export interface AdminIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = "usage: --question-admin list | show <id> | transition <id> <state> --version <n> [--file <path>] [--source <s>] | answer <id> --version <n> --source human_reviewed|template --file <path> | delete <id> | purge (--before <ISO time> | --retention) [--dry-run]";
const ACTOR = "operator:cli";
const MAX_MESSAGE_FILE = 65_536;
const POLICY_FILE = "intake-policy.json";
const DAY_MS = 86_400_000;

/** The CLI arguments when `server.js --question-admin ...` was invoked, else null. Only the first argument selects it. */
export function questionAdminArgs(argv: readonly string[]): string[] | null {
  return argv[2] === "--question-admin" ? argv.slice(3) : null;
}

/** Control characters (newline included) as \uXXXX, so stored text cannot drive the operator's terminal or fake a line. */
export function escapeForTerminal(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Owned by this user, the expected type, and exactly `mode`; else the refusal text. */
function privateEntry(path: string, kind: "directory" | "file", mode: number): string | null {
  let stat;
  try { stat = lstatSync(path); }
  catch { return `${path} does not exist`; }
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) return `${path} is not a ${kind}`;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) return `${path} is not owned by the running user`;
  if ((stat.mode & 0o777) !== mode) return `${path} must be mode ${mode.toString(8).padStart(4, "0")}`;
  return null;
}

function flags(args: readonly string[]): { positional: string[]; named: Map<string, string>; switches: Set<string> } | null {
  const positional: string[] = [];
  const named = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--dry-run" || arg === "--retention") switches.add(arg);
    else if (arg === "--version" || arg === "--file" || arg === "--source" || arg === "--before") {
      const value = args[i + 1];
      if (value === undefined || named.has(arg)) return null;
      named.set(arg, value);
      i++;
    } else if (arg.startsWith("--")) return null;
    else positional.push(arg);
  }
  return { positional, named, switches };
}

function readMessage(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_MESSAGE_FILE) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function retentionCutoff(dir: string, now: number, io: AdminIo): string | null {
  const path = join(dir, POLICY_FILE);
  const refused = privateEntry(path, "file", 0o600);
  if (refused !== null) { io.err(`refused: ${refused}; write ${POLICY_FILE} only once a retention period is approved`); return null; }
  let days: unknown;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    days = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? Reflect.get(raw, "retentionDays") : undefined;
  } catch {
    days = undefined;
  }
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1) { io.err(`refused: ${POLICY_FILE} must hold {"retentionDays": <positive integer>}`); return null; }
  return new Date(now - days * DAY_MS).toISOString();
}

export function runQuestionAdmin(args: readonly string[], env: Readonly<Record<string, string | undefined>>, io: AdminIo, now: () => number): number {
  const parsed = flags(args);
  const command = parsed?.positional[0];
  if (parsed === null || command === undefined || !["list", "show", "transition", "answer", "delete", "purge"].includes(command)) { io.err(USAGE); return 2; }
  const explicit = env.BACKSTAGE_TICKETS_PATH;
  const stateDir = env.STATE_DIRECTORY;
  const path = explicit !== undefined && explicit !== "" ? explicit : stateDir !== undefined && stateDir !== "" ? join(stateDir, "tickets.sqlite") : null;
  if (path === null) { io.err("refused: set STATE_DIRECTORY (or BACKSTAGE_TICKETS_PATH) to the service state"); return 1; }
  const dir = dirname(path);
  const refused = privateEntry(dir, "directory", 0o700) ?? privateEntry(path, "file", 0o600);
  if (refused !== null) { io.err(`refused: ${refused}`); return 1; }

  const [, id, target] = parsed.positional;
  const version = Number(parsed.named.get("--version"));
  const store = new QuestionStore(path);
  try {
    if (command === "list") {
      const rows = store.list();
      for (const r of rows) io.out(`${r.id}  ${r.state}  v${r.version}  ${r.scope}  ${r.created_at}`);
      io.out(`${rows.length} row${rows.length === 1 ? "" : "s"}`);
      return 0;
    }
    if (command === "purge") {
      const dryRun = parsed.switches.has("--dry-run");
      const before = parsed.named.get("--before");
      const byRetention = parsed.switches.has("--retention");
      if (byRetention === (before !== undefined)) { io.err(USAGE); return 2; }
      let cutoff: string | null;
      if (before !== undefined) {
        const at = Date.parse(before);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(before) || Number.isNaN(at)) { io.err("usage: --before takes an ISO time such as 2026-10-01T00:00:00.000Z"); return 2; }
        cutoff = new Date(at).toISOString();
      } else cutoff = retentionCutoff(dir, now(), io);
      if (cutoff === null) return 1;
      const ids = store.purgeBefore(cutoff, byRetention ? "retention" : "operator", now(), dryRun);
      for (const each of ids) io.out(each);
      io.out(`${ids.length} row${ids.length === 1 ? "" : "s"} ${dryRun ? "would be purged" : "purged"} (created before ${cutoff})`);
      return 0;
    }
    if (id === undefined || !QUESTION_ID.test(id)) { io.err(USAGE); return 2; }
    if (command === "show") {
      const row = store.show(id);
      if (row === null) { io.err(`not-found: ${id}`); return 1; }
      for (const [key, value] of Object.entries(row)) io.out(`${key}: ${escapeForTerminal(value === null ? "-" : String(value))}`);
      return 0;
    }
    if (command === "delete") {
      if (!store.remove(id, "operator", now())) { io.err(`not-found: ${id}`); return 1; }
      io.out(`deleted ${id}; tombstone kept`);
      return 0;
    }
    if (!Number.isInteger(version) || version < 1) { io.err(USAGE); return 2; }
    const rawSource = parsed.named.get("--source") ?? (command === "transition" ? "human_reviewed" : undefined);
    let source: ResponseSource | undefined;
    if (rawSource !== undefined) {
      if (!isResponseSource(rawSource)) { io.err("usage: --source is human_reviewed or template"); return 2; }
      source = rawSource;
    }
    const file = parsed.named.get("--file");
    const text = file === undefined ? undefined : readMessage(file);
    if (text === null) { io.err(`refused: cannot read message file ${file ?? ""}`); return 1; }
    const message = text !== undefined && source !== undefined ? { text, source } : undefined;
    let result;
    if (command === "answer") {
      if (source === undefined || message === undefined) { io.err(USAGE); return 2; }
      result = store.answer(id, version, ACTOR, now(), message.text, message.source);
    } else {
      if (!isQuestionState(target)) { io.err("usage: state is pending_review, needs_info, approved, declined or answered"); return 2; }
      result = store.transition(id, target, version, ACTOR, now(), message);
    }
    if (!result.ok) { io.err(`refused: ${result.reason}`); return 1; }
    io.out(`${id} now v${result.version}`);
    return 0;
  } finally {
    store.close();
  }
}
