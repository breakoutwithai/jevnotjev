import { PROMPT_TEMPLATE_VERSION } from "./prompt.ts";
import { CATALOG_VERSION, MODEL_CATALOG } from "./catalog.ts";
import { test, expect, spyOn } from "bun:test";
import {
  buildProviderRequest,
  callProvider,
  parseAnswerRequest,
} from "./providers.ts";
import type { AnswerRequest } from "./contracts.ts";
const request: AnswerRequest = {
  version: "backstage/2",
  revision: "test",
  catalogVersion: CATALOG_VERSION,
  armId: "jev",
  modelId: "jev-1.13.0",
  promptVersion: PROMPT_TEMPLATE_VERSION,
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
test("[unit] B4 strict requests reject malformed and secret-bearing inputs", () => {
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
test("[unit] B3 Jev pins model and captures real usage from allowlisted fields", async () => {
  const captured: { url: string; options: RequestInit }[] = [];
  const result = await callProvider(request, async (url, options) => {
    captured.push({ url: String(url), options });
    return Response.json({
      model: "jev-1.13.0",
      answers: { q1: { choice: "keep" } },
      usage: { input_tokens: 100, output_tokens: 0 },
      secret: request.key,
    });
  });
  expect(result.ok).toBe(true);
  expect(captured).toHaveLength(1);
  expect(captured[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(captured[0]?.options.redirect).toBe("error");
  expect(String(captured[0]?.options.body)).not.toContain(request.key);
  expect(result.tokensIn).toBe(100);
  expect(result.costUsd).toBeCloseTo(0.0000042);
  expect(JSON.stringify(result)).not.toContain(request.key);
});
test("[unit] B3 off-model and unsafe outputs fail without forwarding upstream bodies", async () => {
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
test("[unit] B5 provider errors preserve charge uncertainty with no retry or leaked body", async () => {
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
test("[unit] B3 Anthropic exact output and token usage, missing usage stays unknown", async () => {
  for (const usage of [{ input_tokens: 10, output_tokens: 2 }, undefined]) {
    const result = await callProvider(
      {
        ...request,
        provider: "anthropic",
        armId: "claude-haiku-4-5-20251001",
        modelId: "claude-haiku-4-5-20251001",
      },
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
test("[unit] B5 charged malformed answer preserves usage; off-model never uses pinned price", async () => {
  const result = await callProvider(
    {
      ...request,
      provider: "anthropic",
      armId: "claude-haiku-4-5-20251001",
      modelId: "claude-haiku-4-5-20251001",
    },
    async () =>
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
test("[unit] B4 oversized and truncated provider responses never become answers", async () => {
  const huge = await callProvider(
    request,
    async () => new Response("x".repeat(65537)),
  );
  expect(huge.ok).toBe(false);
  const truncated = await callProvider(
    {
      ...request,
      provider: "anthropic",
      armId: "claude-haiku-4-5-20251001",
      modelId: "claude-haiku-4-5-20251001",
    },
    async () =>
      Response.json({
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text: "keep" }],
        stop_reason: "max_tokens",
      }),
  );
  expect(truncated.ok).toBe(false);
});
test("[unit] B5 timeout retains uncertainty and cache usage is never underpriced", async () => {
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
  const cache = await callProvider(
    {
      ...request,
      provider: "anthropic",
      armId: "claude-haiku-4-5-20251001",
      modelId: "claude-haiku-4-5-20251001",
    },
    async () =>
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
test("[unit] B4 identifier and choice bounds match CSV constraints", () => {
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
test("[unit] B4 timeout cancels a stalled provider response body", async () => {
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
    const result = await callProvider(
      {
        ...request,
        provider: "anthropic",
        armId: "claude-haiku-4-5-20251001",
        modelId: "claude-haiku-4-5-20251001",
      },
      async () =>
        Response.json({
          model: "claude-haiku-4-5-20251001",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "keep" }],
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: cache,
          },
        }),
    );
    expect(result.costUsd).toBeNull();
  }
});

test("[unit] B3 Anthropic must return the exact choice without whitespace repair", async () => {
  const result = await callProvider(
    {
      ...request,
      provider: "anthropic",
      armId: "claude-haiku-4-5-20251001",
      modelId: "claude-haiku-4-5-20251001",
    },
    async () =>
      Response.json({
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text: " keep\n" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
  );
  expect(result.ok).toBe(false);
  expect(result.costUsd).toBe(0.00002);
});
test("[unit] JF2 Responses adapters use selected native endpoints and store false", async () => {
  for (const [provider, modelId] of [
    ["openai", "gpt-6.1-sol"],
    ["xai", "grok-4.7"],
  ]) {
    if ((provider !== "openai" && provider !== "xai") || !modelId)
      throw new Error("fixture");
    const captured: { url: string; options: RequestInit }[] = [];
    const result = await callProvider(
      { ...request, provider, armId: modelId, modelId },
      async (url, options) => {
        captured.push({ url: String(url), options });
        return Response.json({
          model: modelId,
          status: "completed",
          output: [
            { type: "reasoning", encrypted_content: request.key },
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "keep" }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        });
      },
    );
    expect(captured).toHaveLength(1);
    const sent = captured[0];
    if (!sent) throw new Error("Provider did not dispatch");
    expect(sent.url).toBe(
      provider === "openai"
        ? "https://api.openai.com/v1/responses"
        : "https://api.x.ai/v1/responses",
    );
    const wire: unknown = JSON.parse(String(sent.options.body));
    expect(wire).toMatchObject({
      store: false,
      tools: [],
      max_output_tokens: 1024,
    });
    expect(String(sent.options.body)).not.toContain(request.key);
    expect(result.ok).toBe(true);
    expect(result.returnedModel).toBe(modelId);
    expect(JSON.stringify(result)).not.toContain(request.key);
  }
});
test("[unit] JF2 Google uses header key and rejects blocked/truncated/mismatched answers", async () => {
  const modelId = "gemini-3.8-flash";
  for (const finishReason of ["STOP", "MAX_TOKENS", "SAFETY"]) {
    const captured: { url: string; options: RequestInit }[] = [];
    const result = await callProvider(
      { ...request, provider: "google", armId: modelId, modelId },
      async (url, options) => {
        captured.push({ url: String(url), options });
        return Response.json({
          modelVersion: modelId,
          candidates: [
            {
              finishReason,
              content: { role: "model", parts: [{ text: "keep" }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 1,
            thoughtsTokenCount: 2,
          },
        });
      },
    );
    expect(captured).toHaveLength(1);
    const sent = captured[0];
    if (!sent) throw new Error("Provider did not dispatch");
    expect(sent.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
    );
    expect(sent.url).not.toContain(request.key);
    expect(new Headers(sent.options.headers).get("x-goog-api-key")).toBe(
      request.key,
    );
    expect(result.ok).toBe(finishReason === "STOP");
    expect(result.costUsd).toBeNull();
    expect(result.tokensOut).toBe(3);
  }
});
test("[unit] JF1 catalog disagreement is rejected without inference", () => {
  for (const bad of [
    { ...request, armId: "unknown" },
    { ...request, catalogVersion: "old" },
    { ...request, modelId: "gpt-6.1-sol" },
    { ...request, version: "backstage/1" },
  ])
    expect(parseAnswerRequest(bad)).toBeNull();
});
test("[unit] JF2 adaptive Anthropic text survives reasoning blocks without exporting reasoning", async () => {
  for (const modelId of [
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
  ]) {
    const captured: { url: string; options: RequestInit }[] = [];
    const result = await callProvider(
      { ...request, provider: "anthropic", armId: modelId, modelId },
      async (url, options) => {
        captured.push({ url: String(url), options });
        return Response.json({
          model: modelId,
          stop_reason: "end_turn",
          content: [
            { type: "thinking", thinking: request.key },
            { type: "text", text: "keep" },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        });
      },
    );
    expect(captured).toHaveLength(1);
    const sent = captured[0];
    if (!sent) throw new Error("Provider did not dispatch");
    const wire: unknown = JSON.parse(String(sent.options.body));
    expect(wire).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      max_tokens: 1024,
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(request.key);
  }
});
test("[unit] JF2 Responses refuses tool calls refusal extra output and unexpected model identity", async () => {
  const modelId = "gpt-6.1-sol";
  const message = {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "keep" }],
  };
  for (const raw of [
    { model: modelId, status: "incomplete", output: [message] },
    {
      model: modelId,
      status: "completed",
      output: [message, { type: "function_call" }],
    },
    { model: modelId, status: "completed", output: [message, message] },
    {
      model: modelId,
      status: "completed",
      output: [
        { ...message, content: [{ type: "refusal", refusal: request.key }] },
      ],
    },
    { model: "gpt-other", status: "completed", output: [message] },
  ]) {
    const result = await callProvider(
      { ...request, provider: "openai", armId: modelId, modelId },
      async () => Response.json(raw),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(request.key);
  }
});
test("[unit] JF2 cached Responses usage never uses uncached prices when cache cost is unresolved", async () => {
  for (const provider of ["openai", "xai"]) {
    if (provider !== "openai" && provider !== "xai") throw new Error("fixture");
    const modelId = provider === "openai" ? "gpt-6.1-sol" : "grok-4.7";
    for (const cached_tokens of [10, "10", null, -1]) {
      const result = await callProvider(
        { ...request, provider, armId: modelId, modelId },
        async () =>
          Response.json({
            model: modelId,
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "keep" }],
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              input_tokens_details: { cached_tokens },
            },
          }),
      );
      expect(result.ok).toBe(true);
      expect(result.costUsd).toBeNull();
    }
  }
});
test("[unit] JF2 Google nonblocking safety feedback is valid but model mismatch is excluded", async () => {
  const modelId = "gemini-3.8-flash";
  for (const modelVersion of [modelId, "gemini-other"]) {
    const result = await callProvider(
      { ...request, provider: "google", armId: modelId, modelId },
      async () =>
        Response.json({
          modelVersion,
          promptFeedback: { safetyRatings: [] },
          candidates: [
            {
              finishReason: "STOP",
              content: { role: "model", parts: [{ text: "keep" }] },
            },
          ],
        }),
    );
    expect(result.ok).toBe(modelVersion === modelId);
  }
});
test("[unit] JF2 catalog generation controls are the actual outgoing native parameters", async () => {
  for (const armId of [
    "claude-haiku-4-5-20251001",
    "claude-sonnet-5-5",
    "gemini-3.8-flash",
    "gpt-6.1-sol",
    "grok-4.7",
  ]) {
    const entry = MODEL_CATALOG.find((model) => model.id === armId);
    if (!entry) throw new Error("fixture");
    const captured: string[] = [];
    const result = await callProvider(
      { ...request, provider: entry.provider, armId, modelId: entry.modelId },
      async (_url, options) => {
        captured.push(String(options.body));
        return new Response("", { status: 401 });
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "http-401",
      charge: "none",
    });
    expect(captured).toHaveLength(1);
    const raw = captured[0];
    if (!raw) throw new Error("Provider did not dispatch");
    const wire: unknown = JSON.parse(raw);
    if (entry.provider === "anthropic") {
      expect(wire).toMatchObject({
        thinking: { type: entry.parameters.thinking },
        max_tokens: entry.parameters.maxOutputTokens,
      });
      if (entry.parameters.thinking === "adaptive")
        expect(wire).toMatchObject({
          output_config: { effort: entry.parameters.reasoningEffort },
        });
    } else if (entry.provider === "google") {
      expect(wire).toMatchObject({
        generationConfig: {
          maxOutputTokens: entry.parameters.maxOutputTokens,
          candidateCount: 1,
          thinkingConfig: { thinkingLevel: "LOW" },
        },
      });
    } else {
      expect(wire).toMatchObject({
        reasoning: { effort: entry.parameters.reasoningEffort },
        max_output_tokens: entry.parameters.maxOutputTokens,
      });
    }
  }
});
test("[unit] JF2 Google omits unsupported thinking parameters", () => {
  const entry = MODEL_CATALOG.find((model) => model.id === "gemini-3.8-flash");
  if (!entry) throw new Error("fixture");
  const outgoing = buildProviderRequest(request, {
    ...entry,
    parameters: { ...entry.parameters, reasoningEffort: null },
  });
  const wire: unknown = outgoing.body;
  expect(wire).toMatchObject({
    generationConfig: {
      maxOutputTokens: entry.parameters.maxOutputTokens,
      candidateCount: 1,
    },
  });
  expect(JSON.stringify(wire)).not.toContain("thinkingConfig");
});
test("[unit] JF2 provider deadline clamps caller timeout to thirty seconds", async () => {
  const durations: number[] = [];
  const spy = spyOn(AbortSignal, "timeout").mockImplementation(
    (milliseconds) => {
      durations.push(milliseconds);
      return new AbortController().signal;
    },
  );
  try {
    await callProvider(
      request,
      async () => new Response("", { status: 401 }),
      90000,
    );
    expect(durations).toEqual([30000]);
  } finally {
    spy.mockRestore();
  }
});
