import { test, expect } from "bun:test";
import { callProvider, parseAnswerRequest } from "./providers.ts";
import type { AnswerRequest } from "./contracts.ts";
const request: AnswerRequest = {
  version: "backstage/1",
  revision: "test",
  runId: "run-1",
  caseId: "case-1",
  question: "Keep?",
  choices: [
    { name: "keep", definition: "Suitable" },
    { name: "cut", definition: "Unsuitable" },
  ],
  input: "Example",
  provider: "jev",
  key: "secret-test-key",
};
test("[unit] B67 strict requests reject malformed and secret-bearing inputs", () => {
  expect(parseAnswerRequest(request)).not.toBeNull();
  expect(
    parseAnswerRequest({ ...request, endpoint: "https://evil.test" }),
  ).toBeNull();
  expect(parseAnswerRequest({ ...request, input: request.key })).toBeNull();
  expect(
    parseAnswerRequest({
      ...request,
      choices: [{ name: "a|b", definition: "a" }, request.choices[1]],
    }),
  ).toBeNull();
});
test("[unit] B67 Jev pins model and captures real usage from allowlisted fields", async () => {
  const result = await callProvider(request, async (url, options) => {
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(options?.redirect).toBe("error");
    expect(String(options?.body)).not.toContain(request.key);
    return Response.json({
      model: "jev-1.13.0",
      answers: { q1: { choice: "keep" } },
      usage: { input_tokens: 100, output_tokens: 0 },
      secret: request.key,
    });
  });
  expect(result.ok).toBe(true);
  expect(result.tokensIn).toBe(100);
  expect(result.costUsd).toBeCloseTo(0.0000042);
  expect(JSON.stringify(result)).not.toContain(request.key);
});
test("[unit] B67 off-model and unsafe outputs fail without forwarding upstream bodies", async () => {
  for (const payload of [
    { model: "wrong", error: request.key },
    { model: "jev-1.13.0", answers: { q1: { choice: request.key } } },
  ]) {
    const result = await callProvider(request, async () =>
      Response.json(payload),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(request.key);
  }
});
test("[unit] B67 provider errors preserve charge uncertainty with no retry or leaked body", async () => {
  let calls = 0;
  const result = await callProvider(request, async () => {
    calls++;
    return new Response(request.key, { status: 500 });
  });
  expect(calls).toBe(1);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.charge).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain(request.key);
});
test("[unit] B67 Anthropic exact output and token usage, missing usage stays unknown", async () => {
  for (const usage of [{ input_tokens: 10, output_tokens: 2 }, undefined]) {
    const result = await callProvider(
      { ...request, provider: "llm" },
      async () =>
        Response.json({
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "keep" }],
          stop_reason: "end_turn",
          usage,
        }),
    );
    expect(result.ok).toBe(true);
    expect(result.costUsd).toBe(usage ? 0.00002 : null);
  }
});
test("[unit] B67 charged malformed answer preserves usage; off-model never uses pinned price", async () => {
  const result = await callProvider({ ...request, provider: "llm" }, async () =>
    Response.json({
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: "maybe" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.costUsd).toBe(0.00002);
  if (!result.ok) expect(result.charge).toBe("known");
  const wrong = await callProvider(request, async () =>
    Response.json({
      model: "wrong",
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
  );
  expect(wrong.costUsd).toBeNull();
  expect(wrong.tokensIn).toBe(100);
});
test("[unit] B67 oversized and truncated provider responses never become answers", async () => {
  const huge = await callProvider(
    request,
    async () => new Response("x".repeat(65537)),
  );
  expect(huge.ok).toBe(false);
  const truncated = await callProvider(
    { ...request, provider: "llm" },
    async () =>
      Response.json({
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text: "keep" }],
        stop_reason: "max_tokens",
      }),
  );
  expect(truncated.ok).toBe(false);
});
test("[unit] B67 timeout retains uncertainty and cache usage is never underpriced", async () => {
  const timeout = await callProvider(
    request,
    async (_url, options) => {
      await new Promise((_, reject) =>
        options.signal?.addEventListener("abort", () =>
          reject(new Error(request.key)),
        ),
      );
      return Response.json({});
    },
    2,
  );
  expect(timeout.ok).toBe(false);
  if (!timeout.ok) {
    expect(timeout.code).toBe("timeout");
    expect(timeout.charge).toBe("unknown");
  }
  const cache = await callProvider({ ...request, provider: "llm" }, async () =>
    Response.json({
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: "keep" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 100,
      },
    }),
  );
  expect(cache.ok).toBe(true);
  expect(cache.costUsd).toBeNull();
});
test("[unit] B67 identifier and choice bounds match CSV constraints", () => {
  expect(parseAnswerRequest({ ...request, runId: "r".repeat(65) })).toBeNull();
  expect(
    parseAnswerRequest({
      ...request,
      choices: [{ name: "a".repeat(65), definition: "A" }, request.choices[1]],
    }),
  ).toBeNull();
  expect(
    parseAnswerRequest({
      ...request,
      choices: [{ name: "a\tb", definition: "A" }, request.choices[1]],
    }),
  ).toBeNull();
});
test("[unit] B67 timeout cancels a stalled provider response body", async () => {
  let cancelled = false;
  const result = await callProvider(
    request,
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    5,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe("timeout");
  expect(cancelled).toBe(true);
});

test("[unit] B4 malformed cache usage cannot become a known cost", async () => {
  for (const cache of ["100", null, -1, 1.5, {}, false]) {
    const result = await callProvider({ ...request, provider: "llm" }, async () => Response.json({
      model: "claude-haiku-4-5-20251001", stop_reason: "end_turn",
      content: [{ type: "text", text: "keep" }],
      usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: cache },
    }));
    expect(result.costUsd).toBeNull();
  }
});
