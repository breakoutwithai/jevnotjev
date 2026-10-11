/**
 * Inspect a run export: bun scripts/inspect-export.ts <file>
 * Prints what the export holds and every problem found; exits 0 when it checks ok, 1 otherwise.
 */
import { readFileSync } from "node:fs";
import { checkExportText } from "../src/backstage/export-check.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/inspect-export.ts <file>");
  process.exit(1);
}
const result = await checkExportText(readFileSync(file, "utf8"));
const spend = result.totalSpend;
console.log(`calcVersion: ${result.calcVersion ?? "(missing)"}`);
console.log(`cases: ${result.cases}`);
console.log(`labels: ${result.labels}`);
console.log(`totalSpend: ${spend ? `$${spend.knownUsd.toFixed(4)} known, ${spend.unknown} unknown` : "(missing)"}`);
for (const v of result.verdicts)
  console.log(
    `verdict ${v.armId}: recomputed ${v.recomputed ?? "none"}, exported ${v.exported ?? "none"}, ${v.matches ? "match" : "MISMATCH"}`,
  );
console.log(`problems: ${result.problems.length}`);
for (const p of result.problems) console.log(`  - ${p}`);
console.log(result.ok ? "OK" : "NOT OK");
process.exit(result.ok ? 0 : 1);
