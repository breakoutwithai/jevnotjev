import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { BACKSTAGE_BLIND_PICK, BACKSTAGE_PICK, BackstageRun } from "../../src/backstage/run.ts";
import { answerYes } from "../../src/backstage/dom-fixture.ts";
import { screenshotWidth, validateReplay } from "./backstage-simplified-flow.ts";

const HEAD = "a".repeat(40);
const LLM = "claude-haiku-4-5-20251001";
const root = mkdtempSync(join(tmpdir(), "simplified-flow-validator-"));
let runText = ""; let records = "";
let ledger: { version: string; synthetic: true; ledger: { caseId: string; armId: string; runId: string; attemptId: string; output: string; provider: string; dispatchedAt: string; startedAt: string; finishedAt: string; synthetic: true }[] };
let nonBlind: { runText: string; records: string; ledger: typeof ledger };
let startedAt = ""; let missingRecordedAt = "";
function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, bytes: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), bytes]); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]);
}
function png(width: number): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(width * 4 + 1))), chunk("IEND", Buffer.alloc(0))]);
}
function dom(width: number, results = false) {
  return { viewportWidth: width, scrollWidth: width, text: results ? "Results and downloads 30 paired labelled cases" : "Setup and run Judging rule (required)",
    labels: ["Judging rule (required)"], buttons: results ? ["Download records.csv", "Download run evidence"] : ["Setup and run", "Review answers", "Results and downloads", "Try first case", "Run all 30 cases"] };
}
function fixture(useNonBlind = false) {
  const data = useNonBlind ? nonBlind : { runText, records, ledger };
  const directory = mkdtempSync(join(root, "run-")); const recordedAt = new Date().toISOString();
  function artifact(file: string, bytes: Buffer) { writeFileSync(join(directory, file), bytes); return { file, sha256: digest(bytes) }; }
  function json(file: string, data: unknown) { return artifact(file, Buffer.from(JSON.stringify(data))); }
  const replay = { schema: "backstage-simplified-flow/1", head: HEAD, buildSha: HEAD, startedAt, finishedAt: new Date(Date.now() + 1000).toISOString(),
    widths: [1280, 390].map(width => ({ width, recordedAt, dom: json(`${width}-dom.json`, { setup: dom(width), results: dom(width, true) }), screenshot: artifact(`${width}.png`, png(width)) })),
    missingRule: json("missing-rule.json", { recordedAt: missingRecordedAt, activeElement: "acceptance", requestCount: 0, dom: dom(1280) }),
    ledger: json("ledger.json", data.ledger), records: artifact("records.csv", Buffer.from(data.records)), runExport: artifact("run-evidence.json", Buffer.from(data.runText)),
  };
  function save() { writeFileSync(join(directory, "replay.json"), JSON.stringify(replay)); }
  function replace(ref: { file: string; sha256: string }, data: unknown) { const bytes = Buffer.from(JSON.stringify(data)); writeFileSync(join(directory, ref.file), bytes); ref.sha256 = digest(bytes); save(); }
  save(); return { directory, replay, save, replace };
}
beforeAll(async () => {
  startedAt = new Date(Date.now() - 1000).toISOString();
  ledger = { version: HEAD, synthetic: true, ledger: [] };
  missingRecordedAt = new Date().toISOString(); await new Promise<void>(done => setTimeout(done, 2));
  async function capture(blind: boolean) {
  ledger = { version: HEAD, synthetic: true, ledger: [] };
  const run = new BackstageRun({ question: "Does this synthetic case ask for a refund?", choices: [{ name: "yes", definition: "Explicit request" }, { name: "no", definition: "Anything else" }], acceptance: "Match the explicit request", exclusions: "None", keywords: ["refund"], matchChoice: "yes", otherwiseChoice: "no", cases: Array.from({ length: 30 }, (_, i) => ({ id: `c${i + 1}`, input: `Synthetic case ${i + 1}: please refund the payment` })) }, HEAD, { arms: ["jev", LLM, "rule"] });
  await run.start({ jev: "synthetic-jev", anthropic: "synthetic-anthropic" }, async request => {
    const dispatchedAt = new Date().toISOString();
    const result = await answerYes(request);
    ledger.ledger.push({ caseId: request.caseId, armId: request.armId, provider: request.provider, runId: request.runId, attemptId: result.attemptId, output: result.output, dispatchedAt, startedAt: result.startedAt, finishedAt: result.finishedAt, synthetic: true });
    return result;
  });
  run.beginLabeling();
  if (blind) for (const item of run.manifest.scene.cases) run.pickBlind(item.id, "yes", BACKSTAGE_BLIND_PICK);
  else for (const card of run.cards()) run.label(card.id, "accept", BACKSTAGE_PICK);
  run.reveal(); await run.report(); const evidence = run.evidence(); records = evidence.records; runText = JSON.stringify(evidence);
  return { runText, records, ledger };
  }
  const blind = await capture(true); nonBlind = await capture(false);
  runText = blind.runText; records = blind.records; ledger = blind.ledger;
}, 20000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("offline captured replay validator (fixtures are not UI replay evidence)", () => {
  test("[integration] C2 accepts internally consistent synthetic artifacts and real run exports", async () => {
    const f = fixture(); expect(await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).toEqual({ ok: true, problems: [], requests: 60 });
  }, 20000);
  test("[integration] C2 rejects internally consistent run exports judged after answers were shown", async () => {
    const f = fixture(true); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
  });
  test("[unit] C2 reads JPEG SOF dimensions and rejects a truncated frame", () => {
    // Header parser fixture, not a screenshot or proof of a decoded image.
    const frame = Buffer.from([255,216,255,192,0,11,8,0,1,5,0,1,1,17,0,255,217]);
    expect(screenshotWidth(frame)).toBe(1280);
    expect(() => screenshotWidth(frame.subarray(0, frame.length - 2))).toThrow();
  });
  test("[integration] C2 rejects retrospective missing-rule evidence after provider requests", async () => {
    const f = fixture(); f.replace(f.replay.missingRule, { recordedAt: new Date().toISOString(), activeElement: "acceptance", requestCount: 0, dom: dom(1280) });
    expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
  });
  test("[integration] C2 rejects stale replay or build heads", async () => {
    const f = fixture(); f.replay.buildSha = "b".repeat(40); f.save(); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
  });
  test("[integration] C2 rejects malformed and missing viewport artifacts", async () => {
    const f = fixture(); f.replay.widths.pop(); f.save(); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
    writeFileSync(join(f.directory, "replay.json"), "{}"); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
  });
  test("[integration] C2 rejects duplicate actual request slots even with a fresh artifact hash", async () => {
    const f = fixture(); f.replace(f.replay.ledger, { ...ledger, ledger: [...ledger.ledger, ledger.ledger[0]] }); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
  }, 20000);
  test("[integration] C2 rejects altered CSV and inconsistent downloaded export", async () => {
    const f = fixture(); writeFileSync(join(f.directory, f.replay.records.file), records + "altered"); f.replay.records.sha256 = digest(Buffer.from(records + "altered")); f.save(); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
    const bad: unknown = JSON.parse(runText); if (typeof bad !== "object" || bad === null) throw Error("Expected fixture export"); Reflect.set(bad, "records", "altered"); f.replace(f.replay.runExport, bad); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
  }, 20000);
  test("[integration] C2 rejects overflow or old navigation in actual DOM snapshots", async () => {
    const f = fixture(); const item = f.replay.widths[1]; if (!item) throw Error("Missing fixture viewport"); f.replace(item.dom, { setup: { ...dom(390), scrollWidth: 800 }, results: dom(390, true) }); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
    f.replace(item.dom, { setup: { ...dom(390), text: "Learning Lines" }, results: dom(390, true) }); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
  });
  test("[integration] C2 rejects screenshot replacement and stale screenshot timestamps", async () => {
    const f = fixture(); const item = f.replay.widths[0]; if (!item) throw Error("Missing fixture viewport"); writeFileSync(join(f.directory, item.screenshot.file), png(390)); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
    writeFileSync(join(f.directory, item.screenshot.file), png(1280)); const stale = new Date(Date.parse(startedAt) - 60000); utimesSync(join(f.directory, item.screenshot.file), stale, stale); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
  });
  test("[integration] C2 refuses paid calls before missing-rule focus and avoids echoing credentials", async () => {
    const f = fixture(); f.replace(f.replay.missingRule, { recordedAt: new Date().toISOString(), activeElement: "acceptance", requestCount: 1, dom: dom(1280) }); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
    const secret = "sk-proj-" + "A1".repeat(25); writeFileSync(join(f.directory, "replay.json"), secret); const result = await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] }); expect(result.ok).toBe(false); expect(result.problems.join(" ")).not.toContain(secret);
  });
  test("[integration] C2 rejects a ledger attempt whose output differs from the downloaded answer", async () => {
    const f = fixture(); f.replace(f.replay.ledger, { ...ledger, ledger: ledger.ledger.map((item, i) => i === 0 ? { ...item, output: "no" } : item) }); expect((await validateReplay(f.directory, { head: HEAD, widths: [1280, 390] })).ok).toBe(false);
  }, 20000);
});
