// Behavioural check of site/little-shop/seating.js (the seating logic: calls, queue, tally, cost per accepted,
// storage), run without a browser.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SITE = join(import.meta.dir, "..", "site", "little-shop");

interface State { readonly calls: Record<string, string>; readonly cur: string | null; readonly queue: readonly string[] }
interface ArmRow { readonly key: string; readonly accepted: number; readonly calls: number; readonly perAccepted: number | null }
interface Seating {
  readonly VERDICT_AT: number;
  seatCode(i: number): string;
  blank(): State;
  pick(s: State, id: string): State;
  decide(s: State, call: string): State;
  queueUp(s: State, ids: readonly string[]): State;
  taken(calls: Record<string, string>, arms: number): number;
  tally(data: unknown, calls: Record<string, string>): ArmRow[];
  perAccepted(spend: unknown, total: number, n: number, accepted: number): number | null;
  usd(v: unknown): string;
  load(storage: unknown, ids: readonly string[]): Record<string, string>;
  save(storage: unknown, calls: Record<string, string>): boolean;
  clear(storage: unknown): boolean;
  emptyHouse(storage: unknown): { state: State; cleared: boolean };
  readonly KEY: string;
}

function isSeating(v: unknown): v is Seating {
  return typeof v === "object" && v !== null && typeof Reflect.get(v, "decide") === "function";
}

async function seating(): Promise<Seating> {
  const src = await readFile(join(SITE, "seating.js"), "utf8");
  const win: Record<string, unknown> = {};
  new Function("window", src)(win);
  const s = win.JNJSeating;
  if (!isSeating(s)) throw new Error("seating.js did not set window.JNJSeating");
  return s;
}

const IDS = Array.from({ length: 40 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`);

/** A small data object in the shop-data.js shape. */
function data(): unknown {
  return {
    arms: [
      { key: "llm", name: "L", model: "x", spend_usd: 0.4 },
      { key: "rule", name: "R", model: "y", spend_usd: 0 },
      { key: "jev", name: "J", model: "z", spend_usd: null },
    ],
    messages: [
      { id: "m01", text: "a", outputs: { llm: "answer", rule: "answer", jev: "hand_off" } },
      { id: "m02", text: "b", outputs: { llm: "hand_off", rule: "answer", jev: "hand_off" } },
      { id: "m03", text: "c", outputs: { llm: "answer", rule: "hand_off", jev: "answer" } },
      { id: "m04", text: "d", outputs: { llm: "answer", rule: "answer", jev: "answer" } },
    ],
  };
}

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}
class BlockedStorage {
  getItem(): string { throw new Error("SecurityError"); }
  setItem(): void { throw new Error("QuotaExceededError"); }
  removeItem(): void { throw new Error("SecurityError"); }
}

describe("little shop seating logic", () => {
  test("[unit] LSS-1 seats are rows A to E of 8: index 0 is A1, 7 is A8, 8 is B1, 39 is E8", async () => {
    const s = await seating();
    expect([0, 7, 8, 39].map((i) => s.seatCode(i))).toEqual(["A1", "A8", "B1", "E8"]);
  });

  test("[unit] LSS-2 one call seats all three clerks: taken is calls x arms, out of 120", async () => {
    const s = await seating();
    let st = s.pick(s.blank(), "m01");
    st = s.decide(st, "answer");
    expect(st.calls).toEqual({ m01: "answer" });
    expect(s.taken(st.calls, 3)).toBe(3);
    expect(s.taken(Object.fromEntries(IDS.map((id) => [id, "answer"])), 3)).toBe(120);
  });

  test("[unit] LSS-3 a decision with nothing on stage, or a call that is not answer or hand_off, changes nothing", async () => {
    const s = await seating();
    const empty = s.blank();
    expect(s.decide(empty, "answer")).toEqual(empty);
    const on = s.pick(empty, "m02");
    expect(s.decide(on, "maybe")).toEqual(on);
  });

  test("[unit] LSS-4 a row queues only its empty seats, one at a time, and never invents a call", async () => {
    const s = await seating();
    let st = s.decide(s.pick(s.blank(), "m02"), "hand_off");
    st = s.queueUp(st, ["m01", "m02", "m03"]);
    expect(st.cur).toBe("m01");
    expect(st.queue).toEqual(["m03"]);
    expect(Object.keys(st.calls)).toEqual(["m02"]);
    st = s.decide(st, "answer");
    expect(st.cur).toBe("m03");
    expect(st.queue).toEqual([]);
    st = s.decide(st, "hand_off");
    expect(st.calls).toEqual({ m02: "hand_off", m01: "answer", m03: "hand_off" });
    // queue empty: the last message stays on stage, showing the call just made
    expect(st.cur).toBe("m03");
    // a full row queues nothing
    expect(s.queueUp(st, ["m01", "m02", "m03"])).toEqual(st);
  });

  test("[unit] LSS-5 picking a seat clears the queue; the whole house queues every empty seat in order", async () => {
    const s = await seating();
    let st = s.queueUp(s.blank(), IDS);
    expect(st.cur).toBe("m01");
    expect(st.queue.length).toBe(39);
    st = s.pick(st, "m20");
    expect(st.queue).toEqual([]);
    expect(st.cur).toBe("m20");
  });

  test("[unit] LSS-6 tally: an arm is accepted when its recorded output equals the call; cost per accepted is spend / 40 x calls / accepted", async () => {
    const s = await seating();
    const d = data();
    const rows = s.tally(d, { m01: "answer", m02: "hand_off", m03: "answer" });
    expect(rows.map((r) => [r.key, r.accepted, r.calls])).toEqual([["llm", 3, 3], ["rule", 1, 3], ["jev", 2, 3]]);
    // 4 messages in the data: spend / 4 x 3 calls / 3 accepted
    expect(rows[0]?.perAccepted).toBeCloseTo(0.4 / 4 * 3 / 3, 12);
    expect(rows[1]?.perAccepted).toBe(0);
    // unmeasured spend has no cost per accepted, never $0
    expect(rows[2]?.perAccepted).toBeNull();
    expect(s.tally(d, {}).map((r) => [r.key, r.accepted, r.calls, r.perAccepted])).toEqual([["llm", 0, 0, null], ["rule", 0, 0, null], ["jev", 0, 0, null]]);
  });

  test("[unit] LSS-7 cost per accepted is null with 0 accepted or a spend that is not a number", async () => {
    const s = await seating();
    expect(s.perAccepted(0.103167, 40, 30, 20)).toBeCloseTo(0.103167 / 40 * 30 / 20, 12);
    for (const bad of [null, undefined, "0.1", Number.NaN, -1]) expect(s.perAccepted(bad, 40, 30, 20)).toBeNull();
    expect(s.perAccepted(0.1, 40, 30, 0)).toBeNull();
    expect(s.usd(null)).toBe("n/a");
    expect(s.usd(0)).toBe("$0");
    expect(s.usd(0.103167)).toBe("$0.103167");
    expect(s.usd(0.0000488)).toBe("$0.000049");
  });

  test("[unit] LSS-8 calls round-trip through storage; only known ids with answer or hand_off are read back", async () => {
    const s = await seating();
    const store = new MemoryStorage();
    expect(s.save(store, { m01: "answer", m02: "hand_off" })).toBe(true);
    expect(s.load(store, IDS)).toEqual({ m01: "answer", m02: "hand_off" });
    store.setItem(s.KEY, '{"m01":"answer","m99":"answer","m03":"maybe","__proto__":"answer","constructor":"answer","m04":{"x":1}}');
    expect(s.load(store, IDS)).toEqual({ m01: "answer" });
    for (const junk of ["not json", "[1,2]", "null", "42"]) {
      store.setItem(s.KEY, junk);
      expect(s.load(store, IDS)).toEqual({});
    }
    expect(s.clear(store)).toBe(true);
    expect(store.map.has(s.KEY)).toBe(false);
  });

  test("[unit] LSS-9 blocked or missing storage never throws: load reads nothing, save and clear report false", async () => {
    const s = await seating();
    for (const st of [new BlockedStorage(), null, undefined]) {
      expect(s.load(st, IDS)).toEqual({});
      expect(s.save(st, { m01: "answer" })).toBe(false);
      expect(s.clear(st)).toBe(false);
    }
  });

  test("[unit] LSS-10 the verdict is read at 30 calls", async () => {
    const s = await seating();
    expect(s.VERDICT_AT).toBe(30);
  });

  test("[integration] LSS-11 the footer's claims hold in the shipped files: no request carries a call; storage only via seating.js; Empty the house clears it", async () => {
    // code files: no network API named at all (bracket access included, since the bare word is banned)
    for (const f of ["seating.js", "house.js", "verdict.js"]) {
      const src = await readFile(join(SITE, f), "utf8");
      expect(src).not.toMatch(/fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\s*\(|Image\b|\.src\s*=|\.href\s*=|location\s*=|\bopen\s*\(/);
      if (f !== "seating.js") expect(src).not.toMatch(/localStorage\.|sessionStorage|indexedDB|document\.cookie/);
    }
    // the data file is one JSON assignment under a comment: nothing in it runs
    const dataJs = await readFile(join(SITE, "shop-data.js"), "utf8");
    const at = dataJs.indexOf("\nwindow.JNJ_LITTLE_SHOP = ");
    expect(dataJs.slice(0, at)).toMatch(/^\/\*[\s\S]*\*\/$/);
    expect(() => JSON.parse(dataJs.slice(at + "\nwindow.JNJ_LITTLE_SHOP = ".length).trim().replace(/;$/, ""))).not.toThrow();
    // no inline script or style in the page
    const html = await readFile(join(SITE, "index.html"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>|<style|\bon[a-z]+=/i);
    expect(await readFile(join(SITE, "house.css"), "utf8")).not.toMatch(/url\(|@import/);
    const page = await readFile(join(SITE, "index.html"), "utf8");
    // every external resource the page loads (link href, script src) is a font; anchors are links, not requests
    const loads = [...page.matchAll(/<(?:link|script)[^>]*(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? "");
    const hosts = loads.filter((u) => /^[a-z]+:/i.test(u)).map((u) => new URL(u).host);
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.every((h) => h === "fonts.googleapis.com" || h === "fonts.gstatic.com")).toBe(true);
    expect(loads.filter((u) => !/^https?:/.test(u))).toEqual(["house.css", "shop-data.js", "seating.js", "verdict.js", "house.js"]);
    const house = await readFile(join(SITE, "house.js"), "utf8");
    const empty = house.slice(house.indexOf('$("emptyHouse")'), house.indexOf("window.addEventListener(\"storage\""));
    expect(empty).toContain("S.emptyHouse(store)");
  });

  test("[unit] LSS-12 Empty the house clears the calls and the stored key; with storage blocked it says it could not", async () => {
    const s = await seating();
    const store = new MemoryStorage();
    s.save(store, { m01: "answer" });
    const r = s.emptyHouse(store);
    expect(r.state).toEqual(s.blank());
    expect(r.cleared).toBe(true);
    expect(store.map.has(s.KEY)).toBe(false);
    expect(s.emptyHouse(new BlockedStorage()).cleared).toBe(false);
    expect(s.emptyHouse(new BlockedStorage()).state).toEqual(s.blank());
  });
});
