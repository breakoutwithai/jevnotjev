import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { renderSignInPage } from "./sign-in-page.ts";

const BACKSTAGE_NOTICE = "Demo service. Use made-up or redacted data only. Cases you enter may be generalised and used for internal testing. We accept no responsibility for real data sent through our servers or to third-party language models.";
const PUBLIC_NOTICE = "Demo service. Use made-up or redacted data only. We accept no responsibility for real data loaded or entered here.";

function noticeInHtml(html: string): { text: string; hidden: boolean; index: number } | null {
  const start = html.indexOf('<p class="demo-notice"');
  if (start < 0) return null;
  const match = /^<p\b([^>]*)>([^<]*)<\/p>/.exec(html.slice(start));
  if (!match || !/\bclass="demo-notice"/.test(match[1] ?? "")) return null;
  const index = html.indexOf(match[0]);
  const stack: { tag: string; hidden: boolean }[] = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const tag of html.slice(0, index).matchAll(/<\/?([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const name = tag[1]?.toLowerCase() ?? "";
    if (tag[0].startsWith("</")) {
      let open = stack.length - 1;
      while (open >= 0 && stack[open]?.tag !== name) open -= 1;
      if (open >= 0) stack.length = open;
    } else if (!voidTags.has(name) && !tag[0].endsWith("/>")) {
      stack.push({ tag: name, hidden: /\shidden(?:\s|=|$)/i.test(tag[2] ?? "") });
    }
  }
  return { text: match[2] ?? "", hidden: /\shidden(?:\s|=|$)/i.test(match[1] ?? "") || stack.some((node) => node.hidden), index };
}

test("[unit] DN1 sign-in renders the exact Backstage notice for every message and Google setting", async () => {
  for (const message of [null, "signed-out", "locked", "busy", "google", "signin"]) {
    for (const googleConfigured of [true, false]) {
      const html = await renderSignInPage("/backstage/", message, googleConfigured, "default-src 'self'; style-src 'self'").text();
      expect(noticeInHtml(html)?.text).toBe(BACKSTAGE_NOTICE);
    }
  }
});

test("[unit] DN2 sign-in notice is a footnote and its CSP authorizes the rendered style", async () => {
  const response = renderSignInPage("/backstage/", null, false, "default-src 'self'; style-src 'self'");
  const html = await response.text();
  expect(noticeInHtml(html)?.index).toBeGreaterThan(html.indexOf("</main>"));
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  expect(style).toContain(".demo-notice");
  expect(response.headers.get("content-security-policy")).toContain(`'sha256-${createHash("sha256").update(style).digest("base64")}'`);
});

test("[unit] DN3 Backstage app shows the exact notice once outside hidden rooms", async () => {
  const html = await Bun.file("site/backstage/index.html").text();
  expect(html.split(BACKSTAGE_NOTICE).length - 1).toBe(1);
  const notice = noticeInHtml(html);
  expect(notice?.text).toBe(BACKSTAGE_NOTICE);
  expect(notice?.hidden).toBe(false);
  expect(notice?.index).toBeGreaterThan(html.indexOf("</main>"));
});

test("[unit] DN4 public stage shows the exact notice once outside hidden content", async () => {
  const html = await Bun.file("site/index.html").text();
  expect(html.split(PUBLIC_NOTICE).length - 1).toBe(1);
  const notice = noticeInHtml(html);
  expect(notice?.text).toBe(PUBLIC_NOTICE);
  expect(notice?.hidden).toBe(false);
  expect(notice?.index).toBeGreaterThan(html.indexOf("</main>"));
});

test("[unit] DN5 public and Backstage notice wording stays scoped to each page", async () => {
  const publicPage = await Bun.file("site/index.html").text();
  const backstagePage = await Bun.file("site/backstage/index.html").text();
  const signInPage = await renderSignInPage("/backstage/", null, false, "style-src 'self'").text();
  expect(noticeInHtml(publicPage)?.text).not.toMatch(/servers|language models/);
  for (const html of [backstagePage, signInPage]) {
    expect(noticeInHtml(html)?.text).not.toMatch(/What you enter|keys/);
  }
});

test("[unit] DN6 notice pages and sign-in source contain no em or en dashes", async () => {
  for (const file of ["src/backstage/sign-in-page.ts", "site/backstage/index.html", "site/index.html"]) {
    const source = await Bun.file(file).text();
    expect(source).toContain("Demo service.");
    expect(source).not.toMatch(/[\u2013\u2014]/);
  }
});
