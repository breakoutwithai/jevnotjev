import { STARTER_PACKS, type StarterPack } from "./starter-packs.ts";

/** The query parameter a link uses to name a pack: /backstage/?pack=p5. */
export const PACK_PARAM = "pack";

/**
 * The pack a page address names, or null. Only an id in STARTER_PACKS counts (any letter case); anything else, a
 * missing value or an unknown id is ignored so the normal page shows.
 */
export function packFromSearch(search: string): StarterPack | null {
  const id = new URLSearchParams(search).get(PACK_PARAM);
  if (id === null) return null;
  const wanted = id.toLowerCase();
  return STARTER_PACKS.find((p) => p.id === wanted) ?? null;
}
