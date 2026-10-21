// /guide/ provider roadmap and request dialog: the static page. What "works today" must match the code it describes
// (the TokenMax mapper's sources, version and default window; the Backstage catalog's providers), what is "next" is
// requested, not built, with no date, and the dialog's fields are labelled. The browser behaviour is in
// scripts/guide-provider.dom.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_CATALOG } from "../backstage/catalog.ts";
import { QUESTION_LIMITS } from "../guest-intake/contract.ts";
import { parseArgs, VERSION } from "../../site/tm/map.ts";

const ROOT = join(import.meta.dir, "..", "..");
const GUIDE = readFileSync(join(ROOT, "site/guide/index.html"), "utf8");
const SCRIPT = readFileSync(join(ROOT, "site/guide/guide.js"), "utf8");

interface Grabbed { readonly tag: string; readonly attrs: Map<string, string>; text: string }

/** Every element matching `selector`, with its attributes and rendered text (nested markup included). */
async function grab(html: string, selector: string): Promise<Grabbed[]> {
  const out: Grabbed[] = [];
  const open: Grabbed[] = [];
  await new HTMLRewriter()
    .on(selector, {
      element(el) {
        const g: Grabbed = { tag: el.tagName, attrs: new Map([...el.attributes].map(([k, v]) => [k, v])), text: "" };
        out.push(g);
        if (el.selfClosing || !el.canHaveContent) return;
        open.push(g);
        el.onEndTag(() => { open.pop(); });
      },
      text(chunk) {
        for (const g of open) g.text += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  for (const g of out) g.text = g.text.replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return out;
}

const textOf = async (html: string, selector: string): Promise<string> => (await grab(html, selector)).map((g) => g.text).join(" | ");

const PROVIDER_NAMES: Readonly<Record<string, string>> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", xai: "xAI" };

describe("guide provider roadmap section", () => {
  test("[unit] GPR-1 the section exists with its heading and sits outside the field guide", async () => {
    expect(await textOf(GUIDE, "#providers-title")).toBe("What works today and what is next");
    expect(await textOf(GUIDE, "#reference #providers")).toBe("");
  });

  test("[unit] GPR-2 TokenMax facts match the mapper: Claude Code and Codex, its version and its default window", async () => {
    const now = await textOf(GUIDE, "#providersNow");
    expect(now).toContain("Claude Code");
    expect(now).toContain("Codex");
    expect(now).toContain("--days");
    const args = parseArgs([], { home: "/nonexistent-home", now: Date.parse("2026-10-20T00:00:00Z"), cwd: "/tmp" });
    expect(await textOf(GUIDE, '#providers [data-const="TM_DEFAULT_DAYS"]')).toBe(String(args.days));
    expect(await textOf(GUIDE, '#providers [data-const="TM_VERSION"]')).toBe(VERSION);
  });

  test("[unit] GPR-3 every Backstage comparison provider in the catalog is named as working today", async () => {
    const now = await textOf(GUIDE, "#providersNow");
    const providers = [...new Set(MODEL_CATALOG.map((e) => e.provider).filter((p) => p !== "jev"))];
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) expect(`${p}: ${now.includes(PROVIDER_NAMES[p] ?? `missing name for ${p}`)}`).toBe(`${p}: true`);
  });

  test("[unit] GPR-4 the roadmap lists Grok and Gemini as requested, not built, with no date", async () => {
    const items = (await grab(GUIDE, "#providersNext li")).map((g) => g.text);
    expect(items.some((t) => t.includes("xAI (Grok)") && t.includes("requested, not built"))).toBe(true);
    expect(items.some((t) => t.includes("Google (Gemini)") && t.includes("requested, not built"))).toBe(true);
    const section = await textOf(GUIDE, "#providers");
    expect(section).not.toMatch(/\b(20\d\d|Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December|soon|next week|next month)\b/);
  });
});

describe("guide provider request dialog", () => {
  test("[unit] GPR-5 the CTA opens a labelled modal dialog", async () => {
    const [cta] = await grab(GUIDE, "#providerAsk");
    expect(cta?.tag).toBe("button");
    expect(cta?.text).toBe("Ask for a model or provider");
    expect(cta?.attrs.get("aria-haspopup")).toBe("dialog");
    expect(cta?.attrs.get("aria-controls")).toBe("providerDialog");
    const [dialog] = await grab(GUIDE, "dialog#providerDialog");
    expect(dialog?.attrs.get("aria-labelledby")).toBe("providerDialogTitle");
    expect(await textOf(GUIDE, "#providerDialogTitle")).not.toBe("");
  });

  test("[unit] GPR-6 every field has a label, email is optional, the option list names Grok, Gemini and Other", async () => {
    const fields = await grab(GUIDE, "#providerDialog input, #providerDialog select, #providerDialog textarea");
    const labels = await grab(GUIDE, "#providerDialog label");
    const labelled = new Map(labels.map((l) => [l.attrs.get("for") ?? "", l.text]));
    const visible = fields.filter((f) => f.attrs.get("id") !== "providerNickname");
    expect(visible.map((f) => f.attrs.get("id"))).toEqual(["providerWant", "providerOther", "providerUse", "providerEmail", "providerConsent"]);
    for (const f of visible) expect(`${f.attrs.get("id")}: ${(labelled.get(f.attrs.get("id") ?? "") ?? "").length > 0}`).toBe(`${f.attrs.get("id")}: true`);
    expect(labelled.get("providerEmail")).toContain("optional");
    const email = visible.find((f) => f.attrs.get("id") === "providerEmail");
    expect(email?.attrs.get("type")).toBe("email");
    expect(email?.attrs.has("required")).toBe(false);
    const options = (await grab(GUIDE, "#providerWant option")).map((o) => o.text);
    expect(options).toContain("xAI (Grok)");
    expect(options).toContain("Google (Gemini)");
    expect(options).toContain("Other");
    expect(labelled.get("providerConsent")).toMatch(/person reads/);
  });

  test("[unit] GPR-7 the page script posts to the existing intake route and carries no key or secret", () => {
    expect(SCRIPT).toContain('fetch("/api/questions"');
    expect(SCRIPT).toContain('topic: "provider-request"');
    expect(SCRIPT).not.toMatch(/api[_-]?key|secret|bearer|authorization|\bsk-[A-Za-z0-9]/i);
    expect(GUIDE).not.toMatch(/api[_-]?key=|\bsk-[A-Za-z0-9]{8}/i);
    expect(SCRIPT).toContain(`var MAX_REQUEST = ${QUESTION_LIMITS.maxQuestionChars};`);
  });
});
