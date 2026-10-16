import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, scanRunNote } from "./scan-run-note";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./scan-run-note.ts", import.meta.url));
const TEMPLATE_PATH = join(ROOT, "docs/uat/run-note-template.md");
const CHECKLIST_PATH = join(ROOT, "docs/uat/tester-checklist.md");

// Secret-shaped fixtures are built at run time so no key-shaped literal sits in the repo.
const rep = (s: string, n: number): string => s.repeat(n);
const ANTHROPIC = "sk-ant-" + rep("ab1c", 10);
const VENDOR_KEYS: readonly { readonly value: string; readonly name: string }[] = [
  { value: ANTHROPIC, name: "looks like a Anthropic key (sk-ant-)" },
  { value: "sk-proj-" + rep("ab1c", 10), name: "looks like a OpenAI project key (sk-proj-)" },
  { value: "sk-" + rep("ab1c", 10), name: "looks like a OpenAI key (sk-)" },
  { value: "xai-" + rep("ab1c", 10), name: "looks like a xAI key (xai-)" },
  { value: "AIza" + rep("ab1c", 8) + "ab1", name: "looks like a Google key (AIza)" },
  { value: "ghp_" + rep("ab1c", 9), name: "looks like a GitHub token" },
  { value: "Bearer " + rep("ab1c", 6), name: "looks like a Bearer token" },
];
const TYPESAFE_SHAPE = "Kf3Vn9Qw2Lp7Xb5Tz1Rm8Cd4Hj6";
const JWT_PARTS: readonly string[] = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ",
  "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
];

/** "line:kind" for every finding, so a table row asserts exact line numbers and kinds. */
function got(text: string): string[] {
  return scanRunNote(text).map((f) => `${f.line}:${f.kind}`);
}
const asRead = (text: string) => (): string => text;
const refuse = (): string => {
  throw new Error("ENOENT");
};

describe("credential", () => {
  // Kills: dropping findCredentials (or copying only some of its patterns): every shape must carry findCredentials' own name.
  for (const { value, name } of VENDOR_KEYS) {
    test(`[unit] vendor key in a backticked table cell is flagged: ${name}`, () => {
      expect(scanRunNote(`| 3 | \`${value}\` | worked |`)).toEqual([{ line: 1, kind: "credential", name }]);
    });
  }

  // Kills: a keyword rule that misses a spelling, a separator, or case-insensitivity.
  const ASSIGNED = [
    "password: hunter2hunter",
    "API key = 9f8aQ7...",
    'token: "abc12345xyz"',
    "secret=s3cr3t-value",
    "api_key: ab1cd2ef3",
    "api-key=ab1cd2ef3",
    "apikey: ab1cd2ef3",
    "passwd: ab1cd2ef3",
    "Authorization: ab1cd2ef3",
    "PASSWORD: ab1cd2ef3",
  ];
  for (const line of ASSIGNED) {
    test(`[unit] keyword assignment is flagged: ${line}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "credential", name: "credential assignment" }]);
    });
  }

  // Kills: a keyword rule that flags placeholders or short prose values.
  const PLACEHOLDERS = [
    "API key: <value>",
    "password: [redacted]",
    "token: ***",
    "API key: pasted, worked",
    "Token count: 12",
    "API key: entered",
    "password: none",
    "token: n/a",
    "**API key:** <value>",
  ];
  for (const line of PLACEHOLDERS) {
    test(`[unit] placeholder or prose after a keyword is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }

  // Kills: a label rule that misses env, snake_case, JSON or Markdown forms, or that trusts a value because it is all letters or short.
  const LABELLED = [
    "OPENAI_API_KEY=abc123def456ghi789",
    'export TYPESAFE_API_KEY="abc123def456ghi789"',
    '{"api_key": "abc123def456ghi789"}',
    '{"api_key":"1234567890abcdef"}',
    '"password": "hunter2hunter"',
    "access_token=abc123def456ghi789",
    "client_secret: abc123def456ghi789",
    "SECRET_KEY=abc123def456ghi789",
    "**API key:** 1234567890abcdef",
    "password: **hunter2hunter**",
    "password: abc123",
    "password: correcthorsebatterystaple",
    "password: letmeinplease",
    "token: 12345",
  ];
  for (const line of LABELLED) {
    test(`[unit] labelled value is flagged: ${line}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "credential", name: "credential assignment" }]);
    });
  }

  // Kills: a label rule that fires inside a longer word, or that flags a status word or a value under 4 characters.
  for (const line of ["tokens: abcdefgh", "apikeys: abcdefgh", "password: ok", "password: set", "token: no", "secret: Missing", "password: xxxxxxxx"]) {
    test(`[unit] longer word, status word or short value is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }

  // Kills: dropping the unknown-vendor mixed-case rule.
  test("[unit] an unknown vendor key shape is flagged", () => {
    expect(scanRunNote(`key was ${TYPESAFE_SHAPE} here`)).toEqual([{ line: 1, kind: "credential", name: "long mixed-case token" }]);
  });

  // Kills: a token rule that drops the upper+lower+digit requirement or moves the 24-character floor.
  const MIXED = (n: number): string => ("Ab1" + rep("c", n)).slice(0, n);
  for (const line of ["AbCdEfGhIjKlMnOpQrStUvWxYz", "ABCDEF0123456789ABCDEF0123", MIXED(23)]) {
    test(`[unit] token without all three classes or under 24 characters is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }
  test("[unit] a 24-character upper+lower+digit token is flagged", () => {
    expect(MIXED(24)).toHaveLength(24);
    expect(got(MIXED(24))).toEqual(["1:credential"]);
  });

  // Kills: requiring the whole JWT as one token (dots split it), or missing a part.
  test("[unit] each part of a JWT is flagged", () => {
    for (const part of JWT_PARTS) expect(got(part)).toEqual(["1:credential"]);
    expect(got(JWT_PARTS.join("."))).toEqual(["1:credential"]);
  });

  // Kills: a token rule without the upper+lower+digit requirement or without a boundary.
  const NOT_KEYS = [
    "f0cc7791ab34de56f0123456789abcde01234567",
    "1bb6ee2",
    // A lowercase UUID, joined at run time so repository scans for literal UUIDs stay quiet.
    ["123e4567", "e89b", "12d3", "a456", "426614174000"].join("-"),
    "feat/d22-live-run-note",
    "https://github.com/breakoutwithai/jevnotjev/pull/225",
    "a-long-all-lowercase-and-hyphen-slug-for-a-feature-branch-name",
  ];
  for (const line of NOT_KEYS) {
    test(`[unit] SHA, UUID, branch, URL or slug is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }

  // Kills: reporting the same kind twice on one line.
  test("[unit] two credentials on one line give one finding", () => {
    expect(got(`${ANTHROPIC} and ${TYPESAFE_SHAPE}`)).toEqual(["1:credential"]);
  });
});

describe("email", () => {
  // Kills: a regex that misses plus-tags, uppercase, brackets, mailto: or inline code.
  const FLAGGED = [
    "jane.doe+test@gmail.com",
    "JANE@Company.CO.UK",
    "<a@b.io>",
    "mailto:x@y.com",
    "[me](mailto:me@corp.net)",
    "`a@b.dev`",
    "other@breakoutwithai.com",
    "foo!jev@breakoutwithai.com",
  ];
  for (const line of FLAGGED) {
    test(`[unit] email is flagged: ${line}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "email", name: "email address" }]);
    });
  }

  // Kills: ignoring the at/dot obfuscation forms.
  for (const line of ["jane [at] gmail [dot] com", "jane(at)gmail.com", "jane{at}gmail.com"]) {
    test(`[unit] obfuscated email is flagged: ${line}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "email", name: "obfuscated email address" }]);
    });
  }

  // Kills: flagging reserved sample domains, or the published contact in any case.
  const ALLOWED = [
    "tester@example.com",
    "x@example.org",
    "x@example.net",
    "a@foo.example",
    "a@b.test",
    "a@b.invalid",
    "a@b.localhost",
    "jev@breakoutwithai.com",
    "JEV@BreakoutWithAI.com",
    "tester@sub.example.com",
    "tester [at] example [dot] com",
    "jev [at] breakoutwithai [dot] com",
  ];
  for (const line of ALLOWED) {
    test(`[unit] reserved or published address is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }

  // Kills: a regex that treats prose, a bare handle, a version pin or a dangling at-sign as an email.
  for (const line of ["look at the guide", "@handle", "npm@10", "user@"]) {
    test(`[unit] non-email text is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }

  // Kills: an allow-list that matches by suffix and lets other@breakoutwithai.com or a real address through beside a sample one.
  test("[unit] an allowed address does not hide a real one on the same line", () => {
    expect(got("jev@breakoutwithai.com and jane@gmail.com")).toEqual(["1:email"]);
  });

  // Kills: a pattern that retries from every position and goes quadratic on long lines.
  for (const [label, text] of [["a x 40000", rep("a", 40000)], ["a@ x 20000", rep("a@", 20000)]] as const) {
    test(`[unit] a long line is scanned in under 200 ms: ${label}`, () => {
      const t0 = performance.now();
      scanRunNote(text);
      expect(performance.now() - t0).toBeLessThan(200);
    });
  }

  // Kills: reporting each address separately.
  test("[unit] two emails on one line give one finding", () => {
    expect(got("a@gmail.com b@gmail.com")).toEqual(["1:email"]);
  });
});

describe("phone", () => {
  // Kills: an international rule that misses separators or the digit-count window.
  const INTERNATIONAL = ["+44 20 7946 0958", "+1 (415) 555-2671", "+33 1 23 45 67 89", "+447700900123", "+44.20.7946.0958", "+44-20-7946-0958"];
  for (const line of INTERNATIONAL) {
    test(`[unit] international number is flagged: ${line}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "phone", name: "phone number" }]);
    });
  }

  // Kills: a national rule that needs a plus sign or the wrong digit count.
  for (const line of ["07700 900123", "020 7946 0958", "07700900123", "01 23 45 67 89", "06 12 34 56 78", "01.23.45.67.89", "0151 23456789", "0176 12345678", "(020) 7946 0958"]) {
    test(`[unit] national number is flagged: ${line}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "phone", name: "phone number" }]);
    });
  }

  // Kills: a NANP rule that misses brackets or a separator.
  for (const line of ["(415) 555-2671", "415-555-2671", "415.555.2671", "415 555 2671", "1-415-555-2671", "1.415.555.2671", "1 415 555 2671", "4155552671"]) {
    test(`[unit] 3-3-4 number is flagged: ${line}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "phone", name: "phone number" }]);
    });
  }

  // Kills: a digit-run rule that reads dates, times, versions, IPs, money, counts or hex as phone numbers.
  const NOT_PHONES = [
    "2026-10-16",
    "2026-10-16 12:30",
    "2026-10-16T12:30:00Z",
    "12:30",
    "1.63.0",
    "178.62.69.200",
    "1,278,617",
    "0.0012345678",
    "$0.0004",
    "30 40 50 60 70",
    "28 / 30",
    "#225",
    "f0cc7791ab34de56f0123456789abcde01234567",
    "0123456789abcdef0123456789abcdef01234567",
    "ab0123456789cd",
    "03-10-2026 12:30",
    "+1 234 567",
    "+1234567",
    "1760572800",
    "012345678",
    "0123456789012",
  ];
  for (const line of NOT_PHONES) {
    test(`[unit] date, time, version, IP, money, count or hex is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }

  // Kills: a plus rule with an upper bound on the digit count, or a lower bound other than 8.
  for (const line of ["Call +44 20 7946 0958 (2026-10-15)", "+1234567890123456", "+12345678"]) {
    test(`[unit] a plus number with 8 or more digits is flagged: ${line}`, () => {
      expect(got(line)).toEqual(["1:phone"]);
    });
  }

  // Kills: a national rule with the wrong digit window (10 to 12 inclusive).
  for (const [line, n] of [["0123456789", 10], ["012345678901", 12]] as const) {
    test(`[unit] a national number of ${n} digits is flagged: ${line}`, () => {
      expect(got(line)).toEqual(["1:phone"]);
    });
  }
});

describe("lines", () => {
  const noteWith = (eol: string): string =>
    ["# Run note", "", "Contact: jane@gmail.com", "ok", "ok", "", "Call +44 20 7946 0958", "ok", ""].join(eol);

  // Kills: 0-based numbering, or a splitter that breaks on CRLF.
  test("[unit] CRLF file: findings are on lines 3 and 7", () => {
    expect(scanRunNote(noteWith("\r\n"))).toEqual([
      { line: 3, kind: "email", name: "email address" },
      { line: 7, kind: "phone", name: "phone number" },
    ]);
  });

  test("[unit] LF file: findings are on lines 3 and 7", () => {
    expect(scanRunNote(noteWith("\n"))).toEqual([
      { line: 3, kind: "email", name: "email address" },
      { line: 7, kind: "phone", name: "phone number" },
    ]);
  });

  // Kills: one finding per line regardless of kind.
  test("[unit] a line with an email and a phone gives two findings", () => {
    expect(scanRunNote("Contact jane@gmail.com or +44 20 7946 0958")).toEqual([
      { line: 1, kind: "email", name: "email address" },
      { line: 1, kind: "phone", name: "phone number" },
    ]);
  });

  // Kills: an unsorted result.
  test("[unit] findings come out in line then kind order", () => {
    expect(got(`+44 20 7946 0958 jane@gmail.com ${ANTHROPIC}\nx\n${ANTHROPIC}`)).toEqual(["1:credential", "1:email", "1:phone", "3:credential"]);
  });
});

describe("template binding", () => {
  interface Step {
    readonly n: number;
    readonly title: string;
  }
  function checklistSteps(md: string): Step[] {
    return [...md.matchAll(/^## Step (\d+): (.+?)\s*$/gm)].map((m) => ({ n: Number(m[1]), title: m[2] ?? "" }));
  }
  function templateSteps(md: string): Step[] {
    return [...md.matchAll(/^\| (\d+) \| (.+?) \|/gm)].map((m) => ({ n: Number(m[1]), title: m[2] ?? "" }));
  }
  /** Empty when the template has one row per checklist step: same count, numbers, titles and order. */
  function stepMismatches(template: string, checklist: string): string[] {
    const want = checklistSteps(checklist);
    const have = templateSteps(template);
    const out: string[] = [];
    if (want.length !== have.length) out.push(`step count: template ${have.length}, checklist ${want.length}`);
    for (let i = 0; i < Math.max(want.length, have.length); i++) {
      const w = want[i];
      const h = have[i];
      if (w === undefined) out.push(`row ${i + 1}: template has step ${h?.n} with no checklist step`);
      else if (h === undefined) out.push(`row ${i + 1}: checklist step ${w.n} "${w.title}" has no template row`);
      else if (w.n !== h.n || w.title !== h.title) out.push(`row ${i + 1}: template "${h.n} ${h.title}", checklist "${w.n} ${w.title}"`);
    }
    return out;
  }

  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const checklist = readFileSync(CHECKLIST_PATH, "utf8");

  // Kills: a vacuous binding (a parser that finds no steps in the real checklist would pass any template).
  test("[unit] the real checklist has the five known steps", () => {
    expect(checklistSteps(checklist)).toEqual([
      { n: 1, title: "Write the decision and judging rule" },
      { n: 2, title: "Add your cases" },
      { n: 3, title: "Run Jev, an LLM and a rule on every case" },
      { n: 4, title: "Review the answers blind" },
      { n: 5, title: "Reach a verdict" },
    ]);
  });

  // Kills: a template that drifts from the checklist (retitled, added, dropped or reordered step).
  test("[unit] the template has one row per real checklist step", () => {
    expect(stepMismatches(template, checklist)).toEqual([]);
  });

  // Kills: a comparison that only checks the template against itself or ignores extra checklist steps.
  test("[unit] a checklist with one extra step reports the mismatch", () => {
    const longer = `${checklist}\n## Step 6: Share the result\n\n- [ ] Send it.\n`;
    expect(stepMismatches(template, longer)).toEqual([
      "step count: template 5, checklist 6",
      'row 6: checklist step 6 "Share the result" has no template row',
    ]);
  });

  // Kills: a comparison that ignores titles.
  test("[unit] a retitled checklist step reports the mismatch", () => {
    const retitled = checklist.replace("## Step 2: Add your cases", "## Step 2: Load your cases");
    expect(stepMismatches(template, retitled)).toEqual([
      'row 2: template "2 Add your cases", checklist "2 Load your cases"',
    ]);
  });

  // Kills: a comparison that ignores order.
  test("[unit] swapped checklist steps report the mismatch", () => {
    const swapped = checklist.replace("## Step 4: Review", "## Step 5: Review").replace("## Step 5: Reach", "## Step 4: Reach");
    expect(stepMismatches(template, swapped)).toEqual([
      'row 4: template "4 Review the answers blind", checklist "5 Review the answers blind"',
      'row 5: template "5 Reach a verdict", checklist "4 Reach a verdict"',
    ]);
  });
});

describe("template content", () => {
  const template = readFileSync(TEMPLATE_PATH, "utf8");

  // Kills: a template that already holds a flagged string.
  test("[unit] the template as committed has no findings", () => {
    expect(scanRunNote(template)).toEqual([]);
  });

  /** The template with a safe sample value typed into every field, row and issue. */
  function filled(): string {
    const values: Record<string, string> = {
      "Date (YYYY-MM-DD)": "2026-10-16",
      "Run by (handle only)": "tester-42",
      "Site and served build (`/DEPLOYED_SHA` value)": "f0cc7791ab34de56f0123456789abcde01234567",
      "Browser and device": "Firefox 1.63.0 on a laptop",
      "Start time": "2026-10-16T12:30:00Z",
      "End time": "2026-10-16 13:45",
      "Sample data used (synthetic only)": "Pack P1, 10 cases, spend $0.0004, 28 / 30 paired, 1,278,617 rows, issue #225, tester@example.com",
      "Comparison name": "Jev vs LLM",
      "Verdict word": "not enough evidence",
      "Reason, as shown": "needs 30 paired labelled cases; reported to jev@breakoutwithai.com",
    };
    let fields = 0;
    let rows = 0;
    let issues = 0;
    const lines = template.split("\n").map((line) => {
      const field = /^- \*\*(.+):\*\*$/.exec(line);
      if (field !== null) {
        const value = values[field[1] ?? ""];
        if (value === undefined) throw new Error(`no sample value for field: ${field[1]}`);
        fields++;
        return `${line} ${value}`;
      }
      if (/^\| \d+ \| .+ \|  \|  \|  \|$/.test(line)) {
        rows++;
        return line.replace(/\|  \|  \|  \|$/, "| Y | Page opened, answer shown | none, see <value> |");
      }
      if (/^1\. Step N:\s*$/.test(line)) {
        issues++;
        return "1. Step 3: retry button missing, see <value>";
      }
      return line;
    });
    expect({ fields, rows, issues }).toEqual({ fields: 10, rows: 5, issues: 1 });
    return lines.join("\n");
  }

  // Kills: a template whose own wording or sample values trip the scan, which no tester could then pass.
  test("[unit] the template filled with safe sample values has no findings", () => {
    const note = filled();
    expect(note).not.toBe(template);
    expect(note).toContain("| 3 | Run Jev, an LLM and a rule on every case | Y | Page opened, answer shown | none, see <value> |");
    expect(scanRunNote(note)).toEqual([]);
  });

  // Kills: a filled note that hides a real value because the scan skips table rows.
  test("[unit] the same filled note with a phone in a row is flagged on that line", () => {
    const note = filled().replace("none, see <value> |", "none, call +44 20 7946 0958 |");
    const lineNo = note.split("\n").findIndex((l) => l.includes("+44 20 7946 0958")) + 1;
    expect(scanRunNote(note)).toEqual([{ line: lineNo, kind: "phone", name: "phone number" }]);
  });
});

describe("cli", () => {
  const DIRTY = [ANTHROPIC, "Contact jane.doe@gmail.com", "Call +44 20 7946 0958", "password: hunter2hunter"].join("\n") + "\n";

  // Kills: a wrong exit code for a clean file, or a changed summary line.
  test("[unit] clean file: code 0 and the summary", () => {
    expect(runCli(["note.md"], asRead("# Note\n\nStep 1 worked.\n"))).toEqual({ code: 0, out: "scan-run-note: 0 findings in 3 lines" });
  });

  // Kills: a wrong exit code for findings, a changed line format, or a wrong line count.
  test("[unit] dirty file: code 1, one line per finding, then the summary", () => {
    expect(runCli(["note.md"], asRead(DIRTY))).toEqual({
      code: 1,
      out: [
        "line 1: credential (looks like a Anthropic key (sk-ant-))",
        "line 2: email (email address)",
        "line 3: phone (phone number)",
        "line 4: credential (credential assignment)",
        "scan-run-note: 4 findings in 4 lines",
      ].join("\n"),
    });
  });

  // Kills: reading the line count from split() with its trailing empty element, or counting CRLF as two lines.
  test("[unit] CRLF note counts its lines once", () => {
    expect(runCli(["note.md"], asRead("a\r\nb\r\njane@gmail.com\r\n")).out).toBe("line 3: email (email address)\nscan-run-note: 1 findings in 3 lines");
  });

  // Kills: usage errors that exit 0/1 or that read a file anyway.
  test("[unit] no argument: code 2", () => {
    expect(runCli([], refuse).code).toBe(2);
  });
  test("[unit] two arguments: code 2", () => {
    expect(runCli(["a.md", "b.md"], asRead("x\n")).code).toBe(2);
  });
  test("[unit] unreadable file: code 2", () => {
    expect(runCli(["missing.md"], refuse).code).toBe(2);
  });
  // Kills: treating an empty note as a clean note.
  test("[unit] blank-only file: code 2", () => {
    expect(runCli(["note.md"], asRead("\n  \r\n\t\n")).code).toBe(2);
  });
  test("[unit] empty file: code 2", () => {
    expect(runCli(["note.md"], asRead("")).code).toBe(2);
  });

  // Kills: echoing the matched text, per kind (a finding line that quotes its match is a leak into the very note being cleaned).
  const SECRETS: readonly { readonly kind: string; readonly text: string; readonly parts: readonly string[] }[] = [
    { kind: "credential (vendor key)", text: `key ${ANTHROPIC}`, parts: [ANTHROPIC, "ab1cab1c"] },
    { kind: "credential (assignment)", text: "password: hunter2hunter", parts: ["hunter2hunter", "hunter2"] },
    { kind: "credential (mixed-case token)", text: `seen ${TYPESAFE_SHAPE}`, parts: [TYPESAFE_SHAPE, "Kf3Vn9"] },
    { kind: "email", text: "write to jane.doe@gmail.com", parts: ["jane.doe@gmail.com", "jane.doe", "gmail"] },
    { kind: "obfuscated email", text: "write to jane [at] gmail [dot] com", parts: ["jane [at] gmail [dot] com", "jane"] },
    { kind: "phone", text: "call +44 20 7946 0958", parts: ["+44 20 7946 0958", "7946", "0958"] },
  ];
  for (const { kind, text, parts } of SECRETS) {
    test(`[unit] output never contains the matched text: ${kind}`, () => {
      const { code, out } = runCli(["note.md"], asRead(`# Note\n${text}\n`));
      expect(code).toBe(1);
      expect(out.startsWith("line 2: ")).toBe(true);
      for (const part of parts) expect(out).not.toContain(part);
    });
  }

  // Kills: an entry point that is not wired (import.meta.main), or that prints to the wrong stream.
  describe("as a process", () => {
    function run(args: readonly string[]) {
      return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT });
    }
    function withFile<T>(body: string, use: (path: string) => T): T {
      const dir = mkdtempSync(join(tmpdir(), "run-note-"));
      try {
        const path = join(dir, "note.md");
        writeFileSync(path, body);
        return use(path);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    test("[integration] clean file exits 0 with the summary on stdout", () => {
      const r = withFile("# Note\n\nok\n", (p) => run([p]));
      expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: "scan-run-note: 0 findings in 3 lines\n", stderr: "" });
    });

    test("[integration] dirty file exits 1 and neither stream holds a matched substring", () => {
      const r = withFile(DIRTY, (p) => run([p]));
      expect(r.status).toBe(1);
      expect(r.stdout.split("\n")[0]).toBe("line 1: credential (looks like a Anthropic key (sk-ant-))");
      for (const part of [ANTHROPIC, "jane.doe", "7946", "hunter2"]) {
        expect(r.stdout).not.toContain(part);
        expect(r.stderr).not.toContain(part);
      }
    });

    test("[integration] no argument exits 2 with the reason on stderr", () => {
      const r = run([]);
      expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 2, stdout: "" });
      expect(r.stderr).toContain("usage");
    });

    test("[integration] a missing file exits 2", () => {
      expect(run([join(tmpdir(), "run-note-does-not-exist.md")]).status).toBe(2);
    });
  });
});

describe("credential values: quotes, brackets, literals", () => {
  // Kills: a value parser that stops at the first space inside a quoted value.
  for (const line of ['password: "a long secret phrase"', "password: 'two words here'", "password: `three words here`"]) {
    test(`[unit] a quoted value with spaces is flagged: ${line}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "credential", name: "credential assignment" }]);
    });
  }

  // Kills: a placeholder rule that trusts any bracketed value, digits or not.
  for (const line of ["password: [hunter2]", "token: <abc123def>", "secret: {s3cr3t}"]) {
    test(`[unit] a bracketed value holding a digit is flagged: ${line}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "credential", name: "credential assignment" }]);
    });
  }
  for (const line of ["API key: [not provided]", "API key: <your key>", "password: [redacted]", "API key: <value>"]) {
    test(`[unit] a bracketed value without a digit is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }

  // Kills: missing null/true/false status words or trailing-punctuation stripping.
  for (const line of ['{"api_key": null}', '{"password": false}', "password: true", "token: null)", "token: false;"]) {
    test(`[unit] a literal value is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }
  test("[unit] a quoted value that merely starts with null is flagged", () => {
    expect(scanRunNote('{"password": "null-pass-99"}')).toEqual([{ line: 1, kind: "credential", name: "credential assignment" }]);
  });
});

describe("phone spacing and 00 prefix", () => {
  const NBSP = " ";
  const FLAGGED = [
    "phone: 020  7946  0958",
    "phone: 020\t7946\t0958",
    `phone: 020${NBSP}7946${NBSP}0958`,
    "+44 20 7946 0958",
    "+44  20  7946  0958",
    `+44${NBSP}20${NBSP}7946${NBSP}0958`,
    "phone: 00 44 20 7946 0958",
    "tel: 00442079460958",
    "415  555  2671",
  ];
  for (const line of FLAGGED) {
    test(`[unit] spaced or 00-prefixed number is flagged: ${JSON.stringify(line)}`, () => {
      expect(got(line)).toEqual(["1:phone"]);
    });
  }
  for (const line of ["2026-10-16  12:30", "cases 30  40  50"]) {
    test(`[unit] double-spaced date or count is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }
});

describe("phone windows", () => {
  const NBSP = "\u00a0";
  // Kills: a greedy digit-run match that swallows a neighbouring date or number and then rejects the whole candidate.
  const BESIDE_OTHER_DIGITS = [
    "Contact numbers: 020 7946 0958 07700 900123",
    "Called 020 7946 0958 2026-10-16",
    "0800 123 4567 24 hours",
    "07700 900123 07700 900456",
    "07700 900123 42",
  ];
  for (const line of BESIDE_OTHER_DIGITS) {
    test(`[unit] a phone next to other digits is flagged: ${line}`, () => {
      expect(got(line)).toEqual(["1:phone"]);
    });
  }

  // Kills: windows that start or end inside a date or a dotted unit, or a date that joins a run.
  for (const line of ["2026-10-16 2026-10-17", "version 1.63.0 0.0012345678", "built 1.63.0 on 178.62.69.200 for 30 40 50 60 70"]) {
    test(`[unit] adjacent dates, versions and counts are clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }

  // Kills: a 00 rule that needs only spaces, or that moves its 8-digit floor (7 digits after 00 is clean, 8 and more is flagged).
  for (const [label, sep] of [["tab", "\t"], ["no-break space", NBSP]] as const) {
    test(`[unit] 00 prefix with 8 digits after it is flagged, ${label} separated`, () => {
      expect(got(["00", "12", "34", "56", "78"].join(sep))).toEqual(["1:phone"]);
    });
    test(`[unit] 00 prefix with 7 digits after it is clean, ${label} separated`, () => {
      expect(got(["00", "12", "34", "56", "7"].join(sep))).toEqual([]);
    });
  }
  test("[unit] 00 prefix with 12 digits after it is flagged", () => {
    expect(got("00 12 34 56 78 90 12")).toEqual(["1:phone"]);
  });

  // Kills: an all-pairs window scan that is quadratic in the number of groups.
  test("[unit] 20,000 space-separated groups are scanned in under 500 ms", () => {
    const line = rep("12 ", 20000);
    const t0 = performance.now();
    expect(got(line)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("placeholder vocabulary", () => {
  // Kills: a placeholder exemption by shape (brackets) instead of by vocabulary, and a value parser that stops at an asterisk.
  const FLAGGED = [
    "password: [correcthorsebatterystaple]",
    "password: <letmeinplease>",
    "password: P*ssw0rd123",
    "password: Pa*ssword99",
    "secret: ab*cd1234efgh",
  ];
  for (const line of FLAGGED) {
    test(`[unit] a non-vocabulary value is flagged: ${line}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "credential", name: "credential assignment" }]);
    });
  }

  // Kills: a vocabulary missing copied/from/the/console/your/key/value/not/provided, or one that stops honouring wrappers.
  for (const line of ["API key: copied from the console", "API key: <your key>", "API key: [not provided]", "API key: <value>", "password: **[redacted]**", "token: <Value>", "API key: {omitted}", "password: [TypeSafe provider model key]"]) {
    test(`[unit] a vocabulary-only value is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }

  // Kills: a vocabulary check that ignores a digit hidden beside a vocabulary word.
  for (const line of ["password: [value1]", "password: <your2key>"]) {
    test(`[unit] a vocabulary word beside a digit is flagged: ${line}`, () => {
      expect(got(line)).toEqual(["1:credential"]);
    });
  }
});

describe("email forms", () => {
  // Kills: an obfuscation pattern that allows one space only.
  for (const line of ["jane  [at]  gmail  [dot]  com", "jane\t[at]\tgmail\t[dot]\tcom", "jane {at}   gmail  (dot)  com"]) {
    test(`[unit] obfuscated email with runs of whitespace is flagged: ${JSON.stringify(line)}`, () => {
      expect(scanRunNote(line)).toEqual([{ line: 1, kind: "email", name: "obfuscated email address" }]);
    });
  }

  // Kills: a published-contact comparison that sees wrapper characters as part of the address.
  for (const line of ["contact `jev@breakoutwithai.com`", "**jev@breakoutwithai.com**", "'jev@breakoutwithai.com'", '"jev@breakoutwithai.com"']) {
    test(`[unit] the published contact in a wrapper is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }
  for (const line of ["foo!jev@breakoutwithai.com", "`other@breakoutwithai.com`", "`jev@breakoutwithai.com.evil.io`"]) {
    test(`[unit] another address in a wrapper is flagged: ${line}`, () => {
      expect(got(line)).toEqual(["1:email"]);
    });
  }

  // Kills: an obfuscation pattern that retries from every position of a long whitespace run.
  test("[unit] a 40,000-space line is scanned in under 200 ms", () => {
    const t0 = performance.now();
    scanRunNote(rep(" ", 40000));
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("template header", () => {
  // Kills: a template whose step table header drifts from the wording testers are told to follow.
  test("[unit] the step table header is exactly the agreed one", () => {
    const header = "| Step | Title | Worked (Y/N) | What you saw (no question, case text or answers) | Issue (values replaced with `<value>`) |";
    const rows = readFileSync(TEMPLATE_PATH, "utf8").split("\n").filter((l) => l.startsWith("| Step |"));
    expect(rows).toEqual([header]);
  });
});

describe("phone next to a colon or slash", () => {
  // Kills: a touching rule that treats a colon or slash beside a digit group as a time or path when a label or a space is on the other side.
  const LABELLED = [
    "phone:02079460958",
    "tel:00442079460958",
    "tel:415-555-2671",
    "Called 415-555-0123: no answer",
    "Tel +49 30 12-03-2026",
    "tel:1.415-555-2671",
    "tel:1.415 555 2671",
    "Phone:1.212-555-0123",
    "tel:7.916.555.0123",
    "tel:91.987-654-3210",
    "Phone:91.987.654.3210",
    "tel:49.030-1234567",
    "Called +49 30 123456.0: no answer",
    "tel:7.916-555-0123",
    "Tel +1 415 555 0123 / 0124",
  ];
  for (const line of LABELLED) {
    test(`[unit] a labelled or punctuated phone number is flagged: ${line}`, () => {
      expect(got(line)).toEqual(["1:phone"]);
    });
  }

  // Kills: a fix that frees every colon and slash, so times, dates, fractions and paths start to read as phone numbers.
  for (const line of ["03-10-2026 12:30", "12:30", "at 10:30:45", "03/10/2026 12:30", "28/30", "1/2/3", "path/2026/10/16", "steps 12/30: done", "Step 2: 28/30 passed", "Results 01/02/03 10 20 30 40", "03-10-2026 28/30 passed", "03-10-26 1280/1300 passed", "Results 01 02 03 04 28/30 passed", "https://host/2026101601/result"]) {
    test(`[unit] a time, date, fraction or path stays clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }

  // Kills: a window scan that only tries windows starting at the first group of a run (mutation: start every window at group 0).
  for (const line of ["Step 2 07700 900123", "Cases 12 415 555 0123"]) {
    test(`[unit] a phone after leading counts in the same run is flagged: ${line}`, () => {
      expect(got(line)).toEqual(["1:phone"]);
    });
  }
});

describe("published contact local part", () => {
  // Kills: a wrapper strip that cuts the local part at the last wrapper character anywhere in it.
  for (const line of ["alice=jev@breakoutwithai.com", "alice*jev@breakoutwithai.com", "x'jev@breakoutwithai.com", "a`jev@breakoutwithai.com", "**alice=jev@breakoutwithai.com", "contact=jev@breakoutwithai.com", "email=jev@breakoutwithai.com", "<to=jev@breakoutwithai.com>", "mailto:reply-to=jev@breakoutwithai.com"]) {
    test(`[unit] an address that only ends in the published local part is flagged: ${line}`, () => {
      expect(got(line)).toEqual(["1:email"]);
    });
  }

  for (const line of ["Jev@BreakoutWithAI.com", "***jev@breakoutwithai.com***", "`jev@breakoutwithai.com`"]) {
    test(`[unit] the published contact behind a label or wrapper run is clean: ${line}`, () => {
      expect(got(line)).toEqual([]);
    });
  }
});
