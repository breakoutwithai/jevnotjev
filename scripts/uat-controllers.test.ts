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
  append(...nodes: ElementStub[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: ElementStub[]) { this.children.splice(0, this.children.length, ...nodes); }
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
  // The label page reads suggestions/<case>.json after a blind pick; here none is served, so every case has none.
  const fetched: string[] = [];
  const notFound = (url: string) => { fetched.push(url); return Promise.resolve(new Response("not found", { status: 404 })); };
  const run = (source: string) => new Function("window", "document", "Element", "Blob", "URL", "setTimeout", "fetch", source)(win, doc, ElementStub, Blob, { createObjectURL: (blob: Blob) => { blobs.push(blob); return "blob:test"; }, revokeObjectURL: () => {} }, () => 0, notFound);
  if (kind === "label") {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw Error("Missing label controller");
    run(script);
  } else {
    for (const file of ["shop-data.js", "seating.js", "house.js"]) run(await readFile(join(root, "site/little-shop", file), "utf8"));
  }
  const seat = (id: string) => { const node = created.find(el => el.dataset.id === id); if (!node) throw Error(`Missing seat ${id}`); get("fan").events.get("click")?.({ target: node }); };
  return { get, seat, blobs, created, fetched, key: (key: string) => documentEvents.get("keydown")?.({ key, preventDefault: () => {} }) };
}
/** Let the page's suggestion read settle (a 404 here, so "no suggestion yet"). */
async function settle() { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
/** labels.csv without its labelled_at column, which holds the pick time. */
async function csvWithoutTimes(blob: Blob | undefined): Promise<string> {
  const text = (await blob?.text()) ?? "";
  return text.split("\n").map(line => line.split(",").slice(0, 4).join(",")).join("\n");
}
const LABELS_HEADER = "case_id,truth,final,suggestion_shown";

test("[integration] U1 labels and current position survive reload, and a later final pick is recorded beside the blind one", async () => {
  const store = new Store(); const p = await page("label", store);
  p.get("bH").click(); p.get("next").click(); p.get("bA").click();
  const reloaded = await page("label", store);
  expect(reloaded.get("status").textContent).toContain("2 of 40 labelled");
  expect(reloaded.get("pos").textContent).toContain("Message 2 of 40");
  // No suggestion is served here, so the final pick can only keep the blind one.
  reloaded.get("prev").click(); await settle(); reloaded.key("h");
  const revised = await page("label", store); revised.get("dl").click();
  expect(await csvWithoutTimes(revised.blobs[0])).toBe(`${LABELS_HEADER}\nm01,hand_off,hand_off,false\nm02,answer,,\n`);
});
test("[integration] U1 unavailable storage reports unsaved work without breaking labels/export", async () => {
  const store = new Store(); store.blocked = true; const p = await page("label", store);
  p.get("bA").click(); expect(p.get("saveStatus").textContent).toContain("not saved");
  p.get("dl").click(); expect(await csvWithoutTimes(p.blobs[0])).toBe(`${LABELS_HEADER}\nm01,answer,,\n`);
});
test("[integration] U1 changed inputs never inherit previous labels", async () => {
  const store = new Store(); const p = await page("label", store); p.get("bH").click();
  const changed = await page("label", store, text => text.replace("What will the snow be like on Friday?", "Changed test input"));
  expect(changed.get("status").textContent).toContain("0 of 40 labelled");
  expect(changed.get("saveStatus").textContent).toContain("changed");
});
test("[integration] U4 pressed states follow navigation; the blind pick stays pressed and locked after a final pick", async () => {
  const p = await page("label", new Store());
  expect(p.get("bA").getAttribute("aria-pressed")).toBe("false");
  p.key("h");
  expect(p.get("bH").getAttribute("aria-pressed")).toBe("true");
  expect(p.get("bA").getAttribute("aria-pressed")).toBe("false");
  expect(p.get("bA").disabled).toBe(true);
  await settle(); p.key("a");
  expect(p.get("pos").textContent).toContain("Message 1 of 40");
  p.key("h");
  expect(p.get("pos").textContent).toContain("Message 2 of 40");
  expect(p.get("bA").getAttribute("aria-pressed")).toBe("false");
  expect(p.get("bA").disabled).toBe(false);
  p.key("ArrowLeft");
  expect(p.get("bH").getAttribute("aria-pressed")).toBe("true");
  expect(p.get("bA").getAttribute("aria-pressed")).toBe("false");
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
test("[integration] U5 full CSV is ordered and complete, and with no suggestion a final pick cannot change the blind one", async () => {
  const p = await page("label", new Store());
  for (let i = 0; i < 40; i++) { p.key("a"); await settle(); p.key("a"); }
  p.key("ArrowLeft"); p.key("h"); p.get("dl").click();
  const text = await csvWithoutTimes(p.blobs[0]); expect(text.trim().split("\n")).toHaveLength(41);
  expect(text).toContain("m39,answer,answer,false\nm40,answer,answer,false\n");
  expect(p.created.some(el => el.download === "labels.csv")).toBe(true);
  expect(p.fetched).toHaveLength(40);
});

test("[integration] U1 malformed saved state is rejected and a new choice recovers", async () => {
  for (const bad of ["not json", JSON.stringify({dataset:"other",blind:{m01:"answer"},final:{},shown:{},pickedAt:{m01:"2026-10-07T10:00:00.000Z"},position:0})]) {
    const store = new Store(); store.data.set("jnj.uc13.labels.v2", bad);
    const p = await page("label", store); expect(p.get("status").textContent).toContain("0 of 40 labelled");
    p.get("bH").click(); const restored = await page("label", store);
    expect(restored.get("status").textContent).toContain("1 of 40 labelled");
  }
});
test("[integration] U1 invalid saved labels or positions cannot enter the current dataset", async () => {
  for (const invalid of [
    {position:-1},{position:40},{blind:{m01:"unknown"}},{blind:{m99:"answer"}},{blind:[]},
    // A final pick needs its blind pick and its suggestion-shown flag; a blind pick needs its time.
    {final:{m01:"answer"},shown:{}},{final:{m02:"answer"},shown:{m02:true}},{pickedAt:{}},
  ]) {
    const store = new Store(); const p = await page("label", store); p.get("bA").click();
    const snapshot = JSON.parse(store.data.get("jnj.uc13.labels.v2") ?? "null");
    store.data.set("jnj.uc13.labels.v2", JSON.stringify({...snapshot,...invalid}));
    const reloaded = await page("label", store);
    expect(reloaded.get("status").textContent).toContain("0 of 40 labelled");
    expect(reloaded.get("saveStatus").textContent).toContain("could not be restored");
  }
});
test("[integration] U1 quota failure reports unsaved latest choices and export preserves them", async () => {
  const store = new Store(); const p = await page("label", store); p.get("bH").click(); store.blocked = true;
  p.get("next").click(); p.get("bA").click(); expect(p.get("saveStatus").textContent).toContain("not saved");
  p.get("dl").click(); expect(await csvWithoutTimes(p.blobs[0])).toBe(`${LABELS_HEADER}\nm01,hand_off,,\nm02,answer,,\n`);
  store.blocked = false; p.get("prev").click();
  const restored = await page("label", store); expect(restored.get("status").textContent).toContain("2 of 40 labelled");
});
test("[integration] U1 changed acceptance rules invalidate old labels", async () => {
  const store = new Store(); const p = await page("label", store); p.get("bA").click();
  const changed = await page("label", store, text => text.replace("everything asked is covered", "nothing asked is covered"));
  expect(changed.get("status").textContent).toContain("0 of 40 labelled");
  expect(changed.get("saveStatus").textContent).toContain("changed");
});
test("[integration] U4 shop call buttons expose the current call and a completed seat stays editable after reload", async () => {
  const store = new Store(); const p = await page("little-shop", store);
  p.seat("m01");
  expect(p.get("sayAnswer").getAttribute("aria-pressed")).toBe("false");
  expect(p.get("sayHand").getAttribute("aria-pressed")).toBe("false");
  expect(p.get("callHint").textContent).toBe("");
  p.get("sayHand").click();
  expect(p.get("sayHand").getAttribute("aria-pressed")).toBe("true");
  expect(p.get("sayAnswer").getAttribute("aria-pressed")).toBe("false");
  expect(p.get("callHint").textContent).toContain("Change this call");
  const reloaded = await page("little-shop", store); reloaded.seat("m01");
  expect(reloaded.get("ask").hidden).toBe(false);
  expect(reloaded.get("sayHand").getAttribute("aria-pressed")).toBe("true");
  reloaded.get("sayAnswer").click();
  expect(reloaded.get("sayAnswer").getAttribute("aria-pressed")).toBe("true");
  expect(reloaded.get("sayHand").getAttribute("aria-pressed")).toBe("false");
  expect(reloaded.get("taken").textContent).toBe("3");
  expect(store.data.get("jnj.little-shop.call.v1.m01")).toBe("answer");
});
