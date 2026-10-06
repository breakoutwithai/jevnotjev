// Allowlist extraction for .deploy/tests/capture-fixtures.sh (#86). The capture never writes raw
// `nginx -T`, snippet text or response bodies; it writes only the facts below, each parsed and
// validated against a strict shape. Anything that does not parse, or a value outside its shape,
// is an error (the capture then fails), and error messages never echo the offending text.
//
//   bun scripts/capture-extract.ts nginx <auth yes|session|no|unknown> <snippet sha256>   < nginx -T text
//   bun scripts/capture-extract.ts health                                         < health body
import { readFileSync } from "node:fs";

export type NginxServer = { serverNames: string[]; listen: number[] };
export type NginxFacts = { user: string | null; servers: NginxServer[] };
export type HealthFacts = { version: string; protocol: string; catalogVersion: string; trial: { available: boolean } };

type Token = { kind: "word"; value: string } | { kind: "punct"; value: ";" | "{" | "}" };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "#") {
      while (i < text.length && text.charAt(i) !== "\n") i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === ";" || c === "{" || c === "}") {
      tokens.push({ kind: "punct", value: c });
      i++;
    } else if (c === '"' || c === "'") {
      let value = "";
      i++;
      while (i < text.length && text.charAt(i) !== c) {
        if (text.charAt(i) === "\\" && i + 1 < text.length) i++;
        value += text.charAt(i);
        i++;
      }
      if (i >= text.length) throw new Error("nginx: unterminated quoted value");
      i++;
      tokens.push({ kind: "word", value });
    } else {
      let value = "";
      while (i < text.length && !/[\s;{}"'#]/.test(text.charAt(i))) {
        value += text.charAt(i);
        i++;
      }
      tokens.push({ kind: "word", value });
    }
  }
  return tokens;
}

const HOST = /^(\*\.)?[A-Za-z0-9_][A-Za-z0-9_.-]*(\.\*)?$/;
const LISTEN = /^(?:\[[0-9A-Fa-f:]+\]:|[0-9.]+:|\*:)?(\d{1,5})$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

export function extractNginx(text: string): NginxFacts {
  const facts: NginxFacts = { user: null, servers: [] };
  const stack: Array<NginxServer | null> = [];
  let words: string[] = [];
  for (const token of tokenize(text)) {
    if (token.kind === "word") {
      words.push(token.value);
      continue;
    }
    if (token.value === "{") {
      const server = words.length === 1 && words[0] === "server" ? { serverNames: [], listen: [] } : null;
      if (server !== null) facts.servers.push(server);
      stack.push(server);
    } else if (token.value === "}") {
      if (words.length > 0 || stack.length === 0) throw new Error("nginx: unbalanced braces");
      stack.pop();
    } else {
      directive(words, stack, facts);
    }
    words = [];
  }
  if (words.length > 0) throw new Error("nginx: a statement is missing its ';'");
  if (stack.length > 0) throw new Error("nginx: unbalanced braces");
  return facts;
}

function directive(words: string[], stack: Array<NginxServer | null>, facts: NginxFacts): void {
  const [name, ...args] = words;
  const server = stack.at(-1) ?? null;
  if (stack.length === 0 && name === "user") {
    const user = args[0];
    if (args.length < 1 || args.length > 2 || user === undefined || !USER.test(user)) throw new Error("nginx: the user directive is not a plain user name");
    facts.user = user;
    return;
  }
  if (server === null) return;
  const index = facts.servers.indexOf(server) + 1;
  if (name === "server_name") {
    for (const value of args) {
      if (value === "") continue;
      if (!HOST.test(value)) throw new Error(`nginx: a server_name value in server block ${index} is not a plain hostname`);
      server.serverNames.push(value);
    }
  } else if (name === "listen") {
    const port = args[0]?.match(LISTEN)?.[1];
    if (port === undefined) throw new Error(`nginx: a listen value in server block ${index} is not a port`);
    const n = Number(port);
    if (!server.listen.includes(n)) server.listen.push(n);
  }
}

export function nginxRecord(text: string, auth: string, sha256: string): string {
  if (auth !== "yes" && auth !== "session" && auth !== "no" && auth !== "unknown") throw new Error("snippet auth must be yes, session, no or unknown");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("snippet sha256 must be 64 hex characters");
  const facts = extractNginx(text);
  return JSON.stringify({ user: facts.user, servers: facts.servers, snippet: { auth, sha256 } }, null, 2);
}

function field(obj: object, key: string, shape: RegExp): string {
  const value: unknown = Reflect.get(obj, key);
  if (typeof value !== "string" || !shape.test(value)) throw new Error(`health: ${key} is missing or not in its expected shape`);
  return value;
}

export function extractHealth(body: string): HealthFacts {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error("health: the body is not JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("health: the body is not a JSON object");
  const trial: unknown = Reflect.get(raw, "trial");
  const available: unknown = typeof trial === "object" && trial !== null ? Reflect.get(trial, "available") : undefined;
  if (typeof available !== "boolean") throw new Error("health: trial.available is missing or not a boolean");
  return {
    version: field(raw, "version", /^[0-9A-Za-z._-]{1,64}$/),
    protocol: field(raw, "protocol", /^[a-z0-9._/-]{1,32}$/),
    catalogVersion: field(raw, "catalogVersion", /^[0-9A-Za-z._-]{1,32}$/),
    trial: { available },
  };
}

function main(argv: string[]): number {
  const input = readFileSync(0, "utf8");
  try {
    if (argv[0] === "nginx" && argv.length === 3) {
      console.log(nginxRecord(input, argv[1] ?? "", argv[2] ?? ""));
      return 0;
    }
    if (argv[0] === "health" && argv.length === 1) {
      console.log(JSON.stringify(extractHealth(input)));
      return 0;
    }
    console.error("usage: capture-extract.ts nginx <auth> <sha256> | health   (input on stdin)");
    return 2;
  } catch (e) {
    console.error(e instanceof Error ? e.message : "capture-extract: failed");
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
