import { checkJevResponse } from "../jev-answer.ts";
import { PROTOCOL_VERSION } from "./contracts.ts";
import type {
  AnswerRequest,
  AnswerResult,
  AttemptEvidence,
  Choice,
  ModelEntry,
  DispatchError,
} from "./contracts.ts";
import { MODEL_CATALOG, CATALOG_VERSION, getModelEntry } from "./catalog.ts";
import { requestFingerprint } from "./fingerprint.ts";
import { decisionPrompt } from "./prompt.ts";
export { requestFingerprint } from "./fingerprint.ts";
export type ProviderFetch = (
  url: string,
  options: RequestInit,
) => Promise<Response>;
export const PROVIDER_TIMEOUT_MS = 30000;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  );
}
function id(value: unknown, max = 64): value is string {
  return text(value, max) && /^[A-Za-z0-9_.-]+$/.test(value);
}
function choice(value: unknown): value is Choice {
  return (
    object(value) &&
    Object.keys(value).every((k) => ["name", "definition"].includes(k)) &&
    text(value.name, 64) &&
    value.name === value.name.trim() &&
    !/[|\u0000-\u001f\u007f]/.test(value.name) &&
    text(value.definition, 1000)
  );
}
export function dispatchError(code: string, message: string): DispatchError {
  return {
    ok: false,
    dispatched: false,
    code,
    message,
    error: message,
    charge: "none",
  };
}
export type RequestValidation =
  | { ok: true; request: AnswerRequest }
  | { ok: false; error: DispatchError };
export function validateAnswerRequest(
  value: unknown,
  catalog: readonly ModelEntry[] = MODEL_CATALOG,
): RequestValidation {
  const fail = (code: string, message: string): RequestValidation => ({
    ok: false,
    error: dispatchError(code, message),
  });
  if (!object(value))
    return fail("invalid-request", "Expected a JSON request.");
  if (value.version !== PROTOCOL_VERSION)
    return fail(
      "protocol-mismatch",
      "Backstage protocol changed. Reload before running.",
    );
  if (value.catalogVersion !== CATALOG_VERSION)
    return fail(
      "catalog-mismatch",
      "Model catalog changed. Reload before running.",
    );
  const {
    version,
    revision,
    runId,
    caseId,
    question,
    choices,
    input,
    provider,
    key,
    catalogVersion,
    armId,
    modelId,
    promptVersion,
  } = value;
  const entry =
    typeof armId === "string" ? catalog.find((e) => e.id === armId) : undefined;
  if (!entry || !entry.enabled)
    return fail(
      "unsupported-arm",
      "Selected model is unavailable in this catalog.",
    );
  if (entry.provider !== provider || entry.modelId !== modelId)
    return fail(
      "model-selection-mismatch",
      "Selected model does not match its provider or catalog.",
    );
  if (
    Object.keys(value).some(
      (k) =>
        ![
          "version",
          "revision",
          "runId",
          "caseId",
          "question",
          "choices",
          "input",
          "provider",
          "key",
          "catalogVersion",
          "armId",
          "modelId",
          "promptVersion",
        ].includes(k),
    )
  )
    return fail("invalid-request", "Unexpected request fields.");
  if (
    !id(revision) ||
    !id(runId) ||
    !id(caseId) ||
    !/^[A-Za-z0-9_-]+$/.test(caseId) ||
    !id(promptVersion) ||
    !text(question, 1000) ||
    !text(input, 8000) ||
    !Array.isArray(choices) ||
    choices.length !== 2 ||
    !choice(choices[0]) ||
    !choice(choices[1]) ||
    choices[0].name === choices[1].name
  )
    return fail(
      "invalid-request",
      "Invalid decision, choices, case or identity.",
    );
  if (typeof key !== "string" || !/^[\x21-\x7e]{8,512}$/.test(key))
    return fail("invalid-key", "Enter a validly shaped key for this provider.");
  if (
    [
      revision,
      runId,
      caseId,
      promptVersion,
      question,
      input,
      choices[0].name,
      choices[0].definition,
      choices[1].name,
      choices[1].definition,
      entry.id,
      entry.modelId,
      catalogVersion,
    ].some((s) => s.includes(key))
  )
    return fail(
      "unsafe-input",
      "Remove the provider credential from decision text.",
    );
  return {
    ok: true,
    request: {
      version,
      revision,
      runId,
      caseId,
      question,
      choices: [choices[0], choices[1]],
      input,
      provider: entry.provider,
      key,
      catalogVersion,
      armId: entry.id,
      modelId: entry.modelId,
      promptVersion,
    },
  };
}
export function parseAnswerRequest(value: unknown): AnswerRequest | null {
  const result = validateAnswerRequest(value);
  return result.ok ? result.request : null;
}
export async function boundedText(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  const abort = () => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error("body-timeout");
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) throw new Error("body-limit");
      chunks.push(part.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
  if (signal?.aborted) throw new Error("body-timeout");
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}
function token(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
export function buildProviderRequest(
  request: AnswerRequest,
  entry: ModelEntry,
): { url: string; headers: Record<string, string>; body: unknown } {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const params = entry.parameters;
  if (entry.provider === "jev")
    return {
      url: "https://api.typesafe.ai/v1/systemone",
      headers: { ...headers, authorization: `Bearer ${request.key}` },
      body: {
        model: entry.modelId,
        state: request.input,
        questions: {
          q1: {
            type: "choice",
            instructions: { question: request.question },
            criteria: Object.fromEntries(
              request.choices.map((c) => [c.name, c.definition]),
            ),
          },
        },
      },
    };
  const instruction = decisionPrompt(request);
  if (entry.provider === "anthropic")
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        ...headers,
        "x-api-key": request.key,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: entry.modelId,
        max_tokens: params.maxOutputTokens,
        system: instruction,
        messages: [{ role: "user", content: request.input }],
        ...(params.thinking === "adaptive"
          ? {
              thinking: { type: "adaptive" },
              output_config: { effort: params.reasoningEffort },
            }
          : { thinking: { type: "disabled" } }),
      },
    };
  if (entry.provider === "google")
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${entry.modelId}:generateContent`,
      headers: { ...headers, "x-goog-api-key": request.key },
      body: {
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: "user", parts: [{ text: request.input }] }],
        generationConfig: {
          maxOutputTokens: params.maxOutputTokens,
          candidateCount: 1,
          thinkingConfig: { thinkingLevel: "LOW" },
        },
      },
    };
  return {
    url:
      entry.provider === "openai"
        ? "https://api.openai.com/v1/responses"
        : "https://api.x.ai/v1/responses",
    headers: { ...headers, authorization: `Bearer ${request.key}` },
    body: {
      model: entry.modelId,
      input: [
        { role: "system", content: instruction },
        { role: "user", content: request.input },
      ],
      max_output_tokens: params.maxOutputTokens,
      reasoning: { effort: params.reasoningEffort },
      tools: [],
      store: false,
    },
  };
}
interface ParsedProvider {
  output: string | null;
  confidence: number | null;
  returnedModel: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheUnknown: boolean;
}
function parseProvider(
  raw: Record<string, unknown>,
  request: AnswerRequest,
): ParsedProvider {
  const usage = object(raw.usage) ? raw.usage : {};
  let tokensIn = token(usage.input_tokens),
    tokensOut = token(usage.output_tokens),
    output: string | null = null,
    confidence: number | null = null;
  let returnedModel: unknown = raw.model;
  let cacheUnknown = [
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ].some((field) => field in usage && token(usage[field]) !== 0);
  if ("input_tokens_details" in usage) {
    const details = usage.input_tokens_details;
    cacheUnknown ||=
      !object(details) ||
      ("cached_tokens" in details && token(details.cached_tokens) !== 0);
  }
  if (request.provider === "jev") {
    const checked = checkJevResponse(
      raw,
      { q1: request.choices.map((c) => c.name) },
      request.modelId,
    );
    if (checked.ok && checked.answers.q1) {
      output = checked.answers.q1.choice;
      confidence = checked.answers.q1.confidence;
    }
  } else if (request.provider === "anthropic") {
    if (raw.stop_reason === "end_turn" && Array.isArray(raw.content)) {
      const texts = raw.content.filter(
        (part: unknown) => object(part) && part.type === "text",
      );
      if (
        texts.length === 1 &&
        object(texts[0]) &&
        typeof texts[0].text === "string" &&
        raw.content.every(
          (part: unknown) =>
            object(part) &&
            ["text", "thinking", "redacted_thinking"].includes(
              String(part.type),
            ),
        )
      )
        output = texts[0].text;
    }
  } else if (request.provider === "google") {
    returnedModel = raw.modelVersion;
    const u = object(raw.usageMetadata) ? raw.usageMetadata : {};
    tokensIn = token(u.promptTokenCount);
    const candidatesTokens = token(u.candidatesTokenCount);
    const thinkingTokens =
      "thoughtsTokenCount" in u ? token(u.thoughtsTokenCount) : 0;
    tokensOut =
      candidatesTokens !== null && thinkingTokens !== null
        ? candidatesTokens + thinkingTokens
        : null;
    cacheUnknown = true; // Google pricing mapping is intentionally unverified in this catalog.
    if (
      (raw.promptFeedback === undefined ||
        (object(raw.promptFeedback) && !raw.promptFeedback.blockReason)) &&
      Array.isArray(raw.candidates) &&
      raw.candidates.length === 1
    ) {
      const candidate = raw.candidates[0];
      if (
        object(candidate) &&
        candidate.finishReason === "STOP" &&
        object(candidate.content) &&
        candidate.content.role === "model" &&
        Array.isArray(candidate.content.parts)
      ) {
        const parts = candidate.content.parts;
        const answers = parts.filter(
          (part: unknown) => object(part) && part.thought !== true,
        );
        if (
          answers.length === 1 &&
          object(answers[0]) &&
          typeof answers[0].text === "string" &&
          parts.every(
            (part: unknown) =>
              object(part) &&
              typeof part.text === "string" &&
              Object.keys(part).every((k) =>
                ["text", "thought", "thoughtSignature"].includes(k),
              ),
          )
        )
          output = answers[0].text;
      }
    }
  } else if (
    raw.status === "completed" &&
    !raw.error &&
    !raw.incomplete_details &&
    Array.isArray(raw.output)
  ) {
    const messages = raw.output.filter(
      (part: unknown) => object(part) && part.type === "message",
    );
    if (
      messages.length === 1 &&
      object(messages[0]) &&
      messages[0].role === "assistant" &&
      messages[0].status === "completed" &&
      Array.isArray(messages[0].content) &&
      messages[0].content.length === 1 &&
      raw.output.every(
        (part: unknown) =>
          object(part) && ["message", "reasoning"].includes(String(part.type)),
      )
    ) {
      const content = messages[0].content[0];
      if (
        object(content) &&
        content.type === "output_text" &&
        typeof content.text === "string"
      )
        output = content.text;
    }
  }
  return {
    output,
    confidence,
    returnedModel,
    tokensIn,
    tokensOut,
    cacheUnknown,
  };
}
export async function callProvider(
  request: AnswerRequest,
  providerFetch: ProviderFetch = fetch,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<AnswerResult> {
  const valid = validateAnswerRequest(request);
  const entry = getModelEntry(request.armId);
  if (!valid.ok || !entry)
    throw new Error("Invalid provider dispatch contract.");
  const start = Date.now(),
    attemptId = crypto.randomUUID(),
    fingerprint = await requestFingerprint(request, entry);
  let tokensIn: number | null = null,
    tokensOut: number | null = null,
    costUsd: number | null = null,
    returnedModel: string | null = null;
  const evidence = (): AttemptEvidence => ({
    revision: request.revision,
    runId: request.runId,
    caseId: request.caseId,
    provider: request.provider,
    armId: entry.id,
    catalogVersion: entry.catalogVersion,
    promptVersion: request.promptVersion,
    requestedModel: entry.modelId,
    returnedModel,
    parameters: entry.parameters,
    attemptId,
    fingerprint,
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date().toISOString(),
    latencyMs: Date.now() - start,
    model: entry.modelId,
    tokensIn,
    tokensOut,
    costUsd,
    priceVersion: entry.pricing?.version ?? "unknown",
  });
  const fail = (
    code: string,
    message: string,
    charge: "none" | "unknown" | "known" = "unknown",
  ): AnswerResult => ({
    ...evidence(),
    ok: false,
    code,
    message,
    charge: costUsd === null ? charge : "known",
  });
  const signal = AbortSignal.timeout(
    Math.min(PROVIDER_TIMEOUT_MS, Math.max(1, timeoutMs)),
  );
  const wire = buildProviderRequest(request, entry);
  try {
    const response = await providerFetch(wire.url, {
      method: "POST",
      headers: wire.headers,
      body: JSON.stringify(wire.body),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return fail(
        `http-${response.status}`,
        response.status === 401 || response.status === 403
          ? "Provider rejected the key."
          : response.status === 429
            ? "Provider rate limit reached. Retry explicitly when ready."
            : "Provider request failed. Check its dashboard before retrying.",
        [400, 401, 403, 404, 429].includes(response.status)
          ? "none"
          : "unknown",
      );
    }
    const raw: unknown = JSON.parse(await boundedText(response, 65536, signal));
    if (!object(raw))
      return fail("invalid-response", "Provider returned an invalid response.");
    const parsed = parseProvider(raw, request);
    tokensIn = parsed.tokensIn;
    tokensOut = parsed.tokensOut;
    if (
      typeof parsed.returnedModel === "string" &&
      /^[A-Za-z0-9._:-]{1,120}$/.test(parsed.returnedModel) &&
      !parsed.returnedModel.includes(request.key)
    )
      returnedModel = parsed.returnedModel;
    if (
      returnedModel === null ||
      !entry.acceptedResponseModelIds.includes(returnedModel)
    )
      return fail(
        "model-mismatch",
        "Provider returned an unrecognized model; answer excluded.",
      );
    if (
      entry.pricing &&
      tokensIn !== null &&
      tokensOut !== null &&
      !parsed.cacheUnknown
    )
      costUsd =
        (tokensIn * entry.pricing.inputUsdPerMillion +
          tokensOut * entry.pricing.outputUsdPerMillion) /
        1e6;
    if (
      parsed.output === null ||
      parsed.output.includes(request.key) ||
      !request.choices.some((c) => c.name === parsed.output)
    )
      return fail(
        "invalid-answer",
        "Provider did not return exactly one valid option; answer excluded.",
      );
    return {
      ...evidence(),
      ok: true,
      output: parsed.output,
      confidence: parsed.confidence,
    };
  } catch {
    return fail(
      signal.aborted ? "timeout" : "network-or-response",
      signal.aborted
        ? "Provider timed out. Charges may have occurred; check before retrying."
        : "Provider connection or response failed. Charges may have occurred; check before retrying.",
    );
  }
}
