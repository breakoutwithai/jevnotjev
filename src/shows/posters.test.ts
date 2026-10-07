import { describe, expect, test } from "bun:test";
import { MAX_POSTERS, parseUseCase, rankPosters, verdictWordShown, type Poster } from "./posters.ts";

const doc = [
  "# UC13: Shop bot, answer or hand off",
  "",
  "**User story:** As a small shop owner I want the bot to answer what its facts cover.",
  "",
  "## Jev or not",
  "Split. Looking up a price is code: **!Jev**. Deciding one message is a fixed choice: **Jev could help**.",
  "",
  "Files: the run in [docs/product/runs/2026-10-01-uc13-shop-bot/](../runs/2026-10-01-uc13-shop-bot/).",
].join("\n");

const poster = (id: string, date: string): Poster =>
  ({ id: id, title: id, story: "", fit: [], stage: "script-reading", date: date, source: `docs/product/use-cases/${id}.md`, run: null, watch: null });

describe("parseUseCase", () => {
  test("[unit] T2 title, story, fit check and run folder come from the doc text", () => {
    expect(parseUseCase("uc13-shop-bot-answer-or-handoff.md", doc)).toEqual({
      id: "uc13",
      title: "Shop bot, answer or hand off",
      story: "As a small shop owner I want the bot to answer what its facts cover.",
      fit: ["!Jev", "Jev could help"],
      runFolder: "2026-10-01-uc13-shop-bot",
    });
  });

  test("[unit] T2 a doc with no run link has no run folder", () => {
    expect(parseUseCase("uc9-x.md", "# UC9: Roast\n\n**User story:** As a builder.\n").runFolder).toBeNull();
  });
});

describe("verdictWordShown", () => {
  test("[unit] T2 poster under 30 paired labels shows no verdict word", () => {
    expect(verdictWordShown(29)).toBe(false);
    expect(verdictWordShown(0)).toBe(false);
    expect(verdictWordShown(30)).toBe(true);
  });
});

describe("rankPosters", () => {
  test("[unit] ranking: newer item outranks older at equal tickets", () => {
    const ids = rankPosters([poster("old", "2026-09-01"), poster("new", "2026-10-01")], {}).map((p) => p.id);
    expect(ids).toEqual(["new", "old"]);
  });

  test("[unit] ranking: tickets lift an older item", () => {
    const ids = rankPosters([poster("old", "2026-09-28"), poster("new", "2026-10-01")], { old: 5 }).map((p) => p.id);
    expect(ids).toEqual(["old", "new"]);
  });

  test("[unit] T2 at most 10 posters", () => {
    const many = Array.from({ length: 14 }, (_, i) => poster(`uc${i}`, `2026-09-${String(10 + i).padStart(2, "0")}`));
    expect(rankPosters(many, {}).length).toBe(MAX_POSTERS);
    expect(MAX_POSTERS).toBe(10);
  });
});
