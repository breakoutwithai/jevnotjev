// Behavioural check of site/replay/paging.js: a long run plays cases 1 to 10 one at a time, then 10 cases per step.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface Range { readonly from: number; readonly to: number }
interface Group extends Range { readonly end: number; readonly single: boolean }
interface Paging {
  blockEnd(pos: number, by: number | undefined, total: number): number;
  blockStart(pos: number, by: number | undefined, total: number): number;
  next(pos: number, by: number | undefined, total: number): number;
  prev(pos: number, by: number | undefined, total: number): number;
  range(pos: number, by: number | undefined, total: number): Range;
  steps(by: number | undefined, total: number): number[];
  groups(by: number | undefined, total: number): Group[];
}

function isPaging(v: unknown): v is Paging {
  return typeof v === "object" && v !== null && typeof Reflect.get(v, "next") === "function" && typeof Reflect.get(v, "groups") === "function";
}

async function paging(): Promise<Paging> {
  const src = await readFile(join(import.meta.dir, "..", "site", "replay", "paging.js"), "utf8");
  const win: Record<string, unknown> = {};
  new Function("window", src)(win);
  const api = win.JNJ_PAGING;
  if (!isPaging(api)) throw new Error("paging.js did not set JNJ_PAGING");
  return api;
}

/** Positions are 0-based, so case N is position N - 1. */
const caseNo = (pos: number): number => pos + 1;

describe("replay paging (site/replay/paging.js)", () => {
  test("[unit] PG-1 Play on 300 cases steps cases 1 to 10 one at a time, then 20, 30, ... 300: 39 steps", async () => {
    const p = await paging();
    const shown = p.steps(10, 300).map(caseNo);
    expect(shown.slice(0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(shown.slice(10, 13)).toEqual([20, 30, 40]);
    expect(shown.at(-1)).toBe(300);
    expect(shown.length).toBe(39);
    expect(shown.slice(9).every((n, i, all) => i === 0 || n - (all[i - 1] ?? 0) === 10)).toBe(true);
  });

  test("[unit] PG-2 a page step shows ten cases: 11-20, then 21-30, with the last page 291-300", async () => {
    const p = await paging();
    const r = (pos: number): [number, number] => { const g = p.range(pos, 10, 300); return [caseNo(g.from), caseNo(g.to)]; };
    expect(r(9)).toEqual([10, 10]);
    expect(r(19)).toEqual([11, 20]);
    expect(r(29)).toEqual([21, 30]);
    expect(r(299)).toEqual([291, 300]);
  });

  test("[unit] PG-3 next and prev are inverses over the steps, and prev from case 20 returns to case 10", async () => {
    const p = await paging();
    const steps = p.steps(10, 300);
    for (let i = 1; i < steps.length; i++) {
      const at = steps[i] ?? 0;
      expect(p.prev(at, 10, 300)).toBe(steps[i - 1] ?? -1);
      expect(p.next(steps[i - 1] ?? 0, 10, 300)).toBe(at);
    }
    expect(p.prev(19, 10, 300)).toBe(9);
    expect(p.prev(0, 10, 300)).toBe(0);
    expect(p.next(299, 10, 300)).toBe(299);
  });

  test("[unit] PG-4 a position in the middle of a page snaps to the end of that page", async () => {
    const p = await paging();
    expect(caseNo(p.blockEnd(14, 10, 300))).toBe(20);
    expect(caseNo(p.blockEnd(20, 10, 300))).toBe(30);
    expect(caseNo(p.next(14, 10, 300))).toBe(20);
    expect(caseNo(p.prev(14, 10, 300))).toBe(10);
    expect(p.blockEnd(5, 10, 300)).toBe(5);
  });

  test("[unit] PG-5 a total that is not a multiple of ten ends on a short last page", async () => {
    const p = await paging();
    const g = p.range(294, 10, 295);
    expect([caseNo(g.from), caseNo(g.to)]).toEqual([291, 295]);
    expect(p.steps(10, 295).at(-1)).toBe(294);
    expect(p.steps(10, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  test("[unit] PG-6 a run with no page size plays one case per step, as before", async () => {
    const p = await paging();
    expect(p.steps(undefined, 40)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(p.next(7, undefined, 40)).toBe(8);
    expect(p.prev(7, undefined, 40)).toBe(6);
    expect(p.range(7, undefined, 40)).toEqual({ from: 7, to: 7 });
  });

  test("[unit] PG-7 the strip of 300 cases is 10 squares and 29 page chips, each jumping to its page end", async () => {
    const p = await paging();
    const g = p.groups(10, 300);
    expect(g.length).toBe(39);
    expect(g.filter((x) => x.single).length).toBe(10);
    expect(g[10]).toEqual({ from: 10, to: 19, end: 19, single: false });
    expect(g.at(-1)).toEqual({ from: 290, to: 299, end: 299, single: false });
    expect(g.reduce((n, x) => n + (x.to - x.from + 1), 0)).toBe(300);
  });
});
