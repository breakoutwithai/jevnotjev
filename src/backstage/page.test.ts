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
  expect(page).toContain('id="jev-key"');
  expect(page).toContain('id="provider-keys"');
  expect(page).toContain('id="model-options"');
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

test("[smoke] JF1 Jev-only is the initial cast and comparisons require opt-in", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  expect(page).toContain('<input id="compare" type="checkbox" />');
  expect(page).toContain('id="llm-player" hidden');
  expect(page).toContain('id="rule-fields" hidden');
  expect(page).toContain("No Anthropic key needed");
  expect(page).toContain('id="comparison-note" hidden');
});

test("[smoke] JF5 privacy and copy guidance precede billable run controls", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  expect(page.indexOf('class="trust-sign"')).toBeLessThan(
    page.indexOf('id="run-one"'),
  );
  expect(page).toContain("mailto:jev@breakoutwithai.com");
  expect(page).toContain('id="copy-case"');
  expect(page).toContain('id="copy-cli"');
  expect(page).not.toContain("not saved or included in downloads");
});

test("[smoke] I88 irreversible steps use in-page confirm panels, not native dialogs", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  for (const step of ["judging", "reveal", "new-scene"]) {
    const id = `confirm-${step}`;
    expect(page).toContain(`id="${id}"`);
    expect(page).toContain(`id="${id}-yes"`);
    expect(page).toContain(`id="${id}-no"`);
    expect(page).toContain(`id="${id}-title"`);
    expect(page).toContain(`id="${id}-message"`);
    expect(page).toContain(`aria-labelledby="${id}-title"`);
    expect(page).toContain(`aria-describedby="${id}-message"`);
  }
  expect(page.match(/role="alertdialog"/g)?.length).toBe(3);
  const main = await Bun.file("src/backstage/main.ts").text();
  expect(main).not.toMatch(/\bconfirm\(/);
  expect(main).not.toMatch(/\balert\(|\bprompt\(/);
});

test("[smoke] D11 Learning Lines asks for synthetic or redacted cases before case entry", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  const notice = page.indexOf('id="case-safety"');
  expect(notice).toBeGreaterThan(page.indexOf('id="lines-title"'));
  expect(notice).toBeLessThan(page.indexOf('id="cases"'));
  const body = /<p id="case-safety"[^>]*>([\s\S]*?)<\/p>/.exec(page)?.[1] ?? "";
  const shown = body.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
  expect(shown).toContain("synthetic or redacted");
});
