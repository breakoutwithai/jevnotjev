// Minimal DOM and clock fakes for running the site's vanilla scripts under bun test, with no browser.
// Only what theatre.js and stage-door.js touch is modelled.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Handler = (e: { target: unknown }) => void;

export class FakeNode {}

export class FakeEl extends FakeNode {
  readonly classes = new Set<string>();
  readonly props = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly handlers = new Map<string, Handler[]>();
  readonly children = new Set<FakeEl>();
  readonly attrs = new Map<string, string>();
  value = "";
  innerHTML = "";
  hidden = false;
  offsetHeight = 900;
  focused = false;
  lastElementChild: FakeEl | null = null;
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
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, v: string): void { this.attrs.set(name, v); }
  scrollIntoView(): void {}
  querySelectorAll(): FakeEl[] { return []; }
  querySelector(): FakeEl | null { return null; }
}

interface Timer { readonly id: number; readonly at: number; readonly fn: () => void }

/** A clock that only moves when the test says so. */
export class FakeClock {
  now = 0;
  private next = 1;
  private timers: Timer[] = [];
  readonly setTimeout = (fn: () => void, ms: number): number => {
    const id = this.next++;
    this.timers.push({ id, at: this.now + ms, fn });
    return id;
  };
  readonly clearTimeout = (id: number): void => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };
  get pending(): number { return this.timers.length; }
  /** Run due timers in time order until `until` returns true or none are left. */
  runUntil(until: () => boolean = () => false): void {
    while (!until() && this.timers.length > 0) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = this.timers.shift();
      if (!t) return;
      this.now = t.at;
      t.fn();
    }
  }
}

export async function siteScript(name: string): Promise<string> {
  return readFile(join(import.meta.dir, "..", "site", name), "utf8");
}
