import { expect, test } from "bun:test";

test("[smoke] B1 six accessible rooms and real key/run controls", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  for (const title of [
    "New Scene",
    "Casting",
    "Learning Lines",
    "Rehearsals",
    "Dress Rehearsal",
    "Opening Night",
  ])
    expect(page).toContain(title);
  expect(page.match(/type="password"/g)).toHaveLength(2);
  for (const id of [
    "run-one",
    "run-all",
    "stop",
    "retry",
    "clear-keys",
    "download-csv",
    "download-evidence",
  ])
    expect(page).toContain(`id="${id}"`);
  expect(page).toContain('aria-live="polite"');
  expect(page).not.toContain("onclick=");
});

test("[smoke] JO4 Jev-only is the initial cast and comparisons require opt-in", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  expect(page).toContain('<input id="compare" type="checkbox" />');
  expect(page).toContain('id="llm-player" hidden');
  expect(page).toContain('id="rule-fields" hidden');
  expect(page).toContain("No Anthropic key needed");
  expect(page).toContain('id="comparison-note" hidden');
});
