import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askReady, parseCliArgs, parseEnvFile, READY_QUESTION, resolveKey } from "./deploy-checklist.ts";
import type { DecideFetch, FetchInit } from "../src/decide/types.ts";

const KEY = "sk-test-SENTINEL-never-printed";
const CHECKLIST = "HEAD == origin/main: yes 0a03b15\ntest gate: PASS files=97 tests=1900\n";
// The noul answer shape recorded live from jev-1.13.0 (src/jev-answer.typed-vectors.json, first vector).
const answer = (noul: number, model = "jev-1.13.0"): unknown => ({ model, answers: { ready: { type: "noul", noul } } });

type Call = { url: string; init: FetchInit };
function fakeFetch(status: number, body: unknown, calls: Call[] = []): DecideFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}
const key = { key: KEY, source: "JEV_API_KEY (process env)" };

test("[unit] deploy-checklist: Jev yes exits 0 and prints the checklist and the answer", async () => {
  const r = await askReady(CHECKLIST, key, fakeFetch(200, answer(0.93)));
  expect(r.code).toBe(0);
  expect(r.lines).toContain("  HEAD == origin/main: yes 0a03b15");
  expect(r.lines.at(-1)).toBe("jev: yes (p(yes)=0.930, jev-1.13.0); key from JEV_API_KEY (process env)");
});

test("[unit] deploy-checklist: Jev no exits 1", async () => {
  const r = await askReady(CHECKLIST, key, fakeFetch(200, answer(0.12)));
  expect(r.code).toBe(1);
  expect(r.lines.at(-1)).toStartWith("jev: no (p(yes)=0.120");
});

test("[unit] deploy-checklist: the request is one pinned noul question carrying the checklist, key in the header only", async () => {
  const calls: Call[] = [];
  await askReady(CHECKLIST, key, fakeFetch(200, answer(0.9), calls));
  expect(calls.length).toBe(1);
  const call = calls[0];
  if (call === undefined) throw new Error("no call");
  expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(call.init.headers.authorization).toBe(`Bearer ${KEY}`);
  const body: unknown = JSON.parse(call.init.body);
  expect(body).toEqual({
    state: "Release checklist:\nHEAD == origin/main: yes 0a03b15\ntest gate: PASS files=97 tests=1900",
    model: "jev-1.13.0",
    questions: { ready: { type: "noul", instructions: { question: READY_QUESTION.instructions } } },
  });
});

test("[unit] deploy-checklist: unreachable API, http error, wrong model or malformed answer all exit 1", async () => {
  const throwing: DecideFetch = async () => {
    throw new TypeError("fetch failed");
  };
  const cases: [DecideFetch, string][] = [
    [throwing, "jev: unreachable (TypeError)"],
    [fakeFetch(500, { error: "boom" }), "jev: no valid answer (http 500)"],
    [fakeFetch(200, answer(0.9, "jev-1.12.0")), "jev: no valid answer (jev check model)"],
    [fakeFetch(200, answer(1.4)), "jev: no valid answer (jev check noul-range)"],
    [fakeFetch(200, { model: "jev-1.13.0", answers: {} }), "jev: no valid answer (jev check missing-answer)"],
  ];
  for (const [f, want] of cases) {
    const r = await askReady(CHECKLIST, key, f);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toStartWith(want);
  }
});

test("[unit] deploy-checklist: no key or an empty checklist exits 1 without a call", async () => {
  const calls: Call[] = [];
  expect((await askReady(CHECKLIST, null, fakeFetch(200, answer(0.9), calls))).code).toBe(1);
  expect((await askReady("\n\n", key, fakeFetch(200, answer(0.9), calls))).code).toBe(1);
  expect(calls.length).toBe(0);
});

test("[unit] deploy-checklist: the key never appears in the printed lines", async () => {
  const outs = [
    await askReady(CHECKLIST, key, fakeFetch(200, answer(0.9))),
    await askReady(CHECKLIST, key, fakeFetch(500, { echoed: KEY })),
    await askReady(CHECKLIST, key, async () => { throw new Error(KEY); }),
  ];
  for (const o of outs) expect(o.lines.join("\n")).not.toContain(KEY);
});

test("[unit] deploy-checklist: key order is process env (JEV_API_KEY, TYPESAFE_API_KEY), then the env file, then JEV_API_KEY_JAYLO", () => {
  const file = 'JEV_API_KEY_JAYLO="jaylo"\nUAT_USER=x\n';
  expect(resolveKey({ JEV_API_KEY: "a", TYPESAFE_API_KEY: "b" }, file)).toEqual({ key: "a", source: "JEV_API_KEY (process env)" });
  expect(resolveKey({ TYPESAFE_API_KEY: "b" }, file)).toEqual({ key: "b", source: "TYPESAFE_API_KEY (process env)" });
  expect(resolveKey({}, "export TYPESAFE_API_KEY='t'\nJEV_API_KEY_JAYLO=j\n")).toEqual({ key: "t", source: "TYPESAFE_API_KEY (env file)" });
  expect(resolveKey({ JEV_API_KEY: "" }, file)).toEqual({ key: "jaylo", source: "JEV_API_KEY_JAYLO (env file)" });
  expect(resolveKey({}, "UAT_USER=x\n")).toBeNull();
  expect(resolveKey({}, null)).toBeNull();
});

test("[unit] deploy-checklist: env file parsing strips export and one pair of quotes, skips other lines", () => {
  expect(parseEnvFile("# c\nexport A=\"1\"\nB='2'\nC=3=4\nUAT_PASSWORD-01=x\n\n")).toEqual({ A: "1", B: "2", C: "3=4" });
});

test("[unit] deploy-checklist: arguments need --checklist; unknown flags are usage errors", () => {
  expect(parseCliArgs(["--checklist", "c", "--env-file", "e"])).toEqual({ checklist: "c", envFile: "e" });
  expect(parseCliArgs([])).toBe("--checklist <file> is required");
  expect(parseCliArgs(["--checklist"])).toBe("--checklist needs a path");
  expect(parseCliArgs(["--checklist", "c", "--live"])).toBe("unknown argument: --live");
});

test("[integration] deploy-checklist CLI: no key exits 1 naming --no-jev, usage exits 2, and no network is used", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-checklist-"));
  try {
    const list = join(dir, "checklist.txt");
    writeFileSync(list, CHECKLIST);
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir };
    const run = Bun.spawnSync(["bun", join(import.meta.dir, "deploy-checklist.ts"), "--checklist", list, "--env-file", join(dir, "absent")], { env, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain("--no-jev skips the question");
    const bad = Bun.spawnSync(["bun", join(import.meta.dir, "deploy-checklist.ts")], { env, stdout: "pipe", stderr: "pipe" });
    expect(bad.exitCode).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
