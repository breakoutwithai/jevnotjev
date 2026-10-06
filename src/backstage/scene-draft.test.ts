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
  expect(saveSceneDraft(storage, (id) => values.get(id) ?? "")).toBe(true);
  const draft = loadSceneDraft(storage);
  for (const id of SCENE_DRAFT_FIELDS) expect(draft.fields[id]).toBe(`value of ${id}`);
  expect(draft.imported).toBeUndefined();
});

test("[unit] D10 imported case records keep their ids and multiline text", () => {
  const storage = new MemoryStorage();
  const records = [{ id: "row-a", input: "line one\nline two" }, { id: "row_b", input: "second" }];
  saveSceneDraft(storage, (id) => (id === "cases" ? "line one / line two\nsecond" : ""), records);
  expect(loadSceneDraft(storage).imported).toEqual(records);
  // Records without the matching text, or with an invalid id, duplicate id or empty input, are not restored.
  saveSceneDraft(storage, () => "", records);
  expect(loadSceneDraft(storage).imported).toBeUndefined();
  for (const bad of [
    [{ id: "bad id", input: "x" }],
    [{ id: "a", input: "x" }, { id: "a", input: "y" }],
    [{ id: "a", input: "" }],
    [{ id: "a" }],
    "text",
  ]) {
    storage.setItem(SCENE_DRAFT_KEY, JSON.stringify({ fields: { cases: "x" }, imported: bad }));
    expect(loadSceneDraft(storage).imported).toBeUndefined();
  }
});

test("[unit] D10 a failed save reports false and drops the older draft", () => {
  const storage = new MemoryStorage();
  saveSceneDraft(storage, () => "old");
  storage.setItem = () => { throw new Error("quota"); };
  expect(saveSceneDraft(storage, () => "new")).toBe(false);
  expect(storage.items.size).toBe(0);
  expect(saveSceneDraft(undefined, () => "x")).toBe(false);
});

test("[unit] D10 a draft is read only from known text fields and bad storage gives no draft", () => {
  const storage = new MemoryStorage();
  const none = { fields: {}, imported: undefined };
  storage.setItem(SCENE_DRAFT_KEY, JSON.stringify({ fields: { question: "Q?", "jev-key": "secret", cases: 5 } }));
  expect(loadSceneDraft(storage)).toEqual({ fields: { question: "Q?" }, imported: undefined });
  storage.setItem(SCENE_DRAFT_KEY, "{not json");
  expect(loadSceneDraft(storage)).toEqual(none);
  storage.setItem(SCENE_DRAFT_KEY, "7");
  expect(loadSceneDraft(storage)).toEqual(none);
  expect(loadSceneDraft(undefined)).toEqual(none);
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
  expect(judgingRules(undefined)).toEqual({ keep: "", leaveOut: "" });
});
