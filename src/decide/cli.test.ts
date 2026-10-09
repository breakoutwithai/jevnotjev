// src/decide/cli.ts (M3 of the API/MCP work): argument parsing, input files, verdict exit codes and the canary key.
// Integration tests run the CLI as a real process. Provider answers come from the recorded fixtures in ./fixtures through
// the test-only JNJ_DECIDE_FIXTURES file; no test calls a provider or starts a real claude binary.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "../format/validate.ts";
import { FIXTURES_ENV, keysFromEnv, parseArgs, parseCases, parseQuestions, parseRule, toArms, type Command, type SpendCommand } from "./cli-args.ts";
import { cliEnv } from "./cli-spawn.ts";
import { fixtureModeActive } from "./fixture-stamp.ts";
import { DEFAULT_LLM } from "./run.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "decide", "cli.ts");
const D08 = join(ROOT, "examples", "d08-verdicts");
const FX = join(import.meta.dir, "fixtures");

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Done {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the CLI with exactly this environment (PATH only, plus `env`): no key the test did not set reaches it. */
function cli(args: readonly string[], env: Readonly<Record<string, string>> = {}): Done {
  const done = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...env } });
  return { code: done.exitCode, stdout: done.stdout.toString(), stderr: done.stderr.toString() };
}

function json(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  let at: unknown = value;
  for (const key of path) {
    if (typeof key === "number") at = Array.isArray(at) ? at[key] : undefined;
    else at = isRecord(at) ? at[key] : undefined;
  }
  return at;
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

// The three M0 questions, the shape the recorded fixtures answer.
const QUESTIONS = [
  { name: "needs_human", type: "noul", instructions: "Does answering this shop message need a person to check live stock, a booking or a policy?" },
  {
    name: "topic",
    type: "choice",
    instructions: "What is this shop message mainly about?",
    choices: [
      { name: "stock", definition: "Whether an item or size is available." },
      { name: "price", definition: "What something costs." },
      { name: "other", definition: "Anything else." },
    ],
  },
  {
    name: "urgency",
    type: "score",
    instructions: "How urgent is this shop message?",
    levels: [
      { label: "Not urgent", description: "General question." },
      { label: "Somewhat urgent", description: "Wants an answer today." },
      { label: "Very urgent", description: "Safety, injury or a booking about to start." },
    ],
  },
];
const M0_TEXT = "Do you have women's boots in size 6?";

describe("argument parsing", () => {
  test("[unit] CLI-ARGS-1 run reads every flag", () => {
    const got = ok(parseArgs([
      "run", "--questions", "q.json", "--cases", "c.jsonl", "--out", "r.csv", "--arms", "jev,decisions", "--budget", "0.5",
      "--run-id", "run-7", "--prompt-version", "p.v2",
    ]));
    expect(got).toMatchObject({
      cmd: "run", questions: "q.json", cases: "c.jsonl", out: "r.csv", armList: ["jev", "decisions"], budgetUsd: 0.5,
      runId: "run-7", promptVersion: "p.v2", dryRun: false,
    });
  });

  test("[unit] CLI-ARGS-2 --arms turns off every arm it does not name; --llm-model pins the llm", () => {
    const spendOf = (c: Command): SpendCommand => {
      if (c.cmd !== "estimate" && c.cmd !== "ask" && c.cmd !== "run") throw new Error(`not a spend command: ${c.cmd}`);
      return c;
    };
    const listed = spendOf(ok(parseArgs(["estimate", "--questions", "q", "--cases", "c", "--arms", "llm", "--llm-model", "claude-haiku-5-5"])));
    expect(toArms(listed, null)).toEqual({ jev: false, decisions: false, llm: "claude-haiku-5-5", rule: false });
    const defaults = spendOf(ok(parseArgs(["estimate", "--questions", "q", "--cases", "c"])));
    expect(toArms(defaults, null)).toEqual({});
    const rule = { keywords: ["size"], match: "yes", otherwise: "no" };
    const withRule = spendOf(ok(parseArgs(["estimate", "--questions", "q", "--cases", "c", "--rule", "rule.json"])));
    expect(toArms(withRule, rule)).toEqual({ rule });
    const jevOnly = spendOf(ok(parseArgs(["estimate", "--questions", "q", "--cases", "c", "--arms", "jev"])));
    expect(toArms(jevOnly, null)).toEqual({ jev: true, decisions: false, llm: false, rule: false });
    expect(DEFAULT_LLM).toBe("claude-haiku-5-5");
  });

  test("[unit] CLI-ARGS-3 an unknown command, flag or arm is an error naming it", () => {
    const bad = (argv: string[]): string => {
      const got = parseArgs(argv);
      if (got.ok) throw new Error(`expected an error for ${argv.join(" ")}`);
      return got.error;
    };
    expect(bad(["launch"])).toContain("launch");
    expect(bad(["arms", "--loud"])).toContain("--loud");
    expect(bad(["estimate", "--questions", "q", "--cases", "c", "--arms", "jev,gpt"])).toContain("gpt");
    expect(bad(["estimate", "--questions", "q", "--cases", "c", "--arms", "rule"])).toContain("--rule");
    expect(bad(["estimate", "--questions"])).toContain("--questions");
    expect(bad([])).toContain("command");
  });

  test("[unit] CLI-ARGS-4 run needs --out unless --dry-run; estimate needs questions and cases", () => {
    expect(parseArgs(["run", "--questions", "q", "--cases", "c"]).ok).toBe(false);
    expect(ok(parseArgs(["run", "--questions", "q", "--cases", "c", "--dry-run"]))).toMatchObject({ dryRun: true });
    expect(parseArgs(["estimate", "--cases", "c"]).ok).toBe(false);
    expect(parseArgs(["estimate", "--questions", "q"]).ok).toBe(false);
  });

  test("[unit] CLI-ARGS-5 --budget must be a number >= 0", () => {
    for (const value of ["abc", "-1", "", "Infinity", "1e999"]) {
      expect(parseArgs(["run", "--questions", "q", "--cases", "c", "--dry-run", "--budget", value]).ok).toBe(false);
    }
    expect(ok(parseArgs(["run", "--questions", "q", "--cases", "c", "--dry-run", "--budget", "0"]))).toMatchObject({ budgetUsd: 0 });
  });

  test("[unit] CLI-ARGS-6 ask takes exactly one of --case or --input; verdict and validate take one file", () => {
    expect(parseArgs(["ask", "--questions", "q"]).ok).toBe(false);
    expect(parseArgs(["ask", "--questions", "q", "--case", "c.json", "--input", "hi"]).ok).toBe(false);
    expect(ok(parseArgs(["ask", "--questions", "q", "--input", "hi"]))).toMatchObject({ cmd: "ask", input: "hi", caseId: "case-1" });
    expect(ok(parseArgs(["verdict", "r.csv", "--question", "q1"]))).toEqual({ cmd: "verdict", file: "r.csv", question: "q1" });
    expect(ok(parseArgs(["validate", "r.csv"]))).toEqual({ cmd: "validate", file: "r.csv" });
    expect(parseArgs(["verdict"]).ok).toBe(false);
    expect(parseArgs(["validate", "a.csv", "b.csv"]).ok).toBe(false);
  });

  test("[unit] CLI-ARGS-7 a key is never taken from argv: no flag accepts one", () => {
    for (const flag of ["--key", "--jev-key", "--openai-key", "--anthropic-key", "--api-key"]) {
      const got = parseArgs(["ask", "--questions", "q", "--input", "hi", flag, "sk-x"]);
      expect(got.ok).toBe(false);
    }
  });
});

describe("input files", () => {
  test("[unit] CLI-INPUT-1 questions: one object or an array; a malformed question names its index", () => {
    expect(ok(parseQuestions(JSON.stringify(QUESTIONS)))).toHaveLength(3);
    expect(JSON.stringify(ok(parseQuestions(JSON.stringify(QUESTIONS[0]))))).toBe(JSON.stringify([QUESTIONS[0]]));
    const noChoices = parseQuestions(JSON.stringify([QUESTIONS[0], { name: "t", type: "choice", instructions: "x" }]));
    expect(noChoices.ok ? "" : noChoices.error).toContain("questions[1]");
    const badType = parseQuestions(JSON.stringify({ name: "t", type: "multi", instructions: "x" }));
    expect(badType.ok ? "" : badType.error).toContain("type");
    expect(parseQuestions("{not json").ok).toBe(false);
  });

  test("[unit] CLI-INPUT-2 cases: JSONL with blank lines, or a JSON array; a bad line names its number", () => {
    const jsonl = `{"id":"a","input":"one"}\n\n{"id":"b","input":"two"}\n`;
    expect(ok(parseCases(jsonl, "cases.jsonl"))).toEqual([{ id: "a", input: "one" }, { id: "b", input: "two" }]);
    expect(ok(parseCases(`[{"id":"a","input":"one"}]`, "cases.json"))).toEqual([{ id: "a", input: "one" }]);
    const bad = parseCases(`{"id":"a","input":"one"}\n{"id":2}\n`, "cases.jsonl");
    expect(bad.ok ? "" : bad.error).toContain("line 2");
    expect(ok(parseCases(`{"id":"img","input":{"type":"image","url":"x"}}`, "c.jsonl"))).toEqual([{ id: "img", input: { type: "image", url: "x" } }]);
  });

  test("[unit] CLI-INPUT-3 rule file: keywords, match and otherwise", () => {
    expect(ok(parseRule(`{"keywords":["size"],"match":"yes","otherwise":"no"}`))).toEqual({ keywords: ["size"], match: "yes", otherwise: "no" });
    expect(parseRule(`{"keywords":"size","match":"yes","otherwise":"no"}`).ok).toBe(false);
  });

  test("[unit] CLI-KEYS keys come from JEV_API_KEY, OPENAI_API_KEY and ANTHROPIC_API_KEY; empty is absent", () => {
    expect(keysFromEnv({ JEV_API_KEY: "j", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" })).toEqual({ jev: "j", openai: "o", anthropic: "a" });
    expect(keysFromEnv({ JEV_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" })).toEqual({});
  });
});

describe("verdict exit codes", () => {
  test("[integration] CLI-EXIT-0 a labelled file that favours Jev exits 0 with use Jev", () => {
    const done = cli(["verdict", join(D08, "r3-use-jev.csv")]);
    expect(done.code).toBe(0);
    expect(field(json(done.stdout), "verdicts", 0, "verdict")).toBe("use Jev");
    expect(field(json(done.stdout), "exit_code")).toBe(0);
  });

  test("[integration] CLI-EXIT-3 a labelled file where Jev is clearly worse exits 3 with don't use Jev", () => {
    const done = cli(["verdict", join(D08, "r2-jev-worse.csv")]);
    expect(done.code).toBe(3);
    expect(field(json(done.stdout), "verdicts", 0, "verdict")).toBe("don't use Jev");
  });

  test("[integration] CLI-EXIT-4 29 paired cases exits 4 with not enough evidence and add 1", () => {
    const done = cli(["verdict", join(D08, "r1-29-paired.csv")]);
    expect(done.code).toBe(4);
    expect(field(json(done.stdout), "verdicts", 0, "verdict")).toBe("not enough evidence");
    expect(field(json(done.stdout), "verdicts", 0, "addN")).toBe(1);
  });

  test("[integration] CLI-EXIT-2 an invalid records file, a missing file and an unknown question exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-cli-exit-"));
    try {
      const good = readFileSync(join(D08, "r3-use-jev.csv"), "utf8");
      const broken = good.replace(",jev,jev-1.13.0,yes,", ",jev,jev-1.13.0,maybe,");
      expect(broken).not.toBe(good);
      writeFileSync(join(dir, "broken.csv"), broken);
      const invalid = cli(["verdict", join(dir, "broken.csv")]);
      expect(invalid.code).toBe(2);
      expect(invalid.stderr).toContain("ERROR");
      expect(cli(["verdict", join(dir, "absent.csv")]).code).toBe(2);
      expect(cli(["verdict", join(D08, "r3-use-jev.csv"), "--question", "nope"]).code).toBe(2);
      expect(cli(["verdict"]).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[integration] CLI-EXIT-V validate keeps the validator's codes: 0 valid, 1 invalid, 2 usage", () => {
    expect(cli(["validate", join(ROOT, "format", "example-v1.2.csv")]).code).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "jnj-cli-validate-"));
    try {
      const broken = readFileSync(join(D08, "r3-use-jev.csv"), "utf8").replace(",jev,jev-1.13.0,yes,", ",jev,jev-1.13.0,maybe,");
      writeFileSync(join(dir, "broken.csv"), broken);
      expect(cli(["validate", join(dir, "broken.csv")]).code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(cli(["validate"]).code).toBe(2);
  });
});

/** The recorded M0 responses as one fixture file for JNJ_DECIDE_FIXTURES. */
function fixtureFile(dir: string): string {
  const response = (name: string): unknown => {
    const raw = json(readFileSync(join(FX, name), "utf8"));
    return { http: field(raw, "http"), response: field(raw, "response") };
  };
  const path = join(dir, "fixtures.json");
  writeFileSync(path, JSON.stringify({
    hosts: {
      "api.typesafe.ai": response("m0-jev.json"),
      "api.openai.com": response("m0-decisions.json"),
      "api.anthropic.com": response("m0-llm.UNVERIFIED.json"),
    },
    cli: { stdout: readFileSync(join(FX, "m0-llm-cli.jsonl"), "utf8"), exitCode: 0 },
  }));
  return path;
}

/** Every regular file under dir, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("subcommands end to end", () => {
  test("[integration] CLI-ARMS arms lists the four arms with dated prices and the three types", () => {
    const done = cli(["arms"]);
    expect(done.code).toBe(0);
    const out = json(done.stdout);
    const arms = field(out, "arms");
    expect(Array.isArray(arms) ? arms.map((a: unknown) => field(a, "arm")) : []).toEqual(["jev", "decisions", "llm", "rule"]);
    expect(field(out, "types")).toEqual(["noul", "choice", "score"]);
    expect(field(out, "priceTableDate")).toBe("2026-10-08");
  });

  test("[integration] CLI-DRY estimate and run --dry-run make no call and write no file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-cli-dry-"));
    try {
      writeFileSync(join(dir, "q.json"), JSON.stringify(QUESTIONS));
      writeFileSync(join(dir, "c.jsonl"), `${JSON.stringify({ id: "m04", input: M0_TEXT })}\n`);
      const env = { [FIXTURES_ENV]: join(dir, "no-such-fixtures.json") };
      const est = cli(["estimate", "--questions", join(dir, "q.json"), "--cases", join(dir, "c.jsonl"), "--arms", "jev,decisions,llm"], env);
      expect(est.code).toBe(0);
      expect(field(json(est.stdout), "calls")).toBe(3);
      expect(field(json(est.stdout), "casesForVerdict")).toBe(30);
      const dry = cli(["run", "--questions", join(dir, "q.json"), "--cases", join(dir, "c.jsonl"), "--dry-run", "--out", join(dir, "r.csv")], env);
      expect(dry.code).toBe(0);
      expect(field(json(dry.stdout), "calls")).toBe(0);
      expect(readdirSync(dir).sort()).toEqual(["c.jsonl", "q.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[integration] CLI-BADINPUT an unknown model id exits 2 naming the accepted ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-cli-bad-"));
    try {
      writeFileSync(join(dir, "q.json"), JSON.stringify(QUESTIONS));
      writeFileSync(join(dir, "c.jsonl"), `${JSON.stringify({ id: "m04", input: M0_TEXT })}\n`);
      const done = cli(["estimate", "--questions", join(dir, "q.json"), "--cases", join(dir, "c.jsonl"), "--llm-model", "claude-haiku-latest"]);
      expect(done.code).toBe(2);
      expect(done.stderr).toContain("claude-haiku-5-5");
      expect(done.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fixture replays are stamped", () => {
  test("[integration] CLI-FIXTURE-STAMP a fixture-mode ask and run --out stamp every row and keep the NOTE", () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-cli-stamp-"));
    try {
      writeFileSync(join(dir, "q.json"), JSON.stringify(QUESTIONS));
      writeFileSync(join(dir, "c.jsonl"), `${JSON.stringify({ id: "m04", input: M0_TEXT })}\n`);
      writeFileSync(join(dir, "case.json"), JSON.stringify({ id: "m04", input: M0_TEXT }));
      const env = { JEV_API_KEY: "k", OPENAI_API_KEY: "k", [FIXTURES_ENV]: fixtureFile(dir) };
      const q = ["--questions", join(dir, "q.json")];
      const asked = cli(["ask", ...q, "--case", join(dir, "case.json"), "--arms", "jev,decisions"], env);
      expect(asked.code).toBe(0);
      expect(asked.stderr).toContain("NOTE");
      const rows = field(json(asked.stdout), "rows");
      expect(Array.isArray(rows) ? rows.length : 0).toBe(6);
      for (const row of Array.isArray(rows) ? rows : []) {
        expect(field(row, "evidence", "replayed_fixture")).toBe(true);
        expect(String(field(row, "run_id"))).toEndWith("-fixture");
      }
      const out = join(dir, "r.csv");
      const ran = cli(["run", ...q, "--cases", join(dir, "c.jsonl"), "--arms", "jev,decisions", "--out", out], env);
      expect(ran.code).toBe(0);
      expect(ran.stderr).toContain("NOTE");
      const lines = readFileSync(out, "utf8").split("\n").filter((l) => l !== "").slice(1);
      expect(lines).toHaveLength(6);
      for (const line of lines) expect(line.startsWith("jnj-record/1.2,run-001-fixture,")).toBe(true);
      expect(validate(readFileSync(out, "utf8")).errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[unit] CLI-FIXTURE-MODE fixtureModeActive is true only for a non-empty JNJ_DECIDE_FIXTURES", () => {
    expect(fixtureModeActive({})).toBe(false);
    expect(fixtureModeActive({ [FIXTURES_ENV]: "" })).toBe(false);
    expect(fixtureModeActive({ [FIXTURES_ENV]: "/x.json" })).toBe(true);
  });
});

describe("flag guards", () => {
  test("[unit] CLI-CASEID ask --case with --case-id is an error naming --case-id", () => {
    const got = parseArgs(["ask", "--questions", "q", "--case", "c.json", "--case-id", "X"]);
    expect(got.ok).toBe(false);
    expect(got.ok ? "" : got.error).toContain("--case-id");
    expect(ok(parseArgs(["ask", "--questions", "q", "--input", "hi", "--case-id", "X"]))).toMatchObject({ caseId: "X" });
  });

  test("[integration] CLI-OUT-GUARD run --out equal to the cases, questions or rule file exits 2 and leaves the input intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-cli-out-"));
    try {
      const questions = join(dir, "q.json");
      const cases = join(dir, "c.jsonl");
      const rule = join(dir, "rule.json");
      writeFileSync(questions, JSON.stringify(QUESTIONS));
      writeFileSync(cases, `${JSON.stringify({ id: "m04", input: M0_TEXT })}\n`);
      writeFileSync(rule, JSON.stringify({ keywords: ["size"], match: "yes", otherwise: "no" }));
      const before = readFileSync(cases, "utf8");
      const same = cli(["run", "--questions", questions, "--cases", cases, "--dry-run", "--out", join(dir, ".", "c.jsonl")]);
      expect(same.code).toBe(2);
      expect(same.stderr).toContain("--out");
      expect(same.stderr).toContain("cases");
      const q = cli(["run", "--questions", questions, "--cases", cases, "--dry-run", "--out", questions]);
      expect(q.code).toBe(2);
      expect(q.stderr).toContain("questions");
      const r = cli(["run", "--questions", questions, "--cases", cases, "--arms", "jev,rule", "--rule", rule, "--dry-run", "--out", rule]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("rule");
      expect(readFileSync(cases, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("key name fallback", () => {
  test("[unit] CLI-KEYS-FALLBACK the Jev key is JEV_API_KEY, else TYPESAFE_API_KEY; JEV_API_KEY wins", () => {
    expect(keysFromEnv({ TYPESAFE_API_KEY: "t" })).toEqual({ jev: "t" });
    expect(keysFromEnv({ JEV_API_KEY: "j", TYPESAFE_API_KEY: "t" })).toEqual({ jev: "j" });
    expect(keysFromEnv({ JEV_API_KEY: "", TYPESAFE_API_KEY: "t" })).toEqual({ jev: "t" });
    expect(keysFromEnv({ JEV_API_KEY: "", TYPESAFE_API_KEY: "" })).toEqual({});
  });

  test("[integration] CLI-KEYS-TYPESAFE ask answers from TYPESAFE_API_KEY alone, arms reports the key set, no key is printed", () => {
    const canary = `sk-canary-${crypto.randomUUID().replaceAll("-", "")}`;
    const dir = mkdtempSync(join(tmpdir(), "jnj-cli-tskey-"));
    try {
      writeFileSync(join(dir, "q.json"), JSON.stringify(QUESTIONS));
      const env = { TYPESAFE_API_KEY: canary, [FIXTURES_ENV]: fixtureFile(dir) };
      const asked = cli(["ask", "--questions", join(dir, "q.json"), "--input", M0_TEXT, "--arms", "jev"], env);
      expect(asked.code).toBe(0);
      const rows = field(json(asked.stdout), "rows");
      expect((Array.isArray(rows) ? rows : []).map((r: unknown) => field(r, "outcome"))).toEqual(["answered", "answered", "answered"]);
      const arms = cli(["arms"], { TYPESAFE_API_KEY: canary });
      expect(field(json(arms.stdout), "arms", 0, "keySet")).toBe(true);
      expect(occurrences(asked.stdout + asked.stderr + arms.stdout + arms.stderr, canary)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("canary key", () => {
  test("[integration] KEY-CANARY-CLI a canary key in env reaches no stdout, stderr or written file (m3 == 0)", () => {
    const canary = `sk-canary-${crypto.randomUUID().replaceAll("-", "")}`;
    const dir = mkdtempSync(join(tmpdir(), "jnj-cli-canary-"));
    const outDir = join(dir, "out");
    try {
      writeFileSync(join(dir, "q.json"), JSON.stringify(QUESTIONS));
      writeFileSync(join(dir, "c.jsonl"), [`{"id":"m04","input":${JSON.stringify(M0_TEXT)}}`, `{"id":"m05","input":${JSON.stringify(M0_TEXT)}}`].join("\n"));
      writeFileSync(join(dir, "case.json"), JSON.stringify({ id: "m04", input: M0_TEXT }));
      const fixtures = fixtureFile(dir);
      const allKeys = { JEV_API_KEY: canary, OPENAI_API_KEY: canary, ANTHROPIC_API_KEY: canary, [FIXTURES_ENV]: fixtures };
      const noAnthropic = { JEV_API_KEY: canary, OPENAI_API_KEY: canary, [FIXTURES_ENV]: fixtures };
      const q = ["--questions", join(dir, "q.json")];
      const runs: Done[] = [
        cli(["arms"], allKeys),
        cli(["estimate", ...q, "--cases", join(dir, "c.jsonl"), "--arms", "jev,decisions,llm"], allKeys),
        cli(["ask", ...q, "--case", join(dir, "case.json"), "--arms", "jev,decisions,llm"], allKeys),
        cli(["run", ...q, "--cases", join(dir, "c.jsonl"), "--arms", "jev,decisions,llm", "--out", join(outDir, "api.csv")], allKeys),
        cli(["run", ...q, "--cases", join(dir, "c.jsonl"), "--arms", "llm", "--out", join(outDir, "cli.csv")], noAnthropic),
        cli(["run", ...q, "--cases", join(dir, "c.jsonl"), "--budget", "0", "--out", join(outDir, "capped.csv")], allKeys),
        cli(["ask", ...q, "--input", M0_TEXT, "--llm-model", "claude-haiku-latest"], allKeys),
        cli(["verdict", join(outDir, "api.csv")], allKeys),
        cli(["validate", join(outDir, "api.csv")], allKeys),
      ];
      // The runs did the work: the keyed calls answered (the fixture fetch answers 401 to a request with no key).
      const asked = json(runs[2]?.stdout ?? "");
      const rows = field(asked, "rows");
      const outcomes = Array.isArray(rows) ? rows.map((r: unknown) => field(r, "outcome")) : [];
      expect(outcomes).toHaveLength(9);
      expect(outcomes.every((o) => o === "answered")).toBe(true);
      expect(runs[3]?.code).toBe(0);
      expect(validate(readFileSync(join(outDir, "api.csv"), "utf8")).errors).toEqual([]);
      const viaCli = readFileSync(join(outDir, "cli.csv"), "utf8");
      expect(viaCli).toContain(",llm,claude-haiku-5-5,yes,");
      expect(field(json(runs[4]?.stdout ?? ""), "counts", "llm", "answered")).toBe(6);
      expect(String(field(json(runs[4]?.stdout ?? ""), "budgetNote"))).toContain("overshot by at most one call");
      expect(field(json(runs[3]?.stdout ?? ""), "budgetNote")).toBeNull();
      expect(field(json(runs[5]?.stdout ?? ""), "stoppedByBudget")).toBe(true);
      expect(runs[6]?.code).toBe(2);
      // The measure: every captured stream and every file the CLI wrote.
      let count = 0;
      for (const done of runs) count += occurrences(done.stdout, canary) + occurrences(done.stderr, canary);
      const written = filesUnder(outDir);
      expect(written.length).toBe(3);
      for (const file of written) count += occurrences(readFileSync(file, "utf8"), canary);
      // The env the claude-cli transport hands its child, built from the same env the CLI got (src/decide/cli-spawn.ts).
      const childEnv = cliEnv({ PATH: process.env.PATH ?? "", ...allKeys, ANTHROPIC_API_KEY: canary });
      expect(childEnv.PATH).toBe(process.env.PATH ?? "");
      count += occurrences(JSON.stringify(childEnv), canary);
      expect(count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verdict stdout is flushed before exit", () => {
  test("[integration] CLI-PIPE-1 piped verdict output on a file over 1 MB equals the redirected output and parses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-cli-pipe-"));
    try {
      const lines = readFileSync(join(ROOT, "examples", "d15-sheet-check", "records.csv"), "utf8").split("\n");
      const header = lines[0] ?? "";
      const q1 = lines.slice(1).filter((line) => line.includes(",q1,"));
      expect(q1.length).toBeGreaterThan(100);
      const rows: string[] = [header];
      for (let copy = 0; copy < 150; copy++) {
        for (const line of q1) rows.push(line.replace(/^([^,]*,[^,]*,[^,]*,)(c\d+)(,)/, `$1$2x${copy}$3`));
      }
      const big = join(dir, "big.csv");
      writeFileSync(big, rows.join("\n") + "\n");
      const env = { PATH: process.env.PATH ?? "" };

      // A real OS pipe, as in `bun cli.ts verdict big.csv | wc -c`: Bun.spawn's own stdout pipe drains fast enough to hide the bug.
      const through = join(dir, "through-pipe.json");
      const piped = Bun.spawn(["bash", "-c", 'set -o pipefail; "$0" "$1" verdict "$2" | cat > "$3"', process.execPath, CLI, big, through], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
      const pipedCode = await piped.exited;
      const pipedBytes = readFileSync(through);

      const target = join(dir, "out.json");
      const redirected = Bun.spawn([process.execPath, CLI, "verdict", big], { cwd: ROOT, env, stdout: Bun.file(target), stderr: "pipe" });
      const redirectedCode = await redirected.exited;
      const fileBytes = readFileSync(target);

      expect(fileBytes.length).toBeGreaterThan(1_000_000);
      expect(pipedBytes.length).toBe(fileBytes.length);
      expect(pipedBytes.equals(fileBytes)).toBe(true);
      expect(pipedCode).toBe(redirectedCode);
      expect([0, 3, 4]).toContain(pipedCode);
      expect(field(json(pipedBytes.toString("utf8")), "exit_code")).toBe(pipedCode);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
