import { expect, test } from "bun:test";
import {
  SCENE_DRAFT_FIELDS,
  SCENE_DRAFT_KEY,
  clearSceneDraft,
  judgingRules,
  loadSceneDraft,
  saveSceneDraft,
  type DraftStorage,
} from "./scene-draft.ts";

class MemoryStorage implements DraftStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
}

test("[unit] D10 draft fields never name a key input", () => {
  for (const id of SCENE_DRAFT_FIELDS) expect(id).not.toMatch(/-key$|api|secret|password/i);
});

test("[unit] D10 a saved draft comes back field for field", () => {
  const storage = new MemoryStorage();
  const values = new Map(SCENE_DRAFT_FIELDS.map((id) => [id, `value of ${id}`]));
  saveSceneDraft(storage, (id) => values.get(id) ?? "");
  const draft = loadSceneDraft(storage);
  for (const id of SCENE_DRAFT_FIELDS) expect(draft[id]).toBe(`value of ${id}`);
});

test("[unit] D10 a draft is read only from known text fields and bad storage gives no draft", () => {
  const storage = new MemoryStorage();
  storage.setItem(SCENE_DRAFT_KEY, JSON.stringify({ question: "Q?", "jev-key": "secret", cases: 5 }));
  expect(loadSceneDraft(storage)).toEqual({ question: "Q?" });
  storage.setItem(SCENE_DRAFT_KEY, "{not json");
  expect(loadSceneDraft(storage)).toEqual({});
  storage.setItem(SCENE_DRAFT_KEY, "7");
  expect(loadSceneDraft(storage)).toEqual({});
  expect(loadSceneDraft(undefined)).toEqual({});
  const full: DraftStorage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  expect(() => saveSceneDraft(full, () => "x")).not.toThrow();
  expect(() => clearSceneDraft(full)).not.toThrow();
});

test("[unit] D10 clearing removes the draft", () => {
  const storage = new MemoryStorage();
  saveSceneDraft(storage, () => "x");
  clearSceneDraft(storage);
  expect(storage.items.size).toBe(0);
});

test("[unit] D10 judging rules show what to keep and what to leave out", () => {
  expect(judgingRules({ acceptance: "Names the refund", exclusions: "Shipping cases" })).toEqual({
    keep: "Keep when: Names the refund",
    leaveOut: "Leave out: Shipping cases",
  });
  expect(judgingRules({ acceptance: "A", exclusions: "" }).leaveOut).toBe("");
  expect(judgingRules({ acceptance: "A", exclusions: "  \n " }).leaveOut).toBe("");
});
