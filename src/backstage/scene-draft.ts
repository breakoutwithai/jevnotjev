/** Scene fields kept in sessionStorage so a reload before a run does not lose the draft. No key field is ever listed. */
export const SCENE_DRAFT_FIELDS = [
  "question",
  "choice-a",
  "choice-b",
  "definition-a",
  "definition-b",
  "acceptance",
  "exclusions",
  "keywords",
  "cases",
] as const;
export const SCENE_DRAFT_KEY = "backstage-scene-draft";

type DraftField = (typeof SCENE_DRAFT_FIELDS)[number];
export type SceneDraft = Partial<Record<DraftField, string>>;

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isDraftField(name: string): name is DraftField {
  return SCENE_DRAFT_FIELDS.some((field) => field === name);
}

export function saveSceneDraft(
  storage: DraftStorage | undefined,
  read: (id: DraftField) => string,
): void {
  if (!storage) return;
  const draft: SceneDraft = {};
  for (const id of SCENE_DRAFT_FIELDS) draft[id] = read(id);
  try {
    storage.setItem(SCENE_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage full or blocked: the draft is a convenience, never required.
  }
}

export function loadSceneDraft(storage: DraftStorage | undefined): SceneDraft {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SCENE_DRAFT_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const draft: SceneDraft = {};
    for (const [name, value] of Object.entries(parsed))
      if (isDraftField(name) && typeof value === "string") draft[name] = value;
    return draft;
  } catch {
    return {};
  }
}

export function clearSceneDraft(storage: DraftStorage | undefined): void {
  try {
    storage?.removeItem(SCENE_DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The judging rules shown beside each answer: what to keep, and what the rehearsal leaves out. */
export function judgingRules(scene: {
  acceptance: string;
  exclusions: string;
}): { keep: string; leaveOut: string } {
  return {
    keep: `Keep when: ${scene.acceptance}`,
    leaveOut: scene.exclusions.trim() ? `Leave out: ${scene.exclusions}` : "",
  };
}
