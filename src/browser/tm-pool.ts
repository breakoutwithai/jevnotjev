// Jev task pooling on /tm/: the event engine behind the two Jev questions the show asks.
//
//   Every session, every task: "Do I have enough in my limit to finish this task?"  YES keep it local, NO pool it.
//   Every session, when idle:  "Do I have capacity for any tasks before the end of this session?"  YES pick up, NO chill out.
//
// The cast is the public /api/maps board captured 2026-10-22 (21 self-reported rows). The board holds no task budgets,
// session timelines or idle time, so every task, size, allowance and session length here is an illustrative scenario
// input, and every YES/NO is a scripted rule standing in for Jev, not a model call. At 100x each source map is replicated
// 100 times with staggered starts; per-instance values never change, and every count is read from the events this
// engine produces. Pure: no DOM, no network, nothing written anywhere.

export const CAPTURED_ON = "2026-10-22";
/** One illustrative unit of session allowance takes ten story minutes to run. */
export const UNIT_MINUTES = 10;
export const DAY_MINUTES = 1440;
export const WEEK_MINUTES = 7 * DAY_MINUTES;
export const TASK_QUESTION = "Do I have enough in my limit to finish this task?";
export const IDLE_QUESTION = "Do I have capacity for any tasks before the end of this session?";

export type Kind = "heavy" | "lite";
export type SessionShape = { readonly allowance: number; readonly startMinute: number; readonly length: number };
/** A heavy session: 8 units of allowance from 8 PM. */
export const HEAVY_SESSION: SessionShape = { allowance: 8, startMinute: 20 * 60, length: 180 };
/** A lite session: 12 units from 8:11 PM, two hours long, a little work of its own and then idle. */
export const LITE_SESSION: SessionShape = { allowance: 12, startMinute: 20 * 60 + 11, length: 120 };

export type TaskSpec = { readonly title: string; readonly size: number };
/** Each heavy session's two tasks, by weekday. Monday's both fit; from Tuesday the second is bigger than what is left. */
export const DAY_TASKS: readonly (readonly [TaskSpec, TaskSpec])[] = [
  [{ title: "Update the changelog", size: 3 }, { title: "Tidy the README", size: 4 }],
  [{ title: "Rename the env settings", size: 3 }, { title: "Review last week’s PRs", size: 6 }],
  [{ title: "Bump the test fixtures", size: 3 }, { title: "Split the billing module", size: 6 }],
  [{ title: "Fix a flaky test", size: 3 }, { title: "Migrate the search index", size: 6 }],
  [{ title: "Patch the login copy", size: 3 }, { title: "Write tests for the login page", size: 6 }],
  [{ title: "Triage new issues", size: 3 }, { title: "Profile the slow report", size: 6 }],
  [{ title: "Sort the inbox labels", size: 3 }, { title: "Draft the release notes", size: 6 }],
];
/** A lite session's own small task, before it goes idle. */
export const LITE_TASK: TaskSpec = { title: "Answer a quick question", size: 2 };

export type MapRow = {
  readonly id: string; readonly alias: string; readonly day: string; readonly days: number; readonly sessions: number;
  /** Usage limit hits as reported: short + weekly + unknown. */
  readonly limitHits: number;
  /** Codex weekly window used, or null when the row does not report it (shown as unknown, never filled in). */
  readonly codexWeeklyPct: number | null;
};

const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`maps snapshot: ${what} is not a number`);
  return v;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v === "") throw new Error(`maps snapshot: ${what} is not a string`);
  return v;
};

/** The public /api/maps payload, checked field by field. Throws on anything it cannot read. */
export function readSnapshot(data: unknown): readonly MapRow[] {
  if (typeof data !== "object" || data === null || !("rows" in data) || !Array.isArray(data.rows)) throw new Error("maps snapshot: no rows");
  return data.rows.map((row: unknown, i: number): MapRow => {
    if (typeof row !== "object" || row === null || !("caps" in row) || typeof row.caps !== "object" || row.caps === null) throw new Error(`maps snapshot: row ${i} has no caps`);
    const caps = row.caps;
    const get = (o: object, k: string): unknown => (k in o ? Reflect.get(o, k) : undefined);
    const weekly = get(row, "codex_weekly_pct");
    return {
      id: str(get(row, "id"), `row ${i} id`), alias: str(get(row, "alias"), `row ${i} alias`), day: str(get(row, "day"), `row ${i} day`),
      days: num(get(row, "days"), `row ${i} days`), sessions: num(get(row, "sessions"), `row ${i} sessions`),
      limitHits: num(get(caps, "short"), "caps.short") + num(get(caps, "weekly"), "caps.weekly") + num(get(caps, "unknown"), "caps.unknown"),
      codexWeeklyPct: weekly === null ? null : num(weekly, `row ${i} codex_weekly_pct`),
    };
  });
}

/** A row that reported any usage limit hit plays a heavy scenario; every other row a lite one. */
export function kindOf(row: MapRow): Kind { return row.limitHits > 0 ? "heavy" : "lite"; }

/** Illustrative: one session per active day, about one per ten reported sessions in a week, spread across the week. */
export function activeDays(row: MapRow): number[] {
  if (row.sessions <= 0 || row.days <= 0) return [];
  const k = Math.min(7, Math.max(1, Math.round((row.sessions * 7) / row.days / 10)));
  return Array.from({ length: k }, (_, i) => Math.floor(((i + 0.5) * 7) / k));
}

/** The two sessions the stage follows at 1x: the heaviest heavy row and the busiest lite row, replica 0 of each. */
export function focusPair(rows: readonly MapRow[]): { readonly heavy: string; readonly lite: string } {
  const pick = (kind: Kind, score: (r: MapRow) => number): MapRow => {
    const pool = rows.filter((r) => kindOf(r) === kind && activeDays(r).length === 7);
    const best = pool.reduce<MapRow | null>((a, r) => (a === null || score(r) > score(a) ? r : a), null);
    if (!best) throw new Error(`maps snapshot: no ${kind} row active all week`);
    return best;
  };
  return { heavy: instanceId(pick("heavy", (r) => r.limitHits).id, 0), lite: instanceId(pick("lite", (r) => r.sessions).id, 0) };
}

export function instanceId(source: string, replica: number): string { return `${source}-r${String(replica).padStart(3, "0")}`; }

export type Session = {
  readonly id: string; readonly instance: string; readonly source: string; readonly replica: number; readonly kind: Kind; readonly day: number;
  readonly start: number; readonly end: number; readonly allowance: number; readonly tasks: readonly TaskSpec[];
};

/** Every session of every instance at a scale. Replica r of a map has replica 0's scenario, started a little later. */
export function planSessions(rows: readonly MapRow[], scale: number): Session[] {
  const focus = focusPair(rows);
  const out: Session[] = [];
  rows.forEach((row, ri) => {
    const kind = kindOf(row), shape = kind === "heavy" ? HEAVY_SESSION : LITE_SESSION;
    for (let r = 0; r < scale; r++) {
      const instance = instanceId(row.id, r);
      // The two focus sessions start on the hour; everyone else a stagger later, so parallel work spreads out.
      const stagger = instance === focus.heavy || instance === focus.lite ? 0 : 2 + ((ri * 37 + r * 53) % 180);
      for (const day of activeDays(row)) {
        const start = day * DAY_MINUTES + shape.startMinute + stagger;
        const tasks = kind === "heavy" ? DAY_TASKS[day] ?? [] : [LITE_TASK];
        out.push({ id: `${instance}:d${day}`, instance, source: row.id, replica: r, kind, day, start, end: start + shape.length, allowance: shape.allowance, tasks });
      }
    }
  });
  return out;
}

export type Task = { readonly id: string; readonly title: string; readonly size: number; readonly origin: string };
export type Decision = {
  readonly t: number; readonly instance: string; readonly session: string; readonly check: "task" | "idle"; readonly yes: boolean;
  /** The task checked (task check) or picked up (idle YES); null for an idle NO. */
  readonly task: Task | null;
  /** Allowance left in the session when Jev was asked. */
  readonly room: number; readonly allowance: number;
  /** Story minutes to the end of the session when Jev was asked. */
  readonly minutesLeft: number;
};
export type Run = { readonly task: Task; readonly instance: string; readonly start: number; readonly end: number; readonly pickedUp: boolean };
export type Move = { readonly t: number; readonly task: Task; readonly instance: string };
export type Result = {
  readonly scale: number; readonly sources: number; readonly instances: number;
  readonly decisions: readonly Decision[]; readonly runs: readonly Run[];
  /** Tasks entering the shared pool (instance: the session that sent it). */
  readonly pooled: readonly Move[];
  /** Tasks leaving the pool (instance: the session that picked it up). */
  readonly pickups: readonly Move[];
  /** The story minute the last event finishes: Sunday's late sessions run past midnight. */
  readonly end: number;
};

type Idle = { readonly t: number; readonly seq: number; readonly session: Session; readonly room: number };

/** Runs the whole week at a scale. Task checks run in each session's order; idle checks run in story-time order
 * against one shared pool, picking the freshest pooled task that fits the room and the time left. */
export function simulate(rows: readonly MapRow[], scale: number): Result {
  const sessions = planSessions(rows, scale);
  const decisions: Decision[] = [], runs: Run[] = [], pooled: Move[] = [], pickups: Move[] = [], idles: Idle[] = [];
  let seq = 0;
  for (const s of sessions) {
    let cursor = s.start, left = s.allowance;
    s.tasks.forEach((spec, k) => {
      const task: Task = { id: `${s.id}:k${k}`, title: spec.title, size: spec.size, origin: s.instance };
      const yes = spec.size <= left;
      decisions.push({ t: cursor, instance: s.instance, session: s.id, check: "task", yes, task, room: left, allowance: s.allowance, minutesLeft: s.end - cursor });
      if (yes) { runs.push({ task, instance: s.instance, start: cursor, end: cursor + spec.size * UNIT_MINUTES, pickedUp: false }); cursor += spec.size * UNIT_MINUTES; left -= spec.size; }
      else pooled.push({ t: cursor, task, instance: s.instance });
    });
    // every session, heavy or lite, is idle once its own tasks are done: Jev asks the second question then
    idles.push({ t: cursor, seq: seq++, session: s, room: left });
  }
  pooled.sort((a, b) => a.t - b.t);
  // Idle moments, latest first, so the earliest is popped from the end; a new one is inserted in place.
  const queue: Idle[] = [];
  const before = (a: Idle, b: Idle): boolean => a.t < b.t || (a.t === b.t && a.seq < b.seq);
  const push = (x: Idle): void => {
    let lo = 0, hi = queue.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; const q = queue[mid]; if (q && before(x, q)) lo = mid + 1; else hi = mid; }
    queue.splice(lo, 0, x);
  };
  const pop = (): Idle | undefined => queue.pop();
  for (const x of idles) push(x);
  const waiting: Task[] = [];
  let next = 0;
  for (let idle = pop(); idle; idle = pop()) {
    const { t, session: s, room } = idle;
    // tasks pooled at this very minute are in the pool before the idle check asks
    for (let m = pooled[next]; m && m.t <= t; m = pooled[++next]) waiting.push(m.task);
    const minutesLeft = s.end - t;
    let found = -1;
    for (let j = waiting.length - 1; j >= 0; j--) {
      const w = waiting[j];
      if (w && w.size <= room && w.size * UNIT_MINUTES <= minutesLeft) { found = j; break; }
    }
    const task = found >= 0 ? waiting.splice(found, 1)[0] ?? null : null;
    decisions.push({ t, instance: s.instance, session: s.id, check: "idle", yes: task !== null, task, room, allowance: s.allowance, minutesLeft });
    if (!task) continue;
    pickups.push({ t, task, instance: s.instance });
    const end = t + task.size * UNIT_MINUTES;
    runs.push({ task, instance: s.instance, start: t, end, pickedUp: true });
    // idle again once the picked-up task is done: Jev asks again
    push({ t: end, seq: seq++, session: s, room: room - task.size });
  }
  decisions.sort((a, b) => a.t - b.t);
  const end = Math.max(WEEK_MINUTES, ...runs.map((x) => x.end), ...decisions.map((d) => d.t));
  return { scale, sources: rows.length, instances: rows.length * scale, decisions, runs, pooled, pickups, end };
}

export type Counts = {
  readonly decisions: number; readonly taskChecks: number; readonly idleChecks: number;
  readonly taskYes: number; readonly taskNo: number; readonly idleYes: number; readonly idleNo: number;
  readonly poolWaiting: number; readonly pickedUp: number;
  /** Pooled tasks picked up and finished. */
  readonly completed: number;
  /** Task runs whose story interval covers this minute; idle sessions and waiting pool entries are not work. */
  readonly parallelNow: number; readonly parallelPeak: number;
};

/** Counts at any story minute, read from the event stream (binary search, so a frame can call it freely). */
export function timeline(r: Result): (t: number) => Counts {
  const sorted = (xs: number[]): number[] => xs.sort((a, b) => a - b);
  const times = (pred: (d: Decision) => boolean): number[] => sorted(r.decisions.filter(pred).map((d) => d.t));
  const taskYes = times((d) => d.check === "task" && d.yes), taskNo = times((d) => d.check === "task" && !d.yes);
  const idleYes = times((d) => d.check === "idle" && d.yes), idleNo = times((d) => d.check === "idle" && !d.yes);
  const poolIn = sorted(r.pooled.map((m) => m.t)), poolOut = sorted(r.pickups.map((m) => m.t));
  const done = sorted(r.runs.filter((x) => x.pickedUp).map((x) => x.end));
  const starts = sorted(r.runs.map((x) => x.start)), ends = sorted(r.runs.map((x) => x.end));
  // concurrency after each distinct minute, and the running peak
  const steps = sorted([...new Set([...starts, ...ends])]);
  const peaks: number[] = [];
  let peak = 0, si = 0, ei = 0, now = 0;
  for (const t of steps) {
    while (ends[ei] !== undefined && (ends[ei] ?? 0) <= t) { now--; ei++; }
    while (starts[si] !== undefined && (starts[si] ?? 0) <= t) { now++; si++; }
    peak = Math.max(peak, now); peaks.push(peak);
  }
  const upTo = (xs: readonly number[], t: number): number => {
    let lo = 0, hi = xs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if ((xs[mid] ?? 0) <= t) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return (t) => {
    const ty = upTo(taskYes, t), tn = upTo(taskNo, t), iy = upTo(idleYes, t), inn = upTo(idleNo, t);
    const k = upTo(steps, t);
    const picked = upTo(poolOut, t);
    return {
      decisions: ty + tn + iy + inn, taskChecks: ty + tn, idleChecks: iy + inn, taskYes: ty, taskNo: tn, idleYes: iy, idleNo: inn,
      poolWaiting: upTo(poolIn, t) - picked, pickedUp: picked, completed: upTo(done, t),
      parallelNow: upTo(starts, t) - upTo(ends, t), parallelPeak: k === 0 ? 0 : peaks[k - 1] ?? 0,
    };
  };
}

/** The story clock as a reader sees it: "Tue 8:30 PM"; past Sunday midnight, "next Mon 12:28 AM". */
export function storyClock(t: number): string {
  const total = Math.max(0, Math.round(t)), day = Math.floor(total / DAY_MINUTES), m = total % DAY_MINUTES;
  const h = Math.floor(m / 60), mm = m % 60, h12 = h % 12 === 0 ? 12 : h % 12;
  const name = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day % 7] ?? "";
  return `${day >= 7 ? "next " : ""}${name} ${h12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
