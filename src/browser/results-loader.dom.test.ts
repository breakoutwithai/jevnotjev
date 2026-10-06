// D12: the public page loads the visitor's own jnj-record/1 CSV in the browser. Driven through attachLoader with
// DOM fakes (no browser), over the real validator, metrics and verdict.

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleLoader, LOADER_OUT } from "../../scripts/build-loader.ts";
import {
  attachLoader,
  IDS,
  type LoaderDocument,
  type LoaderElement,
  type LoaderEvent,
  type LoaderFile,
} from "./results-loader.ts";

const ROOT = join(import.meta.dir, "..", "..");

class FakeEl implements LoaderElement {
  textContent: string | null = "";
  innerHTML = "";
  hidden = true;
  disabled = true;
  files: LoaderFile[] | null = null;
  readonly classes = new Set<string>(["is-off"]);
  readonly classList = {
    add: (c: string): void => { this.classes.add(c); },
    remove: (c: string): void => { this.classes.delete(c); },
  };
  private readonly handlers = new Map<string, ((e: LoaderEvent) => void)[]>();
  addEventListener(type: string, fn: (e: LoaderEvent) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  fire(type: string, e: LoaderEvent = { preventDefault: () => {} }): void {
    for (const fn of this.handlers.get(type) ?? []) fn(e);
  }
}

function page(): { doc: LoaderDocument; zone: FakeEl; input: FakeEl; status: FakeEl; panel: FakeEl } {
  const zone = new FakeEl();
  const input = new FakeEl();
  const status = new FakeEl();
  const panel = new FakeEl();
  const byId = new Map<string, FakeEl>([[IDS.zone, zone], [IDS.input, input], [IDS.status, status], [IDS.panel, panel]]);
  return { doc: { getElementById: (id) => byId.get(id) ?? null }, zone, input, status, panel };
}

function file(name: string, text: string): LoaderFile {
  const bytes = new TextEncoder().encode(text);
  return { name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

/** Choose a file as the visitor would, and wait for the page to show the outcome. */
async function choose(f: LoaderFile): Promise<ReturnType<typeof page>> {
  const p = page();
  expect(attachLoader(p.doc)).toBe(true);
  p.input.files = [f];
  p.input.fire("change");
  for (let i = 0; i < 200 && p.panel.hidden; i++) await Bun.sleep(5);
  return p;
}

async function example(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), "utf8");
}

/** d06-tiny with the output on the given 1-based line replaced. */
function withOutput(csv: string, line: number, output: string): string {
  const lines = csv.split("\n");
  const row = lines[line - 1] ?? "";
  lines[line - 1] = row.replace(/,yes\|no,([a-z]+),([^,]+),(yes|no),/, `,yes|no,$1,$2,${output},`);
  return lines.join("\n");
}

const D06 = "examples/d06-tiny/records.csv";
const USE_JEV = "examples/d08-verdicts/r3-use-jev.csv";

describe("results loader (D12: load your own results CSV in the browser)", () => {
  test("[unit] D12-L1 the page's input and drop zone are enabled: no disabled attribute, no is-off, no Opens soon", async () => {
    const html = await readFile(join(ROOT, "site", "index.html"), "utf8");
    const input = /<input[^>]*id="csv"[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain('type="file"');
    expect(input).not.toContain("disabled");
    expect(/<label[^>]*id="dropzone"[^>]*>/.exec(html)?.[0] ?? "").not.toContain("is-off");
    expect(html).not.toContain("Opens soon");
    expect(html).not.toContain("when the loader ships");
    expect(html).toContain('<script src="results-loader.js"></script>');
    expect(html).toContain('id="loadedResult"');
  });

  test("[unit] D12-L2 attaching enables a disabled input and an is-off zone", () => {
    const p = page();
    expect(p.input.disabled).toBe(true);
    attachLoader(p.doc);
    expect(p.input.disabled).toBe(false);
    expect(p.zone.classes.has("is-off")).toBe(false);
  });

  test("[unit] D12-L3 a valid file shows VALID, each method's summary and a verdict per question", async () => {
    const p = await choose(file("mine.csv", await example(USE_JEV)));
    expect(p.panel.hidden).toBe(false);
    expect(p.panel.innerHTML).toContain(">VALID<");
    expect(p.panel.innerHTML).toContain("VALID rows=90 cases=30 errors=0 gaps=0");
    for (const method of ["jev: rows=30 labelled=30 accepted=30", "llm: rows=30 labelled=30 accepted=27", "rule: rows=30 labelled=30 accepted=10"]) {
      expect(p.panel.innerHTML).toContain(method);
    }
    expect(p.panel.innerHTML).toContain("Verdict per question");
    expect(p.panel.innerHTML).toContain("use Jev");
    expect(p.status.textContent).toContain("VALID");
    expect(p.status.textContent).toContain("nothing uploaded");
  });

  test("[unit] D12-L4 an invalid file shows INVALID and each error with its line and problem, and no verdict", async () => {
    const bad = withOutput(withOutput(await example(D06), 3, "maybe"), 5, "perhaps");
    const p = await choose(file("bad.csv", bad));
    expect(p.panel.hidden).toBe(false);
    expect(p.panel.innerHTML).toContain(">INVALID<");
    expect(p.panel.innerHTML).toContain("ERROR line 3: output &#39;maybe&#39; is not in answer_set");
    expect(p.panel.innerHTML).toContain("ERROR line 5: output &#39;perhaps&#39; is not in answer_set");
    expect(p.panel.innerHTML.match(/<li>ERROR /g)?.length).toBe(2);
    expect(p.panel.innerHTML).not.toContain("Verdict per question");
    expect(p.status.textContent).toContain("INVALID");
  });

  test("[unit] D12-L5 a file with missing costs and labels shows every GAP line and stays VALID", async () => {
    const p = await choose(file("gaps.csv", await example(D06)));
    expect(p.panel.innerHTML).toContain(">VALID<");
    expect(p.panel.innerHTML).toContain("GAP line 21: cost_usd missing (cv5, q2, rule)");
    expect(p.panel.innerHTML).toContain("GAP line 25: unlabelled (cv2, q2, llm)");
    expect(p.panel.innerHTML.match(/<li>GAP /g)?.length).toBe(2);
    expect(p.panel.innerHTML).toContain("rule: rows=10 labelled=10 accepted=6 cost=incomplete");
  });

  test("[unit] D12-L6 text from the file is escaped: an img onerror cell and a markup file name render as text", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const bad = withOutput(await example(D06), 3, hostile);
    const p = await choose(file("<b onclick=x>.csv", bad));
    expect(p.panel.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(p.panel.innerHTML).not.toContain("<img");
    expect(p.panel.innerHTML).not.toContain("<b onclick");
    expect(p.panel.innerHTML).toContain("&lt;b onclick=x&gt;.csv");
  });

  test("[unit] D12-L7 a file that is not UTF-8 is INVALID with a message, not a crash", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41]);
    const p = await choose({ name: "bin.csv", arrayBuffer: async () => bytes.buffer });
    expect(p.panel.innerHTML).toContain(">INVALID<");
    expect(p.panel.innerHTML).toContain("ERROR file is not valid UTF-8");
  });

  test("[unit] D12-L8 dropping a file on the zone loads it too", async () => {
    const p = page();
    attachLoader(p.doc);
    p.zone.fire("drop", { preventDefault: () => {}, dataTransfer: { files: [file("d.csv", await example(USE_JEV))] } });
    for (let i = 0; i < 200 && p.panel.hidden; i++) await Bun.sleep(5);
    expect(p.panel.innerHTML).toContain(">VALID<");
  });

  test("[unit] D12-L9 before any file is chosen the result panel stays hidden (sample play untouched)", () => {
    const p = page();
    attachLoader(p.doc);
    expect(p.panel.hidden).toBe(true);
    expect(p.panel.innerHTML).toBe("");
  });

  test("[unit] D12-L10 the page without the loader's elements is left alone", () => {
    expect(attachLoader({ getElementById: () => null })).toBe(false);
  });
});

describe("results loader sends nothing", () => {
  const real = { fetch: globalThis.fetch, xhr: Reflect.get(globalThis, "XMLHttpRequest"), ws: Reflect.get(globalThis, "WebSocket") };
  afterEach(() => {
    globalThis.fetch = real.fetch;
    Reflect.set(globalThis, "XMLHttpRequest", real.xhr);
    Reflect.set(globalThis, "WebSocket", real.ws);
  });

  test("[unit] D12-N1 loading a file makes no fetch, XHR or WebSocket call", async () => {
    const calls: string[] = [];
    globalThis.fetch = Object.assign(async (): Promise<Response> => { calls.push("fetch"); throw new Error("network"); }, { preconnect: () => {} });
    Reflect.set(globalThis, "XMLHttpRequest", function Xhr() { calls.push("xhr"); });
    Reflect.set(globalThis, "WebSocket", function Ws() { calls.push("ws"); });
    const p = await choose(file("mine.csv", await example(USE_JEV)));
    expect(p.panel.innerHTML).toContain(">VALID<");
    expect(calls).toEqual([]);
  });

  test("[unit] D12-N2 neither the loader source nor the built bundle contains a network call", async () => {
    const src = await readFile(join(ROOT, "src", "browser", "results-loader.ts"), "utf8");
    const built = await readFile(LOADER_OUT, "utf8");
    for (const text of [src, built]) {
      expect(text).not.toMatch(/\bfetch\s*\(/);
      expect(text).not.toMatch(/XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts/);
    }
  });

  test("[integration] D12-B1 site/results-loader.js is the current build of the loader source", async () => {
    expect(await readFile(LOADER_OUT, "utf8")).toBe(await bundleLoader());
  });
});
