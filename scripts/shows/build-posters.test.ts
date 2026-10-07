import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPosters, POSTERS_OUT, render, summariseRun } from "./build-posters.ts";
import type { Poster } from "../../src/shows/posters.ts";

const ROOT = join(import.meta.dir, "..", "..");
const page = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const office = page.slice(page.indexOf('<section class="office" id="tickets"'), page.indexOf("</section>", page.indexOf('id="tickets"')));
const script = readFileSync(join(ROOT, "site", "shows", "office.js"), "utf8");
const committed: { posters: Poster[] } = JSON.parse(readFileSync(POSTERS_OUT, "utf8"));

describe("ticket office form", () => {
  test("[unit] T1 form has exactly one required field, email", () => {
    expect(office.length).toBeGreaterThan(0);
    const required = [...office.matchAll(/<(input|select|textarea)\b[^>]*\brequired\b[^>]*>/g)].map((m) => m[0].match(/name="([^"]+)"/)?.[1]);
    expect(required).toEqual(["email"]);
    expect(office).toMatch(/<input type="url" id="tkWebsite" name="website"(?![^>]*required)[^>]*>/);
    expect(office).toMatch(/<input type="checkbox" id="tkConsent" name="consent"(?![^>]*checked)[^>]*>/);
    expect(office).toMatch(/<input type="checkbox" id="tkFollow" name="follow_up"(?![^>]*checked)[^>]*>/);
  });
});

describe("posters", () => {
  test("[unit] T2 posters generated, at most 10, none typed", async () => {
    const built = await buildPosters(ROOT);
    expect(readFileSync(POSTERS_OUT, "utf8")).toBe(render(built));
    expect(built.length).toBe(Math.min(10, committed.posters.length));
    expect(built.length).toBeGreaterThan(0);
    for (const p of built) {
      expect(page.includes(p.title)).toBe(false);
      expect(script.includes(p.title)).toBe(false);
      if (p.story) expect(script.includes(p.story)).toBe(false);
    }
    const check = spawnSync("bun", [join(import.meta.dir, "build-posters.ts"), "--check"], { encoding: "utf8" });
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(`posters up to date: ${built.length}`);
  });

  test("[unit] T2 a run under 30 paired labels carries no verdict word; a labelled run does", async () => {
    const rehearsal = await summariseRun(ROOT, "2026-10-03-tokenmax");
    expect(rehearsal?.labelledPaired).toBe(0);
    expect(rehearsal?.verdict).toBeNull();
    const show = await summariseRun(ROOT, "2026-10-01-uc13-shop-bot");
    expect(show?.labelledPaired).toBe(40);
    expect(typeof show?.verdict).toBe("string");
    for (const p of committed.posters) if (p.run && p.run.labelledPaired < 30) expect(p.run.verdict).toBeNull();
  });
});
