// C2 for the guest question journey (#253, #256): an off-host end-to-end check of the real build.
//
//   bun scripts/guest-intake/verify.ts --local
//
// Builds the Backstage release with scripts/backstage-build.ts, starts the built server.js on 127.0.0.1 against a fresh
// private state directory, drives the host CLI through the built server.js --question-admin, and talks to the guest
// routes over HTTP and through the guest MCP adapter as a real stdio subprocess, using the MCP SDK client. The adapter's
// production entrypoint keeps its fixed origin: the loopback origin reaches createGuestMcp only through a generated
// temporary shim, and a separate check runs the production entrypoint itself with a recording fetch stub.
//
// Every server, admin CLI and adapter process is started with a --preload trap that records any fetch to a non-loopback host and
// any process spawn, and refuses both before they happen. Fake provider keys sit in the server's environment and fake
// claude/codex binaries sit first on its PATH. A positive control sends one decide request with a fake key and requires
// the trap to record it, so a trap that records nothing cannot pass. No request leaves 127.0.0.1.
//
// Prints one line per named check, the counts, and GUEST_INTAKE_PASS only when every check passed. No token, email,
// question text or status code is printed. Exit 0 on pass, 1 on any failure, 2 on bad arguments.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mintToken } from "../../src/backstage/api-tokens.ts";
import { cookie, credentialFingerprint, signSession } from "../../src/backstage/auth.ts";
import { NEEDS_INFO_TEMPLATES } from "../../src/guest-intake/contract.ts";
import { GUEST_TOOL_NAMES, TOKEN_ENV } from "../../src/guest-intake/mcp.ts";
import { GuestTokenStore } from "../../src/guest-intake/tokens.ts";
import { buildBackstage } from "../backstage-build.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const MCP_ENTRY = join(ROOT, "src", "guest-intake", "mcp.ts");
const PRODUCTION_ORIGIN = "https://jevnotjev.breakoutwithai.com";
const GUEST = "/api/v1/guest/questions";

if (process.argv.length !== 3 || process.argv[2] !== "--local") {
  process.stderr.write("usage: bun scripts/guest-intake/verify.ts --local\n");
  process.exit(2);
}

// ---- reporting ----

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): boolean {
  if (ok) passed++;
  else failed++;
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` (${detail})`}\n`);
  return ok;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  let at: unknown = value;
  for (const key of path) at = typeof key === "number" ? (Array.isArray(at) ? at[key] : undefined) : isRecord(at) ? at[key] : undefined;
  return at;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parse(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw);
    return value;
  } catch {
    return null;
  }
}

function newKey(): string {
  return randomBytes(32).toString("base64url");
}

// ---- scratch space ----

const scratch = mkdtempSync(join(tmpdir(), "gi-verify-"));
chmodSync(scratch, 0o700);
const state = join(scratch, "state");
mkdirSync(state, { mode: 0o700 });
chmodSync(state, 0o700);
const tickets = join(state, "tickets.sqlite");
const work = join(scratch, "work");
mkdirSync(work, { mode: 0o700 });
const shimBin = join(scratch, "bin");
mkdirSync(shimBin, { mode: 0o700 });
const modelCalls = join(scratch, "model-cli-calls");
for (const name of ["claude", "codex"]) writeFileSync(join(shimBin, name), `#!/bin/sh\necho "$0" >> "${modelCalls}"\n`, { mode: 0o755 });

const TRAP = join(work, "trap.mjs");
writeFileSync(
  TRAP,
  [
    `import { appendFileSync } from "node:fs";`,
    `import childProcess from "node:child_process";`,
    `const file = process.env.GI_TRAP_FILE;`,
    `const record = (entry) => appendFileSync(file, JSON.stringify(entry) + "\\n");`,
    `const loopback = (host) => host === "127.0.0.1" || host === "[::1]" || host === "localhost";`,
    `const realFetch = globalThis.fetch;`,
    `globalThis.fetch = Object.assign(async (input, init) => {`,
    `  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);`,
    `  if (loopback(url.hostname)) return realFetch(input, init);`,
    `  record({ kind: "fetch", host: url.host });`,
    `  throw new Error("trap: outbound request refused");`,
    `}, { preconnect: realFetch.preconnect });`,
    `const refuse = (kind) => (...args) => { record({ kind, command: String(Array.isArray(args[0]) ? args[0][0] : (args[0] && args[0].cmd ? args[0].cmd[0] : args[0])) }); throw new Error("trap: spawn refused"); };`,
    `const hooks = [];`,
    `for (const name of ["spawn", "spawnSync"]) { const hook = refuse("bun." + name); Bun[name] = hook; hooks.push(Bun[name] === hook); }`,
    `for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) { const hook = refuse("child_process." + name); childProcess[name] = hook; hooks.push(childProcess[name] === hook); }`,
    `if (hooks.every(Boolean) && globalThis.fetch !== realFetch) record({ kind: "installed", pid: process.pid });`,
    ``,
  ].join("\n"),
);

interface TrapEntry {
  readonly kind: string;
  readonly host?: string;
}
function trapEntries(file: string): TrapEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map(parse)
    .filter(isRecord)
    .map((e) => ({ kind: text(e.kind), host: text(e.host) }));
}
const violations = (file: string): TrapEntry[] => trapEntries(file).filter((e) => e.kind !== "installed");

const FAKE_KEYS = { JEV_API_KEY: "jev-fake-verify-0000", OPENAI_API_KEY: "sk-fake-verify-0000", ANTHROPIC_API_KEY: "sk-ant-fake-verify-0000", BACKSTAGE_TRIAL_KEY: "trial-fake-verify-0000" };
const SESSION_SECRET = randomBytes(36).toString("base64url");
const TESTER = "tester@example.test";
const operatorsPath = join(state, "operators.json");
writeFileSync(operatorsPath, JSON.stringify([{ email: TESTER }]), { mode: 0o600 });
const apiTokensPath = join(scratch, "api", "api-tokens.json");
const decide = mintToken(apiTokensPath, "verify-decide");

// ---- processes ----

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = isRecord(address) && typeof address.port === "number" ? address.port : 0;
      s.close(() => done(port));
    });
  });
}

interface Running {
  readonly origin: string;
  readonly trap: string;
  readonly stop: () => Promise<void>;
}

let serverRuns = 0;
const HEAD = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
async function startServer(out: string): Promise<Running> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  serverRuns++;
  const trap = join(work, `trap-server-${serverRuns}.jsonl`);
  const proc = Bun.spawn([process.execPath, "--preload", TRAP, join(out, "server.js")], {
    cwd: out,
    env: {
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      HOME: scratch,
      PORT: String(port),
      BACKSTAGE_ORIGIN: origin,
      BACKSTAGE_VERSION: HEAD,
      BACKSTAGE_TRUST_PROXY: "loopback",
      STATE_DIRECTORY: state,
      BACKSTAGE_SESSION_SECRET: SESSION_SECRET,
      BACKSTAGE_OPERATORS_PATH: operatorsPath,
      JNJ_API_TOKENS_PATH: apiTokensPath,
      GI_TRAP_FILE: trap,
      ...FAKE_KEYS,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${origin}/api/questions`);
      if (res.status === 405) return { origin, trap, stop: async () => { proc.kill(); await proc.exited; } };
    } catch {
      await Bun.sleep(100);
    }
  }
  proc.kill();
  await proc.exited;
  const err = await new Response(proc.stderr).text();
  process.stderr.write(`server stderr: ${err.slice(0, 400)}\n`);
  throw new Error("built server did not start");
}

/** Every admin subprocess runs under the same trap as the server; its trap file is kept for the zero-call checks. */
const adminTraps: string[] = [];
const adminEnv = (trap: string): Record<string, string> => ({ PATH: `${shimBin}:${process.env.PATH ?? ""}`, HOME: scratch, STATE_DIRECTORY: state, GI_TRAP_FILE: trap, ...FAKE_KEYS });
async function admin(out: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const trap = join(work, `trap-admin-${adminTraps.length + 1}.jsonl`);
  adminTraps.push(trap);
  const proc = Bun.spawn([process.execPath, "--preload", TRAP, join(out, "server.js"), "--question-admin", ...args], {
    cwd: out,
    env: adminEnv(trap),
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => proc.kill(), 20_000);
  const code = await proc.exited;
  clearTimeout(killer);
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

function mintedToken(stdout: string): { token: string; id: string } | null {
  const token = /^token: (jng_[A-Za-z0-9_-]{43})$/m.exec(stdout)?.[1];
  const id = /^id: (gtk_[a-f0-9]{12})$/m.exec(stdout)?.[1];
  return token === undefined || id === undefined ? null : { token, id };
}

interface Mcp {
  readonly client: Client;
  readonly trap: string;
  readonly close: () => Promise<void>;
}

let mcpRuns = 0;
/** The real adapter as a stdio subprocess; a generated shim injects the loopback origin, the token comes from env. */
async function mcp(origin: string, token: string, entry: "shim" | "production" = "shim", preload = TRAP): Promise<Mcp> {
  mcpRuns++;
  const trap = join(work, `trap-mcp-${mcpRuns}.jsonl`);
  let script = MCP_ENTRY;
  if (entry === "shim") {
    script = join(work, `guest-mcp-shim-${mcpRuns}.ts`);
    writeFileSync(
      script,
      `import { createGuestMcp, serveStdio, TOKEN_ENV } from ${JSON.stringify(MCP_ENTRY)};\n` +
        `await serveStdio(createGuestMcp({ env: { [TOKEN_ENV]: process.env[TOKEN_ENV] }, origin: ${JSON.stringify(origin)} }));\n`,
    );
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--preload", preload, script],
    env: { PATH: process.env.PATH ?? "", HOME: scratch, [TOKEN_ENV]: token, GI_TRAP_FILE: trap, STUB_LOG: join(work, `stub-${mcpRuns}.jsonl`) },
    stderr: "pipe",
  });
  const client = new Client({ name: "gi-verify", version: "1.0.0" });
  await client.connect(transport);
  return { client, trap, close: () => client.close() };
}

async function tool(m: Mcp, name: string, args: Record<string, unknown> = {}): Promise<{ error: boolean; body: unknown }> {
  const result = await m.client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const raw = content.map((c: unknown) => text(field(c, "text"))).join("\n");
  return { error: result.isError === true, body: parse(raw) };
}

// ---- HTTP ----

let ipSeq = 0;
const nextIp = (): string => `192.0.2.${(++ipSeq % 250) + 1}`;

async function publicPost(origin: string, path: string, body: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", "x-backstage-client-ip": nextIp(), ...extra }, body: JSON.stringify(body) });
  return { status: res.status, body: parse(await res.text()) };
}

async function guest(origin: string, token: string | null, method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: unknown; raw: string }> {
  const headers: Record<string, string> = { "x-backstage-client-ip": nextIp(), ...extra };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${origin}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const raw = await res.text();
  return { status: res.status, body: parse(raw), raw };
}

// ---- run ----

const MARKER = `gi-verify-${randomBytes(4).toString("hex")}`;
const EMAIL = "seeded-verify@example.test";
let out = "";
const live: { server: Running | null } = { server: null };
const openMcp: Mcp[] = [];

async function run(): Promise<void> {
  const head = HEAD;
  const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: ROOT }).stdout.toString().trim() !== "";
  process.stdout.write(`source ${head}${dirty ? " (tracked changes present)" : ""}\n`);

  out = await buildBackstage(ROOT, false);
  const bundle = readFileSync(join(out, "server.js"));
  check("C2-01 build: scripts/backstage-build.ts produced server.js", bundle.byteLength > 0, `sha256 ${createHash("sha256").update(bundle).digest("hex").slice(0, 16)}`);

  live.server = await startServer(out);
  const s1 = live.server;
  check("C2-02 built server.js serves on 127.0.0.1 with the preload trap installed", trapEntries(s1.trap).some((e) => e.kind === "installed"));

  // Public: submit, operator review through the built CLI, status.
  const pubKey = newKey();
  const pubBody = { email: EMAIL, question: `Stock help or general help? ${MARKER}`, reply_consent: true, request_key: pubKey, nickname: "" };
  const pub = await publicPost(s1.origin, "/api/questions", pubBody);
  const pubId = text(field(pub.body, "id"));
  const pubCode = text(field(pub.body, "status_code"));
  check("C2-03 public submit stores one row and returns a receipt", pub.status === 200 && /^Q-[0-9A-F]{12}$/.test(pubId) && pubCode === `${pubId}.${pubKey}`);
  const pending = await publicPost(s1.origin, "/api/questions/status", { code: pubCode });
  check("C2-04 public status is pending_review and shows no question or email", pending.status === 200 && field(pending.body, "state") === "pending_review" && !JSON.stringify(pending.body).includes(MARKER) && !JSON.stringify(pending.body).includes(EMAIL));

  const listed = await admin(out, ["list"]);
  check("C2-05 host CLI lists the row without contact or question text", listed.code === 0 && listed.stdout.includes(pubId) && !listed.stdout.includes(EMAIL) && !listed.stdout.includes(MARKER));
  const reply = "Try this in your own assistant: name one decision, two fixed answers and three made-up cases. This is a reviewed preparation prompt, not a Jev result.";
  const replyFile = join(work, "reply.txt");
  writeFileSync(replyFile, reply, { mode: 0o600 });
  const approved = await admin(out, ["transition", pubId, "approved", "--version", "1"]);
  const answered = await admin(out, ["answer", pubId, "--version", "2", "--source", "human_reviewed", "--file", replyFile]);
  const pubAnswered = await publicPost(s1.origin, "/api/questions/status", { code: pubCode });
  check("C2-06 CLI approve and answer, then public status shows the reviewed reply", approved.code === 0 && answered.code === 0 && field(pubAnswered.body, "state") === "answered" && field(pubAnswered.body, "response") === reply && field(pubAnswered.body, "response_source") === "human_reviewed");

  const infoKey = newKey();
  const info = await publicPost(s1.origin, "/api/questions", { ...pubBody, question: `Second question ${MARKER}`, request_key: infoKey });
  const infoId = text(field(info.body, "id"));
  const infoCli = await admin(out, ["transition", infoId, "needs_info", "--version", "1", "--template", "choices"]);
  const infoStatus = await publicPost(s1.origin, "/api/questions/status", { code: `${infoId}.${infoKey}` });
  check("C2-07 needs_info template reaches the public status with source template", infoCli.code === 0 && field(infoStatus.body, "state") === "needs_info" && field(infoStatus.body, "response") === NEEDS_INFO_TEMPLATES.choices && field(infoStatus.body, "response_source") === "template");

  // Guests: two tokens minted through the built CLI; the values stay in this process.
  const mintA = await admin(out, ["token", "mint", "Verify guest A"]);
  const mintB = await admin(out, ["token", "mint", "Verify guest B"]);
  const a = mintedToken(mintA.stdout);
  const b = mintedToken(mintB.stdout);
  if (!check("C2-08 host CLI mints two guest tokens, printed once each", a !== null && b !== null && mintA.code === 0 && mintB.code === 0) || a === null || b === null) return;

  const mA = await mcp(s1.origin, a.token);
  const mB = await mcp(s1.origin, b.token);
  openMcp.push(mA, mB);
  const tools = (await mA.client.listTools()).tools.map((t) => t.name).sort();
  check("C2-09 MCP stdio subprocess lists exactly submit_question, get_my_question, list_my_questions", JSON.stringify(tools) === JSON.stringify([...GUEST_TOOL_NAMES].sort()), tools.join(","));

  const keyA = newKey();
  const httpA = await guest(s1.origin, a.token, "POST", GUEST, { question: `Guest A over HTTP ${MARKER}`, reply_consent: true, request_key: keyA });
  const idA = text(field(httpA.body, "id"));
  const viaMcpA = await tool(mA, "get_my_question", { id: idA });
  check("C2-10 guest A submits over HTTP and reads the same row through MCP", httpA.status === 200 && /^Q-[0-9A-F]{12}$/.test(idA) && !viaMcpA.error && field(viaMcpA.body, "id") === idA && field(viaMcpA.body, "state") === "pending_review");

  const keyB = newKey();
  const submitB = { question: `Guest B over MCP ${MARKER}`, reply_consent: true, request_key: keyB };
  const mcpB = await tool(mB, "submit_question", submitB);
  const idB = text(field(mcpB.body, "id"));
  const replayB = await tool(mB, "submit_question", submitB);
  const httpB = await guest(s1.origin, b.token, "GET", `${GUEST}/${idB}`);
  check("C2-11 guest B submits through MCP, a retry replays the same id, HTTP reads it", !mcpB.error && field(mcpB.body, "replay") === false && field(replayB.body, "id") === idB && field(replayB.body, "replay") === true && httpB.status === 200 && field(httpB.body, "id") === idB);

  const listA = await tool(mA, "list_my_questions");
  const listB = await guest(s1.origin, b.token, "GET", GUEST);
  const idsA = (Array.isArray(field(listA.body, "questions")) ? [field(listA.body, "questions", 0, "id"), field(listA.body, "questions", 1, "id")] : []).filter((x) => x !== undefined);
  const idsB = Array.isArray(field(listB.body, "questions")) ? [field(listB.body, "questions", 0, "id"), field(listB.body, "questions", 1, "id")].filter((x) => x !== undefined) : [];
  check("C2-12 each guest's list holds only its own row and no question text", JSON.stringify(idsA) === JSON.stringify([idA]) && JSON.stringify(idsB) === JSON.stringify([idB]) && !listB.raw.includes(MARKER) && !JSON.stringify(listA.body).includes(MARKER));

  const crossHttp = await guest(s1.origin, a.token, "GET", `${GUEST}/${idB}`);
  const crossMcp = await tool(mB, "get_my_question", { id: idA });
  const pubViaGuest = await guest(s1.origin, a.token, "GET", `${GUEST}/${pubId}`);
  check("C2-13 cross-guest reads are 404 over HTTP and MCP; a public id is 404 to a guest", crossHttp.status === 404 && crossMcp.error && field(crossMcp.body, "error", "code") === "not-found" && pubViaGuest.status === 404);

  const guestByCode = await publicPost(s1.origin, "/api/questions/status", { code: `${idB}.${keyB}` });
  check("C2-14 the public status capability cannot read a guest row with its own id and key", guestByCode.status === 404);

  const answerFile = join(work, "guest-reply.txt");
  writeFileSync(answerFile, reply, { mode: 0o600 });
  const ga = [await admin(out, ["transition", idA, "approved", "--version", "1"]), await admin(out, ["answer", idA, "--version", "2", "--source", "human_reviewed", "--file", answerFile])];
  const gb = [await admin(out, ["transition", idB, "approved", "--version", "1"]), await admin(out, ["answer", idB, "--version", "2", "--source", "template", "--file", answerFile])];
  const readAHttp = await guest(s1.origin, a.token, "GET", `${GUEST}/${idA}`);
  const readAMcp = await tool(mA, "get_my_question", { id: idA });
  const readBHttp = await guest(s1.origin, b.token, "GET", `${GUEST}/${idB}`);
  const readBMcp = await tool(mB, "get_my_question", { id: idB });
  check(
    "C2-15 after the CLI answers, HTTP and MCP return the same reviewed response to each guest",
    [...ga, ...gb].every((r) => r.code === 0) &&
      field(readAHttp.body, "response") === reply && JSON.stringify(readAHttp.body) === JSON.stringify(readAMcp.body) &&
      field(readBHttp.body, "response_source") === "template" && JSON.stringify(readBHttp.body) === JSON.stringify(readBMcp.body),
  );

  // Credentials.
  const unknown = `jng_${randomBytes(32).toString("base64url")}`;
  const bad = await Promise.all([guest(s1.origin, null, "GET", GUEST), guest(s1.origin, unknown, "GET", GUEST), guest(s1.origin, `${a.token}x`, "GET", GUEST), guest(s1.origin, unknown, "POST", GUEST, submitB)]);
  const mUnknown = await mcp(s1.origin, unknown);
  openMcp.push(mUnknown);
  const unknownMcp = await tool(mUnknown, "list_my_questions");
  const mMalformed = await mcp(s1.origin, decide.token);
  openMcp.push(mMalformed);
  const malformedMcp = await tool(mMalformed, "list_my_questions");
  check("C2-16 a missing, unknown or malformed token is 401 over HTTP; MCP reports unauthenticated or token-invalid", bad.every((r) => r.status === 401) && field(unknownMcp.body, "error", "status") === 401 && field(malformedMcp.body, "error", "code") === "token-invalid");

  const past = new GuestTokenStore(tickets, () => Date.now() - 3 * 3_600_000);
  const expired = past.mint("Verify expired", { ttlMs: 3_600_000 });
  past.close();
  const expiredHttp = await guest(s1.origin, expired.token, "GET", GUEST);
  check("C2-17 an expired token is 401", expiredHttp.status === 401);

  const decideOnGuest = await guest(s1.origin, decide.token, "GET", GUEST);
  const guestOnDecide = await Promise.all(
    ([["GET", "arms"], ["POST", "estimate"], ["POST", "ask"], ["POST", "run"], ["POST", "verdict"], ["POST", "validate"]] satisfies ["GET" | "POST", string][]).map(async ([method, route]) =>
      (await fetch(`${s1.origin}/api/v1/${route}`, { method, headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json", "x-jev-key": FAKE_KEYS.JEV_API_KEY }, ...(method === "POST" ? { body: "{}" } : {}) })).status,
    ),
  );
  check("C2-18 a guest token is 401 on all six decide routes, and a decide token is 401 on the guest routes", guestOnDecide.every((status) => status === 401) && decideOnGuest.status === 401, guestOnDecide.join(","));

  const session = signSession({ email: TESTER, auth: "google", iat: Date.now(), exp: Date.now() + 3_600_000, sid: randomBytes(24).toString("base64url"), cred: credentialFingerprint("google") }, SESSION_SECRET);
  const sessionCookie = cookie(s1.origin, "session", session, 3600).split(";")[0] ?? "";
  const sessionOk = await fetch(`${s1.origin}/api/auth/session`, { headers: { cookie: sessionCookie } });
  const cookieGet = await guest(s1.origin, null, "GET", GUEST, undefined, { cookie: sessionCookie });
  const cookiePost = await guest(s1.origin, null, "POST", GUEST, { question: "Cookie only", reply_consent: true, request_key: newKey() }, { cookie: sessionCookie });
  check("C2-19 a valid tester session cookie (204 on /api/auth/session) grants nothing on the guest routes", sessionOk.status === 204 && cookieGet.status === 401 && cookiePost.status === 401);

  const rotated = await admin(out, ["token", "rotate", a.id]);
  const a2 = mintedToken(rotated.stdout);
  const oldA = await guest(s1.origin, a.token, "GET", GUEST);
  const oldMcp = await tool(mA, "list_my_questions");
  const newA = a2 === null ? null : await guest(s1.origin, a2.token, "GET", `${GUEST}/${idA}`);
  check("C2-20 rotation: the old secret is 401 over HTTP and MCP; the new one reads the same row", rotated.code === 0 && a2 !== null && a2.id === a.id && oldA.status === 401 && field(oldMcp.body, "error", "status") === 401 && newA?.status === 200 && field(newA.body, "id") === idA);

  const revoked = await admin(out, ["token", "revoke", b.id]);
  const revokedHttp = await guest(s1.origin, b.token, "GET", GUEST);
  const revokedMcp = await tool(mB, "get_my_question", { id: idB });
  const afterRevoke = await admin(out, ["list"]);
  check("C2-21 revoke: guest B is 401 over HTTP and MCP at once, and its row stays in the queue", revoked.code === 0 && revokedHttp.status === 401 && field(revokedMcp.body, "error", "status") === 401 && afterRevoke.stdout.includes(idB));
  const guestCodeAfter = await publicPost(s1.origin, "/api/questions/status", { code: `${idB}.${keyB}` });
  check("C2-22 after revoke the guest row is still 404 on the public status route", guestCodeAfter.status === 404);

  // Deletion and replay.
  const delPub = await admin(out, ["delete", infoId]);
  const delStatus = await publicPost(s1.origin, "/api/questions/status", { code: `${infoId}.${infoKey}` });
  const delReplay = await publicPost(s1.origin, "/api/questions", { ...pubBody, question: `Second question ${MARKER}`, request_key: infoKey });
  check("C2-23 public delete: old status code 404, replay of the old key 410 deleted", delPub.code === 0 && delStatus.status === 404 && delReplay.status === 410 && field(delReplay.body, "code") === "deleted");
  if (a2 === null) return;
  const mA2 = await mcp(s1.origin, a2.token);
  openMcp.push(mA2);
  const delGuest = await admin(out, ["delete", idA]);
  const delGuestRead = await tool(mA2, "get_my_question", { id: idA });
  const delGuestReplay = await guest(s1.origin, a2.token, "POST", GUEST, { question: `Guest A over HTTP ${MARKER}`, reply_consent: true, request_key: keyA });
  check("C2-24 guest delete: MCP read is not-found and an HTTP replay of the old key is 410", delGuest.code === 0 && field(delGuestRead.body, "error", "code") === "not-found" && delGuestReplay.status === 410);

  // Provider trap, before the positive control.
  const serverViolations = violations(s1.trap);
  const mcpViolations = openMcp.flatMap((m) => violations(m.trap));
  check("C2-25 zero provider requests and zero spawns from the server across the public and guest journeys", serverViolations.length === 0, `${serverViolations.length} recorded`);
  check("C2-26 zero non-loopback requests and zero spawns from the MCP subprocesses", mcpViolations.length === 0 && openMcp.every((m) => trapEntries(m.trap).some((e) => e.kind === "installed")), `${mcpViolations.length} recorded`);
  check("C2-27 no claude or codex binary was started", !existsSync(modelCalls));

  const control = await fetch(`${s1.origin}/api/v1/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${decide.token}`, "content-type": "application/json", "x-jev-key": FAKE_KEYS.JEV_API_KEY },
    body: JSON.stringify({ questions: [{ name: "needs_person", type: "noul", instructions: "Does this made-up message need a person?" }], case: { id: "trap-control", input: "Made-up message for the trap control." }, arms: { jev: true, llm: false } }),
  });
  await control.text();
  const caught = violations(s1.trap).filter((e) => e.kind === "fetch");
  check("C2-28 trap control: one decide ask with a fake key is recorded and refused before it leaves the process", caught.length > 0, caught.map((e) => e.host ?? "").join(","));

  for (const m of openMcp.splice(0)) await m.close();

  // Restart: the same state read by a fresh server process.
  await s1.stop();
  live.server = await startServer(out);
  const s2 = live.server;
  const afterPub = await publicPost(s2.origin, "/api/questions/status", { code: pubCode });
  const afterDeleted = await publicPost(s2.origin, "/api/questions/status", { code: `${infoId}.${infoKey}` });
  const afterReplay = await publicPost(s2.origin, "/api/questions", { ...pubBody, question: `Second question ${MARKER}`, request_key: infoKey });
  check("C2-29 after restart the public reply reads back and the deleted row stays 404/410", field(afterPub.body, "response") === reply && afterDeleted.status === 404 && afterReplay.status === 410);
  const mB2Http = await guest(s2.origin, b.token, "GET", GUEST);
  const mA3 = await mcp(s2.origin, a2.token);
  openMcp.push(mA3);
  const afterList = await tool(mA3, "list_my_questions");
  const afterOld = await guest(s2.origin, a.token, "GET", GUEST);
  check("C2-30 after restart revoke and rotation still hold, and the deleted guest row stays gone", mB2Http.status === 401 && afterOld.status === 401 && !afterList.error && JSON.stringify(field(afterList.body, "questions")) === "[]");
  const tokenList = await admin(out, ["token", "list"]);
  check("C2-31 host CLI token list shows ids and status and no token", tokenList.code === 0 && tokenList.stdout.includes(a.id) && tokenList.stdout.includes("revoked") && !tokenList.stdout.includes("jng_"));
  check("C2-32 zero provider requests and zero spawns after restart", violations(s2.trap).length === 0 && violations(mA3.trap).length === 0);

  // The admin CLI: every compiled --question-admin process carried the trap, and the trap works in that launch line.
  const adminViolations = adminTraps.flatMap(violations);
  const adminInstalled = adminTraps.every((t) => trapEntries(t).some((e) => e.kind === "installed"));
  check(`C2-34 every admin CLI subprocess (${adminTraps.length}) ran with the trap and made zero provider requests and zero spawns`, adminTraps.length > 0 && adminInstalled && adminViolations.length === 0, `${adminViolations.length} recorded`);
  const probe = join(work, "admin-probe.mjs");
  writeFileSync(probe, `try { await fetch("https://api.anthropic.com/v1/messages", { method: "POST" }); } catch {}\ntry { Bun.spawn(["claude", "--version"]); } catch {}\n`);
  const probeTrap = join(work, "trap-admin-control.jsonl");
  const control2 = Bun.spawn([process.execPath, "--preload", TRAP, probe], { cwd: out, env: adminEnv(probeTrap), stdout: "ignore", stderr: "ignore" });
  await control2.exited;
  const kinds = violations(probeTrap).map((e) => `${e.kind}${e.host === "" || e.host === undefined ? "" : `:${e.host}`}`);
  check("C2-35 admin trap control: the admin launch line records and refuses one provider fetch and one claude spawn", kinds.includes("fetch:api.anthropic.com") && kinds.includes("bun.spawn") && !existsSync(modelCalls), kinds.join(","));

  // The production adapter entrypoint: fixed origin, no override, with a stub fetch that sends nothing.
  const stub = join(work, "stub-fetch.mjs");
  writeFileSync(
    stub,
    `import { appendFileSync } from "node:fs";\n` +
      `globalThis.fetch = Object.assign(async (input) => { appendFileSync(process.env.STUB_LOG, JSON.stringify({ url: String(input) }) + "\\n"); return Response.json({ questions: [] }); }, { preconnect: globalThis.fetch.preconnect });\n`,
  );
  const prod = await mcp(s2.origin, a2.token, "production", stub);
  openMcp.push(prod);
  await tool(prod, "list_my_questions");
  const stubLog = join(work, `stub-${mcpRuns}.jsonl`);
  const sent = existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n").map(parse).map((e) => text(field(e, "url"))) : [];
  check("C2-33 the production MCP entrypoint sends only to the pinned origin", JSON.stringify(sent) === JSON.stringify([`${PRODUCTION_ORIGIN}${GUEST}`]));
}

let crashed = false;
try {
  await run();
} catch (error) {
  crashed = true;
  check("C2-RUN verification completed without an exception", false, error instanceof Error ? error.name : "error");
} finally {
  for (const m of openMcp.splice(0)) await m.close().catch(() => undefined);
  await live.server?.stop().catch(() => undefined);
  if (out !== "") rmSync(out, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(`checks ${passed + failed}, passed ${passed}, failed ${failed}\n`);
if (!crashed && failed === 0 && passed > 0) {
  process.stdout.write("GUEST_INTAKE_PASS\n");
  process.exit(0);
}
process.stdout.write("GUEST_INTAKE_FAIL\n");
process.exit(1);
