import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLabels, formatRecords, parseRecords, parseTruth } from "./arms.ts";
import { main, parseArgs, pool, renderPage, spawnJson, type Paths } from "./run-arms.ts";

const EXAMPLE = fileURLToPath(new URL("../../examples/uc13-shop-bot/", import.meta.url));
const RUN = fileURLToPath(new URL("../../docs/product/runs/2026-10-01-uc13-shop-bot/", import.meta.url));
const FIXTURE = join(EXAMPLE, "fixtures/uc13.jev.json");

/** A copy of the recorded run in a temp dir; the example and fixture are read in place, never written. */
async function withRun(fn: (paths: Paths) => Promise<void>): Promise<void> {
  const out = await mkdtemp(join(tmpdir(), "uc13-run-"));
  try {
    await copyFile(join(RUN, "records.csv"), join(out, "records.csv"));
    await copyFile(join(RUN, "raw.json"), join(out, "raw.json"));
    await fn({ example: EXAMPLE, out, fixture: FIXTURE, jevCall: join(out, "no-such-jev-call") });
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function read(path: string): Promise<string> {
  return Bun.file(path).text();
}

describe("run-arms commands", () => {
  test("[unit] UC13-F1 run --dry leaves records.csv and raw.json untouched", async () => {
    await withRun(async (paths) => {
      const before = [await read(join(paths.out, "records.csv")), await read(join(paths.out, "raw.json"))];
      await main(["run", "--dry"], paths);
      expect([await read(join(paths.out, "records.csv")), await read(join(paths.out, "raw.json"))]).toEqual(before);
    });
  });

  test("[unit] UC13-F2 M1 replay keeps labels and their provenance on every arm, byte-identical", async () => {
    await withRun(async (paths) => {
      const rows = parseRecords(await read(join(paths.out, "records.csv")));
      const truth = parseTruth(`case_id,truth\nm01,hand_off\nm02,answer\nm03,answer\n`);
      const labelled = formatRecords(applyLabels(rows, truth, { source: "human", by: "op-1", at: "2026-10-07T09:30:00Z", blind: true }));
      await writeFile(join(paths.out, "records.csv"), labelled);
      await main(["replay"], paths);
      expect(await read(join(paths.out, "records.csv"))).toBe(labelled);
    });
  });

  test("[unit] M1 replay keeps each case's own provenance when cases were labelled differently", async () => {
    await withRun(async (paths) => {
      const rows = parseRecords(await read(join(paths.out, "records.csv")));
      const blind = applyLabels(rows, parseTruth("case_id,truth\nm01,hand_off\n"), { source: "human", by: "op-1", at: "2026-10-07T09:30:00Z", blind: true });
      const mixed = blind.map((r, i) => (r.case_id === "m01" ? r : rows[i] ?? r));
      const text = formatRecords(mixed);
      await writeFile(join(paths.out, "records.csv"), text);
      await main(["replay"], paths);
      expect(await read(join(paths.out, "records.csv"))).toBe(text);
    });
  });

  test("[unit] M1 label stamps exactly the provenance given on the command line, and a /1 labelled run is refused on rebuild", async () => {
    await withRun(async (paths) => {
      await writeFile(join(paths.out, "labels.csv"), "case_id,truth\nm01,hand_off\n");
      await main(["label", "--source", "human", "--by", "op-2", "--at", "2026-10-08T10:00:00Z", "--blind", "true"], paths);
      const rows = parseRecords(await read(join(paths.out, "records.csv")));
      expect(new Set(rows.filter((r) => r.label !== "").map((r) => [r.label_source, r.labelled_by, r.labelled_at, r.label_blind].join("|")))).toEqual(
        new Set(["human|op-2|2026-10-08T10:00:00Z|true"]),
      );
      expect(rows.filter((r) => r.label !== "")).toHaveLength(3);
      const v1 = formatRecords(
        rows.map(({ labelled_by: _by, labelled_at: _at, label_blind: _blind, ...r }) => ({ ...r, format_version: "jnj-record/1" })),
      );
      await writeFile(join(paths.out, "records.csv"), v1);
      await expect(main(["replay"], paths)).rejects.toThrow(/label --source/);
    });
  });

  test("[unit] UC13-F2 replay of the recorded run reproduces records.csv and raw.json", async () => {
    await withRun(async (paths) => {
      await main(["replay"], paths);
      expect(await read(join(paths.out, "records.csv"))).toBe(await read(join(RUN, "records.csv")));
      expect(await read(join(paths.out, "raw.json"))).toBe(await read(join(RUN, "raw.json")));
    });
  });

  test("[unit] UC13-F8 run --arm jev refuses kept LLM results without a matching inputs fingerprint", async () => {
    await withRun(async (paths) => {
      await expect(main(["run", "--arm", "jev"], paths)).rejects.toThrow(/full run/);
      const raw: unknown = JSON.parse(await read(join(paths.out, "raw.json")));
      const edited = typeof raw === "object" && raw !== null ? { ...raw, inputs_sha256: "0".repeat(64) } : raw;
      await writeFile(join(paths.out, "raw.json"), JSON.stringify(edited));
      await expect(main(["run", "--arm", "jev"], paths)).rejects.toThrow(/full run/);
    });
  });

  test("[unit] UC13-F9 replay refuses malformed raw calls or missing LLM rows", async () => {
    await withRun(async (paths) => {
      await writeFile(join(paths.out, "raw.json"), JSON.stringify({ run_id: "run-shopbot-2026-10-01" }));
      await expect(main(["replay"], paths)).rejects.toThrow(/raw\.json/);
    });
    await withRun(async (paths) => {
      const rows = parseRecords(await read(join(paths.out, "records.csv"))).filter((r) => r.answerer !== "llm" || r.case_id !== "m07");
      await writeFile(join(paths.out, "records.csv"), formatRecords(rows));
      await expect(main(["replay"], paths)).rejects.toThrow(/m07/);
    });
  });
});

describe("argument parsing", () => {
  test("[unit] UC13-F22 unknown or conflicting flags are refused before any side effect", () => {
    expect(() => parseArgs(["run", "--dry-run"])).toThrow(/--dry-run/);
    expect(() => parseArgs(["run", "--dry", "--arm", "jev"])).toThrow(/--dry/);
    expect(() => parseArgs(["run", "--arm", "llm"])).toThrow(/--arm/);
    expect(() => parseArgs(["replay", "--dry"])).toThrow(/--dry/);
    expect(() => parseArgs(["label"])).toThrow(/--source/);
    expect(() => parseArgs(["label", "--source", "human", "--by", "op-1", "--at", "2026-10-07"])).toThrow(/--blind/);
    expect(() => parseArgs(["label", "--source", "person", "--by", "op-1", "--at", "2026-10-07", "--blind", "true"])).toThrow(/--source/);
    expect(() => parseArgs(["label", "--source", "human", "--by", "a@b.c", "--at", "2026-10-07", "--blind", "true"])).toThrow(/--by/);
    expect(() => parseArgs(["label", "--source", "human", "--by", "op-1", "--at", "today", "--blind", "true"])).toThrow(/--at/);
    expect(() => parseArgs(["label", "--source", "human", "--by", "op-1", "--at", "2026-10-07", "--blind", "yes"])).toThrow(/--blind/);
    expect(parseArgs(["label", "--source", "human_reviewed", "--by", "operator", "--at", "2026-10-03", "--blind", "false"])).toEqual({
      command: "label",
      dry: false,
      arm: null,
      provenance: { source: "human_reviewed", by: "operator", at: "2026-10-03", blind: false },
    });
    expect(() => parseArgs(["deploy"])).toThrow(/usage/);
    expect(parseArgs(["run", "--dry"])).toEqual({ command: "run", dry: true, arm: null, provenance: null });
    expect(parseArgs(["run", "--arm", "jev"])).toEqual({ command: "run", dry: false, arm: "jev", provenance: null });
    expect(parseArgs(["replay"])).toEqual({ command: "replay", dry: false, arm: null, provenance: null });
  });
});

describe("worker pool", () => {
  test("[unit] UC13-F12 a failure stops new work and settles in-flight work before rejecting", async () => {
    const started: number[] = [];
    let slowDone = false;
    const run = pool([0, 1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      if (n === 0) throw new Error("boom");
      await Bun.sleep(50);
      if (n === 1) slowDone = true;
      return n;
    });
    await expect(run).rejects.toThrow(/boom/);
    expect(slowDone).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  test("[unit] UC13-F12 results come back in input order with their index", async () => {
    expect(await pool(["a", "b", "c"], 2, async (s, i) => `${s}${i}`)).toEqual(["a0", "b1", "c2"]);
  });
});

describe("subprocess deadline", () => {
  test("[integration] UC13-F14 a stalled subprocess is killed at its deadline", async () => {
    const t0 = performance.now();
    await expect(spawnJson(["sleep", "5"], tmpdir(), "sleeper", 100)).rejects.toThrow(/sleeper timed out/);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("labelling page", () => {
  const template = "<script>\nconst SHEET = __SHEET__;\nconst CASES = __CASES__;\n</script>";

  test("[unit] UC13-F16 data holding </script> cannot close the page script", () => {
    const html = renderPage(template, "</script><script>alert(1)</script>", [{ case_id: "m01", case_input: "</SCRIPT>" }]);
    expect(html.match(/<\/script>/gi)?.length).toBe(1);
    expect(html).not.toContain("<script>alert");
  });

  test("[unit] UC13-F17 $ patterns and marker text in the data are inserted literally", () => {
    const html = renderPage(template, "Cost is $& and $' and $`", [{ case_id: "m01", case_input: "__SHEET__" }]);
    expect(html).toContain('const SHEET = "Cost is $& and $\' and $`";');
    expect(html).toContain('"case_input":"__SHEET__"');
  });

  test("[unit] UC13-F23 the generated page holds the answer vocabulary but no arm output or model", async () => {
    const html = await read(join(RUN, "label.html"));
    expect(html).toContain("hand_off");
    for (const leak of ["jev-1.13.0", "claude-haiku", "keywords.v1", "probabilities", "confidence", "answerer"]) {
      expect(html).not.toContain(leak);
    }
  });

  test("[unit] UC13-F18 shortcuts ignore modifiers, key repeat, composition and editable targets", async () => {
    const html = await read(join(EXAMPLE, "label.template.html"));
    const src = html.match(/\/\/ shortcut:start\n([\s\S]*?)\/\/ shortcut:end/)?.[1];
    expect(src).toBeDefined();
    const shortcut: unknown = new Function(`${src ?? ""}\nreturn shortcut;`)();
    if (typeof shortcut !== "function") throw new Error("template defines no shortcut function");
    const key = (k: string, extra: Record<string, unknown> = {}) => shortcut({ key: k, target: { tagName: "BODY" }, ...extra });
    expect([key("a"), key("H"), key("ArrowLeft"), key("ArrowRight")]).toEqual(["answer", "hand_off", "prev", "next"]);
    expect(key("a", { ctrlKey: true })).toBeNull();
    expect(key("a", { metaKey: true })).toBeNull();
    expect(key("a", { altKey: true })).toBeNull();
    expect(key("a", { repeat: true })).toBeNull();
    expect(key("a", { isComposing: true })).toBeNull();
    expect(key("a", { target: { tagName: "INPUT" } })).toBeNull();
    expect(key("a", { target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
    expect(key("x")).toBeNull();
  });
});
