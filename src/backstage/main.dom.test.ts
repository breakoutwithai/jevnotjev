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
async function mount(health = new Response(JSON.stringify({ trial: { available: true }, protocol: PROTOCOL_VERSION, version: "so6-test", catalogVersion: CATALOG_VERSION }), { status: 200, headers: { "content-type": "application/json" } }), signOutResponse: Response | Error = redirectedResponse(), store = new FakeStorage(), answer?: (request: AnswerRequest) => Promise<unknown>) {
  const document = documentFromMarkup(await Bun.file("site/backstage/index.html").text());
  const urls: string[] = [];
  const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
  const replacements: string[] = [];
  const historyCalls: unknown[][] = [];
  const location = { search: "", pathname: "/backstage/", origin: "https://example.test", replace: (url: string) => replacements.push(url) };
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

async function importCsv(page: Awaited<ReturnType<typeof mount>>, csv: string) {
  const input = page.get("import-cases");
  if (!(input instanceof FakeInput)) throw new Error("import-cases is not an input");
  input.files = [new File([csv], "cases.csv", { type: "text/csv" })];
  input.dispatchEvent(new Event("change"));
  await tick();
  await tick();
}

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
  page.get("accept").click();
  page.get("reveal").click();
  page.get("confirm-reveal-yes").click();
  await tick();
  const rendered = ["progress", "metrics", "verdict", "notice", "blind-card"].map((id) => textOf(page.get(id))).join("\n");
  // Positive control: the metrics table rendered, so an absent word is absent from displayed content.
  expect(rendered).toContain("Kept / labelled");
  expect(rendered).toContain("Cost / kept");
  expect(rendered).not.toMatch(/latency/i);
  expect(rendered).not.toMatch(/labell?ing time/i);
});
