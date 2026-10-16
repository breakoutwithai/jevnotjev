// Threat model: an honest tester accidentally pastes a real key, email or phone into a note; a deliberate evader (zero-width characters, entity encoding, values split across lines) is out of scope.
import { readFileSync } from "node:fs";
import { findCredentials } from "../../src/backstage/credential-scan";

export type FindingKind = "credential" | "email" | "phone";
export interface Finding {
  readonly line: number;
  readonly kind: FindingKind;
  /** A pattern label, never the matched text. */
  readonly name: string;
}

const KIND_ORDER: readonly FindingKind[] = ["credential", "email", "phone"];

// ---- credentials ----

const ASSIGNMENT =
  /(?<![A-Za-z0-9])(?:api[ _-]?key|secret[ _-]?key|password|passwd|secret|token|authorization)["'`*_]*\s*[:=][\s*_]*(?:"([^"]*)"?|'([^']*)'?|`([^`]*)`?|(<[^>]*>|\[[^\]]*\]|\{[^}]*\})|([^\s"'`]+))/gi;
const MASK = /^[*xX.-]+$/;
/** The closed vocabulary of a placeholder: a value made only of these words says nothing secret. */
const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set([
  "pasted", "entered", "accepted", "rejected", "worked", "redacted", "removed", "hidden", "none", "blank", "empty",
  "set", "valid", "invalid", "ok", "yes", "no", "required", "optional", "provided", "missing", "null", "true", "false",
  "value", "your", "key", "api", "here", "not", "omitted", "copied", "from", "the", "console", "typesafe", "provider", "model",
]);
/** A bounded run of 24+ token characters. */
const LONG_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g;

/** A value is a placeholder when it is a run of mask characters, under 4 characters, or only closed-vocabulary words and no digit. */
function isPlaceholder(value: string): boolean {
  if (MASK.test(value) || value.length < 4) return true;
  if (/\d/.test(value)) return false;
  const lower = value.toLowerCase();
  if (lower === "n/a") return true;
  const words = lower.split(/[^a-z]+/).filter((w) => w !== "");
  return words.length > 0 && words.every((w) => PLACEHOLDER_WORDS.has(w));
}

function assignedValueLooksReal(line: string): boolean {
  for (const m of line.matchAll(ASSIGNMENT)) {
    const quoted = m[1] ?? m[2] ?? m[3];
    const bracketed = m[4];
    // A quoted value runs to its closing quote; an unquoted one loses trailing JSON/prose punctuation.
    const raw = (quoted ?? bracketed ?? m[5] ?? "").trim();
    const unquoted = quoted === undefined && bracketed === undefined ? raw.replace(/[}\]),;.]+$/, "") : raw;
    const value = unquoted.replace(/^[*_]+|[*_]+$/g, "");
    if (!isPlaceholder(value)) return true;
  }
  return false;
}

function credentialName(line: string): string | null {
  // The shared scanner owns the vendor key shapes; its hits read "$: looks like a ...".
  const vendor = findCredentials(line)[0];
  if (vendor !== undefined) return vendor.replace(/^\$: /, "");
  if (assignedValueLooksReal(line)) return "credential assignment";
  for (const m of line.matchAll(LONG_TOKEN)) {
    const t = m[0];
    if (/[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t)) return "long mixed-case token";
  }
  return null;
}

// ---- email ----

// The left boundary stops the scan retrying from every position inside one long run of address characters.
const EMAIL = /(?<![A-Za-z0-9!#$%&'*+/=?^_`{|}~.-])[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
// The lookbehind lets a whitespace run match once, from its start, so a long run is not rescanned from every position.
const AT_FORM = /(?<!\s)\s*[[({]at[\])}]\s*/gi;
const DOT_FORM = /(?<!\s)\s*[[({]dot[\])}]\s*/gi;
const PUBLISHED_CONTACT = "jev@breakoutwithai.com";
const SAMPLE_DOMAIN = /(?:^|\.)(?:example|test|invalid|localhost)$|(?:^|\.)example\.(?:com|org|net)$/;
/** What may sit in front of the published local part: a leading run of wrapper characters and nothing else. */
const CONTACT_PREFIX = /^[`'"*]*/;

/** The address with a leading wrapper run removed; any other character in the local part stays and makes it a different address. */
function unwrapped(match: string, domain: string): string {
  const local = match.slice(0, match.length - domain.length - 1);
  return `${local.slice((CONTACT_PREFIX.exec(local) ?? [""])[0].length)}@${domain}`.toLowerCase();
}

function hasRealEmail(line: string): boolean {
  for (const m of line.matchAll(EMAIL)) {
    const domain = m[1] ?? "";
    if (unwrapped(m[0], domain) === PUBLISHED_CONTACT || SAMPLE_DOMAIN.test(domain.toLowerCase())) continue;
    return true;
  }
  return false;
}

// ---- phone ----

/** One run of digits and where it sits in the line. */
interface Group {
  readonly digits: string;
  readonly start: number;
  readonly end: number;
}
/** The smallest piece a window is built from: one group, or groups joined by dots. */
interface Unit {
  readonly groups: readonly Group[];
}

// What may join two digit groups into one run: spaces, tabs or no-break spaces, one hyphen, or parentheses around a group.
const RUN_JOIN = /^(?:[ \t ]+|-|[ \t ]*[()][ \t ]*|[ \t ]*\)[ \t ]*\([ \t ]*)$/;
const ISO_DATE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;
/** A group touching a letter, underscore or slash is part of a word, fraction or path. A colon ties it only with a digit on its far side (a time), so "tel:415-555-2671" is not exempt. */
const WORD_CHAR = /[A-Za-z_/]/;
const DIGIT = /\d/;

/** Does the character just outside a group (`at`) tie it to a word, a time or a path? `far` is the character beyond it. */
function ties(at: string, far: string): boolean {
  return WORD_CHAR.test(at) || (at === ":" && DIGIT.test(far));
}
/** A window stops growing once it holds this many digits; longer windows add nothing a shorter prefix did not already flag. */
const MAX_WINDOW_DIGITS = 20;

function digitGroups(line: string): Group[] {
  const groups: Group[] = [];
  const re = /\d+/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    groups.push({ digits: m[0], start: m.index, end: m.index + m[0].length });
  }
  return groups;
}

/** Marks every character that sits inside an ISO date. */
function dateMask(line: string): Uint8Array {
  const mask = new Uint8Array(line.length);
  const re = new RegExp(ISO_DATE.source, "g");
  for (let m = re.exec(line); m !== null; m = re.exec(line)) mask.fill(1, m.index, m.index + m[0].length);
  return mask;
}

/** A dotted unit is phone-eligible only when every group has 2-4 digits, or it is the 1-3-3-4 North American form. */
function dottedEligible(groups: readonly Group[]): boolean {
  if (groups.length === 1) return true;
  if (groups.every((g) => g.digits.length >= 2 && g.digits.length <= 4)) return true;
  return groups.map((g) => g.digits.length).join(",") === "1,3,3,4" && groups[0]?.digits === "1";
}

/** The line as runs of phone-eligible units. Dates, groups touching a word, colon or slash, and ineligible dotted units end a run. */
function digitRuns(line: string): Unit[][] {
  const dated = dateMask(line);
  const runs: Unit[][] = [];
  let run: Unit[] = [];
  let unit: Group[] = [];
  const flushRun = (): void => {
    if (run.length > 0) runs.push(run);
    run = [];
  };
  const flushUnit = (): void => {
    if (unit.length === 0) return;
    if (dottedEligible(unit)) run.push({ groups: unit });
    else flushRun();
    unit = [];
  };
  let prev: Group | undefined;
  for (const g of digitGroups(line)) {
    const inDate = dated[g.start] === 1 || dated[g.end - 1] === 1;
    // A colon frees a group beside it, except inside a dotted unit ("tel:1.415-555-2671", "123456.0:"): that unit would hide the groups beside it.
    const labelledDotted = line.charAt(g.start - 1) === ":" && line.charAt(g.end) === "." && DIGIT.test(line.charAt(g.end + 1));
    const trailingDotted = line.charAt(g.end) === ":" && line.charAt(g.start - 1) === "." && DIGIT.test(line.charAt(g.start - 2));
    const touching = labelledDotted || trailingDotted || ties(line.charAt(g.start - 1), line.charAt(g.start - 2)) || ties(line.charAt(g.end), line.charAt(g.end + 1));
    if (inDate || touching) {
      flushUnit();
      flushRun();
      prev = undefined;
      continue;
    }
    const gap = prev === undefined ? "" : line.slice(prev.end, g.start);
    if (prev !== undefined && gap === ".") {
      unit.push(g);
    } else {
      flushUnit();
      if (prev === undefined || !RUN_JOIN.test(gap)) flushRun();
      unit = [g];
    }
    prev = g;
  }
  flushUnit();
  flushRun();
  return runs;
}

/** Does this window of digit groups match a phone rule? `before` is the character in front of its first group. */
function windowIsPhone(window: readonly Group[], before: string, plusPrefix: boolean): boolean {
  const digits = window.reduce((n, g) => n + g.digits.length, 0);
  const first = window[0]?.digits ?? "";
  if (plusPrefix && digits >= 8) return true;
  if (first.startsWith("00") && !(before !== "" && ",.+-".includes(before)) && digits - 2 >= 8) return true;
  if (first.startsWith("0") && digits >= 10 && digits <= 12) return true;
  const shape = window.map((g) => g.digits.length).join(",");
  if (shape === "3,3,4" || (shape === "1,3,3,4" && first === "1")) return true;
  return window.length === 1 && /^[2-9]\d{2}[2-9]\d{6}$/.test(first);
}

function hasPhone(line: string): boolean {
  for (const run of digitRuns(line)) {
    for (let i = 0; i < run.length; i++) {
      const firstGroup = run[i]?.groups[0];
      if (firstGroup === undefined) continue;
      const before = line.charAt(firstGroup.start - 1);
      const plusPrefix = i === 0 && before === "+" && !/[A-Za-z0-9]/.test(line.charAt(firstGroup.start - 2));
      const window: Group[] = [];
      let digits = 0;
      for (let j = i; j < run.length && digits <= MAX_WINDOW_DIGITS; j++) {
        for (const g of run[j]?.groups ?? []) {
          window.push(g);
          digits += g.digits.length;
        }
        if (windowIsPhone(window, before, plusPrefix)) return true;
      }
    }
  }
  return false;
}

// ---- scan ----

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function emailName(line: string): string | null {
  if (hasRealEmail(line)) return "email address";
  // Obfuscated forms are normalised first so the same exemptions apply.
  const plain = line.replace(AT_FORM, "@").replace(DOT_FORM, ".");
  return plain !== line && hasRealEmail(plain) ? "obfuscated email address" : null;
}

export function scanRunNote(text: string): Finding[] {
  const findings: Finding[] = [];
  splitLines(text).forEach((raw, i) => {
    const line = i + 1;
    const hits: Record<FindingKind, string | null> = {
      credential: credentialName(raw),
      email: emailName(raw),
      phone: hasPhone(raw) ? "phone number" : null,
    };
    for (const kind of KIND_ORDER) {
      const name = hits[kind];
      if (name !== null) findings.push({ line, kind, name });
    }
  });
  return findings;
}

// ---- cli ----

export function runCli(args: readonly string[], read: (path: string) => string): { readonly code: 0 | 1 | 2; readonly out: string } {
  const path = args[0];
  if (args.length !== 1 || path === undefined) return { code: 2, out: "scan-run-note: usage: bun scripts/uat/scan-run-note.ts <note.md>" };
  let text: string;
  try {
    text = read(path);
  } catch {
    return { code: 2, out: "scan-run-note: cannot read the note file" };
  }
  const lines = splitLines(text);
  if (!lines.some((l) => l.trim() !== "")) return { code: 2, out: "scan-run-note: the note has no non-blank lines, so it is not a clean note" };
  const findings = scanRunNote(text);
  const rows = findings.map((f) => `line ${f.line}: ${f.kind} (${f.name})`);
  rows.push(`scan-run-note: ${findings.length} findings in ${lines.length} lines`);
  return { code: findings.length === 0 ? 0 : 1, out: rows.join("\n") };
}

if (import.meta.main) {
  const result = runCli(Bun.argv.slice(2), (path) => readFileSync(path, "utf8"));
  (result.code === 2 ? process.stderr : process.stdout).write(result.out + "\n");
  process.exit(result.code);
}
