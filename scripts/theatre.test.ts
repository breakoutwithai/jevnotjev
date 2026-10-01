// Behavioural check of site/theatre.js without a browser: the script runs against small fakes of the elements it
// touches, with a clock the test advances, and the test reads the curtain and beat state.

import { describe, expect, test } from "bun:test";
import { FakeClock, FakeEl, FakeNode, type Handler, siteScript } from "./dom-fakes.ts";

interface Stage {
  readonly root: FakeEl;
  readonly ids: Map<string, FakeEl>;
  readonly doc: FakeEl;
  readonly win: FakeEl;
  readonly scrolls: unknown[];
  readonly clock: FakeClock;
  readonly played: { count: number };
  scrollTo(y: number): void;
}

async function runTheatre(hash = "", withStage = true): Promise<Stage> {
  const src = await siteScript("theatre.js");
  const root = new FakeEl();
  root.classes.add("motion");
  const ids = new Map<string, FakeEl>();
  for (const id of ["overture", "runway", "askInput", "door", "skipOverture", "t1", "cues", "cueBtn", "dialogue"]) ids.set(id, new FakeEl());
  const main = new FakeEl();
  for (const id of ["askInput", "door", "t1", "cues", "cueBtn", "dialogue"]) {
    const el = ids.get(id);
    if (el) main.children.add(el);
  }
  const scrolls: unknown[] = [];
  const doc = new FakeEl();
  const win = new FakeEl();
  const clock = new FakeClock();
  const played = { count: 0 };
  const dialogue = ids.get("dialogue");
  const stage = {
    openerTail: "to do a thing?",
    playOpener: () => { played.count++; if (dialogue) dialogue.lastElementChild = new FakeEl(); },
    act1Final: () => { const i = ids.get("askInput"); if (i) i.value = "to do a thing?"; },
  };
  const windowObj = {
    JNJStage: withStage ? stage : undefined,
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
  run(windowObj, documentObj, { hash }, (fn: () => void) => { fn(); return 0; }, FakeNode, clock.setTimeout, clock.clearTimeout);
  return {
    root, ids, doc, win, scrolls, clock, played,
    scrollTo(y: number) { windowObj.scrollY = y; win.fire("scroll"); },
  };
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
    s.scrollTo(0);
    expect(s.root.dataset.curtain).toBe("open");
  });

  test("[unit] SITE-5 tabbing into the page opens the curtain without waiting for the scroll", async () => {
    const s = await runTheatre();
    s.doc.fire("focusin", s.ids.get("cueBtn"));
    expect(s.root.dataset.curtain).toBe("open");
    s.scrollTo(0);
    expect(s.root.dataset.curtain).toBe("open");
  });

  test("[unit] SITE-11 if the page script failed (no JNJStage), the page falls back to static: no curtain over the site", async () => {
    const s = await runTheatre("", false);
    expect(s.root.classes.has("motion")).toBe(false);
    expect(s.root.classes.has("static")).toBe(true);
    expect(s.ids.get("overture")?.classes.has("gone")).toBe(true);
    expect(s.root.dataset.beat).toBe("3");
  });

  test("[unit] SITE-12 focus that comes from a pointer opens the curtain without scrolling, so the click lands where aimed", async () => {
    const s = await runTheatre();
    s.doc.fire("pointerdown", s.ids.get("cueBtn"));
    s.doc.fire("focusin", s.ids.get("cueBtn"));
    expect(s.root.dataset.curtain).toBe("open");
    expect(s.scrolls).toEqual([]);
    const k = await runTheatre();
    k.doc.fire("keydown", k.ids.get("cueBtn"));
    k.doc.fire("focusin", k.ids.get("cueBtn"));
    expect(k.scrolls).toEqual([{ top: 900, behavior: "instant" }]);
  });

  test("[unit] SITE-5 a deep link loads open", async () => {
    const s = await runTheatre("#act3");
    expect(s.root.dataset.curtain).toBe("open");
    expect(s.root.dataset.beat).toBe("3");
  });
});

describe("theatre.js Act I beats", () => {
  test("[unit] SITE-7 choosing an example while the opener types cancels the opener: no later timer overwrites the choice", async () => {
    const s = await runTheatre();
    s.scrollTo(0.9 * 900);
    expect(s.root.dataset.act1).toBe("typing");
    // capture on #cues runs before the example's own handler, which then writes its question
    s.ids.get("cues")?.fire("click", s.ids.get("cueBtn"));
    const input = s.ids.get("askInput");
    if (input) input.value = "to route support tickets?";
    s.clock.runUntil();
    expect(input?.value).toBe("to route support tickets?");
    expect(input?.classes.has("struck")).toBe(false);
    expect(s.played.count).toBe(0);
    expect(s.root.dataset.act1).toBe("dialogue");
    s.scrollTo(900);
    expect(s.root.dataset.beat).toBe("3");
  });

  test("[unit] SITE-8 the note waits for the last dialogue line's animationend, with a timer fallback", async () => {
    const s = await runTheatre();
    s.scrollTo(0.9 * 900);
    s.clock.runUntil(() => s.played.count > 0);
    expect(s.root.dataset.act1).toBe("dialogue");
    s.scrollTo(900);
    expect(s.root.dataset.beat).toBe("2");
    s.ids.get("dialogue")?.lastElementChild?.fire("animationend");
    expect(s.root.dataset.beat).toBe("3");

    const t = await runTheatre();
    t.scrollTo(0.9 * 900);
    t.clock.runUntil(() => t.played.count > 0);
    const startedAt = t.clock.now;
    t.scrollTo(900);
    t.clock.runUntil(() => t.root.dataset.beat === "3");
    expect(t.root.dataset.beat).toBe("3");
    expect(t.clock.now - startedAt).toBeGreaterThanOrEqual(1100);
  });
});
