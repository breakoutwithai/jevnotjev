// FLOW.md "Metrics and where each number comes from": a metric is only "shown" where code shows it (D03).
// Every file:line the table cites must exist and hold the thing the row says, and the rows the audit found missing are present.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderResultView } from "../../scripts/result-view.ts";

const ROOT = join(import.meta.dir, "..", "..");
const flow = readFileSync(join(ROOT, "FLOW.md"), "utf8");

function metricRows(): { readonly metric: string; readonly source: string; readonly where: string }[] {
  const lines = flow.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## Metrics and where each number comes from"));
  if (start < 0) throw new Error("FLOW.md has no metrics section");
  const rows: { metric: string; source: string; where: string }[] = [];
  for (const line of lines.slice(start + 3)) {
    if (!line.startsWith("|")) break;
    const [metric = "", source = "", where = ""] = line.split("|").slice(1, -1).map((cell) => cell.trim());
    rows.push({ metric, source, where });
  }
  return rows;
}

function linesOf(path: string): string[] {
  return readFileSync(join(ROOT, path), "utf8").split("\n");
}

describe("FLOW.md metric table", () => {
  const rows = metricRows();

  test("[unit] D03 the table has the three columns and the rows the audit found missing", () => {
    expect(flow).toContain("| Metric | Input source | Shown or recorded only");
    const names = rows.map((row) => row.metric);
    for (const wanted of ["Failed-attempt spend", "Total attempts", "Unlabelled", "Excluded", "Latency", "Labelling time"]) {
      expect(names).toContain(wanted);
    }
    expect(rows.every((row) => row.where.length > 0)).toBe(true);
  });

  test("[unit] D03 latency is recorded, not shown, and labelling time is not recorded", () => {
    const latency = rows.find((row) => row.metric === "Latency");
    const labelling = rows.find((row) => row.metric === "Labelling time");
    expect(latency?.where).toContain("shown nowhere");
    expect(latency?.where).not.toMatch(/\bshown\)/);
    expect(labelling?.where).toContain("Not recorded, not shown");
    expect(flow).not.toContain("Label source and labelling time");
  });

  test("[unit] D03 every file:line the table cites exists", () => {
    const cites = rows.flatMap((row) => [...`${row.source} ${row.where}`.matchAll(/((?:src|scripts|format)\/[\w./-]+?\.(?:ts|md)):(\d+)(?:-(\d+))?/g)]);
    expect(cites.length).toBeGreaterThan(20);
    for (const [whole, path = "", from = "", to] of cites) {
      const total = linesOf(path).length;
      expect({ whole, ok: Number(to ?? from) <= total && Number(from) >= 1 }).toEqual({ whole, ok: true });
    }
  });

  test.each<[string, string, number, string]>([
    ["Backstage spend per arm", "src/backstage/main.ts", 606, "Answers-only spend"],
    ["Backstage kept", "src/backstage/main.ts", 604, "Kept / labelled"],
    ["Backstage cost per kept", "src/backstage/main.ts", 607, "Cost / kept"],
    ["Backstage unlabelled", "src/backstage/main.ts", 605, "Unlabelled"],
    ["Backstage failed attempts", "src/backstage/main.ts", 539, "Failed attempts:"],
    ["Backstage total attempts", "src/backstage/main.ts", 589, "Total actual attempts"],
    ["Backstage excluded", "src/backstage/main.ts", 626, "excluded. Jev-only wins"],
    ["Backstage confidence", "src/backstage/main.ts", 376, "Returned confidence"],
    ["latency recorded", "src/backstage/run.ts", 1397, "latency_ms"],
    ["tokens recorded", "src/backstage/run.ts", 1394, "tokens_in"],
    ["label source recorded", "src/backstage/run.ts", 1393, "label_source"],
    ["failed-attempt spend", "src/backstage/run.ts", 1522, "extraSpend()"],
    ["total spend", "src/backstage/run.ts", 1533, "totalSpend()"],
    ["result view spend", "scripts/result-view.ts", 151, "Spend"],
    ["result view accepted", "scripts/result-view.ts", 148, "Accepted"],
    ["result view cost per accepted", "scripts/result-view.ts", 152, "Cost per accepted result"],
    ["result view case cost", "src/core/case-table.ts", 35, "cost missing"],
    ["result view numbers table", "scripts/result-view.ts", 211, "function numbersTable"],
    ["result view limitations", "scripts/result-view.ts", 257, "limitations"],
    ["metrics wins", "src/core/metrics.ts", 66, "Jev wins"],
    ["metrics excluded", "src/core/metrics.ts", 58, "excluded"],
    ["metrics unlabelled", "src/core/metrics.ts", 37, "unlabelled"],
  ])("[unit] D03 %s: the cited line holds its subject", (_name, path, line, text) => {
    expect(linesOf(path)[line - 1]).toContain(text);
    // And FLOW.md cites it: some range for this file covers the line.
    const covered = rows
      .flatMap((row) => [...`${row.source} ${row.where}`.matchAll(/((?:src|scripts|format)\/[\w./-]+?\.(?:ts|md)):(\d+)(?:-(\d+))?/g)])
      .some(([, cited = "", from = "", to]) => cited === path && Number(from) <= line && line <= Number(to ?? from));
    expect({ path, line, covered }).toEqual({ path, line, covered: true });
  });

  test("[unit] D03 the rendered result view shows no latency and no labelling time", async () => {
    for (const source of ["examples/d06-tiny/records.csv", "examples/d12-three-methods/records.csv"]) {
      const page = await renderResultView(readFileSync(join(ROOT, source), "utf8"), source);
      const shown = page
        .replace(/<style>[\s\S]*?<\/style>/g, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]*>/g, " ");
      // Positive control: the visible text is the page's content, not an empty string.
      expect(shown).toContain("Cost per accepted result");
      expect(shown).toContain("Gaps");
      expect({ source, latency: /latency/i.test(shown), labelling: /labell?ing time/i.test(shown) }).toEqual({ source, latency: false, labelling: false });
    }
  });

  // The Backstage side is rendered, not read from source: "the rendered Backstage run shows failed-attempt spend and no
  // latency or labelling time" in src/backstage/main.dom.test.ts.
});
