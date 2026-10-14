import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PURPOSE_SENTENCE } from "./purpose.ts";
import { renderSignInPage } from "./sign-in-page.ts";

async function page(): Promise<string> {
  return (await Bun.file("site/backstage/index.html").text()).replace(/<!--[\s\S]*?-->/g, "");
}
function flat(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function openTag(html: string, id: string): string {
  return new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
}
function panel(html: string, index: number): string {
  return new RegExp(`<section data-panel="${index}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? "";
}
function firstStep(html: string): string {
  const entry = /<div class="topic-entry">[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
  return entry + panel(html, 0);
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

const jobs = ["Your question", "Who answers", "Your cases", "Judge the answers", "Cost and downloads", "Verdict"];
const titles = ["scene-title", "casting-title", "lines-title", "rehearsal-title", "dress-title", "opening-title"];
const plainSteps = ["Your question", "Who answers", "Your cases", "Judge the answers", "Cost and downloads", "Verdict"];
const theatreSteps = ["New Scene", "Casting", "Learning Lines", "Rehearsals", "Dress Rehearsal", "Opening Night"];

test("[smoke] W5 every pre-existing Backstage id survives", async () => {
  const html = await page();
  const oldIds = [...html.matchAll(/id="([^"]+)"/g)]
    .map((match) => match[0])
    .filter((id) => !["topic-heading","start-pack","question-hint","cases-mutation-preview","cases-replace","confirm-replace","confirm-replace-title","confirm-replace-message","confirm-replace-yes","confirm-replace-no","fix-run","review-run"].some((added) => id === 'id="' + added + '"'))
    .sort();
  const digest = (ids: readonly string[]) => createHash("sha256").update(ids.join("\n") + "\n").digest("hex");
  expect(digest(oldIds)).toBe("5143692d364687a22ce0f9219673fb8ad72e129931ec7e61f4a93d7600e8e1b2");
  expect(digest(oldIds.slice(1))).not.toBe(digest(oldIds));
});

test("[smoke] W5 the first heading asks for the tester's question before the first field", async () => {
  const html = await page();
  expect(flat(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "")).toBe("What do you want to decide?");
  const firstField = /<(?:input|textarea|select)\b[^>]*\bid="([^"]+)"/.exec(html);
  expect(firstField?.[1]).toBe("question");
  expect(flat(html.slice(html.indexOf("<main>"), firstField?.index ?? 0))).not.toMatch(/\b(?:Scene|Casting|Learning Lines|Rehearsals|Dress Rehearsal|Opening Night|Act)\b/i);
});

test("[smoke] W5 workspace navigation uses three task-oriented targets without theatre subtitles",async()=>{const html=await page();const nav=/<nav[\s\S]*?<\/nav>/.exec(html)?.[0]??"";expect(flat(nav)).toContain("Setup and run");expect(flat(nav)).toContain("Review answers");expect(flat(nav)).toContain("Results and downloads");expect(nav.match(/data-room=/g)).toHaveLength(3);for(const word of theatreSteps)expect(nav).not.toContain(word);});
test("[smoke] W5 each step starts with one Jev tutorial sentence before controls", async () => {
  const html = await page();
  plainSteps.forEach((_, index) => {
    const room = index === 0 ? firstStep(html) : panel(html, index);
    const tutorial = /<p class="direction">([\s\S]*?)<\/p>/.exec(room);
    const sentence = flat(tutorial?.[1] ?? "");
    expect(sentence).toMatch(/^Jev .*\.$/);
    expect(sentence.match(/[.!?]/g)?.length).toBe(1);
    const firstControl = room.search(/<(?:input|textarea|select|button)\b/);
    if (firstControl >= 0) expect(tutorial?.index ?? Infinity).toBeLessThan(firstControl);
  });
});

test("[unit] W5 heading, field order, tab priority and tutorial checks reject mutations", async () => {
  const html = await page();
  const firstHeading = (source: string) => flat(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(source)?.[1] ?? "");
  const firstField = (source: string) => /<(?:input|textarea|select)\b[^>]*\bid="([^"]+)"/.exec(source)?.[1];
  const firstTab = (source: string) => flat(/<button data-room="0"[^>]*>([\s\S]*?)<\/button>/.exec(source)?.[1] ?? "");
  const firstTutorial = (source: string) => flat(/<p class="direction">([\s\S]*?)<\/p>/.exec(firstStep(source))?.[1] ?? "");
  expect(firstHeading(html.replace("What do you want to decide?</h1>", "Backstage Pass</h1>"))).not.toBe("What do you want to decide?");
  expect(firstField(html.replace('<textarea id="question"', '<input id="premature"><textarea id="question"'))).not.toBe("question");
  expect(firstTab(html)).toBe("Setup and run");
  expect(firstTab(html.replace("Setup and run</button>","New Scene</button>"))).not.toBe("Setup and run");
  expect(firstTutorial(html.replace("Jev answers your question with one of your two choices and how sure it is so you can test which answers to keep.</p>", "Set the scene before the first call.</p>"))).not.toMatch(/^Jev .*\.$/);
});

test("[smoke] UX-C03 workspace targets reference accessible headings for setup review and results",async()=>{const html=await page();for(const [id,name] of [["scene-title","Your question"],["rehearsal-title","Judge the answers"],["dress-title","Cost and downloads"]]){expect(flat(roomTitle(html,id??""))).toContain(name??"");expect(openTag(html,id??"")).toContain('tabindex="-1"');}});
test("[smoke] W5 all sections have plain headings without theatre subtitles",async()=>{const html=await page();titles.forEach((title,index)=>{expect(flat(roomTitle(html,title))).toContain(jobs[index]??"");expect(roomTitle(html,title)).not.toContain('class="job"');});});
test("[smoke] UX-C04 room 1 opens with a Before you start box naming every requirement", async () => {
  const html = await page();
  const room = panel(html, 0);
  const box = /<aside[^>]*id="before-you-start"[^>]*>[\s\S]*?<\/aside>/.exec(room)?.[0] ?? "";
  expect(room.indexOf('id="before-you-start"')).toBeGreaterThan(-1);
  expect(room.indexOf('id="before-you-start"')).toBeGreaterThan(room.indexOf('id="scene-fields"'));
  expect(openTag(box, "before-you-start")).not.toMatch(/\shidden(\s|>|=)/);
  const shown = flat(box);
  for (const required of ["Before you start", "your own Jev key", "billed to your own provider accounts", "30 paired, human-labelled cases", "synthetic or redacted data only", PURPOSE_SENTENCE])
    expect(shown).toContain(required);
  expect(box).toContain('href="/guide/"');
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
