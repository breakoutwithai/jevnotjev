/**
 * Inspect a run export: bun scripts/inspect-export.ts <file>
 * Prints what the export holds and every problem found; exits 0 when it checks ok, 1 otherwise.
 * The check's contract is the header of src/backstage/export-check.ts.
 */
import { readFileSync } from "node:fs";
import { CALC_VERSION } from "../src/backstage/contracts.ts";
import { checkExportText } from "../src/backstage/export-check.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/inspect-export.ts <file>");
  process.exit(1);
}
const result = await checkExportText(readFileSync(file, "utf8"));
const spend = result.totalSpend;
console.log("Checks reproducibility and credentials; not proof the file came from a real run.");
// The export's calcVersion is untrusted text: print it only when it is this build's.
const calc = result.calcVersion === null ? "(missing)" : result.calcVersion === CALC_VERSION ? CALC_VERSION : `(differs from ${CALC_VERSION})`;
console.log(`calcVersion: ${calc}`);
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
