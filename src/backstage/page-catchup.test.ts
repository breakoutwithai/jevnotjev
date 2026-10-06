import { expect, test } from "bun:test";
import { parseCases } from "./run.ts";

/** Problems with the Act I credentials note in a page; empty when a user sees it before the first field. */
function sceneNoteProblems(markup: string): string[] {
  const page = markup.replace(/<!--[\s\S]*?-->/g, "");
  const problems: string[] = [];
  const legend = page.indexOf("Your decision");
  const question = page.indexOf('id="question"');
  const note = [...page.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)].find((m) =>
    /\bid="scene-safety"/.test(m[1] ?? ""),
  );
  if (!note) return ["missing"];
  if ((note.index ?? -1) < legend) problems.push("above the legend");
  if ((note.index ?? Infinity) > question) problems.push("after the first field");
  const attrs = ` ${note[1] ?? ""}`;
  if (/\shidden(\s|=|$)|display:\s*none|\bsr-only\b/.test(attrs))
    problems.push("not visible");
  if (!/class="[^"]*\btrust-sign\b/.test(attrs)) problems.push("not styled as a sign");
  const shown = (note[2] ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
  for (const message of [
    "API keys",
    "passwords",
    "private data",
    "synthetic or redacted",
    "key field",
  ])
    if (!shown.includes(message)) problems.push(`lacks "${message}"`);
  return problems;
}

test("[smoke] D10 the scene form warns against credentials and private data before the first field", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  expect(sceneNoteProblems(page)).toEqual([]);
});

test("[unit] D10 the scene note check fails each way the note could vanish", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  const note = /<p id="scene-safety"[^>]*>[\s\S]*?<\/p>/.exec(page)?.[0] ?? "";
  expect(note).not.toBe("");
  const open = /<p id="scene-safety"[^>]*>/.exec(note)?.[0] ?? "";
  const mutants: Record<string, string> = {
    removed: page.replace(note, ""),
    empty: page.replace(note, `${open}</p>`),
    hidden: page.replace(open, open.replace("<p ", "<p hidden ")),
    srOnly: page.replace(open, open.replace('class="', 'class="sr-only ')),
    unstyled: page.replace(open, open.replace("trust-sign", "plain")),
    shortened: page.replace(note, `${open}Be careful.</p>`),
    movedAfterFirstField: page
      .replace(note, "")
      .replace('<div class="columns">', `${note}<div class="columns">`),
    keysDropped: page.replace("API keys", "tokens"),
    privateDropped: page.replace("private data", "secrets"),
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    expect(mutant).not.toBe(page);
    expect([name, sceneNoteProblems(mutant).length > 0]).toEqual([name, true]);
  }
});

test("[smoke] D11 a sample cases file sits next to the import control and parses", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  const control = page.indexOf('id="import-cases"');
  const link = /<a\b[^>]*href="\.\/sample-cases\.csv"[^>]*>([^<]+)<\/a>/.exec(page);
  expect(link?.[1]).toContain("sample");
  expect(link?.index ?? -1).toBeGreaterThan(control);
  expect((link?.index ?? Infinity) - control).toBeLessThan(400);
  const csv = await Bun.file("site/backstage/sample-cases.csv").text();
  const cases = parseCases(csv);
  expect(cases.length).toBeGreaterThanOrEqual(3);
  expect(cases.some((c) => c.input.includes(","))).toBe(true);
  expect(csv).not.toMatch(/@|\d{6,}|sk-|key/i);
});

/** Markup problems for the leave-out slot; the rendered text and visibility are asserted in main.dom.test.ts. */
function leaveOutSlotProblems(page: string): string[] {
  const rubric = page.indexOf('id="rubric"');
  const slot = /<p id="leave-out"([^>]*)>/.exec(page);
  if (!slot) return ["missing"];
  const problems: string[] = [];
  const distance = slot.index - rubric;
  if (rubric < 0 || distance <= 0 || distance >= 120) problems.push("not beside the keep rule");
  if (/\s(hidden|style)\b|\bsr-only\b/.test(` ${slot[1] ?? ""}`)) problems.push("hidden or styled away");
  return problems;
}

test("[smoke] D10 the judging page has a visible leave-out slot beside the keep rule", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  expect(leaveOutSlotProblems(page)).toEqual([]);
  const slot = '<p id="leave-out">';
  const mutants = [
    page.replace(slot, '<p id="leave-out" hidden>'),
    page.replace(slot, '<p id="leave-out" class="sr-only">'),
    page.replace(slot, '<p id="leave-out" style="display:none">'),
    page.replace(slot, ""),
    page.replace(`${slot}</p>`, "").replace('<p id="rubric"></p>', `<p id="rubric"></p><div>${"x".repeat(150)}</div>${slot}</p>`),
  ];
  for (const mutant of mutants) {
    expect(mutant).not.toBe(page);
    expect(leaveOutSlotProblems(mutant).length).toBeGreaterThan(0);
  }
});

test("[smoke] D10 the persistence copy is qualified by what the browser allows", async () => {
  const page = (await Bun.file("site/backstage/index.html").text()).replace(/\s+/g, " ");
  expect(page).toContain("When the browser allows storage, refreshing keeps your scene text in this tab");
  expect(page).toContain("a notice appears here if it cannot be kept");
  const status = /<p id="draft-status"([^>]*)>/.exec(page);
  expect(status).not.toBeNull();
  expect(` ${status?.[1] ?? ""}`).not.toMatch(/\s(hidden|style)\b|sr-only/);
  expect(status?.[1]).toContain('role="status"');
});
