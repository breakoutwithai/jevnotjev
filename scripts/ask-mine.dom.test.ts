import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHandler } from "../src/backstage/server.ts";
import { resolveChromium } from "./uat/happy-path-lib.ts";

// The page and its script run in a real browser against the real static handler. The visitor API is a scripted
// stand-in that follows the #307 contract, so these tests check what the page sends and how it renders what comes back.

const SITE = join(import.meta.dir, "..", "site");
const HOSTILE = "<img src=x onerror=alert(1)>";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

interface FakeQuestion { id: string; state: string; created_at: number; updated_at: number; question: string; response: string | null; response_source: string | null }
interface Fake {
  signedIn: boolean;
  email: string;
  canAsk: boolean;
  reason: "one-question" | "free-slots-used" | null;
  waitlistPosition: number | null;
  questions: FakeQuestion[];
  submitStatus: number;
  submitBody: Record<string, unknown>;
}

const fake: Fake = { signedIn: false, email: "", canAsk: false, reason: null, waitlistPosition: null, questions: [], submitStatus: 200, submitBody: {} };
const posts: { path: string; contentType: string | null; body: unknown }[] = [];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let handler: ReturnType<typeof createHandler>;

function reset(patch: Partial<Fake>): void {
  Object.assign(fake, { signedIn: false, email: "", canAsk: false, reason: null, waitlistPosition: null, questions: [], submitStatus: 200, submitBody: { id: "Q-0123456789AB", state: "pending_review", replay: false } }, patch);
  posts.length = 0;
}

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/v1/visitor/")) {
        if (request.method === "POST") {
          const text = await request.text();
          let body: unknown = text;
          try { body = JSON.parse(text); } catch { body = text; }
          posts.push({ path, contentType: request.headers.get("content-type"), body });
          if (path.endsWith("/sign-out")) { fake.signedIn = false; return new Response(null, { status: 204 }); }
          return Response.json(fake.submitBody, { status: fake.submitStatus });
        }
        if (!fake.signedIn) return Response.json({ code: "unauthenticated" }, { status: 401 });
        if (path.endsWith("/me")) return Response.json({ email: fake.email, can_ask: fake.canAsk, reason: fake.reason, waitlist_position: fake.waitlistPosition });
        return Response.json({ questions: fake.questions });
      }
      return handler(request, { remoteAddress: "198.51.100.7" });
    },
  });
  handler = createHandler({ version: "test", origin: server.url.origin, staticRoot: SITE, log: () => {} });
  browser = await chromium.launch({ executablePath: found.path });
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  handler?.close();
});

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${server.url.origin}/ask/mine/`);
  return page;
}

const answered: FakeQuestion = { id: "Q-AAAAAAAAAAAA", state: "answered", created_at: 1_760_000_000_000, updated_at: 1_760_000_500_000, question: "Route shop questions to stock help or general help?", response: "State it as a fixed choice with two answers.", response_source: "human_reviewed" };

describe("my questions page", () => {
  test("[integration] VM-1 signed out shows the Google link and no form", async () => {
    reset({});
    const page = await open();
    try {
      await page.locator("#mineSignedOut").waitFor({ state: "visible" });
      const link = page.locator("#mineGoogle");
      expect(await link.innerText()).toBe("Continue with Google");
      expect(await link.getAttribute("href")).toBe("/api/auth/google");
      expect(await page.locator("#mineForm").isVisible()).toBe(false);
      expect(await page.locator("#mineSignedIn").isVisible()).toBe(false);
    } finally { await page.close(); }
  });

  test("[integration] VM-2 signed in lists own questions with state and reply, and shows the form when can_ask", async () => {
    reset({ signedIn: true, email: "visitor@example.test", canAsk: false, reason: "one-question", questions: [answered] });
    const page = await open();
    try {
      await page.locator("#mineSignedIn").waitFor({ state: "visible" });
      expect(await page.locator("#mineEmail").innerText()).toBe("visitor@example.test");
      const card = page.locator("#mineList article");
      expect(await card.count()).toBe(1);
      const text = await card.innerText();
      expect(text).toContain("Q-AAAAAAAAAAAA");
      expect(text).toContain("answered");
      expect(text).toContain("Route shop questions to stock help or general help?");
      expect(text).toContain("State it as a fixed choice with two answers.");
      expect(await page.locator("#mineSignOut").isVisible()).toBe(true);
    } finally { await page.close(); }

    reset({ signedIn: true, email: "new@example.test", canAsk: true, reason: null, questions: [] });
    const fresh = await open();
    try {
      await fresh.locator("#mineSignedIn").waitFor({ state: "visible" });
      expect(await fresh.locator("#mineForm").isVisible()).toBe(true);
      expect(await fresh.locator("#mineMessage").isVisible()).toBe(false);
      expect(await fresh.locator("#mineEmpty").isVisible()).toBe(true);
    } finally { await fresh.close(); }
  });

  test("[integration] VM-3 a question and reply containing markup render as text and create no element", async () => {
    reset({ signedIn: true, email: "visitor@example.test", reason: "one-question", questions: [{ ...answered, question: HOSTILE, response: `${HOSTILE} reply` }] });
    const page = await open();
    try {
      await page.locator("#mineList article").waitFor({ state: "visible" });
      expect(await page.locator("#mineList").innerText()).toContain(HOSTILE);
      expect(await page.locator("#mineList img").count()).toBe(0);
      expect(await page.locator("img[src='x']").count()).toBe(0);
    } finally { await page.close(); }
  });

  test("[integration] VM-4 the form is hidden and the message shown for one-question and for free-slots-used", async () => {
    const messages: [Fake["reason"], string][] = [
      ["one-question", "You have already used your free question. Your question and its reply are on this page."],
      ["free-slots-used", "The free places are taken. You are on the waitlist. Your place on the waitlist: 3."],
    ];
    for (const [reason, message] of messages) {
      reset({ signedIn: true, email: "visitor@example.test", canAsk: false, reason, waitlistPosition: reason === "free-slots-used" ? 3 : null });
      const page = await open();
      try {
        await page.locator("#mineSignedIn").waitFor({ state: "visible" });
        expect(await page.locator("#mineForm").isVisible()).toBe(false);
        expect(await page.locator("#mineMessage").innerText()).toBe(message);
      } finally { await page.close(); }
    }
  });

  test("[integration] VM-5 a refused submit shows the API message and hides the form", async () => {
    const message = "The free places are taken. You are on the waitlist.";
    reset({ signedIn: true, email: "visitor@example.test", canAsk: true, submitStatus: 409, submitBody: { code: "free-slots-used", message, waitlist_position: 4 } });
    const page = await open();
    try {
      await page.locator("#mineForm").waitFor({ state: "visible" });
      await page.locator("#mineQuestion").fill("A question after the cap");
      await page.locator("#mineReply").check();
      await page.locator("#mineSubmit").click();
      await page.locator("#mineMessage").waitFor({ state: "visible" });
      expect(await page.locator("#mineMessage").innerText()).toBe(`${message} Your place on the waitlist: 4.`);
      expect(await page.locator("#mineForm").isVisible()).toBe(false);
    } finally { await page.close(); }
  });

  test("[integration] VM-9 the waitlist view shows the fixed message and the position from /me, and no place when none is sent", async () => {
    reset({ signedIn: true, email: "waiting@example.test", canAsk: false, reason: "free-slots-used", waitlistPosition: 1 });
    const page = await open();
    try {
      await page.locator("#mineSignedIn").waitFor({ state: "visible" });
      expect(await page.locator("#mineMessage").innerText()).toBe("The free places are taken. You are on the waitlist. Your place on the waitlist: 1.");
      expect(await page.locator("#mineForm").isVisible()).toBe(false);
    } finally { await page.close(); }

    reset({ signedIn: true, email: "waiting@example.test", canAsk: false, reason: "free-slots-used", waitlistPosition: null });
    const bare = await open();
    try {
      await bare.locator("#mineSignedIn").waitFor({ state: "visible" });
      expect(await bare.locator("#mineMessage").innerText()).toBe("The free places are taken. You are on the waitlist.");
    } finally { await bare.close(); }
  });

  test("[integration] VM-6 submit sends JSON with reply_consent true, a 43-char key and no email field", async () => {
    reset({ signedIn: true, email: "visitor@example.test", canAsk: true });
    const page = await open();
    try {
      await page.locator("#mineForm").waitFor({ state: "visible" });
      await page.locator("#mineQuestion").fill("Should refunds go to a person or a rule?");
      await page.locator("#mineReply").check();
      await page.locator("#mineSubmit").click();
      await page.waitForFunction(() => {
        const field = document.getElementById("mineQuestion");
        return field instanceof HTMLTextAreaElement && field.value === "";
      });
      const sent = posts.filter((p) => p.path === "/api/v1/visitor/questions");
      expect(sent).toHaveLength(1);
      const first = sent[0];
      expect(first?.contentType).toBe("application/json");
      const body = first?.body;
      expect(typeof body === "object" && body !== null).toBe(true);
      if (typeof body !== "object" || body === null) return;
      expect(Object.keys(body).sort()).toEqual(["marketing_consent", "question", "reply_consent", "request_key"]);
      expect(Reflect.get(body, "reply_consent")).toBe(true);
      expect(Reflect.get(body, "question")).toBe("Should refunds go to a person or a rule?");
      expect(String(Reflect.get(body, "request_key"))).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect("email" in body).toBe(false);
    } finally { await page.close(); }
  });

  test("[integration] VM-7 sign-out posts to the sign-out route and returns to the signed-out view", async () => {
    reset({ signedIn: true, email: "visitor@example.test", reason: "one-question", questions: [answered] });
    const page = await open();
    try {
      await page.locator("#mineSignedIn").waitFor({ state: "visible" });
      await page.locator("#mineSignOut").click();
      await page.locator("#mineSignedOut").waitFor({ state: "visible" });
      expect(posts.map((p) => p.path)).toEqual(["/api/v1/visitor/sign-out"]);
    } finally { await page.close(); }
  });

  test("[unit] VM-8 the page links the shared stylesheet first and uses no inline script or innerHTML", () => {
    const html = readFileSync(join(SITE, "ask", "mine", "index.html"), "utf8");
    const js = readFileSync(join(SITE, "ask", "mine", "mine.js"), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    expect([...head.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)][0]?.[0]).toContain('href="../../page.css"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect((html + js).includes(EM_DASH) || (html + js).includes(EN_DASH)).toBe(false);
  });
});
