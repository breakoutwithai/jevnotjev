// Pure parsing for src/decide/cli.ts: argv to a command, input file text to the core's types, env to provider keys.
// No I/O here. No flag takes a key: keys come from the caller's env only (argv is visible to every process on the host).
import { DEFAULT_LLM } from "./run.ts";
import type { ArmName, Arms, Case, ChoiceOption, NonTextInput, ProviderKeys, QuestionSpec, RuleArm, ScoreLevel } from "./types.ts";

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** Test-only: a JSON file of recorded provider responses. When set, the CLI answers every provider call from it and never
 * calls a provider or starts a claude binary. Documented in docs/api.md as test-only. */
export const FIXTURES_ENV = "JNJ_DECIDE_FIXTURES";

/** The env names read for the caller's provider keys, as used elsewhere in this repo (scripts/uat/backstage-happy-path.ts). */
export const KEY_ENV: Readonly<Record<keyof ProviderKeys, string>> = {
  jev: "JEV_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/** Read when JEV_API_KEY is empty: the name the Backstage copy tells users to set (src/backstage/main.ts). */
export const JEV_KEY_FALLBACK_ENV = "TYPESAFE_API_KEY";

export type CommandName = "arms" | "estimate" | "ask" | "run" | "verdict" | "rescore" | "validate";
/** Tools exposed by MCP and HTTP; rescore is a CLI-only command. */
export const COMMANDS: readonly Exclude<CommandName, "rescore">[] = ["arms", "estimate", "ask", "run", "verdict", "validate"];
const CLI_COMMANDS: readonly CommandName[] = [...COMMANDS, "rescore"];
const ARM_NAMES: readonly ArmName[] = ["jev", "decisions", "llm", "rule"];

export interface SpendCommand {
  readonly cmd: "estimate" | "ask" | "run";
  readonly questions: string;
  readonly cases?: string;
  readonly casePath?: string;
  readonly input?: string;
  readonly caseId?: string;
  /** The arms named by --arms; null when --arms was not given (the core's defaults apply). */
  readonly armList: readonly ArmName[] | null;
  readonly llmModel?: string;
  readonly rulePath?: string;
  readonly budgetUsd?: number;
  readonly dryRun: boolean;
  readonly runId?: string;
  readonly promptVersion?: string;
  readonly out?: string;
}

export type Command =
  | { readonly cmd: "help" }
  | { readonly cmd: "arms" }
  | SpendCommand
  | { readonly cmd: "verdict"; readonly file: string; readonly question?: string }
  | { readonly cmd: "rescore"; readonly file: string; readonly labels: string; readonly manifest?: string; readonly writeManifest?: string }
  | { readonly cmd: "validate"; readonly file: string };

const VALUE_FLAGS = new Set([
  "--questions", "--cases", "--case", "--input", "--case-id", "--arms", "--llm-model", "--rule", "--budget", "--run-id",
  "--prompt-version", "--out", "--question", "--labels", "--manifest", "--write-manifest",
]);
const BOOL_FLAGS = new Set(["--dry-run"]);
const ALLOWED: Readonly<Record<CommandName, ReadonlySet<string>>> = {
  arms: new Set(),
  estimate: new Set(["--questions", "--cases", "--arms", "--llm-model", "--rule", "--budget", "--run-id", "--prompt-version"]),
  ask: new Set(["--questions", "--case", "--input", "--case-id", "--arms", "--llm-model", "--rule", "--budget", "--dry-run", "--run-id", "--prompt-version"]),
  run: new Set(["--questions", "--cases", "--arms", "--llm-model", "--rule", "--budget", "--dry-run", "--run-id", "--prompt-version", "--out"]),
  verdict: new Set(["--question"]),
  rescore: new Set(["--labels", "--manifest", "--write-manifest"]),
  validate: new Set(),
};

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function isCommand(value: string): value is CommandName {
  return CLI_COMMANDS.some((c) => c === value);
}

function isArmName(value: string): value is ArmName {
  return ARM_NAMES.some((a) => a === value);
}

function parseArmList(raw: string): Parsed<readonly ArmName[]> {
  const names = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (names.length === 0) return fail("--arms needs at least one of jev, decisions, llm, rule");
  const out: ArmName[] = [];
  for (const name of names) {
    if (!isArmName(name)) return fail(`--arms: unknown arm ${JSON.stringify(name)}; accepted: ${ARM_NAMES.join(", ")}`);
    if (!out.includes(name)) out.push(name);
  }
  return { ok: true, value: out };
}

function parseBudget(raw: string): Parsed<number> {
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0) return fail(`--budget must be a number >= 0, got ${JSON.stringify(raw)}`);
  return { ok: true, value: n };
}

/** argv (without the runtime and script) to one command, or an error naming the bad part. */
export function parseArgs(argv: readonly string[]): Parsed<Command> {
  const [first, ...rest] = argv;
  if (first === undefined) return fail("no command; expected one of " + CLI_COMMANDS.join(", "));
  if (first === "--help" || first === "-h" || first === "help") return { ok: true, value: { cmd: "help" } };
  if (!isCommand(first)) return fail(`unknown command ${JSON.stringify(first)}; expected one of ${CLI_COMMANDS.join(", ")}`);
  const allowed = ALLOWED[first];
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!allowed.has(arg) || !(VALUE_FLAGS.has(arg) || BOOL_FLAGS.has(arg))) return fail(`${first}: unknown flag ${arg}`);
    if (BOOL_FLAGS.has(arg)) {
      bools.add(arg);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return fail(`${arg} needs a value`);
    if (values.has(arg)) return fail(`${arg} given twice`);
    values.set(arg, value);
    i += 1;
  }

  if (first === "arms") {
    if (positional.length > 0) return fail(`arms takes no arguments, got ${JSON.stringify(positional[0])}`);
    return { ok: true, value: { cmd: "arms" } };
  }
  if (first === "verdict" || first === "validate") {
    const [file, ...extra] = positional;
    if (file === undefined || extra.length > 0) return fail(`${first} takes exactly one records file`);
    if (first === "validate") return { ok: true, value: { cmd: "validate", file } };
    const question = values.get("--question");
    return { ok: true, value: { cmd: "verdict", file, ...(question !== undefined ? { question } : {}) } };
  }
  if (first === "rescore") {
    const [file, ...extra] = positional;
    if (file === undefined || extra.length > 0) return fail("rescore takes exactly one records file");
    const labels = values.get("--labels");
    if (labels === undefined) return fail("rescore needs --labels <file>");
    const manifest = values.get("--manifest");
    const writeManifest = values.get("--write-manifest");
    return { ok: true, value: { cmd: "rescore", file, labels, ...(manifest === undefined ? {} : { manifest }), ...(writeManifest === undefined ? {} : { writeManifest }) } };
  }

  if (positional.length > 0) return fail(`${first}: unexpected argument ${JSON.stringify(positional[0])}`);
  const questions = values.get("--questions");
  if (questions === undefined) return fail(`${first} needs --questions <file>`);
  const cases = values.get("--cases");
  const casePath = values.get("--case");
  const input = values.get("--input");
  if (first === "ask") {
    if ((casePath === undefined) === (input === undefined)) return fail("ask needs exactly one of --case <file> or --input <text>");
  } else if (cases === undefined) {
    return fail(`${first} needs --cases <file>`);
  }
  const dryRun = bools.has("--dry-run");
  const out = values.get("--out");
  if (first === "run" && !dryRun && out === undefined) return fail("run needs --out <file> (or --dry-run)");

  let armList: readonly ArmName[] | null = null;
  const rawArms = values.get("--arms");
  if (rawArms !== undefined) {
    const parsed = parseArmList(rawArms);
    if (!parsed.ok) return fail(parsed.error);
    armList = parsed.value;
  }
  const rulePath = values.get("--rule");
  if (armList !== null && armList.includes("rule") && rulePath === undefined) return fail("--arms rule needs --rule <file>");
  if (armList !== null && !armList.includes("rule") && rulePath !== undefined) return fail("--rule given but rule is not in --arms");
  const llmModel = values.get("--llm-model");
  if (armList !== null && !armList.includes("llm") && llmModel !== undefined) return fail("--llm-model given but llm is not in --arms");

  let budgetUsd: number | undefined;
  const rawBudget = values.get("--budget");
  if (rawBudget !== undefined) {
    const parsed = parseBudget(rawBudget);
    if (!parsed.ok) return fail(parsed.error);
    budgetUsd = parsed.value;
  }
  const runId = values.get("--run-id");
  const promptVersion = values.get("--prompt-version");
  if (first === "ask" && casePath !== undefined && values.has("--case-id")) {
    return fail("ask: --case-id only applies with --input; a --case file carries its own id");
  }
  const caseId = first === "ask" && input !== undefined ? (values.get("--case-id") ?? "case-1") : undefined;
  const command: SpendCommand = {
    cmd: first,
    questions,
    armList,
    dryRun,
    ...(cases !== undefined ? { cases } : {}),
    ...(casePath !== undefined ? { casePath } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(caseId !== undefined ? { caseId } : {}),
    ...(llmModel !== undefined ? { llmModel } : {}),
    ...(rulePath !== undefined ? { rulePath } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(promptVersion !== undefined ? { promptVersion } : {}),
    ...(out !== undefined ? { out } : {}),
  };
  return { ok: true, value: command };
}

/** The core's Arms from the parsed flags. With no --arms the core defaults stand; --llm-model and --rule adjust them. */
export function toArms(c: SpendCommand, rule: RuleArm | null): Arms {
  if (c.armList === null) {
    return { ...(c.llmModel !== undefined ? { llm: c.llmModel } : {}), ...(rule !== null ? { rule } : {}) };
  }
  const has = (a: ArmName): boolean => c.armList?.includes(a) ?? false;
  return {
    jev: has("jev"),
    decisions: has("decisions"),
    llm: has("llm") ? (c.llmModel ?? DEFAULT_LLM) : false,
    rule: has("rule") && rule !== null ? rule : false,
  };
}

/** Provider keys from env; an empty value is absent. Only the three names in KEY_ENV are read. */
export function keysFromEnv(env: Readonly<Record<string, string | undefined>>): ProviderKeys {
  const pick = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v === "" ? undefined : v;
  };
  const jev = pick(KEY_ENV.jev) ?? pick(JEV_KEY_FALLBACK_ENV);
  const openai = pick(KEY_ENV.openai);
  const anthropic = pick(KEY_ENV.anthropic);
  return { ...(jev !== undefined ? { jev } : {}), ...(openai !== undefined ? { openai } : {}), ...(anthropic !== undefined ? { anthropic } : {}) };
}

// ---- input files: unknown JSON to the core's types, with the failing path named ----

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class InputError extends Error {}

function str(rec: { readonly [key: string]: unknown }, key: string, at: string): string {
  const v = rec[key];
  if (typeof v !== "string") throw new InputError(`${at}.${key} must be a string`);
  return v;
}

function list(rec: { readonly [key: string]: unknown }, key: string, at: string): readonly unknown[] {
  const v = rec[key];
  if (!Array.isArray(v)) throw new InputError(`${at}.${key} must be an array`);
  return v;
}

function toQuestion(value: unknown, at: string): QuestionSpec {
  if (!isRecord(value)) throw new InputError(`${at} must be an object`);
  const name = str(value, "name", at);
  const instructions = str(value, "instructions", at);
  const type = value.type;
  if (type === "noul") {
    const criteria = value.criteria;
    if (criteria !== undefined && typeof criteria !== "string") throw new InputError(`${at}.criteria must be a string`);
    return { name, type, instructions, ...(criteria !== undefined ? { criteria } : {}) };
  }
  if (type === "choice") {
    const choices = list(value, "choices", at).map((c, i): ChoiceOption => {
      const where = `${at}.choices[${i}]`;
      if (!isRecord(c)) throw new InputError(`${where} must be an object`);
      return { name: str(c, "name", where), definition: str(c, "definition", where) };
    });
    return { name, type, instructions, choices };
  }
  if (type === "score") {
    const levels = list(value, "levels", at).map((l, i): ScoreLevel => {
      const where = `${at}.levels[${i}]`;
      if (!isRecord(l)) throw new InputError(`${where} must be an object`);
      return { label: str(l, "label", where), description: str(l, "description", where) };
    });
    return { name, type, instructions, levels };
  }
  throw new InputError(`${at}.type must be noul, choice or score, got ${JSON.stringify(type)}`);
}

function toCase(value: unknown, at: string): Case {
  if (!isRecord(value)) throw new InputError(`${at} must be an object`);
  const id = str(value, "id", at);
  const input = value.input;
  if (typeof input === "string") return { id, input };
  if (isRecord(input) && typeof input.type === "string") {
    const nonText: NonTextInput = { ...input, type: input.type };
    return { id, input: nonText };
  }
  throw new InputError(`${at}.input must be a string (v1 is text only) or an object with a type`);
}

function jsonParse(text: string, what: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw new InputError(`${what} is not JSON: ${error instanceof Error ? error.message : "parse error"}`);
  }
}

function guard<T>(fn: () => T): Parsed<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (error instanceof InputError) return fail(error.message);
    throw error;
  }
}

/** A questions file: one QuestionSpec object or an array of them. */
export function parseQuestions(text: string): Parsed<readonly QuestionSpec[]> {
  return guard(() => {
    const raw = jsonParse(text, "questions file");
    return Array.isArray(raw) ? raw.map((q, i) => toQuestion(q, `questions[${i}]`)) : [toQuestion(raw, "questions[0]")];
  });
}

/** A cases file: JSONL (one Case per line, blank lines skipped) when the path ends in .jsonl, else a JSON array. */
export function parseCases(text: string, path: string): Parsed<readonly Case[]> {
  return guard(() => {
    if (path.toLowerCase().endsWith(".jsonl")) {
      const out: Case[] = [];
      text.split("\n").forEach((line, i) => {
        if (line.trim() === "") return;
        out.push(toCase(jsonParse(line, `cases line ${i + 1}`), `cases line ${i + 1}`));
      });
      return out;
    }
    const raw = jsonParse(text, "cases file");
    if (!Array.isArray(raw)) throw new InputError("cases file must be a JSON array (or .jsonl, one case per line)");
    return raw.map((c, i) => toCase(c, `cases[${i}]`));
  });
}

/** One case file for `ask --case`: a single Case object. */
export function parseCase(text: string): Parsed<Case> {
  return guard(() => toCase(jsonParse(text, "case file"), "case"));
}

/** A rule file: { keywords: string[], match, otherwise }. */
export function parseRule(text: string): Parsed<RuleArm> {
  return guard(() => {
    const raw = jsonParse(text, "rule file");
    if (!isRecord(raw)) throw new InputError("rule must be an object");
    const keywords = list(raw, "keywords", "rule").map((k, i) => {
      if (typeof k !== "string") throw new InputError(`rule.keywords[${i}] must be a string`);
      return k;
    });
    return { keywords, match: str(raw, "match", "rule"), otherwise: str(raw, "otherwise", "rule") };
  });
}

/** The test-only fixture file named by JNJ_DECIDE_FIXTURES. */
export interface FixtureSet {
  readonly hosts: Readonly<Record<string, { readonly http: number; readonly response: unknown }>>;
  readonly cli: { readonly stdout: string; readonly exitCode: number } | null;
}

export function parseFixtures(text: string): Parsed<FixtureSet> {
  return guard(() => {
    const raw = jsonParse(text, FIXTURES_ENV);
    if (!isRecord(raw) || !isRecord(raw.hosts)) throw new InputError(`${FIXTURES_ENV}: needs a hosts object`);
    const hosts: Record<string, { http: number; response: unknown }> = {};
    for (const [host, fx] of Object.entries(raw.hosts)) {
      if (!isRecord(fx) || typeof fx.http !== "number") throw new InputError(`${FIXTURES_ENV}: hosts.${host} needs http and response`);
      hosts[host] = { http: fx.http, response: fx.response };
    }
    let cli: FixtureSet["cli"] = null;
    if (isRecord(raw.cli)) {
      const exitCode = typeof raw.cli.exitCode === "number" ? raw.cli.exitCode : 0;
      cli = { stdout: str(raw.cli, "stdout", "cli"), exitCode };
    }
    return { hosts, cli };
  });
}
