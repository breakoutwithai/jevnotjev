// The question admin page (#278): server-rendered HTML for /backstage/questions/. Every stored value is escaped
// before it reaches the markup; the one inline script and style are pinned by hash in the page's own CSP, so the
// page runs nothing else and loads nothing from another origin.
import { createHash } from "node:crypto";
import { TRANSITIONS, type QuestionState } from "./contract.ts";
import type { QuestionRow, QueueEntry } from "./store.ts";

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem;color:#1d1d1f}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #ddd}
pre{white-space:pre-wrap;background:#f4f4f5;padding:.75rem;border:1px solid #ddd}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{font-weight:600}
textarea{width:100%;min-height:8rem;font:inherit}label{display:block;margin:.5rem 0}#result{font-weight:600}`;

const SCRIPT = `const form = document.getElementById("reply");
if (form) form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const out = document.getElementById("result");
  const data = new FormData(form);
  const body = { version: Number(data.get("version")), to: String(data.get("to")) };
  const text = String(data.get("text") || "");
  if (text.trim() !== "") { body.text = text; body.source = String(data.get("source")); }
  out.textContent = "Saving";
  try {
    const res = await fetch(form.dataset.action, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const reply = await res.json();
    if (res.ok) { location.reload(); return; }
    out.textContent = "Refused: " + (reply.code || res.status);
  } catch { out.textContent = "Request failed"; }
});`;

const digest = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** The page's CSP: its own inline script and style by hash, fetches to this origin only, nothing else. */
export const ADMIN_PAGE_CSP = `default-src 'none'; script-src ${digest(SCRIPT)}; style-src ${digest(STYLE)}; connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": ADMIN_PAGE_CSP,
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

function heading(level: 1 | 2, text: string): string {
  return `<h${level}>${escapeHtml(text)}</h${level}>\n`;
}

function page(title: string, parts: readonly string[], status = 200): Response {
  const head = `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>` +
    `<style>${STYLE}</style></head>`;
  const html = [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    head,
    "<body>",
    ...parts,
    `<script>${SCRIPT}</script>`,
    "</body></html>",
  ].join("\n");
  return new Response(html, { status, headers: HEADERS });
}

const BACK_LINK = `<p><a href="/backstage/questions/">All questions</a></p>`;

export function renderAdminList(entries: readonly QueueEntry[]): Response {
  const rows = entries.map((e) =>
    `<tr><td><a href="/backstage/questions/?id=${escapeHtml(e.id)}">${escapeHtml(e.id)}</a></td><td>${escapeHtml(e.kind)}</td><td>${escapeHtml(e.state)}</td><td>v${e.version}</td><td>${escapeHtml(e.scope)}</td><td>${escapeHtml(e.created_at)}</td><td>${escapeHtml(e.updated_at)}</td></tr>`);
  const summary = `<p>${entries.length} question${entries.length === 1 ? "" : "s"}, newest first</p>`;
  const table = entries.length === 0
    ? "<p>No questions yet</p>"
    : ["<table><thead><tr><th>Id</th><th>Kind</th><th>State</th><th>Version</th><th>Scope</th><th>Created</th><th>Updated</th></tr></thead><tbody>", ...rows, "</tbody></table>"].join("\n");
  return page("Questions", [heading(1, "Questions"), summary, table]);
}

function nextStates(state: QuestionState): QuestionState[] {
  return TRANSITIONS.filter(([from]) => from === state).map(([, to]) => to);
}

export function renderAdminDetail(row: QuestionRow): Response {
  const field = (label: string, value: string): string => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`;
  const next = nextStates(row.state);
  const facts = [
    field("Kind", row.kind), ...(row.page === null ? [] : [field("From page", row.page)]),
    field("State", row.state), field("Version", String(row.version)), field("Scope", row.scope),
    field("Created", row.created_at), field("Updated", row.updated_at), field("Email", row.email ?? "none (guest token)"),
    field("Reply consent", row.reply_consent === 1 ? "yes" : "no"), field("Marketing consent", row.marketing_consent === 1 ? "yes" : "no"),
  ].join("");
  const reply = row.response === null
    ? "<p>No reply yet</p>"
    : `<pre>${escapeHtml(row.response)}</pre>\n<p>Source: ${escapeHtml(row.response_source ?? "-")}</p>`;
  const form = next.length === 0
    ? "<p>No further state change is allowed from this state</p>"
    : [
        `<form id="reply" data-action="/api/backstage/questions/${escapeHtml(row.id)}/reply">`,
        `<input type="hidden" name="version" value="${row.version}">`,
        `<label>Move to <select name="to">${next.map((s) => `<option value="${s}">${s}</option>`).join("")}</select></label>`,
        `<label>Reply or note (required for needs_info and answered)<textarea name="text">${escapeHtml(row.response ?? "")}</textarea></label>`,
        `<label>Source <select name="source"><option value="human_reviewed">human_reviewed</option><option value="template">template</option></select></label>`,
        `<button type="submit">Save</button> <span id="result" role="status"></span>`,
        "</form>",
      ].join("\n");
  const title = `Question ${row.id}`;
  return page(title, [
    BACK_LINK, heading(1, row.id), `<dl>${facts}</dl>`,
    heading(2, "Question"), `<pre>${escapeHtml(row.question)}</pre>`,
    heading(2, "Reply"), reply,
    heading(2, "Change"), form,
  ]);
}

export function renderAdminNotFound(): Response {
  return page("Question not found", [BACK_LINK, heading(1, "Question not found")], 404);
}
