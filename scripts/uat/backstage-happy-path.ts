/** Human-run fresh-clone Backstage walk. Provider calls occur only after --run-all in a non-dry run. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { chromium, type Page } from "playwright-core";
import { loadExample } from "../uc13/arms.ts";
import { MODEL_CATALOG } from "../../src/backstage/catalog.ts";
import { validate } from "../../src/format/validate.ts";
import { buildReport, casesCsv, checkEvidence, checkRecords, envValue, fitKeywords, pinError, pollUntil, readOpeningNight, redact, reportDirName, resolveChromium, ruleKeywords, runCompleteState, runStartState, describeRunReason, scanForSecrets, uc13Scene, type Arm, type ReportInput } from "./happy-path-lib.ts";

const usage = "Usage: bun scripts/uat/backstage-happy-path.ts --out <dir> [--base <url>] [--clone-sha <sha>] [--example <dir>] [--key-env <file>] [--jev-key-name <NAME>] [--llm-key-name <NAME>] [--llm-model <id>] [--chromium <path>] [--pause-for-labels] [--headed] [--dry-run]\nChromium: --chromium, else UAT_CHROMIUM_PATH, else Playwright's cache (bunx playwright-core install chromium).";
interface Options { base: string; out: string; cloneSha: string | null; example: string; keyEnv: string | null; jevKeyName: string; llmKeyName: string; llmModel: string; chromium: string | null; pause: boolean; headed: boolean; dryRun: boolean }
function parseArgs(args: readonly string[]): Options | null {
  const options: Options = { base: "http://localhost:3456", out: "", cloneSha: null, example: "examples/uc13-shop-bot", keyEnv: null, jevKeyName: "JEV_API_KEY", llmKeyName: "OPENAI_API_KEY", llmModel: "gpt-6-luna", chromium: null, pause: false, headed: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help") return null;
    if (flag === "--pause-for-labels") { options.pause = true; options.headed = true; continue; }
    if (flag === "--headed") { options.headed = true; continue; }
    if (flag === "--dry-run") { options.dryRun = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) return null;
    switch (flag) {
      case "--base": options.base = value; break;
      case "--out": options.out = value; break;
      case "--clone-sha": options.cloneSha = value; break;
      case "--example": options.example = value; break;
      case "--key-env": options.keyEnv = value; break;
      case "--jev-key-name": options.jevKeyName = value; break;
      case "--llm-key-name": options.llmKeyName = value; break;
      case "--llm-model": options.llmModel = value; break;
      case "--chromium": options.chromium = value; break;
      default: return null;
    }
  }
  return options.out ? options : null;
}
/** Playwright's expected Chromium path; empty when the registry cannot name one. */
function bundledChromium(): string {
  try { return chromium.executablePath(); } catch { return ""; }
}
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const JEV_ROLE = "Jev key";
const LLM_ROLE = "LLM key";
const secrets = new Map<string, string>();
const clean = (value: unknown): string => redact(value instanceof Error ? value.message : String(value), secrets);
/** Real path of the nearest existing ancestor, plus the rest, so a not-yet-created --out compares like a real one. */
function realOf(path: string): string {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  return realpathSync(existing) + path.slice(existing.length);
}
function insideDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}
/**
 * Real path of the git work tree containing cwd; null when cwd is in no repository; undefined when git cannot run
 * (fail closed). Inherited GIT_* variables are dropped so an override cannot point the check at another tree.
 */
function workTreeTop(): string | null | undefined {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("GIT_") && value !== undefined) env[name] = value;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", env });
  if (top.error) return undefined;
  if (top.status !== 0) return /not a git repository/i.test(top.stderr) ? null : undefined;
  return realOf(top.stdout.replace(/\r?\n$/, ""));
}
async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) { console.error(clean(usage)); return 2; }
  // Run output never enters the repo: refuse an --out inside the git work tree this runs from.
  const repoTop = workTreeTop();
  if (repoTop === undefined) { console.error("Cannot run git to check that --out is outside the repository"); return 2; }
  if (repoTop !== null && insideDir(realOf(resolve(options.out)), repoTop)) {
    console.error("--out must be outside the repository work tree; run output never enters the repo");
    return 2;
  }
  // The key field is per provider (src/backstage/main.ts builds `${provider}-key`), so the model picks it.
  const llmEntry = MODEL_CATALOG.find((entry) => entry.modelId === options.llmModel && entry.provider !== "jev");
  if (!llmEntry) { console.error("--llm-model is not a catalog LLM model id; see src/backstage/catalog.ts"); return 2; }
  const llmProvider = llmEntry.provider;
  if (!options.dryRun) {
    let env = "";
    // Secrets are keyed by role, never by env name: a key name can carry a person's name, and every
    // message, redaction and scan hit below prints the map key.
    if (options.keyEnv) try { env = await readFile(options.keyEnv, "utf8"); } catch { console.error(clean("Cannot read the --key-env file")); return 2; }
    for (const [role, name] of [[JEV_ROLE, options.jevKeyName], [LLM_ROLE, options.llmKeyName]] as const) {
      const value = options.keyEnv ? (envValue(env, name) ?? "") : (process.env[name] ?? "");
      if (!value) { console.error(clean(`Missing the ${role} (see --jev-key-name / --llm-key-name)`)); return 2; }
      secrets.set(role, value);
    }
  }
  const example = await loadExample(resolve(options.example));
  const ruleMd = await readFile(join(resolve(options.example), "rule.md"), "utf8");
  const caseIds = example.cases.map((c) => c.case_id);
  const terms = ruleKeywords(ruleMd);
  const keywords = fitKeywords(terms, 20);
  const health = await fetch(new URL("/api/backstage/health", options.base));
  if (!health.ok) throw new Error(`Health returned HTTP ${health.status}`);
  const healthBody: unknown = await health.json();
  const version = typeof healthBody === "object" && healthBody !== null && "version" in healthBody && typeof healthBody.version === "string" ? healthBody.version : "unknown";
  const suffix = (options.cloneSha ?? version).slice(0, 7).replace(/[^A-Za-z0-9_.-]/g, "") || "unknown";
  // One fresh folder per invocation; the non-recursive mkdir fails rather than reuse an existing one.
  const reportDir = resolve(options.out, reportDirName(new Date(), suffix, randomBytes(3).toString("hex")));
  await mkdir(resolve(options.out), { recursive: true });
  await mkdir(reportDir);
  // A symlinked dated folder under an outside --out could still point back into the repo.
  if (repoTop !== null && insideDir(realpathSync(reportDir), repoTop)) {
    console.error("The report folder resolves inside the repository work tree; run output never enters the repo");
    return 2;
  }
  const csvPath = join(reportDir, "cases.csv");
  await writeFile(csvPath, casesCsv(example.cases));
  const steps: ReportInput["steps"][number][] = [];
  let page: Page | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let verdictText = "";
  let runStarted = false;
  let recordsCsv = "";
  let evidenceJson = "";
  const jevModel = MODEL_CATALOG.find((entry) => entry.provider === "jev")?.modelId ?? "jev-1.13.0";
  const armModels: Readonly<Record<Arm, string>> = { jev: jevModel, llm: options.llmModel, rule: "keywords-v1" };
  const caseInputs: ReadonlyMap<string, string> = new Map(example.cases.map((c) => [c.case_id, c.case_input]));
  const record = async (room: string, step: string, fn: () => Promise<string | void>): Promise<void> => {
    let pass = true, detail = "completed";
    try { const said = await fn(); if (typeof said === "string" && said) detail = said; } catch (error) { pass = false; detail = clean(error); }
    const shot = `${String(steps.length + 1).padStart(2, "0")}-${room.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${step.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jpg`;
    if (page) try { await page.screenshot({ path: join(reportDir, shot), type: "jpeg", quality: 80 }); } catch (error) { pass = false; detail += `; screenshot: ${clean(error)}`; }
    steps.push({ room, step, pass, detail, shot });
  };
  // The local build reports its git revision as its version; a different value means another server owns the port,
  // so nothing is driven (no keys typed, no paid calls) and only the failure report is written.
  const pinned = pinError(version, options.cloneSha);
  await record("Build", "pin", async () => { if (pinned) throw new Error(pinned); });
  const chromiumPath = pinned ? null : resolveChromium(options.chromium, process.env.UAT_CHROMIUM_PATH, bundledChromium(), existsSync);
  if (chromiumPath && "error" in chromiumPath) await record("Browser", "chromium", async () => { throw new Error(chromiumPath.error); });
  if (chromiumPath && "path" in chromiumPath) try {
    browser = await chromium.launch({ headless: !options.headed, executablePath: chromiumPath.path });
    page = await browser.newPage({ acceptDownloads: true });
    page.setDefaultTimeout(15000);
    const p = page;
    await record("New Scene", "open", async () => { await p.goto(new URL("/backstage/", options.base).toString()); await p.locator("#question").waitFor(); });
    const scene = uc13Scene(example.factSheet);
    await record("New Scene", "set decision", async () => {
      await p.locator("#question").fill(scene.question);
      await p.locator("#choice-a").fill(scene.choiceA);
      await p.locator("#choice-b").fill(scene.choiceB);
      await p.locator("#definition-a").fill(scene.definitionA);
      await p.locator("#definition-b").fill(scene.definitionB);
      await p.locator("#acceptance").fill(scene.acceptance);
    });
    await record("Casting", "open", async () => { await p.locator("#next").click(); await p.waitForTimeout(400); });
    await record("Casting", "select players", async () => {
      await p.locator("#compare").check();
      await p.locator("#llm-player").waitFor({ state: "visible" });
      await p.locator(`#model-options [id="arm-${options.llmModel}"]`).check();
      await p.locator("#include-rule").check();
      await p.locator("#rule-fields").waitFor({ state: "visible" });
      await p.locator("#keywords").fill(keywords.kept.join("\n"));
      return `rule: ${keywords.kept.length} literals (Backstage cap 20); redundant under substring match: ${keywords.redundant.join(", ") || "none"}; left out of rule.md: ${keywords.dropped.join(", ") || "none"}`;
    });
    await record("Casting", "provider keys", async () => {
      if (options.dryRun) return;
      const jev = secrets.get(JEV_ROLE);
      const llm = secrets.get(LLM_ROLE);
      if (!jev || !llm) throw new Error("Missing provider key");
      await p.locator('#jev-key[type="password"]').fill(jev);
      await p.locator(`#${llmProvider}-key[type="password"]`).fill(llm);
    });
    await record("Learning Lines", "open", async () => { await p.locator("#next").click(); await p.waitForTimeout(400); });
    await record("Learning Lines", "import 40 cases", async () => {
      await p.locator("#import-cases").setInputFiles(csvPath);
      await p.getByText("Imported 40 cases", { exact: false }).waitFor();
      const preview = await p.locator("#run-preview").innerText();
      if (!preview.includes("40 cases")) throw new Error(`Run preview did not show 40 cases: ${preview}`);
    });
    if (!options.dryRun) {
      await record("Learning Lines", "run all", async () => {
        // A blocked run only writes its reason to #run-reason and #notice; surface it instead of waiting out the timeout.
        const reason = (await p.locator("#run-reason").innerText()).trim();
        if (reason) throw new Error(`Run not startable: ${describeRunReason(reason)}`);
        await p.locator("#run-all").click();
        // Started means #progress shows the run (the app awaits its health check first). #run-reason is only reported.
        try {
          await pollUntil(async () => runStartState(await p.locator("#progress").innerText()), 60000, 500, sleep);
        } catch (error) {
          const why = describeRunReason(await p.locator("#run-reason").innerText());
          const notice = (await p.locator("#notice").innerText()).trim();
          throw new Error(`Run did not start: ${clean(error)}; run reason ${why}${notice ? `; notice: ${notice}` : ""}`);
        }
        runStarted = true;
      });
      await record("Learning Lines", "complete all arms", async () => {
        if (!runStarted) throw new Error("skipped: the run did not start");
        const paidCells = caseIds.length * 2;
        await pollUntil(async () => runCompleteState(await p.locator("#run-preview").innerText(), await p.locator("#progress").innerText(), paidCells), 600000, 2000, sleep);
      });
      await record("Rehearsals", "open", async () => { await p.locator("#next").click(); await p.waitForTimeout(400); });
      await record("Rehearsals", "open judging", async () => { await p.getByRole("button", { name: /Open .*judging/ }).click(); await p.locator("#confirm-judging-yes").click(); await p.locator("#blind-card").waitFor(); });
      if (options.pause) await record("Rehearsals", "person labels", async () => { console.log(clean("Judging is open. Label in the headed browser, then press Enter here.")); const input = createInterface({ input: process.stdin, output: process.stdout }); try { await input.question(""); } finally { input.close(); } });
      await record("Rehearsals", "reveal", async () => {
        await p.locator("#reveal").click();
        const confirm = p.locator("#confirm-reveal-yes");
        if (!(await confirm.isVisible())) throw new Error((await p.locator("#reveal-reason").innerText()) || "Reveal confirmation was unavailable");
        await confirm.click();
      });
      await record("Dress Rehearsal", "open", async () => { await p.locator('#rooms button[data-room="4"]').click(); });
      await record("Dress Rehearsal", "download-csv", async () => {
        const [download] = await Promise.all([p.waitForEvent("download"), p.locator("#download-csv").click()]);
        await download.saveAs(join(reportDir, "records.csv"));
        recordsCsv = await readFile(join(reportDir, "records.csv"), "utf8");
      });
      await record("Dress Rehearsal", "download-evidence", async () => {
        const [download] = await Promise.all([p.waitForEvent("download"), p.locator("#download-evidence").click()]);
        await download.saveAs(join(reportDir, "evidence.json"));
        evidenceJson = await readFile(join(reportDir, "evidence.json"), "utf8");
        const problems = checkEvidence(evidenceJson, recordsCsv, options.pause);
        if (problems.length) throw new Error(problems.slice(0, 3).join("; "));
      });
      await record("Opening Night", "verdict", async () => {
        await p.locator('#rooms button[data-room="5"]').click();
        await p.locator("#verdict h3").waitFor();
        verdictText = await p.locator("#verdict").innerText();
        const parsed = readOpeningNight(verdictText);
        if ("error" in parsed) throw new Error(parsed.error);
      });
    }
  } catch (error) {
    await record("Browser", "start or navigate", async () => { throw new Error(clean(error)); });
  } finally { await browser?.close(); }
  if (!options.dryRun) {
    const checked = validate(recordsCsv);
    if (checked.errors.length) steps.push({ room: "Records", step: "validate", pass: false, detail: checked.errors.slice(0, 3).join("; "), shot: "" });
    const problems = checkRecords(recordsCsv, caseIds, ["jev", "llm", "rule"], options.pause, { inputs: caseInputs, models: armModels });
    if (problems.length) steps.push({ room: "Records", step: "all players", pass: false, detail: `${problems.length} record problem(s)`, shot: "" });
  }
  const out = resolve(options.out);
  const reportInput: ReportInput = { base: options.base, version, cloneSha: options.cloneSha, csv: recordsCsv, caseIds, caseInputs, armModels, evidence: evidenceJson, verdictText, steps, secretHits: scanForSecrets(out, secrets), runTime: new Date().toISOString(), labels: options.pause ? "by a person (--pause-for-labels)" : "none (agents never label)", notes: ["Scanned: --out (all files)", `Rule: Backstage keyword rule (substring match, cap 20), not rule.md's word-start rule: ${keywords.kept.length} of ${terms.length} rule.md terms; redundant under substring match: ${keywords.redundant.join(", ") || "none"}; left out: ${keywords.dropped.join(", ") || "none"}`, "Screenshots: keys are typed only into password fields; screenshot pixels are not scanned."], dryRun: options.dryRun };
  let result = buildReport(reportInput);
  await writeFile(join(reportDir, "report.md"), clean(result.markdown));
  const after = scanForSecrets(out, secrets);
  if (after.length) {
    result = buildReport({ ...reportInput, secretHits: after });
    await writeFile(join(reportDir, "report.md"), clean(result.markdown));
  }
  console.log(clean(join(reportDir, "report.md")));
  console.log(clean(`Verdict: ${verdictText.split("\n")[0] || (options.dryRun ? "DRY RUN" : "unavailable")}`));
  return result.exitCode;
}
try { process.exitCode = await main(); } catch (error) { console.error(clean(error)); process.exitCode = 1; }
