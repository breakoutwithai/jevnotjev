import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
class Store {
  readonly data = new Map<string, string>();
  blocked = false;
  getItem(key: string) { if (this.blocked) throw Error("blocked"); return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.blocked) throw Error("blocked"); this.data.set(key, value); }
  removeItem(key: string) { if (this.blocked) throw Error("blocked"); this.data.delete(key); }
}
interface EventData { target?: ElementStub; key?: string; preventDefault?: () => void }
class ElementStub {
  textContent = ""; innerHTML = ""; className = ""; hidden = false; disabled = false;
  href = ""; download = ""; type = "";
  dataset: Record<string, string> = {};
  style = { width: "", setProperty(_name: string, _value: string) {} };
  readonly attrs = new Map<string, string>();
  readonly children: ElementStub[] = [];
  readonly events = new Map<string, (e: EventData) => void>();
  onclick: (() => void) | null = null;
  classList = { toggle: (_name: string, _on: boolean) => {} };
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  addEventListener(name: string, fn: (e: EventData) => void) { this.events.set(name, fn); }
  appendChild(node: ElementStub) { this.children.push(node); }
  insertBefore(node: ElementStub, _before: ElementStub) { this.children.push(node); }
  closest(selector: string) { return this.className.split(" ").includes(selector.slice(1)) ? this : null; }
  focus() {}
  click() { if (!this.disabled && !this.hidden) { this.onclick?.(); this.events.get("click")?.({ target: this }); } }
}
async function page(kind: "label" | "little-shop", store: Store, transform = (s: string) => s) {
  const html = transform(await readFile(join(root, "site", kind, "index.html"), "utf8"));
  const elements = new Map<string, ElementStub>();
  const created: ElementStub[] = [];
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) if (match[1]) elements.set(match[1], new ElementStub());
  const rule = elements.get("acceptanceRule");
  if (rule) rule.textContent = (html.match(/<p[^>]*id="acceptanceRule"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/<[^>]*>/g, "");
  const get = (id: string) => { const el = elements.get(id); if (!el) throw Error(`Missing element ${id}`); return el; };
  const documentEvents = new Map<string, (e: EventData) => void>();
  const blobs: Blob[] = [];
  const doc = {
    getElementById: get,
    createElement: (_tag: string) => { const el = new ElementStub(); created.push(el); return el; },
    addEventListener: (name: string, handler: (e: EventData) => void) => documentEvents.set(name, handler),
  };
  const win: Record<string, unknown> = { localStorage: store, addEventListener: () => {} };
  const run = (source: string) => new Function("window", "document", "Element", "Blob", "URL", "setTimeout", source)(win, doc, ElementStub, Blob, { createObjectURL: (blob: Blob) => { blobs.push(blob); return "blob:test"; }, revokeObjectURL: () => {} }, () => 0);
  if (kind === "label") {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw Error("Missing label controller");
    run(script);
  } else {
    for (const file of ["shop-data.js", "seating.js", "house.js"]) run(await readFile(join(root, "site/little-shop", file), "utf8"));
  }
  const seat = (id: string) => { const node = created.find(el => el.dataset.id === id); if (!node) throw Error(`Missing seat ${id}`); get("fan").events.get("click")?.({ target: node }); };
  return { get, seat, blobs, created, key: (key: string) => documentEvents.get("keydown")?.({ key, preventDefault: () => {} }) };
}

test("[integration] U1 labels and current position survive reload and revision", async () => {
  const store = new Store(); const p = await page("label", store);
  p.get("bH").click(); p.get("bA").click(); p.get("prev").click();
  const reloaded = await page("label", store);
  expect(reloaded.get("status").textContent).toContain("2 of 40 labelled");
  expect(reloaded.get("pos").textContent).toContain("Message 2 of 40");
  reloaded.get("prev").click(); reloaded.get("bA").click();
  const revised = await page("label", store); revised.get("dl").click();
  expect(await revised.blobs[0]?.text()).toBe("case_id,truth\nm01,answer\nm02,answer\n");
});
test("[integration] U1 unavailable storage reports unsaved work without breaking labels/export", async () => {
  const store = new Store(); store.blocked = true; const p = await page("label", store);
  p.get("bA").click(); expect(p.get("saveStatus").textContent).toContain("not saved");
  p.get("dl").click(); expect(await p.blobs[0]?.text()).toBe("case_id,truth\nm01,answer\n");
});
test("[integration] U1 changed inputs never inherit previous labels", async () => {
  const store = new Store(); const p = await page("label", store); p.get("bH").click();
  const changed = await page("label", store, text => text.replace("What will the snow be like on Friday?", "Changed test input"));
  expect(changed.get("status").textContent).toContain("0 of 40 labelled");
  expect(changed.get("saveStatus").textContent).toContain("changed");
});
test("[integration] U4 pressed states follow navigation and corrected choices", async () => {
  const p = await page("label", new Store());
  expect(p.get("bA").getAttribute("aria-pressed")).toBe("false");
  p.key("h"); p.key("ArrowLeft");
  expect(p.get("bH").getAttribute("aria-pressed")).toBe("true");
  expect(p.get("bA").getAttribute("aria-pressed")).toBe("false");
  p.key("a"); p.key("ArrowLeft");
  expect(p.get("bA").getAttribute("aria-pressed")).toBe("true");
  expect(p.get("bH").getAttribute("aria-pressed")).toBe("false");
});
test("[integration] U2 one shop call can be corrected while preserving others and counts", async () => {
  const store = new Store(); const p = await page("little-shop", store);
  p.seat("m01"); p.get("sayHand").click(); p.seat("m02"); p.get("sayHand").click();
  p.seat("m01"); expect(p.get("ask").hidden).toBe(false); p.get("sayAnswer").click();
  expect(p.get("taken").textContent).toBe("6");
  expect(p.get("yourCall").textContent).toBe("Your call: Answer");
  expect(p.get("arms").innerHTML).toContain("1 of 2 accepted");
  const reloaded = await page("little-shop", store); reloaded.seat("m01");
  expect(reloaded.get("yourCall").textContent).toBe("Your call: Answer"); reloaded.seat("m02");
  expect(reloaded.get("yourCall").textContent).toBe("Your call: Hand off");
});
test("[integration] U3 completed shop reload directs review instead of choosing empty seats", async () => {
  const store = new Store(); const p = await page("little-shop", store); p.get("seatAll").click();
  for (let i = 0; i < 40; i++) p.get("sayAnswer").click();
  const reloaded = await page("little-shop", store);
  expect(reloaded.get("taken").textContent).toBe("120");
  expect(reloaded.get("seatAll").disabled).toBe(true);
  expect(reloaded.get("idle").textContent).toContain("All 40 calls are complete");
  expect(reloaded.get("idle").textContent).toContain("review");
});
test("[integration] U5 full CSV is ordered, complete and includes revisions", async () => {
  const p = await page("label", new Store()); for (let i = 0; i < 40; i++) p.key("a");
  p.key("ArrowLeft"); p.key("h"); p.get("dl").click();
  const text = await p.blobs[0]?.text(); expect(text?.trim().split("\n")).toHaveLength(41);
  expect(text).toContain("m39,hand_off\nm40,answer\n");
  expect(p.created.some(el => el.download === "labels.csv")).toBe(true);
});

test("[integration] U1 malformed saved state is rejected and a new choice recovers", async () => {
  for (const bad of ["not json", JSON.stringify({dataset:"other",truth:{m01:"answer"},position:0})]) {
    const store = new Store(); store.data.set("jnj.uc13.labels.v1", bad);
    const p = await page("label", store); expect(p.get("status").textContent).toContain("0 of 40 labelled");
    p.get("bH").click(); const restored = await page("label", store);
    expect(restored.get("status").textContent).toContain("1 of 40 labelled");
  }
});
test("[integration] U1 invalid saved labels or positions cannot enter the current dataset", async () => {
  for (const invalid of [{position:-1},{position:40},{truth:{m01:"unknown"}},{truth:{m99:"answer"}},{truth:[]}]) {
    const store = new Store(); const p = await page("label", store); p.get("bA").click();
    const snapshot = JSON.parse(store.data.get("jnj.uc13.labels.v1") ?? "null");
    store.data.set("jnj.uc13.labels.v1", JSON.stringify({...snapshot,...invalid}));
    const reloaded = await page("label", store);
    expect(reloaded.get("status").textContent).toContain("0 of 40 labelled");
    expect(reloaded.get("saveStatus").textContent).toContain("could not be restored");
  }
});
test("[integration] U1 quota failure reports unsaved latest choices and export preserves them", async () => {
  const store = new Store(); const p = await page("label", store); p.get("bH").click(); store.blocked = true;
  p.get("bA").click(); expect(p.get("saveStatus").textContent).toContain("not saved");
  p.get("dl").click(); expect(await p.blobs[0]?.text()).toBe("case_id,truth\nm01,hand_off\nm02,answer\n");
  store.blocked = false; p.get("prev").click();
  const restored = await page("label", store); expect(restored.get("status").textContent).toContain("2 of 40 labelled");
});
test("[integration] U1 changed acceptance rules invalidate old labels", async () => {
  const store = new Store(); const p = await page("label", store); p.get("bA").click();
  const changed = await page("label", store, text => text.replace("everything asked is covered", "nothing asked is covered"));
  expect(changed.get("status").textContent).toContain("0 of 40 labelled");
  expect(changed.get("saveStatus").textContent).toContain("changed");
});
