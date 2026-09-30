// Parity check: the Python validator, loader and exporter (checked out from a git ref by parity.sh)
// against the TypeScript port, on the repo fixtures and the fixtures PR 15's tests built.
// Every comparison is on real command output: stdout, stderr and exit code. Run it via scripts/parity.sh.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRow, formatRows, readRecords } from "../src/format/csv.ts";
import { connect } from "../src/db/connect.ts";

interface Args {
  python: string;
  pythonRoot: string;
  work: string;
  admin: string;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i] ?? "";
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined) throw new Error(`bad argument ${key}`);
    values.set(key.slice(2), value);
  }
  const get = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`missing --${key}`);
    return value;
  };
  return { python: get("python"), pythonRoot: get("python-root"), work: get("work"), admin: get("admin") };
}

const args = parseArgs(Bun.argv.slice(2));
const ROOT = join(import.meta.dir, "..");
const EXAMPLE = join(ROOT, "format", "example-v1.csv");
const D06 = join(ROOT, "examples", "d06-tiny", "records.csv");
const FIXTURES = join(args.work, "fixtures");
mkdirSync(FIXTURES, { recursive: true });

type Purpose = "records" | "labels";

interface Fixture {
  readonly name: string;
  readonly path: string;
  readonly purpose: Purpose;
  /** Loaded first, as records, with the same implementation. */
  readonly base?: string;
}

// ---------------------------------------------------------------- fixtures

const fixtures: Fixture[] = [];
const exampleText = await Bun.file(EXAMPLE).text();
const [exampleHeaderRecord, ...exampleRecords] = readRecords(exampleText);
const HEADER = [...(exampleHeaderRecord?.fields ?? [])];
const index = (name: string): number => {
  const found = HEADER.indexOf(name);
  if (found < 0) throw new Error(`no column ${name}`);
  return found;
};
const exampleRows = (): string[][] => exampleRecords.map((record) => [...record.fields]);

function add(name: string, text: string, purpose: Purpose = "records", base?: string): void {
  const path = join(FIXTURES, `${String(fixtures.length + 1).padStart(2, "0")}-${name}.csv`);
  writeFileSync(path, text, "utf8");
  fixtures.push(base === undefined ? { name, path, purpose } : { name, path, purpose, base });
}

function addRows(name: string, change: (rows: string[][]) => string[][] | void, purpose: Purpose = "records", base?: string): void {
  const rows = exampleRows();
  const changed = change(rows) ?? rows;
  add(name, formatRow(HEADER) + formatRows(changed), purpose, base);
}

function set(rows: string[][], row: number, column: string, value: string): void {
  const target = rows.at(row);
  if (target === undefined) throw new Error(`no row ${row}`);
  target[index(column)] = value;
}

function setAll(rows: string[][], column: string, value: string): void {
  for (const row of rows) row[index(column)] = value;
}

// the repo fixtures, as they are
const copy = (name: string, source: string): void => {
  const path = join(FIXTURES, `${String(fixtures.length + 1).padStart(2, "0")}-${name}.csv`);
  copyFileSync(source, path);
  fixtures.push({ name, path, purpose: "records" });
};
copy("example-v1", EXAMPLE);
copy("d06-tiny", D06);

// format/test_validate.py cases
addRows("output-maybe", (r) => set(r, 0, "output", "maybe"));
addRows("answerer-robot", (r) => set(r, 0, "answerer", "robot"));
addRows("label-without-source", (r) => set(r, 0, "label_source", ""));
addRows("confidence-1.5", (r) => set(r, 0, "confidence", "1.5"));
addRows("cost-about-a-cent", (r) => set(r, 0, "cost_usd", "about a cent"));
addRows("question-reworded", (r) => set(r, 3, "question", "Does this message want money back?"));
addRows("question-reworded-new-version", (r) => {
  set(r, 3, "question", "Does this message want money back?");
  set(r, 3, "prompt_version", "refund-q.v2");
});
addRows("duplicate-row", (r) => [...r, [...(r[0] ?? [])]]);
addRows("case-input-differs", (r) => set(r, 3, "case_input", "something else"));
addRows("format-version-2", (r) => set(r, 0, "format_version", "jnj-record/2"));
add("missing-label-column", (() => {
  const keep = HEADER.map((_, i) => i).filter((i) => i !== index("label"));
  return formatRow(keep.map((i) => HEADER[i] ?? "")) + formatRows(exampleRows().map((row) => keep.map((i) => row[i] ?? "")));
})());
add("empty-file", formatRow(HEADER, "\r\n"));
const oddNumbers: [string, string][] = [["confidence", "nan"], ["cost_usd", "nan"], ["cost_usd", "inf"], ["tokens_in", "4_2"]];
for (const [column, value] of oddNumbers) {
  addRows(`${column}-${value}`, (r) => set(r, 0, column, value));
}
addRows("padded-label", (r) => set(r, 0, "label", " accept "));
const [headerLine = "", firstLine = ""] = exampleText.split(/\r?\n/);
add("short-row", `${headerLine}\n${firstLine.split(",").slice(0, -4).join(",")}\n`);
add("extra-cells", `${headerLine}\n${firstLine},junk,junk\n`);
add("duplicate-header", `${headerLine},run_id\n${firstLine},run-002\n`);

// reading edge cases the Python csv module and repr() decide
add("bom-header", "﻿" + exampleText);
add("crlf-and-blank-lines", exampleText.replaceAll("\n", "\r\n").replace("\r\n", "\r\n\r\n\r\n"));
addRows("quoted-newline-in-case", (r) => {
  for (const row of r) if (row[index("case_id")] === "m01") row[index("case_input")] = "line one\nline two, \"quoted\"";
});
add("unterminated-quote", exampleText + '"unterminated,x');
addRows("unicode-in-output", (r) => set(r, 0, "output", "é​﻿\u{1F600}\u007f it's"));
addRows("confidence-1e16", (r) => set(r, 0, "confidence", "1e16"));
addRows("tokens-trailing-newline", (r) => set(r, 0, "tokens_in", "42\n"));
addRows("long-case-input", (r) => set(r, 0, "case_input", "x".repeat(8001)));

// db/tests (PR 15) cases
addRows("invalid-confidence-last-row", (r) => set(r, -1, "confidence", "1.5"));
const dbCells: [string, string][] = [
  ["confidence", "1e-400"],
  ["tokens_in", "3000000000"],
  ["tokens_in", "9223372036854775807"],
  ["cost_usd", "1e-400"],
  ["cost_usd", "00042"],
  ["tokens_in", "9223372036854775808"],
  ["latency_ms", "1" + "0".repeat(30)],
  ["cost_usd", "1e-16384"],
  ["confidence", "0e-99999"],
  ["confidence", "1.00000000000000000001"],
];
for (const [column, value] of dbCells) {
  addRows(`db-${column}-${value.slice(0, 24)}`, (r) => set(r, 0, column, value));
}
addRows("db-run-id-line-break", (r) => setAll(r, "run_id", "run-001\n"));
const answerSets: [string, string, string][] = [
  ["answer-set-yes-no", "run-1", "yes|no"],
  ["answer-set-duplicate", "run-1", "yes|yes|no"],
];
for (const [name, runId, answerSet] of answerSets) {
  addRows(name, (r) => {
    setAll(r, "run_id", runId);
    setAll(r, "answer_set", answerSet);
  });
}
const answerSetBase = fixtures.find((fixture) => fixture.name === "answer-set-yes-no")?.path;
for (const changed of ["no|yes", "yes|no|maybe"]) {
  addRows(`answer-set-changed-${changed.replaceAll("|", "-")}`, (r) => {
    setAll(r, "run_id", "run-2");
    setAll(r, "answer_set", changed);
  }, "records", answerSetBase);
}
addRows("labels-fill-missing", (r) => {
  set(r, 7, "label", "reject");
  set(r, 7, "label_source", "human");
}, "labels", EXAMPLE);
addRows("labels-change-existing", (r) => {
  set(r, 7, "label", "reject");
  set(r, 7, "label_source", "human");
  set(r, 0, "label", "reject");
}, "labels", EXAMPLE);
addRows("labels-row-not-loaded", (r) => {
  set(r, 7, "output", "yes");
  set(r, 7, "label", "reject");
  set(r, 7, "label_source", "human");
}, "labels", EXAMPLE);
addRows("reworded-rolls-back", (r) => {
  setAll(r, "run_id", "run-002");
  setAll(r, "prompt_version", "refund-q.v2");
  set(r, -1, "prompt_version", "refund-q.v1");
  set(r, -1, "question", "Is this a refund request?");
}, "records", EXAMPLE);
addRows("other-file-same-run", (r) => setAll(r, "prompt_version", "refund-q.v2"), "records", EXAMPLE);
addRows("run-000-reversed", (r) => {
  setAll(r, "run_id", "run-000");
  return [...r].reverse();
}, "records", EXAMPLE);
addRows("run-009-shares-case-id", (r) => {
  setAll(r, "run_id", "run-009");
  for (const row of r) if (row[index("case_id")] === "m01") row[index("case_input")] = "A different message with the same case_id.";
}, "records", EXAMPLE);

// the planted secrets of review r1 (N2, O7)
const SECRET_QUESTION = "Q-SECRET: is this person asking for money back?";
const SECRET_CASE = "CASE-SECRET kettle arrived broken";
const secret = (r: string[][]): void => {
  setAll(r, "question", SECRET_QUESTION);
  for (const row of r) row[index("case_input")] = `${SECRET_CASE} ${row[index("case_id")] ?? ""}`;
};
addRows("secret-rows", secret);
const secretBase = fixtures.at(-1)?.path;
addRows("secret-reworded", (r) => {
  secret(r);
  setAll(r, "run_id", "run-002");
  setAll(r, "question", `${SECRET_QUESTION} (reworded)`);
}, "records", secretBase);
addRows("secret-other-file-same-run", (r) => {
  secret(r);
  setAll(r, "prompt_version", "refund-q.v2");
}, "records", secretBase);
addRows("secret-overlong-case", (r) => {
  secret(r);
  for (const row of r) if (row[index("case_id")] === "m02") row[index("case_input")] = SECRET_CASE + " x".repeat(5000);
}, "records", secretBase);
addRows("secret-empty-question", (r) => {
  secret(r);
  setAll(r, "question", "");
}, "records", secretBase);
addRows("secret-relabel", (r) => {
  secret(r);
  set(r, 0, "label", "reject");
}, "labels", secretBase);

// ---------------------------------------------------------------- runners

interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

let dsn = "";

async function run(command: readonly string[]): Promise<Outcome> {
  const child = Bun.spawn([...command], {
    cwd: ROOT,
    env: { ...process.env, JNJ_DATABASE_URL: dsn },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

const py = (script: string, ...rest: string[]): Promise<Outcome> => run([args.python, join(args.pythonRoot, script), ...rest]);
const ts = (script: string, ...rest: string[]): Promise<Outcome> => run(["bun", join(ROOT, script), ...rest]);

let comparisons = 0;
const failures: string[] = [];

function firstDifference(left: string, right: string): string {
  const a = left.split("\n");
  const b = right.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}:\n    python: ${JSON.stringify(a[i] ?? "<none>").slice(0, 200)}\n    ts:     ${JSON.stringify(b[i] ?? "<none>").slice(0, 200)}`;
  }
  return "";
}

function compare(label: string, python: Outcome, typescript: Outcome): void {
  comparisons += 1;
  const keys: (keyof Outcome)[] = ["code", "stdout", "stderr"];
  for (const key of keys) {
    const left = String(python[key]);
    const right = String(typescript[key]);
    if (left !== right) failures.push(`DIFF ${label} ${key} ${firstDifference(left, right)}`);
  }
}

/** Every run_id the fixture (and its base) names, plus one that does not exist. */
async function runIds(paths: readonly string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const path of paths) {
    const [header, ...rows] = readRecords(await Bun.file(path).text());
    const column = header?.fields.indexOf("run_id") ?? -1;
    if (column < 0) continue;
    for (const row of rows) {
      const id = row.fields[column] ?? "";
      if (id !== "") ids.add(id);
    }
  }
  return [...ids, "nope"];
}

// ---------------------------------------------------------------- database

const admin = connect(args.admin, { max: 1 });
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const loadDb = `jnj_parity_${suffix}`;
const pyDb = `jnj_parity_py_${suffix}`;
const withDb = (name: string): string =>
  /^postgres(ql)?:\/\//.test(args.admin) ? Object.assign(new URL(args.admin), { pathname: `/${name}` }).toString() : `${args.admin} dbname=${name}`;

async function main(): Promise<number> {
  console.log(`parity: ${fixtures.length} fixtures`);
  if (fixtures.length === 0) {
    console.log("parity: FAIL, no fixtures");
    return 1;
  }

  // migrations: each implementation on its own fresh database, then each on the other's
  await admin.unsafe(`create database "${loadDb}"`);
  await admin.unsafe(`create database "${pyDb}"`);
  dsn = withDb(loadDb);
  const tsFirst = await ts("src/db/migrate-cli.ts");
  dsn = withDb(pyDb);
  const pyFirst = await py("db/migrate.py");
  compare("migrate fresh", pyFirst, tsFirst);
  const tsAgain = await ts("src/db/migrate-cli.ts");
  dsn = withDb(loadDb);
  const pyAgain = await py("db/migrate.py");
  compare("migrate up to date", pyAgain, tsAgain);
  const ledger = async (name: string): Promise<string> => {
    const sql = connect(withDb(name), { max: 1 });
    try {
      const rows = await sql`select number, name, sha256 from public.jnj_schema_migration order by number`;
      return rows.map((row) => `${row["number"]} ${row["name"]} ${row["sha256"]}`).join("\n");
    } finally {
      await sql.end();
    }
  };
  compare("migration ledger", { stdout: await ledger(pyDb), stderr: "", code: 0 }, { stdout: await ledger(loadDb), stderr: "", code: 0 });

  const db = connect(withDb(loadDb), { max: 1 });
  try {
    for (const [n, fixture] of fixtures.entries()) {
      const label = fixture.name;
      const tsValidate = await ts("src/format/cli.ts", fixture.path);
      compare(`${label} validate`, await py("format/validate.py", fixture.path), tsValidate);
      const verdict = tsValidate.stdout.trimEnd().split("\n").at(-1)?.split(" ")[0] ?? "";
      let loaded = "";
      const exportRuns = await runIds(fixture.base === undefined ? [fixture.path] : [fixture.base, fixture.path]);
      for (const policy of ["synthetic", "restricted"]) {
        const pySlug = `p-${n}-${policy[0]}`;
        const tsSlug = `t-${n}-${policy[0]}`;
        await db`insert into jnj.workspace (slug, content_policy) values (${pySlug}, ${policy}), (${tsSlug}, ${policy})`;
        const labelsFlag = fixture.purpose === "labels" ? ["--labels"] : [];
        if (fixture.base !== undefined) {
          compare(`${label} ${policy} base load`, await py("db/load.py", pySlug, fixture.base), await ts("src/db/load-cli.ts", tsSlug, fixture.base));
        }
        const tsLoad = await ts("src/db/load-cli.ts", ...labelsFlag, tsSlug, fixture.path);
        compare(`${label} ${policy} load`, await py("db/load.py", ...labelsFlag, pySlug, fixture.path), tsLoad);
        if (policy === "synthetic") loaded = (tsLoad.stdout || tsLoad.stderr).split("\n")[0]?.slice(0, 60) ?? "";
        const files = async (slug: string): Promise<string> => {
          const rows = await db`
            select f.purpose, f.file_sha256, f.original_name, f.original_name_sha256, f.original_name_length
            from jnj.import_file f join jnj.workspace w on w.id = f.workspace_id where w.slug = ${slug} order by f.id`;
          return rows.map((row) => Object.values(row).map(String).join(" ")).join("\n");
        };
        compare(`${label} ${policy} import_file rows`, { stdout: await files(pySlug), stderr: "", code: 0 }, { stdout: await files(tsSlug), stderr: "", code: 0 });
        for (const runId of exportRuns) {
          const pyExport = await py("db/export.py", pySlug, "--run", runId);
          compare(`${label} ${policy} export ${runId} (same workspace)`, pyExport, await ts("src/db/export-cli.ts", pySlug, "--run", runId));
          const tsExport = await ts("src/db/export-cli.ts", tsSlug, "--run", runId);
          compare(`${label} ${policy} export ${runId} (loaded by each)`, pyExport, {
            ...tsExport,
            stderr: tsExport.stderr.replaceAll(tsSlug, pySlug),
          });
        }
      }
      const mine = failures.filter((failure) => failure.startsWith(`DIFF ${label} `)).length;
      console.log(`${mine === 0 ? "ok  " : "FAIL"} ${String(n + 1).padStart(2, "0")} ${label.padEnd(34)} ${verdict.padEnd(7)} | ${loaded}`);
    }
  } finally {
    await db.end();
  }
  for (const failure of failures) console.log(failure);
  console.log(`parity: ${fixtures.length} fixtures, ${comparisons} comparisons, ${failures.length} differences`);
  return failures.length === 0 && comparisons > 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} finally {
  await admin.unsafe(`drop database if exists "${loadDb}" with (force)`);
  await admin.unsafe(`drop database if exists "${pyDb}" with (force)`);
  await admin.end();
}
process.exit(code);
