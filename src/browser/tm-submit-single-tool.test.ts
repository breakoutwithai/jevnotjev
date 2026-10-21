import { describe, expect, test } from "bun:test";
import { checkMap } from "../backstage/maps.ts";
import { submitBody, weekToPayload } from "./tm-submit.ts";
import { parseWeek, type Week } from "./tm-week.ts";

// #344: a visitor who uses only one of Claude / Codex has "not recorded" for the other tool's lines and must still be able to Submit.

const CLAUDE_ONLY = [
  "TOKENMAX WEEK", "Period: 2026-09-24 to 2026-09-30", "Claude sessions: 2", "Codex sessions: not recorded", "Claude output tokens: 625000",
  "Codex output tokens: not recorded", "Opus share of Claude output: 100%", "Usage limit hits: 0", "Sessions per day: 2, 0, 1, 1, 0, 1, 1",
  "Limit hit days: none", "Codex weekly window used: not recorded", "Pattern: leaving most unused",
].join("\n");
const CODEX_ONLY = CLAUDE_ONLY
  .replace("Claude sessions: 2", "Claude sessions: not recorded").replace("Codex sessions: not recorded", "Codex sessions: 2")
  .replace("Claude output tokens: 625000", "Claude output tokens: not recorded").replace("Codex output tokens: not recorded", "Codex output tokens: 625000")
  .replace("Opus share of Claude output: 100%", "Opus share of Claude output: not recorded").replace("Codex weekly window used: not recorded", "Codex weekly window used: 12%");
const KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const week = (text: string): Week => { const w = parseWeek(text); if (!w) throw new Error("fixture did not parse"); return w; };

describe("tm-submit single tool (#344)", () => {
  test("[unit] TM-18 a Claude-only block (Codex lines not recorded) maps to sources claude and the server accepts it", () => {
    const mapped = weekToPayload(week(CLAUDE_ONLY));
    if (!mapped.ok) throw new Error(mapped.message);
    expect(mapped.payload).toMatchObject({ sources: "claude", sessions: 2, days: 7, output_tokens: { claude: 625000, codex: 0 }, opus_share_pct: 100, codex_weekly_pct: null });
    expect(checkMap(submitBody(mapped.payload, "abc", KEY)).ok).toBe(true);
  });

  test("[unit] TM-18 a Codex-only block (Claude lines not recorded) maps to sources codex and the server accepts it", () => {
    const mapped = weekToPayload(week(CODEX_ONLY));
    if (!mapped.ok) throw new Error(mapped.message);
    expect(mapped.payload).toMatchObject({ sources: "codex", sessions: 2, output_tokens: { claude: 0, codex: 625000 }, codex_weekly_pct: 12 });
    expect(checkMap(submitBody(mapped.payload, "abc", KEY)).ok).toBe(true);
  });

  test("[unit] TM-18 when neither tool is recorded the submit is refused without telling the visitor to rerun the same prompt", () => {
    const neither = CLAUDE_ONLY.replace("Claude sessions: 2", "Claude sessions: not recorded").replace("Claude output tokens: 625000", "Claude output tokens: not recorded");
    const result = weekToPayload(week(neither));
    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.message;
    expect(message).toContain("Claude sessions");
    expect(message).toContain("Codex sessions");
    expect(message).not.toContain("Run the prompt again");
  });

  test("[unit] TM-18 a tool with output tokens but no session count is still refused, naming the session line", () => {
    const result = weekToPayload(week(CLAUDE_ONLY.replace("Codex output tokens: not recorded", "Codex output tokens: 5")));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("Codex sessions");
  });

  test("[unit] TM-18 a tool is absent only when its lines say not recorded: unreadable values are refused", () => {
    const result = weekToPayload(week(CLAUDE_ONLY.replace("Codex sessions: not recorded", "Codex sessions: unreadable").replace("Codex output tokens: not recorded", "Codex output tokens: unreadable")));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("Codex sessions");
  });

  test("[unit] TM-18 a tool is absent only when its lines say not recorded: omitted lines are refused", () => {
    const omitted = CLAUDE_ONLY.split("\n").filter((l) => !l.startsWith("Codex sessions") && !l.startsWith("Codex output tokens")).join("\n");
    const result = weekToPayload(week(omitted));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("Codex sessions");
  });

  test("[unit] TM-18 Codex with a weekly window reading is not absent, so the submit is refused rather than sent with zero Codex", () => {
    const result = weekToPayload(week(CLAUDE_ONLY.replace("Codex weekly window used: not recorded", "Codex weekly window used: 12%")));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("Codex sessions");
  });

  test("[unit] TM-18 the last line for a label decides: a later number overrides an earlier not recorded and is never zeroed", () => {
    const result = weekToPayload(week(`${CLAUDE_ONLY}\nCodex sessions: 10\nCodex output tokens: 500`));
    expect(result.ok && result.payload).toMatchObject({ sources: "claude+codex", sessions: 12, output_tokens: { claude: 625000, codex: 500 } });
  });

  test("[unit] TM-18 the last line for a label decides: a later unreadable value overrides an earlier not recorded", () => {
    const result = weekToPayload(week(`${CLAUDE_ONLY}\nCodex sessions: unreadable\nCodex output tokens: unreadable`));
    expect(result.ok).toBe(false);
  });

  test("[unit] TM-18 an omitted Codex weekly window line is refused, not read as Codex absent", () => {
    const omitted = CLAUDE_ONLY.split("\n").filter((l) => !l.startsWith("Codex weekly window")).join("\n");
    expect(weekToPayload(week(omitted)).ok).toBe(false);
  });

  test("[unit] TM-18 an unreadable Codex weekly window line is refused, not read as Codex absent", () => {
    expect(weekToPayload(week(CLAUDE_ONLY.replace("Codex weekly window used: not recorded", "Codex weekly window used: unreadable"))).ok).toBe(false);
  });
});
