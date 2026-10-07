import { expect, test } from "bun:test";
import { PURPOSE_SENTENCE } from "./purpose.ts";
import { renderSignInPage } from "./sign-in-page.ts";

async function page(): Promise<string> {
  return (await Bun.file("site/backstage/index.html").text()).replace(/<!--[\s\S]*?-->/g, "");
}
function flat(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function openTag(html: string, id: string): string {
  return new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
}
function panel(html: string, index: number): string {
  return new RegExp(`<section data-panel="${index}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? "";
}
// The room title element, from its id to its closing tag.
function roomTitle(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  const end = html.indexOf("</" + "h2", start);
  return start < 0 || end < 0 ? "" : html.slice(start, end);
}

test("[smoke] UX-125 a focused room heading never shows the browser default ring", async () => {
  const css = await Bun.file("site/backstage/backstage.css").text();
  const rule = /h2\[tabindex="-1"\]:focus\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(rule).toMatch(/outline:\s*none/);
  const visible = /h2\[tabindex="-1"\]:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(visible).toMatch(/outline:\s*3px solid var\(--brass\)/);
});

test("[smoke] UX-C01 Run buttons point at a reachable reason and the estimate basis is stated", async () => {
  const html = await page();
  for (const id of ["run-one", "run-all"]) {
    const tag = openTag(html, id);
    expect(tag).toContain('aria-describedby="run-reason"');
    expect(tag).not.toMatch(/\sdisabled(\s|>|=)/);
  }
  expect(openTag(html, "run-reason")).toBeTruthy();
  const basis = flat(/<p[^>]*id="estimate-basis"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "");
  expect(basis).toContain("list prices");
  expect(basis).toContain("invoice");
});

test("[smoke] UX-C02 Casting says a key field appears per provider, and where a TypeSafe key comes from", async () => {
  const html = await page();
  const llm = /<div id="llm-player"[\s\S]*?<div id="provider-keys">/.exec(html)?.[0] ?? "";
  const hint = flat(/<p[^>]*id="key-hint"[^>]*>([\s\S]*?)<\/p>/.exec(llm)?.[1] ?? "");
  expect(hint).toContain("key field appears");
  expect(hint).toContain("tick one of its models");
  expect(llm.indexOf('id="key-hint"')).toBeLessThan(llm.indexOf('id="model-options"'));
  expect(openTag(html, "jev-key")).toContain('aria-describedby="jev-key-source"');
  const source = /<p[^>]*id="jev-key-source"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  expect(source).toContain('href="https://console.typesafe.ai/playground"');
  expect(flat(source)).toContain("TypeSafe API key");
  // No URL other than the Playground link already on the page.
  for (const href of source.matchAll(/href="([^"]+)"/g)) expect(href[1]).toBe("https://console.typesafe.ai/playground");
});

const jobs = ["Question", "Models and keys", "Test cases", "Judge answers", "Cost and downloads", "Result"];
const titles = ["scene-title", "casting-title", "lines-title", "rehearsal-title", "dress-title", "opening-title"];

test("[smoke] UX-C03 every room names its plain job in the nav and in its heading", async () => {
  const html = await page();
  const nav = /<nav[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
  jobs.forEach((job, index) => {
    const navButton = new RegExp(`<button data-room="${index}"[\\s\\S]*?</button`).exec(nav)?.[0] ?? "";
    expect(flat(navButton)).toContain(job);
    // A literal space keeps the accessible name from running the two labels together.
    expect(navButton).toContain(`</span> <small class="job">${job}</small>`);
    expect(flat(roomTitle(html, titles[index] ?? ""))).toContain(job);
  });
});

test("[smoke] UX-C03 acts run I to VI, one per room", async () => {
  const html = await page();
  const acts = [...html.matchAll(/<p class="eyebrow">ACT ([IVX]+) \//g)].map((match) => match[1]);
  expect(acts).toEqual(["I", "II", "III", "IV", "V", "VI"]);
  acts.forEach((act, index) => expect(panel(html, index)).toContain(`ACT ${act} /`));
});

test("[smoke] UX-C04 room 1 opens with a Before you start box naming every requirement", async () => {
  const html = await page();
  const room = panel(html, 0);
  const box = /<aside[^>]*id="before-you-start"[^>]*>[\s\S]*?<\/aside>/.exec(room)?.[0] ?? "";
  expect(room.indexOf('id="before-you-start"')).toBeGreaterThan(-1);
  expect(room.indexOf('id="before-you-start"')).toBeLessThan(room.indexOf('id="scene-fields"'));
  expect(openTag(box, "before-you-start")).not.toMatch(/\shidden(\s|>|=)/);
  const shown = flat(box);
  for (const required of ["Before you start", "your own Jev key", "billed to your own accounts", "30 paired, human-labelled cases", "synthetic or redacted data only", PURPOSE_SENTENCE])
    expect(shown).toContain(required);
});

test("[unit] UX-C04 the sign-in page carries the same purpose sentence", async () => {
  const html = await renderSignInPage("/backstage/", null, false, "default-src 'self'; style-src 'self'").text();
  expect(html).toContain(PURPOSE_SENTENCE);
  expect(PURPOSE_SENTENCE).toContain("not a chatbot");
});

test("[smoke] UX-C05 a skip link to the room heading comes first in the page", async () => {
  const html = await page();
  const body = html.slice(html.indexOf("<body>"));
  const skip = openTag(body, "skip-link");
  expect(skip).toContain('href="#scene-title"');
  expect(body.indexOf('id="skip-link"')).toBeLessThan(body.indexOf("<header>"));
});

test("[smoke] UX-C05 Reveal and Download keep their place in Tab order with a reason, and the CSV note sits beside Download", async () => {
  const html = await page();
  expect(openTag(html, "reveal")).toContain('aria-describedby="reveal-reason"');
  expect(openTag(html, "download-csv")).toContain('aria-describedby="download-reason csv-note"');
  expect(openTag(html, "download-evidence")).toContain('aria-describedby="download-reason"');
  for (const id of ["reveal", "download-csv", "download-evidence"]) expect(openTag(html, id)).not.toMatch(/\sdisabled(\s|>|=)/);
  const dress = panel(html, 4);
  const note = flat(/<p[^>]*id="csv-note"[^>]*>([\s\S]*?)<\/p>/.exec(dress)?.[1] ?? "");
  expect(note).toContain("Failed attempts are only in the run evidence file");
  expect(dress.indexOf('id="csv-note"')).toBeGreaterThan(dress.indexOf('id="download-evidence"'));
  expect(dress.indexOf('id="csv-note"') - dress.indexOf('id="download-evidence"')).toBeLessThan(400);
});

test("[smoke] UX-C03 Rehearsals reveal button reads the same in both modes", async () => {
  const main = await Bun.file("src/backstage/main.ts").text();
  expect(main).not.toContain('button("reveal").textContent');
  const html = await page();
  const label = flat(/<button id="reveal"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? "");
  expect(label).toBe("Finish judging and lock labels");
});
