import {
  MODELS,
  PROTOCOL_VERSION,
  type AnswerRequest,
  type AnswerResult,
  type AnswerFailure,
  type Provider,
  type Scene,
} from "./contracts.ts";
import { COLUMNS, validate } from "../format/validate.ts";
import { formatRows, readDictRows } from "../format/csv.ts";
import { cohortMetrics } from "../core/metrics.ts";
import { fileSeed } from "../core/calc.ts";
import { verdict } from "../core/verdict.ts";

export interface Keys {
  readonly jev: string;
  readonly llm: string;
}
export type Transport = (
  request: AnswerRequest,
  signal: AbortSignal,
) => Promise<unknown>;
export type Label = "accept" | "reject" | null;
export interface Manifest {
  readonly revision: string;
  readonly runId: string;
  readonly promptVersion: string;
  readonly questionId: string;
  readonly createdAt: string;
  readonly scene: Scene;
}
export interface Card {
  readonly id: string;
  readonly caseId: string;
  readonly input: string;
  readonly output: string;
  readonly label: Label;
}
interface RowAnswer {
  readonly id: string;
  readonly caseId: string;
  readonly provider: Provider | "rule";
  readonly output: string;
  readonly confidence: number | null;
  readonly model: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
}
const providers: readonly Provider[] = ["jev", "llm"];
function containsKey(value: unknown, keys: readonly string[]): boolean {
  if (typeof value === "string")
    return keys.some((key) => key.length > 0 && value.includes(key));
  if (Array.isArray(value))
    return value.some((item) => containsKey(item, keys));
  if (typeof value === "object" && value !== null)
    return Object.values(value).some((item) => containsKey(item, keys));
  return false;
}
export function validateSceneKeys(scene: Scene, keys: Keys): void {
  if (containsKey(scene, Object.values(keys)))
    throw new Error(
      "A provider key appears in the scene. Remove it before running.",
    );
  for (const provider of providers)
    if (!/^[\x21-\x7e]{8,512}$/.test(keys[provider]))
      throw new Error(
        `Supply a valid ${provider} key (8-512 printable characters, no spaces).`,
      );
}
function bounded(value: string, limit: number, name: string): string {
  if (
    !value.trim() ||
    value.length > limit ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new Error(`${name} is required (maximum ${limit} characters).`);
  return value;
}
function validCases(cases: Scene["cases"]): Scene["cases"] {
  if (cases.length < 1 || cases.length > 100)
    throw new Error("Add between 1 and 100 cases.");
  const ids = new Set<string>();
  return Object.freeze(
    cases.map((c) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(c.id) || ids.has(c.id))
        throw new Error(
          "Case IDs must be unique: letters, numbers, underscores or hyphens, at most 64 characters.",
        );
      ids.add(c.id);
      return Object.freeze({
        id: c.id,
        input: bounded(c.input, 8000, "Case input"),
      });
    }),
  );
}
/** Strict import boundary; the shared historical record reader remains permissive. */
function checkCaseCsvSyntax(csv: string): void {
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  for (const char of csv) {
    if (state === "quoted") {
      if (char === '"') state = "closed";
      continue;
    }
    if (state === "closed") {
      if (char === '"') {
        state = "quoted";
        continue;
      }
      if (char === "," || char === "\r" || char === "\n") {
        state = "start";
        continue;
      }
      throw new Error(
        "Invalid case CSV: unexpected text after a closing quote.",
      );
    }
    if (char === "," || char === "\r" || char === "\n") {
      state = "start";
      continue;
    }
    if (char === '"') {
      if (state !== "start")
        throw new Error("Invalid case CSV: quote inside an unquoted field.");
      state = "quoted";
    } else state = "plain";
  }
  if (state === "quoted")
    throw new Error("Invalid case CSV: quoted field was not closed.");
}
export function parseCases(csv: string): Scene["cases"] {
  checkCaseCsvSyntax(csv);
  const parsed = readDictRows(csv);
  if (
    parsed.header?.length !== 2 ||
    parsed.header[0] !== "case_id" ||
    parsed.header[1] !== "case_input"
  )
    throw new Error("Use exactly the CSV columns case_id,case_input.");
  return validCases(
    parsed.rows.map((r) => {
      if (r.fields.length !== 2)
        throw new Error(`Invalid case CSV at line ${r.line}.`);
      return { id: r.fields[0] ?? "", input: r.fields[1] ?? "" };
    }),
  );
}
function freezeScene(s: Scene): Scene {
  const choices: Scene["choices"] = [
    Object.freeze({
      name: bounded(s.choices[0].name, 64, "Choice"),
      definition: bounded(s.choices[0].definition, 1000, "Definition"),
    }),
    Object.freeze({
      name: bounded(s.choices[1].name, 64, "Choice"),
      definition: bounded(s.choices[1].definition, 1000, "Definition"),
    }),
  ];
  if (
    choices[0].name === choices[1].name ||
    choices.some(
      (c) => /[|\x00-\x1f\x7f]/.test(c.name) || c.name !== c.name.trim(),
    )
  )
    throw new Error(
      "Use two different choice names without pipes or line breaks.",
    );
  if (
    !choices.some((c) => c.name === s.matchChoice) ||
    !choices.some((c) => c.name === s.otherwiseChoice)
  )
    throw new Error("The rule must select one of the named choices.");
  if (s.keywords.length > 20)
    throw new Error("Provide at most 20 literal keywords.");
  if (s.exclusions.length > 2000)
    throw new Error("Exclusions are limited to 2000 characters.");
  return Object.freeze({
    question: bounded(s.question, 1000, "Question"),
    choices: Object.freeze(choices),
    acceptance: bounded(s.acceptance, 2000, "Acceptance rule"),
    exclusions: s.exclusions,
    keywords: Object.freeze(s.keywords.map((k) => bounded(k, 200, "Keyword"))),
    matchChoice: s.matchChoice,
    otherwiseChoice: s.otherwiseChoice,
    cases: validCases(s.cases),
  });
}
export async function inputFingerprint(
  r: Pick<AnswerRequest, "question" | "choices" | "input" | "provider">,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      question: r.question,
      choices: r.choices,
      input: r.input,
      provider: r.provider,
      model: MODELS[r.provider],
    }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
function object(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function amount(v: unknown, integer = false): v is number | null {
  return (
    v === null ||
    (typeof v === "number" &&
      Number.isFinite(v) &&
      v >= 0 &&
      (!integer || Number.isSafeInteger(v)))
  );
}
function short(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200;
}
function date(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) &&
    Number.isFinite(Date.parse(v))
  );
}
/** Only allowlisted fields cross the response boundary. Arbitrary upstream metadata never reaches export. */
export async function parseAnswerResult(
  value: unknown,
  request: AnswerRequest,
): Promise<AnswerResult> {
  if (
    !object(value) ||
    value.runId !== request.runId ||
    value.revision !== request.revision ||
    value.caseId !== request.caseId ||
    value.provider !== request.provider ||
    value.model !== MODELS[request.provider] ||
    value.fingerprint !== (await inputFingerprint(request)) ||
    !short(value.attemptId) ||
    !/^[A-Za-z0-9_-]+$/.test(value.attemptId) ||
    !date(value.startedAt) ||
    !date(value.finishedAt) ||
    !amount(value.latencyMs, true) ||
    value.latencyMs === null ||
    !amount(value.tokensIn, true) ||
    !amount(value.tokensOut, true) ||
    !amount(value.costUsd) ||
    !short(value.priceVersion)
  )
    throw new Error("Invalid response evidence.");
  const common = {
    runId: request.runId,
    revision: request.revision,
    caseId: request.caseId,
    provider: request.provider,
    model: MODELS[request.provider],
    attemptId: value.attemptId,
    fingerprint: await inputFingerprint(request),
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    latencyMs: value.latencyMs,
    tokensIn: value.tokensIn,
    tokensOut: value.tokensOut,
    costUsd: value.costUsd,
    priceVersion: value.priceVersion,
  };
  if (containsKey(common, [request.key]))
    throw new Error("Unsafe response evidence.");
  if (
    value.ok === true &&
    typeof value.output === "string" &&
    request.choices.some((c) => c.name === value.output) &&
    amount(value.confidence) &&
    (value.confidence === null || value.confidence <= 1)
  )
    return {
      ...common,
      ok: true,
      output: value.output,
      confidence: value.confidence,
    };
  if (
    value.ok === false &&
    (value.charge === "none" ||
      value.charge === "unknown" ||
      value.charge === "known") &&
    short(value.code) &&
    /^[a-z0-9_-]{1,40}$/.test(value.code)
  )
    return {
      ...common,
      ok: false,
      code: value.code,
      message: `Provider call failed (${value.code}).`,
      charge: value.charge,
    };
  throw new Error("Invalid answer response.");
}
export const answerTransport: Transport = async (request, signal) => {
  const began = Date.now();
  const response = await fetch("/api/backstage/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.any([signal, AbortSignal.timeout(65000)]),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    const expected: Readonly<Record<number, readonly string[]>> = {
      400: [
        "Invalid request. Check case, options and credentials.",
        "Invalid or oversized request.",
      ],
      403: ["Same-origin requests required."],
      409: ["Page and runner versions differ. Reload before running."],
      413: ["Request too large."],
      415: ["JSON required."],
      503: ["Runner busy. Retry explicitly when ready."],
    };
    if (
      response.headers.get("content-type")?.includes("application/json") &&
      expected[response.status]
    ) {
      const body: unknown = await response.json();
      if (
        object(body) &&
        typeof body.error === "string" &&
        expected[response.status]?.includes(body.error)
      ) {
        const failure: AnswerFailure = {
          ok: false,
          runId: request.runId,
          revision: request.revision,
          caseId: request.caseId,
          provider: request.provider,
          model: MODELS[request.provider],
          attemptId: crypto.randomUUID(),
          fingerprint: await inputFingerprint(request),
          startedAt: new Date(began).toISOString(),
          finishedAt: new Date().toISOString(),
          latencyMs: Date.now() - began,
          tokensIn: null,
          tokensOut: null,
          costUsd: 0,
          priceVersion: "not-called",
          charge: "none",
          code: `local-${response.status}`,
          message:
            "The runner rejected this request before calling the provider.",
        };
        return failure;
      }
    }
    throw new Error("Answer request failed.");
  }
  return response.json();
};

/** Owns a single frozen cohort. Provider keys exist only in the active async call closure. */
export class BackstageRun {
  readonly manifest: Manifest;
  #attempts: AnswerResult[] = [];
  #answers: RowAnswer[] = [];
  #labels = new Map<string, Label>();
  #order = new Map<string, number>();
  #controller: AbortController | null = null;
  #started = false;
  #revealed = false;
  #labeling = false;
  #unsafe = false;
  #notify: (() => void) | undefined;
  constructor(scene: Scene, revision = "test") {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(revision))
      throw new Error("Invalid run revision.");
    const frozen = freezeScene(scene);
    this.manifest = Object.freeze({
      runId: crypto.randomUUID(),
      revision,
      promptVersion: "backstage-v1",
      questionId: "decision",
      createdAt: new Date().toISOString(),
      scene: frozen,
    });
    // Shuffle slots before results arrive: completion order and provider order cannot reveal identity.
    const slots = frozen.cases.flatMap((c) =>
      ["rule", "jev", "llm"].map((p) => `${c.id}:${p}`),
    );
    for (let i = slots.length - 1; i > 0; i--) {
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      const j = Math.floor(((random[0] ?? 0) / 4294967296) * (i + 1));
      const a = slots[i];
      const b = slots[j];
      if (a !== undefined && b !== undefined) {
        slots[i] = b;
        slots[j] = a;
      }
    }
    slots.forEach((slot, i) => this.#order.set(slot, i));
  }
  get running(): boolean {
    return this.#controller !== null;
  }
  get attempts(): readonly AnswerResult[] {
    return structuredClone(this.#attempts);
  }
  get completed(): number {
    return this.#answers.filter((a) => a.provider !== "rule").length;
  }
  get total(): number {
    return this.manifest.scene.cases.length * 2;
  }
  get started(): boolean {
    return this.#started;
  }
  get labeling(): boolean {
    return this.#labeling;
  }
  beginLabeling(): void {
    if (this.#unsafe)
      throw new Error(
        "This run contains a provider key. Start a new scene without the key.",
      );
    if (this.running || !this.#answers.length || this.#unsafe)
      throw new Error("Finish or stop the run before opening blind judging.");
    this.#labeling = true;
  }
  get revealed(): boolean {
    return this.#revealed;
  }
  reveal(): void {
    if (
      this.running ||
      !this.#answers.length ||
      this.#unsafe ||
      !this.#labeling
    )
      throw new Error("Finish or stop a safe run before revealing results.");
    this.#revealed = true;
  }
  cards(): readonly Card[] {
    return [...this.#answers]
      .sort(
        (a, b) =>
          (this.#order.get(`${a.caseId}:${a.provider}`) ?? 0) -
          (this.#order.get(`${b.caseId}:${b.provider}`) ?? 0),
      )
      .map((a) => ({
        id: a.id,
        caseId: a.caseId,
        input:
          this.manifest.scene.cases.find((c) => c.id === a.caseId)?.input ?? "",
        output: a.output,
        label: this.#labels.get(a.id) ?? null,
      }));
  }
  label(id: string, label: Label): void {
    if (!this.#labeling)
      throw new Error(
        "Open blind judging before labeling. This locks retries.",
      );
    if (this.#revealed)
      throw new Error("Labels are locked after revealing results.");
    if (this.running)
      throw new Error("Stop or finish the run before labeling.");
    if (!this.#answers.some((a) => a.id === id))
      throw new Error("Unknown answer card.");
    this.#labels.set(id, label);
  }
  stop(): void {
    this.#controller?.abort();
  }
  async start(
    keys: Keys,
    transport: Transport = answerTransport,
    onChange?: () => void,
  ): Promise<void> {
    if (this.#started)
      throw new Error(
        "This run has already started. Use explicit retry for incomplete calls.",
      );
    await this.#execute(keys, transport, onChange);
  }
  async retry(
    keys: Keys,
    transport: Transport = answerTransport,
    onChange?: () => void,
  ): Promise<void> {
    if (this.#labeling)
      throw new Error(
        "Retries are locked once blind judging begins. Start a new run.",
      );
    if (!this.#started) throw new Error("Start the run first.");
    await this.#execute(keys, transport, onChange);
  }
  async #execute(
    keys: Keys,
    transport: Transport,
    onChange?: () => void,
  ): Promise<void> {
    if (this.running) throw new Error("A run is already in progress.");
    const scene = this.manifest.scene;
    if (this.#unsafe)
      throw new Error(
        "This run was rejected because it contains a key. Start a new scene.",
      );
    const keyValues = Object.values(keys);
    if (
      containsKey(scene, keyValues) ||
      containsKey(this.#attempts, keyValues) ||
      containsKey(this.#answers, keyValues)
    ) {
      this.#unsafe = true;
      throw new Error(
        "A provider key appears in run data. Start a new scene without the key.",
      );
    }
    validateSceneKeys(scene, keys);
    this.#started = true;
    const controller = new AbortController();
    this.#controller = controller;
    this.#notify = onChange;
    if (!this.#answers.length)
      for (const c of scene.cases) {
        const ruleStarted = performance.now();
        const output = scene.keywords.some((k) =>
          c.input.toLowerCase().includes(k.toLowerCase()),
        )
          ? scene.matchChoice
          : scene.otherwiseChoice;
        const latencyMs = Math.round(performance.now() - ruleStarted);
        this.#answers.push({
          id: crypto.randomUUID(),
          caseId: c.id,
          provider: "rule",
          output,
          model: "keywords-v1",
          confidence: null,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          latencyMs,
        });
      }
    try {
      this.#notify?.();
      for (const c of scene.cases)
        for (const provider of providers) {
          if (controller.signal.aborted) return;
          if (
            this.#answers.some(
              (a) => a.caseId === c.id && a.provider === provider,
            )
          )
            continue;
          const request: AnswerRequest = {
            version: PROTOCOL_VERSION,
            runId: this.manifest.runId,
            revision: this.manifest.revision,
            caseId: c.id,
            question: scene.question,
            choices: scene.choices,
            input: c.input,
            provider,
            key: keys[provider],
          };
          const began = Date.now();
          let result: AnswerResult;
          const fingerprint = await inputFingerprint(request);
          if (controller.signal.aborted) return;
          const interrupted = (): AnswerFailure => ({
            ok: false,
            runId: request.runId,
            revision: request.revision,
            caseId: c.id,
            provider,
            attemptId: crypto.randomUUID(),
            fingerprint,
            startedAt: new Date(began).toISOString(),
            finishedAt: new Date().toISOString(),
            latencyMs: Date.now() - began,
            model: MODELS[provider],
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
            priceVersion: "unavailable",
            code: controller.signal.aborted ? "stopped" : "transport_failure",
            message: controller.signal.aborted
              ? "Stopped while in flight; charge may have occurred."
              : "No verified answer received; charge may have occurred.",
            charge: "unknown",
          });
          let abortListener: (() => void) | undefined;
          try {
            const aborted = new Promise<never>((_, reject) => {
              abortListener = () => reject(new Error("Stopped"));
              controller.signal.addEventListener("abort", abortListener, {
                once: true,
              });
              if (controller.signal.aborted) abortListener();
            });
            const raw = await Promise.race([
              transport(request, controller.signal),
              aborted,
            ]);
            result = await parseAnswerResult(raw, request);
            if (containsKey(result, Object.values(keys)))
              throw new Error("Unsafe response evidence.");
            if (controller.signal.aborted) result = interrupted();
          } catch {
            result = interrupted();
          } finally {
            if (abortListener)
              controller.signal.removeEventListener("abort", abortListener);
          }
          this.#attempts.push(result);
          if (result.ok)
            this.#answers.push({
              id: crypto.randomUUID(),
              caseId: c.id,
              provider,
              output: result.output,
              model: result.model,
              confidence: result.confidence,
              tokensIn: result.tokensIn,
              tokensOut: result.tokensOut,
              costUsd: result.costUsd,
              latencyMs: result.latencyMs,
            });
          this.#notify?.();
        }
    } finally {
      this.#controller = null;
      this.#notify?.();
      this.#notify = undefined;
    }
  }
  csv(): string {
    if (this.#unsafe)
      throw new Error("Export blocked: this run contains a provider key.");
    const s = this.manifest.scene;
    const rows = this.#answers.map((a) => {
      const label = this.#labels.get(a.id) ?? null;
      const data: Record<string, string | number | null> = {
        format_version: "jnj-record/1",
        run_id: this.manifest.runId,
        prompt_version: this.manifest.promptVersion,
        case_id: a.caseId,
        case_input: s.cases.find((c) => c.id === a.caseId)?.input ?? "",
        question_id: this.manifest.questionId,
        question: s.question,
        answer_set: s.choices.map((c) => c.name).join("|"),
        answerer: a.provider,
        answerer_model: a.model,
        output: a.output,
        confidence: a.confidence,
        label,
        label_source: label === null ? null : "human",
        tokens_in: a.tokensIn,
        tokens_out: a.tokensOut,
        cost_usd: a.costUsd,
        latency_ms: a.latencyMs,
      };
      return COLUMNS.map((k) =>
        data[k] === null || data[k] === undefined ? "" : String(data[k]),
      );
    });
    return formatRows([COLUMNS, ...rows]);
  }
  /** Fixed recovery advice only: never identifiers, raw errors or answer mappings. */
  retryAdvice(): readonly string[] {
    const advice = new Set<string>();
    for (const attempt of this.#attempts) {
      if (
        attempt.ok ||
        this.#answers.some(
          (answer) =>
            answer.caseId === attempt.caseId &&
            answer.provider === attempt.provider,
        )
      )
        continue;
      switch (attempt.code) {
        case "http-401":
        case "http-403":
          advice.add(
            "A call rejected a key or account permission. Check both provider keys and account access in Casting before retrying.",
          );
          break;
        case "http-429":
          advice.add(
            "A call was rate limited. Wait and check account limits before retrying unfinished calls.",
          );
          break;
        case "local-409":
          advice.add(
            "The page and runner versions differ. Preserve this run's results, then reload before starting a new scene.",
          );
          break;
        case "local-503":
          advice.add(
            "The runner is busy. Wait before retrying unfinished calls; rejected requests were not sent to providers.",
          );
          break;
        case "local-400":
        case "local-403":
        case "local-413":
        case "local-415":
          advice.add(
            "The runner rejected a request before calling a provider. Check scene inputs and credentials, or reload the page.",
          );
          break;
        case "model-mismatch":
        case "invalid-answer":
        case "invalid-response":
          advice.add(
            "A response could not be accepted. Check account usage before retrying; another call may incur another charge.",
          );
          break;
        default:
          advice.add(
            "A call failed or was interrupted. Check both provider dashboards for charges before retrying unfinished calls.",
          );
      }
    }
    return [...advice].sort();
  }
  extraSpend(): { knownUsd: number; unknown: number } {
    let knownUsd = 0;
    let unknown = 0;
    for (const a of this.#attempts)
      if (!a.ok) {
        if (a.costUsd !== null) knownUsd += a.costUsd;
        else if (a.charge !== "none") unknown++;
      }
    return { knownUsd, unknown };
  }
  async report() {
    const csv = this.csv();
    const parsed = validate(csv);
    if (parsed.errors.length) throw new Error("Run records failed validation.");
    if (!parsed.rows.length) throw new Error("Run has no completed answers.");
    const metrics = cohortMetrics(parsed.rows, this.manifest);
    return {
      csv,
      metrics,
      verdict: verdict(metrics, await fileSeed(csv)),
      extraSpend: this.extraSpend(),
    };
  }
  evidence() {
    if (this.#unsafe)
      throw new Error("Export blocked: this run contains a provider key.");
    return {
      version: PROTOCOL_VERSION,
      manifest: this.manifest,
      attempts: this.attempts,
      labels: this.#answers.map((a) => ({
        caseId: a.caseId,
        provider: a.provider,
        label: this.#labels.get(a.id) ?? null,
      })),
      extraSpend: this.extraSpend(),
      records: this.csv(),
    };
  }
}

/** Entire handshake is bounded, including headers and JSON body; cancellation never starts paid work. */
export async function checkRunnerHealth(
  revision: string,
  signal: AbortSignal,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
  timeoutMs = 10000,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(
          new Error(
            "Runner check stopped or timed out. No provider calls were started.",
          ),
        );
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const checked = (async () => {
      if (controller.signal.aborted) throw new Error("Runner check cancelled.");
      const response = await fetcher("/api/backstage/health", {
        cache: "no-store",
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          "Runner unavailable. Start the matching Backstage server.",
        );
      const health: unknown = await response.json();
      if (
        !object(health) ||
        health.protocol !== PROTOCOL_VERSION ||
        health.version !== revision
      )
        throw new Error(
          "Page and runner versions differ. Reload before running.",
        );
    })();
    await Promise.race([checked, cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

/** A superseded file read cannot overwrite a newer import, edit or frozen run. */
export class CaseImportState {
  #generation = 0;
  #pending = false;
  get pending(): boolean {
    return this.#pending;
  }
  invalidate(): void {
    this.#generation++;
    this.#pending = false;
  }
  async read(text: Promise<string>): Promise<Scene["cases"] | undefined> {
    const generation = ++this.#generation;
    this.#pending = true;
    try {
      const csv = await text;
      if (generation !== this.#generation) return undefined;
      return parseCases(csv);
    } catch (error) {
      if (generation !== this.#generation) return undefined;
      throw error;
    } finally {
      if (generation === this.#generation) this.#pending = false;
    }
  }
}
