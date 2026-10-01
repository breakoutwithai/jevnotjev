// UC13 Jev fixture: the exact request and the full raw response of every real Jev call in ONE file, so the run (and
// later the site demo) can replay real answers with no network. Entries are keyed by the sha256 of the exact bytes
// POSTed (the same bytes jaylo-jev.sh hashes into its calls.jsonl body_sha256); case_id only orders them.
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { JEV_MODEL, parseJevResponse, type ArmReply, type Case, type JevBody } from "./arms.ts";

export const FIXTURE_SCHEMA = "jnj-jev-fixture/1";
/**
 * A key-like token anywhere in a string: `api_`/`api-` followed by 6+ key characters, or `Bearer <token>`. The key is
 * never in stdout; this guards that. Plain prose ("the api is", "bearer of news") does not match.
 */
export const KEY_PATTERN = /(?:^|[^A-Za-z0-9])api[_-][A-Za-z0-9_-]{6,}|\bBearer\s+\S+/;
const SECRET_FIELDS = /^(authorization|api[_-]?key)$/i;

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The bytes handed to jaylo-jev.sh as the body file: no trailing newline. */
export function requestBytes(body: JevBody): string {
  return JSON.stringify(body);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Throws if the response holds an authorization/api_key field or a key-like token anywhere in a string. */
export function assertNoSecrets(value: unknown, caseId: string, path = "$"): void {
  if (typeof value === "string") {
    if (KEY_PATTERN.test(value)) throw new Error(`Jev ${caseId}: key-like string at ${path}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, caseId, `${path}[${i}]`));
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELDS.test(k)) throw new Error(`Jev ${caseId}: secret field "${k}" at ${path}`);
      assertNoSecrets(v, caseId, `${path}.${k}`);
    }
  }
}

/** Throws unless both the request and the response carry the pinned model. */
export function assertPinned(request: unknown, response: unknown, caseId: string): void {
  const req = isObject(request) ? String(request.model) : "none";
  const res = isObject(response) ? String(response.model) : "none";
  if (req !== JEV_MODEL || res !== JEV_MODEL) throw new Error(`Jev ${caseId}: model pin ${JEV_MODEL} violated (request ${req}, response ${res})`);
}

export interface JevEntry {
  readonly case_id: string;
  readonly request_sha256: string;
  readonly request: unknown;
  readonly response: unknown;
  readonly latency_ms: number;
  readonly utc: string;
  readonly http: number;
  readonly usage: unknown;
}

export interface JevFixture {
  readonly schema: string;
  readonly model: string;
  readonly captured_utc: string;
  readonly entries: readonly JevEntry[];
}

/** One captured call as a fixture entry; refuses a secret-bearing or off-pin response. */
export function jevEntry(caseId: string, request: JevBody, response: unknown, latencyMs: number, utc: string): JevEntry {
  assertNoSecrets(response, caseId);
  assertPinned(request, response, caseId);
  const usage = isObject(response) ? (response.usage ?? null) : null;
  return { case_id: caseId, request_sha256: sha256Hex(requestBytes(request)), request, response, latency_ms: latencyMs, utc, http: 200, usage };
}

export async function writeFixture(path: string, entries: readonly JevEntry[], capturedUtc: string): Promise<void> {
  const fixture: JevFixture = { schema: FIXTURE_SCHEMA, model: JEV_MODEL, captured_utc: capturedUtc, entries };
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(fixture, null, 1) + "\n");
}

export async function readFixture(path: string): Promise<JevFixture> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`replay: fixture ${path} is missing`);
  const raw: unknown = JSON.parse(await file.text());
  if (!isObject(raw) || raw.schema !== FIXTURE_SCHEMA || raw.model !== JEV_MODEL || typeof raw.captured_utc !== "string" || !Array.isArray(raw.entries)) {
    throw new Error(`replay: ${path} is not a ${FIXTURE_SCHEMA} fixture for ${JEV_MODEL}`);
  }
  const seen = new Set<string>();
  const entries: JevEntry[] = raw.entries.map((e: unknown, i: number) => {
    if (!isObject(e) || typeof e.case_id !== "string" || typeof e.request_sha256 !== "string" || !isObject(e.request) ||
      typeof e.latency_ms !== "number" || !Number.isInteger(e.latency_ms) || e.latency_ms < 0 || typeof e.utc !== "string" || e.http !== 200) {
      throw new Error(`replay: ${path} entry ${i} is malformed (needs http 200 and a non-negative integer latency_ms)`);
    }
    if (seen.has(e.case_id)) throw new Error(`replay: ${path} has a duplicate entry for ${e.case_id}`);
    seen.add(e.case_id);
    return { case_id: e.case_id, request_sha256: e.request_sha256, request: e.request, response: e.response, latency_ms: e.latency_ms, utc: e.utc, http: e.http, usage: e.usage };
  });
  return { schema: FIXTURE_SCHEMA, model: JEV_MODEL, captured_utc: raw.captured_utc, entries };
}

export interface Replayed { readonly case_: Case; readonly reply: ArmReply; readonly ms: number }

/**
 * Rebuild the Jev replies from the fixture alone, no network, in case order. Each case's CURRENT request body is
 * hashed and must equal the entry's request_sha256, so an edited prompt or fact sheet cannot replay a stale answer.
 */
export function replayJev(fixture: JevFixture, cases: readonly Case[], bodyFor: (c: Case) => JevBody): Replayed[] {
  const byHash = new Map(fixture.entries.map((e) => [e.case_id, e]));
  return cases.map((c) => {
    const entry = byHash.get(c.case_id);
    if (entry === undefined) throw new Error(`replay: no fixture entry for ${c.case_id}`);
    const hash = sha256Hex(requestBytes(bodyFor(c)));
    if (hash !== entry.request_sha256) throw new Error(`replay: ${c.case_id} request changed (now ${hash}, fixture ${entry.request_sha256}); recapture`);
    if (sha256Hex(JSON.stringify(entry.request)) !== entry.request_sha256) throw new Error(`replay: ${c.case_id} stored request does not match its hash`);
    assertNoSecrets(entry.response, c.case_id);
    assertPinned(entry.request, entry.response, c.case_id);
    return { case_: c, reply: parseJevResponse(entry.response, c.case_id), ms: entry.latency_ms };
  });
}
