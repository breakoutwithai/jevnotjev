import {
  PROTOCOL_VERSION,
  type AnswerRequest,
  type AnswerResult,
  type AnswerFailure,
  type Provider,
  type ProviderKeys,
  type RunMode,
  type Scene,
  type ModelEntry,
} from "./contracts.ts";
import {
  CATALOG_VERSION,
  getModelEntry,
  JEV_ARM_ID,
  MAX_SELECTED_ARMS,
  MAX_RUN_REQUESTS,
} from "./catalog.ts";
import { PROMPT_TEMPLATE_VERSION } from "./prompt.ts";
import { requestFingerprint } from "./fingerprint.ts";
import { COLUMNS, validate } from "../format/validate.ts";
import { formatRows, readDictRows } from "../format/csv.ts";
import { cohortMetrics } from "../core/metrics.ts";
import { fileSeed } from "../core/calc.ts";
import { verdict } from "../core/verdict.ts";
export type Keys = ProviderKeys;
export type KeySource = Keys | (() => Keys);
export type Transport = (
  request: AnswerRequest,
  signal: AbortSignal,
) => Promise<unknown>;
export type Label = "accept" | "reject" | null;
export interface Selection {
  readonly arms: readonly string[];
}
export interface Manifest {
  readonly mode: RunMode;
  readonly arms: readonly string[];
  readonly models: readonly ModelEntry[];
  readonly catalogVersion: string;
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
  readonly attemptId: string | null;
  readonly caseId: string;
  readonly armId: string;
  readonly provider: Provider | "rule";
  readonly output: string;
  readonly confidence: number | null;
  readonly model: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
}
export interface ComparisonExport {
  readonly armId: string;
  readonly runId: string;
  readonly filename: string;
  readonly csv: string;
  readonly attemptIds: readonly string[];
}
function suppliedKeys(source: KeySource): Keys {
  return typeof source === "function" ? source() : source;
}
function keyValues(keys: Keys): string[] {
  return Object.values(keys).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
function containsKey(value: unknown, keys: readonly string[]): boolean {
  if (typeof value === "string")
    return keys.some((key) => key.length > 0 && value.includes(key));
  if (Array.isArray(value))
    return value.some((item) => containsKey(item, keys));
  if (typeof value === "object" && value !== null)
    return Object.values(value).some((item) => containsKey(item, keys));
  return false;
}
export function validateSceneKeys(
  scene: Scene,
  keys: Keys,
  _mode: RunMode = "jev-only",
): void {
  if (containsKey(scene, keyValues(keys)))
    throw new Error(
      "A provider key appears in the scene. Remove it before running.",
    );
  if (!validKey(keys.jev))
    throw new Error(
      "Supply a valid jev key (8-512 printable characters, no spaces).",
    );
}
function validKey(key: string | undefined): key is string {
  return typeof key === "string" && /^[\x21-\x7e]{8,512}$/.test(key);
}
export const inputFingerprint = requestFingerprint;
function bounded(value: string, limit: number, name: string): string {
  if (
    !value.trim() ||
    value.length > limit ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new Error(`${name} is required (maximum ${limit} characters).`);
  return value;
}
const CASE_HEADER = "case_id,case_input";
const CASE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
function validCases(cases: Scene["cases"]): Scene["cases"] {
  if (cases.length < 1 || cases.length > 100)
    throw new Error(`Add between 1 and 100 cases (found ${cases.length}).`);
  const ids = new Set<string>();
  return Object.freeze(
    cases.map((c) => {
      if (!CASE_ID.test(c.id) || ids.has(c.id))
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
  let line = 1;
  let opened = 1;
  let previous = "";
  for (const char of csv) {
    if (char === "\n" ? previous !== "\r" : char === "\r") line += 1;
    previous = char;
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
        `Line ${line}: text appears after a closing quote. Put the whole field inside the quotes, for example c1,"one, two".`,
      );
    }
    if (char === "," || char === "\r" || char === "\n") {
      state = "start";
      continue;
    }
    if (char === '"') {
      if (state !== "start")
        throw new Error(
          `Line ${line}: a " appears inside an unquoted field. Wrap the whole field in quotes and double the inner quote (""), for example c1,"say ""hi""".`,
        );
      state = "quoted";
      opened = line;
    } else state = "plain";
  }
  if (state === "quoted")
    throw new Error(
      `Line ${opened}: a quoted field starts here but is not closed. Add the closing " at the end of the case text.`,
    );
}
/** First line of a record: readDictRows reports the line it ends on. */
function startLine(record: { line: number; fields: readonly string[] }): number {
  return record.fields.reduce(
    (line, field) => line - (field.match(/\r\n|\r|\n/g)?.length ?? 0),
    record.line,
  );
}
export function parseCases(csv: string): Scene["cases"] {
  checkCaseCsvSyntax(csv);
  const parsed = readDictRows(csv);
  if (parsed.header === null)
    throw new Error(`The CSV file is empty. Its first row must be the header ${CASE_HEADER}.`);
  if (parsed.header.join(",") !== CASE_HEADER || parsed.header.length !== 2)
    throw new Error(
      `The header row is "${parsed.header.join(",").slice(0, 80)}". It must be exactly ${CASE_HEADER}.`,
    );
  if (parsed.rows.length === 0)
    throw new Error(
      `The CSV has a header but no case rows. Add at least one row, for example c1,Please refund my order.`,
    );
  if (parsed.rows.length > 100)
    throw new Error(
      `The CSV has ${parsed.rows.length} case rows. Import at most 100.`,
    );
  const seen = new Map<string, number>();
  return validCases(
    parsed.rows.map((r) => {
      const line = startLine(r);
      const count = r.fields.length;
      if (count !== 2)
        throw new Error(
          `Line ${line} has ${count} ${count === 1 ? "column" : "columns"}; expected 2 (${CASE_HEADER}). If the case text contains a comma, wrap it in quotes, for example c1,"one, two".`,
        );
      const id = r.fields[0] ?? "";
      const input = r.fields[1] ?? "";
      if (!CASE_ID.test(id))
        throw new Error(
          `Line ${line}: case_id "${id.slice(0, 80)}" is not allowed. Use 1 to 64 letters, numbers, underscores or hyphens.`,
        );
      const first = seen.get(id);
      if (first !== undefined)
        throw new Error(
          `Line ${line}: case_id "${id}" is already used on line ${first}. Each case_id must be unique.`,
        );
      seen.set(id, line);
      if (CONTROL.test(input))
        throw new Error(
          `Line ${line}: case_input contains an invisible control character (for example a null byte). Remove it and import again.`,
        );
      if (!input.trim())
        throw new Error(`Line ${line}: case_input is empty. Add the case text after the comma.`);
      if (input.length > 8000)
        throw new Error(
          `Line ${line}: case_input is ${input.length} characters. Keep each case at most 8000 characters.`,
        );
      return { id, input };
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

function entryFor(request: AnswerRequest): ModelEntry {
  const entry = getModelEntry(request.armId);
  if (!entry) throw new Error("Unknown arm.");
  return entry;
}
async function failure(
  request: AnswerRequest,
  code: string,
  charge: "none" | "unknown" = "none",
  began = Date.now(),
): Promise<AnswerFailure> {
  const entry = entryFor(request);
  return {
    ok: false,
    revision: request.revision,
    runId: request.runId,
    caseId: request.caseId,
    provider: request.provider,
    armId: request.armId,
    catalogVersion: request.catalogVersion,
    promptVersion: request.promptVersion,
    requestedModel: request.modelId,
    returnedModel: null,
    parameters: entry.parameters,
    model: request.modelId,
    attemptId: crypto.randomUUID(),
    fingerprint: await inputFingerprint(request),
    startedAt: new Date(began).toISOString(),
    finishedAt: new Date().toISOString(),
    latencyMs: charge === "none" ? 0 : Date.now() - began,
    tokensIn: charge === "none" ? 0 : null,
    tokensOut: charge === "none" ? 0 : null,
    costUsd: charge === "none" ? 0 : null,
    priceVersion: charge === "none" ? "not-called" : "unavailable",
    code,
    message:
      charge === "none"
        ? "This arm was not called (" + code + ")."
        : "No verified answer received; charges may have occurred.",
    charge,
  };
}
export async function parseAnswerResult(
  value: unknown,
  request: AnswerRequest,
): Promise<AnswerResult> {
  const entry = entryFor(request);
  if (
    !object(value) ||
    value.runId !== request.runId ||
    value.revision !== request.revision ||
    value.caseId !== request.caseId ||
    value.provider !== request.provider ||
    value.armId !== request.armId ||
    value.catalogVersion !== request.catalogVersion ||
    value.promptVersion !== request.promptVersion ||
    value.requestedModel !== request.modelId ||
    value.model !== request.modelId ||
    JSON.stringify(value.parameters) !== JSON.stringify(entry.parameters) ||
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
    !short(value.priceVersion) ||
    (value.returnedModel !== null && typeof value.returnedModel !== "string")
  )
    throw new Error("Invalid response evidence.");
  const common = {
    runId: request.runId,
    revision: request.revision,
    caseId: request.caseId,
    provider: request.provider,
    armId: request.armId,
    catalogVersion: request.catalogVersion,
    promptVersion: request.promptVersion,
    requestedModel: request.modelId,
    returnedModel: value.returnedModel,
    parameters: entry.parameters,
    model: request.modelId,
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
    (value.confidence === null || value.confidence <= 1) &&
    typeof value.returnedModel === "string" &&
    entry.acceptedResponseModelIds.includes(value.returnedModel)
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
      message: "Provider call failed (" + value.code + ").",
      charge: value.charge,
    };
  throw new Error("Invalid answer response.");
}
export async function dispatchFailure(
  raw: unknown,
  request: AnswerRequest,
): Promise<AnswerFailure | null> {
  const codes = [
    "protocol-mismatch",
    "prompt-mismatch",
    "unknown-arm",
    "catalog-mismatch",
    "trial-exhausted",
    "trial-replay",
    "trial-budget",
    "trial-limit",
    "trial-unavailable",
    "invalid-request",
    "busy",
    "origin-rejected",
    "revision-mismatch",
    "request-too-large",
    "json-required",
    "method-not-allowed",
    "unsupported-arm",
    "model-selection-mismatch",
    "invalid-key",
    "unsafe-input",
    "runner-busy",
    "request-rejected",
  ];
  if (
    object(raw) &&
    raw.dispatched === false &&
    raw.ok === false &&
    raw.charge === "none" &&
    typeof raw.code === "string" &&
    codes.includes(raw.code)
  )
    return failure(request, raw.code);
  return null;
}
export const answerTransport: Transport = async (request, signal) => {
  const response = await fetch("/api/backstage/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.any([signal, AbortSignal.timeout(65000)]),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    const raw: unknown = await response.json();
    const rejected = await dispatchFailure(raw, request);
    if (rejected) return rejected;
    throw new Error("Answer request failed.");
  }
  return response.json();
};

/** Minting never calls a provider; an uncertain mint cannot create an inference charge. */
export function trialTransport(
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Transport {
  const idempotencyKey = crypto.randomUUID();
  return async (request, signal) => {
    try {
      const mint = await fetcher("/api/backstage/trial/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        cache: "no-store",
        redirect: "error",
      });
      if (!mint.ok) return failure(request, "trial-unavailable");
    } catch {
      return failure(request, "trial-unavailable");
    }
    if (signal.aborted) return failure(request, "not-run");
    const { key, ...body } = request;
    const response = await fetcher("/api/backstage/trial/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, idempotencyKey }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(65000)]),
      cache: "no-store",
      redirect: "error",
    });
    const raw: unknown = await response.json();
    if (!response.ok) {
      const rejected = await dispatchFailure(raw, request);
      if (rejected) return rejected;
      throw new Error("Trial answer failed.");
    }
    return raw;
  };
}

export class BackstageRun {
  readonly manifest: Manifest;
  #attempts: AnswerResult[] = [];
  #answers: RowAnswer[] = [];
  #labels = new Map<string, Label>();
  #order = new Map<string, number>();
  #controller: AbortController | null = null;
  #started = false;
  #funded = false;
  #revealed = false;
  #labeling = false;
  #unsafe = false;
  constructor(
    scene: Scene,
    revision = "test",
    selection: Selection = { arms: [JEV_ARM_ID] },
  ) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(revision))
      throw new Error("Invalid run revision.");
    const arms = [...selection.arms];
    if (
      !arms.includes(JEV_ARM_ID) ||
      arms.filter((id) => id !== "rule").length > MAX_SELECTED_ARMS ||
      new Set(arms).size !== arms.length
    )
      throw new Error(
        "Select Jev and at most eleven distinct provider comparison arms.",
      );
    const models = arms
      .filter((id) => id !== "rule")
      .map((id) => {
        const entry = getModelEntry(id);
        if (!entry?.enabled)
          throw new Error("Unknown or unavailable comparison arm.");
        return structuredClone(entry);
      });
    if (models.length * scene.cases.length > MAX_RUN_REQUESTS)
      throw new Error(
        "Reduce cases or models: at most " +
          MAX_RUN_REQUESTS +
          " provider requests per run.",
      );
    const rule = arms.includes("rule");
    if (rule && scene.keywords.filter((k) => k.trim()).length === 0)
      throw new Error("Add at least one keyword for the selected rule.");
    const frozen = freezeScene(
      rule
        ? scene
        : {
            ...scene,
            keywords: [],
            matchChoice: scene.choices[0].name,
            otherwiseChoice: scene.choices[1].name,
          },
    );
    this.manifest = Object.freeze({
      mode: arms.length === 1 ? "jev-only" : "compare",
      arms: Object.freeze(arms),
      models: Object.freeze(
        models.map((entry) =>
          Object.freeze({
            ...entry,
            parameters: Object.freeze(entry.parameters),
            acceptedResponseModelIds: Object.freeze([
              ...entry.acceptedResponseModelIds,
            ]),
          }),
        ),
      ),
      catalogVersion: CATALOG_VERSION,
      runId: crypto.randomUUID(),
      revision,
      promptVersion: PROMPT_TEMPLATE_VERSION,
      questionId: "decision",
      createdAt: new Date().toISOString(),
      scene: frozen,
    });
    const slots = frozen.cases.flatMap((c) =>
      arms.map((id) => c.id + ":" + id),
    );
    for (let i = slots.length - 1; i > 0; i--) {
      const bytes = new Uint32Array(1);
      crypto.getRandomValues(bytes);
      const j = Math.floor(((bytes[0] ?? 0) / 4294967296) * (i + 1));
      const a = slots[i];
      const b = slots[j];
      if (a !== undefined && b !== undefined) {
        slots[i] = b;
        slots[j] = a;
      }
    }
    slots.forEach((slot, index) => this.#order.set(slot, index));
  }
  get running() {
    return this.#controller !== null;
  }
  get attempts(): readonly AnswerResult[] {
    return structuredClone(this.#attempts);
  }
  get funded() {
    return this.#funded;
  }
  get started() {
    return this.#started;
  }
  get labeling() {
    return this.#labeling;
  }
  get revealed() {
    return this.#revealed;
  }
  get completed() {
    return new Set(this.#attempts.map((a) => a.caseId + ":" + a.armId)).size;
  }
  get total() {
    return this.manifest.scene.cases.length * this.manifest.models.length;
  }
  get pending() {
    return (
      this.total - this.#answers.filter((a) => a.provider !== "rule").length
    );
  }
  get exportable() {
    return this.#started && !this.running && !this.#unsafe;
  }
  beginLabeling() {
    if (this.#unsafe)
      throw new Error(
        "This run contains a provider key. Start a new scene without the key.",
      );
    if (this.running || !this.#answers.length)
      throw new Error("Finish or stop the run before opening blind judging.");
    this.#labeling = true;
  }
  reveal() {
    if (this.running || this.#unsafe || !this.#labeling)
      throw new Error("Finish or stop a safe run before revealing results.");
    this.#revealed = true;
  }
  #labelKey(a: RowAnswer) {
    return JSON.stringify([a.caseId, a.output]);
  }
  cards(): readonly Card[] {
    return [...this.#answers]
      .sort(
        (a, b) =>
          (this.#order.get(a.caseId + ":" + a.armId) ?? 0) -
          (this.#order.get(b.caseId + ":" + b.armId) ?? 0),
      )
      .map((a) => ({
        id: a.id,
        caseId: a.caseId,
        input:
          this.manifest.scene.cases.find((c) => c.id === a.caseId)?.input ?? "",
        output: a.output,
        label: this.#labels.get(this.#labelKey(a)) ?? null,
      }));
  }
  results(): readonly Pick<
    RowAnswer,
    "caseId" | "armId" | "output" | "confidence"
  >[] {
    if (this.#unsafe || (this.manifest.mode === "compare" && !this.#revealed))
      return [];
    return this.#answers.map(({ caseId, armId, output, confidence }) => ({
      caseId,
      armId,
      output,
      confidence,
    }));
  }
  label(id: string, label: Label) {
    if (!this.#labeling)
      throw new Error(
        "Open blind judging before labeling. This locks retries.",
      );
    if (this.#revealed)
      throw new Error("Labels are locked after revealing results.");
    if (this.running)
      throw new Error("Stop or finish the run before labeling.");
    const answer = this.#answers.find((a) => a.id === id);
    if (!answer) throw new Error("Unknown answer card.");
    this.#labels.set(this.#labelKey(answer), label);
  }
  stop() {
    this.#controller?.abort();
  }
  async start(
    keys: KeySource,
    transport: Transport = answerTransport,
    onChange?: () => void,
  ) {
    if (this.#started)
      throw new Error(
        "This run has already started. Use explicit retry for incomplete calls.",
      );
    await this.#execute(keys, transport, onChange);
  }
  async startTrial(transport: Transport, onChange?: () => void): Promise<void> {
    if (this.#started) throw new Error("This trial has already started.");
    const s = this.manifest.scene;
    if (
      this.manifest.arms.length !== 1 ||
      this.manifest.arms[0] !== JEV_ARM_ID ||
      s.cases.length !== 1 ||
      s.question.length > 200 ||
      s.choices.some((c) => c.name.length > 32 || c.definition.length > 200) ||
      (s.cases[0]?.input.length ?? 0) > 1000
    )
      throw new Error(
        "Trial limits: one case up to 1,000 characters, question up to 200, answer names 32 and definitions 200.",
      );
    this.#funded = true;
    await this.#execute({}, transport, onChange, true);
  }
  async retry(
    keys: KeySource,
    transport: Transport = answerTransport,
    onChange?: () => void,
  ) {
    if (this.#funded)
      throw new Error(
        "Funded trials cannot be retried. Use your own key in a new run.",
      );
    if (this.#labeling)
      throw new Error(
        "Retries are locked once blind judging begins. Start a new run.",
      );
    if (!this.#started) throw new Error("Start the run first.");
    await this.#execute(keys, transport, onChange);
  }
  async #execute(
    source: KeySource,
    transport: Transport,
    onChange?: () => void,
    funded = false,
  ) {
    if (this.running) throw new Error("A run is already in progress.");
    const scene = this.manifest.scene;
    if (this.#unsafe)
      throw new Error(
        "This run was rejected because it contains a key. Start a new scene.",
      );
    const unsafe = () => {
      const values = keyValues(suppliedKeys(source));
      return (
        containsKey(scene, values) ||
        containsKey(this.#attempts, values) ||
        containsKey(this.#answers, values)
      );
    };
    if (unsafe()) {
      this.#unsafe = true;
      throw new Error(
        "A provider key appears in run data. Start a new scene without the key.",
      );
    }
    if (!funded) validateSceneKeys(scene, suppliedKeys(source));
    this.#started = true;
    const controller = new AbortController();
    this.#controller = controller;
    const skipped = new Set<Provider>();
    if (
      this.manifest.arms.includes("rule") &&
      !this.#answers.some((a) => a.armId === "rule")
    )
      for (const c of scene.cases)
        this.#answers.push({
          id: crypto.randomUUID(),
          attemptId: null,
          caseId: c.id,
          armId: "rule",
          provider: "rule",
          output: scene.keywords.some((k) =>
            c.input.toLowerCase().includes(k.toLowerCase()),
          )
            ? scene.matchChoice
            : scene.otherwiseChoice,
          model: "keywords-v1",
          confidence: null,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          latencyMs: 0,
        });
    try {
      onChange?.();
      for (const c of scene.cases)
        for (const entry of this.manifest.models) {
          if (
            this.#answers.some((a) => a.caseId === c.id && a.armId === entry.id)
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
            provider: entry.provider,
            key: suppliedKeys(source)[entry.provider] ?? "",
            armId: entry.id,
            modelId: entry.modelId,
            catalogVersion: this.manifest.catalogVersion,
            promptVersion: this.manifest.promptVersion,
          };
          let result: AnswerResult;
          if (controller.signal.aborted)
            result = await failure(request, "not-run");
          else if (!funded && !validKey(request.key))
            result = await failure(
              request,
              request.key ? "invalid-key" : "missing-key",
            );
          else if (skipped.has(entry.provider))
            result = await failure(request, "provider-blocked");
          else {
            // Yield to Stop before dispatch, including the first progress notification.
            await inputFingerprint(request);
            if (controller.signal.aborted)
              result = await failure(request, "not-run");
            else {
              const began = Date.now();
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
                if (containsKey(result, keyValues(suppliedKeys(source))))
                  throw new Error("Unsafe response evidence.");
                if (controller.signal.aborted)
                  result = await failure(request, "stopped", "unknown", began);
              } catch {
                result = await failure(
                  request,
                  controller.signal.aborted ? "stopped" : "transport_failure",
                  "unknown",
                  began,
                );
              } finally {
                if (abortListener)
                  controller.signal.removeEventListener("abort", abortListener);
              }
            }
          }
          if (
            !result.ok &&
            (result.code === "http-401" || result.code === "http-403")
          )
            skipped.add(entry.provider);
          this.#attempts.push(result);
          if (result.ok)
            this.#answers.push({
              id: crypto.randomUUID(),
              attemptId: result.attemptId,
              caseId: c.id,
              armId: entry.id,
              provider: entry.provider,
              output: result.output,
              model: result.model,
              confidence: result.confidence,
              tokensIn: result.tokensIn,
              tokensOut: result.tokensOut,
              costUsd: result.costUsd,
              latencyMs: result.latencyMs,
            });
          onChange?.();
        }
    } finally {
      this.#controller = null;
      onChange?.();
    }
  }
  #csv(answers: readonly RowAnswer[], runId: string): string {
    if (this.#unsafe)
      throw new Error("Export blocked: this run contains a provider key.");
    const s = this.manifest.scene;
    return formatRows([
      COLUMNS,
      ...answers.map((a) => {
        const label = this.#labels.get(this.#labelKey(a)) ?? null;
        const data: Record<string, string | number | null> = {
          format_version: "jnj-record/1",
          run_id: runId,
          prompt_version: this.manifest.promptVersion,
          case_id: a.caseId,
          case_input: s.cases.find((c) => c.id === a.caseId)?.input ?? "",
          question_id: this.manifest.questionId,
          question: s.question,
          answer_set: s.choices.map((c) => c.name).join("|"),
          answerer:
            a.provider === "jev"
              ? "jev"
              : a.provider === "rule"
                ? "rule"
                : "llm",
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
      }),
    ]);
  }
  exports(): readonly ComparisonExport[] {
    const comparators = this.manifest.arms.filter(
      (id) => id !== JEV_ARM_ID && id !== "rule",
    );
    const ids = comparators.length
      ? comparators
      : [this.manifest.arms.includes("rule") ? "rule" : JEV_ARM_ID];
    return ids.map((armId, index) => {
      const runId =
        ids.length === 1
          ? this.manifest.runId
          : this.manifest.runId + "-pair-" + (index + 1);
      const answers = this.#answers.filter(
        (a) =>
          a.armId === JEV_ARM_ID || a.armId === armId || a.armId === "rule",
      );
      return {
        armId,
        runId,
        filename: "records-" + (index + 1) + ".csv",
        csv: this.#csv(answers, runId),
        attemptIds: answers.flatMap((a) => (a.attemptId ? [a.attemptId] : [])),
      };
    });
  }
  csv(): string {
    const outputs = this.exports();
    return outputs.length === 1
      ? (outputs[0]?.csv ?? formatRows([COLUMNS]))
      : formatRows([
          COLUMNS,
          ...outputs.flatMap((output) =>
            readDictRows(output.csv).rows.map((row) => row.fields),
          ),
        ]);
  }
  retryAdvice(): readonly string[] {
    const failed = this.#attempts.filter(
      (a) =>
        !a.ok &&
        !this.#answers.some(
          (b) => a.caseId === b.caseId && a.armId === b.armId,
        ),
    );
    const advice = new Set<string>();
    for (const attempt of failed) {
      if (attempt.ok) continue;
      switch (attempt.code) {
        case "missing-key":
        case "invalid-key":
        case "provider-blocked":
          advice.add(
            "Some selected provider keys are missing, invalid or blocked. Correct them before explicit retry; these skipped calls were not charged.",
          );
          break;
        case "http-401":
        case "http-403":
          advice.add(
            "Check selected provider keys and account permissions before explicit retry.",
          );
          break;
        case "http-429":
          advice.add(
            "Wait for the provider rate limit to reset and check account limits before explicit retry.",
          );
          break;
        case "revision-mismatch":
        case "protocol-mismatch":
        case "catalog-mismatch":
        case "prompt-mismatch":
          advice.add(
            "Reload the matching page and runner before a new run. These rejected requests were not sent to providers.",
          );
          break;
        case "runner-busy":
        case "busy":
          advice.add(
            "Wait for runner capacity before retrying. Rejected requests were not sent to providers.",
          );
          break;
        case "trial-unavailable":
        case "trial-exhausted":
        case "trial-replay":
        case "trial-budget":
        case "trial-limit":
          advice.add(
            "The funded trial is unavailable or consumed. Use your own key in a new run or copy the decision to Playground.",
          );
          break;
        case "not-run":
          advice.add(
            "Remaining calls were stopped before dispatch and were not charged. Retry explicitly when ready.",
          );
          break;
        default:
          advice.add(
            attempt.charge === "none"
              ? "A request was rejected before a provider call. Check inputs and selected keys before retrying."
              : "Check provider account usage before retrying a failed response.",
          );
      }
      if (attempt.charge === "unknown")
        advice.add(
          "A dispatched call has unknown charges. Check provider account usage before retrying; another call may incur another charge.",
        );
    }
    return [...advice].sort();
  }
  extraSpend() {
    let knownUsd = 0,
      unknown = 0;
    for (const a of this.#attempts)
      if (!a.ok) {
        if (a.costUsd !== null) knownUsd += a.costUsd;
        else if (a.charge !== "none") unknown++;
      }
    return { knownUsd, unknown };
  }
  totalSpend() {
    let knownUsd = 0,
      unknown = 0;
    for (const a of this.#attempts) {
      if (a.costUsd !== null) knownUsd += a.costUsd;
      else if (a.ok || a.charge !== "none") unknown++;
    }
    return { knownUsd, unknown };
  }
  async report() {
    const csv = this.csv();
    const pairs = await Promise.all(
      this.exports().map(async (output) => {
        const parsed = validate(output.csv);
        if (
          parsed.errors.length &&
          !(
            output.csv === formatRows([COLUMNS]) &&
            !this.#answers.some(
              (a) =>
                a.armId === JEV_ARM_ID ||
                a.armId === output.armId ||
                a.armId === "rule",
            )
          )
        )
          throw new Error("Run records failed validation.");
        const metrics = parsed.rows.length
          ? cohortMetrics(parsed.rows, {
              ...this.manifest,
              runId: output.runId,
            })
          : {
              key: {
                runId: output.runId,
                promptVersion: this.manifest.promptVersion,
                questionId: this.manifest.questionId,
              },
              question: this.manifest.scene.question,
              answerSet: this.manifest.scene.choices
                .map((c) => c.name)
                .join("|"),
              cases: 0,
              arms: [],
              jevVsLlm: null,
              jevVsRule: null,
            };
        return {
          ...output,
          metrics,
          verdict:
            this.manifest.mode === "compare" && parsed.rows.length
              ? verdict(metrics, await fileSeed(output.csv))
              : null,
        };
      }),
    );
    const first = pairs[0];
    if (!first) throw new Error("Missing export cohort.");
    return {
      csv,
      metrics: first.metrics,
      verdict: pairs.length === 1 ? first.verdict : null,
      pairs,
      extraSpend: this.extraSpend(),
      totalSpend: this.totalSpend(),
    };
  }
  evidence() {
    if (
      this.manifest.mode === "compare" &&
      !this.#revealed &&
      this.#answers.length > 0
    )
      throw new Error("Reveal results before downloading comparison evidence.");
    if (this.#unsafe)
      throw new Error("Export blocked: this run contains a provider key.");
    return {
      version: PROTOCOL_VERSION,
      manifest: this.manifest,
      funding: this.#funded ? "trial" : "byok",
      attempts: this.attempts,
      labels: this.#answers.map((a) => ({
        caseId: a.caseId,
        armId: a.armId,
        provider: a.provider,
        output: a.output,
        label: this.#labels.get(this.#labelKey(a)) ?? null,
      })),
      extraSpend: this.extraSpend(),
      totalSpend: this.totalSpend(),
      comparisons: this.exports(),
      comparisonNote:
        "Jev observations are reused across comparison cohorts. Do not sum their costs; totalSpend counts each actual attempt once. Verdicts are per-pair, uncorrected for multiple comparisons.",
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
        health.version !== revision ||
        health.catalogVersion !== CATALOG_VERSION
      )
        throw new Error(
          "Page and runner versions differ. Reload before running.",
        );
      if (
        typeof window !== "undefined" &&
        typeof health.origin === "string" &&
        health.origin !== window.location.origin
      )
        throw new Error(
          "Open Backstage at " +
            health.origin +
            " before running; this page origin does not match the runner.",
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
