import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { SESSION_TTL_MS } from "./auth.ts";
import { renderSignInPage } from "./sign-in-page.ts";
import { createHandler } from "./server.ts";

const privacyPath = "site/privacy/index.html";
const summary = "Backstage does not save your cases, runs or keys to a file or database on our server.";

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

test("[unit] #128 Bun serves the privacy page with a trailing slash", async () => {
  const handler = createHandler({ version: "test", staticRoot: "site" });
  const response = await handler(new Request("http://localhost:3456/privacy/"));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(summary);
  handler.close();
});

function badCitations(page: string): string[] {
  const source = page.match(/^<!--[\s\S]*?-->/)?.[0] ?? "";
  const bad: string[] = [];
  for (const match of source.matchAll(/^([\w./@-]+):([\d,-]+)/gm)) {
    const path = match[1] ?? "";
    const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").length : 0;
    for (const span of (match[2] ?? "").split(",")) {
      const [first, last] = span.split("-").map(Number);
      if (!first || first < 1 || (last !== undefined && (last < first || last > lines)) || first > lines) bad.push(`${path}:${span}`);
    }
  }
  return bad;
}

test("[unit] #128 every privacy source citation resolves to existing lines", async () => {
  const page = await Bun.file(privacyPath).text();
  expect(badCitations(page)).toEqual([]);
  expect(badCitations(page.replace("site/index.html:229", "site/index.html:999999"))).toContain("site/index.html:999999");
  expect(badCitations(page.replace("journald@jevnotjev-backstage.conf:1-5", "journald@jevnotjev-backstage.conf:1-999999"))).toContain(".deploy/journald@jevnotjev-backstage.conf:1-999999");
});

const allowedWriters = new Set(["tickets.ts", "trial.ts", "auth.ts", "api-tokens.ts"]);
const writer = /\b(?:writeFileSync|Bun\.write|appendFile(?:Sync)?|new Database|createWriteStream|openSync)\b/;
function unexpectedWriters(sources: ReadonlyMap<string, string>): string[] {
  return [...sources].filter(([name, source]) => !allowedWriters.has(name) && writer.test(source)).map(([name]) => name);
}

test("[unit] #128 a new server storage writer requires a privacy page update", async () => {
  const sources = new Map<string, string>();
  for (const path of new Bun.Glob("*.ts").scanSync({ cwd: "src/backstage" })) {
    if (!path.endsWith(".test.ts")) sources.set(path, await Bun.file(`src/backstage/${path}`).text());
  }
  expect(unexpectedWriters(sources)).toEqual([]);
  expect(unexpectedWriters(new Map([...sources, ["new-storage.ts", "Bun.write(path, data)"]]))).toContain("new-storage.ts");
});

function statedSessionHours(page: string): number | null {
  const match = page.match(/sign-in session cookie[^.]*?(\d+)-hour maximum age/i);
  return match ? Number(match[1]) : null;
}

test("[unit] #128 stated session cookie hours equal SESSION_TTL_MS", async () => {
  const page = await Bun.file(privacyPath).text();
  expect(statedSessionHours(page)).toBe(SESSION_TTL_MS / 3_600_000);
  expect(statedSessionHours(page.replace("12-hour maximum age", "13-hour maximum age"))).not.toBe(SESSION_TTL_MS / 3_600_000);
});

test("[unit] #128 scene draft directions name sign-out and closing the tab, never a clear action", async () => {
  const page = await Bun.file(privacyPath).text();
  expect(page).toMatch(/draft[^.]*sign out or close the tab/i);
  expect(page).not.toMatch(/draft[^.]*clear action/i);
});
