// Behavioural check of site/theatre.js without a browser: the script runs against small fakes of the elements it
// touches, with scrollY pinned at 0 the way a slow smooth scroll leaves it, and the test reads the curtain state.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Handler = (e: { target: unknown }) => void;

class FakeNode {}

class FakeEl extends FakeNode {
  readonly classes = new Set<string>();
  readonly props = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly handlers = new Map<string, Handler[]>();
  readonly children = new Set<FakeEl>();
  value = "";
  offsetHeight = 900;
  focused = false;
  readonly classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on: boolean) => { if (on) this.classes.add(c); else this.classes.delete(c); },
  };
  readonly style = { setProperty: (k: string, v: string) => { this.props.set(k, v); } };
  addEventListener(type: string, fn: Handler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  fire(type: string, target: unknown = this): void {
    for (const fn of this.handlers.get(type) ?? []) fn({ target });
  }
  contains(other: unknown): boolean {
    return other === this || [...this.children].some((c) => c.contains(other));
  }
  focus(): void { this.focused = true; }
}

interface Stage {
  readonly root: FakeEl;
  readonly ids: Map<string, FakeEl>;
  readonly main: FakeEl;
  readonly doc: FakeEl;
  readonly win: FakeEl;
  readonly scrolls: unknown[];
}

async function runTheatre(hash = ""): Promise<Stage> {
  const src = await readFile(join(import.meta.dir, "..", "site", "theatre.js"), "utf8");
  const root = new FakeEl();
  root.classes.add("motion");
  const ids = new Map<string, FakeEl>();
  for (const id of ["overture", "runway", "askInput", "door", "skipOverture", "t1", "cueBtn"]) ids.set(id, new FakeEl());
  const main = new FakeEl();
  for (const id of ["askInput", "door", "t1", "cueBtn"]) {
    const el = ids.get(id);
    if (el) main.children.add(el);
  }
  const scrolls: unknown[] = [];
  const doc = new FakeEl();
  const win = new FakeEl();
  const stage = {
    openerTail: "to do a thing?",
    playOpener: () => {},
    act1Final: () => { const i = ids.get("askInput"); if (i) i.value = "to do a thing?"; },
  };
  const windowObj = {
    JNJStage: stage,
    scrollY: 0,
    innerHeight: 900,
    scrollTo: (o: unknown) => { scrolls.push(o); },
    addEventListener: (t: string, fn: Handler) => win.addEventListener(t, fn),
  };
  const documentObj = {
    documentElement: root,
    getElementById: (id: string) => ids.get(id) ?? null,
    querySelector: (sel: string) => (sel === "main" ? main : null),
    addEventListener: (t: string, fn: Handler) => doc.addEventListener(t, fn),
  };
  const run = new Function("window", "document", "location", "requestAnimationFrame", "Node", "setTimeout", "clearTimeout", src);
  run(windowObj, documentObj, { hash }, (fn: () => void) => { fn(); return 0; }, FakeNode, () => 0, () => {});
  return { root, ids, main, doc, win, scrolls };
}

describe("theatre.js curtain", () => {
  test("[unit] SITE-5 loads closed at scrollY 0", async () => {
    const s = await runTheatre();
    expect(s.root.dataset.curtain).toBe("closed");
    expect(s.root.dataset.beat).toBe("0");
  });

  test("[unit] SITE-5 Skip the overture opens the curtain at once, with scrollY still 0, and a scroll event never re-closes it", async () => {
    const s = await runTheatre();
    s.ids.get("skipOverture")?.fire("click");
    expect(s.root.dataset.curtain).toBe("open");
    expect(s.ids.get("overture")?.props.get("--p")).toBe("1.0000");
    expect(s.ids.get("overture")?.classes.has("gone")).toBe(true);
    expect(s.root.dataset.beat).toBe("3");
    expect(s.ids.get("door")?.classes.has("shown")).toBe(true);
    expect(s.ids.get("t1")?.focused).toBe(true);
    expect(s.scrolls).toEqual([{ top: 900, behavior: "instant" }]);
    s.win.fire("scroll");
    expect(s.root.dataset.curtain).toBe("open");
  });

  test("[unit] SITE-5 tabbing into the page opens the curtain without waiting for the scroll", async () => {
    const s = await runTheatre();
    s.doc.fire("focusin", s.ids.get("cueBtn"));
    expect(s.root.dataset.curtain).toBe("open");
    s.win.fire("scroll");
    expect(s.root.dataset.curtain).toBe("open");
  });

  test("[unit] SITE-5 a deep link loads open", async () => {
    const s = await runTheatre("#act3");
    expect(s.root.dataset.curtain).toBe("open");
    expect(s.root.dataset.beat).toBe("3");
  });
});
