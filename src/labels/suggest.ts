/**
 * Where a labeller's Jev suggestion comes from, and the calls it costs (labelling loop M2, metric m4).
 * Pure apart from the injected client: no DOM, no fetch of its own.
 *
 * - A recorded Jev arm output for the case is reused: 0 calls.
 * - With none recorded, Jev is called once per case, and only with the labeller's own key (bring your own key).
 * - With neither, the case shows "no suggestion yet". Our key is never used: the client receives only the key passed in.
 *
 * A suggestion is never a label. Labels come only from the labeller's picks (callsForPick).
 */
import type { JevSuggestion } from "./rank.ts";

export type SuggestionPlan = "recorded" | "call" | "none";

export type Suggestion =
  | { readonly kind: "recorded"; readonly answer: JevSuggestion }
  | { readonly kind: "called"; readonly answer: JevSuggestion }
  | { readonly kind: "none"; readonly reason: "no-key" | "call-failed" };

/** Asks Jev for one case with the labeller's key. Resolves null when the answer is unusable. */
export interface JevSuggestionClient {
  ask(caseId: string, key: string): Promise<JevSuggestion | null>;
}

function usableKey(key: string | null): key is string {
  return key !== null && key.trim().length > 0;
}

export function suggestionPlan(recorded: JevSuggestion | null, labellerKey: string | null): SuggestionPlan {
  if (recorded !== null) return "recorded";
  return usableKey(labellerKey) ? "call" : "none";
}

/** One suggestion per case: a call, once made (or failed), is never repeated for that case. */
export class SuggestionBook {
  readonly #client: JevSuggestionClient;
  readonly #called = new Map<string, Promise<Suggestion>>();
  constructor(client: JevSuggestionClient) {
    this.#client = client;
  }
  get(caseId: string, recorded: JevSuggestion | null, labellerKey: string | null): Promise<Suggestion> {
    const plan = suggestionPlan(recorded, labellerKey);
    if (plan === "recorded" && recorded !== null) return Promise.resolve({ kind: "recorded", answer: recorded });
    const earlier = this.#called.get(caseId);
    if (earlier !== undefined) return earlier;
    if (plan === "none" || !usableKey(labellerKey)) return Promise.resolve({ kind: "none", reason: "no-key" });
    const pending = this.#client.ask(caseId, labellerKey).then(
      (answer): Suggestion => (answer === null ? { kind: "none", reason: "call-failed" } : { kind: "called", answer }),
      (): Suggestion => ({ kind: "none", reason: "call-failed" }),
    );
    this.#called.set(caseId, pending);
    return pending;
  }
}

export type Call = "accept" | "reject";

/** A labeller's picks for one case. blind null = unsure (no label). final is set only after the suggestion step. */
export interface CasePick {
  readonly blind: string | null;
  readonly final: string | null;
  readonly suggestionShown: boolean | null;
}

export interface RowCalls {
  /** The blind pick's call on this answer: the scoring truth. */
  readonly label: Call | null;
  /** The final pick's call on this answer: reported beside label, never instead of it. */
  readonly labelFinal: Call | null;
  readonly suggestionShown: boolean | null;
}

/** The calls one answer gets from a case's picks: accept when the answer equals the pick, else reject. */
export function callsForPick(output: string, pick: CasePick): RowCalls {
  if (pick.blind === null && pick.final !== null) throw new Error("A final pick needs a blind pick first.");
  if ((pick.final === null) !== (pick.suggestionShown === null)) throw new Error("A final pick says whether a suggestion was shown, and only a final pick does.");
  const call = (picked: string | null): Call | null => (picked === null ? null : picked === output ? "accept" : "reject");
  return {
    label: call(pick.blind),
    labelFinal: call(pick.final),
    suggestionShown: pick.suggestionShown,
  };
}
