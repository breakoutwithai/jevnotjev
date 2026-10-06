// The public page's "Load your own script (CSV)": a jnj-record/1 file is read in the browser only, run through the
// same validate, metrics and verdict code the command line uses, and shown as VALID or INVALID with every ERROR and
// GAP line, the per-method summary and one verdict per question. Pure apart from the DOM handles passed to
// attachLoader: no Node or Bun APIs, and nothing here sends data anywhere (no network calls of any kind).
// Bundled to site/results-loader.js by scripts/build-loader.ts; never edit the built file.

import { fileSeed } from "../core/calc.ts";
import { groupCohorts, metricsOfCohortRows } from "../core/metrics.ts";
import { verdict } from "../core/verdict.ts";
import { decodeUtf8, report, summary, validate, type Validation } from "../format/validate.ts";

/** Largest file the page reads, in bytes. Validation runs on the page's thread, so a bigger file would freeze it. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Most questions (cohorts: run, prompt version and question id) the page evaluates; each gets its own verdict. */
export const MAX_COHORTS = 1000;

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
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
  /** One verdict per question; empty when the file is invalid. */
  readonly questions: readonly QuestionVerdict[];
}

function failure(fileName: string, message: string): LoadedResult {
  return { fileName, valid: false, errors: [message], gaps: [], headline: "INVALID rows=0 cases=0 errors=1 gaps=0", methods: [], questions: [] };
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
    return { fileName, valid: false, errors: result.errors, gaps: result.gaps, headline, methods: [], questions: [] };
  }
  const groups = groupCohorts(result.rows);
  if (groups.length > MAX_COHORTS) {
    const message = "file has " + groups.length + " questions (run, prompt version and question id each count); the limit is " + MAX_COHORTS;
    return { fileName, valid: false, errors: [message], gaps: result.gaps, headline: "INVALID rows=" + result.rows.length + " errors=1", methods: [], questions: [] };
  }
  const seed = await fileSeed(text);
  const questions: QuestionVerdict[] = [];
  for (const { key, rows } of groups) {
    const metrics = metricsOfCohortRows(rows, key);
    try {
      const v = verdict(metrics, seed);
      questions.push({ question: metrics.question, questionId: key.questionId, runId: key.runId, promptVersion: key.promptVersion, verdict: v.verdict, reason: v.reason });
    } catch (error) {
      const why = error instanceof Error ? error.message : "no verdict";
      questions.push({ question: metrics.question, questionId: key.questionId, runId: key.runId, promptVersion: key.promptVersion, verdict: null, reason: why });
    }
  }
  return { fileName, valid: true, errors: [], gaps: result.gaps, headline, methods: summary(result.rows), questions };
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

/** The result panel. Every file-derived string goes through escapeHtml; the markup around it is fixed. */
export function renderResult(r: LoadedResult): string {
  const parts = [
    el("h3", r.valid ? "ld-word ld-valid" : "ld-word ld-invalid", r.valid ? "VALID" : "INVALID"),
    el("p", "ld-file", r.fileName + ": " + r.headline),
    list("ld-errors", "ERROR", r.errors),
    list("ld-gaps", "GAP", r.gaps),
  ];
  if (r.valid) {
    parts.push(el("h4", "ld-head", "Each method"), list("ld-methods", "", r.methods));
    const rows = r.questions.map(
      (q) =>
        '<li><span class="ld-id">' + escapeHtml("run " + q.runId + ", prompt " + q.promptVersion + ", question " + q.questionId) + "</span> " +
        '<span class="ld-q">' + escapeHtml(q.question) + '</span> <span class="ld-v">' + escapeHtml(q.verdict ?? "no verdict") +
        '</span> <span class="ld-why">' + escapeHtml(q.reason) + "</span></li>",
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
