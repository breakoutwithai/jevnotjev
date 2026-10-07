import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "./server.ts";
import { checkTicket, RATE_LIMIT, TicketLimiter, TicketStore } from "./tickets.ts";

const ORIGIN = "http://localhost:3456";
const SEEDED = "seeded-7f3a91@example.test";

function setup(): { handler: ReturnType<typeof createHandler>; store: TicketStore; logs: string[]; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "tickets-"));
  const site = join(dir, "site");
  mkdirSync(join(site, "shows"), { recursive: true });
  const poster = (id: string, date: string) =>
    ({ id: id, title: id, story: "", fit: [], stage: "script-reading", date: date, source: `docs/${id}.md`, run: null });
  writeFileSync(join(site, "shows", "posters.json"), JSON.stringify({ schema: "jnj-posters/1", posters: [poster("uc13", "2026-10-01"), poster("uc9", "2026-09-28")] }));
  const path = join(dir, "tickets.sqlite");
  const logs: string[] = [];
  const handler = createHandler({ version: "test", origin: ORIGIN, staticRoot: site, tickets: { path }, log: (line) => logs.push(line) });
  return { handler, store: new TicketStore(path), logs, path };
}

const ask = (data: unknown, ip = "203.0.113.7", origin = ORIGIN): [Request, { remoteAddress: string }] => [
  new Request(`${ORIGIN}/api/tickets`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(data) }),
  { remoteAddress: ip },
];

const valid = { kind: "show", show: "uc13", email: SEEDED, website: "https://shop.example", consent: true, nickname: "" };

describe("ticket office endpoint", () => {
  test("[integration] T3 no consent stores 0 rows, consent stores 1", async () => {
    const { handler, store } = setup();
    const refused = await handler(...ask({ ...valid, consent: false }));
    expect(refused.status).toBe(400);
    expect(store.count()).toBe(0);
    const issued = await handler(...ask(valid));
    expect(issued.status).toBe(200);
    const body: unknown = await issued.json();
    expect(typeof body === "object" && body !== null && "ticket" in body && typeof body.ticket === "string" && /^JNJ-[0-9A-F]{12}$/.test(body.ticket)).toBe(true);
    expect(store.count()).toBe(1);
  });

  test("[integration] T4 honeypot, bad email, bad URL, unknown show, cross-origin store nothing", async () => {
    const { handler, store } = setup();
    expect((await handler(...ask({ ...valid, nickname: "bot" }))).status).toBe(200);
    expect((await handler(...ask({ ...valid, email: "not-an-email" }, "203.0.113.8"))).status).toBe(400);
    expect((await handler(...ask({ ...valid, website: "javascript:alert(1)" }, "203.0.113.9"))).status).toBe(400);
    expect((await handler(...ask({ ...valid, show: "nope" }, "203.0.113.10"))).status).toBe(400);
    expect((await handler(...ask(valid, "203.0.113.11", "https://evil.test"))).status).toBe(403);
    expect(store.count()).toBe(0);
  });

  test("[integration] T4 a sixth request from one address inside the window gets 429", async () => {
    const { handler, store } = setup();
    for (let i = 0; i < 5; i++) expect((await handler(...ask({ ...valid, email: `p${i}@example.test` }))).status).toBe(200);
    expect((await handler(...ask({ ...valid, email: "p6@example.test" }))).status).toBe(429);
    expect(store.count()).toBe(5);
  });

  test("[integration] T4 an oversized body is refused", async () => {
    const { handler, store } = setup();
    expect((await handler(...ask({ ...valid, idea: "x".repeat(5000) }))).status).toBe(413);
    expect(store.count()).toBe(0);
  });

  test("[integration] T5 seeded email absent from log output", async () => {
    const { handler, logs } = setup();
    await handler(...ask(valid));
    await handler(...ask({ ...valid, consent: false }, "203.0.113.12"));
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((line) => line.includes("ticket.issued"))).toBe(true);
    expect(logs.filter((line) => line.includes(SEEDED) || line.includes("shop.example")).length).toBe(0);
  });

  test("[integration] backstage ticket needs no show and keeps the idea; ranking counts tickets", async () => {
    const { handler, store } = setup();
    expect((await handler(...ask({ kind: "backstage", email: SEEDED, idea: "Can my bot answer this?", consent: true }))).status).toBe(200);
    for (let i = 0; i < 2; i++) await handler(...ask({ ...valid, show: "uc9", email: `q${i}@example.test` }, `198.51.100.${i}`));
    expect(store.count()).toBe(3);
    const ranking = await handler(new Request(`${ORIGIN}/api/tickets/ranking`));
    expect(await ranking.json()).toEqual({ ids: ["uc9", "uc13"], counts: { uc9: 2 } });
  });
});

describe("ticket office hardening", () => {
  test("[integration] a retried submission with the same request key returns the same ticket and stores 1 row", async () => {
    const { handler, store } = setup();
    const keyed = { ...valid, request_key: "attempt-7f3a91c2d4e5" };
    const first: unknown = await (await handler(...ask(keyed))).json();
    const again: unknown = await (await handler(...ask(keyed))).json();
    const id = (v: unknown): unknown => (typeof v === "object" && v !== null && "ticket" in v ? v.ticket : null);
    expect(id(again)).toBe(id(first));
    expect(again).toMatchObject({ kind: "show", show: "uc13", replay: true });
    expect(store.count()).toBe(1);
    const changed = await handler(...ask({ ...keyed, kind: "backstage", show: null }));
    expect(changed.status).toBe(409);
    expect(store.count()).toBe(1);
  });

  test("[integration] T4 malformed bodies use up the address allowance before any body is parsed", async () => {
    const { handler, store } = setup();
    const broken = (): [Request, { remoteAddress: string }] => [
      new Request(`${ORIGIN}/api/tickets`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{not json" }),
      { remoteAddress: "203.0.113.50" },
    ];
    for (let i = 0; i < RATE_LIMIT; i++) expect((await handler(...broken())).status).toBe(413);
    expect((await handler(...ask(valid, "203.0.113.50"))).status).toBe(429);
    expect(store.count()).toBe(0);
  });

  test("[unit] an apostrophe in the local part is a valid email", () => {
    const shows = new Set(["uc13"]);
    expect(checkTicket({ ...valid, email: "o'connor@example.com" }, shows).ok).toBe(true);
    for (const email of ["a@exa'mple.com", "a@foo..com", "a@foo/bar.com", "a@-foo.com", "a@foo.c"])
      expect(checkTicket({ ...valid, email }, shows)).toEqual({ ok: false, reason: "bad-email" });
  });

  test("[integration] a malformed catalogue is an outage (503), not an empty catalogue", async () => {
    const { handler, store, path } = setup();
    await Bun.write(join(path, "..", "site", "shows", "posters.json"), "{not json");
    expect((await handler(new Request(`${ORIGIN}/api/tickets/ranking`))).status).toBe(503);
    expect((await handler(...ask(valid))).status).toBe(503);
    expect(store.count()).toBe(0);
  });

  test("[unit] a full limiter refuses new addresses instead of evicting an active limit", () => {
    let now = 0;
    const limiter = new TicketLimiter(() => now, 3);
    for (let i = 0; i < RATE_LIMIT; i++) expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("c")).toBe(true);
    expect(limiter.allow("d")).toBe(false);
    expect(limiter.allow("a")).toBe(false);
    now = 11 * 60_000;
    expect(limiter.allow("d")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
  });
});
