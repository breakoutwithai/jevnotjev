// The live /label/ page (site/label/index.html) runs in a small fake DOM: its own inline script, a logged fetch, and
// in-memory storage. Labelling loop M2: the blind pick comes first; only then is the picked case's suggestion fetched.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LABEL_OUT, SUGGESTIONS_OUT } from "./stage-demo.ts";

class Node {
  children: Node[] = [];
  textContent = "";
  constructor(readonly tagName: string) {}
  append(...nodes: Node[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Node[]) {
    this.children = nodes;
    this.textContent = "";
  }
}
class Element extends Node {
  id = "";
  hidden = false;
  disabled = false;
  className = "";
  onclick: (() => void) | null = null;
  download = "";
  href = "";
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classList = {
    toggle: (name: string, on: boolean) => {
      const names = new Set(this.className.split(" ").filter(Boolean));
      if (on) names.add(name);
      else names.delete(name);
      this.className = [...names].join(" ");
    },
  };
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  click() {
    this.onclick?.();
  }
}

interface Page {
  readonly root: Element;
  readonly fetched: string[];
  readonly downloads: string[];
  byId(id: string): Element;
  /** Everything in the connected tree: text and attribute values, hidden or not. */
  text(): string;
  key(key: string): void;
  settle(): Promise<void>;
}

/** Suggestion file bodies by URL; a URL that is absent answers 404. */
async function servedSuggestions(): Promise<Map<string, string>> {
  const served = new Map<string, string>();
  for (const id of ["m01", "m02", "m03"]) served.set(`suggestions/${id}.json`, await readFile(join(SUGGESTIONS_OUT, `${id}.json`), "utf8"));
  return served;
}

async function openPage(served: Map<string, string>, storage = new Map<string, string>()): Promise<Page> {
  const html = await readFile(LABEL_OUT, "utf8");
  const script = /<script>\n([\s\S]*)<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error("label page has no inline script");
  const elements: Element[] = [];
  const stack: Element[] = [];
  const voidTags = new Set(["br", "meta", "input", "img", "link"]);
  const body = html.slice(html.indexOf("<body>"), html.indexOf("<script>"));
  for (const token of body.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)) {
    const raw = token[0];
    if (!raw.startsWith("<")) {
      const parent = stack.at(-1);
      if (parent && raw.trim()) parent.textContent += raw;
      continue;
    }
    if (raw.startsWith("</")) {
      stack.pop();
      continue;
    }
    const tag = /^<([a-z][\w-]*)/i.exec(raw)?.[1]?.toLowerCase() ?? "";
    const element = new Element(tag.toUpperCase());
    for (const attr of raw.slice(tag.length + 1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      if (attr[1]) element.setAttribute(attr[1], attr[2] ?? "");
    }
    elements.push(element);
    stack.at(-1)?.append(element);
    if (!voidTags.has(tag)) stack.push(element);
  }
  const root = elements[0];
  if (!root) throw new Error("no markup");
  const fetched: string[] = [];
  const downloads: string[] = [];
  const keyListeners: ((e: unknown) => void)[] = [];
  const pending: Promise<unknown>[] = [];
  const document = {
    getElementById: (id: string) => elements.find((e) => e.id === id) ?? null,
    createElement: (tag: string) => {
      const e = new Element(tag.toUpperCase());
      elements.push(e);
      return e;
    },
    addEventListener: (type: string, listener: (e: unknown) => void) => {
      if (type === "keydown") keyListeners.push(listener);
    },
  };
  const localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  };
  const fetchStub = (url: string) => {
    fetched.push(url);
    const bodyText = served.get(url);
    const response = Promise.resolve(
      bodyText === undefined ? new Response("not found", { status: 404 }) : new Response(bodyText, { status: 200, headers: { "content-type": "application/json" } }),
    );
    pending.push(response);
    return response;
  };
  const blobs = new Map<string, Blob>();
  const URLStub = {
    createObjectURL: (blob: Blob) => {
      const id = `blob:${blobs.size}`;
      blobs.set(id, blob);
      return id;
    },
    revokeObjectURL: () => {},
  };
  // The anchor the page clicks to download: record what it would save.
  const createElement = document.createElement;
  document.createElement = (tag: string) => {
    const e = createElement(tag);
    if (tag === "a") {
      e.click = () => {
        const blob = blobs.get(e.href);
        if (blob) pending.push(blob.text().then((t) => downloads.push(t)));
      };
    }
    return e;
  };
  const run = new Function("document", "window", "fetch", "Blob", "URL", "setTimeout", script);
  run(document, { localStorage }, fetchStub, Blob, URLStub, (fn: () => void) => fn());
  const walk = (n: Node): string =>
    [n.textContent, n instanceof Element ? [...n.attributes.values()].join("\n") : "", ...n.children.map(walk)].join("\n");
  return {
    root,
    fetched,
    downloads,
    byId: (id) => {
      const found = [...elements].reverse().find((e) => e.id === id && connected(root, e));
      if (!found) throw new Error(`no connected element ${id}`);
      return found;
    },
    text: () => walk(root),
    key: (key) => {
      for (const listener of keyListeners) listener({ key, target: { tagName: "BODY" }, preventDefault: () => {} });
    },
    settle: async () => {
      for (let i = 0; i < 5; i++) {
        await Promise.all(pending.splice(0));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}
function connected(root: Node, target: Node): boolean {
  return root === target || root.children.some((child) => connected(child, target));
}

/** What would show Jev's answer for a case. (A bare percent is no marker: the fact sheet has "15% off".) */
const MARKERS = [/Jev's ranking/, /Jev's choice/, /#1 /, /Jev's confidence/];
function leaks(page: Page): string[] {
  const text = page.text();
  return MARKERS.filter((m) => m.test(text)).map(String);
}

describe("/label/ blind-then-suggest", () => {
  test("[e2e] M2 blind integrity on /label/: no suggestion in the DOM or network before the blind pick, and none prefetched", async () => {
    const page = await openPage(await servedSuggestions());
    await page.settle();
    expect(page.byId("msg").textContent).toBe("What will the snow be like on Friday?");
    expect(page.fetched).toEqual([]);
    expect(leaks(page)).toEqual([]);
    // Moving through cases without picking fetches nothing.
    page.byId("next").click();
    page.byId("prev").click();
    await page.settle();
    expect(page.fetched).toEqual([]);
    expect(leaks(page)).toEqual([]);
    // The blind pick on m01: exactly its own suggestion is fetched, then shown (positive control).
    page.byId("bA").click();
    await page.settle();
    expect(page.fetched).toEqual(["suggestions/m01.json"]);
    expect(leaks(page)).toEqual(MARKERS.map(String));
    expect(page.byId("suggestion").children.map((c) => c.textContent)).toContain("Jev's ranking");
    expect(page.text()).toContain("#1 hand_off 100% (Jev's choice)");
    expect(page.text()).toContain("#2 answer 0%");
    expect(page.text()).toContain("Your blind pick: answer");
    // The next case is not prefetched.
    expect(page.fetched.some((u) => u.includes("m02"))).toBe(false);
  });

  test("[integration] M2 /label/ records the blind pick as truth and the final pick beside it in labels.csv", async () => {
    const page = await openPage(await servedSuggestions());
    page.byId("bA").click();
    await page.settle();
    page.byId("final-hand_off").click();
    await page.settle();
    // Advanced to m02 after the final pick; its suggestion is not fetched until its own blind pick.
    expect(page.byId("msg").textContent).toBe("Do you sell helmets?");
    expect(page.fetched).toEqual(["suggestions/m01.json"]);
    page.key("h");
    await page.settle();
    page.key("h");
    await page.settle();
    page.byId("dl").click();
    await page.settle();
    const csv = page.downloads[0] ?? "";
    const [header, ...rows] = csv.trim().split("\n");
    expect(header).toBe("case_id,truth,final,suggestion_shown,labelled_at");
    expect(rows.map((r) => r.split(",").slice(0, 4).join(","))).toEqual(["m01,answer,hand_off,true", "m02,hand_off,hand_off,true"]);
    for (const r of rows) expect(r.split(",")[4]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("[integration] M2 /label/ a blind pick is made once: after the suggestion, A and H change only the final pick", async () => {
    const page = await openPage(await servedSuggestions());
    page.byId("bH").click();
    await page.settle();
    expect(page.byId("bA").disabled).toBe(true);
    expect(page.byId("bH").disabled).toBe(true);
    page.key("a");
    await page.settle();
    page.byId("prev").click();
    page.byId("dl").click();
    await page.settle();
    expect((page.downloads[0] ?? "").split("\n")[1]?.split(",").slice(0, 4).join(",")).toBe("m01,hand_off,answer,true");
  });

  test("[integration] M2 /label/ with no suggestion file the case says no suggestion yet; keeping the pick records suggestion_shown false", async () => {
    const page = await openPage(new Map());
    page.byId("bH").click();
    await page.settle();
    expect(page.text()).toContain("No suggestion yet.");
    expect(leaks(page)).toEqual([]);
    page.byId("final-hand_off").click();
    page.byId("dl").click();
    await page.settle();
    expect((page.downloads[0] ?? "").split("\n")[1]?.split(",").slice(0, 4).join(",")).toBe("m01,hand_off,hand_off,false");
  });

  test("[integration] M2 /label/ unsure records no truth, shows the ranking, and offers no final pick", async () => {
    const page = await openPage(await servedSuggestions());
    page.byId("bU").click();
    await page.settle();
    expect(page.fetched).toEqual(["suggestions/m01.json"]);
    expect(page.text()).toContain("Unsure: no label is recorded for this case.");
    expect(page.text()).toContain("#1 hand_off 100% (Jev's choice)");
    expect(() => page.byId("final-hand_off")).toThrow();
    page.byId("dl").click();
    await page.settle();
    expect((page.downloads[0] ?? "").trim()).toBe("case_id,truth,final,suggestion_shown,labelled_at");
  });

  test("[integration] M2 /label/ picks survive a reload; a picked case shows its suggestion again, an unpicked one does not", async () => {
    const storage = new Map<string, string>();
    const first = await openPage(await servedSuggestions(), storage);
    first.byId("bA").click();
    await first.settle();
    const second = await openPage(await servedSuggestions(), storage);
    await second.settle();
    expect(second.byId("msg").textContent).toBe("What will the snow be like on Friday?");
    expect(second.fetched).toEqual(["suggestions/m01.json"]);
    expect(second.text()).toContain("Your blind pick: answer");
    second.byId("next").click();
    await second.settle();
    expect(second.fetched).toEqual(["suggestions/m01.json"]);
    expect(second.byId("suggestion").children).toEqual([]);
  });
});
