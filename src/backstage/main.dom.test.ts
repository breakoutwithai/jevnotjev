import { expect, test } from "bun:test";
import { CATALOG_VERSION } from "./catalog.ts";
import { PROTOCOL_VERSION, type AnswerRequest } from "./contracts.ts";
import { getModelEntry } from "./catalog.ts";
import { inputFingerprint } from "./run.ts";
import { SCENE_DRAFT_KEY } from "./scene-draft.ts";

class FakeNode extends EventTarget {
  children: FakeNode[] = [];
  textContent = "";
  constructor(readonly tagName: string) { super(); }
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeNode[]) { this.children = nodes; this.textContent = ""; }
}

class FakeElement extends FakeNode {
  id = "";
  type = "";
  value = "";
  checked = false;
  hidden = false;
  disabled = false;
  className = "";
  dataset: Record<string, string> = {};
  onclick: (() => void) | null = null;
  private attributes = new Map<string, string>();
  owner: FakeDocument | undefined;
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
    if (name === "type") this.type = value;
    if (name === "value") this.value = value;
    if (name === "class") this.className = value;
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
    if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  attributeText(): string { return [...this.attributes.values(), this.value].join("\n"); }
  focus() { if (this.owner) this.owner.activeElement = this; }
  click() { this.onclick?.(); this.dispatchEvent(new Event("click")); }
}
class FakeInput extends FakeElement { files: File[] | null = null; }
class FakeTextArea extends FakeElement {}
class FakeButton extends FakeElement {}
class FakeFieldSet extends FakeElement {}

class FakeDocument {
  readonly documentElement = new FakeElement("HTML");
  activeElement: FakeElement | null = null;
  private elements: FakeElement[] = [];
  createElement(tag: string): FakeElement {
    const upper = tag.toUpperCase();
    const element = upper === "INPUT" ? new FakeInput(upper)
      : upper === "TEXTAREA" ? new FakeTextArea(upper)
      : upper === "BUTTON" ? new FakeButton(upper)
      : upper === "FIELDSET" ? new FakeFieldSet(upper)
      : new FakeElement(upper);
    element.owner = this;
    this.elements.push(element);
    return element;
  }
  createTextNode(value: string): FakeNode { const node = new FakeNode("#text"); node.textContent = value; return node; }
  getElementById(id: string): FakeElement | null { return this.elements.find((element) => element.id === id) ?? null; }
  /** Everything in the connected tree from the page's root element: text, attributes and field values, hidden or not. */
  connectedText(): string {
    const walk = (node: FakeNode): string =>
      [node.textContent, node instanceof FakeElement ? node.attributeText() : "", ...node.children.map(walk)].join("\n");
    const root = this.elements[0];
    return root === undefined ? "" : walk(root);
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector === "[data-panel]") return this.elements.filter((element) => element.dataset.panel !== undefined);
    if (selector === "[data-room]") return this.elements.filter((element) => element.dataset.room !== undefined);
    if (selector === "[data-arm]:checked") return this.elements.filter((element) => element.dataset.arm !== undefined && element.checked);
    throw new Error(`Unexpected selector: ${selector}`);
  }
  querySelector(selector: string): FakeElement | null {
    const match = /^\[data-panel="(\d+)"\] h2$/.exec(selector);
    if (!match) throw new Error(`Unexpected selector: ${selector}`);
    const panel = this.elements.find((element) => element.dataset.panel === match[1]);
    const findHeading = (node: FakeNode): FakeElement | null => {
      for (const child of node.children) {
        if (child instanceof FakeElement && child.tagName === "H2") return child;
        const nested = findHeading(child);
        if (nested) return nested;
      }
      return null;
    };
    return panel ? findHeading(panel) : null;
  }
}

function documentFromMarkup(markup: string): FakeDocument {
  const document = new FakeDocument();
  const stack: FakeElement[] = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  for (const token of markup.matchAll(/<\/?[a-z][^>]*>/gi)) {
    const raw = token[0];
    if (raw.startsWith("</")) { stack.pop(); continue; }
    const tag = /^<([a-z][\w-]*)/i.exec(raw)?.[1]?.toLowerCase();
    if (!tag) throw new Error(`Cannot parse tag ${raw}`);
    const element = document.createElement(tag);
    for (const attr of raw.slice(tag.length + 1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      const name = attr[1];
      if (name) element.setAttribute(name, attr[2] ?? "");
    }
    stack.at(-1)?.append(element);
    if (!voidTags.has(tag) && !raw.endsWith("/>")) stack.push(element);
  }
  return document;
}

let importNumber = 0;
function redirectedResponse(): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "redirected", { value: true });
  return response;
}
class FakeStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
}
async function mount(health = new Response(JSON.stringify({ trial: { available: true }, protocol: PROTOCOL_VERSION, version: "so6-test", catalogVersion: CATALOG_VERSION }), { status: 200, headers: { "content-type": "application/json" } }), signOutResponse: Response | Error = redirectedResponse(), store = new FakeStorage(), answer?: (request: AnswerRequest) => Promise<unknown>, search = "") {
  const document = documentFromMarkup(await Bun.file("site/backstage/index.html").text());
  const urls: string[] = [];
  const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
  const replacements: string[] = [];
  const historyCalls: unknown[][] = [];
  const location = { search, pathname: "/backstage/", origin: "https://example.test", replace: (url: string) => replacements.push(url) };
  const window = new EventTarget();
  Object.assign(window, { location });
  Object.assign(globalThis, {
    document, window, location,
    sessionStorage: store,
    history: { replaceState: (...args: unknown[]) => historyCalls.push(args) },
    navigator: { clipboard: { writeText: async (_value: string) => {} } },
    matchMedia: (_query: string) => ({ matches: false }),
    XMLHttpRequest: class { constructor() { throw new Error("No XMLHttpRequest may be constructed"); } },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    HTMLButtonElement: FakeButton,
    HTMLFieldSetElement: FakeFieldSet,
    BACKSTAGE_BUILD_VERSION: "so6-test",
    fetch: async (input: string, init?: RequestInit) => {
      urls.push(input);
      requests.push({ input, init });
      if (input === "/api/auth/sign-out") {
        if (signOutResponse instanceof Error) throw signOutResponse;
        return signOutResponse;
      }
      if (input === "/api/backstage/answer" && answer && typeof init?.body === "string") {
        const request: AnswerRequest = JSON.parse(init.body);
        return new Response(JSON.stringify(await answer(request)), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (input !== "/api/backstage/health") throw new Error(`Unexpected fetch: ${input}`);
      return health.clone();
    },
  });
  await import(`./main.ts?so6=${++importNumber}`);
  const get = (id: string): FakeElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing markup element: ${id}`);
    return found;
  };
  return { document, get, urls, requests, replacements, historyCalls, window, store };
}

const keyIds = ["jev-key", "anthropic-key", "openai-key", "google-key", "xai-key"];
function fillKeys(get: (id: string) => FakeElement) {
  for (const id of keyIds) get(id).value = `${id}-secret-value`;
}
function assertKeysBlank(get: (id: string) => FakeElement) {
  for (const id of keyIds) expect(get(id).value).toBe("");
}
async function tick() { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }

test("[integration] A2 load does not send sign-out", async () => {
  const page = await mount();
  expect(page.requests.some((request) => request.input === "/api/auth/sign-out")).toBe(false);
});

test("[integration] A2 sign-out clears keys and scene before POST and navigates", async () => {
  const page = await mount();
  fillKeys(page.get);
  page.get("sign-out").click();
  assertKeysBlank(page.get);
  expect(page.get("sign-out").disabled).toBe(true);
  expect(page.get("notice").textContent).toBe("Signing out. Keys and session cleared.");
  const signOutRequests = page.requests.filter((request) => request.input === "/api/auth/sign-out");
  expect(signOutRequests).toHaveLength(1);
  expect(signOutRequests[0]?.init).toMatchObject({ method: "POST", credentials: "same-origin" });
  expect(signOutRequests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  await tick();
  expect(page.replacements).toEqual(["/backstage/sign-in?signed-out=1"]);
});

test("[integration] A2 failed sign-out keeps keys cleared, stays put, and re-enables control", async () => {
  const page = await mount(undefined, new Response(null, { status: 403 }));
  fillKeys(page.get);
  page.get("sign-out").click();
  await tick();
  assertKeysBlank(page.get);
  expect(page.replacements).toEqual([]);
  expect(page.get("notice").textContent).toBe("Sign-out failed. Your keys are cleared, but you are still signed in. Try again, or close the browser.");
  expect(page.get("sign-out").disabled).toBe(false);
  page.get("sign-out").click();
  expect(page.requests.filter((request) => request.input === "/api/auth/sign-out")).toHaveLength(2);
});

test("[integration] SO6 pending sign-out blocks run controls and beforeunload", async () => {
  const page = await mount();
  await tick();
  page.get("question").value = "Which choice?";
  page.get("definition-a").value = "First choice";
  page.get("definition-b").value = "Second choice";
  page.get("acceptance").value = "Keep the first choice";
  page.get("cases").value = "A sample case";
  fillKeys(page.get);
  page.get("sign-out").click();
  expect(page.requests.some((request) => request.input === "/api/auth/sign-out")).toBe(true);
  for (const id of ["run-one", "run-all", "run-trial"]) page.get(id).click();
  // Let any accidentally started run settle before the next scenario replaces the globals.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(page.urls.filter((url) => url.startsWith("/api/backstage/answer") || url.startsWith("/api/backstage/trial/"))).toEqual([]);
  const beforeunload = new Event("beforeunload", { cancelable: true });
  page.window.dispatchEvent(beforeunload);
  expect(beforeunload.defaultPrevented).toBe(false);
});

test("[integration] SO6 clear-keys blanks fields without signing out", async () => {
  const page = await mount();
  fillKeys(page.get);
  page.get("clear-keys").click();
  assertKeysBlank(page.get);
  expect(page.requests.some((request) => request.input === "/api/auth/sign-out")).toBe(false);
  expect(page.replacements).toEqual([]);
  expect(page.get("notice").textContent).toBe("Keys cleared and further calls stopped. Already dispatched calls may still be charged.");
});

test("[integration] A2 unauthenticated health response shows expiry link and retains keys", async () => {
  const page = await mount(new Response('{"code":"unauthenticated"}', { status: 401, headers: { "content-type": "application/json" } }));
  fillKeys(page.get);
  await tick();
  expect(page.get("notice").textContent).toBe("Your sign-in has expired. ");
  const link = page.get("notice").children[0];
  expect(link?.tagName).toBe("A");
  expect(link?.textContent).toBe("Sign in again.");
  expect(link instanceof FakeElement ? link.getAttribute("href") : null).toBe("/backstage/sign-in");
  for (const id of keyIds) expect(page.get(id).value).toBe(`${id}-secret-value`);
  expect(page.replacements).toEqual([]);
});

test("[integration] A2 other health errors leave expiry message absent", async () => {
  const page = await mount(new Response('{"code":"other"}', { status: 401, headers: { "content-type": "application/json" } }));
  await tick();
  expect(page.get("notice").textContent).not.toContain("Your sign-in has expired.");
  expect(page.get("notice").children).toEqual([]);
});

const sceneIds = ["question", "choice-a", "choice-b", "definition-a", "definition-b", "acceptance", "exclusions", "keywords", "cases"];
function typeInto(page: Awaited<ReturnType<typeof mount>>, id: string, value: string) {
  page.get(id).value = value;
  page.get(id).dispatchEvent(new Event("input"));
}

const roomTitles = ["scene-title", "casting-title", "lines-title", "rehearsal-title", "dress-title", "opening-title"];
function navButton(page: Awaited<ReturnType<typeof mount>>, room: number): FakeElement {
  const found = page.document.querySelectorAll("[data-room]").find((item) => item.dataset.room === String(room));
  if (!found) throw new Error(`Missing nav button ${room}`);
  return found;
}
function tickModel(page: Awaited<ReturnType<typeof mount>>, arm: string) {
  const box = page.get(`arm-${arm}`);
  box.checked = true;
  box.dispatchEvent(new Event("change"));
}
function compareOn(page: Awaited<ReturnType<typeof mount>>) {
  page.get("compare").checked = true;
  page.get("compare").dispatchEvent(new Event("change"));
}

test("[integration] UX-125 first load leaves focus off the scene heading; changing room moves it to the new heading", async () => {
  const page = await mount();
  expect(page.document.activeElement).not.toBe(page.get("scene-title"));
  expect(page.document.activeElement).toBeNull();
  navButton(page, 1).click();
  expect(page.document.activeElement).toBe(page.get("casting-title"));
  page.get("next").click();
  expect(page.document.activeElement).toBe(page.get("lines-title"));
  page.get("back").click();
  page.get("back").click();
  expect(page.document.activeElement).toBe(page.get("scene-title"));
});

test("[integration] UX-C05 the skip link follows the current room and moves focus to its heading", async () => {
  const page = await mount();
  expect(page.get("skip-link").getAttribute("href")).toBe("#scene-title");
  roomTitles.forEach((title, index) => {
    navButton(page, index).click();
    page.get("theme").focus();
    expect(page.document.activeElement).toBe(page.get("theme"));
    expect(page.get("skip-link").getAttribute("href")).toBe(`#${title}`);
    page.get("skip-link").click();
    expect(page.document.activeElement).toBe(page.get(title));
  });
});

test("[integration] UX-C03 the line under the nav names each room's own step", async () => {
  const page = await mount();
  const lines: string[] = [];
  for (let index = 0; index < 6; index++) {
    navButton(page, index).click();
    lines.push(page.get("room-line").textContent);
  }
  expect(lines[0]).toBe("Set the scene before the first call.");
  expect(new Set(lines).size).toBe(6);
  for (const line of lines) expect(line.length).toBeGreaterThan(10);
});

test("[integration] UX-C01 Run stays reachable but off, with its reason, until there is a case and every selected model has its key", async () => {
  const page = await mount();
  await tick();
  for (const id of ["run-one", "run-all"]) {
    expect(page.get(id).disabled).toBe(false);
    expect(page.get(id).getAttribute("aria-disabled")).toBe("true");
  }
  expect(page.get("run-reason").textContent).toBe("Add at least one case. Add your TypeSafe API key on Casting.");
  page.get("run-all").click();
  await tick();
  expect(page.urls.filter((url) => url.startsWith("/api/backstage/answer"))).toEqual([]);
  expect(page.get("notice").textContent).toBe("Add at least one case. Add your TypeSafe API key on Casting.");
  typeInto(page, "cases", "Please refund my mug");
  expect(page.get("run-reason").textContent).toBe("Add your TypeSafe API key on Casting.");
  typeInto(page, "jev-key", "jev-secret-value");
  for (const id of ["run-one", "run-all"]) expect(page.get(id).getAttribute("aria-disabled")).toBe("false");
  expect(page.get("run-reason").textContent).toBe("");
  compareOn(page);
  tickModel(page, "gpt-6-luna");
  expect(page.get("run-one").getAttribute("aria-disabled")).toBe("true");
  expect(page.get("run-reason").textContent).toBe("Add your OpenAI API key on Casting, or untick its models.");
  typeInto(page, "openai-key", "openai-secret-value");
  expect(page.get("run-one").getAttribute("aria-disabled")).toBe("false");
  // Clear keys closes the gate again without any typing.
  page.get("clear-keys").click();
  expect(page.get("run-one").getAttribute("aria-disabled")).toBe("true");
  expect(page.get("run-reason").textContent).toBe("Add your TypeSafe API key on Casting. Add your OpenAI API key on Casting, or untick its models.");
});

test("[integration] UX-C01 the spend preview gives a money range beside the call count and names unpriced models", async () => {
  const page = await mount();
  typeInto(page, "cases", "Please refund my mug\nWhere is my parcel?");
  expect(page.get("run-preview").textContent).toMatch(/^2 cases\. Run all: up to 2 paid calls, estimated \$[\d.]+ to \$[\d.]+\. First case: up to 1 paid call, estimated \$[\d.]+ to \$[\d.]+\.$/);
  compareOn(page);
  tickModel(page, "gemini-3.8-flash");
  expect(page.get("run-preview").textContent).toContain("up to 4 paid calls");
  expect(page.get("run-preview").textContent).toContain("Gemini 3.8 Flash: price unknown, not in the estimate.");
});

test("[integration] UX-C02 ticking a provider's model shows its key field and announces it", async () => {
  const page = await mount();
  await tick();
  compareOn(page);
  expect(page.get("openai-key-player").hidden).toBe(true);
  tickModel(page, "gpt-6-luna");
  expect(page.get("openai-key-player").hidden).toBe(false);
  expect(page.get("notice").textContent).toBe("OpenAI API key field added below the models.");
  tickModel(page, "grok-4.7");
  expect(page.get("notice").textContent).toBe("xAI API key field added below the models.");
});

test("[integration] UX-C05 Reveal and Download stay in Tab order with a reason until they can act", async () => {
  const page = await mount(undefined, undefined, undefined, answerYes);
  await tick();
  for (const id of ["reveal", "download-csv", "download-evidence"]) {
    expect(page.get(id).disabled).toBe(false);
    expect(page.get(id).getAttribute("aria-disabled")).toBe("true");
  }
  expect(page.get("reveal-reason").textContent).toBe("Run your cases and open judging first.");
  expect(page.get("download-reason").textContent).toBe("Run your cases first. Downloads unlock when the run has answers to export.");
  page.get("reveal").click();
  expect(page.get("confirm-reveal").hidden).toBe(true);
  fillScene(page, "");
  typeInto(page, "cases", "Please refund my mug");
  await runFirstCase(page);
  // Both files wait for judging; each locked button is described by the reason.
  expect(page.get("download-reason").textContent).toBe("Finish judging in Rehearsals to unlock downloads.");
  for (const id of ["download-csv", "download-evidence"]) expect(page.get(id).getAttribute("aria-disabled")).toBe("true");
  expect(page.get("download-csv").getAttribute("aria-describedby")).toBe("download-reason csv-note");
  expect(page.get("download-evidence").getAttribute("aria-describedby")).toBe("download-reason");
  await openJudging(page);
  expect(page.get("reveal").getAttribute("aria-disabled")).toBe("false");
  expect(page.get("reveal-reason").textContent).toBe("");
  page.get("pick-first").click();
  page.get("reveal").click();
  page.get("confirm-reveal-yes").click();
  await tick();
  for (const id of ["download-csv", "download-evidence"]) expect(page.get(id).getAttribute("aria-disabled")).toBe("false");
  expect(page.get("download-reason").textContent).toBe("");
  // An unlocked button is no longer described by a lock reason.
  expect(page.get("download-csv").getAttribute("aria-describedby")).toBe("csv-note");
  expect(page.get("download-evidence").getAttribute("aria-describedby")).toBeNull();
  expect(page.get("reveal").getAttribute("aria-disabled")).toBe("true");
  expect(page.get("reveal-reason").textContent).toBe("Results are revealed; labels are locked.");
});

test("[integration] D10 a scene typed before a run is restored after a reload", async () => {
  const first = await mount();
  for (const id of sceneIds) typeInto(first, id, `typed ${id}`);
  const second = await mount(undefined, undefined, first.store);
  for (const id of sceneIds) expect(second.get(id).value).toBe(`typed ${id}`);
  const blank = await mount();
  for (const id of ["question", "acceptance", "exclusions", "cases"]) expect(blank.get(id).value).toBe("");
});

test("[integration] D10 no key value is ever written to storage or restored", async () => {
  const first = await mount();
  fillKeys(first.get);
  for (const id of sceneIds) typeInto(first, id, `typed ${id}`);
  for (const id of keyIds) first.get(id).dispatchEvent(new Event("input"));
  expect(first.store.items.size).toBeGreaterThan(0);
  const stored = [...first.store.items.entries()].flat().join("\n");
  for (const id of keyIds) expect(stored).not.toContain(`${id}-secret-value`);
  const second = await mount(undefined, undefined, first.store);
  assertKeysBlank(second.get);
});

test("[integration] D10 sign-out removes the saved scene", async () => {
  const page = await mount();
  typeInto(page, "question", "Which choice?");
  expect(page.store.items.size).toBe(1);
  page.get("sign-out").click();
  await tick();
  expect(page.store.items.size).toBe(0);
});

async function importCsv(page: Awaited<ReturnType<typeof mount>>, csv: string | Uint8Array) {
  const input = page.get("import-cases");
  if (!(input instanceof FakeInput)) throw new Error("import-cases is not an input");
  input.files = [new File([typeof csv === "string" ? csv : Uint8Array.from(csv).buffer], "cases.csv", { type: "text/csv" })];
  input.dispatchEvent(new Event("change"));
  await tick();
  await tick();
}

test("[integration] D16-BACKSTAGE-UTF8 the page refuses undecodable bytes without importing", async () => {
  const page = await mount();
  const bytes = Uint8Array.from([...new TextEncoder().encode("case_id,case_input\nc1,"), 0xff]);
  await importCsv(page, bytes);
  expect(page.get("notice").textContent).toBe("Case CSV has undecodable UTF-8 bytes on line 2. Save it as UTF-8 and import again.");
  expect(page.get("cases").value).toBe("");
  expect(page.get("notice").textContent).not.toContain("Imported");
});

test("[integration] D16-BACKSTAGE-UNICODE the page imports BOM, accented text and emoji intact", async () => {
  const page = await mount();
  await importCsv(page, new TextEncoder().encode("\ufeffcase_id,case_input\nc1,café 😀\n"));
  expect(page.get("cases").value).toBe("café 😀");
  expect(page.get("notice").textContent).toContain("Imported 1 cases");
});

test("[integration] D11 a malformed CSV import names the line, the problem and the expected form", async () => {
  const page = await mount();
  await importCsv(page, "case_id,case_input\nc1,fine\nc2,one,two\n");
  const shown = page.get("notice").textContent;
  expect(shown).toContain("Line 3");
  expect(shown).toContain("3 columns");
  expect(shown).toContain("expected 2 (case_id,case_input)");
  expect(shown).not.toContain("Imported");
  expect(page.get("cases").value).toBe("");
});

test("[integration] D11 a well-formed CSV import reports the count", async () => {
  const page = await mount();
  await importCsv(page, "case_id,case_input\nc1,fine\nc2,also fine\n");
  expect(page.get("notice").textContent).toContain("Imported 2 cases");
  expect(page.get("cases").value).toBe("fine\nalso fine");
});

async function answerYes(request: AnswerRequest) {
  return {
    ok: true, runId: request.runId, revision: request.revision, caseId: request.caseId,
    provider: request.provider, attemptId: crypto.randomUUID(), fingerprint: await inputFingerprint(request),
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), latencyMs: 10,
    model: request.modelId, armId: request.armId, catalogVersion: request.catalogVersion,
    promptVersion: request.promptVersion, requestedModel: request.modelId, returnedModel: request.modelId,
    parameters: getModelEntry(request.armId)?.parameters, tokensIn: 20, tokensOut: 1, costUsd: 0.001,
    priceVersion: "2026-10-03", output: "yes", confidence: null,
  };
}
function fillScene(page: Awaited<ReturnType<typeof mount>>, exclusions = "") {
  typeInto(page, "question", "Which choice?");
  typeInto(page, "definition-a", "First choice");
  typeInto(page, "definition-b", "Second choice");
  typeInto(page, "acceptance", "Keep the first choice");
  typeInto(page, "exclusions", exclusions);
  page.get("jev-key").value = "jev-secret-value";
}
async function until(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await tick();
  expect(done()).toBe(true);
}
async function runFirstCase(page: Awaited<ReturnType<typeof mount>>) {
  page.get("run-one").click();
  await until(() => page.document.getElementById("open-judging") !== null);
}
async function openJudging(page: Awaited<ReturnType<typeof mount>>) {
  page.get("open-judging").click();
  page.get("confirm-judging-yes").click();
  await tick();
}

test("[integration] D10 an import survives a reload with its case ids and multiline text", async () => {
  const csv = 'case_id,case_input\nrow-a,"line one\nline two"\nrow-b,second\n';
  const first = await mount();
  await importCsv(first, csv);
  const sent: AnswerRequest[] = [];
  const record = async (request: AnswerRequest) => { sent.push(request); return answerYes(request); };
  // Reload straight after the import: no other field was touched.
  const second = await mount(undefined, undefined, first.store, record);
  expect(second.get("cases").value).toBe("line one / line two\nsecond");
  fillScene(second);
  await runFirstCase(second);
  expect(sent.map((r) => [r.caseId, r.input])).toEqual([["row-a", "line one\nline two"]]);
});

test("[integration] D10 editing another field after an import keeps the imported records", async () => {
  const first = await mount();
  await importCsv(first, 'case_id,case_input\nrow-a,"line one\nline two"\nrow-b,second\n');
  typeInto(first, "acceptance", "Keep the first choice");
  const sent: AnswerRequest[] = [];
  const record = async (request: AnswerRequest) => { sent.push(request); return answerYes(request); };
  const second = await mount(undefined, undefined, first.store, record);
  fillScene(second);
  await runFirstCase(second);
  expect(sent.map((r) => [r.caseId, r.input])).toEqual([["row-a", "line one\nline two"]]);
  // Typing in the cases box replaces the import with plain lines, and that is what is kept.
  const third = await mount();
  await importCsv(third, "case_id,case_input\nrow-a,one\n");
  typeInto(third, "cases", "typed line");
  const fourth = await mount(undefined, undefined, third.store, record);
  expect(fourth.get("cases").value).toBe("typed line");
  sent.length = 0;
  fillScene(fourth);
  await runFirstCase(fourth);
  expect(sent.map((r) => [r.caseId, r.input])).toEqual([["case-1", "typed line"]]);
});

test("[integration] D10 a draft that cannot be stored shows a status and leaves no stale draft", async () => {
  const store = new FakeStorage();
  const page = await mount(undefined, undefined, store);
  typeInto(page, "question", "kept");
  expect(store.items.size).toBe(1);
  expect(page.get("draft-status").textContent).toBe("");
  store.setItem = () => { throw new Error("quota"); };
  typeInto(page, "question", "not kept");
  expect(page.get("draft-status").textContent).toContain("Could not keep your scene in this tab");
  expect(store.items.size).toBe(0);
  const reloaded = await mount(undefined, undefined, store);
  expect(reloaded.get("question").value).toBe("");
});

test("[integration] D10 a storage failure during CSV import stays visible after the import notice, until a save succeeds", async () => {
  const store = new FakeStorage();
  const working = store.setItem.bind(store);
  store.setItem = () => { throw new Error("quota"); };
  const page = await mount(undefined, undefined, store);
  await importCsv(page, "case_id,case_input\nc1,fine\nc2,also fine\n");
  expect(page.get("notice").textContent).toContain("Imported 2 cases");
  expect(page.get("draft-status").textContent).toContain("Could not keep your scene in this tab");
  typeInto(page, "question", "still failing");
  expect(page.get("draft-status").textContent).toContain("Could not keep your scene in this tab");
  store.setItem = working;
  typeInto(page, "question", "works again");
  expect(page.get("draft-status").textContent).toBe("");
});

test("[integration] D10 a saved scene that cannot be removed at sign-out says so", async () => {
  const store = new FakeStorage();
  const page = await mount(undefined, undefined, store);
  typeInto(page, "question", "kept");
  store.removeItem = () => { throw new Error("blocked"); };
  page.get("sign-out").click();
  expect(page.get("draft-status").textContent).toContain("Could not remove the saved scene");
  await tick();
  expect(page.get("draft-status").textContent).toContain("Could not remove the saved scene");
});

test("[integration] D10 a failed save whose cleanup also fails says the old draft may remain", async () => {
  const store = new FakeStorage();
  const page = await mount(undefined, undefined, store);
  typeInto(page, "question", "kept");
  store.setItem = () => { throw new Error("quota"); };
  store.removeItem = () => { throw new Error("blocked"); };
  typeInto(page, "question", "not kept");
  expect(page.get("draft-status").textContent).toContain("Could not remove the saved scene");
});

test("[integration] D10 imported records are not restored when the saved cases text differs", async () => {
  const first = await mount();
  await importCsv(first, "case_id,case_input\nrow-a,imported one\n");
  const saved = first.store.getItem(SCENE_DRAFT_KEY) ?? "";
  const tampered = JSON.parse(saved);
  tampered.fields.cases = "visible case";
  first.store.setItem(SCENE_DRAFT_KEY, JSON.stringify(tampered));
  const sent: AnswerRequest[] = [];
  const second = await mount(undefined, undefined, first.store, async (request) => { sent.push(request); return answerYes(request); });
  expect(second.get("cases").value).toBe("visible case");
  fillScene(second);
  await runFirstCase(second);
  expect(sent.map((r) => [r.caseId, r.input])).toEqual([["case-1", "visible case"]]);
});

test("[integration] D10 typing while sign-out is pending never recreates the draft", async () => {
  const page = await mount();
  typeInto(page, "question", "before");
  page.get("sign-out").click();
  typeInto(page, "question", "during sign-out");
  expect(page.store.items.size).toBe(0);
  // A write that slips in from elsewhere is removed again before navigation.
  page.store.setItem(SCENE_DRAFT_KEY, "{}");
  await tick();
  expect(page.store.items.size).toBe(0);
  expect(page.replacements).toEqual(["/backstage/sign-in?signed-out=1"]);
});

/** What a user sees of the leave-out rule on the judging page; empty when it is shown. */
function leaveOutProblems(page: Awaited<ReturnType<typeof mount>>, exclusions: string): string[] {
  const shown = page.get("leave-out");
  const problems: string[] = [];
  if (shown.textContent !== `Leave out: ${exclusions}`) problems.push(`text is "${shown.textContent}"`);
  if (shown.hidden) problems.push("hidden");
  if (page.get("rubric").textContent !== "Keep when: Keep the first choice") problems.push("keep rule missing");
  return problems;
}

test("[integration] D10 judging shows what to keep and what to leave out, and a new scene clears both", async () => {
  const page = await mount(undefined, undefined, undefined, answerYes);
  fillScene(page, "Shipping questions");
  typeInto(page, "cases", "Please refund my mug");
  await runFirstCase(page);
  await openJudging(page);
  expect(leaveOutProblems(page, "Shipping questions")).toEqual([]);
  // Negative controls: hidden, emptied or shortened rule text is reported.
  const real = page.get("leave-out").textContent;
  page.get("leave-out").hidden = true;
  expect(leaveOutProblems(page, "Shipping questions")).toContain("hidden");
  page.get("leave-out").hidden = false;
  for (const mutant of ["", "Leave out:", "Shipping questions"]) {
    page.get("leave-out").textContent = mutant;
    expect(leaveOutProblems(page, "Shipping questions").length).toBeGreaterThan(0);
  }
  page.get("leave-out").textContent = real;
  expect(leaveOutProblems(page, "Shipping questions")).toEqual([]);
  // Edit as a new scene: nothing of the earlier scene stays on the judging page.
  page.get("new-scene").click();
  page.get("confirm-new-scene-yes").click();
  await tick();
  expect(page.get("leave-out").textContent).toBe("");
  expect(page.get("rubric").textContent).toBe("");
});

test("[integration] D10 a scene with nothing to leave out shows no leave-out line", async () => {
  const page = await mount(undefined, undefined, undefined, answerYes);
  fillScene(page, "");
  typeInto(page, "cases", "Please refund my mug");
  await runFirstCase(page);
  await openJudging(page);
  expect(page.get("rubric").textContent).toBe("Keep when: Keep the first choice");
  expect(page.get("leave-out").textContent).toBe("");
});

function textOf(node: FakeNode): string {
  return [node.textContent, ...node.children.map(textOf)].join("\n");
}

test("[integration] D03 the revealed Backstage run shows kept and cost figures and no latency or labelling time", async () => {
  const page = await mount(undefined, undefined, undefined, answerYes);
  fillScene(page, "");
  typeInto(page, "cases", "Please refund my mug");
  await runFirstCase(page);
  await openJudging(page);
  page.get("pick-first").click();
  page.get("reveal").click();
  page.get("confirm-reveal-yes").click();
  await tick();
  const rendered = ["progress", "metrics", "verdict", "notice", "blind-card"].map((id) => textOf(page.get(id))).join("\n");
  // Positive control: the metrics table rendered, so an absent word is absent from displayed content.
  expect(rendered).toContain("Kept / labelled");
  expect(rendered).toContain("Cost / kept");
  expect(rendered).toContain("1 / 1");
  expect(rendered).not.toMatch(/latency/i);
  expect(rendered).not.toMatch(/labell?ing time/i);
});

/** Jev answers yes with confidence 0.82 and per-option probabilities: distinctive text a leak would show. */
async function answerYesRanked(request: AnswerRequest) {
  return { ...(await answerYes(request)), confidence: 0.82, probabilities: { yes: 0.82, no: 0.18 } };
}
/** What would show Jev's answer for a case: the ranking, its percentages, the confidence, the answers table. */
const SUGGESTION_MARKERS = [/82%/, /18%/, /0\.82/, /Jev's choice/, /Jev's ranking/, /Returned confidence/, /^Jev answers$/m];
function leaks(page: Awaited<ReturnType<typeof mount>>): string[] {
  const text = page.document.connectedText();
  return SUGGESTION_MARKERS.filter((marker) => marker.test(text)).map(String);
}
function within(node: FakeNode, id: string): FakeElement | null {
  for (const child of node.children) {
    if (child instanceof FakeElement && child.id === id) return child;
    const found = within(child, id);
    if (found) return found;
  }
  return null;
}
function answerCalls(page: Awaited<ReturnType<typeof mount>>): number {
  return page.urls.filter((url) => url === "/api/backstage/answer").length;
}

test("[e2e] M2 blind integrity: no Jev answer, ranking or confidence is in the DOM or network before the blind pick", async () => {
  const page = await mount(undefined, undefined, undefined, answerYesRanked);
  fillScene(page, "");
  typeInto(page, "cases", "Please refund my mug");
  await runFirstCase(page);
  const runCalls = answerCalls(page);
  expect(runCalls).toBe(1);
  // After the run, before judging: Learning Lines holds no answer for the unpicked case.
  expect(leaks(page)).toEqual([]);
  await openJudging(page);
  // Judging open, case on screen, not yet picked: the case and both choices, nothing of Jev's answer.
  expect(textOf(page.get("blind-card"))).toContain("Please refund my mug");
  expect(page.get("pick-first").textContent).toBe("yes");
  expect(page.get("pick-second").textContent).toBe("no");
  expect(page.get("pick-actions").hidden).toBe(false);
  expect(leaks(page)).toEqual([]);
  expect(answerCalls(page)).toBe(runCalls);
  // The blind pick: now the ranking appears (positive control), from the recorded answer with no new call.
  page.get("pick-second").click();
  await tick();
  expect(leaks(page)).toEqual(SUGGESTION_MARKERS.map(String));
  expect(textOf(page.get("suggestion"))).toContain("#1 yes 82% (Jev's choice)");
  expect(textOf(page.get("suggestion"))).toContain("#2 no 18%");
  expect(answerCalls(page)).toBe(runCalls);
  expect(page.get("pick-actions").hidden).toBe(true);
  // Keep or change: the final pick is recorded beside the blind one.
  const change = within(page.get("suggestion"), "final-yes");
  if (!change) throw new Error("no final-yes button in the suggestion panel");
  change.click();
  await tick();
  expect(textOf(page.get("blind-card"))).toContain("Your blind pick: no");
  // getElementById in this fake also finds replaced nodes; read the buttons from the live panel.
  expect(within(page.get("suggestion"), "final-yes")?.getAttribute("aria-pressed")).toBe("true");
  expect(within(page.get("suggestion"), "final-no")?.getAttribute("aria-pressed")).toBe("false");
});

test("[integration] M2 unsure records no label and still shows the ranking after the pick", async () => {
  const page = await mount(undefined, undefined, undefined, answerYesRanked);
  fillScene(page, "");
  typeInto(page, "cases", "Please refund my mug");
  await runFirstCase(page);
  await openJudging(page);
  expect(leaks(page)).toEqual([]);
  page.get("pick-unsure").click();
  await tick();
  expect(textOf(page.get("blind-card"))).toContain("Your blind pick: unsure");
  expect(textOf(page.get("suggestion"))).toContain("#1 yes 82% (Jev's choice)");
  expect(textOf(page.get("suggestion"))).toContain("Unsure: no label is recorded for this case.");
  expect(within(page.get("suggestion"), "final-yes")).toBeNull();
});

test("[e2e] M2 blind integrity per case: picking one case shows its ranking and answer, never another case's", async () => {
  const page = await mount(undefined, undefined, undefined, async (request) =>
    request.input.includes("order")
      ? { ...(await answerYes(request)), output: "no", confidence: 0.37, probabilities: { yes: 0.37, no: 0.63 } }
      : answerYesRanked(request),
  );
  fillScene(page, "");
  typeInto(page, "cases", "Please refund my mug\nWhere is my order");
  page.get("run-all").click();
  await until(() => page.document.getElementById("open-judging") !== null);
  await openJudging(page);
  const secondCase = [/63%/, /37%/, /0\.37/];
  const text = () => page.document.connectedText();
  expect(leaks(page)).toEqual([]);
  page.get("pick-first").click();
  await tick();
  // Case 1 picked: its ranking and its Learning Lines row show; nothing of case 2 does.
  expect(text()).toContain("#1 yes 82% (Jev's choice)");
  expect(textOf(page.get("progress"))).toContain("0.82");
  for (const marker of secondCase) expect(text()).not.toMatch(marker);
  // Case 2 on screen, not yet picked: still nothing of its answer.
  page.get("next-card").click();
  await tick();
  expect(textOf(page.get("blind-card"))).toContain("Where is my order");
  expect(page.get("suggestion").children).toEqual([]);
  for (const marker of secondCase) expect(text()).not.toMatch(marker);
  // Positive control: its blind pick reveals it.
  page.get("pick-second").click();
  await tick();
  expect(textOf(page.get("suggestion"))).toContain("#1 no 63% (Jev's choice)");
  // Evidence holds every answer, so it stays locked until judging finishes (aria-disabled keeps it in Tab order).
  expect(page.get("download-evidence").getAttribute("aria-disabled")).toBe("true");
  page.get("download-evidence").click();
  expect(page.get("notice").textContent).toBe("Finish judging in Rehearsals to unlock downloads.");
});

/** Compare mode with the keyword rule, so a case whose Jev call failed still has an answer to pick. */
async function compareWithFailedJevOnSecondCase(jevKey: string) {
  let failSecond = true;
  const sent: AnswerRequest[] = [];
  const page = await mount(undefined, undefined, undefined, async (request) => {
    sent.push(request);
    if (failSecond && request.input.includes("order")) throw new Error("network");
    return answerYesRanked(request);
  });
  fillScene(page, "");
  page.get("compare").checked = true;
  page.get("include-rule").checked = true;
  typeInto(page, "keywords", "refund");
  typeInto(page, "cases", "Please refund my mug\nWhere is my order");
  page.get("run-all").click();
  await until(() => page.document.getElementById("open-judging") !== null);
  await openJudging(page);
  failSecond = false;
  page.get("jev-key").value = jevKey;
  page.get("next-card").click();
  await tick();
  expect(textOf(page.get("blind-card"))).toContain("Where is my order");
  page.get("pick-second").click();
  await tick();
  return { page, sent };
}

test("[integration] M2 m4 no recorded Jev answer: Ask Jev makes one call on the typed key, however often it is clicked", async () => {
  const { page, sent } = await compareWithFailedJevOnSecondCase("jev-typed-labeller-key");
  expect(textOf(page.get("suggestion"))).toContain("No suggestion yet: this run has no Jev answer for this case.");
  const before = sent.length;
  const ask = within(page.get("suggestion"), "ask-jev");
  if (!ask) throw new Error("no Ask Jev button");
  ask.click();
  ask.click();
  await until(() => textOf(page.get("suggestion")).includes("Jev's ranking"));
  expect(sent.length).toBe(before + 1);
  expect(sent.at(-1)?.key).toBe("jev-typed-labeller-key");
  expect(sent.at(-1)?.provider).toBe("jev");
  expect(textOf(page.get("suggestion"))).toContain("#1 yes 82% (Jev's choice)");
  expect(within(page.get("suggestion"), "ask-jev")).toBeNull();
});

test("[integration] M2 m4 no recorded Jev answer and no Jev key: no Ask Jev button, no call, keep only", async () => {
  const { page, sent } = await compareWithFailedJevOnSecondCase("");
  const before = sent.length;
  expect(textOf(page.get("suggestion"))).toContain("No suggestion yet");
  expect(within(page.get("suggestion"), "ask-jev")).toBeNull();
  expect(within(page.get("suggestion"), "final-no")?.textContent).toBe("Keep no");
  expect(within(page.get("suggestion"), "final-yes")).toBeNull();
  await tick();
  expect(sent.length).toBe(before);
});

// Labelling loop M3: calibration before the tester's own cases, starter packs, and the optional CSV label column.
test("[integration] M3 calibration: 5 practice cases, the reference hidden until each pick, then shown as human_reviewed with agreement", async () => {
  const { UC13_CALIBRATION } = await import("../labels/calibration-set.ts");
  const page = await mount();
  page.get("next").click();
  page.get("next").click();
  page.get("next").click();
  const calibration = page.get("calibration");
  expect(textOf(calibration)).toContain("Practice case 1 of 5");
  expect(textOf(calibration)).toContain(UC13_CALIBRATION.question);
  expect(page.get("calibration-first").textContent).toBe("answer");
  expect(page.get("calibration-second").textContent).toBe("hand_off");
  // Picks: m16 answer (agree), m10 answer (differs), m29 unsure, m26 hand_off (agree), m19 hand_off (agree) -> 3 of 4.
  const picks = ["calibration-first", "calibration-first", "calibration-unsure", "calibration-second", "calibration-second"];
  for (const [index, id] of picks.entries()) {
    const c = UC13_CALIBRATION.cases[index];
    if (c === undefined) throw new Error("missing calibration case");
    expect(textOf(calibration)).toContain(c.input);
    // Before the pick, nothing of the reference is on the page.
    expect(textOf(page.get("calibration-feedback"))).toBe("");
    expect(page.document.connectedText()).not.toContain("Reference label");
    page.get(id).click();
    expect(textOf(page.get("calibration-feedback"))).toContain(`Reference label: ${c.truth}`);
    expect(textOf(page.get("calibration-feedback"))).toContain("human_reviewed");
    // The pick buttons hide; focus moves to Next rather than dropping to the page.
    expect(page.get("calibration-actions").hidden).toBe(true);
    expect(page.document.activeElement?.id).toBe("calibration-next");
    page.get("calibration-next").click();
    expect(page.document.activeElement?.id).toBe(index < 4 ? "calibration-case" : "calibration-result");
  }
  const result = textOf(page.get("calibration-result"));
  expect(result).toContain("You agreed with the reference on 3 of 4 picked cases (75%); 1 unsure.");
  expect(result).toContain("m10");
});

test("[integration] M3 starter packs load their scene and 10 cases, and say where their labels came from", async () => {
  const page = await mount();
  page.get("starter-p1").click();
  expect(page.get("question").value).toContain("fact sheet");
  expect(page.get("choice-a").value).toBe("hand_off");
  expect(page.get("choice-b").value).toBe("answer");
  expect(page.get("acceptance").value).toContain("fact sheet");
  // Each P1 case carries the fact sheet (the models see only the case text), shown on one line per case.
  expect(page.get("cases").value.split("\n").length).toBe(10);
  expect(page.get("cases").value.split("\n").every((line) => line.includes("Larchfield"))).toBe(true);
  expect(page.get("notice").textContent).toContain("10 cases");
  expect(page.get("notice").textContent).toContain("10 human_reviewed");
  page.get("starter-p4").click();
  expect(page.get("question").value).toBe("Does this outfit suit the occasion?");
  expect(page.get("notice").textContent).toContain("10 agent");
  expect(page.get("notice").textContent).not.toContain("human_reviewed");
  // Editing the cases drops the pack's labels, and says so.
  typeInto(page, "cases", "one new case");
  expect(page.get("notice").textContent).toContain("dropped 10 imported labels");
});

test("[integration] M3 a starter pack's human_reviewed labels reach the export when nobody picks", async () => {
  const { spyOn } = await import("bun:test");
  const { validate } = await import("../format/validate.ts");
  const blobs: Blob[] = [];
  const created = spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (blob instanceof Blob) blobs.push(blob);
    return "blob:test";
  });
  const revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  try {
    const page = await mount(undefined, undefined, undefined, async (request) => ({
      ...(await answerYes(request)),
      output: request.choices[0].name,
    }));
    page.get("starter-p1").click();
    page.get("jev-key").value = "jev-secret-value";
    page.get("run-all").click();
    await until(() => page.document.getElementById("open-judging") !== null);
    await openJudging(page);
    page.get("reveal").click();
    page.get("confirm-reveal-yes").click();
    await tick();
    page.get("download-csv").click();
    const csv = await blobs.at(-1)?.text();
    if (csv === undefined) throw new Error("no CSV downloaded");
    const parsed = validate(csv);
    expect(parsed.errors).toEqual([]);
    const sources = parsed.rows.map(({ values }) => [values.get("label_source"), values.get("labelled_by"), values.get("label_blind")]);
    expect(sources.length).toBe(10);
    expect(sources.every((s) => s[0] === "human_reviewed" && s[1] === "operator" && s[2] === "false")).toBe(true);
  } finally {
    created.mockRestore();
    revoked.mockRestore();
  }
});

test("[integration] M3 a CSV label column reaches the export: imported labels stay agent, a pick in the UI is human", async () => {
  const { spyOn } = await import("bun:test");
  const { validate } = await import("../format/validate.ts");
  const blobs: Blob[] = [];
  const created = spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (blob instanceof Blob) blobs.push(blob);
    return "blob:test";
  });
  const revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  try {
    const page = await mount(undefined, undefined, undefined, answerYes);
    fillScene(page, "");
    await importCsv(page, "case_id,case_input,label\nc1,Please refund my mug,yes\nc2,Where is my order,no\n");
    expect(page.get("notice").textContent).toContain("Imported 2 cases");
    expect(page.get("notice").textContent).toContain("2 agent");
    page.get("run-all").click();
    await until(() => page.document.getElementById("open-judging") !== null);
    await openJudging(page);
    page.get("pick-second").click();
    page.get("reveal").click();
    page.get("confirm-reveal-yes").click();
    await tick();
    page.get("download-csv").click();
    const csv = await blobs.at(-1)?.text();
    if (csv === undefined) throw new Error("no CSV downloaded");
    const parsed = validate(csv);
    expect(parsed.errors).toEqual([]);
    const cells = parsed.rows.map(({ values }) => ["case_id", "label", "label_source", "labelled_by"].map((k) => values.get(k)));
    expect(cells).toEqual([
      ["c1", "reject", "human", "backstage-operator"],
      ["c2", "reject", "agent", "csv-import"],
    ]);
  } finally {
    created.mockRestore();
    revoked.mockRestore();
  }
});

test("[integration] PL6 ?pack=p5 loads that pack on arrival, with 30 cases and no model call, and leaves the address clean", async () => {
  const page = await mount(undefined, undefined, undefined, undefined, "?pack=p5");
  expect(page.get("question").value).toBe("Was that video worth the watch?");
  expect(page.get("choice-a").value).toBe("keep_watching");
  expect(page.get("choice-b").value).toBe("quiz_time");
  expect(page.get("cases").value.split("\n").length).toBe(30);
  expect(page.get("notice").textContent).toContain("Loaded P5");
  expect(page.get("notice").textContent).toContain("30 cases");
  expect(page.requests.some((request) => request.input === "/api/backstage/answer")).toBe(false);
  expect(page.historyCalls.length).toBe(1);
  expect(String(page.historyCalls[0]?.[2])).toBe("/backstage/");
});

test("[integration] PL7 an unknown pack id, or none, shows the normal page: empty scene, no notice", async () => {
  for (const search of ["?pack=p9", "", "?pack="]) {
    const page = await mount(undefined, undefined, undefined, undefined, search);
    expect(page.get("question").value).toBe("");
    expect(page.get("cases").value).toBe("");
    expect(page.get("notice").textContent).not.toContain("Loaded");
  }
});

test("[integration] PL8 every pack has a button, and the P6 button loads its scene with 30 cases and no label summary", async () => {
  const page = await mount();
  for (const id of ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]) expect(page.document.getElementById(`starter-${id}`)).not.toBeNull();
  page.get("starter-p6").click();
  expect(page.get("question").value).toBe("Is this find worth a morning headline?");
  expect(page.get("cases").value.split("\n").length).toBe(30);
  expect(page.get("notice").textContent).toContain("30 cases");
  expect(page.get("notice").textContent).not.toContain("Labels on");
});

test("[integration] HK8 Casting enables Run with an empty Jev key when the server holds a house key", async () => {
  const health = new Response(JSON.stringify({ houseKey: true, trial: { available: false, reason: "off" }, protocol: PROTOCOL_VERSION, version: "so6-test", catalogVersion: CATALOG_VERSION }), { status: 200, headers: { "content-type": "application/json" } });
  const sent: AnswerRequest[] = [];
  const page = await mount(health, redirectedResponse(), new FakeStorage(), async (request) => { sent.push(request); return {}; });
  await tick();
  expect(page.get("house-key-note").hidden).toBe(false);
  expect(page.get("house-key-note").textContent).toBe("Local test key in use. Leave this blank or paste your own.");
  fillScene(page);
  typeInto(page, "cases", "Please refund my mug");
  typeInto(page, "jev-key", "");
  expect(page.get("run-reason").textContent).toBe("");
  for (const id of ["run-one", "run-all"]) expect(page.get(id).getAttribute("aria-disabled")).toBe("false");
  page.get("run-one").click();
  await until(() => sent.length > 0);
  expect(sent[0]?.key).toBe("");
  expect(sent[0]?.armId).toBe("jev");
});
