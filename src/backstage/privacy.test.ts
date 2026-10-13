import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { renderSignInPage } from "./sign-in-page.ts";
import { createHandler } from "./server.ts";

const privacyPath = "site/privacy/index.html";
const summary = "Backstage does not store your cases, runs or provider keys on our server.";

test("[unit] #128 privacy page exists with valid source paths and plain punctuation", async () => {
  expect(existsSync(privacyPath)).toBe(true);
  if (!existsSync(privacyPath)) return;
  const page = await Bun.file(privacyPath).text();
  expect(page).not.toMatch(/[\u2013\u2014]/);
  expect(page).not.toMatch(/challenge|ranking|competition/i);
  expect(page).not.toMatch(/<script\b/i);
  for (const heading of ["What we keep", "What we do not keep", "What leaves your browser", "How long", "How to get your data deleted", "Not decided yet"]) {
    expect(page).toContain(`<h2>${heading}</h2>`);
  }
  const sourceBlock = page.match(/^<!--[\s\S]*?-->/)?.[0] ?? "";
  expect(sourceBlock).toContain("docs/product/what-is-stored.md:");
  for (const citation of sourceBlock.matchAll(/(src\/[\w/.-]+\.ts):\d+/g)) {
    expect(existsSync(citation[1] ?? "")).toBe(true);
  }
  expect(page).toContain(`<p id="data-summary">${summary}</p>`);
});

test("[unit] #128 every demo notice repeats the privacy summary exactly", async () => {
  const page = await Bun.file(privacyPath).text();
  const stated = page.match(/<p id="data-summary">([^<]+)<\/p>/)?.[1];
  expect(stated).toBe(summary);
  const signIn = await renderSignInPage("/backstage/", null, false, "style-src 'self'").text();
  for (const html of [signIn, ...await Promise.all(["site/backstage/index.html", "site/index.html", "site/guide/index.html"].map((path) => Bun.file(path).text()))]) {
    const notice = html.match(/Demo service\.[\s\S]*?<\/p>/)?.[0] ?? "";
    expect(notice).toContain(summary);
    expect(notice.split(summary).length - 1).toBe(1);
  }
});

test("[unit] #128 sign-in, Casting, Learning Lines, footers and ticket office link to privacy", async () => {
  const signIn = await renderSignInPage("/backstage/", null, false, "style-src 'self'").text();
  const backstage = await Bun.file("site/backstage/index.html").text();
  const publicPage = await Bun.file("site/index.html").text();
  const guide = await Bun.file("site/guide/index.html").text();
  const inElement = (html: string, opening: string, close: string): string => html.split(opening, 2)[1]?.split(close, 1)[0] ?? "";
  for (const [html, opening, close] of [
    [signIn, '<p class="demo-notice">', "</p>"],
    [backstage, '<aside class="trust-sign" aria-label="Keys and privacy">', "</aside>"],
    [backstage, '<p id="case-safety" class="trust-sign">', "</p>"],
    [backstage, '<p class="demo-notice">', "</p>"],
    [publicPage, '<p class="tk-privacy">', "</p>"],
    [publicPage, '<p class="demo-notice">', "</p>"],
    [guide, "<footer>", "</footer>"],
  ]) {
    expect(inElement(html ?? "", opening ?? "", close ?? "")).toContain('<a href="/privacy/">How we handle data</a>');
  }
});

test("[unit] #128 outdated data-use claim is absent outside the open point", async () => {
  for (const dir of ["site", "src"]) {
    const paths = [...new Bun.Glob("**/*.{html,ts}").scanSync({ cwd: dir })];
    for (const path of paths) {
      if (path.endsWith("privacy.test.ts")) continue;
      const source = await Bun.file(`${dir}/${path}`).text();
      if (path === "privacy/index.html") continue;
      expect(source).not.toMatch(/may be generalised and used for internal testing/i);
    }
  }
});

test("[unit] #128 Bun serves the privacy page with and without a trailing slash", async () => {
  const handler = createHandler({ version: "test", staticRoot: "site" });
  for (const path of ["/privacy/", "/privacy"]) {
    const response = await handler(new Request(`http://localhost:3456${path}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(summary);
  }
  handler.close();
});
