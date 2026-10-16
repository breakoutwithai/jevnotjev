import { ingestPipeline, promptFor, samples } from "./ingest.ts";

function element(id: string): HTMLElement { const value = document.getElementById(id); if (!value) throw new Error(`Missing ${id}`); return value; }
function select(id: string): HTMLSelectElement { const value = element(id); if (!(value instanceof HTMLSelectElement)) throw new Error(`Invalid ${id}`); return value; }
function textarea(id: string): HTMLTextAreaElement { const value = element(id); if (!(value instanceof HTMLTextAreaElement)) throw new Error(`Invalid ${id}`); return value; }
const draft = textarea("draft"), instructions = textarea("instructions"), status = element("status"), preview = element("preview");
function updatePrompt(): void {
  const provider = select("provider").value;
  const mode = select("mode").value;
  instructions.value = promptFor(provider === "codex" ? "codex" : provider === "both" ? "both" : "claude", mode === "jev" ? "jev" : "host", { subscription: select("subscription").value, week: select("week").value });
}
for (const id of ["provider", "mode", "subscription", "week"]) element(id).addEventListener("change", updatePrompt);
element("copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(instructions.value); status.textContent = "Full instructions copied. Review them in your local assistant."; } catch { instructions.focus(); instructions.select(); status.textContent = "Select and copy the full instructions above."; } });
for (const sample of samples()) {
  const button = document.createElement("button"); button.type = "button"; button.textContent = `${sample.name} (synthetic)`;
  button.addEventListener("click", () => { draft.value = sample.text; preview.textContent = "Synthetic sample loaded. Validate it through the same path as your own report."; status.textContent = "Sample is synthetic and excluded from rankings."; });
  element("samples").append(button);
}
element("validate").addEventListener("click", async () => {
  const result = await ingestPipeline(draft.value, { progress: stage => { status.textContent = stage.replaceAll("-", " "); } });
  if (!result.ok) { status.textContent = `Needs correction: ${result.error} Draft retained.`; preview.textContent = "No map generated. No data published."; return; }
  const r = result.value;
  status.textContent = "Aggregate validated locally. Platform Jev checks NOT RUN. Nothing sent or published.";
  preview.textContent = `${r.synthetic ? "SYNTHETIC SAMPLE - excluded from rankings\n\n" : "PRIVATE LOCAL PREVIEW\n\n"}${r.map.sessions} sessions · ${r.map.days} days · ${r.period.basis.replaceAll("_", " ")}\nClaude output: ${r.tokens.claude.output.toLocaleString()} tokens\nCodex output: ${r.tokens.codex.output.toLocaleString()} tokens\nCoverage: ${r.coverage.accepted} accepted records, ${r.coverage.malformed} malformed, ${r.coverage.unsupported} unsupported\nSemantic subset: ${r.coverage.semantic_selected} of ${r.coverage.semantic_candidates} candidates\nLocal mode: ${r.analysis.mode}; status: ${r.analysis.status}\n${result.map ? "Legacy map projection available locally." : "Legacy map projection pending: Opus share unknown."}\n\nPublic-field preview (not submitted):\n${JSON.stringify(result.map, null, 2)}`;
});
updatePrompt();

element("platform").addEventListener("click", async () => {
  const local = await ingestPipeline(draft.value);
  if (!local.ok) { status.textContent = `Needs correction: ${local.error} Draft retained; nothing sent.`; return; }
  status.textContent = "Sending allowlisted aggregate to the platform preview endpoint. No publication requested.";
  try {
    const response = await fetch("/api/tokenmax/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(local.value) });
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) { status.textContent = "Platform preview did not accept the report. Draft retained; nothing published."; return; }
    const platform = "platform" in result ? result.platform : "pending";
    status.textContent = platform === "accepted" ? "Platform checks accepted this aggregate. Nothing published." : "Platform received and validated the aggregate. Platform Jev checks NOT RUN or pending. Nothing published.";
  } catch { status.textContent = "Platform unavailable. Draft retained; nothing published."; }
});
