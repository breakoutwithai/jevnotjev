import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { evaluateText } from "../browser/results-loader.ts";
import { readDictRows, formatRows } from "../format/csv.ts";
import { FIXTURES_ENV } from "../decide/cli-args.ts";

const ROOT = join(import.meta.dir, "..", "..");
const GUIDE = join(ROOT, "docs", "GUIDE.md");
const CASES = join(ROOT, "examples", "uc13-shop-bot", "cases.jsonl");
const COMMAND_IDS = [
  "prepare", "question", "rule", "cases", "estimate", "without-jev", "with-jev", "label-page",
  "merge-labels", "validate", "result-page", "verdict-no-jev", "verdict-with-jev",
] satisfies readonly string[];
const BROWSER_ALLOWLIST = new Map([
  ["label-page", { command: "open site/label/index.html", reason: "The UC13 blind picks need a human in a browser." }],
  ["result-page", { command: "open site/index.html", reason: "The file picker needs a browser." }],
]);

interface GuideCommand { readonly id: string; readonly script: string }

function commands(text: string): GuideCommand[] {
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)\n```/g)];
  const fences = [...text.matchAll(/^```([^\n]*)$/gm)].map((match) => match[1]);
  expect(fences).toEqual(blocks.flatMap(() => ["sh", ""]));
  return blocks.map((match) => {
    const script = match[1] ?? "";
    const first = script.split("\n")[0] ?? "";
    const id = first.match(/^# guide: ([a-z-]+)$/)?.[1];
    if (id === undefined) throw new Error(`Every sh block needs a # guide: id, got ${JSON.stringify(first)}`);
    return { id, script: script.split("\n").slice(1).join("\n") };
  });
}

function fixtureFile(dir: string): string {
  const path = join(dir, "fixtures.json");
  writeFileSync(path, JSON.stringify({ hosts: {
    "api.typesafe.ai": { http: 200, response: {
      model: "jev-1.13.0",
      answers: { routing: { type: "choice", choice: "hand_off", confidence: 0.9, probabilities: { answer: 0.1, hand_off: 0.9 } } },
      usage: { input_tokens: 451, output_tokens: 71 },
    } },
    "api.anthropic.com": { http: 200, response: {
      model: "claude-haiku-5-5", content: [{ type: "text", text: '{"routing":"hand_off"}' }],
      stop_reason: "end_turn", usage: { input_tokens: 190, output_tokens: 32 },
    } },
  }, cli: { stdout: "", exitCode: 1 } }));
  return path;
}

function testCopy(dir: string): void {
  for (const path of ["src", "format", "site", "examples/uc13-shop-bot/cases.jsonl", "examples/uc13-shop-bot/fact-sheet.md", "package.json"]) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, path), target, { recursive: true });
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
}

function runGuide(dir: string, id: string, fixture: string): { code: number; output: string; error: string } {
  const command = commands(readFileSync(GUIDE, "utf8")).find((item) => item.id === id);
  if (command === undefined) throw new Error(`Missing ${id} command`);
  const done = Bun.spawnSync(["/bin/sh", "-eu", "-c", command.script], {
    cwd: dir, env: { PATH: process.env.PATH ?? "", [FIXTURES_ENV]: fixture, ANTHROPIC_API_KEY: "fixture-only" },
  });
  return { code: done.exitCode, output: done.stdout.toString(), error: done.stderr.toString() };
}

function writeLabels(dir: string, ids: readonly string[]): void {
  writeFileSync(join(dir, "guide-work", "labels.csv"), formatRows([
    ["case_id", "truth", "final", "suggestion_shown", "labelled_at"],
    ...ids.map((id) => [id, "hand_off", "", "", "2026-10-09T00:00:00Z"]),
  ]));
}

function caseIds(): string[] {
  return readFileSync(CASES, "utf8").trim().split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("case_id" in value) || typeof value.case_id !== "string") {
      throw new Error("Bad case fixture");
    }
    return value.case_id;
  });
}

describe("first-use guide", () => {
  test("[unit] D18-GUIDE-STRUCTURE seven steps and the README entry are in order", () => {
    const text = readFileSync(GUIDE, "utf8");
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      "1. Describe the decision", "2. Write 30+ cases", "3. Price it first", "4. Run the arms",
      "5. Label blind", "6. Load the file", "7. Read the verdict",
    ]);
    expect(readFileSync(join(ROOT, "README.md"), "utf8").split("\n").slice(0, 6)).toContain("Run your own workflow: [docs/GUIDE.md](docs/GUIDE.md).");
  });

  test("[unit] D18-GUIDE-COMMANDS every sh block is checked or explicitly browser-allowlisted", () => {
    const listed = commands(readFileSync(GUIDE, "utf8"));
    expect(listed.map((command) => command.id)).toEqual(COMMAND_IDS);
    const browser = listed.filter((command) => /^open /m.test(command.script));
    expect(browser.map((command) => command.id)).toEqual([...BROWSER_ALLOWLIST.keys()]);
    for (const command of browser) {
      const allowed = BROWSER_ALLOWLIST.get(command.id);
      if (allowed === undefined) throw new Error(`Browser command ${command.id} is not allowlisted`);
      expect(allowed.reason.length).toBeGreaterThan(0);
      expect(command.script).toBe(allowed.command);
    }
  });

  test("[integration] D18-GUIDE-RUN every guide command executes in a temp copy with provider fixtures and Chromium", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-guide-"));
    try {
      testCopy(dir);
      const fixture = fixtureFile(dir);
      const listed = commands(readFileSync(GUIDE, "utf8"));
      expect(listed.map((command) => command.id)).toEqual(COMMAND_IDS);
      const expected = new Map([
        ["prepare", { code: 0, output: "guide-work ready" }],
        ["question", { code: 0, output: "routing question ready" }],
        ["rule", { code: 0, output: '"match": "hand_off"' }],
        ["cases", { code: 0, output: "40 cases ready" }],
        ["estimate", { code: 0, output: '"casesForVerdict": 30' }],
        ["without-jev", { code: 0, output: '"rows": 80' }],
        ["with-jev", { code: 0, output: '"rows": 120' }],
        ["merge-labels", { code: 0, output: "with-jev: labelled 120 rows" }],
        ["validate", { code: 0, output: '"valid": true' }],
        ["verdict-no-jev", { code: 4, output: '"verdict": "not enough evidence"' }],
        ["verdict-with-jev", { code: 0, output: '"verdict": "use Jev"' }],
      ]);
      expect([...expected.keys(), ...BROWSER_ALLOWLIST.keys()].sort()).toEqual([...COMMAND_IDS].sort());
      const sourceCases = readFileSync(CASES, "utf8").trim().split("\n").map((line) => {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null || !("case_id" in value) || typeof value.case_id !== "string" ||
          !("case_input" in value) || typeof value.case_input !== "string") throw new Error("bad source case");
        return { id: value.case_id, input: value.case_input };
      });
      const chromiumPath = process.env.UAT_CHROMIUM_PATH || chromium.executablePath();
      if (!existsSync(chromiumPath)) throw new Error("Chromium is missing. Install it with `bunx playwright-core install chromium` or set UAT_CHROMIUM_PATH.");
      const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
      let pageVerdict = "";
      try {
      for (const command of listed) {
        if (BROWSER_ALLOWLIST.has(command.id)) {
          const page = join(dir, BROWSER_ALLOWLIST.get(command.id)?.command.slice(5) ?? "missing");
          expect(existsSync(page)).toBe(true);
          const tab = await browser.newPage();
          await tab.goto(pathToFileURL(page).href);
          if (command.id === "label-page") {
            expect(await tab.locator("#pos").textContent()).toBe("Message 1 of 40 (m01)");
            expect(await tab.locator("#suggestion").textContent()).toBe("");
            await tab.locator("#bH").click();
            expect(await tab.locator("#picked").textContent()).toBe("Your blind pick: hand_off");
            for (let i = 1; i < 40; i++) await tab.locator("#next").click();
            expect(await tab.locator("#pos").textContent()).toBe("Message 40 of 40 (m40)");
          } else {
            await tab.locator("#csv").setInputFiles(join(dir, "guide-work", "with-jev-labelled.csv"));
            await tab.waitForFunction(() => document.getElementById("dropStatus")?.textContent?.startsWith("VALID: with-jev-labelled.csv"));
            pageVerdict = await tab.locator("#loadedResult .ld-verdicts .ld-v").first().textContent() ?? "";
            expect(pageVerdict).toBe("use Jev");
          }
          await tab.close();
          continue;
        }
        if (command.id === "merge-labels") {
          const labelRows = sourceCases.map(({ id }) => [id, "hand_off", "", "", "2026-10-09T00:00:00Z"]);
          writeFileSync(join(dir, "guide-work", "labels.csv"), formatRows([
            ["case_id", "truth", "final", "suggestion_shown", "labelled_at"], ...labelRows,
          ]));
        }
        const check = expected.get(command.id);
        if (check === undefined) throw new Error(`No check for ${command.id}`);
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? "", [FIXTURES_ENV]: fixture, ANTHROPIC_API_KEY: "fixture-only",
        };
        if (command.id === "with-jev") env.JEV_API_KEY = "fixture-only";
        if (command.id === "without-jev") expect(env.JEV_API_KEY).toBeUndefined();
        const done = Bun.spawnSync(["/bin/sh", "-eu", "-c", command.script], { cwd: dir, env });
        const output = done.stdout.toString();
        expect(done.exitCode, `${command.id}: ${done.stderr.toString()} ${output}`).toBe(check.code);
        expect(output, command.id).toContain(check.output);
        if (command.id === "verdict-with-jev") {
          const verdict: unknown = JSON.parse(output);
          if (typeof verdict !== "object" || verdict === null || !("verdicts" in verdict) || !Array.isArray(verdict.verdicts)) {
            throw new Error("CLI verdict missing");
          }
          const first: unknown = verdict.verdicts[0];
          if (typeof first !== "object" || first === null || !("verdict" in first) || typeof first.verdict !== "string") {
            throw new Error("CLI verdict entry missing");
          }
          expect(pageVerdict).toBe(first.verdict);
        }
        if (command.id === "without-jev" || command.id === "with-jev") {
          expect(done.stderr.toString()).toContain(`NOTE ${FIXTURES_ENV} is set`);
        }
        if (command.id === "prepare") expect(existsSync(join(dir, "guide-work"))).toBe(true);
        if (command.id === "question") {
          const question: unknown = JSON.parse(readFileSync(join(dir, "guide-work", "question.json"), "utf8"));
          if (typeof question !== "object" || question === null || !("instructions" in question) || typeof question.instructions !== "string") {
            throw new Error("Guide question has no instructions");
          }
          expect(question.instructions).toContain(readFileSync(join(dir, "examples", "uc13-shop-bot", "fact-sheet.md"), "utf8").trim());
        }
        if (command.id === "rule") {
          const rule: unknown = JSON.parse(readFileSync(join(dir, "guide-work", "rule.json"), "utf8"));
          expect(rule).toMatchObject({ match: "hand_off", otherwise: "answer" });
        }
      }
      const madeCases = readFileSync(join(dir, "guide-work", "cases.jsonl"), "utf8").trim().split("\n").map((line) => {
        const value: unknown = JSON.parse(line);
        return value;
      });
      expect(madeCases).toEqual(sourceCases);
      const without = readDictRows(readFileSync(join(dir, "guide-work", "no-jev.csv"), "utf8"));
      const withJev = readDictRows(readFileSync(join(dir, "guide-work", "with-jev.csv"), "utf8"));
      const armAt = withJev.header?.indexOf("answerer") ?? -1;
      expect(without.rows.every((row) => row.fields[armAt] !== "jev")).toBe(true);
      expect(withJev.rows.filter((row) => row.fields[armAt] === "jev")).toHaveLength(40);
      const runAt = withJev.header?.indexOf("run_id") ?? -1;
      expect(withJev.rows.every((row) => row.fields[runAt] === "guide-with-jev-fixture")).toBe(true);
      for (const name of ["no-jev", "with-jev"]) {
        const labelled = readDictRows(readFileSync(join(dir, "guide-work", `${name}-labelled.csv`), "utf8"));
        if (!labelled.header) throw new Error(`Missing ${name} labelled header`);
        const at = (column: string): number => labelled.header?.indexOf(column) ?? -1;
        for (const { fields } of labelled.rows) {
          expect(fields[at("label")]).toBe(fields[at("output")] === "hand_off" ? "accept" : "reject");
          expect(fields[at("label_source")]).toBe("human");
          expect(fields[at("labelled_by")]).toBe("operator");
          expect(fields[at("labelled_at")]).toBe("2026-10-09T00:00:00Z");
          expect(fields[at("label_blind")]).toBe("true");
        }
      }
      const loaded = await evaluateText("with-jev-labelled.csv", readFileSync(join(dir, "guide-work", "with-jev-labelled.csv"), "utf8"));
      expect(loaded.valid).toBe(true);
      expect(loaded.questions[0]?.caseTotal).toBe(40);
      expect(loaded.questions[0]?.verdict).toBe("use Jev");
      } finally {
        await browser.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[integration] D18-GUIDE-NO-JEV labels, validates and scores with only the no-Jev run", () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-guide-no-jev-"));
    try {
      testCopy(dir);
      const fixture = fixtureFile(dir);
      for (const id of ["prepare", "question", "rule", "cases", "without-jev"]) {
        expect(runGuide(dir, id, fixture).code, id).toBe(0);
      }
      writeLabels(dir, caseIds());
      expect(runGuide(dir, "merge-labels", fixture)).toMatchObject({ code: 0, output: expect.stringContaining("no-jev: labelled 80 rows") });
      expect(existsSync(join(dir, "guide-work", "with-jev-labelled.csv"))).toBe(false);
      expect(runGuide(dir, "validate", fixture)).toMatchObject({ code: 0, output: expect.stringContaining('"valid": true') });
      expect(runGuide(dir, "verdict-no-jev", fixture)).toMatchObject({ code: 4, output: expect.stringContaining('"verdict": "not enough evidence"') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[integration] D18-GUIDE-LABEL-GUARDS rejects short and unknown truth lists, leaves refused rows unlabelled", () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-guide-label-"));
    try {
      testCopy(dir);
      const fixture = fixtureFile(dir);
      for (const id of ["prepare", "question", "rule", "cases", "without-jev"]) {
        expect(runGuide(dir, id, fixture).code, id).toBe(0);
      }
      const ids = caseIds();
      writeLabels(dir, ids.slice(0, 29));
      const short = runGuide(dir, "merge-labels", fixture);
      expect(short.code).not.toBe(0);
      expect(short.error).toContain("Need at least 30 blind truth picks");
      writeLabels(dir, [...ids, "typo-id"]);
      const unknown = runGuide(dir, "merge-labels", fixture);
      expect(unknown.code).not.toBe(0);
      expect(unknown.error).toContain("Unknown label case_id typo-id");
      writeLabels(dir, ids);
      const path = join(dir, "guide-work", "no-jev.csv");
      const source = readDictRows(readFileSync(path, "utf8"));
      if (!source.header) throw new Error("Missing run header");
      const outcomeAt = source.header.indexOf("outcome");
      const first = source.rows[0];
      if (first === undefined) throw new Error("Missing run row");
      const rows = source.rows.map(({ fields }, index) => {
        const cells = [...fields];
        if (index === 0) cells[outcomeAt] = "refused";
        return cells;
      });
      writeFileSync(path, formatRows([source.header, ...rows]));
      expect(runGuide(dir, "merge-labels", fixture).code).toBe(0);
      const labelled = readDictRows(readFileSync(join(dir, "guide-work", "no-jev-labelled.csv"), "utf8"));
      if (!labelled.header) throw new Error("Missing labelled header");
      const at = (column: string): number => labelled.header?.indexOf(column) ?? -1;
      for (const [index, { fields }] of labelled.rows.entries()) {
        if (index === 0) {
          for (const column of ["label", "label_source", "labelled_by", "labelled_at", "label_blind"]) {
            expect(fields[at(column)], column).toBe("");
          }
        } else {
          expect(fields[at("label")]).toBe(fields[at("output")] === "hand_off" ? "accept" : "reject");
          expect(fields[at("label_source")]).toBe("human");
          expect(fields[at("labelled_by")]).toBe("operator");
          expect(fields[at("labelled_at")]).toBe("2026-10-09T00:00:00Z");
          expect(fields[at("label_blind")]).toBe("true");
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[integration] D18-GUIDE-PROVENANCE configured source, handle and blindness reach every label", () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-guide-provenance-"));
    try {
      testCopy(dir);
      const fixture = fixtureFile(dir);
      for (const id of ["prepare", "question", "rule", "cases", "without-jev"]) {
        expect(runGuide(dir, id, fixture).code, id).toBe(0);
      }
      writeLabels(dir, caseIds());
      const command = commands(readFileSync(GUIDE, "utf8")).find((item) => item.id === "merge-labels");
      if (command === undefined) throw new Error("Missing merge command");
      for (const [source, blind] of [["human", "false"], ["human_reviewed", "false"], ["agent", "false"]]) {
        const script = command.script
          .replace('const SOURCE = "human";', `const SOURCE = "${source}";`)
          .replace('const BY = "operator";', 'const BY = "labeller-1";')
          .replace('const BLIND = "true";', `const BLIND = "${blind}";`);
        const done = Bun.spawnSync(["/bin/sh", "-eu", "-c", script], {
          cwd: dir, env: { PATH: process.env.PATH ?? "", [FIXTURES_ENV]: fixture, ANTHROPIC_API_KEY: "fixture-only" },
        });
        expect(done.exitCode, done.stderr.toString()).toBe(0);
        const labelled = readDictRows(readFileSync(join(dir, "guide-work", "no-jev-labelled.csv"), "utf8"));
        if (!labelled.header) throw new Error("Missing labelled header");
        const at = (column: string): number => labelled.header?.indexOf(column) ?? -1;
        for (const { fields } of labelled.rows) {
          expect(fields[at("label_source")]).toBe(source);
          expect(fields[at("labelled_by")]).toBe("labeller-1");
          expect(fields[at("label_blind")]).toBe(blind);
        }
        expect(runGuide(dir, "validate", fixture)).toMatchObject({ code: 0, output: expect.stringContaining('"valid": true') });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
