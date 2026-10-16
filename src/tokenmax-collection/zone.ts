/** Arithmetic adapted from TokenMax's pure burn-zone core: zones apply to observed subscription windows.
 * Reserve shrinks to reset; precedence and one-seventh pace floor preserve the source policy.
 * Token counters never enter this calculation. No private source data is incorporated.
 */
export type WindowReading = { usedPercent: number; windowMinutes: number; resetsAt: number; ts: number };
export type WindowZone = "COLD" | "ON_TRACK" | "HOT" | "RESERVE" | "CAPPED" | "STALE" | "UNKNOWN";
export type ZoneResult = { zone: WindowZone; coverage: "adequate" | "missing" | "invalid"; reservePct: number | null };
const HOUR = 3_600_000;
export function calculateZone(reading: WindowReading | undefined, now: number, reservePctPerDay = 10): ZoneResult {
  if (reading === undefined) return { zone: "UNKNOWN", coverage: "missing", reservePct: null };
  const { usedPercent, windowMinutes, resetsAt, ts } = reading;
  if (![usedPercent, windowMinutes, resetsAt, ts, now, reservePctPerDay].every(Number.isFinite)
    || usedPercent < 0 || usedPercent > 100 || windowMinutes <= 0 || reservePctPerDay < 0
    || now < 0 || ts < 0 || resetsAt < 0 || ts > now || resetsAt < now
    || resetsAt - now > windowMinutes * 60_000 || resetsAt - ts > windowMinutes * 60_000) {
    return { zone: "UNKNOWN", coverage: "invalid", reservePct: null };
  }
  const windowHours = windowMinutes / 60;
  const hoursLeft = (resetsAt - now) / HOUR;
  const elapsed = Math.max(0, windowHours - hoursLeft);
  const reserve = windowHours < 24 ? 0 : Math.min(100, Math.max(0, reservePctPerDay * Math.min(hoursLeft, windowHours) / 24));
  const pace = elapsed >= 1 ? usedPercent / Math.max(elapsed, windowHours / 7) : 0;
  const projected = usedPercent + pace * hoursLeft;
  let zone: WindowZone;
  if ((now - ts) / HOUR > 12) zone = "STALE";
  else if (usedPercent >= 100) zone = "CAPPED";
  else if (usedPercent > 100 - reserve) zone = "RESERVE";
  else if (projected > 100) zone = "HOT";
  else if (projected < 100 - reserve - 10) zone = "COLD";
  else zone = "ON_TRACK";
  return { zone, coverage: "adequate", reservePct: Math.round(reserve * 10) / 10 };
}
