import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import { bundleTm, TM_OUT } from "./build-tm.ts";
import { weekToPayload } from "../src/browser/tm-submit.ts";
import { WITH_ACT, WITHOUT_ACT, BANNED_ANYWHERE, bannedHits, jargonHits, PROMPT, SAMPLE_CARD, SAMPLE_RESULT } from "./uat/tm-the-run-check.ts";
import {
  cardHeadline, dayLabels, limitDayIndexes, NOT_A_RESULT, parseWeek, periodLine, readDate, readLimitDays, readPerDay, SAMPLE_WEEK, situationOf, stageHeadline, stageSubtitle,
  weekLines, type Week,
} from "../src/browser/tm-week.ts";

// /tm/ "The Run": a plain front panel, the click-through TokenMax show, then Map your real week (#command: one plain
// prompt, shown in full, to paste into the Claude Code or Codex the visitor already uses, a paste box with Show my week
// and Show Sample) and the router card (#sceneD). Served from site/ by Bun.serve; every off-origin request is blocked. Issue #309 criterion
// 3: no jargon in the first viewport, no curl or terminal anywhere; no bun, map.ts, --share, download or script in the
// visible text or the copied prompt.

const SITE = join(import.meta.dir, "..", "site");
const MOTIONS: ("no-preference" | "reduce")[] = ["no-preference", "reduce"];
const VIEWS: readonly (readonly [number, number])[] = [[390, 844], [1440, 900]];
const TRUST = "Pasting and Show my week stay in your browser. Only Submit sends anything.";
// En and em dash, built from code points so no dash glyph sits in this file.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]|&[mn]dash;|\\\\u201[34]`);
const html = (): string => readFileSync(join(SITE, "tm", "index.html"), "utf8");

// Operator decision (2026-10-21): the "What a real week looks like" section and its sample-card link are removed;
// Show Sample fills the Your week card instead. This replaces the two VP-6 sample-link tests.
test("[unit] VP-6 no maps sample link, sample-card link or sample section remains on /tm/", () => {
  const page = html();
  expect(page).not.toMatch(/\/maps\/#m=|id="openCard"|id="sceneB"|id="browser"|See a sample card|Open a sample card|What a real week looks like|A sample week|Counts only: no messages, no files|One builder's real week/);
  expect(page).toContain('<a id="seeMaps" href="/maps/">See the shared maps</a>');
  expect(page).toContain('href="/guide/#tokenmax"');
});

test("[unit] TM-1 the opening curtain scene and the terminal scene are gone; fonts are bundled, not fetched", () => {
  const page = html();
  for (const gone of ["curtain", "marquee", "sur", "halfL", "halfR", "sceneA", "term", "out", "pics"]) expect(page).not.toContain(`id="${gone}"`);
  expect(page).not.toMatch(/Scroll to open the show|Your Claude week, mapped|fonts\.googleapis|fonts\.gstatic/);
  const css = readFileSync(join(SITE, "tm", "tm.css"), "utf8");
  const fonts = [...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1] ?? "");
  expect(fonts.sort()).toEqual(["fonts/Alegreya-Italic.ttf", "fonts/Alegreya.ttf", "fonts/Archivo.ttf"]);
  for (const f of fonts) expect(existsSync(join(SITE, "tm", f))).toBe(true);
  expect(css).not.toMatch(/https?:\/\//);
  // #309: the command ticket is gone; no curl and no terminal wording in any shipped source of the page.
  for (const gone of ["cmd", "cmdText", "ticket", "tok1", "note1", "share", "shareWeek"]) expect(page).not.toContain(`id="${gone}"`);
  // The prompt is plain text on the page: no collapsed gate, no link to the mapper, no install step.
  expect(page).not.toMatch(/<details|<summary|href="\/tm\/map\.ts"|press Share/i);
  expect(page).toContain(`<pre id="sharePrompt">${PROMPT.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`);
  for (const file of [join(SITE, "tm", "index.html"), join(SITE, "tm", "tm.css"), join(SITE, "tm", "tm.js"), join(import.meta.dir, "..", "src", "browser", "tm-run.ts")]) {
    expect({ file, hit: BANNED_ANYWHERE.exec(readFileSync(file, "utf8"))?.[0] ?? null }).toEqual({ file, hit: null });
  }
});

// ---------- TM-10: the pasted result, read in the browser only ----------
const WANT: Week = {
  period: { start: "2026-10-14", end: "2026-10-20" }, claudeSessions: 288, codexSessions: 2925, claudeOutput: 7940728, codexOutput: 4315259,
  opusShare: 42, limitHits: 2, codexWindow: 7, pattern: null, perDay: null, limitDays: null,
};
const TABLE = [
  "| Item | Value |", "|---|---|", "| Period | 2026-10-14 to 2026-10-20 |", "| Claude sessions | 288 |", "| Codex sessions | 2,925 |",
  "| Claude output tokens | 7,940,728 |", "| Codex output tokens | 4,315,259 |", "| Opus share of Claude output | 42 % |",
  "| Usage limit hits | 2 |", "| Codex weekly window used | 7% |",
].join("\n");
const BULLETS = SAMPLE_RESULT.split("\n").map((l, i) => (i === 0 ? `**${l}**` : `- ${l.toUpperCase().replace(": ", " :   ")}`)).join("\n");
const CAVEAT = "Count mismatch: sessions 3213 is 288 Claude plus 2,925 Codex; 86 duplicate files were de-duplicated.";

test("[unit] TM-37 privacy copy states the board deletion date once", () => {
  const privacy = readFileSync(join(SITE, "privacy", "index.html"), "utf8");
  expect((privacy.match(/Rows have no automatic deletion date\./g) ?? []).length).toBe(1);
});

test("[unit] TM-39 Submit consent names every payload field", () => {
  const week = parseWeek(SAMPLE_RESULT);
  if (!week) throw new Error("fixture did not parse");
  const mapped = weekToPayload(week);
  if (!mapped.ok) throw new Error(mapped.message);
  const consent = /<p class="hint" id="submitConsent">([^<]+)<\/p>/.exec(html())?.[1] ?? "";
  const labels: Readonly<Record<string, string>> = { v: "format name tm-share/1", skill: "mapper version 0.0.0, which marks a pasted block", days: "days covered", sources: "Claude, Codex or both", sessions: "total sessions", subagent_sessions: "subagent sessions", caps: "cap hits", output_tokens: "output tokens", opus_share_pct: "Opus share", codex_weekly_pct: "Codex weekly window" };
  for (const key of Object.keys(mapped.payload)) expect({ key, named: consent.includes(labels[key] ?? "FIELD NOT DESCRIBED") }).toEqual({ key, named: true });
  for (const phrase of ["nickname", "short cap hits", "weekly cap hits", "unknown cap hits", "Claude output tokens", "Codex output tokens", "random request key", "after reloading or closing the page"]) expect(consent).toContain(phrase);
});

test("[unit] TM-10 parseWeek reads the sample week as a plain block, a markdown table and a bulleted list", () => {
  expect(parseWeek(SAMPLE_RESULT)).toEqual(WANT);
  expect(parseWeek(TABLE)).toEqual(WANT);
  expect(parseWeek(BULLETS)).toEqual(WANT);
  expect(weekLines(WANT).map((l) => [l.label, l.value])).toEqual(SAMPLE_CARD.map((r) => [...r]));
  // No Pattern line: two limit hits make it running out.
  expect(situationOf(WANT)).toBe("running out");
  expect(situationOf({ ...WANT, limitHits: 0 })).toBe("leaving most unused");
  expect(situationOf({ ...WANT, pattern: "leaving most unused" })).toBe("leaving most unused");
  expect(parseWeek(`${SAMPLE_RESULT}\nPattern: leaving most unused`)?.pattern).toBe("leaving most unused");
});

test("[unit] TM-10 'not recorded' and unreadable lines stay not recorded; caveats around the block are ignored; garbage is refused", () => {
  const partial = parseWeek("TOKENMAX WEEK\nPeriod: not recorded\nClaude sessions: 288\nCodex sessions: not recorded\nUsage limit hits: unknown\nOpus share of Claude output: Not Recorded");
  expect(partial).toEqual({ period: null, claudeSessions: 288, codexSessions: null, claudeOutput: null, codexOutput: null, opusShare: null, limitHits: null, codexWindow: null, pattern: null, perDay: null, limitDays: null });
  if (!partial) throw new Error("partial did not parse");
  expect(weekLines(partial).map((l) => l.value)).toEqual(["288", "not recorded", "not recorded", "not recorded", "not recorded", "not recorded", "not recorded"]);
  expect(periodLine(partial)).toBe("Period not recorded");
  expect(cardHeadline(partial)).toBe("Usage limit hits not recorded");
  expect(parseWeek(`${CAVEAT}\n\nNote: numbers are approximate.\n${SAMPLE_RESULT}\n\n${CAVEAT}`)).toEqual(WANT);
  for (const junk of ["", "hello", "Here is your summary: you did a lot.", "| a | b |\n|---|---|", "Sessions 288"]) expect(parseWeek(junk)).toBeNull();
  expect(NOT_A_RESULT).toBe("That doesn't look like the result. Run the prompt again and paste what it prints.");
});

for (const motion of MOTIONS) test(`[integration] TM-11 pasting the result shows the parsed week only: caveats never reach the page, no request, no storage, no horizontal scroll (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    try {
      await page.locator("#pasteBox").fill(`${CAVEAT}\n\n${SAMPLE_RESULT}\n\nNot checked: what happens after this.`);
      await page.locator("#showWeek").click();
      const card = await page.evaluate(() => ({
        rows: [...document.querySelectorAll("#yourFields dt")].map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]),
        line: document.getElementById("yourLine")?.textContent ?? "",
        tag: document.querySelector("#yourWeek .local-tag")?.textContent ?? "",
        visible: document.getElementById("yourWeek")?.checkVisibility() ?? false,
        dom: document.documentElement.textContent ?? "",
        widths: { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        stored: localStorage.length + sessionStorage.length,
      }));
      expect(card.rows).toEqual(SAMPLE_CARD.map((r) => [...r]));
      expect(card.line).toBe("Heavy load: you hit your limit 2 times");
      expect(card.tag).toBe("Your numbers, shown on this page only");
      expect(card.visible).toBe(true);
      expect(card.dom).not.toContain("duplicate files");
      expect(card.dom).not.toContain("Not checked");
      if (width === 390) { expect(card.widths.doc).toBeLessThanOrEqual(390); expect(card.widths.body).toBeLessThanOrEqual(390); }
      expect(card.stored).toBe(0);
      expect(bannedHits(await page.evaluate(() => document.body.innerText))).toEqual([]);
      // Play my week plays these numbers on the stage (the sample block has no per-day line, so no day claims).
      await page.locator("#playMine").click();
      await page.waitForFunction(() => document.getElementById("dataEnd")?.hidden === false, null, { timeout: 8000 });
      expect(await page.locator("#dataBig").innerText()).toBe("You hit your limit 2 times");
      // Garbage is refused in one plain message and the card goes away.
      await page.locator("#pasteBox").fill("hello there");
      await page.locator("#showWeek").click();
      expect(await page.locator("#pasteError").innerText()).toBe(NOT_A_RESULT);
      expect(await page.locator("#yourWeek").isVisible()).toBe(false);
      expect(requests.filter((u) => !u.startsWith(`http://127.0.0.1:${server.port}/`))).toEqual([]);
      expect(requests.filter((u) => !/\.(html|css|js|ttf)$|\/tm\/(#.*)?$/.test(new URL(u).pathname + new URL(u).hash))).toEqual([]);
    } finally { await close(page); }
  }
}, 40000);

test("[integration] TM-12 the headline strikes through days: accessible name without it, wraps at 390 with no horizontal scroll", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "reduce");
    try {
      const h1 = await page.locator("h1").evaluate((el) => {
        const s = el.querySelector("s");
        const deco = s ? getComputedStyle(s).textDecorationLine : "";
        const r = el.getBoundingClientRect();
        return { struck: s?.textContent ?? "", deco, hidden: s?.getAttribute("aria-hidden") ?? "", shows: el.querySelector("em")?.textContent ?? "", inside: r.left >= 0 && r.right <= innerWidth, widths: { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth } };
      });
      expect({ width, ...h1, widths: undefined }).toEqual({ width, struck: "days", deco: "line-through", hidden: "true", shows: "shows", inside: true, widths: undefined });
      if (width === 390) { expect(h1.widths.doc).toBeLessThanOrEqual(390); expect(h1.widths.body).toBeLessThanOrEqual(390); }
      expect(await page.getByRole("heading", { level: 1, name: "Your week is a run of seven shows", exact: true }).count()).toBe(1);
    } finally { await close(page); }
  }
}, 30000);

// ---------- TM-20..22: Submit sends the pasted week to POST /api/maps, on the visitor's press only ----------
type Sent = { readonly method: string; readonly origin: string | undefined; readonly type: string | undefined; readonly body: unknown };
const MAP_ID = "TM-0123456789AB";
const BOARD = { rows: [], totals: { builders: 0, cap_episodes: 0, with_weekly_cap: 0 } };

/** Answers POST /api/maps in the browser's own network layer (the page's real fetch runs) and records what it sent. */
async function stubMaps(page: Page, answer: (sent: Sent, nth: number) => { status: number; body: unknown } | "abort", delayMs = 0): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.route("**/api/maps", async (route) => {
    const request = route.request();
    const item: Sent = { method: request.method(), origin: request.headers()["origin"], type: request.headers()["content-type"], body: request.postDataJSON() };
    sent.push(item);
    if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
    const reply = answer(item, sent.length);
    if (reply === "abort") { await route.abort("failed"); return; }
    await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  return sent;
}
function keyOf(sent: Sent): string {
  const body = sent.body;
  return typeof body === "object" && body !== null && "request_key" in body && typeof body.request_key === "string" ? body.request_key : "";
}
const stored = (key: string, replay = false) => ({ status: 200, body: { id: MAP_ID, replay, delete: `/maps/#delete=${MAP_ID}.${key}`, board: BOARD } });

for (const motion of MOTIONS) test(`[integration] TM-20 a labelled Submit sits beside Show my week with a nickname field and plain consent copy; nothing is sent before it is pressed (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    try {
      const form = await page.evaluate(() => {
        const submit = document.getElementById("submitWeek"), show = document.getElementById("showWeek"), alias = document.getElementById("aliasBox");
        const label = document.querySelector('label[for="aliasBox"]');
        const described = (alias?.getAttribute("aria-describedby") ?? "").split(" ").map((i) => document.getElementById(i)?.textContent ?? "");
        return {
          label: submit?.textContent, sameRow: submit?.parentElement === show?.parentElement, aliasLabel: label?.textContent ?? "",
          aliasValue: alias instanceof HTMLInputElement ? alias.value : null, required: alias instanceof HTMLInputElement ? alias.required : null,
          pattern: alias?.getAttribute("pattern"), helper: document.getElementById("aliasHelp")?.textContent ?? "", described,
          consent: document.getElementById("submitConsent")?.textContent ?? "",
          submitDescribedBy: submit?.getAttribute("aria-describedby"), widths: { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth },
          alertRoles: ["pasteError", "aliasError"].map((i) => document.getElementById(i)?.getAttribute("role")), live: document.getElementById("submitStatus")?.getAttribute("aria-live"),
        };
      });
      expect(form.label).toBe("Submit");
      expect(form.sameRow).toBe(true);
      expect(form.aliasLabel).toBe("Nickname for the public board");
      expect(form.aliasValue).toBe("");
      expect(form.required).toBe(true);
      expect(form.pattern).toBe("[a-z0-9\\-]{3,24}");
      expect(form.helper).toContain("Choose a nickname, not your real name or email");
      expect(form.helper).toContain("Spaces and symbols become hyphens; the result must be 3 to 24 letters, digits or hyphens.");
      expect(form.described[0]).toBe(form.helper);
      expect(form.consent).toContain("Pressing Submit sends the numbers from your result");
      expect(form.consent).toContain("and your nickname");
      expect(form.consent).toContain("public board at /maps/");
      expect(form.consent).toContain("self-reported and not verified");
      expect(form.submitDescribedBy).toBe("submitConsent");
      expect(form.alertRoles).toEqual(["alert", "alert"]);
      expect(form.live).toBe("polite");
      expect(await page.locator("#trust").innerText()).toBe(TRUST);
      expect(await page.locator("head meta[name=description]").getAttribute("content")).toContain("only Submit sends your numbers");
      expect(await page.evaluate(() => document.documentElement.textContent ?? "")).not.toContain("Nothing is sent anywhere");
      if (width === 390) { expect(form.widths.doc).toBeLessThanOrEqual(390); expect(form.widths.body).toBeLessThanOrEqual(390); }
      // Pasting and Show my week send nothing.
      await page.locator("#pasteBox").fill(SAMPLE_RESULT);
      await page.locator("#showWeek").click();
      expect(requests.filter((u) => new URL(u).pathname.startsWith("/api/"))).toEqual([]);
      expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
      expect(bannedHits(await page.evaluate(() => document.body.innerText))).toEqual([]);
    } finally { await close(page); }
  }
}, 40000);

for (const motion of MOTIONS) test(`[integration] TM-21 Submit posts the tm-share/1 body to /api/maps once, shows the board link, map id, key and remove link, and a second press replays the same key (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    try {
      const seen = new Map<string, string>();
      const sent = await stubMaps(page, (item) => { const key = keyOf(item); const replay = seen.has(key); const id = seen.get(key) ?? (seen.size === 0 ? MAP_ID : `TM-${String(seen.size + 1).padStart(12, "0")}`); seen.set(key, id); return { status: 200, body: { id, replay } }; }, 300);
      await page.locator("#pasteBox").fill(`${CAVEAT}\n\n${SAMPLE_RESULT}`);
      await page.locator("#aliasBox").fill("pasted-one");
      // Keyboard operable: focus the button and press Enter; a double press while the request is in flight sends one request.
      await page.locator("#submitWeek").focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      expect(await page.locator("#submitWeek").isDisabled()).toBe(true);
      expect(await page.locator("#submitStatus").innerText()).toBe("Submitting...");
      await page.waitForFunction(() => document.getElementById("submitted")?.hidden === false);
      expect(sent.length).toBe(1);
      const first = sent[0];
      if (!first) throw new Error("no request");
      expect(first.method).toBe("POST");
      expect(first.origin).toBe(`http://127.0.0.1:${server.port}`);
      expect(first.type).toBe("application/json");
      expect(JSON.stringify(first.body)).toBe(JSON.stringify({
        payload: {
          v: "tm-share/1", skill: "0.0.0", days: 7, sources: "claude+codex", sessions: 3213, subagent_sessions: 0,
          caps: { short: 0, weekly: 0, unknown: 2 }, output_tokens: { claude: 7940728, codex: 4315259 }, opus_share_pct: 42, codex_weekly_pct: 7,
        },
        alias: "pasted-one",
        request_key: keyOf(first),
      }));
      const key = keyOf(first);
      expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
      const receipt = await page.evaluate(() => ({
        head: document.querySelector("#receipts li .submitted-head")?.textContent, id: document.querySelector("#receipts li code:first-of-type")?.textContent, key: document.querySelector("#receipts li p:nth-of-type(4) code")?.textContent,
        board: document.querySelector("#receipts li a")?.getAttribute("href"), remove: document.querySelector("#receipts li p:last-child a")?.getAttribute("href"),
        focused: document.activeElement?.closest("li")?.dataset.mapId, status: document.getElementById("submitStatus")?.textContent, text: document.getElementById("submitted")?.textContent ?? "",
        saved: localStorage.length + sessionStorage.length, pasteError: document.getElementById("pasteError")?.hidden, enabled: document.getElementById("submitWeek")?.hasAttribute("disabled") === false,
        widths: { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      }));
      expect(receipt.head).toBe("Submitted. Your entry is on the public board as pasted-one.");
      expect(receipt.id).toBe(MAP_ID);
      expect(receipt.key).toBe(key);
      expect(receipt.board).toBe("/maps/");
      expect(receipt.remove).toBe(`/maps/#delete=${MAP_ID}.${key}`);
      expect(receipt.text).toContain("Keep this key to remove your entry");
      expect(receipt.focused).toBe(MAP_ID);
      expect(receipt.status).toBe("Submitted. Your entry is on the public board.");
      expect(receipt.saved).toBe(0);
      expect(receipt.pasteError).toBe(true);
      expect(receipt.enabled).toBe(true);
      if (width === 390) { expect(receipt.widths.doc).toBeLessThanOrEqual(390); expect(receipt.widths.body).toBeLessThanOrEqual(390); }
      // The same paste and alias again: the same key goes out, so the server replays instead of adding a row.
      await page.locator("#submitWeek").click();
      await page.waitForFunction(() => document.getElementById("submitStatus")?.textContent?.startsWith("Already submitted") === true);
      expect(sent.length).toBe(2);
      expect(keyOf(sent[1] ?? first)).toBe(key);
      // Another paste is another attempt: a new key.
      await page.locator("#pasteBox").fill(SAMPLE_RESULT.replace("Claude sessions: 288", "Claude sessions: 289"));
      await page.locator("#submitWeek").click();
      await page.waitForFunction(() => document.querySelectorAll("#receipts li").length === 2);
      expect(sent.length).toBe(3);
      expect(keyOf(sent[2] ?? first)).not.toBe(key);
    } finally { await close(page); }
  }
}, 60000);

test("[integration] TM-33 drafts A, B, A reuse A's first key and keep two receipts newest first", async () => {
  const page = await open(390, 844, "reduce");
  try {
    const keys: string[] = [];
    const rows = new Map<string, string>();
    await page.route("**/api/maps", async (route) => {
      const body: unknown = route.request().postDataJSON();
      const key = keyOf({ method: "POST", origin: "", type: "", body });
      keys.push(key);
      const replay = rows.has(key);
      const id = rows.get(key) ?? `TM-${String(rows.size + 1).padStart(12, "0")}`;
      rows.set(key, id);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id, replay }) });
    });
    await page.locator("#aliasBox").fill("draft-a");
    await page.locator("#pasteBox").fill(SAMPLE_RESULT);
    await page.locator("#submitWeek").click();
    await page.locator("#receipts li").first().waitFor();
    await page.locator("#aliasBox").fill("draft-b");
    await page.locator("#submitWeek").click();
    await page.waitForFunction(() => document.querySelectorAll("#receipts li").length === 2);
    await page.locator("#aliasBox").fill("draft-a");
    await page.locator("#submitWeek").click();
    await page.waitForFunction(() => document.getElementById("submitStatus")?.textContent?.startsWith("Already submitted") === true);
    expect(keys.length).toBe(3);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(rows.size).toBe(2);
    expect(await page.locator("#receipts li").count()).toBe(2);
    expect(await page.locator("#receipts li").first().getAttribute("data-map-id")).toBe("TM-000000000002");
    expect(await page.locator("#receipts li").last().getAttribute("data-map-id")).toBe("TM-000000000001");
    expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    await page.reload();
    await page.locator("#aliasBox").fill("draft-a");
    await page.locator("#pasteBox").fill(SAMPLE_RESULT);
    await page.locator("#submitWeek").click();
    await page.waitForFunction(() => document.querySelectorAll("#receipts li").length === 1);
    expect(keys[3]).not.toBe(keys[0]);
  } finally { await close(page); }
}, 30000);

test("[integration] TM-34 later invalid and rejected attempts leave every receipt untouched", async () => {
  const page = await open(390, 844, "reduce");
  try {
    await page.clock.install();
    let nth = 0;
    await page.route("**/api/maps", async (route) => {
      nth++;
      if (nth === 2) await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "bad-payload", field: "days", reason: "must be 1 to 90" }) });
      else if (nth === 3) await route.abort("failed");
      else if (nth === 4) await new Promise<void>(() => {});
      else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: MAP_ID, replay: nth > 2 }) });
    });
    await page.locator("#aliasBox").fill("draft-a");
    await page.locator("#pasteBox").fill(SAMPLE_RESULT);
    await page.locator("#submitWeek").click();
    await page.locator("#receipts li").first().waitFor();
    const receipt = await page.locator("#receipts").innerHTML();
    // The list is unchanged AND still on screen: its own box is wider and taller than 1px (hidden or clipped fails).
    const intact = async (): Promise<void> => {
      expect(await page.locator("#receipts").innerHTML()).toBe(receipt);
      const box = await page.locator("#receipts li").first().boundingBox();
      expect(box !== null && box.width > 1 && box.height > 1).toBe(true);
    };
    for (const paste of ["junk", SAMPLE_RESULT.replace("Claude sessions: 288", "Claude sessions: -12"), SAMPLE_RESULT.replace("Usage limit hits: 2", "Usage limit hits: not recorded")]) {
      await page.locator("#pasteBox").fill(paste);
      await page.locator("#submitWeek").click();
      await intact();
    }
    await page.locator("#pasteBox").fill(SAMPLE_RESULT);
    await page.locator("#aliasBox").fill("!!");
    await page.locator("#submitWeek").click();
    await intact();
    await page.locator("#aliasBox").fill("draft-b");
    await page.locator("#submitWeek").click();
    await page.waitForFunction(() => document.getElementById("pasteError")?.textContent?.includes("days must be 1 to 90") === true);
    await intact();
    await page.locator("#aliasBox").fill("draft-c");
    await page.locator("#submitWeek").click();
    await page.waitForFunction(() => document.getElementById("pasteError")?.textContent?.includes("did not complete") === true);
    await intact();
    await page.locator("#aliasBox").fill("draft-d");
    await page.locator("#submitWeek").click();
    await page.clock.fastForward(16000);
    await page.waitForFunction(() => document.getElementById("pasteError")?.textContent?.includes("no answer within 15 seconds") === true);
    await intact();
  } finally { await close(page); }
}, 30000);

test("[integration] TM-39 a nickname with capitals, spaces or symbols is normalised: shown as 'will appear as' before Submit, then sent normalised; one that normalises to nothing still refuses", async () => {
  const page = await open(390, 844, "reduce");
  try {
    const sent = await stubMaps(page, (item) => stored(keyOf(item)));
    await page.locator("#pasteBox").fill(SAMPLE_RESULT);
    const preview = () => page.evaluate(() => ({ hidden: document.getElementById("aliasPreview")?.hidden, text: document.getElementById("aliasPreview")?.textContent ?? "" }));
    await page.locator("#aliasBox").fill("Early AI!");
    expect(await preview()).toEqual({ hidden: false, text: "Will appear as: early-ai" });
    expect(sent.length).toBe(0);
    await page.locator("#aliasBox").fill("early-ai");
    expect((await preview()).hidden).toBe(true);
    await page.locator("#aliasBox").fill("!!");
    await page.locator("#submitWeek").click();
    expect(await page.evaluate(() => ({ error: document.getElementById("aliasError")?.hidden, invalid: document.getElementById("aliasBox")?.getAttribute("aria-invalid") }))).toEqual({ error: false, invalid: "true" });
    expect(sent.length).toBe(0);
    await page.locator("#aliasBox").fill("Early AI!");
    await page.locator("#submitWeek").click();
    await page.waitForFunction(() => document.getElementById("submitted")?.hidden === false);
    expect(sent.map((s) => (s.body && typeof s.body === "object" && "alias" in s.body ? s.body.alias : null))).toEqual(["early-ai"]);
    expect(await page.evaluate(() => ({ box: (document.getElementById("aliasBox") as HTMLInputElement).value, error: document.getElementById("aliasError")?.hidden, preview: document.getElementById("aliasPreview")?.hidden }))).toEqual({ box: "early-ai", error: true, preview: true });
  } finally { await close(page); }
}, 40000);

test("[integration] TM-41 the box does not cut typed text before normalising: leading symbols do not eat the name, and over-long names are refused, not truncated", async () => {
  const page = await open(390, 844, "reduce");
  try {
    const sent = await stubMaps(page, (item) => stored(keyOf(item)));
    await page.locator("#pasteBox").fill(SAMPLE_RESULT);
    await page.locator("#aliasBox").pressSequentially("!".repeat(24) + "Pam");
    await page.locator("#submitWeek").click();
    await page.waitForFunction(() => document.getElementById("submitted")?.hidden === false);
    expect(sent.map((s) => (s.body && typeof s.body === "object" && "alias" in s.body ? s.body.alias : null))).toEqual(["pam"]);
    await page.locator("#aliasBox").fill("");
    await page.locator("#aliasBox").pressSequentially("a".repeat(30));
    expect(await page.evaluate(() => (document.getElementById("aliasBox") as HTMLInputElement).value.length)).toBe(30);
    await page.locator("#submitWeek").click();
    expect(await page.evaluate(() => ({ error: document.getElementById("aliasError")?.hidden, invalid: document.getElementById("aliasBox")?.getAttribute("aria-invalid") }))).toEqual({ error: false, invalid: "true" });
    expect(sent.length).toBe(1);
    // 24 letters, 40 symbols, then one more letter normalises to 26 characters: refused, not cut to 24 and accepted.
    await page.locator("#aliasBox").fill("");
    await page.locator("#aliasBox").pressSequentially("a".repeat(24) + "!".repeat(40) + "b");
    await page.locator("#submitWeek").click();
    expect(await page.evaluate(() => ({ error: document.getElementById("aliasError")?.hidden, box: (document.getElementById("aliasBox") as HTMLInputElement).value }))).toEqual({ error: false, box: "a".repeat(24) + "-b" });
    expect(sent.length).toBe(1);
  } finally { await close(page); }
}, 40000);

test("[integration] TM-38 a delete key left in localStorage by the earlier build is removed when the page starts", async () => {
  const page = await open(390, 844, "reduce");
  try {
    await page.evaluate(() => { localStorage.setItem("tm-submit/1", JSON.stringify({ id: "TM-000000000001", key: "k".repeat(32), alias: "old-entry" })); localStorage.setItem("unrelated", "keep"); });
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("submitWeek") !== null && document.querySelectorAll("#run .poster").length === 7);
    expect(await page.evaluate(() => [localStorage.getItem("tm-submit/1"), localStorage.getItem("unrelated")])).toEqual([null, "keep"]);
  } finally { await close(page); }
}, 30000);

test("[integration] TM-33 a request-key-reused 409 forgets only that draft's key", async () => {
  const page = await open(390, 844, "reduce");
  try {
    const keys: string[] = [];
    await page.route("**/api/maps", async (route) => {
      const body: unknown = route.request().postDataJSON();
      keys.push(keyOf({ method: "POST", origin: "", type: "", body }));
      await route.fulfill({ status: keys.length === 1 ? 409 : 200, contentType: "application/json", body: JSON.stringify(keys.length === 1 ? { code: "request-key-reused" } : { id: MAP_ID, replay: false }) });
    });
    await page.locator("#aliasBox").fill("draft-a");
    await page.locator("#pasteBox").fill(SAMPLE_RESULT);
    await page.locator("#submitWeek").click();
    await page.waitForFunction(() => document.getElementById("pasteError")?.textContent?.includes("already used") === true);
    await page.locator("#submitWeek").click();
    await page.locator("#receipts li").waitFor();
    expect(keys.length).toBe(2);
    expect(keys[1]).not.toBe(keys[0]);
  } finally { await close(page); }
}, 30000);

test("[integration] TM-35 Submit refuses a signed raw number while Show my week still displays it", async () => {
  const page = await open(390, 844, "reduce");
  try {
    const sent: string[] = [];
    await page.route("**/api/maps", async (route) => { sent.push(route.request().url()); await route.abort(); });
    await page.locator("#pasteBox").fill(SAMPLE_RESULT.replace("Claude sessions: 288", "Claude sessions: -12"));
    await page.locator("#showWeek").click();
    expect(await page.locator("#yourFields").innerText()).toContain("12");
    await page.locator("#aliasBox").fill("draft-a");
    await page.locator("#submitWeek").click();
    expect(await page.locator("#pasteError").innerText()).toContain('Claude sessions must be a plain whole number like 1,234, not "-12"');
    expect(await page.locator("#yourWeek").isVisible()).toBe(true);
    expect(sent).toHaveLength(0);
  } finally { await close(page); }
}, 30000);

test("[integration] TM-36 a stalled request times out after 15 seconds and retry reuses its key", async () => {
  const page = await open(390, 844, "reduce");
  try {
    await page.clock.install();
    const keys: string[] = [];
    await page.route("**/api/maps", async (route) => {
      const body: unknown = route.request().postDataJSON();
      keys.push(keyOf({ method: "POST", origin: "", type: "", body }));
      if (keys.length === 1) { await new Promise<void>(() => {}); return; }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: MAP_ID, replay: true }) });
    });
    await page.locator("#aliasBox").fill("draft-a");
    await page.locator("#pasteBox").fill(SAMPLE_RESULT);
    await page.locator("#submitWeek").click();
    await page.waitForFunction(() => document.getElementById("submitStatus")?.textContent === "Submitting...");
    await page.clock.fastForward(16000);
    await page.waitForFunction(() => document.getElementById("pasteError")?.textContent?.includes("no answer within 15 seconds") === true);
    // The server may have stored the row before the abort, so the page must not say "Not submitted".
    expect(await page.locator("#pasteError").innerText()).toMatch(/^Not confirmed: .*may already be on the board/);
    expect(await page.locator("#submitWeek").isEnabled()).toBe(true);
    await page.locator("#submitWeek").click();
    await page.locator("#receipts li").waitFor();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  } finally { await close(page); }
}, 30000);

test("[integration] TM-36 a stalled response body is aborted and retry keeps its key", async () => {
  const page = await open(390, 844, "reduce");
  try {
    await page.clock.install();
    await page.evaluate(() => {
      const keys: string[] = [];
      Object.defineProperty(window, "__submitKeys", { value: keys });
      Object.defineProperty(window, "fetch", { configurable: true, value: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body: unknown = JSON.parse(String(init?.body));
        if (typeof body === "object" && body !== null && "request_key" in body && typeof body.request_key === "string") keys.push(body.request_key);
        if (keys.length === 1) {
          const stream = new ReadableStream<Uint8Array>({ start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); } });
          return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ id: "TM-000000000001", replay: true }), { status: 200, headers: { "content-type": "application/json" } });
      } });
    });
    await page.locator("#aliasBox").fill("draft-a");
    await page.locator("#pasteBox").fill(SAMPLE_RESULT);
    await page.locator("#submitWeek").click();
    await page.clock.fastForward(16000);
    await page.waitForFunction(() => document.getElementById("pasteError")?.textContent?.includes("no answer within 15 seconds") === true);
    expect(await page.locator("#submitWeek").isEnabled()).toBe(true);
    await page.locator("#submitWeek").click();
    await page.locator("#receipts li").waitFor();
    const keys = await page.evaluate(() => Reflect.get(window, "__submitKeys"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  } finally { await close(page); }
}, 30000);

test("[integration] TM-22 Submit refuses locally (no request) for a missing nickname, a bad nickname, junk or a missing required line, and shows the server's reason or a network failure", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "reduce");
    try {
      const sent = await stubMaps(page, (item, nth) => {
        if (nth === 1) return { status: 400, body: { code: "bad-payload", field: "opus_share_pct", reason: "must be 0 to 100" } };
        if (nth === 2) return "abort";
        return stored(keyOf(item));
      });
      const alerts = (): Promise<{ paste: string; pasteShown: boolean; alias: string; aliasShown: boolean; invalid: string | null; focused: string | undefined }> => page.evaluate(() => ({
        paste: document.getElementById("pasteError")?.textContent ?? "", pasteShown: document.getElementById("pasteError")?.hidden === false,
        alias: document.getElementById("aliasError")?.textContent ?? "", aliasShown: document.getElementById("aliasError")?.hidden === false,
        invalid: document.getElementById("aliasBox")?.getAttribute("aria-invalid") ?? null, focused: document.activeElement?.id,
      }));
      await page.locator("#pasteBox").fill(SAMPLE_RESULT);
      // No nickname.
      await page.locator("#submitWeek").click();
      expect(await alerts()).toEqual({ paste: "", pasteShown: false, alias: "Enter a nickname to submit. Choose a nickname that is 3 to 24 letters, digits or hyphens once spaces and symbols are turned into hyphens.", aliasShown: true, invalid: "true", focused: "aliasBox" });
      // A nickname that is too short after normalising is refused.
      await page.locator("#aliasBox").fill("x");
      await page.locator("#submitWeek").click();
      expect((await alerts()).alias).toBe("Choose a nickname that is 3 to 24 letters, digits or hyphens once spaces and symbols are turned into hyphens.");
      // Junk, and a block missing a required line, name the problem and send nothing.
      await page.locator("#aliasBox").fill("pasted-one");
      await page.locator("#pasteBox").fill("hello there");
      await page.locator("#submitWeek").click();
      expect(await alerts()).toMatchObject({ paste: NOT_A_RESULT, pasteShown: true, aliasShown: false, invalid: null });
      await page.locator("#pasteBox").fill(SAMPLE_RESULT.replace("Usage limit hits: 2", "Usage limit hits: not recorded"));
      await page.locator("#submitWeek").click();
      expect((await alerts()).paste).toBe("Not submitted: Usage limit hits is not recorded in your result. Run the prompt again and paste the whole result.");
      await page.locator("#pasteBox").fill(SAMPLE_RESULT.replace("2026-10-14 to 2026-10-20", "2026-06-01 to 2026-10-21"));
      await page.locator("#submitWeek").click();
      expect((await alerts()).paste).toBe("Not submitted: the period is 143 days; a submitted week covers 1 to 90 days.");
      expect(sent.length).toBe(0);
      // The server refuses a number: its field and reason are shown in the alert area, the button works again.
      await page.locator("#pasteBox").fill(SAMPLE_RESULT);
      await page.locator("#submitWeek").click();
      await page.waitForFunction(() => document.getElementById("pasteError")?.textContent?.startsWith("Not submitted: opus_share_pct") === true);
      expect((await alerts()).paste).toBe("Not submitted: opus_share_pct must be 0 to 100.");
      expect(await page.locator("#submitted").isHidden()).toBe(true);
      expect(await page.locator("#submitWeek").isEnabled()).toBe(true);
      // The network drops: the page says it did not complete, and the retry sends the same key.
      await page.locator("#submitWeek").click();
      await page.waitForFunction(() => document.getElementById("pasteError")?.textContent?.includes("did not complete") === true);
      expect((await alerts()).paste).toBe("Not confirmed: the request did not complete, so your entry may already be on the board. Check your connection and press Submit again on this page to get your receipt and key; for the same result and nickname it never adds a second row.");
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
      await page.locator("#submitWeek").click();
      await page.waitForFunction(() => document.getElementById("submitted")?.hidden === false);
      expect(sent.length).toBe(3);
      expect(new Set(sent.map(keyOf)).size).toBe(1);
      expect(await page.locator("#pasteError").isHidden()).toBe(true);
      if (width === 390) expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(390);
    } finally { await close(page); }
  }
}, 60000);

test("[integration] TM-2 site/tm/tm.js is the current build of src/browser/tm-run.ts", async () => {
  expect(readFileSync(TM_OUT, "utf8")).toBe(await bundleTm());
});

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

async function open(width: number, height: number, motion: "no-preference" | "reduce", errors?: string[], hash = ""): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  if (errors) page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}/tm/${hash}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#run .poster").length === 7);
  return page;
}
async function close(page: Page): Promise<void> { await page.context().close(); }
async function scrollShare(page: Page, share: number): Promise<void> {
  await page.evaluate((s) => scrollTo(0, Math.round((document.documentElement.scrollHeight - innerHeight) * s)), share);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
}

for (const motion of MOTIONS) test(`[integration] TM-8 the exact prompt is visible with no click, under "Map your real week" with the trust line on the heading's line; Copy says where to paste; nothing technical on the page (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    try {
      // No click, no scroll handler: the prompt is laid out and visible as soon as the page loads.
      const prompt = await page.locator("#sharePrompt").evaluate((el) => ({ text: el.textContent, visible: el.checkVisibility({ visibilityProperty: true, opacityProperty: true }), height: el.getBoundingClientRect().height, gated: !!el.closest("details, [hidden]") }));
      expect(prompt.text).toBe(PROMPT);
      expect(prompt.visible).toBe(true);
      expect(prompt.height).toBeGreaterThan(40);
      expect(prompt.gated).toBe(false);
      expect(await page.locator("#copy").isVisible()).toBe(true);
      // Operator decision (2026-10-21): the "Paste this into Claude Code or Codex." line is gone; the Copy label says it.
      expect(await page.locator("#copy").innerText()).toBe("Copy for Claude Code or Codex");
      expect(await page.locator("#pasteLine").count()).toBe(0);
      expect(await page.locator("#hCmd").innerText()).toBe("Map your real week");
      expect((await page.locator("#trust").innerText()).trim()).toBe(TRUST);
      // The trust line follows the heading on its line at 1440; on a phone it may wrap under the heading, never above it.
      const head = await page.evaluate(() => {
        const h = document.getElementById("hCmd")?.getBoundingClientRect(), t = document.getElementById("trust")?.getBoundingClientRect();
        return h && t ? { sameLine: Math.abs(h.bottom - t.bottom) < 12 && t.left >= h.right, below: t.top >= h.bottom - 2 } : null;
      });
      expect(head === null ? false : width === 1440 ? head.sameLine : head.sameLine || head.below).toBe(true);
      // The whole visible page, and the prompt as copied: none of the banned words (the prompt's "do not download" excepted).
      expect({ width, hits: bannedHits(await page.evaluate(() => document.body.innerText)) }).toEqual({ width, hits: [] });
      expect(await page.locator('a[href*="map.ts"]').count()).toBe(0);
    } finally { await close(page); }
  }
}, 30000);

// Operator decision (2026-10-21): the first viewport is the headline and two big picker boxes; the intro paragraph,
// the audience line, the router note and the tags are removed. TM-7 asserts that design in place of #309 criteria 1-2.
for (const motion of MOTIONS) test(`[integration] TM-7 the first viewport, no scroll: the headline and two big picker boxes that do not overlap it, the cue over their seam, no jargon, none of the removed copy (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    try {
      // The cue fades in about 1.5 s after load (at once under reduced motion).
      await page.waitForFunction(() => { const c = document.getElementById("pickCue"); return !!c && document.getElementById("pick")?.classList.contains("cue-on") === true && getComputedStyle(c).opacity === "1"; }, null, { timeout: 4000 });
      const layout = await page.evaluate(() => {
        const box = (el: Element | null): { top: number; bottom: number; left: number; right: number; height: number; width: number } | null => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
        };
        const [burn, under] = [...document.querySelectorAll(".pick-btn")].map(box);
        const cueEl = document.getElementById("pickCue");
        const group = document.querySelector(".pick-btns");
        return {
          h1: box(document.querySelector("h1")), burn: burn ?? null, under: under ?? null, cue: box(cueEl),
          cueHidden: cueEl?.getAttribute("aria-hidden"), cuePointer: cueEl ? getComputedStyle(cueEl).pointerEvents : "", cueOpacity: cueEl ? getComputedStyle(cueEl).opacity : "",
          role: group?.getAttribute("role"), label: group?.getAttribute("aria-label"), vh: innerHeight, vw: innerWidth,
          pulse: [...document.querySelectorAll(".pick-btn")].map((b) => getComputedStyle(b).animationName),
        };
      });
      const { h1, burn, under, cue } = layout;
      if (!h1 || !burn || !under || !cue) throw new Error(`missing first-viewport element: ${JSON.stringify(layout)}`);
      // Both boxes wholly in the first viewport, large, below the headline.
      for (const b of [burn, under]) {
        expect(b.top >= 0 && b.bottom <= layout.vh).toBe(true);
        expect(b.height).toBeGreaterThanOrEqual(width === 390 ? 88 : 96);
        expect(b.top).toBeGreaterThanOrEqual(h1.bottom);
      }
      // Side by side at 1440, full-width stacked at 390.
      if (width === 1440) expect(Math.abs(burn.top - under.top) < 2 && under.left > burn.right).toBe(true);
      else expect(under.top > burn.bottom && burn.width > layout.vw - 40 && under.width > layout.vw - 40).toBe(true);
      // The cue straddles the seam (half over each box), below the headline, never taking a click; hidden from screen readers.
      const seam = width === 1440 ? { a: cue.left < burn.right && cue.right > under.left } : { a: cue.top < burn.bottom && cue.bottom > under.top };
      expect({ width, ...seam, belowH1: cue.top >= h1.bottom, hidden: layout.cueHidden, pointer: layout.cuePointer, opacity: layout.cueOpacity }).toEqual({ width, a: true, belowH1: true, hidden: "true", pointer: "none", opacity: "1" });
      expect({ role: layout.role, label: layout.label }).toEqual({ role: "group", label: "Which week is yours?" });
      // The pulse runs until a week is picked; reduced motion has none.
      expect(layout.pulse).toEqual(motion === "reduce" ? ["none", "none"] : ["nudge", "nudge"]);
      const restText = await page.evaluate(() => document.body.innerText);
      await page.locator(".pick-btn[data-mode=under]").click();
      const after = await page.evaluate(() => ({ pulse: [...document.querySelectorAll(".pick-btn")].map((b) => getComputedStyle(b).animationName), cue: getComputedStyle(document.getElementById("pickCue") ?? document.body).display }));
      expect(after).toEqual({ pulse: ["none", "none"], cue: "none" });
      // The removed copy is gone from the page at rest (the ghost light's own status line names "% of your week
      // left unused" once a week plays); the footer is the single "Illustrative" line.
      const text = restText;
      for (const gone of ["Play a week of AI coding", "For people who use Claude Code or Codex", "The TokenMax router is being designed", "Pick your week above", "of your week left", "Seven performances. One weekly limit.", "I run out before Friday", "I never use it all", "The curtain falls mid-week", "Half the seats sit empty", "Heavy User Hits Limits", "Lite Never Limited", "Tonight's prompt", "Where each step sits", "The review", "Try this prompt", "Comes after the show"]) expect({ gone, found: text.includes(gone) }).toEqual({ gone, found: false });
      expect(await page.locator(".pick-main").allInnerTexts()).toEqual(["Heavy Loads Hit Limits", "Lite Usage Never Limited"]);
      // Each title sits on one line and the pair is balanced: same height, same width (at 390 each takes the full width).
      const titles = await page.evaluate(() => [...document.querySelectorAll(".pick-main")].map((el) => { const lh = parseFloat(getComputedStyle(el).lineHeight); return { lines: Math.round(el.getBoundingClientRect().height / lh) }; }));
      expect(titles).toEqual([{ lines: 1 }, { lines: 1 }]);
      expect(Math.abs(burn.height - under.height) < 1 && Math.abs(burn.width - under.width) < 1).toBe(true);
      expect(await page.locator(".pick-btn .pick-icon svg").count()).toBe(2);
      // Operator decision (2026-10-21): the footer disclaimer is removed too; no "Illustrative" text anywhere on the page.
      expect([...text.matchAll(/illustrative/gi)].length).toBe(0);
      expect(/illustrative/i.test(await page.evaluate(() => document.documentElement.textContent ?? ""))).toBe(false);
    } finally { await close(page); }
  }
}, 40000);

for (const motion of MOTIONS) test(`[integration] TM-7b the first viewport has no jargon-list word and the page no curl or terminal (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    try {
      const first = await page.evaluate(() => {
        const texts: string[] = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walk.nextNode(); node; node = walk.nextNode()) {
          const text = (node.textContent ?? "").trim();
          const el = node.parentElement;
          if (!text || !el || el.closest("script, style") || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
          // Word by word: a long text node (the prompt) may start in the first viewport and run on below it.
          const words: string[] = [];
          for (const m of (node.textContent ?? "").matchAll(/\S+/g)) {
            const range = document.createRange(); range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
            if ([...range.getClientRects()].some((r) => r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) words.push(m[0]);
          }
          if (words.length) texts.push(words.join(" "));
        }
        return { texts };
      });
      expect({ width, hits: jargonHits(first.texts) }).toEqual({ width, hits: [] });
      expect(first.texts.length).toBeGreaterThan(5);
      const anywhere = await page.evaluate(() => [document.documentElement.textContent ?? "", ...[...document.querySelectorAll("*")].flatMap((el) => ["title", "aria-label", "alt", "content", "href"].map((a) => el.getAttribute(a) ?? ""))].join(" "));
      expect(BANNED_ANYWHERE.exec(anywhere)?.[0] ?? null).toBeNull();
    } finally { await close(page); }
  }
}, 30000);

// #309 / #260: a first-time visitor reads, with no scroll, what the page does for them and what to press. The plain
// sentence and a labelled "Get my prompt" action sit between the headline and the picker boxes (which TM-7 still keeps
// wholly in the first viewport). No fixed element may hang off the bottom of a phone screen (the old ticket's clip).
const PLAIN_VIEWS: readonly (readonly [number, number])[] = [[390, 844], [1280, 800]];
for (const motion of MOTIONS) test(`[integration] TM-40 the plain sentence and a labelled Get my prompt action are in the first viewport at 390x844 and 1280x800, no scroll; it lands on the prompt (${motion})`, async () => {
  for (const [width, height] of PLAIN_VIEWS) {
    const page = await open(width, height, motion);
    try {
      const first = await page.evaluate(() => {
        const at = (sel: string): { top: number; bottom: number; inView: boolean; text: string; visible: boolean; px: number } | null => {
          const el = document.querySelector(sel);
          if (!(el instanceof HTMLElement)) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && r.width > 0, text: el.innerText.trim(), visible: el.checkVisibility({ visibilityProperty: true, opacityProperty: true }), px: parseFloat(getComputedStyle(el).fontSize) };
        };
        const fixedOff = [...document.querySelectorAll("body *")].filter((el) => getComputedStyle(el).position === "fixed" && el.checkVisibility())
          .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.className, top: r.top, bottom: r.bottom }; }).filter((r) => r.top < 0 || r.bottom > innerHeight);
        return { lede: at("#lede"), action: at("#getPrompt"), href: document.getElementById("getPrompt")?.getAttribute("href") ?? null, vh: innerHeight, y: scrollY, fixedOff };
      });
      const { lede, action } = first;
      if (!lede || !action) throw new Error(`#309: missing on the first viewport at ${width}x${height}: ${JSON.stringify(first)}`);
      expect({ width, visible: lede.visible, inView: lede.inView, px: lede.px >= 15, jargon: jargonHits([lede.text]) }).toEqual({ width, visible: true, inView: true, px: true, jargon: [] });
      expect(lede.text).toMatch(/Claude Code or Codex/);
      expect({ width, text: action.text, href: first.href, visible: action.visible, inView: action.inView, y: first.y })
        .toEqual({ width, text: "Get my prompt", href: "#command", visible: true, inView: true, y: 0 });
      expect(first.fixedOff).toEqual([]);
      await page.locator("#getPrompt").click();
      await page.waitForFunction(() => document.activeElement?.id === "command");
      const landed = await page.evaluate(() => {
        const inView = (id: string): boolean => { const r = document.getElementById(id)?.getBoundingClientRect(); return !!r && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && r.width > 0; };
        // The prompt box itself: its top edge and at least its first 60 px are on screen (at 390 the full prompt is taller than the phone).
        const p = document.getElementById("sharePrompt")?.getBoundingClientRect();
        return { heading: inView("hCmd"), prompt: !!p && p.top >= 0 && p.top + 60 <= innerHeight && p.left >= 0 && p.right <= innerWidth };
      });
      expect({ width, ...landed }).toEqual({ width, heading: true, prompt: true });
    } finally { await close(page); }
  }
}, 30000);

for (const motion of MOTIONS) {
  test(`[integration] no horizontal scroll at 390x844 at 0, 50 and 100% of the scroll, before and after a show (${motion})`, async () => {
    const errors: string[] = [];
    const page = await open(390, 844, motion, errors);
    try {
      for (const pick of [false, true]) {
        if (pick) { await scrollShare(page, 0); await page.locator(".pick-btn[data-mode=under]").click(); await page.waitForTimeout(400); }
        for (const share of [0, .5, 1]) {
          await scrollShare(page, share);
          const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
          expect(widths.doc).toBeLessThanOrEqual(390);
          expect(widths.body).toBeLessThanOrEqual(390);
        }
      }
      expect(errors).toEqual([]);
    } finally { await close(page); }
  }, 30000);

  test(`[integration] Copy copies the exact prompt; aria-live says Copied (${motion})`, async () => {
    for (const [width, height] of VIEWS) {
      const page = await open(width, height, motion);
      try {
        expect(await page.locator("#sharePrompt").textContent()).toBe(PROMPT);
        const copy = page.getByRole("button", { name: "Copy" });
        await copy.scrollIntoViewIfNeeded();
        const box = await copy.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { onScreen: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, covered: hit === node || node.contains(hit) };
        });
        expect(box).toEqual({ onScreen: true, covered: true });
        expect(await page.locator("#copyMsg").getAttribute("aria-live")).toBe("polite");
        await copy.click();
        await page.waitForFunction(() => (document.getElementById("copyMsg")?.textContent ?? "").length > 0);
        expect(await page.locator("#copyMsg").textContent()).toBe("Copied. Paste it into Claude Code or Codex on your computer.");
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied).toBe(PROMPT);
        expect(bannedHits(copied)).toEqual([]);
      } finally { await close(page); }
    }
  }, 30000);
}

test("[integration] Copy falls back to selecting the prompt with a keyboard hint when the clipboard refuses", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } });
      document.execCommand = () => false;
    });
    await page.goto(`http://127.0.0.1:${server.port}/tm/`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Copy" }).click();
    await page.waitForFunction(() => (document.getElementById("copyMsg")?.textContent ?? "").length > 0);
    expect(await page.locator("#copyMsg").textContent()).toMatch(/^The prompt is selected\. Press (Cmd|Ctrl)\+C to copy it\.$/);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(PROMPT);
  } finally { await page.close(); }
}, 30000);

test("[integration] TM-3 the visitor order: front panel, situation picker, stage, the three cards, the prompt, the sample week, the shared maps", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "reduce");
    try {
      const order = await page.evaluate(() => ["h1", ".pick", "#stage", "#keepLights", "#command", "#hCmd", "#trust", "#sharePrompt", "#copy", "#pasteBox", "#showWeek", "#sceneD", "#seeMaps"]
        .map((sel) => { const el = document.querySelector(sel); return { sel, top: el ? el.getBoundingClientRect().top + scrollY : -1 }; }));
      expect(order.every((o) => o.top >= 0)).toBe(true);
      // The heading and the trust line share a line at 1440, so compare the rest, which stack at every width.
      const stacked = order.filter((o) => o.sel !== "#trust").map((o) => o.top);
      expect([...stacked].sort((a, b) => a - b)).toEqual(stacked);
      expect(await page.locator("#seeMaps").innerText()).toBe("See the shared maps");
      expect(await page.locator("#tokenmaxGuide").innerText()).toBe("Understand TokenMax and explore a recorded comparison");
      expect(await page.locator("#tokenmaxGuide").getAttribute("href")).toBe("/guide/#tokenmax");
      // Operator decision (2026-10-21): the three cards, the "Map your real week" button and the footer are removed.
      for (const gone of ["#promptCard", "#houseCard", "#review", "#tryBtn", "#seating", "#mapWeek", ".foot", ".lower"]) expect({ gone, count: await page.locator(gone).count() }).toEqual({ gone, count: 0 });
    } finally { await close(page); }
  }
}, 30000);

// Operator decision (2026-10-21): no visible top button; "Skip to the command" shows only when keyboard-focused.
for (const motion of MOTIONS) test(`[integration] TM-4 Skip to the command is the first Tab stop, off screen until focused, then on screen, and moves focus to the prompt (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    try {
      const where = (): Promise<{ text: string | null; onScreen: boolean }> => page.locator("#jumpCommand").evaluate((el) => { const r = el.getBoundingClientRect(); return { text: el.textContent, onScreen: r.left >= 0 && r.top >= 0 && r.bottom <= innerHeight && r.width >= 24 && r.height >= 24 }; });
      expect(await where()).toEqual({ text: "Skip to the command", onScreen: false });
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("jumpCommand");
      expect(await where()).toEqual({ text: "Skip to the command", onScreen: true });
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.activeElement?.id === "command");
      expect(await page.locator("#sharePrompt").isVisible()).toBe(true);
      const at = await page.locator("#trust").evaluate((el, trust) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { text: (el.textContent ?? "").trim() === trust, inView: r.top >= 0 && r.bottom <= innerHeight, uncovered: hit === el || el.contains(hit), px: parseFloat(getComputedStyle(el).fontSize) >= 13 };
      }, TRUST);
      expect({ width, ...at }).toEqual({ width, text: true, inView: true, uncovered: true, px: true });
    } finally { await close(page); }
  }
}, 30000);

test("[integration] TM-5 reduced motion: picking a week and See it with TokenMax land on their end states at once, with nothing animating; the tagline shows", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "reduce");
    try {
      await page.locator(".pick-btn[data-mode=burn]").click();
      const without = await page.evaluate(() => ({ drop: document.getElementById("drop")?.classList.contains("show-copy"), act: document.getElementById("act")?.textContent, keep: document.getElementById("keepLights")?.classList.contains("shown"), skip: document.getElementById("skip")?.hidden, running: document.getAnimations().filter((a) => a.playState === "running").length }));
      expect(without).toEqual({ drop: true, act: WITHOUT_ACT, keep: true, skip: true, running: 0 });
      await page.locator("#dropBtn").click();
      const withTm = await page.evaluate(() => ({ settled: document.getElementById("stage")?.classList.contains("settled"), act: document.getElementById("act")?.textContent, badge: document.getElementById("gaugeBadge")?.textContent, running: document.getAnimations().filter((a) => a.playState === "running").length }));
      expect(withTm).toEqual({ settled: true, act: WITH_ACT.burn, badge: "Lasted to Sunday", running: 0 });
    } finally { await close(page); }
  }
}, 30000);

test("[integration] TM-6 turning reduced motion on mid-show jumps to the end state", async () => {
  const page = await open(1440, 900, "no-preference");
  try {
    await page.locator(".pick-btn[data-mode=under]").click();
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.getElementById("ghost")?.classList.contains("on"))).toBe(false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.getElementById("ghost")?.classList.contains("on") === true, null, { timeout: 2000 });
    expect(await page.evaluate(() => ({ half: document.querySelectorAll(".poster.half").length, skip: document.getElementById("skip")?.hidden }))).toEqual({ half: 7, skip: true });
  } finally { await close(page); }
}, 30000);

test("[integration] the page and its sources carry no em or en dash and no home paths", async () => {
  const page = await open(1440, 900, "reduce", undefined, "#under-after");
  try {
    const text = await page.evaluate(() => document.documentElement.textContent ?? "");
    expect(text).not.toMatch(DASHES);
  } finally { await close(page); }
  const sources = [join(SITE, "tm", "index.html"), join(SITE, "tm", "tm.css"), join(SITE, "tm", "tm.js"), join(import.meta.dir, "..", "src", "browser", "tm-run.ts")];
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(DASHES);
    expect(src).not.toMatch(/\/Users\/|~\/|\.claude\//);
  }
}, 30000);

// ---------- The Cmd+V bug (reproduced in Chrome on the operator's Mac, 2026-10-21) and paste-to-play ----------
// With #command in the URL, a late fonts.ready or any hashchange ran focusCommand() and pulled focus out of the paste
// box, so Cmd+V went to the section. Fix: focus moves only when it is not already inside #command.
const HEAVY_BASE = [
  "TOKENMAX WEEK", "Period: 2026-10-14 to 2026-10-20", "Claude sessions: 292", "Codex sessions: 2,730", "Claude output tokens: 7,124,205",
  "Codex output tokens: 3,213,109", "Opus share of Claude output: 39%", "Usage limit hits: 22", "Codex weekly window used: 7%", "Pattern: running out",
];
// Block v2: per day (combined, summing to 292 + 2,730 = 3,022) and the limit-hit dates (a Thursday and a Saturday).
const HEAVY = [...HEAVY_BASE.slice(0, 8), "Sessions per day: 410, 520, 615, 448, 386, 330, 313", "Limit hit days: 2026-10-15, 2026-10-17", ...HEAVY_BASE.slice(8)].join("\n");
const HEAVY_V1 = HEAVY_BASE.join("\n");
const LITE = HEAVY.replace("Usage limit hits: 22", "Usage limit hits: 0").replace("Limit hit days: 2026-10-15, 2026-10-17", "Limit hit days: none").replace("Pattern: running out", "Pattern: leaving most unused");

test("[unit] TM-17 block v2: seven per-day numbers or not recorded; limit-hit dates or none; weekdays from the dates; the ending from the numbers only", () => {
  const heavy = parseWeek(HEAVY);
  if (!heavy) throw new Error("HEAVY did not parse");
  expect(heavy.perDay).toEqual([410, 520, 615, 448, 386, 330, 313]);
  expect(heavy.limitDays).toEqual(["2026-10-15", "2026-10-17"]);
  expect(dayLabels(heavy)).toEqual(["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"]);
  expect(limitDayIndexes(heavy)).toEqual([1, 3]);
  expect(stageHeadline(heavy)).toBe("You hit your limit 22 times, on Thu and Sat");
  expect(stageSubtitle(heavy)).toBe("292 Claude Code and 2,730 Codex sessions; Opus 39% of Claude output");
  expect(cardHeadline(heavy)).toBe("Heavy load: you hit your limit 22 times");
  // Without the two new lines: no per-day counts, no dates, no day claims; the headline still comes from the hits.
  const v1 = parseWeek(HEAVY_V1);
  if (!v1) throw new Error("HEAVY_V1 did not parse");
  expect({ perDay: v1.perDay, limitDays: v1.limitDays, idx: limitDayIndexes(v1), head: stageHeadline(v1) }).toEqual({ perDay: null, limitDays: null, idx: [], head: "You hit your limit 22 times" });
  const lite = parseWeek(LITE);
  if (!lite) throw new Error("LITE did not parse");
  expect({ days: lite.limitDays, head: stageHeadline(lite), card: cardHeadline(lite) }).toEqual({ days: [], head: "You never hit your limit", card: "Light use: you never hit a limit" });
  // Tolerant of spaces and weekday words; a wrong count or an unreadable date is not recorded, never guessed.
  expect(readPerDay(" Wed 410 ,Thu 520,  615, 448, 386, 330 , Tue 313 ")).toEqual([410, 520, 615, 448, 386, 330, 313]);
  for (const bad of ["410, 520, 615, 448, 386, 330", "410, 520, 615, 448, 386, 330, 313, 9", "410, 520, about 600, 448, 386, 330, 313", "not recorded"]) expect(readPerDay(bad)).toBeNull();
  expect(readLimitDays("Thu 2026-10-15 , Sat 2026-10-17")).toEqual(["2026-10-15", "2026-10-17"]);
  expect(readLimitDays("None")).toEqual([]);
  for (const bad of ["2026-10-15, Saturday", "2026-02-30", "15 Oct", "not recorded"]) expect(readLimitDays(bad)).toBeNull();
  expect(readDate("2026-13-01")).toBeNull();
  expect(parseWeek(HEAVY.replace("Sessions per day: 410, 520, 615, 448, 386, 330, 313", "Sessions per day: 410, 520"))?.perDay).toBeNull();
  // A date outside the period is never placed on a poster or named in the headline.
  const outside = parseWeek(HEAVY.replace("2026-10-17", "2026-10-30"));
  if (!outside) throw new Error("outside did not parse");
  expect({ idx: limitDayIndexes(outside), head: stageHeadline(outside) }).toEqual({ idx: [1], head: "You hit your limit 22 times" });
  // The sample's per-day numbers sum to its recorded 3,993 sessions; its recorded cap hits fall on one date inside its period.
  expect((SAMPLE_WEEK.perDay ?? []).reduce((a, b) => a + b, 0)).toBe((SAMPLE_WEEK.claudeSessions ?? 0) + (SAMPLE_WEEK.codexSessions ?? 0));
  expect(limitDayIndexes(SAMPLE_WEEK).length).toBe(SAMPLE_WEEK.limitDays?.length ?? -1);
  // A recorded date is stamped only when Usage limit hits is above 0: with hits 0 or not recorded, nothing is stamped.
  expect(limitDayIndexes({ ...heavy, limitHits: 0 })).toEqual([]);
  expect(limitDayIndexes({ ...heavy, limitHits: null })).toEqual([]);
  expect(stageHeadline({ ...heavy, limitHits: 0 })).toBe("You never hit your limit");
});

test("[integration] TM-15 focus in the paste box survives a hashchange and a late fonts.ready on #command; Skip to the command still moves focus when it is elsewhere", async () => {
  for (const [width, height] of VIEWS) {
    // Fonts held back 2.5 s, so document.fonts.ready resolves after the visitor has clicked into the box.
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "no-preference" });
    const page = await context.newPage();
    try {
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (!url.startsWith(`http://127.0.0.1:${server.port}/`)) return route.abort();
        if (url.endsWith(".ttf")) await new Promise((done) => setTimeout(done, 2500));
        return route.continue();
      });
      await page.goto(`http://127.0.0.1:${server.port}/tm/#command`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.getElementById("pasteBox") !== null && document.querySelectorAll("#run .poster").length === 7);
      await page.locator("#pasteBox").focus();
      await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 10000 });
      await page.waitForTimeout(200);
      expect({ width, after: "fonts.ready", active: await page.evaluate(() => document.activeElement?.id) }).toEqual({ width, after: "fonts.ready", active: "pasteBox" });
      await page.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
      await page.waitForTimeout(50);
      expect({ width, after: "hashchange", active: await page.evaluate(() => document.activeElement?.id) }).toEqual({ width, after: "hashchange", active: "pasteBox" });
      // Focus elsewhere: Skip to the command still takes it to the section.
      await page.locator(".pick-btn[data-mode=burn]").focus();
      await page.locator("#jumpCommand").focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.activeElement?.id === "command");
    } finally { await context.close(); }
  }
}, 40000);


// Operator decisions (2026-10-21): Show my week, Show Sample and a paste never scroll or move focus; the card appears
// in place. Play my week (inside the card) is the only thing that scrolls: it plays the shown numbers on the stage.
for (const motion of MOTIONS) test(`[integration] TM-16 a paste shows the card in place (no scroll, focus stays in the box); Play my week puts the numbers on the stage and ends with focus on Replay (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    try {
      // A real paste: the clipboard holds the block, and the keyboard pastes it into the focused box.
      await page.locator("#pasteBox").scrollIntoViewIfNeeded();
      await page.evaluate((t) => navigator.clipboard.writeText(t), HEAVY);
      await page.locator("#pasteBox").focus();
      const y0 = await page.evaluate(() => scrollY);
      await page.keyboard.press("ControlOrMeta+V");
      expect(await page.locator("#pasteBox").inputValue()).toBe(HEAVY);
      await page.waitForFunction(() => document.getElementById("yourWeek")?.hidden === false, null, { timeout: 3000 });
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({ y: scrollY, focus: document.activeElement?.id ?? "", cardBottom: document.getElementById("yourWeek")?.getBoundingClientRect().bottom ?? 0 }));
      // The card may be brought into view ("nearest") only when it would be off screen; never toward the stage.
      expect(after.focus).toBe("pasteBox");
      expect(after.y).toBeGreaterThanOrEqual(y0 - 1);
      if (after.y > y0 + 1) expect(Math.round(after.cardBottom)).toBeLessThanOrEqual(height);
      const card = await page.evaluate(() => {
        const text = (sel: string): string => document.querySelector(sel)?.textContent ?? "";
        const rows = [...document.querySelectorAll("#yourFields dt")].map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]);
        const align = [...document.querySelectorAll("#yourFields dd")].map((dd) => getComputedStyle(dd).textAlign);
        return { name: text("#hYour"), period: text("#yourPeriod"), line: text("#yourLine"), rows, align };
      });
      expect(card).toEqual({
        name: "Your week", period: "2026-10-14 to 2026-10-20", line: "Heavy load: you hit your limit 22 times",
        rows: [["Claude sessions", "292"], ["Codex sessions", "2,730"], ["Claude output tokens", "7,124,205"], ["Codex output tokens", "3,213,109"], ["Opus share", "39%"], ["Usage limit hits", "22"], ["Codex weekly window used", "7%"]],
        align: Array(7).fill("right"),
      });
      // Show my week does the same: no scroll, focus stays where it was.
      const y1 = await page.evaluate(() => scrollY);
      await page.locator("#showWeek").click();
      expect(Math.abs((await page.evaluate(() => scrollY)) - y1)).toBeLessThanOrEqual(1);
      // Play my week: the stage scrolls to the top and plays these numbers.
      await page.locator("#playMine").click();
      if (motion === "no-preference") { await page.waitForFunction(() => document.getElementById("skip")?.hidden === false, null, { timeout: 3000 }); await page.locator("#skip").focus(); await page.keyboard.press("Enter"); }
      await page.waitForFunction(() => document.getElementById("dataEnd")?.hidden === false, null, { timeout: 6000 });
      await page.waitForTimeout(300);
      const stage = await page.evaluate(() => {
        const text = (sel: string): string => document.querySelector(sel)?.textContent ?? "";
        const posters = [...document.querySelectorAll("#run .poster")];
        return {
          top: Math.round(document.getElementById("stage")?.getBoundingClientRect().top ?? -99),
          days: posters.map((p) => p.querySelector(".day")?.textContent ?? ""),
          counts: posters.map((p) => p.querySelector(".lab")?.textContent ?? ""),
          stamped: posters.filter((p) => p.classList.contains("cut")).map((p) => p.querySelector(".day")?.textContent ?? ""),
          cancelled: posters.filter((p) => p.classList.contains("cancel")).length,
          left: text("#leftPct"), gauge: text("#gaugeName"), big: text("#dataBig"), sub: text("#dataSub"),
          drop: document.getElementById("drop")?.classList.contains("show-copy") ?? false, thursday: document.body.innerText.includes("Thursday night"),
          focus: document.activeElement?.id ?? "",
        };
      });
      expect({ width, ...stage, top: 0, focus: "" }).toEqual({
        width, top: 0, days: ["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"], counts: ["410", "520", "615", "448", "386", "330", "313"],
        stamped: ["Thu", "Sat"], cancelled: 0, left: "93%", gauge: "Codex week left",
        big: "You hit your limit 22 times, on Thu and Sat", sub: "292 Claude Code and 2,730 Codex sessions; Opus 39% of Claude output",
        drop: false, thursday: false, focus: "",
      });
      expect(Math.abs(stage.top)).toBeLessThanOrEqual(2);
      expect(stage.focus).toBe("replay");
      // See it with TokenMax runs the scripted With week, tagged as an example, not the visitor's numbers.
      await page.locator("#dataWith").click();
      await page.waitForFunction(() => document.getElementById("exampleTag")?.hidden === false, null, { timeout: 3000 });
      expect(await page.locator("#exampleTag").textContent()).toBe("Example week, not your numbers");
      expect(requests.filter((u) => !u.startsWith(`http://127.0.0.1:${server.port}/`))).toEqual([]);
    } finally { await close(page); }
  }
}, 60000);

test("[integration] TM-16b Play my week without the v2 lines: no counts, no stamps, no day claims; Lite ends on You never hit your limit; focus ends on Replay", async () => {
  for (const [width, height] of VIEWS) for (const [fixture, big] of [[HEAVY_V1, "You hit your limit 22 times"], [LITE, "You never hit your limit"]] satisfies [string, string][]) {
    const page = await open(width, height, "reduce");
    try {
      await page.locator("#pasteBox").fill(fixture);
      await page.locator("#showWeek").click();
      await page.locator("#playMine").click();
      await page.waitForFunction(() => document.getElementById("dataEnd")?.hidden === false, null, { timeout: 4000 });
      const s = await page.evaluate(() => ({
        big: document.getElementById("dataBig")?.textContent ?? "", stamped: document.querySelectorAll("#run .poster.cut").length, cancelled: document.querySelectorAll("#run .poster.cancel").length,
        counts: [...document.querySelectorAll("#run .poster .lab")].map((l) => l.textContent ?? ""), focus: document.activeElement?.id ?? "",
      }));
      const counts = fixture === HEAVY_V1 ? Array(7).fill("not recorded") : ["410", "520", "615", "448", "386", "330", "313"];
      expect({ width, ...s }).toEqual({ width, big, stamped: 0, cancelled: 0, counts, focus: "replay" });
    } finally { await close(page); }
  }
}, 40000);

// Operator decision (2026-10-21): the sample lives in the Your week card behind Show Sample, replacing the share card.
// The recorded run: 515 Claude Code + 3,478 Codex = 3,993 sessions, 2 cap hits, Opus-class 87%, Codex week 15%.
const SAMPLE_ROWS = [["Claude sessions", "515"], ["Codex sessions", "3,478"], ["Claude output tokens", "9,977,232"], ["Codex output tokens", "7,503,143"], ["Opus share", "87%"], ["Usage limit hits", "2"], ["Codex weekly window used", "15%"]];
for (const motion of MOTIONS) test(`[integration] TM-14 Show Sample: nothing of the sample at load; the card shows the six sample values with a Sample tag and no link; a valid paste replaces it; the old section is gone (${motion})`, async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, motion);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    try {
      const card = (): Promise<{ hidden: boolean; rows: string[][]; sample: boolean; local: boolean; links: number; text: string }> => page.evaluate(() => {
        const el = document.getElementById("yourWeek");
        return {
          hidden: !el || !el.checkVisibility(),
          rows: [...document.querySelectorAll("#yourFields dt")].map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]),
          sample: document.getElementById("sampleTag")?.checkVisibility() ?? false,
          local: document.getElementById("localTag")?.checkVisibility() ?? false,
          links: el?.querySelectorAll("a").length ?? -1,
          text: document.body.innerText,
        };
      });
      const atLoad = await card();
      expect({ width, hidden: atLoad.hidden, sample: atLoad.sample }).toEqual({ width, hidden: true, sample: false });
      for (const gone of ["3,478", "9,977,232", "7,503,143", "What a real week looks like", "See a sample card", "Open a sample card", "One builder's real week"]) expect({ gone, found: atLoad.text.includes(gone) }).toEqual({ gone, found: false });
      expect(await page.locator("#sceneB, #openCard, #browser, .url, a[href*='/maps/#m=']").count()).toBe(0);
      expect(await page.locator("#sceneD").isVisible()).toBe(true);
      // Show Sample sits on the row with Show my week, to its right, the same size.
      const row = await page.evaluate(() => {
        const a = document.getElementById("showWeek")?.getBoundingClientRect(), b = document.getElementById("showSample")?.getBoundingClientRect();
        return a && b ? { right: b.left > a.right, sameRow: Math.abs(a.top - b.top) < 2, sameHeight: Math.abs(a.height - b.height) < 1, text: document.getElementById("showSample")?.textContent } : null;
      });
      expect(row).toEqual({ right: true, sameRow: true, sameHeight: true, text: "Show Sample" });
      const ySample = await page.evaluate(() => scrollY);
      await page.locator("#showSample").click();
      const sample = await card();
      expect(await page.locator("#hYour").innerText()).toBe("Sample week");
      expect(await page.locator("#yourPeriod").innerText()).toBe("2026-10-09 to 2026-10-15");
      // No scroll toward the stage: at most "nearest" to bring the card into view.
      expect(await page.evaluate(() => scrollY)).toBeGreaterThanOrEqual(ySample - 1);
      expect(await page.evaluate(() => document.getElementById("stage")?.getBoundingClientRect().top ?? 0)).toBeLessThan(0);
      expect({ width, hidden: sample.hidden, rows: sample.rows, sample: sample.sample, local: sample.local, links: sample.links }).toEqual({ width, hidden: false, rows: SAMPLE_ROWS, sample: true, local: false, links: 0 });
      // Play my week on the sample: the stage says the per-day split is illustrative, never "from your numbers".
      const playAct = async (): Promise<string> => {
        await page.evaluate(() => document.getElementById("dataEnd")?.setAttribute("hidden", ""));
        await page.locator("#playMine").click();
        if (motion === "no-preference") { await page.waitForFunction(() => document.getElementById("skip")?.hidden === false, null, { timeout: 3000 }); await page.locator("#skip").click(); }
        await page.waitForFunction(() => document.getElementById("dataEnd")?.hidden === false, null, { timeout: 4000 });
        return (await page.locator("#act").textContent()) ?? "";
      };
      const sampleAct = await playAct();
      expect({ width, sampleLabel: sampleAct.startsWith("Sample week") && sampleAct.includes("per-day split illustrative, not your numbers"), mineLabel: sampleAct.includes("from your numbers") }).toEqual({ width, sampleLabel: true, mineLabel: false });
      // A valid paste replaces the sample: its own values, the local tag back, no Sample tag.
      await page.locator("#pasteBox").fill(SAMPLE_RESULT);
      await page.locator("#showWeek").click();
      const mine = await card();
      expect({ width, rows: mine.rows, sample: mine.sample, local: mine.local }).toEqual({ width, rows: SAMPLE_CARD.map((r) => [...r]), sample: false, local: true });
      const mineAct = await playAct();
      expect({ width, mineLabel: mineAct.startsWith("Your week") && mineAct.includes("from your numbers"), sampleLabel: mineAct.includes("illustrative") }).toEqual({ width, mineLabel: true, sampleLabel: false });
      if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(requests.filter((u) => !u.startsWith(`http://127.0.0.1:${server.port}/`))).toEqual([]);
    } finally { await close(page); }
  }
}, 40000);

test("[integration] the router card says not run yet and shows no result: no percentage, no counts beyond 47 jobs and #236", async () => {
  const page = await open(390, 844, "reduce");
  try {
    const text = await page.locator("#sceneD").evaluate((node) => [node.textContent ?? "", ...[...node.querySelectorAll("[aria-label], [title]")].map((el) => `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`)].join(" "));
    expect(text.replace(/\s+/g, " ")).toContain("47 jobs in rehearsal, not run yet");
    expect(text).toContain("no result yet");
    expect(text).not.toContain("%");
    expect([...new Set([...text.matchAll(/\d+/g)].map((m) => m[0]))].sort()).toEqual(["236", "47"]);
  } finally { await close(page); }
}, 30000);

for (const motion of MOTIONS) {
  // Floors: 12 px at 1440 (the floor this page had before The Run, #309 criterion 6); 11 px at 390, the prototype's
  // STYLE rule for phone poster labels, an explicit decision recorded on the PR for the operator to overrule.
  test(`[integration] every visible text node renders at 12 px or more at 1440 and 11 px or more at 390, at rest, at both end states and with the prompt open (${motion})`, async () => {
    for (const [width, height, floor] of [[390, 844, 11], [1440, 900, 12]] satisfies [number, number, number][]) for (const hash of ["", "#burn-before", "#under-after", "#command"]) {
      const page = await open(width, height, motion, undefined, hash);
      try {
        await page.waitForTimeout(300);
        const small = await page.evaluate((min) => {
          const found: string[] = [];
          const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walk.nextNode(); node; node = walk.nextNode()) {
            const text = (node.textContent ?? "").trim();
            const el = node.parentElement;
            if (!text || !el || el.closest("script, style") || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
            let px = parseFloat(getComputedStyle(el).fontSize);
            if (el instanceof SVGGraphicsElement) {
              const m = el.getScreenCTM();
              if (m) px *= Math.hypot(m.a, m.b);
            }
            if (px < min - 0.01) found.push(`${text.slice(0, 30)} ${px.toFixed(1)}px`);
          }
          return found;
        }, floor);
        expect({ width, hash, small }).toEqual({ width, hash, small: [] });
      } finally { await close(page); }
    }
  }, 90000);
}

test("[integration] TM-9 Skip while the curtain rises for See it with TokenMax lands on the With end state", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "no-preference", undefined, "#burn-before");
    try {
      await page.waitForFunction(() => document.getElementById("drop")?.classList.contains("show-copy") === true);
      await page.locator("#dropBtn").click();
      await page.waitForTimeout(150);
      await page.locator("#skip").click();
      await page.waitForTimeout(900);
      const end = await page.evaluate(() => ({ settled: document.getElementById("stage")?.classList.contains("settled"), act: document.getElementById("act")?.textContent ?? "", call: document.getElementById("stage")?.classList.contains("call") }));
      expect({ width, ...end }).toEqual({ width, settled: true, act: WITH_ACT.burn, call: true });
    } finally { await close(page); }
  }
}, 30000);

// Operator decision (2026-10-21): the tagline is hidden until a week has played to its end, then fades in under the
// stage in space kept for it, so nothing moves.
test("[integration] TM-13 the tagline is hidden at rest, shows after Skip and on every end-state deep link, centred under the stage, with no layout jump", async () => {
  const TAG = "TokenMax + Jev can help keep the lights on";
  const read = (page: Page): Promise<{ shown: boolean; text: string; top: number; centre: number; vw: number; stageBottom: number; commandTop: number; inText: boolean }> => page.evaluate(() => {
    const el = document.getElementById("keepLights");
    const r = el?.getBoundingClientRect();
    return {
      shown: !!el && el.classList.contains("shown") && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
      text: el?.textContent ?? "", top: (r?.top ?? 0) + scrollY, centre: r ? (r.left + r.right) / 2 : 0, vw: document.documentElement.clientWidth,
      stageBottom: (document.getElementById("stage")?.getBoundingClientRect().bottom ?? 0) + scrollY,
      commandTop: (document.getElementById("command")?.getBoundingClientRect().top ?? 0) + scrollY,
      inText: document.body.innerText.includes("TokenMax + Jev can help keep the lights on"),
    };
  });
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "no-preference");
    try {
      const rest = await read(page);
      expect({ width, shown: rest.shown, inText: rest.inText, text: rest.text }).toEqual({ width, shown: false, inText: false, text: TAG });
      expect(rest.top).toBeGreaterThanOrEqual(rest.stageBottom);
      expect(Math.abs(rest.centre - rest.vw / 2)).toBeLessThan(2);
      await page.locator(".pick-btn[data-mode=burn]").click();
      await page.waitForTimeout(600);
      // Measured while the week plays (the stage's Replay bar is already shown), so only the tagline could move things.
      const playing = await read(page);
      expect(playing.shown).toBe(false);
      await page.locator("#skip").click();
      await page.waitForFunction(() => document.getElementById("keepLights")?.classList.contains("shown") === true);
      await page.waitForTimeout(700);
      const after = await read(page);
      expect({ width, shown: after.shown, inText: after.inText }).toEqual({ width, shown: true, inText: true });
      // Space was kept: the tagline and the section under it did not move.
      expect({ top: Math.round(after.top), command: Math.round(after.commandTop) }).toEqual({ top: Math.round(playing.top), command: Math.round(playing.commandTop) });
    } finally { await close(page); }
    for (const hash of ["#burn-before", "#burn-after", "#under-before", "#under-after"]) {
      const deep = await open(width, height, "no-preference", undefined, hash);
      try {
        await deep.waitForFunction(() => document.getElementById("keepLights")?.classList.contains("shown") === true, null, { timeout: 4000 });
        expect({ width, hash, inText: (await read(deep)).inText }).toEqual({ width, hash, inText: true });
      } finally { await close(deep); }
    }
  }
}, 60000);

// Operator decision (2026-10-21): the formatted card names the cap event "Usage limit hits", as the prompt block does.
test("[integration] one name for the cap event: usage limit hits, never cap episodes", async () => {
  const page = await open(1440, 900, "reduce");
  try {
    const all = await page.evaluate(() => [document.documentElement.textContent ?? "", ...[...document.querySelectorAll("*")].flatMap((el) => ["title", "aria-label", "alt", "content"].map((a) => el.getAttribute(a) ?? ""))].join(" "));
    expect(all).not.toMatch(/cap episode/i);
    // The share card that named it moved into Show Sample (operator decision, 2026-10-21).
    await page.locator("#showSample").click();
    expect(await page.locator("#yourFields dt").allTextContents()).toContain("Usage limit hits");
    expect(await page.locator("#yourFields dt").allTextContents()).not.toContain("Cap hits");
    expect(await page.evaluate(() => document.documentElement.textContent ?? "")).not.toMatch(/cap episode/i);
  } finally { await close(page); }
  for (const file of ["index.html", "tm.css", "tm.js"]) expect(readFileSync(join(SITE, "tm", file), "utf8")).not.toMatch(/cap episode/i);
}, 30000);

test("[integration] the router card walks one example ruled job and one unmatched job, labelled as an example, with no router result anywhere", async () => {
  const page = await open(390, 844, "reduce");
  try {
    const card = await page.locator("#sceneD").evaluate((scene) => {
      const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      const ruled = scene.querySelector(".walk.ruled");
      const unmatched = scene.querySelector(".walk.unmatched");
      const path = ruled?.querySelector(".path") ?? null;
      return {
        all: text(scene),
        ruledJob: text(ruled?.querySelector(".job") ?? null),
        ruledRule: text(ruled?.querySelector(".rule") ?? null),
        yoursOnDashedLine: !!path?.querySelector(".yours") && getComputedStyle(path, "::before").borderTopStyle + getComputedStyle(path, "::before").borderLeftStyle,
        ruledDoor: text(ruled?.querySelector(".door") ?? null),
        openJob: text(unmatched?.querySelector(".job") ?? null),
        openRule: text(unmatched?.querySelector(".rule") ?? null),
        openDoor: text(unmatched?.querySelector(".door") ?? null),
        jev: text(scene.querySelector("#jevdef")),
        example: text(scene.querySelector("#router .eg")),
      };
    });
    // No source holds the jobs, the rule or the count 47 (site/tm/index.html, Scene D sources), so the card says example.
    expect(card.example).toBe("Example jobs, rule and count");
    expect(card.ruledJob).toBe("Job Implement a feature in a client app");
    expect(card.ruledRule).toBe("Example rule R-PRO matches \\bimplement(s|ed|ing|ation)?\\b, seat pro_ok");
    expect(String(card.yoursOnDashedLine)).toContain("dashed");
    expect(card.ruledDoor).toBe("Door Claude, ChatGPT or Codex window");
    expect(card.openJob).toBe("Job Pick up the next ticket");
    expect(card.openRule).toBe("No rule matches: abstain");
    expect(card.openDoor).toBe("Door Jev in rehearsal, 47 jobs (example), not run yet");
    expect(card.jev).toBe("Jev picks from a fixed list of answers, fast and cheap");
    expect(card.all).not.toMatch(/route most|most jobs|%/i);
    expect([...new Set([...card.all.matchAll(/\d+/g)].map((m) => m[0]))].sort()).toEqual(["236", "47"]);
  } finally { await close(page); }
}, 30000);

for (const motion of MOTIONS) {
  test(`[integration] every visible button and link is at least 24x24 px with text at least 13 px (${motion})`, async () => {
    for (const [width, height] of VIEWS) {
      const page = await open(width, height, motion);
      try {
        let checked = 0;
        for (const pick of [false, true]) {
          if (pick) { await page.locator(".pick-btn[data-mode=burn]").click(); await page.locator("#replay").waitFor(); }
          const res = await page.evaluate(() => {
            const bad: string[] = [];
            let n = 0;
            for (const el of document.querySelectorAll("a[href], button, summary")) {
              if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
              n += 1;
              const r = el.getBoundingClientRect();
              const px = parseFloat(getComputedStyle(el).fontSize);
              if (r.width < 24 || r.height < 24 || px < 13) bad.push(`${(el.textContent ?? "").trim()} ${r.width.toFixed(0)}x${r.height.toFixed(0)} ${px}px`);
            }
            return { bad, n };
          });
          expect(res.bad).toEqual([]);
          checked += res.n;
        }
        // At rest: Skip to the command (off screen until focused), two picks, Try, Copy, the guide, the sample card, /maps/; then with the show played,
        // Replay, Try on the curtain and the rest again.
        expect(checked).toBeGreaterThanOrEqual(18);
      } finally { await close(page); }
    }
  }, 60000);
}

test("[integration] if tm.js does not load, the front panel, the full prompt with Copy, the sample week and the maps link are still shown", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  try {
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.endsWith("/tm/tm.js")) return route.abort();
      return url.startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort();
    });
    await page.goto(`http://127.0.0.1:${server.port}/tm/`, { waitUntil: "load" });
    const hidden = await page.evaluate(() => {
      const out: string[] = [];
      for (const root of document.querySelectorAll(".front, #command, #sceneD")) {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walk.nextNode(); node; node = walk.nextNode()) {
          const text = (node.textContent ?? "").trim();
          const el = node.parentElement;
          // The status line, the paste error, the submit receipt and the Your week card stay hidden until used, by design;
          // the phone way forward shows on a narrow screen only (TM-41).
          if (!text || !el || el.id === "copyMsg" || el.closest("#pasteError, #yourWeek, #submitted, #phoneWay")) continue;
          if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) out.push(text);
        }
      }
      return out;
    });
    expect(hidden).toEqual([]);
    expect(await page.locator("#sharePrompt").isVisible()).toBe(true);
    expect(await page.locator("#copy").isVisible()).toBe(true);
    expect(await page.locator("#sharePrompt").textContent()).toBe(PROMPT);
  } finally { await context.close(); }
}, 30000);

test("[integration] Tab from the top reaches Skip to the command, Copy, this week's card and /maps/, each on screen when focused", async () => {
  for (const [width, height] of VIEWS) {
    const page = await open(width, height, "no-preference");
    try {
      const reached: { id: string; inView: boolean }[] = [];
      for (let i = 0; i < 30 && !reached.some((r) => r.id === "seeMaps"); i++) {
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => {
          const el = document.activeElement;
          if (!(el instanceof HTMLElement) || !el.id) return null;
          const r = el.getBoundingClientRect();
          return { id: el.id, inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth };
        });
        if (focused) reached.push(focused);
      }
      const want = ["jumpCommand", "copy", "showWeek", "showSample", "seeMaps"];
      expect({ width, found: reached.filter((r) => want.includes(r.id)) }).toEqual({ width, found: want.map((id) => ({ id, inView: true })) });
    } finally { await close(page); }
  }
}, 30000);

// #378: a persistent "Program (guide)" link to /guide/ sits top right in the first viewport.
test("[unit] PG3 /tm/ carries a Program (guide) link to /guide/ after the skip link and before the playbill, besides the TokenMax guide link", () => {
  const page = html();
  expect(page).toContain('<a class="program-link" href="/guide/">Program (guide)</a>');
  expect(page.indexOf('id="jumpCommand"')).toBeLessThan(page.indexOf('class="program-link"'));
  expect(page.indexOf('class="program-link"')).toBeLessThan(page.indexOf('class="playbill"'));
  expect(page).toContain('id="tokenmaxGuide"');
});

for (const motion of MOTIONS) for (const [width, height] of VIEWS) test(`[integration] PG4 /tm/ at ${width}x${height} (${motion}) shows the Program (guide) link top right in the first viewport, with no scroll`, async () => {
  const page = await open(width, height, motion);
  try {
    const link = page.getByRole("link", { name: "Program (guide)" });
    expect(await link.count()).toBe(1);
    expect(await link.getAttribute("href")).toBe("/guide/");
    const view = await link.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, topFifth: r.top < innerHeight / 5, right: (r.left + r.right) / 2 > innerWidth / 2, hit: hit === node || node.contains(hit), y: scrollY };
    });
    expect({ width, motion, ...view }).toEqual({ width, motion, inView: true, topFifth: true, right: true, hit: true, y: 0 });
  } finally { await close(page); }
}, 30000);

// ux-swarm 2026-10-23 c04: the prompt step assumed a computer; a phone visitor dead-ended. The step says where it runs,
// and a phone gets two ways forward: watch the sample week, or send this page to the computer.
const DEVICE = "This step runs in Claude Code or Codex, on the computer where you use them.";
for (const [width, height] of VIEWS) test(`[integration] TM-41 at ${width}x${height} the prompt step says it runs on your computer; only a narrow screen gets the phone way forward`, async () => {
  const page = await open(width, height, "reduce");
  try {
    const note = page.locator("#deviceNote");
    expect(await note.innerText()).toBe(DEVICE);
    expect(await note.isVisible()).toBe(true);
    expect(await page.evaluate(() => {
      const n = document.getElementById("deviceNote"), c = document.getElementById("copy");
      return !!n && !!c && (n.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    })).toBe(true);
    expect(await page.locator("#phoneWay").isVisible()).toBe(width < 760);
  } finally { await close(page); }
}, 30000);

test("[integration] TM-42 at 390x844 Watch the sample week plays the sample on stage; the link button hands this page to the computer", async () => {
  const page = await open(390, 844, "reduce");
  try {
    await page.evaluate(() => { Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true }); });
    await page.locator("#phoneSample").click();
    expect(await page.locator("#yourWeek").isVisible()).toBe(true);
    expect(await page.locator("#sampleTag").isVisible()).toBe(true);
    await page.waitForFunction(() => Math.abs(document.getElementById("stage")?.getBoundingClientRect().top ?? 999) < 40);
    await page.locator("#phoneLink").scrollIntoViewIfNeeded();
    await page.locator("#phoneLink").click();
    await page.waitForFunction(() => (document.getElementById("copyMsg")?.textContent ?? "").length > 0);
    expect(await page.locator("#copyMsg").textContent()).toBe("Link copied. Open it on the computer where you use Claude Code or Codex.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:${server.port}/tm/`);
  } finally { await close(page); }
}, 30000);

// ux-swarm 2026-10-23 c05 (and Olly, 2026-10-22): no visible way to ask or send feedback. A plain link sits in the first
// viewport, and once a week has played a block under the stage offers the feedback form and the guide.
for (const [width, height] of VIEWS) test(`[integration] TM-43 at ${width}x${height}, when the show ends, a feedback link is on screen with no scroll and the ask block offers feedback and the guide`, async () => {
  const fresh = await open(width, height, "reduce");
  try {
    expect(await fresh.locator("#askAfter").isVisible()).toBe(false);
  } finally { await close(fresh); }
  const page = await open(width, height, "reduce", undefined, "#burn-after");
  try {
    await page.waitForFunction(() => document.getElementById("stage")?.classList.contains("settled") === true);
    const onScreen = await page.evaluate(() => [...document.querySelectorAll('a[href="/feedback/?from=tm"]')].filter((a) => {
      const r = a.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && (hit === a || a.contains(hit));
    }).map((a) => a.textContent));
    expect({ width, y: await page.evaluate(() => scrollY), onScreen }).toEqual({ width, y: 0, onScreen: ["Ask a question or send feedback"] });
    const block = page.locator("#askAfter");
    expect(await block.isVisible()).toBe(true);
    const links = await block.locator("a").evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute("href")]));
    expect(links).toEqual([["Ask a question or tell us what you think", "/feedback/?from=tm"], ["Read the guide", "/guide/"]]);
  } finally { await close(page); }
}, 30000);
