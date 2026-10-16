import { expect, test } from "bun:test";
import { calculateZone } from "./zone.ts";
const HOUR = 3_600_000;
const now = 1_800_000_000_000;
const reading = (usedPercent: number, hoursLeft: number, age = 0, windowMinutes = 10080) => ({ usedPercent, windowMinutes, resetsAt: now + hoursLeft * HOUR, ts: now - age * HOUR });
test("[unit] TZ1 actual readings cover six window zones", () => {
  expect(calculateZone(reading(10, 72), now).zone).toBe("COLD");
  expect(calculateZone(reading(45, 72), now).zone).toBe("ON_TRACK");
  expect(calculateZone(reading(65, 72), now).zone).toBe("HOT");
  expect(calculateZone(reading(71, 72), now).zone).toBe("RESERVE");
  expect(calculateZone(reading(100, 72), now).zone).toBe("CAPPED");
  expect(calculateZone(reading(100, 72, 12.01), now).zone).toBe("STALE");
});
test("[unit] TZ2 absent and invalid readings never invent zones", () => {
  expect(calculateZone(undefined, now)).toEqual({ zone: "UNKNOWN", coverage: "missing", reservePct: null });
  for (const r of [reading(-1, 1), reading(101, 1), reading(10, -1), reading(10, 169), reading(10, 1, -1), reading(10, 1, 0, 0), reading(NaN, 1)]) {
    expect(calculateZone(r, now)).toEqual({ zone: "UNKNOWN", coverage: "invalid", reservePct: null });
  }
  expect(calculateZone(reading(10, 1), Infinity).coverage).toBe("invalid");
  expect(calculateZone(reading(10, 1), now, -1).coverage).toBe("invalid");
});
test("[unit] TZ3 exact staleness reserve and reset boundaries", () => {
  expect(calculateZone(reading(100, 1, 12), now).zone).toBe("CAPPED");
  expect(calculateZone(reading(70, 72), now).zone).toBe("HOT");
  expect(calculateZone(reading(71, 72), now).reservePct).toBe(30);
  expect(calculateZone(reading(50, 0), now).reservePct).toBe(0);
  expect(calculateZone(reading(50, 2, 0, 300), now).reservePct).toBe(0);
  expect(calculateZone(reading(0, 168), now, 100).reservePct).toBe(100);
});
test("[unit] TZ4 early pace uses one seventh window and under hour no projection", () => {
  expect(calculateZone(reading(20, 167.5), now, 0).zone).toBe("COLD");
  expect(calculateZone(reading(20, 167), now, 0).zone).toBe("HOT");
  expect(calculateZone(reading(0, 168), now, 0).zone).toBe("COLD");
});
