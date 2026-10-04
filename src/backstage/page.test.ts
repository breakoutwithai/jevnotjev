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
