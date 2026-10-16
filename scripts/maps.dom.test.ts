import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import { SHARE_BASE, shareLink, type SharePayload } from "../skills/tokenmax-map/scripts/map.ts";

// The /maps/ share page and board (#238). A fake Backstage answers /api/maps and /api/maps/delete per the contract
// and records every request, so the tests can count what the page sends and when.

const SITE = join(import.meta.dir, "..", "site");
const COMMAND = "curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts | bun run - --share";
const LABEL = /self-reported by tokenmax-map \d+\.\d+\.\d+, not verified/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
type Seen = { method: string; path: string; body: unknown };
type Row = Rec & { id: string; alias: string; day: string };

const PAYLOAD: SharePayload = {
  v: "tm-share/1",
  skill: "0.3.0",
  days: 7,
  sources: "claude+codex",
  sessions: 42,
  subagent_sessions: 9,
  caps: { short: 2, weekly: 1, unknown: 0 },
  output_tokens: { claude: 1234567, codex: 89012 },
  opus_share_pct: 61,
  codex_weekly_pct: 37,
};
// [field, exact value sent (data-value), text shown]. The v3 share card shows every value exactly, grouped by thousands.
const LEAVES: [string, string, string][] = [
  ["v", "tm-share/1", "tm-share/1"], ["skill", "0.3.0", "0.3.0"], ["days", "7", "7"], ["sources", "claude+codex", "claude+codex"],
  ["sessions", "42", "42"], ["subagent_sessions", "9", "9"], ["caps.short", "2", "2"], ["caps.weekly", "1", "1"], ["caps.unknown", "0", "0"],
  ["output_tokens.claude", "1234567", "1,234,567"], ["output_tokens.codex", "89012", "89,012"], ["opus_share_pct", "61", "61"], ["codex_weekly_pct", "37", "37"],
];

function boardRow(id: string, alias: string, payload: Rec): Row {
  const row: Row = { id, alias, day: "2026-10-16" };
  for (const [key, value] of Object.entries(payload)) if (key !== "v") row[key] = value;
  return row;
}
const OTHER = boardRow("TM-0000000000A1", "builder-zz99", { ...PAYLOAD, skill: "0.3.0", sessions: 5, subagent_sessions: 0, caps: { short: 0, weekly: 0, unknown: 1 }, output_tokens: { claude: 0, codex: 5000 }, opus_share_pct: 0, codex_weekly_pct: null });

function totals(rows: Row[]): Rec {
  let capEpisodes = 0, withWeekly = 0;
  for (const row of rows) {
    const caps = row.caps;
    if (!isRec(caps)) continue;
    const n = (k: string) => { const v = caps[k]; return typeof v === "number" ? v : 0; };
    capEpisodes += n("short") + n("weekly") + n("unknown");
    if (n("weekly") > 0) withWeekly += 1;
  }
  return { builders: rows.length, cap_episodes: capEpisodes, with_weekly_cap: withWeekly };
}

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let origin = "";
const seen: Seen[] = [];
let rows: Row[] = [];
let postReply: { status: number; body: Rec } | null = null;
let deleteReply: { status: number; body: Rec } | null = null;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname.startsWith("/api/maps")) {
      const text = request.method === "POST" ? await request.text() : "";
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      seen.push({ method: request.method, path: pathname, body });
      if (pathname === "/api/maps" && request.method === "GET") return Response.json({ rows, totals: totals(rows) }, { headers: { "cache-control": "no-store" } });
      if (pathname === "/api/maps" && request.method === "POST") {
        if (postReply) return Response.json(postReply.body, { status: postReply.status });
        if (!isRec(body) || !isRec(body.payload) || typeof body.alias !== "string" || typeof body.request_key !== "string") return Response.json({ code: "bad-body", field: "", reason: "not an object" }, { status: 400 });
        const id = "TM-00000000BEEF";
        rows = [boardRow(id, body.alias, body.payload), ...rows];
        return Response.json({ id, replay: false, delete: `/maps/#delete=${id}.${body.request_key}`, board: { rows, totals: totals(rows) } });
      }
      if (pathname === "/api/maps/delete" && request.method === "POST") {
        if (deleteReply) return Response.json(deleteReply.body, { status: deleteReply.status });
        return Response.json({ deleted: true });
      }
      return new Response("Not found", { status: 404 });
    }
    const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });
beforeEach(() => { seen.length = 0; rows = [OTHER]; postReply = null; deleteReply = null; });

const apiSeen = () => seen.filter((s) => s.path === "/api/maps" || s.path === "/api/maps/delete");
const posts = (path = "/api/maps") => seen.filter((s) => s.method === "POST" && s.path === path);
const link = () => shareLink(PAYLOAD, `${origin}/maps/`);
const fragment = (json: string) => `${origin}/maps/#m=${Buffer.from(json, "utf8").toString("base64url")}`;

async function open(url: string, width = 1440, height = 900, motion: "reduce" | "no-preference" = "no-preference"): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await page.goto(url, { waitUntil: "load" });
  return { page, context };
}

test("[unit] M0 the share link is built by the mapper's own shareLink against SHARE_BASE", () => {
  expect(SHARE_BASE).toBe("https://jevnotjev.breakoutwithai.com/maps/");
  expect(link().startsWith(`${origin}/maps/#m=`)).toBe(true);
});

test("[integration] 1 a valid link shows every payload field with its value and a prefilled alias", async () => {
  const { page, context } = await open(link());
  try {
    await page.locator("#mapShare").waitFor();
    expect(await page.locator("#mapPreview").innerText()).toContain("What will be sent");
    for (const [field, exact, shown] of LEAVES) {
      const cell = page.locator(`#mapFields [data-field="${field}"]`);
      expect(await cell.count(), field).toBe(1);
      expect(await cell.getAttribute("data-value"), field).toBe(exact);
      expect((await cell.innerText()).trim(), field).toBe(shown);
    }
    // The exact token counts are visible in words, not only in an attribute.
    const fieldsText = await page.locator("#mapFields").innerText();
    expect(fieldsText).toContain("1,234,567");
    expect(fieldsText).toContain("89,012");
    expect(fieldsText.toLowerCase()).toContain("short / weekly / unknown");
    // The v3 share card: one labelled line per field (11 lines for 13 leaves, caps on one line), not a table.
    expect(await page.locator("#mapFields table").count()).toBe(0);
    expect(await page.locator("#mapFields dl.map-field-list > dt").count()).toBe(11);
    expect(await page.locator("#mapFields dl.map-field-list > dd").count()).toBe(11);
    expect(await page.locator("#mapPreview button").count()).toBe(1);
    expect(await page.locator("label[for=mapAlias]").innerText()).toContain("Alias on the board");
    expect(await page.locator("#mapAlias").inputValue()).toMatch(/^builder-[a-z0-9]{4}$/);
    expect(await page.locator("#mapPreview").innerText()).toContain("Nothing has been sent yet.");
    expect(await page.locator("button#mapShare[type=button]").innerText()).toBe("Share");
  } finally { await context.close(); }
});

test("[integration] 2 M5 a valid link sends nothing to /api/maps before Share", async () => {
  const { page, context } = await open(link());
  try {
    await page.locator("#mapShare").waitFor();
    await page.waitForTimeout(1000);
    const n = apiSeen().length;
    console.log(`M5 api_maps_requests_before_share=${n}`);
    expect(n).toBe(0);
  } finally { await context.close(); }
});

test("[integration] 3 Share sends exactly one POST with the decoded payload, the alias and a 43-char request key", async () => {
  const { page, context } = await open(link());
  try {
    await page.locator("#mapShare").dblclick();
    await page.locator("#mapBoard .map-row.mine").waitFor();
    await page.waitForTimeout(200);
    expect(posts().length).toBe(1);
    const body = posts()[0]?.body;
    if (!isRec(body)) throw new Error("body is not an object");
    expect(Object.keys(body).sort()).toEqual(["alias", "nickname", "payload", "request_key"]);
    expect(body.nickname).toBe("");
    expect(body.payload).toEqual(PAYLOAD);
    expect(JSON.stringify(body.payload)).toBe(JSON.stringify(PAYLOAD));
    expect(body.alias).toMatch(/^builder-[a-z0-9]{4}$/);
    expect(body.request_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  } finally { await context.close(); }
});

test("[integration] 4 after Share the own row, the status, the delete link show and the fragment is gone", async () => {
  const { page, context } = await open(link());
  try {
    await page.locator("#mapAlias").fill("builder-me42");
    await page.locator("#mapShare").click();
    const mine = page.locator("#mapBoard .map-row.mine");
    await mine.waitFor();
    expect(await mine.innerText()).toContain("builder-me42");
    expect(await page.locator("#mapBoard .map-row").count()).toBe(2);
    const status = page.locator("#mapStatus");
    expect(await status.getAttribute("aria-live")).toBe("polite");
    expect(await status.innerText()).toBe("Shared. Your row is on the board.");
    const body = posts()[0]?.body;
    const key = isRec(body) ? String(body.request_key) : "";
    const del = page.locator("#mapDeleteLink a");
    expect(await del.getAttribute("href")).toBe(`${origin}/maps/#delete=TM-00000000BEEF.${key}`);
    expect(await page.locator("#mapDeleteLink").innerText()).toContain("Keep this link to delete your row");
    expect(await page.evaluate(() => location.hash)).toBe("");
    expect(await page.locator("#mapTotals").innerText()).toContain("2");
  } finally { await context.close(); }
});

test("[integration] 5 a 400 bad-alias shows the reason as an alert, adds no row and keeps Share available", async () => {
  postReply = { status: 400, body: { code: "bad-alias", field: "alias", reason: "alias must be 3 to 24 of a-z, 0-9 or hyphen" } };
  const { page, context } = await open(link());
  try {
    await page.locator("#mapShare").click();
    const alert = page.locator("[role=alert]");
    await page.waitForFunction(() => (document.querySelector("[role=alert]")?.textContent ?? "").length > 0);
    expect(await alert.innerText()).toContain("alias must be 3 to 24 of a-z, 0-9 or hyphen");
    expect(await page.locator("#mapBoard .map-row").count()).toBe(0);
    expect(await page.locator("#mapShare").isEnabled()).toBe(true);
    expect(await page.locator("#mapShare").isVisible()).toBe(true);
  } finally { await context.close(); }
});

const tampered = (): [string, string][] => [
  ["extra key", fragment(JSON.stringify({ ...PAYLOAD, extra: 1 }))],
  ["__proto__ key", fragment(JSON.stringify(PAYLOAD).replace(/}$/, ',"__proto__":{}}'))],
  ["nested extra key", fragment(JSON.stringify({ ...PAYLOAD, caps: { ...PAYLOAD.caps, monthly: 1 } }))],
  ["string in a number", fragment(JSON.stringify({ ...PAYLOAD, sessions: "42" }))],
  ["float", fragment(JSON.stringify({ ...PAYLOAD, opus_share_pct: 61.5 }))],
  ["out of range", fragment(JSON.stringify({ ...PAYLOAD, days: 91 }))],
  ["subagents above sessions", fragment(JSON.stringify({ ...PAYLOAD, subagent_sessions: 43 }))],
  ["keys out of order", fragment(JSON.stringify({ skill: PAYLOAD.skill, v: PAYLOAD.v, days: 7, sources: PAYLOAD.sources, sessions: 42, subagent_sessions: 9, caps: PAYLOAD.caps, output_tokens: PAYLOAD.output_tokens, opus_share_pct: 61, codex_weekly_pct: 37 }))],
  ["not base64", `${origin}/maps/#m=%%%not*base64`],
  ["not json", `${origin}/maps/#m=${Buffer.from("hello", "utf8").toString("base64url")}`],
];
test("[integration] 6 a tampered fragment shows the not-a-map message, no Share button and sends nothing", async () => {
  for (const [name, url] of tampered()) {
    const { page, context } = await open(url, 390, 844);
    try {
      await page.waitForFunction(() => (document.querySelector("#mapInvalid")?.textContent ?? "").length > 0);
      expect(await page.locator("#mapInvalid").innerText(), name).toContain("This link does not hold a tm-share/1 map.");
      expect(await page.locator("#mapInvalid").isVisible(), name).toBe(true);
      expect(await page.locator("#mapShare:visible").count(), name).toBe(0);
      await page.waitForTimeout(150);
      expect(apiSeen().length, name).toBe(0);
    } finally { await context.close(); }
  }
}, 30000);

test("[integration] 7 keyboard only: Tab reaches the alias then Share, Enter sends, the focus ring shows", async () => {
  for (const key of ["Enter", " "]) {
    seen.length = 0;
    rows = [OTHER];
    const { page, context } = await open(link());
    try {
      await page.locator("#mapShare").waitFor();
      let reached = false;
      for (let i = 0; i < 12 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await page.evaluate(() => document.activeElement?.id === "mapAlias");
      }
      expect(reached).toBe(true);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("mapShare");
      const ring = await page.locator("#mapShare").evaluate((node) => {
        const style = getComputedStyle(node);
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
      });
      expect(ring.style).not.toBe("none");
      expect(ring.width).toBeGreaterThan(0);
      await page.keyboard.press(key);
      await page.locator("#mapBoard .map-row.mine").waitFor();
      expect(posts().length).toBe(1);
    } finally { await context.close(); }
  }
}, 30000);

test("[integration] 8 no horizontal scroll at 390x844 and 1440x900 before and after Share and on the board", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    for (const url of [link(), `${origin}/maps/`]) {
      rows = [OTHER, boardRow("TM-0000000000A2", "builder-wide-alias-123456", { ...PAYLOAD, output_tokens: { claude: 1000000000000, codex: 1000000000000 } })];
      const { page, context } = await open(url, width, height);
      try {
        if (url.includes("#m=")) {
          await page.locator("#mapShare").waitFor();
          const before = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
          expect(before.s, `${width} preview`).toBeLessThanOrEqual(before.c);
          await page.locator("#mapShare").click();
        }
        await page.locator("#mapBoard .map-row").first().waitFor();
        const after = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
        expect(after.s, `${width} board`).toBeLessThanOrEqual(after.c);
      } finally { await context.close(); }
    }
  }
}, 30000);

test("[integration] 9 under reduced motion nothing animates or transitions", async () => {
  const { page, context } = await open(link(), 390, 844, "reduce");
  try {
    await page.locator("#mapShare").focus();
    await page.locator("#mapShare").click();
    await page.locator("#mapBoard .map-row.mine").waitFor();
    const moving = await page.evaluate(() => {
      const busy: string[] = [];
      for (const node of Array.from(document.querySelectorAll("*"))) {
        const style = getComputedStyle(node);
        const anyNonZero = (list: string) => list.split(",").some((v) => parseFloat(v) > 0);
        if (style.animationName !== "none" && anyNonZero(style.animationDuration)) busy.push(`${node.tagName} animation`);
        if (anyNonZero(style.transitionDuration)) busy.push(`${node.tagName} transition`);
      }
      return { busy, running: document.getAnimations().length };
    });
    expect(moving.busy).toEqual([]);
    expect(moving.running).toBe(0);
  } finally { await context.close(); }
});

test("[integration] 10 with no fragment the page reads the board once and labels every row as self-reported", async () => {
  rows = [boardRow("TM-0000000000B2", "builder-new1", { ...PAYLOAD, skill: "0.3.1" }), OTHER];
  const { page, context } = await open(`${origin}/maps/`);
  try {
    await page.locator("#mapBoard .map-row").nth(1).waitFor();
    await page.waitForTimeout(200);
    expect(seen.filter((s) => s.method === "GET" && s.path === "/api/maps").length).toBe(1);
    expect(apiSeen().length).toBe(1);
    const totalsText = (await page.locator("#mapTotals").innerText()).replace(/\s+/g, " ");
    expect(totalsText).toContain("2 builders mapped");
    expect(totalsText).toContain("4 cap episodes");
    expect(totalsText).toContain("1 builder hit a weekly cap");
    const rowsShown = page.locator("#mapBoard .map-row");
    expect(await rowsShown.count()).toBe(2);
    const first = await rowsShown.nth(0).innerText();
    expect(first).toContain("builder-new1");
    expect(first).toContain("self-reported by tokenmax-map 0.3.1, not verified");
    const second = await rowsShown.nth(1).innerText();
    expect(second).toContain("builder-zz99");
    expect(second).toContain("self-reported by tokenmax-map 0.3.0, not verified");
    for (const text of [first, second]) {
      expect(text).toMatch(LABEL);
      for (const word of ["2026-10-16", "sessions", "caps short / weekly / unknown", "claude output", "codex output", "opus share", "codex weekly"]) expect(text.toLowerCase()).toContain(word);
    }
    // Output tokens in compact form; the exact count stays in the title.
    expect(first).toContain("1.2M");
    expect(await rowsShown.nth(0).locator('[title="1,234,567 output tokens"]').count()).toBe(1);
    expect(second.replace(/\s+/g, " ")).toContain("0 / 0 / 1");
    expect(second).toContain("none read");
    // Data is text, never markup: an alias with markup characters would not become an element.
    expect(await page.locator("#mapBoard script, #mapBoard img").count()).toBe(0);
  } finally { await context.close(); }
});

const THREE = (): Row[] => [
  boardRow("TM-0000000000C3", "builder-c333", { ...PAYLOAD, skill: "0.3.2", caps: { short: 3, weekly: 2, unknown: 1 } }),
  boardRow("TM-0000000000C2", "builder-c222", { ...PAYLOAD, caps: { short: 0, weekly: 0, unknown: 0 } }),
  OTHER,
];

test("[integration] 10b the board header is exactly 3 stat tiles whose figures equal the API totals", async () => {
  rows = THREE();
  const want = totals(rows);
  const { page, context } = await open(`${origin}/maps/`, 390, 844);
  try {
    await page.locator("#mapBoard .map-row").nth(2).waitFor();
    const tiles = page.locator("#mapTotals .map-tile");
    expect(await tiles.count()).toBe(3);
    const figures: Record<string, string> = {};
    for (let i = 0; i < 3; i++) {
      const tile = tiles.nth(i);
      const key = String(await tile.getAttribute("data-total"));
      figures[key] = (await tile.locator(".map-tile-figure").innerText()).trim();
      expect((await tile.locator(".map-tile-label").innerText()).trim().length).toBeGreaterThan(0);
    }
    expect(figures).toEqual({ builders: String(want.builders), cap_episodes: String(want.cap_episodes), with_weekly_cap: String(want.with_weekly_cap) });
    expect(figures).toEqual({ builders: "3", cap_episodes: "7", with_weekly_cap: "1" });
    const fontFamily = await tiles.first().locator(".map-tile-figure").evaluate((n) => getComputedStyle(n).fontFamily);
    expect(fontFamily).toContain("Alegreya");
  } finally { await context.close(); }
});

test("[integration] 10c every board row shows the not-verified label once, newest first", async () => {
  rows = THREE();
  const { page, context } = await open(`${origin}/maps/`);
  try {
    await page.locator("#mapBoard .map-row").nth(2).waitFor();
    const shown = page.locator("#mapBoard .map-row");
    expect(await shown.count()).toBe(3);
    const aliases: string[] = [];
    for (let i = 0; i < 3; i++) {
      const row = shown.nth(i);
      const labels = row.locator(".map-row-label");
      expect(await labels.count()).toBe(1);
      expect(await labels.isVisible()).toBe(true);
      expect(await labels.innerText()).toMatch(LABEL);
      aliases.push((await row.locator(".map-row-alias").innerText()).trim());
    }
    expect(aliases).toEqual(["builder-c333", "builder-c222", "builder-zz99"]);
    expect(await shown.nth(0).locator(".map-row-label").innerText()).toContain("tokenmax-map 0.3.2");
  } finally { await context.close(); }
});

test("[integration] 10d the board is the v3 cast list and no visible label on it ends with a full stop or a colon", async () => {
  rows = THREE();
  const { page, context } = await open(`${origin}/maps/`, 390, 844);
  try {
    await page.locator("#mapBoard .map-row").nth(2).waitFor();
    expect((await page.locator("#mapBoardTitle").innerText()).trim()).toBe("Cast list");
    expect(await page.locator("#mapBoardSection").innerText()).toContain("Newest first, self-reported, not verified");
    // Every visible element on the board whose own text is not empty: headings, sub line, tile labels, figure labels, row labels.
    const labels = await page.locator("#mapBoardSection").evaluate((root) => {
      const out: string[] = [];
      for (const n of Array.from(root.querySelectorAll("*"))) {
        const own = Array.from(n.childNodes).filter((c) => c.nodeType === Node.TEXT_NODE).map((c) => c.textContent ?? "").join("").trim();
        if (!own) continue;
        const box = n.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        out.push(own);
      }
      return out;
    });
    expect(labels.length).toBeGreaterThan(20);
    expect(labels.filter((text) => /[.:]$/.test(text))).toEqual([]);
  } finally { await context.close(); }
});

test("[integration] 11 a delete link sends one POST with the id and key and reports success", async () => {
  const key = "A".repeat(43);
  const { page, context } = await open(`${origin}/maps/#delete=TM-00000000BEEF.${key}`);
  try {
    const button = page.locator("#mapDeleteRow");
    expect(await button.innerText()).toBe("Delete my row");
    expect(apiSeen().length).toBe(0);
    await button.click();
    await page.waitForFunction(() => (document.querySelector("#mapStatus")?.textContent ?? "").length > 0);
    expect(posts("/api/maps/delete").length).toBe(1);
    expect(posts("/api/maps/delete")[0]?.body).toEqual({ id: "TM-00000000BEEF", key });
    expect(await page.locator("#mapStatus").innerText()).toContain("Deleted");
  } finally { await context.close(); }
});

test("[integration] 11b a delete link the server does not know reports not found", async () => {
  deleteReply = { status: 404, body: { code: "not-found" } };
  const { page, context } = await open(`${origin}/maps/#delete=TM-00000000BEEF.${"B".repeat(43)}`);
  try {
    await page.locator("#mapDeleteRow").click();
    await page.waitForFunction(() => (document.querySelector("[role=alert]")?.textContent ?? "").length > 0);
    expect(await page.locator("[role=alert]").innerText()).toContain("No row matches this delete link");
  } finally { await context.close(); }
});

test("[integration] 13 a retry after a network error reuses the same request_key", async () => {
  const { page, context } = await open(link());
  try {
    const keys: unknown[] = [];
    await page.route("**/api/maps", (route) => {
      const body: unknown = route.request().postDataJSON();
      keys.push(isRec(body) ? body.request_key : null);
      return keys.length === 1 ? route.abort() : route.continue();
    });
    await page.locator("#mapShare").click();
    await page.waitForFunction(() => (document.querySelector("[role=alert]")?.textContent ?? "").length > 0);
    expect(await page.locator("#mapShare").isEnabled()).toBe(true);
    await page.locator("#mapShare").click();
    await page.locator("#mapBoard .map-row.mine").waitFor();
    expect(keys.length).toBe(2);
    expect(keys[1]).toBe(keys[0]);
    expect(posts().length).toBe(1);
    expect(await page.locator("[role=alert]").innerText()).toBe("");
  } finally { await context.close(); }
});

test("[integration] 12 M1 landing to own row on the board in four actions or fewer", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  let actions = 0;
  try {
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#tmCopy").click(); actions += 1;
    expect(await page.locator("#tmCommand").innerText()).toBe(COMMAND);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COMMAND);
    // Action 2: paste into a terminal; the mapper prints shareLink(payload). Simulated with the fixture payload.
    actions += 1;
    const printed = link();
    await page.goto(printed, { waitUntil: "load" }); actions += 1;
    expect(await page.locator("#mapAlias").inputValue()).toMatch(/^builder-[a-z0-9]{4}$/);
    await page.locator("#mapShare").click(); actions += 1;
    await page.locator("#mapBoard .map-row.mine").waitFor();
    console.log(`M1 actions=${actions}`);
    expect(actions).toBeLessThanOrEqual(4);
  } finally { await context.close(); }
}, 30000);
