import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { renderSignInPage } from "./sign-in-page.ts";

const BACKSTAGE_NOTICE = "Demo service. Use made-up or redacted data only. Cases you enter may be generalised and used for internal testing. We accept no responsibility for real data sent through our servers or to third-party language models.";
const PUBLIC_NOTICE = "Demo service. Use made-up or redacted data only. We accept no responsibility for real data loaded or entered here.";

function hidesNotice(style: string): boolean {
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?)\s*(?:!important\s*)?(?=;|$)/i.test(style);
}

function hiddenByAttributes(attributes: string): boolean {
  const style = /(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
  return /\shidden(?:\s|=|$)/i.test(attributes) || hidesNotice(style?.[1] ?? style?.[2] ?? style?.[3] ?? "");
}

function noticeInHtml(html: string, externalCss = ""): { text: string; hidden: boolean; index: number; ancestors: string[] } | null {
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
      stack.push({ tag: name, hidden: hiddenByAttributes(tag[2] ?? "") });
    }
  }
  const inlineCss = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((style) => style[1] ?? "").join("\n");
  const css = `${inlineCss}\n${externalCss}`.replace(/\/\*[\s\S]*?\*\//g, "");
  const hiddenByCss = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some((rule) =>
    /(?:^|[\s>+~,(])(?:html|body|p)(?=$|[\s>+~.#:[(,])|(?:^|[^\w-])\.demo-notice(?![\w-])/i.test(rule[1] ?? "") && hidesNotice(rule[2] ?? ""),
  );
  return { text: match[2] ?? "", hidden: hiddenByAttributes(match[1] ?? "") || stack.some((node) => node.hidden) || hiddenByCss, index, ancestors: stack.map((node) => node.tag) };
}

test("[unit] DN1 sign-in renders the exact Backstage notice for every message and Google setting", async () => {
  for (const message of [null, "signed-out", "locked", "busy", "google", "signin"]) {
    for (const googleConfigured of [true, false]) {
      const html = await renderSignInPage("/backstage/", message, googleConfigured, "default-src 'self'; style-src 'self'").text();
      expect(noticeInHtml(html)?.text).toBe(BACKSTAGE_NOTICE);
      expect(noticeInHtml(html)?.hidden).toBe(false);
    }
  }
});

test("[unit] DN2 sign-in notice is a footnote and its CSP authorizes the rendered style", async () => {
  const response = renderSignInPage("/backstage/", null, false, "default-src 'self'; style-src 'self'");
  const html = await response.text();
  expect(noticeInHtml(html)?.hidden).toBe(false);
  expect(noticeInHtml(html)?.ancestors).toEqual(["html", "body"]);
  expect(noticeInHtml(html)?.index).toBeGreaterThan(html.indexOf("</main>"));
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  expect(style).toContain(".demo-notice");
  expect(response.headers.get("content-security-policy")).toContain(`'sha256-${createHash("sha256").update(style).digest("base64")}'`);
});

test("[unit] DN3 Backstage app shows the exact notice once outside hidden rooms", async () => {
  const html = await Bun.file("site/backstage/index.html").text();
  const css = await Bun.file("site/backstage/backstage.css").text();
  expect(html.split(BACKSTAGE_NOTICE).length - 1).toBe(1);
  const notice = noticeInHtml(html, css);
  expect(notice?.text).toBe(BACKSTAGE_NOTICE);
  expect(notice?.hidden).toBe(false);
  expect(notice?.ancestors).toEqual(["html", "body"]);
  expect(notice?.index).toBeGreaterThan(html.indexOf("</main>"));
});

test("[unit] DN4 public stage shows the exact notice once outside hidden content", async () => {
  const html = await Bun.file("site/index.html").text();
  expect(html.split(PUBLIC_NOTICE).length - 1).toBe(1);
  const notice = noticeInHtml(html);
  expect(notice?.text).toBe(PUBLIC_NOTICE);
  expect(notice?.hidden).toBe(false);
  expect(notice?.ancestors).toEqual(["html", "body"]);
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

test("[unit] DN7 visibility helper detects hidden ancestors and notice CSS", () => {
  const notice = '<p class="demo-notice">Demo service.</p>';
  expect(noticeInHtml(`<div hidden>${notice}</div>`)?.hidden).toBe(true);
  expect(noticeInHtml(`<div style="display: none">${notice}</div>`)?.hidden).toBe(true);
  expect(noticeInHtml(`<div style="visibility: hidden">${notice}</div>`)?.hidden).toBe(true);
  expect(noticeInHtml(`<div style="opacity: 0">${notice}</div>`)?.hidden).toBe(true);
  expect(noticeInHtml('<p class="demo-notice" style="display: none">Demo service.</p>')?.hidden).toBe(true);
  expect(noticeInHtml(`<style>.demo-notice{display:none}</style>${notice}`)?.hidden).toBe(true);
  expect(noticeInHtml(notice, ".demo-notice { visibility: hidden }")?.hidden).toBe(true);
  const wrapped = `<html><head><style>.notice-wrapper{display:none}</style></head><body><div class="notice-wrapper">${notice}</div></body></html>`;
  expect(noticeInHtml(wrapped)?.ancestors).toEqual(["html", "body", "div"]);
  expect(noticeInHtml(`<style>body{display:none}</style>${notice}`)?.hidden).toBe(true);
  expect(noticeInHtml(notice, "p{visibility:hidden}")?.hidden).toBe(true);
  expect(noticeInHtml(`<html hidden><body>${notice}</body></html>`)?.hidden).toBe(true);
  expect(noticeInHtml(`<html><body style="opacity:0">${notice}</body></html>`)?.hidden).toBe(true);
  expect(noticeInHtml(notice)?.hidden).toBe(false);
});
