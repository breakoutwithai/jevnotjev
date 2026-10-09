import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecideFetch } from "../decide/types.ts";
import { ApiTokenStore, mintToken } from "./api-tokens.ts";
import { createApiV1 } from "./api-v1.ts";

const EXAMPLES = join(import.meta.dir, "..", "..", "examples", "d08-verdicts");
const QUESTIONS = [{ name: "q", type: "noul", instructions: "Is this useful?" }];
const CASE = { id: "c1", input: "A shop question" };
const KEY = "private-test-key";
const RECORD_ROUTES: readonly (readonly [string, number])[] = [["verdict", 2], ["validate", 1]];
const VERDICT_CASES: readonly (readonly [string, string, string])[] = [
  ["r1-both-zero.csv", "both-zero-accepted", "not enough evidence: Jev and the LLM both have 0 accepted; neither answer is being accepted"],
  ["r1-no-jev.csv", "no-jev-rows", "not enough evidence: no Jev results"],
  ["r1-no-llm.csv", "no-llm-rows", "not enough evidence: no LLM results"],
];

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}
function errorRow(body: unknown, arm: string, reason: string): void {
  const rows = field(body, "rows");
  expect(Array.isArray(rows)).toBe(true);
  if (!Array.isArray(rows)) return;
  expect(rows).toHaveLength(1);
  const row: unknown = rows[0];
  expect(field(row, "case_id")).toBe("c1");
  expect(field(row, "answerer")).toBe(arm);
  expect(field(row, "outcome")).toBe("error");
  expect(field(field(row, "evidence"), "reason")).toBe(reason);
}

async function withApi(fetch: DecideFetch | undefined, fn: (call: (route: string, body: unknown) => Promise<{ status: number; body: unknown; text: string }>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "jnj-broken-api-"));
  try {
    const path = join(dir, "tokens.json");
    const { token } = mintToken(path, "broken-path-test");
    const api = createApiV1({ tokens: new ApiTokenStore(path), ...(fetch === undefined ? {} : { deps: { fetch, which: () => null } }) });
    const call = async (route: string, body: unknown): Promise<{ status: number; body: unknown; text: string }> => {
      const request = new Request(`http://localhost/api/v1/${route}`, {
        method: "POST", body: JSON.stringify(body), headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json",
          "x-jev-key": KEY, "x-openai-key": KEY, "x-anthropic-key": KEY,
        },
      });
      const { response } = await api(request, new URL(request.url).pathname, { acquire: () => true, release: () => {} });
      const text = await response.text();
      expect(text).not.toMatch(/Internal error|private-test-key|(?:^|\n)\s+at \S+/);
      const parsed: unknown = JSON.parse(text);
      expect(response.status).not.toBe(500);
      return { status: response.status, body: parsed, text };
    };
    await fn(call);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("[integration] D16-API-EMPTY empty records have a named 4xx response and documented exit codes", async () => {
  await withApi(undefined, async (call) => {
    for (const [route, code] of RECORD_ROUTES) {
      const got = await call(route, { records: "" });
      expect(got.status).toBe(route === "verdict" ? 400 : 200);
      if (route === "verdict") expect(field(got.body, "code")).toBe("invalid-input");
      expect(field(got.body, "exit_code")).toBe(code);
      expect(field(got.body, "errors")).toEqual([`${route === "verdict" ? "records: " : ""}the file is empty: expected a header row and data rows`]);
    }
  });
});

test("[integration] D16-API-HEADER header-only records name zero data rows", async () => {
  const records = readFileSync(join(EXAMPLES, "r1-both-zero.csv"), "utf8").split("\n")[0] + "\n";
  await withApi(undefined, async (call) => {
    for (const [route, code] of RECORD_ROUTES) {
      const got = await call(route, { records });
      expect(got.status).toBe(route === "verdict" ? 400 : 200);
      expect(field(got.body, "exit_code")).toBe(code);
      expect(field(got.body, "errors")).toEqual(["file has no data rows"]);
    }
  });
});

test("[integration] D16-API-CASES zero cases in run and estimate are named invalid input", async () => {
  await withApi(undefined, async (call) => {
    for (const route of ["run", "estimate"]) {
      const got = await call(route, { questions: QUESTIONS, cases: [], arms: { jev: true, llm: false } });
      expect(got.status).toBe(400);
      expect(field(got.body, "exit_code")).toBe(2);
      expect(field(got.body, "errors")).toEqual(["cases: no cases"]);
    }
  });
});

test("[integration] D16-API-ASK-EMPTY ask rejects a missing case with a named 4xx", async () => {
  await withApi(undefined, async (call) => {
    const got = await call("ask", { questions: QUESTIONS, arms: { jev: true, llm: false } });
    expect(got.status).toBe(400);
    expect(field(got.body, "exit_code")).toBe(2);
    expect(field(got.body, "errors")).toEqual(["case: Invalid input: expected object, received undefined"]);
  });
});

for (const [name, condition, reason] of VERDICT_CASES) {
  test(`[integration] D16-API-VERDICT ${name} names ${condition} with exit code 4`, async () => {
    await withApi(undefined, async (call) => {
      const got = await call("verdict", { records: readFileSync(join(EXAMPLES, name), "utf8") });
      expect(got.status).toBe(200);
      expect(field(got.body, "exit_code")).toBe(4);
      const verdicts = field(got.body, "verdicts");
      expect(Array.isArray(verdicts)).toBe(true);
      if (!Array.isArray(verdicts)) return;
      const verdict: unknown = verdicts[0];
      expect(field(verdict, "verdict")).toBe("not enough evidence");
      expect(field(verdict, "condition")).toBe(condition);
      expect(field(verdict, "reason")).toBe(reason);
    });
  });
}

test("[integration] D16-API-ARM ask and run reject unknown arms with a named 4xx", async () => {
  await withApi(undefined, async (call) => {
    for (const route of ["ask", "run"]) {
      const data = route === "ask" ? { case: CASE } : { cases: [CASE] };
      const got = await call(route, { questions: QUESTIONS, ...data, arms: { mystery: true } });
      expect(got.status).toBe(400);
      expect(field(got.body, "exit_code")).toBe(2);
      expect(field(got.body, "errors")).toEqual(['arms: Unrecognized key: "mystery"']);
    }
  });
});

for (const arm of ["jev", "decisions", "llm"]) {
  const statuses: readonly (readonly [number, string])[] = [
    [429, `${arm}: rate limited by the provider (HTTP 429)`],
    [503, `${arm}: provider server error (HTTP 503)`],
    [418, `${arm}: provider returned HTTP 418`],
    [0, `${arm}: provider request timed out`],
  ];
  for (const [status, reason] of statuses) {
    test(`[integration] D16-API-PROVIDER ${arm} ${status} gives named error rows in ask and run`, async () => {
      const fetch: DecideFetch = async () => {
        if (status === 0) throw new DOMException("Request timed out", "TimeoutError");
        return new Response(JSON.stringify({ error: KEY }), { status });
      };
      await withApi(fetch, async (call) => {
        const arms = { jev: arm === "jev", decisions: arm === "decisions", llm: arm === "llm" ? "claude-haiku-5-5" : false };
        for (const route of ["ask", "run"]) {
          const data = route === "ask" ? { case: CASE } : { cases: [CASE] };
          const got = await call(route, { questions: QUESTIONS, ...data, arms });
          expect(got.status).toBe(200);
          errorRow(got.body, arm, reason);
          expect(field(got.body, "errorReasons")).toEqual([reason]);
          expect(got.text).not.toContain(KEY);
        }
      });
    });
  }
}

const FAILURES: readonly (readonly [string, Error])[] = [["network", new TypeError("fetch failed")], ["abort", new DOMException("Aborted", "AbortError")]];
for (const [name, failure] of FAILURES) {
  test(`[integration] D16-API-${name.toUpperCase()} fetch failures are network errors, not timeouts`, async () => {
    const fetch: DecideFetch = async () => { throw failure; };
    await withApi(fetch, async (call) => {
      const got = await call("ask", { questions: QUESTIONS, case: CASE, arms: { jev: true, llm: false } });
      expect(got.status).toBe(200);
      errorRow(got.body, "jev", "jev: network error contacting provider");
      expect(got.text).not.toContain("timed out");
    });
  });
}
