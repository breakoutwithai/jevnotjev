// The public page's "Load your own script (CSV)": a jnj-record/1 file is read in the browser only, run through the
// same validate, metrics and verdict code the command line uses, and shown as VALID or INVALID with every ERROR and
// GAP line, the per-method summary and one verdict per question. Pure apart from the DOM handles passed to
// attachLoader: no Node or Bun APIs, and nothing here sends data anywhere (no network calls of any kind).
// Bundled to site/results-loader.js by scripts/build-loader.ts; never edit the built file.

import { fileSeed } from "../core/calc.ts";
import { caseCell, caseLines, matchingMethods } from "../core/case-table.ts";
import { armsInFile, groupCohorts, metricsOfCohortRows, provenanceByMethod } from "../core/metrics.ts";
import { verdict } from "../core/verdict.ts";
import { decodeUtf8, report, summary, validate, type Validation } from "../format/validate.ts";

/** Largest file the page reads, in bytes. Validation runs on the page's thread, so a bigger file would freeze it. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Most questions (cohorts: run, prompt version and question id) the page evaluates; each gets its own verdict. */
export const MAX_COHORTS = 1000;

/** Most cases one question's table shows; the rest are counted, so a big file stays fast to draw. The verdict still uses every case. */
export const MAX_CASE_ROWS = 200;

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** One case of one question: what each method answered and cost (words for a missing row, cost or label), and which methods the label accepts. */
export interface CaseView {
  readonly caseId: string;
  readonly llm: string;
  readonly rule: string;
  readonly jev: string;
  readonly matches: string;
}

export interface QuestionVerdict {
  readonly question: string;
  readonly questionId: string;
  readonly runId: string;
  readonly promptVersion: string;
  /** The verdict name, or null when no verdict could be computed. */
  readonly verdict: string | null;
  /** One line for the screen: the verdict's reason, or why there is no verdict. */
  readonly reason: string;
  /** What limits this verdict (Verdict.limitations); empty when no verdict could be computed. */
  readonly limitations: readonly string[];
  /** The first MAX_CASE_ROWS cases, in file order. */
  readonly cases: readonly CaseView[];
  /** How many cases the question has in all. */
  readonly caseTotal: number;
}

export interface LoadedResult {
  readonly fileName: string;
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly gaps: readonly string[];
  /** The one-line count, e.g. `VALID rows=30 cases=5 errors=0 gaps=2`. */
  readonly headline: string;
  /** One line per method (answerer); empty when the file is invalid. */
  readonly methods: readonly string[];
  /** One line per method (same order as `methods`): where its labels came from and whether they were blind. */
  readonly provenance: readonly string[];
  /** One verdict per question; empty when the file is invalid. */
  readonly questions: readonly QuestionVerdict[];
}

function failure(fileName: string, message: string): LoadedResult {
  return { fileName, valid: false, errors: [message], gaps: [], headline: "INVALID rows=0 cases=0 errors=1 gaps=0", methods: [], provenance: [], questions: [] };
}

/** Validate, summarise and judge one file's bytes. A file that cannot be read is INVALID, never an exception. */
export async function evaluateBytes(fileName: string, bytes: Uint8Array): Promise<LoadedResult> {
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch {
    return failure(fileName, "file is not valid UTF-8");
  }
  return evaluateText(fileName, text);
}

export async function evaluateText(fileName: string, text: string): Promise<LoadedResult> {
  let result: Validation;
  try {
    result = validate(text);
  } catch (error) {
    return failure(fileName, error instanceof Error ? error.message : "file could not be read");
  }
  const { lines } = report(result);
  const headline = lines[lines.length - 1] ?? "";
  if (result.errors.length > 0) {
    return { fileName, valid: false, errors: result.errors, gaps: result.gaps, headline, methods: [], provenance: [], questions: [] };
  }
  const groups = groupCohorts(result.rows);
  if (groups.length > MAX_COHORTS) {
    const message = "file has " + groups.length + " questions (run, prompt version and question id each count); the limit is " + MAX_COHORTS;
    return { fileName, valid: false, errors: [message], gaps: result.gaps, headline: "INVALID rows=" + result.rows.length + " errors=1", methods: [], provenance: [], questions: [] };
  }
  const seed = await fileSeed(text);
  const arms = armsInFile(result.rows);
  const questions: QuestionVerdict[] = [];
  for (const { key, rows } of groups) {
    const metrics = metricsOfCohortRows(rows, key);
    const lines = caseLines(rows);
    const cases = lines.slice(0, MAX_CASE_ROWS).map((line) => ({
      caseId: line.caseId,
      llm: caseCell(line.rows.llm),
      rule: caseCell(line.rows.rule),
      jev: caseCell(line.rows.jev),
      matches: matchingMethods(line),
    }));
    const head = { question: metrics.question, questionId: key.questionId, runId: key.runId, promptVersion: key.promptVersion, cases, caseTotal: lines.length };
    try {
      const v = verdict(metrics, seed, arms);
      questions.push({ ...head, verdict: v.verdict, reason: v.reason, limitations: v.limitations });
    } catch (error) {
      const why = error instanceof Error ? error.message : "no verdict";
      questions.push({ ...head, verdict: null, reason: why, limitations: [] });
    }
  }
  return { fileName, valid: true, errors: [], gaps: result.gaps, headline, methods: summary(result.rows), provenance: provenanceByMethod(result.rows), questions };
}

/** Text safe to place inside HTML element content or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** One element: fixed tag and class, with the text escaped here. */
function el(tag: string, className: string, text: string): string {
  return "<" + tag + ' class="' + className + '">' + escapeHtml(text) + "</" + tag + ">";
}

function list(className: string, prefix: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  const lines = items.map((i) => "<li>" + escapeHtml(prefix === "" ? i : prefix + " " + i) + "</li>");
  return '<ul class="' + className + '">' + lines.join("") + "</ul>";
}

function cellHtml(caseId: string, column: string, value: string): string {
  return '<td data-cell="case.' + escapeHtml(caseId) + "." + column + '">' + escapeHtml(value) + "</td>";
}

/** One question's cases, a row each with llm, rule and jev side by side, capped at MAX_CASE_ROWS rows with the count said. */
function caseTable(q: QuestionVerdict): string {
  const rows = q.cases.map(
    (c) =>
      '<tr data-case="' + escapeHtml(c.caseId) + '"><th scope="row">' + escapeHtml(c.caseId) + "</th>" +
      cellHtml(c.caseId, "llm", c.llm) + cellHtml(c.caseId, "rule", c.rule) + cellHtml(c.caseId, "jev", c.jev) + cellHtml(c.caseId, "matches", c.matches) + "</tr>",
  );
  const more = q.caseTotal > q.cases.length
    ? '<p class="ld-more">' + escapeHtml("This table is showing the first " + q.cases.length + " of " + q.caseTotal + " cases; the verdict above counts all of them.") + "</p>"
    : "";
  return (
    '<div class="ld-scroll"><table class="ld-cases"><caption>Every case: each method\'s output and cost, and which methods match the label</caption>' +
    '<thead><tr><th scope="col">Case</th><th scope="col">llm</th><th scope="col">rule</th><th scope="col">jev</th><th scope="col">Matches label</th></tr></thead><tbody>' +
    rows.join("") + "</tbody></table></div>" + more
  );
}

/** The result panel. Every file-derived string goes through escapeHtml; the markup around it is fixed. */
export function renderResult(r: LoadedResult): string {
  const parts = [
    el("h3", r.valid ? "ld-word ld-valid" : "ld-word ld-invalid", r.valid ? "VALID" : "INVALID"),
    el("p", "ld-file", r.fileName + ": " + r.headline),
    list("ld-errors", "ERROR", r.errors),
    list("ld-gaps", "GAP", r.gaps),
  ];
  if (r.valid) {
    parts.push(el("h4", "ld-head", "Each method"), list("ld-methods", "", r.methods), el("h4", "ld-head", "Where each method's labels came from"), list("ld-provenance", "", r.provenance));
    const rows = r.questions.map(
      (q) =>
        '<li><span class="ld-id">' + escapeHtml("run " + q.runId + ", prompt " + q.promptVersion + ", question " + q.questionId) + "</span> " +
        '<span class="ld-q">' + escapeHtml(q.question) + '</span> <span class="ld-v">' + escapeHtml(q.verdict ?? "no verdict") +
        '</span> <span class="ld-why">' + escapeHtml(q.reason) + "</span>" + list("ld-limits", "Limitation:", q.limitations) + caseTable(q) + "</li>",
    );
    parts.push(el("h4", "ld-head", "Verdict per question"), '<ul class="ld-verdicts">' + rows.join("") + "</ul>");
  }
  return parts.join("");
}

/** What the page script needs from a file: a name and Blob's arrayBuffer. */
export interface LoaderFile {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface LoaderEvent {
  preventDefault(): void;
  readonly dataTransfer?: { readonly files: ArrayLike<LoaderFile> } | null;
}
export interface LoaderElement {
  textContent: string | null;
  innerHTML: string;
  hidden: boolean | string;
  disabled?: boolean;
  value?: string;
  files?: ArrayLike<LoaderFile> | null;
  readonly classList: { add(name: string): void; remove(name: string): void };
  addEventListener(type: string, listener: (event: LoaderEvent) => void): void;
  removeAttribute?(name: string): void;
}
export interface LoaderDocument {
  getElementById(id: string): LoaderElement | null;
}

export const IDS = { zone: "dropzone", input: "csv", status: "dropStatus", panel: "loadedResult" } as const;

/** Acts II to V each carry a flag, and Act V a slot for the loaded verdict; the page has no flag until a file is loaded. */
export const STAGE_IDS = { flags: ["sampleFlag2", "sampleFlag3", "sampleFlag4", "sampleFlag5"], current: "currentVerdict" } as const;

/** Most questions listed in the Act V slot; the panel below the play lists them all. */
const MAX_CURRENT = 10;

/**
 * Once a file has been checked, Acts II to V (still the recorded sample) say so, and Act V shows the file's own verdict
 * as the current one, so the page never shows two verdicts with no label on which is which. Each element is optional.
 */
export function markStage(doc: LoaderDocument, r: LoadedResult): void {
  const name = r.fileName;
  const flagText = r.valid
    ? "Sample data: this act replays the recorded shop-bot run, not " + name + ". The verdict for " + name + " is at the top of Act V."
    : "Sample data: this act replays the recorded shop-bot run. " + name + " is INVALID, so it has no verdict.";
  for (const id of STAGE_IDS.flags) {
    const flag = doc.getElementById(id);
    if (!flag) continue;
    flag.textContent = flagText;
    flag.hidden = false;
  }
  const slot = doc.getElementById(STAGE_IDS.current);
  if (!slot) return;
  if (!r.valid) {
    slot.innerHTML = el("h3", "ld-now-head", "Your file: " + name) + el("p", "ld-now", "INVALID: there is no verdict for your file. The verdict below is the recorded sample's.");
  } else {
    const items = r.questions.slice(0, MAX_CURRENT).map((q) => {
      // The reason usually opens with the verdict's own name; the slot already shows it in bold.
      const why = q.verdict !== null && q.reason.startsWith(q.verdict + ": ") ? q.reason.slice(q.verdict.length + 2) : q.reason;
      return "<li>" + escapeHtml("run " + q.runId + ", prompt " + q.promptVersion + ", question " + q.questionId + ": ") + '<span class="ld-v">' + escapeHtml(q.verdict ?? "no verdict") + "</span> " + escapeHtml("(" + why + ")") + list("ld-limits", "Limitation:", q.limitations) + "</li>";
    });
    const more = r.questions.length > MAX_CURRENT ? el("p", "ld-now", "and " + (r.questions.length - MAX_CURRENT) + " more questions: see the result under the curtain call.") : "";
    slot.innerHTML = el("h3", "ld-now-head", "Current verdict: your file " + name) + '<ul class="ld-now-list">' + items.join("") + "</ul>" + more;
  }
  slot.hidden = false;
}

/** Wire the page's drop zone. Returns false (and does nothing) when the page lacks the elements. */
export function attachLoader(doc: LoaderDocument, onSettled?: (fileName: string) => void): boolean {
  const zone = doc.getElementById(IDS.zone);
  const input = doc.getElementById(IDS.input);
  const status = doc.getElementById(IDS.status);
  const panel = doc.getElementById(IDS.panel);
  if (!zone || !input || !status || !panel) return false;

  input.disabled = false;
  input.removeAttribute?.("disabled");
  zone.classList.remove("is-off");

  /** Selection counter: only the newest selection may render, so a slow older read cannot overwrite it. */
  let latest = 0;

  async function take(file: LoaderFile | undefined): Promise<void> {
    if (!file || !status || !panel) return;
    latest += 1;
    const mine = latest;
    status.textContent = "Reading " + file.name + " here in your browser. Nothing is uploaded.";
    let outcome: LoadedResult;
    if (file.size > MAX_FILE_BYTES) {
      outcome = failure(file.name, "file is " + megabytes(file.size) + " MB; the limit is " + megabytes(MAX_FILE_BYTES).replace(/\.0$/, "") + " MB");
    } else {
      try {
        outcome = await evaluateBytes(file.name, new Uint8Array(await file.arrayBuffer()));
      } catch {
        outcome = failure(file.name, "file could not be read");
      }
    }
    if (mine !== latest) {
      onSettled?.(file.name);
      return;
    }
    panel.innerHTML = renderResult(outcome);
    panel.hidden = false;
    markStage(doc, outcome);
    status.textContent = (outcome.valid ? "VALID" : "INVALID") + ": " + outcome.fileName + ", read in your browser, nothing uploaded.";
    onSettled?.(file.name);
  }

  input.addEventListener("change", () => {
    const chosen = input.files?.[0];
    // Clear the picker so choosing the same file again fires change again.
    input.value = "";
    void take(chosen);
  });
  for (const t of ["dragenter", "dragover"]) {
    zone.addEventListener(t, (e) => {
      e.preventDefault();
      zone.classList.add("over");
    });
  }
  zone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    void take(e.dataTransfer?.files[0]);
  });
  return true;
}
