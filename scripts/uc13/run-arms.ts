// UC13 three-arm run. Reads examples/uc13-shop-bot/, writes docs/product/runs/2026-10-01-uc13-shop-bot/.
//
//   bun scripts/uc13/run-arms.ts run --dry   rule arm only, no network
//   bun scripts/uc13/run-arms.ts run         rule, Jev (jev-1.13.0) and the LLM (claude -p --model haiku)
//   bun scripts/uc13/run-arms.ts page        label.html: fact sheet, acceptance rule, messages; no arm output
//   bun scripts/uc13/run-arms.ts label       merge labels.csv (case_id,truth) into records.csv
//
// Jev calls go through $JEV_CALL (default ~/.claude/scripts/jaylo-jev.sh call <body.json>), which reads the key
// itself; this process never holds it. The LLM arm runs with no tools, no MCP servers and no user settings,
// so its cost is the triage prompt alone. One call per message per arm.
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRITERIA, QUESTION, RUN_ID, applyLabels, armRecord, formatRecords, jevBody, loadExample, parseJevResponse,
  parseLlmResponse, parseRecords, parseTruth, ruleRecord, type ArmReply, type Case, type RecordRow,
} from "./arms.ts";

const EXAMPLE = fileURLToPath(new URL("../../examples/uc13-shop-bot/", import.meta.url));
const OUT = fileURLToPath(new URL("../../docs/product/runs/2026-10-01-uc13-shop-bot/", import.meta.url));
const JEV_CALL = process.env.JEV_CALL ?? join(homedir(), ".claude/scripts/jaylo-jev.sh");
const LLM_MODEL = "haiku";
const CONCURRENCY = 4;

const { factSheet, cases } = await loadExample(EXAMPLE);

const LLM_SYSTEM =
  "You are the triage step of a ski shop's website and phone bot. Rules: unknown availability stays unknown; " +
  "an enquiry is not a confirmed booking; the bot may only state facts from the fact sheet.\n\n" +
  `Fact sheet:\n${factSheet}\n\nFor the customer message you are given, decide: ${QUESTION}\n` +
  `answer: ${CRITERIA.answer}\nhand_off: ${CRITERIA.hand_off}\n` +
  "Reply with exactly one word: answer or hand_off.";

interface Timed { readonly reply: ArmReply; readonly ms: number }

async function spawnJson(cmd: readonly string[], cwd: string, what: string): Promise<{ json: unknown; ms: number }> {
  const t0 = performance.now();
  const proc = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const ms = Math.round(performance.now() - t0);
  if (code !== 0) throw new Error(`${what} exited ${code}: ${stderr.trim().slice(0, 300)}`);
  const json: unknown = JSON.parse(stdout);
  return { json, ms };
}

async function jevArm(c: Case, dir: string): Promise<Timed> {
  const bodyPath = join(dir, `${c.case_id}.json`);
  await Bun.write(bodyPath, JSON.stringify(jevBody(factSheet, c)));
  const { json, ms } = await spawnJson([JEV_CALL, "call", bodyPath], dir, `Jev ${c.case_id}`);
  return { reply: parseJevResponse(json, c.case_id), ms };
}

async function llmArm(c: Case, dir: string): Promise<Timed> {
  const { json, ms } = await spawnJson(
    ["claude", "-p", "--model", LLM_MODEL, "--output-format", "json", "--tools", "", "--strict-mcp-config",
      "--setting-sources", "", "--no-session-persistence", "--system-prompt", LLM_SYSTEM, `Customer message: ${c.case_input}`],
    dir, `claude -p ${c.case_id}`,
  );
  return { reply: parseLlmResponse(json, c.case_id), ms };
}

/** Run fn over items, at most `limit` at a time, results in input order. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      if (item !== undefined) out[i] = await fn(item);
    }
  }));
  return out;
}

async function run(dry: boolean): Promise<void> {
  const rows: RecordRow[] = cases.map(ruleRecord);
  const calls: unknown[] = [];
  if (!dry) {
    const dir = await mkdtemp(join(tmpdir(), "uc13-"));
    try {
      const arms: readonly (readonly ["jev" | "llm", (c: Case, dir: string) => Promise<Timed>])[] = [["jev", jevArm], ["llm", llmArm]];
      for (const [arm, fn] of arms) {
        const results = await pool(cases, CONCURRENCY, (c) => fn(c, dir));
        results.forEach(({ reply, ms }, i) => {
          const c = cases[i];
          if (c === undefined) return;
          rows.push(armRecord(c, arm, reply, ms));
          calls.push({ case_id: c.case_id, arm, model: reply.model, choice: reply.choice, probabilities: reply.probabilities });
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  await Bun.write(join(OUT, "records.csv"), formatRecords(rows));
  await Bun.write(join(OUT, "raw.json"), JSON.stringify({ run_id: RUN_ID, llm_model_requested: LLM_MODEL, calls }, null, 1) + "\n");
  const arms = [...new Set(rows.map((r) => r.answerer))].sort().join(",");
  console.log(`wrote records.csv rows=${rows.length} cases=${cases.length} arms=${arms}`);
}

async function label(): Promise<void> {
  const truth = parseTruth(await Bun.file(join(OUT, "labels.csv")).text());
  const rows = applyLabels(parseRecords(await Bun.file(join(OUT, "records.csv")).text()), truth);
  await Bun.write(join(OUT, "records.csv"), formatRecords(rows));
  console.log(`labelled ${rows.filter((r) => r.label !== "").length} of ${rows.length} rows from ${truth.size} truth labels`);
}

async function page(): Promise<void> {
  const template = await Bun.file(join(EXAMPLE, "label.template.html")).text();
  const html = template.replace("__SHEET__", JSON.stringify(factSheet)).replace("__CASES__", JSON.stringify(cases));
  await Bun.write(join(OUT, "label.html"), html);
  console.log(`wrote label.html with ${cases.length} messages`);
}

const [command, ...flags] = process.argv.slice(2);
if (command === "run") await run(flags.includes("--dry"));
else if (command === "label") await label();
else if (command === "page") await page();
else {
  console.error("usage: bun scripts/uc13/run-arms.ts run [--dry] | label | page");
  process.exit(2);
}
