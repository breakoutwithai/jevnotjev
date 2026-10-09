import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { formatRows, readDictRows } from "../../src/format/csv.ts";
import { join } from "node:path";
import { buildPosters, POSTERS_OUT, render, summariseRun, watchPage } from "./build-posters.ts";
import type { Poster } from "../../src/shows/posters.ts";

const ROOT = join(import.meta.dir, "..", "..");
const page = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const office = page.slice(page.indexOf('<section class="office" id="tickets"'), page.indexOf("</section>", page.indexOf('id="tickets"')));
const script = readFileSync(join(ROOT, "site", "shows", "office.js"), "utf8");
const committed: { posters: Poster[] } = JSON.parse(readFileSync(POSTERS_OUT, "utf8"));

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  textContent = "";
  value = "";
  href = "";
  hidden = false;
  disabled = false;
  checked = false;
  id = "";
  private attributes = new Map<string, string>();
  constructor(readonly tag: string) {}
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  set innerHTML(_value: string) { this.children = []; }
  get options(): FakeElement[] { return this.children.filter((child) => child.tag === "option"); }
  addEventListener(_name: string, _handler: () => void): void {}
  querySelector(selector: string): FakeElement | null {
    if (selector === ".tk-submit") return submit;
    if (selector === "input[name=kind]:checked") return showKind;
    return null;
  }
  querySelectorAll(_selector: string): FakeElement[] { return []; }
}
const submit = new FakeElement("button");
const showKind = new FakeElement("input");
showKind.value = "show";

async function renderedOffice(): Promise<FakeElement> {
  const wrap = new FakeElement("div");
  const form = new FakeElement("form");
  const select = new FakeElement("select");
  const ids = new Map<string, FakeElement>([["tkForm", form], ["tkShow", select], ["tkPosters", wrap]]);
  for (const id of ["tkShowField", "tkWebsiteField", "tkIdeaField", "tkChosen"]) ids.set(id, new FakeElement("div"));
  const document = {
    getElementById: (id: string) => ids.get(id) ?? null,
    createElement: (tag: string) => new FakeElement(tag),
    querySelectorAll: (_selector: string) => [],
  };
  const fetch = async (url: string) => url === "shows/posters.json"
    ? { ok: true, json: async () => committed }
    : { ok: false, json: async () => ({}) };
  new Function("document", "fetch", "crypto", script)(document, fetch, crypto);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return wrap;
}

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
  test("[integration] S6 UC13 poster derives headline and projection while retaining the verdict", async () => {
    const run = await summariseRun(ROOT, "2026-10-01-uc13-shop-bot");
    expect(run?.headline).toBe("Same accuracy as the LLM (38/40 each) at 1/79th of the cost");
    expect(run?.verdict).toBe("not enough evidence");
    expect(run?.whyNotYet).toBe("Not proven yet: the lower bound of Jev minus the LLM is -0.11, below the -0.10 margin, on 40 paired cases. If the next cases split the same way, about 6 more paired cases would bring it inside the margin.");
  });

  test("[integration] S6 office renders real poster headline, verdict and projection in order", async () => {
    const wrap = await renderedOffice();
    const card = wrap.children.find((child) => child.getAttribute("data-id") === "uc13");
    expect(card).toBeDefined();
    const measured = card?.children.filter((child) => ["tk-headline", "tk-verdict", "tk-why"].includes(child.className));
    expect(measured?.map((child) => child.className)).toEqual(["tk-headline", "tk-verdict", "tk-why"]);
    expect(measured?.map((child) => child.textContent)).toEqual([
      "Same accuracy as the LLM (38/40 each) at 1/79th of the cost",
      "Verdict: not enough proof yet: test more cases",
      "Not proven yet: the lower bound of Jev minus the LLM is -0.11, below the -0.10 margin, on 40 paired cases. If the next cases split the same way, about 6 more paired cases would bring it inside the margin.",
    ]);
  });

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
    expect(rehearsal?.labelledPaired).toBe(5);
    expect(rehearsal?.labels).toBe("human_reviewed, blind: no");
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
  test("[integration] S6 an extra unlabelled dear LLM row cannot inflate a paired headline", async () => {
    const root = fixture(() => {});
    const file = join(root, "docs/product/runs/2026-01-01-fixture/records.csv");
    const { header, rows } = readDictRows(readFileSync(file, "utf8"));
    const head = header ?? [];
    const extra = [...(rows.find((r) => r.fields[head.indexOf("answerer")] === "llm")?.fields ?? [])];
    extra[head.indexOf("case_id")] = "m41";
    extra[head.indexOf("label")] = "";
    extra[head.indexOf("label_source")] = "";
    extra[head.indexOf("label_blind")] = "";
    extra[head.indexOf("labelled_by")] = "";
    extra[head.indexOf("labelled_at")] = "";
    extra[head.indexOf("cost_usd")] = "10";
    writeFileSync(file, formatRows([head, ...rows.map((r) => r.fields), extra]));
    expect((await summariseRun(root, "2026-01-01-fixture"))?.headline).toBe("Same accuracy as the LLM (38/40 each) at 1/79th of the cost");
    const dear = fixture((cell, set) => { if (cell("answerer") === "jev") set("cost_usd", "0.01"); });
    const dearFile = join(dear, "docs/product/runs/2026-01-01-fixture/records.csv");
    const dearRows = readDictRows(readFileSync(dearFile, "utf8"));
    writeFileSync(dearFile, formatRows([dearRows.header ?? [], ...dearRows.rows.map((r) => r.fields), extra]));
    expect((await summariseRun(dear, "2026-01-01-fixture"))?.headline).toBeNull();
  });
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

describe("fit checks", () => {
  test("[unit] a use-case doc with no bold fit check stops generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "posters-fit-"));
    mkdirSync(join(root, "docs/product/use-cases"), { recursive: true });
    mkdirSync(join(root, "site"), { recursive: true });
    writeFileSync(join(root, "docs/product/use-cases/uc99-x.md"), "# UC99: X\n\n**User story:** As a builder.\n\n## Jev or not\nNo verdict here.\n");
    expect(buildPosters(root)).rejects.toThrow("no fit check found");
  });
});

describe("watch links", () => {
  test("[unit] a run shown only by the data-driven replay page links to replay/?run=<key>", async () => {
    const built = await buildPosters(ROOT);
    expect(built.find((p) => p.id === "uc11")?.watch).toBe("replay/?run=tokenmax");
    expect(committed.posters.find((p) => p.id === "uc11")?.watch).toBe("replay/?run=tokenmax");
  });

  test("[unit] a run named by a site page keeps that page", async () => {
    const built = await buildPosters(ROOT);
    expect(built.find((p) => p.id === "uc13")?.watch).toBe("little-shop/");
    expect(watchPage(ROOT, "2026-10-01-uc13-shop-bot")).toBe("little-shop/");
  });

  test("[unit] a run folder no page names and no replay source holds has no watch link", () => {
    const root = mkdtempSync(join(tmpdir(), "posters-watch-"));
    mkdirSync(join(root, "site", "other"), { recursive: true });
    writeFileSync(join(root, "site", "other", "index.html"), "<p>nothing here</p>");
    expect(watchPage(root, "2026-01-01-nowhere")).toBeNull();
    expect(watchPage(ROOT, "2026-01-01-nowhere")).toBeNull();
  });
});
