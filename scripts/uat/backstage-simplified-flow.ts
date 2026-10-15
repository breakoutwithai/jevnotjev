/** Offline consistency gate for CUA-captured synthetic replay artifacts; never drives a browser or calls a provider.
 * Artifacts are unsigned. PASS proves consistency with the captured run, not authenticity or human accuracy.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { checkExport } from "../../src/backstage/export-check.ts";
import { findCredentials } from "../../src/backstage/credential-scan.ts";

const stamp = z.string().datetime();
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const artifact = z.object({ file: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const replaySchema = z.object({
  schema: z.literal("backstage-simplified-flow/1"), head: sha, buildSha: sha,
  startedAt: stamp, finishedAt: stamp,
  widths: z.array(z.object({ width: z.number().int().positive(), recordedAt: stamp,
    dom: artifact, screenshot: artifact }).strict()),
  missingRule: artifact, ledger: artifact, records: artifact, runExport: artifact,
}).strict();
const domSchema = z.object({ viewportWidth: z.number().int().positive(), clientWidth: z.number().int().positive().optional(), scrollWidth: z.number().nonnegative(),
  text: z.string(), labels: z.array(z.string()), buttons: z.array(z.string()) }).strict();
const widthSchema = z.object({ setup: domSchema, results: domSchema }).strict();
const missingSchema = z.object({ recordedAt: stamp, activeElement: z.literal("acceptance"),
  requestCount: z.literal(0), dom: domSchema }).strict();
const ledgerSchema = z.object({ version: sha, synthetic: z.literal(true), ledger: z.array(z.object({
  caseId: z.string(), armId: z.string(), runId: z.string(), attemptId: z.string(), output: z.string(),
  provider: z.string(), dispatchedAt: stamp, startedAt: stamp, finishedAt: stamp, synthetic: z.literal(true),
}).strict()) }).strict();
const exportSchema = z.object({ manifest: z.object({ revision: z.string(), runId: z.string(), arms: z.array(z.string()),
  models: z.array(z.object({ id: z.string(), provider: z.string() }).passthrough()),
  scene: z.object({ cases: z.array(z.object({ id: z.string(), input: z.string() }).passthrough()) }).passthrough(),
}).passthrough(), records: z.string(), labels: z.array(z.object({
  label: z.enum(["accept", "reject"]), labelSource: z.literal("human"), labelBlind: z.literal(true),
}).passthrough()).length(90), attempts: z.array(z.object({
  runId: z.string(), revision: z.string(), caseId: z.string(), armId: z.string(), attemptId: z.string(),
  provider: z.string(), output: z.string(), ok: z.boolean(),
}).passthrough()) }).passthrough();

export interface ReplayOptions { readonly head: string; readonly widths: readonly number[]; }
export interface ReplayResult { readonly ok: boolean; readonly problems: readonly string[]; readonly requests: number; }
class ReplayError extends Error {}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
export function screenshotWidth(bytes: Buffer): number {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new ReplayError("Incomplete JPEG");
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) throw new ReplayError("Invalid JPEG marker");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker !== undefined && marker >= 0xd0 && marker <= 0xd7) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new ReplayError("Truncated JPEG segment");
      if (marker !== undefined && [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || bytes.readUInt16BE(offset + 3) === 0) throw new ReplayError("Invalid JPEG frame");
        const width = bytes.readUInt16BE(offset + 5);
        if (!width) throw new ReplayError("Empty JPEG frame");
        return width;
      }
      offset += length;
    }
    throw new ReplayError("Missing JPEG frame");
  }
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new ReplayError("Screenshot is not PNG");
  let offset = 8; let width = 0; let data = false; let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new ReplayError("Truncated PNG");
    const length = bytes.readUInt32BE(offset); const end = offset + 12 + length;
    if (end > bytes.length) throw new ReplayError("Truncated PNG chunk");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new ReplayError("PNG checksum mismatch");
    if (offset === 8 && (type !== "IHDR" || length !== 13)) throw new ReplayError("Missing PNG header");
    if (type === "IHDR") { width = bytes.readUInt32BE(offset + 8); if (!bytes.readUInt32BE(offset + 12)) throw new ReplayError("Empty PNG"); }
    if (type === "IDAT") data = true;
    if (type === "IEND") { ended = true; if (length || end !== bytes.length) throw new ReplayError("Invalid PNG end"); }
    offset = end;
  }
  if (!width || !data || !ended) throw new ReplayError("Incomplete PNG");
  return width;
}

export async function validateReplay(directory: string, options: ReplayOptions): Promise<ReplayResult> {
  const problems: string[] = []; let requests = 0;
  try {
    const base = resolve(directory);
    const replay = replaySchema.parse(JSON.parse(readFileSync(resolve(base, "replay.json"), "utf8")));
    const start = Date.parse(replay.startedAt); const finish = Date.parse(replay.finishedAt);
    if (finish < start || finish > Date.now() + 60000) throw new ReplayError("Invalid replay time window");
    if (replay.head !== options.head || replay.buildSha !== options.head) throw new ReplayError("Replay head/build does not match expected head");
    function inWindow(date: string): void {
      if (Date.parse(date) < start || Date.parse(date) > finish) throw new ReplayError("Artifact timestamp outside replay");
    }
    function bytes(ref: z.infer<typeof artifact>): Buffer {
      const path = resolve(base, ref.file);
      if (!path.startsWith(base + sep)) throw new ReplayError("Artifact path leaves evidence directory");
      const output = readFileSync(path);
      if (digest(output) !== ref.sha256) throw new ReplayError("Artifact hash mismatch");
      if (statSync(path).mtimeMs < start - 1000 || statSync(path).mtimeMs > finish + 1000) throw new ReplayError("Stale artifact modification time");
      return output;
    }
    function json(ref: z.infer<typeof artifact>): unknown {
      const value: unknown = JSON.parse(bytes(ref).toString("utf8"));
      if (findCredentials(value).length) throw new ReplayError("Credential-shaped content in evidence");
      return value;
    }
    const widths = replay.widths.map(item => item.width);
    if (options.widths.length === 0 || new Set(widths).size !== widths.length || widths.length !== options.widths.length || options.widths.some(width => !widths.includes(width))) throw new ReplayError("Required viewport evidence missing or duplicated");
    for (const item of replay.widths) {
      inWindow(item.recordedAt);
      const dom = widthSchema.parse(json(item.dom));
      for (const snapshot of [dom.setup, dom.results]) {
        if (snapshot.viewportWidth !== item.width || snapshot.scrollWidth > item.width) throw new ReplayError("Viewport mismatch or horizontal overflow");
        if (/Learning Lines|Casting|Rehearsals|Dress Rehearsal|Opening Night|New Scene/.test(snapshot.text)) throw new ReplayError("Old theatre workflow remains visible");
      }
      for (const label of ["Setup and run", "Review answers", "Results and downloads"]) {
        if (!dom.setup.buttons.includes(label)) throw new ReplayError("Simplified navigation missing");
      }
      if (!dom.setup.labels.includes("Judging rule (required)")) throw new ReplayError("Required judging rule is not labelled");
      for (const label of ["Try first case", "Run all 30 cases"]) if (!dom.setup.buttons.includes(label)) throw new ReplayError("Run action missing");
      if (!dom.results.text.includes("Results and downloads") || !dom.results.text.includes("paired labelled cases")) throw new ReplayError("Rendered results missing");
      for (const label of ["Download records.csv", "Download run evidence"]) if (!dom.results.buttons.includes(label)) throw new ReplayError("Download action missing");
      const imageWidth = screenshotWidth(bytes(item.screenshot));
      if (imageWidth !== item.width && imageWidth !== dom.setup.clientWidth) throw new ReplayError("Screenshot viewport mismatch");
    }
    const missing = missingSchema.parse(json(replay.missingRule)); inWindow(missing.recordedAt);
    // The validation message from setupProblem(), not the permanent "Judging rule (required)" field label.
    if (!missing.dom.text.includes("Judging rule is required")) throw new ReplayError("Missing-rule reason absent");
    const ledger = ledgerSchema.parse(json(replay.ledger));
    if (ledger.version !== options.head) throw new ReplayError("Stub ledger version mismatch");
    const exported: unknown = json(replay.runExport);
    const checked = await checkExport(exported);
    if (!checked.ok) throw new ReplayError("Downloaded run evidence does not reproduce");
    const run = exportSchema.parse(exported);
    if (run.manifest.revision !== options.head || run.manifest.scene.cases.length !== 30) throw new ReplayError("Run head or 30-case requirement mismatch");
    if (bytes(replay.records).toString("utf8") !== run.records) throw new ReplayError("Downloaded CSV differs from run evidence");
    const cases = new Set(run.manifest.scene.cases.map(item => item.id));
    if (cases.size !== 30) throw new ReplayError("Case IDs not unique");
    const models = run.manifest.models.filter(model => run.manifest.arms.includes(model.id) && model.id !== "rule");
    if (models.length !== 2 || !run.manifest.arms.includes("rule") || !models.some(model => model.provider === "jev")) throw new ReplayError("Expected Jev, one model and local rule");
    const slots = new Set<string>(); const attemptIds = new Set<string>();
    for (const entry of ledger.ledger) {
      inWindow(entry.dispatchedAt); inWindow(entry.startedAt); inWindow(entry.finishedAt);
      if (Date.parse(entry.dispatchedAt) <= Date.parse(missing.recordedAt) || Date.parse(entry.startedAt) < Date.parse(entry.dispatchedAt)) throw new ReplayError("Paid request precedes missing-rule validation");
      if (Date.parse(entry.finishedAt) < Date.parse(entry.startedAt)) throw new ReplayError("Request timing reversed");
      const model = models.find(model => model.id === entry.armId);
      if (!cases.has(entry.caseId) || !model || model.provider !== entry.provider || entry.runId !== run.manifest.runId) throw new ReplayError("Request not in selected run");
      const slot = `${entry.caseId}\0${entry.armId}`;
      if (slots.has(slot) || attemptIds.has(entry.attemptId)) throw new ReplayError("Duplicate paid request slot or attempt");
      slots.add(slot); attemptIds.add(entry.attemptId);
      const attempts = run.attempts.filter(attempt => attempt.caseId === entry.caseId && attempt.armId === entry.armId);
      if (attempts.length !== 1 || !attempts[0]?.ok || attempts[0].attemptId !== entry.attemptId || attempts[0].output !== entry.output || attempts[0].provider !== entry.provider || attempts[0].revision !== options.head || attempts[0].runId !== entry.runId) throw new ReplayError("Ledger does not match exported successful attempt");
    }
    requests = ledger.ledger.length;
    if (requests !== 60 || run.attempts.length !== 60) throw new ReplayError("Expected exactly 60 synthetic paid-provider slots");
    if (checked.labels !== 90 || checked.verdicts.length !== 1 || checked.verdicts.some(verdict => !verdict.matches)) throw new ReplayError("Incomplete labelled three-method results");
  } catch (error) {
    // Never echo untrusted data, field values or credential-bearing schema errors.
    problems.push(error instanceof z.ZodError ? "Malformed replay artifact schema" : error instanceof ReplayError ? error.message : "Replay artifact could not be read or checked");
  }
  return { ok: problems.length === 0, problems, requests };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  function option(name: string): string | undefined { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; }
  const directory = option("--evidence-dir") ?? process.env.BACKSTAGE_UAT_EVIDENCE;
  const widthText = option("--widths") ?? "1280,390";
  const widths = widthText.split(",").map(Number);
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: resolve(import.meta.dir, "..", "..") });
  const head = option("--expect-head") ?? git.stdout.toString().trim();
  if (!args.includes("--offline") || !directory || !/^[0-9a-f]{40}$/.test(head) || widths.some(width => !Number.isInteger(width) || width <= 0)) {
    console.error("Use --offline --widths 1280,390 --evidence-dir PATH [--expect-head SHA]"); process.exitCode = 1;
  } else {
    const result = await validateReplay(directory, { head, widths });
    console.log(result.ok ? `SIMPLIFIED FLOW PASS widths=${widths.join(",")} requests=${result.requests}` : `SIMPLIFIED FLOW FAIL: ${result.problems.join("; ")}`);
    if (!result.ok) process.exitCode = 1;
  }
}
