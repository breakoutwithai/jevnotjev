// [unit] The served copy at site/tm/map.ts is byte-identical to the skill's mapper source (M3).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = join(import.meta.dir, "map.ts");
const SERVED = join(import.meta.dir, "..", "..", "..", "site", "tm", "map.ts");

/** Bytes that differ, counting any length difference as differing bytes. */
function differingBytes(a: Buffer, b: Buffer): number {
  let n = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}

describe("[unit] served mapper parity", () => {
  test("[unit] M3 site/tm/map.ts equals skills/tokenmax-map/scripts/map.ts byte for byte", () => {
    const source = readFileSync(SOURCE);
    let served = Buffer.alloc(0);
    try {
      served = readFileSync(SERVED);
    } catch {
      // a missing served copy is a parity failure, reported below as differing bytes
    }
    process.stdout.write(`M3 differing_bytes=${differingBytes(source, served)}\n`);
    expect(source.length).toBeGreaterThan(0);
    expect(Buffer.compare(served, source)).toBe(0);
  });
});
