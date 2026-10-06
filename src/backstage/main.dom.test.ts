import { expect, test } from "bun:test";
import { CATALOG_VERSION } from "./catalog.ts";
import { PROTOCOL_VERSION } from "./contracts.ts";

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

class FakeXHR {
  static opened: FakeXHR[] = [];
  method = "";
  url = "";
  async = false;
  user = "";
  password = "";
  timeout = 0;
  status = 0;
  onloadend: (() => void) | null = null;
  constructor() { FakeXHR.opened.push(this); }
  open(method: string, url: string, async: boolean, user: string, password: string) {
    Object.assign(this, { method, url, async, user, password });
  }
  send() {}
  finish(status: number) { this.status = status; this.onloadend?.(); }
}

let importNumber = 0;
async function mount(search = "") {
  const document = documentFromMarkup(await Bun.file("site/backstage/index.html").text());
  const urls: string[] = [];
  const replacements: string[] = [];
  const historyCalls: unknown[][] = [];
  const location = { search, pathname: "/backstage/", origin: "https://example.test", replace: (url: string) => replacements.push(url) };
  const window = new EventTarget();
  Object.assign(window, { location });
  FakeXHR.opened = [];
  Object.assign(globalThis, {
    document, window, location,
    history: { replaceState: (...args: unknown[]) => historyCalls.push(args) },
    navigator: { clipboard: { writeText: async (_value: string) => {} } },
    matchMedia: (_query: string) => ({ matches: false }),
    XMLHttpRequest: FakeXHR,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    HTMLButtonElement: FakeButton,
    HTMLFieldSetElement: FakeFieldSet,
    BACKSTAGE_BUILD_VERSION: "so6-test",
    fetch: async (input: string) => {
      urls.push(input);
      if (input !== "/api/backstage/health") throw new Error(`Unexpected fetch: ${input}`);
      return new Response(JSON.stringify({ trial: { available: true }, protocol: PROTOCOL_VERSION, version: "so6-test", catalogVersion: CATALOG_VERSION }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await import(`./main.ts?so6=${++importNumber}`);
  const get = (id: string): FakeElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing markup element: ${id}`);
    return found;
  };
  return { document, get, urls, replacements, historyCalls, window };
}

const keyIds = ["jev-key", "anthropic-key", "openai-key", "google-key", "xai-key"];
function fillKeys(get: (id: string) => FakeElement) {
  for (const id of keyIds) get(id).value = `${id}-secret-value`;
}
function assertKeysBlank(get: (id: string) => FakeElement) {
  for (const id of keyIds) expect(get(id).value).toBe("");
}
function assertRequest() {
  expect(FakeXHR.opened).toHaveLength(1);
  const xhr = FakeXHR.opened[0];
  if (!xhr) throw new Error("Missing sign-out XHR");
  expect([xhr.method, xhr.url, xhr.async, xhr.user, xhr.timeout]).toEqual(["GET", "/api/backstage/sign-out", true, "signed-out", 10000]);
  expect(xhr.password).toMatch(/^[0-9a-f]{32}$/);
  return xhr;
}
async function tick() { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }

test("[integration] SO6 load without query keeps warning hidden and opens no XHR", async () => {
  const page = await mount();
  expect(page.get("signed-out").hidden).toBe(true);
  expect(FakeXHR.opened).toHaveLength(0);
});

test("[integration] SO6 sign-out clears keys and awaits a 401 before navigation", async () => {
  const page = await mount();
  fillKeys(page.get);
  page.get("sign-out").click();
  assertKeysBlank(page.get);
  expect(page.get("sign-out").disabled).toBe(true);
  expect(page.get("notice").textContent).toBe("Signing out. Keys and session cleared.");
  const xhr = assertRequest();
  expect(page.replacements).toEqual([]);
  xhr.finish(401);
  await tick();
  expect(page.replacements).toEqual(["/backstage/?signed-out=1"]);
});

for (const status of [0, 200]) test(`[integration] SO6 sign-out navigates after XHR status ${status}`, async () => {
  const page = await mount();
  fillKeys(page.get);
  page.get("sign-out").click();
  assertKeysBlank(page.get);
  expect(page.get("sign-out").disabled).toBe(true);
  expect(page.get("notice").textContent).toBe("Signing out. Keys and session cleared.");
  const xhr = assertRequest();
  expect(page.replacements).toEqual([]);
  xhr.finish(status);
  await tick();
  expect(page.replacements).toEqual(["/backstage/?signed-out=1"]);
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
  assertRequest();
  for (const id of ["run-one", "run-all", "run-trial"]) page.get(id).click();
  // Let any accidentally started run settle before the next scenario replaces the globals.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(page.urls.filter((url) => url.startsWith("/api/backstage/answer") || url.startsWith("/api/backstage/trial/"))).toEqual([]);
  const beforeunload = new Event("beforeunload", { cancelable: true });
  page.window.dispatchEvent(beforeunload);
  expect(beforeunload.defaultPrevented).toBe(false);
});

test("[integration] SO6 kept-login warning receives focus and clears query", async () => {
  const page = await mount("?signed-out=1");
  expect(page.get("signed-out").hidden).toBe(false);
  expect(page.document.activeElement).toBe(page.get("signed-out"));
  expect(page.historyCalls).toEqual([[null, "", "/backstage/"]]);
});

test("[integration] SO6 clear-keys blanks fields without signing out", async () => {
  const page = await mount();
  fillKeys(page.get);
  page.get("clear-keys").click();
  assertKeysBlank(page.get);
  expect(FakeXHR.opened).toHaveLength(0);
  expect(page.replacements).toEqual([]);
  expect(page.get("notice").textContent).toBe("Keys cleared and further calls stopped. Already dispatched calls may still be charged.");
});
