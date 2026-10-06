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

/** The one storage status: what the page may say about the saved draft. */
export type DraftStatus = "saved" | "save-failed" | "clear-failed";

const STATUS_TEXT: Record<DraftStatus, string> = {
  saved: "",
  "save-failed":
    "Could not keep your scene in this tab, so a reload will lose it. Download or copy your text first.",
  "clear-failed":
    "Could not remove the saved scene from this tab. Close the tab to clear it.",
};
export function draftStatusText(status: DraftStatus): string {
  return STATUS_TEXT[status];
}

/** How imported cases appear in the cases box: multiline text is flattened. */
export function importedDisplay(cases: readonly DraftCase[]): string {
  return cases.map((c) => c.input.replaceAll("\n", " / ")).join("\n");
}

/** A failed save drops any older draft so a stale one never comes back; if that also fails the status says so. */
export function saveSceneDraft(
  storage: DraftStorage | undefined,
  read: (id: DraftField) => string,
  imported?: readonly DraftCase[],
): DraftStatus {
  if (!storage) return "save-failed";
  const fields: SceneDraft = {};
  for (const id of SCENE_DRAFT_FIELDS) fields[id] = read(id);
  try {
    storage.setItem(
      SCENE_DRAFT_KEY,
      JSON.stringify({ fields, imported: imported ?? null }),
    );
    return "saved";
  } catch {
    return clearSceneDraft(storage) ? "save-failed" : "clear-failed";
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
    // Records come back only when they are exactly what the cases box shows, so the box never differs from what runs.
    const records = importedCases(Reflect.get(parsed, "imported"));
    return {
      fields,
      imported:
        records && importedDisplay(records) === fields.cases
          ? records
          : undefined,
    };
  } catch {
    return empty;
  }
}

/** True when no draft remains (or there is no storage); false when removal failed. */
export function clearSceneDraft(storage: DraftStorage | undefined): boolean {
  try {
    storage?.removeItem(SCENE_DRAFT_KEY);
    return true;
  } catch {
    return false;
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
