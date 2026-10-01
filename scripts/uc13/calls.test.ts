import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jevBody } from "./arms.ts";
import { assertNoSecrets, jevEntry, readFixture, replayJev, requestBytes, sha256Hex, writeFixture } from "./calls.ts";

const response = {
  model: "jev-1.13.0",
  answers: { q1: { type: "choice", choice: "hand_off", confidence: 0.9, probabilities: { answer: 0.1, hand_off: 0.9 } } },
  usage: { input_tokens: 500, output_tokens: 3 },
};
const c1 = { case_id: "m01", case_input: "Is it safe?" };
const c2 = { case_id: "m02", case_input: "Do you sell helmets?" };
const bodyFor = (c: { case_id: string; case_input: string }) => jevBody("SHEET", c);

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "uc13-calls-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Jev fixture", () => {
  test("[unit] UC13-7 an entry keeps the exact request, its sha256, the full response, latency and usage", () => {
    const entry = jevEntry("m01", bodyFor(c1), response, 812, "2026-10-01T10:00:00Z");
    expect(entry.request_sha256).toBe(sha256Hex(requestBytes(bodyFor(c1))));
    expect(entry.request).toEqual(bodyFor(c1));
    expect(entry.response).toEqual(response);
    expect([entry.latency_ms, entry.http, entry.usage]).toEqual([812, 200, response.usage]);
  });

  test("[unit] UC13-7 a response with an authorization or api_key field, or a key-like string, is refused", () => {
    expect(() => assertNoSecrets({ ...response, Authorization: "x" }, "m01")).toThrow(/secret field/);
    expect(() => assertNoSecrets({ nested: [{ api_key: "x" }] }, "m01")).toThrow(/secret field/);
    expect(() => assertNoSecrets({ note: "api_abc123" }, "m01")).toThrow(/key-like/);
    expect(() => jevEntry("m01", bodyFor(c1), { ...response, apiKey: "x" }, 1, "u")).toThrow(/m01/);
    expect(() => assertNoSecrets(response, "m01")).not.toThrow();
  });

  test("[unit] UC13-7 a request or response off the jev-1.13.0 pin is refused", () => {
    expect(() => jevEntry("m01", bodyFor(c1), { ...response, model: "jev-1.12.0" }, 1, "u")).toThrow(/pin/);
    expect(() => jevEntry("m01", { ...bodyFor(c1), model: "jev-1.12.0" }, response, 1, "u")).toThrow(/pin/);
  });

  test("[unit] UC13-8 replay rebuilds replies and latency from the fixture file, no network", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "f.json");
      await writeFixture(path, [jevEntry("m01", bodyFor(c1), response, 812, "u"), jevEntry("m02", bodyFor(c2), response, 90, "u")], "2026-10-01T10:00:00Z");
      const out = replayJev(await readFixture(path), [c1, c2], bodyFor);
      expect(out.map((o) => [o.reply.choice, o.ms])).toEqual([["hand_off", 812], ["hand_off", 90]]);
    });
  });

  test("[unit] UC13-8 replay fails loudly on a missing case or an edited prompt", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "f.json");
      await writeFixture(path, [jevEntry("m01", bodyFor(c1), response, 1, "u")], "t");
      const fixture = await readFixture(path);
      expect(() => replayJev(fixture, [c1, c2], bodyFor)).toThrow(/m02/);
      expect(() => replayJev(fixture, [c1], (c) => jevBody("EDITED SHEET", c))).toThrow(/request changed/);
      await expect(readFixture(join(dir, "none.json"))).rejects.toThrow(/missing/);
    });
  });
});
