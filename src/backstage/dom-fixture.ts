import { getModelEntry } from "./catalog.ts";
import { inputFingerprint } from "./run.ts";
import { CATALOG_VERSION } from "./catalog.ts";
import { PROTOCOL_VERSION, type AnswerRequest } from "./contracts.ts";
export class FakeNode extends EventTarget {
  children: FakeNode[] = [];
  textContent = "";
  constructor(readonly tagName: string) {
    super();
  }
  append(...nodes: FakeNode[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeNode[]) {
    this.children = nodes;
    this.textContent = "";
  }
}

export class FakeElement extends FakeNode {
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
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  attributeText(): string {
    return [...this.attributes.values(), this.value].join("\n");
  }
  focus() {
    if (this.owner) this.owner.activeElement = this;
  }
  click() {
    this.onclick?.();
    this.dispatchEvent(new Event("click"));
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector !== "button")
      throw new Error(`Unexpected selector: ${selector}`);
    const found: FakeElement[] = [];
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        if (child instanceof FakeElement && child.tagName === "BUTTON")
          found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}
export class FakeInput extends FakeElement {
  files: File[] | null = null;
}
class FakeTextArea extends FakeElement {}
class FakeButton extends FakeElement {}
class FakeFieldSet extends FakeElement {}
class FakeSelect extends FakeElement {}

class FakeDocument {
  readonly documentElement = new FakeElement("HTML");
  activeElement: FakeElement | null = null;
  private elements: FakeElement[] = [];
  createElement(tag: string): FakeElement {
    const upper = tag.toUpperCase();
    const element =
      upper === "INPUT"
        ? new FakeInput(upper)
        : upper === "TEXTAREA"
          ? new FakeTextArea(upper)
          : upper === "BUTTON"
            ? new FakeButton(upper)
            : upper === "FIELDSET"
              ? new FakeFieldSet(upper)
              : upper === "SELECT"
                ? new FakeSelect(upper)
                : new FakeElement(upper);
    element.owner = this;
    this.elements.push(element);
    return element;
  }
  createTextNode(value: string): FakeNode {
    const node = new FakeNode("#text");
    node.textContent = value;
    return node;
  }
  getElementById(id: string): FakeElement | null {
    return this.elements.find((element) => element.id === id) ?? null;
  }
  /** Everything in the connected tree from the page's root element: text, attributes and field values, hidden or not. */
  connectedText(): string {
    const walk = (node: FakeNode): string =>
      [
        node.textContent,
        node instanceof FakeElement ? node.attributeText() : "",
        ...node.children.map(walk),
      ].join("\n");
    const root = this.elements[0];
    return root === undefined ? "" : walk(root);
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector === "img")
      return this.elements.filter((element) => element.tagName === "IMG");
    if (selector === "[data-panel]")
      return this.elements.filter(
        (element) => element.dataset.panel !== undefined,
      );
    if (selector === "[data-room]")
      return this.elements.filter(
        (element) => element.dataset.room !== undefined,
      );
    if (selector === "[data-arm]:checked")
      return this.elements.filter(
        (element) => element.dataset.arm !== undefined && element.checked,
      );
    throw new Error(`Unexpected selector: ${selector}`);
  }
  querySelector(selector: string): FakeElement | null {
    const match = /^\[data-panel="(\d+)"\] h2$/.exec(selector);
    if (!match) throw new Error(`Unexpected selector: ${selector}`);
    const panel = this.elements.find(
      (element) => element.dataset.panel === match[1],
    );
    const findHeading = (node: FakeNode): FakeElement | null => {
      for (const child of node.children) {
        if (child instanceof FakeElement && child.tagName === "H2")
          return child;
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
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  for (const token of markup.matchAll(/<\/?[a-z][^>]*>/gi)) {
    const raw = token[0];
    if (raw.startsWith("</")) {
      stack.pop();
      continue;
    }
    const tag = /^<([a-z][\w-]*)/i.exec(raw)?.[1]?.toLowerCase();
    if (!tag) throw new Error(`Cannot parse tag ${raw}`);
    const element = document.createElement(tag);
    for (const attr of raw
      .slice(tag.length + 1)
      .matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      const name = attr[1];
      if (name) element.setAttribute(name, attr[2] ?? "");
    }
    stack.at(-1)?.append(element);
    if (!voidTags.has(tag) && !raw.endsWith("/>")) stack.push(element);
  }
  return document;
}

let importNumber = 0;
export function redirectedResponse(): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "redirected", { value: true });
  return response;
}
export class FakeStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}
export async function mount(
  health = new Response(
    JSON.stringify({
      trial: { available: true },
      protocol: PROTOCOL_VERSION,
      version: "so6-test",
      catalogVersion: CATALOG_VERSION,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  ),
  signOutResponse: Response | Error = redirectedResponse(),
  store = new FakeStorage(),
  answer?: (request: AnswerRequest) => Promise<unknown>,
  search = "",
  coach?: (
    question: string,
    signal: AbortSignal | undefined,
    mode?: string,
  ) => unknown | Promise<unknown>,
) {
  const document = documentFromMarkup(
    await Bun.file("site/backstage/index.html").text(),
  );
  const urls: string[] = [];
  const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
  const copied: string[] = [];
  const replacements: string[] = [];
  const historyCalls: unknown[][] = [];
  const location = {
    search,
    pathname: "/backstage/",
    origin: "https://example.test",
    replace: (url: string) => replacements.push(url),
  };
  const window = new EventTarget();
  Object.assign(window, { location });
  Object.assign(globalThis, {
    document,
    window,
    location,
    sessionStorage: store,
    history: { replaceState: (...args: unknown[]) => historyCalls.push(args) },
    navigator: {
      clipboard: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    },
    matchMedia: (_query: string) => ({ matches: false }),
    XMLHttpRequest: class {
      constructor() {
        throw new Error("No XMLHttpRequest may be constructed");
      }
    },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    HTMLButtonElement: FakeButton,
    HTMLFieldSetElement: FakeFieldSet,
    HTMLSelectElement: FakeSelect,
    BACKSTAGE_BUILD_VERSION: "so6-test",
    fetch: async (input: string, init?: RequestInit) => {
      urls.push(input);
      requests.push({ input, init });
      if (input === "/api/auth/sign-out") {
        if (signOutResponse instanceof Error) throw signOutResponse;
        return signOutResponse;
      }
      if (
        input === "/api/backstage/answer" &&
        answer &&
        typeof init?.body === "string"
      ) {
        const request: AnswerRequest = JSON.parse(init.body);
        return new Response(JSON.stringify(await answer(request)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        input === "/api/backstage/coach" &&
        coach &&
        typeof init?.body === "string"
      ) {
        const data: unknown = JSON.parse(init.body);
        const question =
          typeof data === "object" &&
          data !== null &&
          "question" in data &&
          typeof data.question === "string"
            ? data.question
            : typeof data === "object" &&
                data !== null &&
                "scene" in data &&
                typeof data.scene === "object" &&
                data.scene !== null &&
                "question" in data.scene &&
                typeof data.scene.question === "string"
              ? data.scene.question
              : "";
        const casesMode =
          typeof data === "object" &&
          data !== null &&
          "mode" in data &&
          data.mode === "cases";
        const reply = await coach(
          question,
          init.signal ?? undefined,
          casesMode ? "cases" : undefined,
        );
        return reply instanceof Response
          ? reply
          : Response.json(
              casesMode
                ? { cases: reply }
                : {
                    drafts: reply,
                    promptVersion: "coach.2",
                    model: "claude-sonnet-5-5",
                  },
            );
      }
      if (input !== "/api/backstage/health")
        throw new Error(`Unexpected fetch: ${input}`);
      return health.clone();
    },
  });
  await import(`./main.ts?so6=${++importNumber}`);
  const get = (id: string): FakeElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing markup element: ${id}`);
    return found;
  };
  return {
    document,
    get,
    urls,
    requests,
    replacements,
    historyCalls,
    window,
    store,
    copied,
  };
}

export async function tick() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function answerYes(request: AnswerRequest) {
  return {
    ok: true,
    runId: request.runId,
    revision: request.revision,
    caseId: request.caseId,
    provider: request.provider,
    attemptId: crypto.randomUUID(),
    fingerprint: await inputFingerprint(request),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    latencyMs: 10,
    model: request.modelId,
    armId: request.armId,
    catalogVersion: request.catalogVersion,
    promptVersion: request.promptVersion,
    requestedModel: request.modelId,
    returnedModel: request.modelId,
    parameters: getModelEntry(request.armId)?.parameters,
    tokensIn: 20,
    tokensOut: 1,
    costUsd: 0.001,
    priceVersion: "2026-10-03",
    output: "yes",
    confidence: null,
  };
}
