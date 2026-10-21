import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import { SHARE_BASE, shareLink, type SharePayload } from "../skills/tokenmax-map/scripts/map.ts";
import { withStripShown } from "./tm-strip.ts";

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
let privateReply: { status: number; body: Rec } | null = null;
// The landing strip ships hidden; the one test that starts from it serves the landing page with that one `hidden` removed.
let landingStripShown = false;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === "/api/questions" && request.method === "POST") {
      const body: unknown = await request.json();
      seen.push({ method: "POST", path: pathname, body });
      if (privateReply) return Response.json(privateReply.body, { status: privateReply.status });
      const key = isRec(body) && typeof body.request_key === "string" ? body.request_key : "";
      return Response.json({ id: "Q-00000000BEEF", status_code: `Q-00000000BEEF.${key}`, state: "pending_review", replay: false });
    }
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
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    if (landingStripShown && path === join(SITE, "index.html")) return new Response(withStripShown(await file.text()), { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response(file);
  } });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });
beforeEach(() => { seen.length = 0; rows = [OTHER]; postReply = null; deleteReply = null; privateReply = null; landingStripShown = false; });

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

test("[integration] board lede shows the default and longer window", async () => {
  const { page, context } = await open(`${origin}/maps/`);
  try {
    const lede = page.locator(".map-lede");
    expect(await lede.isVisible()).toBe(true);
    const box = await lede.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeGreaterThan(1);
    expect(box?.height).toBeGreaterThan(1);
    const copy = await lede.innerText();
    expect(copy).toContain("Builders share a map of their Claude Code and Codex use");
    expect(copy).toContain("7 days by default");
    expect(copy).toContain("90");
    expect(copy).toContain("--days");
  } finally { await context.close(); }
});

test("[integration] board lede shows how to add a map", async () => {
  const { page, context } = await open(`${origin}/maps/`);
  try {
    const lede = page.locator(".map-lede");
    expect(await lede.isVisible()).toBe(true);
    const copy = await lede.innerText();
    expect(copy).toContain("--share");
    expect(copy).toContain("open the link it prints");
    expect(await lede.locator('a[href="/tm/"]').isVisible()).toBe(true);
  } finally { await context.close(); }
});

test("[unit] M0 the share link is built by the mapper's own shareLink against SHARE_BASE", () => {
  expect(SHARE_BASE).toBe("https://jevnotjev.breakoutwithai.com/maps/");
  expect(link().startsWith(`${origin}/maps/#m=`)).toBe(true);
});

test("[integration] M0b the board link on an invalid share opens the visible board", async () => {
  const { page, context } = await open(`${origin}/maps/#m=invalid`);
  try {
    expect(await page.locator("#mapInvalid").isVisible()).toBe(true);
    const boardLink = page.locator("#mapInvalid a[href='/maps/']");
    expect(await boardLink.isVisible()).toBe(true);
    expect((await boardLink.innerText()).trim()).toBe("open the board");
    await boardLink.click();
    await page.locator("#mapBoardSection").waitFor({ state: "visible" });
    expect(new URL(page.url()).hash).toBe("");
    expect(await page.locator("#mapBoardSection").isVisible()).toBe(true);
  } finally { await context.close(); }
});

test("[integration] M-null weekly usage distinguishes an unread Codex log from a missing weekly snapshot", async () => {
  rows = [
    boardRow("TM-0000000000A1", "codex-read", { ...PAYLOAD, codex_weekly_pct: null }),
    boardRow("TM-0000000000A2", "codex-unread", { ...PAYLOAD, sources: "claude", codex_weekly_pct: null }),
  ];
  const { page, context } = await open(`${origin}/maps/`);
  try {
    const read = page.locator('[data-map-id="TM-0000000000A1"]');
    const unread = page.locator('[data-map-id="TM-0000000000A2"]');
    await unread.waitFor({ state: "visible" });
    const weekly = (row: typeof read) => row.locator(".map-fig").filter({ has: page.locator("dt", { hasText: "Codex weekly used" }) }).locator("dd");
    expect(await weekly(read).innerText()).toBe("not in the logs");
    expect(await weekly(unread).innerText()).toBe("not collected");
    expect(await read.isVisible()).toBe(true);
    expect(await unread.isVisible()).toBe(true);
  } finally { await context.close(); }
});

test("[integration] M-null a shared Codex log without weekly usage shows not in the logs in the preview", async () => {
  const payload = { ...PAYLOAD, codex_weekly_pct: null };
  const { page, context } = await open(shareLink(payload, `${origin}/maps/`));
  try {
    await page.locator("#mapShare").waitFor();
    const weekly = page.locator('#mapPreview [data-field="codex_weekly_pct"]');
    expect(await weekly.isVisible()).toBe(true);
    expect((await weekly.innerText()).trim()).toBe("not in the logs");
  } finally { await context.close(); }
});

test("[integration] 1 a valid link shows every payload field with its value and a prefilled alias", async () => {
  const { page, context } = await open(link());
  try {
    await page.locator("#mapShare").waitFor();
    expect(await page.locator("#mapPreview").innerText()).toContain("Review these fields");
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
    expect(await page.locator("#mapPreview button").count()).toBe(2);
    expect(await page.locator("label[for=mapAlias]").innerText()).toContain("Alias on the board");
    expect(await page.locator("#mapAlias").inputValue()).toMatch(/^builder-[a-z0-9]{4}$/);
    expect(await page.locator("#mapPreview").innerText()).toContain("Nothing has been sent yet.");
    expect(await page.locator("button#mapShare[type=button]").innerText()).toBe("Share");
  } finally { await context.close(); }
});

test("[integration] 10c pasted skill is named in the detail card while mapper skill keeps its version", async () => {
  const cases: readonly (readonly [string, string])[] = [["0.0.0", "pasted block"], ["0.3.0", "0.3.0"]];
  for (const [skill, shown] of cases) {
    const { page, context } = await open(fragment(JSON.stringify({ ...PAYLOAD, skill })));
    try {
      const cell = page.locator('#mapFields [data-field="skill"]');
      await cell.waitFor();
      expect(await cell.getAttribute("data-value")).toBe(skill);
      expect((await cell.innerText()).trim()).toBe(shown);
    } finally { await context.close(); }
  }
});

test("[integration] VP-5 own card sends usage privately and shows a status receipt", async () => {
  const { page, context } = await open(link());
  try {
    expect(await page.locator("#mapPrivateForm").isVisible()).toBe(true);
    await page.locator("#mapPrivateEmail").fill("visitor@example.test");
    await page.locator("#mapPrivateConsent").check();
    await page.locator("#mapPrivateSend").dblclick();
    await page.locator("#mapPrivateReceipt").waitFor({ state: "visible" });
    const privatePosts = posts("/api/questions");
    expect(privatePosts).toHaveLength(1);
    expect(posts("/api/maps")).toHaveLength(0);
    if (!isRec(privatePosts[0]?.body)) throw new Error("missing private body");
    expect(privatePosts[0].body.usage).toEqual(PAYLOAD);
    expect(privatePosts[0].body.question).toBe("Please review my TokenMax usage.");
    expect(privatePosts[0].body.reply_consent).toBe(true);
    expect(privatePosts[0].body.request_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await page.locator("#mapPrivateRef").innerText()).toMatch(/^Q-/);
    expect(await page.locator("#mapPrivateCode").innerText()).toMatch(/^Q-[0-9A-F]{12}\.[A-Za-z0-9_-]{43}$/);
    expect(await page.locator("#mapPrivateCopy").isVisible()).toBe(true);
    expect(await page.locator("#mapPrivateReceipt a").getAttribute("href")).toBe("/ask/#status");
  } finally { await context.close(); }
});

test("[integration] VP-6 sample and invalid fragments expose no sharing forms", async () => {
  for (const url of [link() + "&sample", fragment("{}")]) {
    const { page, context } = await open(url);
    try {
      if (url.includes("&sample")) expect(await page.locator("#mapSampleLabel").isVisible()).toBe(true);
      expect(await page.locator("#mapShare").isVisible()).toBe(false);
      expect(await page.locator("#mapPrivateForm").isVisible()).toBe(false);
    } finally { await context.close(); }
  }
});

test("[integration] VP-5 private retry keeps its key after a network error", async () => {
  const { page, context } = await open(link());
  const attempts: Rec[] = [];
  try {
    await page.route("**/api/questions", async (route) => {
      const body: unknown = route.request().postDataJSON();
      if (isRec(body)) attempts.push(body);
      if (attempts.length === 1) await route.abort();
      else await route.continue();
    });
    await page.locator("#mapPrivateEmail").fill("retry@example.test");
    await page.locator("#mapPrivateConsent").check();
    await page.locator("#mapPrivateSend").click();
    await page.locator("#mapPrivateError").waitFor({ state: "visible" });
    expect(await page.locator("#mapPrivateReceipt").isVisible()).toBe(false);
    await page.locator("#mapPrivateSend").click();
    await page.locator("#mapPrivateReceipt").waitFor({ state: "visible" });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.request_key).toBe(attempts[1]?.request_key);
  } finally { await context.close(); }
});

test("[integration] VP-5 private send stays disabled while its request is in flight", async () => {
  const { page, context } = await open(link());
  let release = () => {};
  const gate = new Promise<void>((done) => { release = done; });
  const attempts: string[] = [];
  try {
    await page.route("**/api/questions", async (route) => {
      attempts.push(route.request().url());
      await gate;
      await route.continue();
    });
    await page.locator("#mapPrivateEmail").fill("wait@example.test");
    await page.locator("#mapPrivateConsent").check();
    await page.locator("#mapPrivateSend").dblclick();
    expect(await page.locator("#mapPrivateSend").isDisabled()).toBe(true);
    expect(attempts).toHaveLength(1);
    release();
    await page.locator("#mapPrivateReceipt").waitFor({ state: "visible" });
  } finally { release(); await context.close(); }
});

test("[integration] VP-5 private refusal statuses show a plain error and no receipt", async () => {
  const messages: [number, string][] = [
    [400, "The usage or note was refused. Check the fields and try again."],
    [409, "That attempt was already used for different details. Press send again for a new attempt."],
    [410, "That question was deleted. Press send again as a new question."],
    [413, "Your message is too large. Shorten the note and send again."],
    [429, "Too many tries from this network. Wait ten minutes and try again."],
    [503, "Questions are unavailable right now. Try again later."],
  ];
  for (const [status, message] of messages) {
    privateReply = { status, body: { code: "refused" } };
    const { page, context } = await open(link());
    try {
      await page.locator("#mapPrivateEmail").fill("refused@example.test");
      await page.locator("#mapPrivateConsent").check();
      await page.locator("#mapPrivateSend").click();
      await page.locator("#mapPrivateError").waitFor({ state: "visible" });
      expect(await page.locator("#mapPrivateError").innerText()).toBe(message);
      expect(await page.locator("#mapPrivateReceipt").isVisible()).toBe(false);
      expect(posts("/api/maps")).toHaveLength(0);
    } finally { await context.close(); }
  }
});

test("[integration] VP-5 a trapped private send receives the neutral accepted message", async () => {
  privateReply = { status: 200, body: { ok: true } };
  const { page, context } = await open(link());
  try {
    await page.locator("#mapPrivateEmail").fill("visitor@example.test");
    await page.locator("#mapPrivateConsent").check();
    await page.locator("#mapPrivateSend").click();
    await page.locator("#mapPrivateError").waitFor({ state: "visible" });
    expect(await page.locator("#mapPrivateError").innerText()).toBe("Thanks. Your question was not stored; reload the page if you meant to send it.");
    expect(await page.locator("#mapPrivateReceipt").isVisible()).toBe(false);
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
    const alert = page.locator("#mapAlert");
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
    expect(totalsText).toContain("4 cap hits");
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
      for (const word of ["2026-10-16", "sessions", "cap hits short / weekly / unknown", "claude output", "codex output", "opus share", "codex weekly"]) expect(text.toLowerCase()).toContain(word);
    }
    // Output tokens in compact form; the exact count stays in the title.
    expect(first).toContain("1.2M");
    expect(await rowsShown.nth(0).locator('[title="1,234,567 output tokens"]').count()).toBe(1);
    expect(second.replace(/\s+/g, " ")).toContain("0 / 0 / 1");
    expect(second).toContain("not in the logs");
    expect(second).not.toContain("none read");
  } finally { await context.close(); }
});

test("[integration] 10b a row from a pasted /tm/ block (skill 0.0.0) says so, and a mapper row keeps the mapper caption", async () => {
  rows = [boardRow("TM-0000000000B3", "pasted-one", { ...PAYLOAD, skill: "0.0.0" }), OTHER];
  const { page, context } = await open(`${origin}/maps/`);
  try {
    await page.locator("#mapBoard .map-row").nth(1).waitFor();
    const rowsShown = page.locator("#mapBoard .map-row");
    const pasted = await rowsShown.nth(0).locator(".map-row-label").innerText();
    expect(pasted).toBe("self-reported from a pasted TokenMax block, not verified");
    expect(pasted).not.toContain("tokenmax-map");
    expect(await rowsShown.nth(1).locator(".map-row-label").innerText()).toBe("self-reported by tokenmax-map 0.3.0, not verified");
  } finally { await context.close(); }
});

test("[integration] 10e server data with markup renders as text: no element is created and no handler runs", async () => {
  const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  rows = [boardRow("TM-0000000000E5", hostile, { ...PAYLOAD, skill: '0.3.0<b id="inj">x</b>' }), OTHER];
  const { page, context } = await open(`${origin}/maps/`);
  try {
    await page.locator("#mapBoard .map-row").nth(1).waitFor();
    await page.waitForTimeout(200);
    expect((await page.locator("#mapBoard .map-row-alias").first().innerText()).trim()).toBe(hostile);
    expect(await page.locator("#mapBoard .map-row-label").first().innerText()).toContain('0.3.0<b id="inj">x</b>');
    expect(await page.locator("#mapBoard img, #mapBoard script, #inj").count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, "__pwned") ?? null)).toBeNull();
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
    expect(await page.locator("#mapAlert").innerText()).toContain("No row matches this delete link");
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
    expect(await page.locator("#mapAlert").innerText()).toBe("");
  } finally { await context.close(); }
});

test("[integration] 13b an unreadable success (no id, or not JSON) is a retryable failure: the alias locks and the retry repeats key and alias", async () => {
  for (const reply of [{ status: 200, body: "{}" }, { status: 200, body: "<html>proxy page</html>" }]) {
    seen.length = 0;
    rows = [OTHER];
    const { page, context } = await open(link());
    try {
      const sent: { key: unknown; alias: unknown }[] = [];
      await page.route("**/api/maps", (route) => {
        const b: unknown = route.request().postDataJSON();
        sent.push({ key: isRec(b) ? b.request_key : null, alias: isRec(b) ? b.alias : null });
        return sent.length === 1 ? route.fulfill({ status: reply.status, contentType: "application/json", body: reply.body }) : route.continue();
      });
      await page.locator("#mapShare").click();
      await page.waitForFunction(() => (document.querySelector("[role=alert]")?.textContent ?? "").length > 0, null, { timeout: 5000 });
      expect(await page.locator("#mapAlert").innerText(), reply.body).toContain("Not shared");
      expect(await page.locator("#mapShare").isEnabled(), reply.body).toBe(true);
      expect(await page.locator("#mapPreview").isVisible(), reply.body).toBe(true);
      expect(await page.locator("#mapAlias").isEditable(), reply.body).toBe(false);
      await page.locator("#mapShare").click();
      await page.locator("#mapBoard .map-row.mine").waitFor();
      expect(sent.length).toBe(2);
      expect(sent[1]).toEqual(sent[0]);
    } finally { await context.close(); }
  }
}, 30000);

test("[integration] 13c only the honeypot answer reads as received with nothing added", async () => {
  postReply = { status: 200, body: { ok: true } };
  const { page, context } = await open(link());
  try {
    await page.locator("#mapShare").click();
    await page.waitForFunction(() => (document.getElementById("mapStatus")?.textContent ?? "").length > 0);
    expect(await page.locator("#mapStatus").innerText()).toBe("Received. Nothing was added to the board.");
    expect(await page.locator("#mapAlert").innerText()).toBe("");
  } finally { await context.close(); }
});

test("[integration] 13d after a failed POST the not-sent line is gone and focus is on Share; a definite refusal keeps the alias editable; after success focus is on the delete link", async () => {
  postReply = { status: 400, body: { code: "bad-alias", field: "alias", reason: "alias taken by the test" } };
  const { page, context } = await open(link());
  try {
    expect(await page.locator("#mapNotSent").isVisible()).toBe(true);
    await page.locator("#mapShare").click();
    await page.waitForFunction(() => (document.querySelector("[role=alert]")?.textContent ?? "").length > 0);
    expect(await page.locator("#mapNotSent").isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("mapShare");
    expect(await page.locator("#mapAlias").isEditable()).toBe(true);
    postReply = null;
    await page.locator("#mapShare").click();
    await page.locator("#mapBoard .map-row.mine").waitFor();
    expect(await page.evaluate(() => document.activeElement?.closest("#mapDeleteLink") !== null && document.activeElement?.tagName === "A")).toBe(true);
  } finally { await context.close(); }
});

test("[integration] 13e the honeypot field's name and id carry no word a browser autofills", async () => {
  const { page, context } = await open(link());
  try {
    const traps = await page.locator(".map-honey input").evaluateAll((nodes) => nodes.map((n) => ({ name: n.getAttribute("name") ?? "", id: n.id })));
    expect(traps).toHaveLength(2);
    for (const trap of traps) {
      expect(trap.name.length).toBeGreaterThan(0);
      expect(`${trap.name} ${trap.id}`).not.toMatch(/name|nick|mail|phone|user|address/i);
    }
  } finally { await context.close(); }
});

/** The command the page shows, run for real: the served mapper piped to `bun run -` against a synthetic Claude history. Returns the link it prints. */
async function runServedMapper(): Promise<string> {
  const served = await (await fetch(`${origin}/tm/map.ts`)).text();
  const claude = mkdtempSync(join(tmpdir(), "tmx-journey-claude-"));
  const project = join(claude, "-Users-x-projects-alpha");
  mkdirSync(project, { recursive: true });
  const usage = { input_tokens: 10, output_tokens: 5 };
  writeFileSync(join(project, "s-1.jsonl"), [
    JSON.stringify({ type: "assistant", sessionId: "s-1", uuid: "u-1", timestamp: "2026-10-14T09:00:00Z", cwd: "/x/alpha", message: { id: "m1", model: "claude-opus-5-5", usage } }),
    JSON.stringify({ type: "assistant", sessionId: "s-1", uuid: "u-2", timestamp: "2026-10-14T09:10:00Z", isApiErrorMessage: true, error: "rate_limit", message: { id: "x", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 2pm (Europe/Warsaw)" }] } }),
  ].join("\n"));
  const proc = Bun.spawn(["bun", "run", "-", "--share", "--claude", claude, "--codex", "none", "--out", join(mkdtempSync(join(tmpdir(), "tmx-journey-out-")), "r"), "--now", "2026-10-16T12:00:00Z"], {
    stdin: new TextEncoder().encode(served), stdout: "pipe", stderr: "pipe", cwd: mkdtempSync(join(tmpdir(), "tmx-journey-cwd-")),
  });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  const printed = stdout.split("\n").find((line) => line.startsWith(`${SHARE_BASE}#m=`));
  if (!printed) throw new Error(`the served mapper printed no share link:\n${stdout}`);
  return `${origin}/maps/${printed.slice(SHARE_BASE.length)}`;
}

test("[integration] 12 M1 landing to own row on the board in four actions or fewer, with the real served mapper as the terminal step", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  landingStripShown = true;
  const page = await context.newPage();
  await page.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  let actions = 0;
  try {
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#tmCopy").click(); actions += 1;
    expect(await page.locator("#tmCommand").innerText()).toBe(COMMAND);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COMMAND);
    // Action 2: paste into a terminal. The copied command's script is fetched from the served site and run for real.
    actions += 1;
    const printed = await runServedMapper();
    await page.goto(printed, { waitUntil: "load" }); actions += 1;
    expect(await page.locator("#mapAlias").inputValue()).toMatch(/^builder-[a-z0-9]{4}$/);
    expect(await page.locator('#mapFields [data-field="sessions"]').getAttribute("data-value")).toBe("1");
    expect(await page.locator('#mapFields [data-field="caps.short"]').getAttribute("data-value")).toBe("1");
    await page.locator("#mapShare").click(); actions += 1;
    await page.locator("#mapBoard .map-row.mine").waitFor();
    console.log(`M1 actions=${actions}`);
    expect(actions).toBeLessThanOrEqual(4);
  } finally { await context.close(); }
}, 60000);

// #238 pass 2: one name for the cap event everywhere, "cap hits"; the trust line on the share card; tap targets.
const TRUST_LINE = "Runs on your machine. Nothing sent until you choose a send button.";

test("[integration] 14 the cap event is called cap hits everywhere: the meta description, the share card, the board and the shipped files say cap hits and never cap episode; share labels carry no trailing punctuation", async () => {
  for (const file of ["index.html", "maps.js"]) expect({ file, episode: /cap episode/i.test(readFileSync(join(SITE, "maps", file), "utf8")) }).toEqual({ file, episode: false });
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    rows = THREE();
    const { page, context } = await open(link(), width, height);
    try {
      await page.locator("#mapShare").waitFor();
      const meta = await page.locator('meta[name="description"]').getAttribute("content") ?? "";
      expect({ width, hits: meta.includes("cap hits"), episode: /episode/i.test(meta) }).toEqual({ width, hits: true, episode: false });
      const share = await page.locator("#mapFields").evaluate((root) => Array.from(root.querySelectorAll("dt")).map((dt) => (dt.textContent ?? "").trim()));
      expect({ width, cap: share.filter((label) => /^cap/i.test(label)) }).toEqual({ width, cap: ["Cap hits, short / weekly / unknown"] });
      expect({ width, trailing: share.filter((label) => /[.:,;]$/.test(label)) }).toEqual({ width, trailing: [] });
      await page.locator("#mapShare").click();
      await page.locator("#mapBoard .map-row.mine").waitFor();
      const seenText = await page.evaluate(() => ({ text: document.body.innerText, html: document.documentElement.outerHTML }));
      expect({ width, text: /cap episode/i.test(seenText.text), html: /cap episode/i.test(seenText.html), tile: /\bcap hits?\b/.test(seenText.text) }).toEqual({ width, text: false, html: false, tile: true });
      expect({ width, rowLabel: (await page.locator("#mapBoard .map-row").first().innerText()).toLowerCase().includes("cap hits short / weekly / unknown") }).toEqual({ width, rowLabel: true });
    } finally { await context.close(); }
  }
}, 30000);

test("[integration] 15 the share card shows the trust line at 390 and 1440, on the first screen, before Share", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    const { page, context } = await open(link(), width, height);
    try {
      await page.locator("#mapShare").waitFor();
      const trust = await page.locator("#mapTrust").evaluate((node) => {
        const r = node.getBoundingClientRect(), s = getComputedStyle(node);
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { text: (node.textContent ?? "").trim(), inCard: Boolean(document.getElementById("mapPreview")?.contains(node)),
          shown: s.display !== "none" && s.visibility === "visible" && r.width > 0 && r.height > 0, inView: r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
          size: parseFloat(s.fontSize) >= 13, hit: hit === node || node.contains(hit) };
      });
      expect({ width, ...trust, sent: posts().length }).toEqual({ width, text: TRUST_LINE, inCard: true, shown: true, inView: true, size: true, hit: true, sent: 0 });
    } finally { await context.close(); }
  }
}, 30000);

test("[integration] 16 every visible link and button is at least 24x24 px with text at least 13 px: share card, after Share, board, delete and not-a-map views at 390 and 1440", async () => {
  const views: [string, () => string, (page: Page) => Promise<void>][] = [
    ["share", link, async (page) => { await page.locator("#mapShare").waitFor(); }],
    ["shared", link, async (page) => { await page.locator("#mapShare").click(); await page.locator("#mapDeleteLink a").waitFor(); }],
    ["board", () => `${origin}/maps/`, async (page) => { await page.locator("#mapBoard .map-row").first().waitFor(); }],
    ["delete", () => `${origin}/maps/#delete=TM-00000000BEEF.${"A".repeat(43)}`, async (page) => { await page.locator("#mapDeleteRow").waitFor(); }],
    ["invalid", () => fragment("{}"), async (page) => { await page.locator("#mapInvalid a").waitFor(); }],
  ];
  for (const [width, height] of [[390, 844], [1440, 900]]) for (const [name, url, ready] of views) {
    rows = [OTHER];
    const { page, context } = await open(url(), width, height);
    try {
      await ready(page);
      const controls = await page.evaluate(() => Array.from(document.querySelectorAll("a, button")).filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden";
      }).map((n) => {
        const r = n.getBoundingClientRect();
        return { name: n.id || (n.textContent ?? "").trim().slice(0, 24), w: r.width >= 24, h: r.height >= 24, text: parseFloat(getComputedStyle(n).fontSize) >= 13 };
      }));
      expect({ width, name, some: controls.length > 0, bad: controls.filter((c) => !c.w || !c.h || !c.text) }).toEqual({ width, name, some: true, bad: [] });
    } finally { await context.close(); }
  }
}, 60000);

// #242: source coverage governs visible and accessible measurements; defaults remain in the wire payload.
for (const fixture of [
  { name: "Claude only", sources: "claude", claude: 1200, codex: 0, shown: ["1,200", "not collected"], board: ["1.2K", "not collected"] },
  { name: "Codex only", sources: "codex", claude: 0, codex: 2400, shown: ["not collected", "2,400"], board: ["not collected", "2.4K"] },
  { name: "collected zero", sources: "claude+codex", claude: 0, codex: 0, shown: ["0", "0"], board: ["0", "0"] },
  { name: "both nonzero", sources: "claude+codex", claude: 1200, codex: 2400, shown: ["1,200", "2,400"], board: ["1.2K", "2.4K"] },
]) test(`[integration] #242 ${fixture.name}: preview and board preserve coverage, accessibility and payload`, async () => {
  const payload = { ...PAYLOAD, sources: fixture.sources, output_tokens: { claude: fixture.claude, codex: fixture.codex } };
  const { page, context } = await open(fragment(JSON.stringify(payload)));
  try {
    for (const [i, provider] of ["claude", "codex"].entries()) {
      const leaf = page.locator(`[data-field="output_tokens.${provider}"]`);
      expect(await leaf.innerText()).toBe(fixture.shown[i] ?? "missing expectation");
      expect(await leaf.ariaSnapshot()).toContain(fixture.shown[i] ?? "missing expectation");
      expect(await leaf.getAttribute("data-value")).toBe(String(provider === "claude" ? fixture.claude : fixture.codex));
    }
    expect(await page.locator('[data-field="opus_share_pct"]').innerText()).toBe(fixture.sources === "codex" ? "not collected" : "61");
    expect(await page.locator('[data-field="codex_weekly_pct"]').innerText()).toBe(fixture.sources === "claude" ? "not collected" : "37");
    expect(posts()).toHaveLength(0);
    await page.locator("#mapShare").click();
    const row = page.locator('[data-map-id="TM-00000000BEEF"]');
    await row.waitFor({ timeout: 3000 });
    for (const [i, provider] of ["Claude", "Codex"].entries()) {
      const figure = row.locator(".map-fig").filter({ has: page.locator("dt", { hasText: `${provider} output` }) }).locator("dd");
      expect(await figure.innerText()).toBe(fixture.board[i] ?? "missing expectation");
      expect(await figure.ariaSnapshot()).toContain(fixture.board[i] ?? "missing expectation");
      if (fixture.board[i] === "not collected") expect(await figure.getAttribute("title")).toBeNull();
    }
    expect(await page.locator("#mapBoard .map-row").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-map-id")))).toEqual(rows.map(r => r.id));
    const sent = posts()[0]?.body;
    expect(isRec(sent) ? sent.payload : null).toEqual(payload);
    expect(await page.locator('[data-total="builders"] .map-tile-figure').innerText()).toBe("2");
  } finally { await context.close(); }
});

test("[integration] #242 malformed sources fail preview and board instead of inventing measurements", async () => {
  for (const sources of ["", "claude,codex", ["claude"], null]) {
    const { page, context } = await open(fragment(JSON.stringify({ ...PAYLOAD, sources })));
    try {
      expect(await page.locator("#mapInvalid").isVisible()).toBe(true);
      expect(await page.locator("#mapShare").isVisible()).toBe(false);
      expect(apiSeen()).toHaveLength(0);
      rows = [boardRow("TM-0000000000A1", "builder-test", { ...PAYLOAD, sources })];
      await page.goto(`${origin}/maps/`);
      await page.waitForFunction(() => Boolean(document.querySelector("#mapAlert")?.textContent) || !document.querySelector("#mapBoardSection")?.hasAttribute("hidden"));
      expect(await page.locator("#mapAlert").innerText()).toContain("not available");
      expect(await page.locator("#mapBoardSection").isVisible()).toBe(false);
    } finally { await context.close(); seen.length = 0; }
  }
});

test("[integration] #242 only a valid empty board exposes an explicit empty state; HTTP, JSON and schema errors fail", async () => {
  rows = [];
  const { page, context } = await open(`${origin}/maps/`);
  try {
    await page.locator("#mapBoardSection").waitFor();
    expect(await page.locator("#mapEmpty").innerText()).toContain("No maps shared yet");
    expect(await page.locator("#mapBoard .map-row").count()).toBe(0);
    expect(await page.locator("#mapAlert").innerText()).toBe("");
    for (const reply of [
      { status: 503, body: "{}" }, { status: 200, body: "not JSON" }, { status: 200, body: "{}" },
      { status: 200, body: JSON.stringify({ rows: [], totals: { builders: 1, cap_episodes: 0, with_weekly_cap: 0 } }) },
      { status: 200, body: JSON.stringify({ rows: [null], totals: { builders: 1, cap_episodes: 0, with_weekly_cap: 0 } }) },
    ]) {
      await page.route("**/api/maps", route => route.fulfill({ ...reply, contentType: "application/json" }));
      await page.reload();
      await page.waitForFunction(() => Boolean(document.querySelector("#mapAlert")?.textContent) || !document.querySelector("#mapBoardSection")?.hasAttribute("hidden"));
      expect(await page.locator("#mapAlert").innerText()).toContain("not available");
      expect(await page.locator("#mapBoardSection").isVisible()).toBe(false);
      expect(await page.locator("#mapEmpty").isVisible()).toBe(false);
      await page.unroute("**/api/maps");
    }
  } finally { await context.close(); }
});

async function keyboardFollow(page: Page, selector: string): Promise<void> {
  const control = page.locator(selector);
  expect(await control.isVisible()).toBe(true);
  // Traverse the real tab order, including the story's skip links and fixed Copy ticket.
  for (let step = 0; step < 50; step++) {
    await page.keyboard.press("Tab");
    if (await control.evaluate(n => n === document.activeElement)) break;
  }
  expect(await control.evaluate(n => {
    const r = n.getBoundingClientRect(), s = getComputedStyle(n);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return n === document.activeElement && s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && (hit === n || n.contains(hit));
  })).toBe(true);
  await Promise.all([page.waitForNavigation({ waitUntil: "load", timeout: 3000 }), page.keyboard.press("Enter")]);
}

async function followExplanation(page: Page, capture = false): Promise<void> {
  const unsafe: string[] = [];
  const track = (request: import("playwright-core").Request) => { if (request.method() !== "GET" || /\/backstage\/|api\.typesafe\.ai|api\.anthropic\.com|api\.openai\.com/.test(request.url())) unsafe.push(request.method() + " " + request.url()); };
  page.on("request", track);
  try {
    await keyboardFollow(page, "#tokenmaxGuide");
    expect(new URL(page.url()).pathname + new URL(page.url()).hash).toBe("/guide/#tokenmax");
    const explanation = page.locator("#tokenmax");
    expect(await explanation.isVisible()).toBe(true);
    const text = await explanation.innerText();
    for (const meaning of ["TokenMax", "self-reported", "not collected", "not in the logs", "labelled evidence", "optional"]) expect(text).toContain(meaning);
    expect(await explanation.locator('a[href="/maps/"]').isVisible()).toBe(true);
    const artifacts = process.env.JNJ_JOURNEY_ARTIFACTS;
    if (artifacts && capture) { mkdirSync(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, `guide-${page.viewportSize()?.width}.png`) }); }
    await keyboardFollow(page, '#tokenmax a[href="/replay/?run=uc13-100"]');
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe("/replay/?run=uc13-100");
    await page.locator("#headline").filter({ hasText: /.+/ }).waitFor({ timeout: 3000 });
    expect((await page.locator("#arms").innerText()).length).toBeGreaterThan(0);
    const before = await page.locator("#counter").innerText();
    await page.getByRole("button", { name: "Next case", exact: true }).click();
    expect(await page.locator("#counter").innerText()).not.toBe(before);
    expect(unsafe).toEqual([]);
  } finally { page.off("request", track); }
}

test("[integration] #258 both origins navigate by keyboard to explanation and anonymous recorded sample at 390 and 1440", async () => {
  for (const motion of ["reduce", "no-preference"] satisfies ("reduce" | "no-preference")[]) for (const width of [390, 1440]) for (const path of ["/maps/", "/tm/"]) {
    const { page, context } = await open(`${origin}${path}`, width, 900, motion);
    const unsafe: string[] = [];
    await page.route("**/*", route => {
      const req = route.request();
      if (!req.url().startsWith(`${origin}/`)) return route.abort();
      if (req.method() !== "GET" || new URL(req.url()).pathname.startsWith("/backstage")) { unsafe.push(req.method() + " " + req.url()); return route.abort(); }
      return route.continue();
    });
    try {
      const artifacts = process.env.JNJ_JOURNEY_ARTIFACTS;
      if (artifacts && motion === "reduce") { mkdirSync(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, `${path.slice(1, -1)}-${width}.png`) }); }
      await followExplanation(page, true);
      if (artifacts && motion === "reduce") await page.screenshot({ path: join(artifacts, `${path.slice(1, -1)}-replay-${width}.png`) });
      expect(unsafe).toEqual([]);
      expect(posts()).toHaveLength(0);
      await page.goto(`${origin}/guide/#tokenmax`);
      await keyboardFollow(page, '#tokenmax a[href="/maps/"]');
      expect(new URL(page.url()).pathname).toBe("/maps/");
      await page.locator("#mapBoardSection").waitFor();
    } finally { await context.close(); }
  }
}, 60000);

test("[integration] #258 navigation assertions reject self-loop, 404, unrelated, hidden/offscreen, absent focus, dead-end and mutating variants", async () => {
  for (const variant of ["self", "404", "unrelated", "hidden", "offscreen", "no-focus", "dead-end", "mutation"]) {
    const { page, context } = await open(`${origin}/maps/`);
    page.setDefaultTimeout(2000);
    try {
      if (variant === "dead-end") await page.route("**/guide/", async route => route.fulfill({ contentType: "text/html", body: (await Bun.file(join(SITE, "guide/index.html")).text()).replace('href="/replay/?run=uc13-100"', 'href="/guide/#tokenmax"') }));
      if (variant === "mutation") await page.route("**/guide/", async route => route.fulfill({ contentType: "text/html", body: (await Bun.file(join(SITE, "guide/index.html")).text()) + '<script>fetch("/api/maps",{method:"POST",body:"{}"})</script>' }));
      if (["self", "404", "unrelated"].includes(variant)) await page.locator("#tokenmaxGuide").evaluate((n, href) => n.setAttribute("href", href), variant === "self" ? "/maps/" : variant === "404" ? "/missing/" : "/privacy/");
      if (variant === "hidden") await page.locator("#tokenmaxGuide").evaluate(n => n.setAttribute("style", "display:none"));
      if (variant === "offscreen") await page.locator("#tokenmaxGuide").evaluate(n => n.setAttribute("style", "position:fixed;left:-10000px"));
      if (variant === "no-focus") await page.locator("#tokenmaxGuide").evaluate(n => n.setAttribute("style", "outline:none"));
      let rejected = false;
      try { await followExplanation(page); } catch { rejected = true; }
      expect({ variant, rejected }).toEqual({ variant, rejected: true });
    } finally { await context.close(); }
  }
}, 30000);

test("[integration] #242 a stored share with an unreadable returned board retains its delete link and explains the display failure", async () => {
  postReply = { status: 200, body: { id: "TM-00000000BEEF", delete: `/maps/#delete=TM-00000000BEEF.${"A".repeat(43)}`, board: {} } };
  const { page, context } = await open(link());
  try {
    await page.locator("#mapShare").click();
    await page.locator("#mapShared").waitFor();
    expect(await page.locator("#mapStatus").innerText()).toContain("board could not be displayed");
    expect(await page.locator("#mapDeleteLink a").getAttribute("href")).toContain("#delete=TM-00000000BEEF");
    expect(await page.locator("#mapBoardSection").isVisible()).toBe(false);
    expect(posts()).toHaveLength(1);
  } finally { await context.close(); }
});
