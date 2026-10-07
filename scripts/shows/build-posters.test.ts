import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { formatRows, readDictRows } from "../../src/format/csv.ts";
import { join } from "node:path";
import { buildPosters, POSTERS_OUT, render, summariseRun } from "./build-posters.ts";
import type { Poster } from "../../src/shows/posters.ts";

const ROOT = join(import.meta.dir, "..", "..");
const page = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const office = page.slice(page.indexOf('<section class="office" id="tickets"'), page.indexOf("</section>", page.indexOf('id="tickets"')));
const script = readFileSync(join(ROOT, "site", "shows", "office.js"), "utf8");
const committed: { posters: Poster[] } = JSON.parse(readFileSync(POSTERS_OUT, "utf8"));

describe("ticket office form", () => {
  test("[unit] T1 form has exactly one required field, email", () => {
    expect(office.length).toBeGreaterThan(0);
    const required = [...office.matchAll(/<(input|select|textarea)\b[^>]*\brequired\b[^>]*>/g)].map((m) => m[0].match(/name="([^"]+)"/)?.[1]);
    expect(required).toEqual(["email"]);
    expect(office).toMatch(/<input type="url" id="tkWebsite" name="website"(?![^>]*required)[^>]*>/);
    expect(office).toMatch(/<input type="checkbox" id="tkConsent" name="consent"(?![^>]*checked)[^>]*>/);
    expect(office).toMatch(/<input type="checkbox" id="tkFollow" name="follow_up"(?![^>]*checked)[^>]*>/);
  });
});

describe("posters", () => {
  test("[unit] T2 posters generated, at most 10, none typed", async () => {
    const built = await buildPosters(ROOT);
    expect(readFileSync(POSTERS_OUT, "utf8")).toBe(render(built));
    const docs = readdirSync(join(ROOT, "docs/product/use-cases")).filter((f) => /^uc\d+-.+\.md$/.test(f));
    expect(built.length).toBe(docs.length);
    expect(built.length).toBeGreaterThan(0);
    for (const p of built) {
      expect(page.includes(p.title)).toBe(false);
      expect(script.includes(p.title)).toBe(false);
      if (p.story) expect(script.includes(p.story)).toBe(false);
    }
    const check = spawnSync("bun", [join(import.meta.dir, "build-posters.ts"), "--check"], { encoding: "utf8" });
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(`posters up to date: ${built.length}`);
  });

  test("[unit] T2 a run under 30 paired labels carries no verdict word; a labelled run does", async () => {
    const rehearsal = await summariseRun(ROOT, "2026-10-03-tokenmax");
    expect(rehearsal?.labelledPaired).toBe(0);
    expect(rehearsal?.verdict).toBeNull();
    const show = await summariseRun(ROOT, "2026-10-01-uc13-shop-bot");
    expect(show?.labelledPaired).toBe(40);
    expect(typeof show?.verdict).toBe("string");
    for (const p of committed.posters) if (p.run && p.run.labelledPaired < 30) expect(p.run.verdict).toBeNull();
  });
});

const UC13 = readFileSync(join(ROOT, "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv"), "utf8");

/** A one-run fixture root whose records.csv is UC13's with `edit` applied to every row's cells. */
function fixture(edit: (cell: (name: string) => string, set: (name: string, value: string) => void) => void): string {
  const root = mkdtempSync(join(tmpdir(), "posters-"));
  mkdirSync(join(root, "docs/product/use-cases"), { recursive: true });
  mkdirSync(join(root, "docs/product/runs/2026-01-01-fixture"), { recursive: true });
  const { header, rows } = readDictRows(UC13);
  const head = header ?? [];
  const out = rows.map(({ fields }) => {
    const row = [...fields];
    edit((name) => row[head.indexOf(name)] ?? "", (name, value) => { row[head.indexOf(name)] = value; });
    return row;
  });
  writeFileSync(join(root, "docs/product/runs/2026-01-01-fixture/records.csv"), formatRows([head, ...out]));
  return root;
}

describe("summariseRun on fixtures", () => {
  test("[unit] an unreviewed agent label is not counted as checked or paired", async () => {
    const root = fixture((_cell, set) => { set("label_source", "agent"); set("label_blind", "true"); });
    const run = await summariseRun(root, "2026-01-01-fixture");
    expect(run?.labelledPaired).toBe(0);
    expect(run?.verdict).toBeNull();
    expect(run?.methods.map((m) => [m.arm, m.rows, m.labelled, m.accepted])).toEqual([["llm", 40, 0, 0], ["rule", 40, 0, 0], ["jev", 40, 0, 0]]);
  });

  test("[unit] two questions of 20 paired cases each are two cohorts, neither judged", async () => {
    const root = fixture((cell, set) => { if (Number(cell("case_id").slice(1)) > 20) set("question_id", "q2"); });
    const run = await summariseRun(root, "2026-01-01-fixture");
    expect(run?.cohorts).toBe(2);
    expect(run?.labelledPaired).toBe(20);
    expect(run?.verdict).toBeNull();
  });

  test("[unit] an invalid records.csv stops generation", async () => {
    const root = fixture((cell, set) => { if (cell("case_id") === "m01") set("label", "maybe"); });
    expect(summariseRun(root, "2026-01-01-fixture")).rejects.toThrow("is invalid");
  });
});

describe("catalogue and deploy", () => {
  test("[unit] every use-case doc has a poster: ids derived from the docs folder, not the generated file", () => {
    const ids = readdirSync(join(ROOT, "docs/product/use-cases")).filter((f) => /^uc\d+-.+\.md$/.test(f)).map((f) => f.match(/^(uc\d+)/)?.[1] ?? f).sort();
    expect(committed.posters.map((p) => p.id).sort()).toEqual(ids);
  });

  test("[unit] a poster change marks Backstage stale: posters.json is a Backstage drift path", () => {
    const ship = readFileSync(join(ROOT, ".deploy/ship.sh"), "utf8");
    expect(ship.match(/^BACKSTAGE_FIXED_PATHS=\(([^)]*)\)/m)?.[1]?.split(/\s+/)).toContain("site/shows/posters.json");
  });
});
