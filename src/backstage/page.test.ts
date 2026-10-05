import { expect, test } from "bun:test";

test("[smoke] SO1 header sign-out and hidden kept-login warning", async () => {
  const page = await Bun.file("site/backstage/index.html").text();
  const header = page.match(/<header>([\s\S]*?)<\/header>/)?.[1] ?? "";
  expect(header).toMatch(/<button\b[^>]*\bid="sign-out"[^>]*\btype="button"[^>]*>Sign out<\/button>/);
  expect(header).toMatch(/<button\b[^>]*\bid="theme"[^>]*>House Lights<\/button>/);
  expect((header.match(/id="sign-out"/g) ?? []).length).toBe(1);
  expect((header.match(/id="theme"/g) ?? []).length).toBe(1);
  const warning = page.match(/<main>\s*(<p\b[^>]*\bid="signed-out"[^>]*>[\s\S]*?<\/p>)/)?.[1] ?? "";
  expect(warning).toContain("hidden");
  expect(warning).toContain('role="alert"');
  expect(warning).toContain("Quit the browser");
  expect(page).not.toContain("onclick=");
});

test("[smoke] SO5 sign-out shares clearKeys and clears the scene", async () => {
  const main = await Bun.file("src/backstage/main.ts").text();
  expect(main).toMatch(/from "\.\/signout\.ts"/);
  expect(main).toMatch(/button\("clear-keys"\)\.onclick\s*=\s*\(\)\s*=>\s*\{\s*clearKeys\(\)/);
  expect(main).toMatch(/button\("sign-out"\)\.onclick[\s\S]*?clear:\s*\(\)\s*=>\s*\{\s*clearKeys\(\);\s*clearScene\(\)/);
  expect(main).toContain("location.replace(url)");
  expect(main).not.toMatch(/\b(?:alert|confirm|prompt)\(/);
});

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
  const page = (await Bun.file("site/backstage/index.html").text()).replace(
    /<!--[\s\S]*?-->/g,
    "",
  );
  const title = page.indexOf('id="lines-title"');
  const cases = page.indexOf('id="cases"');
  expect(title).toBeGreaterThan(-1);
  const notice = [...page.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)].find((m) =>
    /\bid="case-safety"/.test(m[1] ?? ""),
  );
  expect(notice?.index ?? -1).toBeGreaterThan(title);
  expect(notice?.index ?? Infinity).toBeLessThan(cases);
  expect(` ${notice?.[1] ?? ""}`).not.toMatch(
    /\shidden(\s|=|$)|display:\s*none|\bsr-only\b/,
  );
  const shown = (notice?.[2] ?? "").replace(/\s+/g, " ");
  for (const message of [
    "synthetic or redacted",
    "personal or customer data",
    "sent to every provider you select",
  ])
    expect(shown).toContain(message);
});
