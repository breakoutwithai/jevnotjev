// One link loads a persona pack: /backstage/?pack=p5. The id parse, and the sign-in round trip of the query.
import { expect, test } from "bun:test";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeNextPath } from "../backstage/auth.ts";
import { createHandler } from "../backstage/server.ts";
import { packFromSearch } from "./pack-link.ts";

const ORIGIN = "http://localhost:8787";

test("[unit] PL1 a valid pack id in the query selects that pack, in any case or position", () => {
  expect(packFromSearch("?pack=p5")?.id).toBe("p5");
  expect(packFromSearch("pack=p8")?.id).toBe("p8");
  expect(packFromSearch("?x=1&pack=p1")?.id).toBe("p1");
  expect(packFromSearch("?pack=P6")?.id).toBe("p6");
});

test("[unit] PL2 an unknown, empty, repeated-wrong or missing pack id selects nothing", () => {
  for (const search of ["", "?", "?pack=", "?pack=p9", "?pack=p0", "?pack=p55", "?pack=__proto__", "?pack=constructor", "?pack=p5%00", "?other=p5"])
    expect([search, packFromSearch(search)]).toEqual([search, null]);
});

test("[unit] PL3 next keeps ?pack=<id> and nothing else after the path", () => {
  expect(sanitizeNextPath("/backstage/?pack=p5")).toBe("/backstage/?pack=p5");
  expect(sanitizeNextPath("/backstage/x?pack=p5")).toBe("/backstage/x?pack=p5");
  for (const value of [
    "/backstage/?pack=p5&x=1",
    "/backstage/?pack=",
    "/backstage/?pack=<script>",
    "/backstage/?next=//evil.test",
    "/backstage/?pack=p5#x",
    "/backstage/?pack=p5\n",
    "/backstage/?",
    "//evil.test/?pack=p5",
    "https://evil.test/backstage/?pack=p5",
    "/other/?pack=p5",
    "/backstage/..?pack=p5",
    "/backstage//?pack=p5",
  ])
    expect([value, sanitizeNextPath(value)]).toEqual([value, "/backstage/"]);
});

function operators() {
  const directory = mkdtempSync(join(tmpdir(), "backstage-pack-"));
  const salt = randomBytes(16).toString("hex");
  const hash = `scrypt$${salt}$${scryptSync("correct-password", salt, 64).toString("hex")}`;
  const path = join(directory, "operators.json");
  writeFileSync(path, JSON.stringify([{ email: "a@example.com", password_hash: hash }]));
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("[integration] PL4 the sign-in redirect carries the pack query, the sign-in page and the password redirect return it", async () => {
  const data = operators();
  const handler = createHandler({ version: "test", origin: ORIGIN, requireSession: true, auth: { sessionSecret: "s".repeat(32), operatorsPath: data.path } });
  try {
    const gated = await handler(new Request(`${ORIGIN}/backstage/?pack=p5`));
    expect(gated.status).toBe(302);
    const location = gated.headers.get("location") ?? "";
    expect(location).toStartWith("/backstage/sign-in?next=");
    const next = new URL(location, ORIGIN).searchParams.get("next");
    expect(next).toBe("/backstage/?pack=p5");

    const page = await (await handler(new Request(`${ORIGIN}${location}`))).text();
    expect(page).toContain('name="next" value="/backstage/?pack=p5"');

    const signIn = await handler(
      new Request(`${ORIGIN}/api/auth/password`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "a@example.com", password: "correct-password", next: next ?? "" }),
      }),
    );
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get("location")).toBe("/backstage/?pack=p5");
  } finally {
    data.cleanup();
    handler.close();
  }
});

test("[integration] PL5 a hostile next in the sign-in form still lands on /backstage/", async () => {
  const data = operators();
  const handler = createHandler({ version: "test", origin: ORIGIN, requireSession: true, auth: { sessionSecret: "s".repeat(32), operatorsPath: data.path } });
  try {
    for (const next of ["//evil.test/?pack=p5", "https://evil.test/", "/backstage/?pack=p5&next=//evil.test", "/backstage/?next=https://evil.test"]) {
      const response = await handler(
        new Request(`${ORIGIN}/api/auth/password`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ email: "a@example.com", password: "correct-password", next }),
        }),
      );
      expect([next, response.headers.get("location")]).toEqual([next, "/backstage/"]);
    }
    const page = await (await handler(new Request(`${ORIGIN}/backstage/sign-in?next=${encodeURIComponent("/backstage/?pack=p5&next=//evil.test")}`))).text();
    expect(page).toContain('name="next" value="/backstage/"');
  } finally {
    data.cleanup();
    handler.close();
  }
});
