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
export interface DraftCase {
  readonly id: string;
  readonly input: string;
}
export interface LoadedDraft {
  fields: SceneDraft;
  /** Validated records of an imported CSV, with their ids and original multiline text. */
  imported: DraftCase[] | undefined;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isDraftField(name: string): name is DraftField {
  return SCENE_DRAFT_FIELDS.some((field) => field === name);
}

/** Returns false when the draft could not be kept; any older draft is then dropped so a stale one never comes back. */
export function saveSceneDraft(
  storage: DraftStorage | undefined,
  read: (id: DraftField) => string,
  imported?: readonly DraftCase[],
): boolean {
  if (!storage) return false;
  const fields: SceneDraft = {};
  for (const id of SCENE_DRAFT_FIELDS) fields[id] = read(id);
  try {
    storage.setItem(
      SCENE_DRAFT_KEY,
      JSON.stringify({ fields, imported: imported ?? null }),
    );
    return true;
  } catch {
    clearSceneDraft(storage);
    return false;
  }
}

function importedCases(value: unknown): DraftCase[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100)
    return undefined;
  const cases: DraftCase[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const id: unknown = Reflect.get(item, "id");
    const input: unknown = Reflect.get(item, "input");
    if (
      typeof id !== "string" ||
      typeof input !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
      seen.has(id) ||
      input.length === 0 ||
      input.length > 8000
    )
      return undefined;
    seen.add(id);
    cases.push({ id, input });
  }
  return cases;
}

export function loadSceneDraft(storage: DraftStorage | undefined): LoadedDraft {
  const empty: LoadedDraft = { fields: {}, imported: undefined };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(SCENE_DRAFT_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    const stored: unknown = Reflect.get(parsed, "fields");
    const fields: SceneDraft = {};
    if (typeof stored === "object" && stored !== null)
      for (const [name, value] of Object.entries(stored))
        if (isDraftField(name) && typeof value === "string")
          fields[name] = value;
    return {
      fields,
      imported: fields.cases
        ? importedCases(Reflect.get(parsed, "imported"))
        : undefined,
    };
  } catch {
    return empty;
  }
}

export function clearSceneDraft(storage: DraftStorage | undefined): void {
  try {
    storage?.removeItem(SCENE_DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The judging rules shown beside each answer: what to keep, and what the rehearsal leaves out. Both empty with no active scene. */
export function judgingRules(
  scene: { acceptance: string; exclusions: string } | undefined,
): { keep: string; leaveOut: string } {
  if (!scene) return { keep: "", leaveOut: "" };
  return {
    keep: `Keep when: ${scene.acceptance}`,
    leaveOut: scene.exclusions.trim() ? `Leave out: ${scene.exclusions}` : "",
  };
}
