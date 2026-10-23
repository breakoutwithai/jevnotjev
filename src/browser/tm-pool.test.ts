import { describe, expect, test } from "bun:test";
import snapshot from "./tm-maps-20261022.json";
import { SCENARIOS } from "./tm-run.ts";
import {
  activeDays, CAPTURED_ON, DAY_MINUTES, DAY_TASKS, focusPair, kindOf, LITE_SESSION, HEAVY_SESSION, planSessions, readSnapshot, simulate, storyClock, timeline, UNIT_MINUTES,
  WEEK_MINUTES, type Decision, type MapRow, type Result,
} from "./tm-pool.ts";

// Jev task pooling on /tm/ (TASK d28 task-pooling): the event engine behind the two Jev questions. Every task and
// session value is illustrative; the cast comes from the public /api/maps snapshot captured 2026-10-22; the YES/NO
// answers are scripted rules, not model calls.

const ROWS = readSnapshot(snapshot);
const ONE = simulate(ROWS, 1);
const HUNDRED = simulate(ROWS, 100);
const FOCUS = focusPair(ROWS);
const onDay = (r: Result, instance: string, day: number): Decision[] => r.decisions.filter((d) => d.instance === instance && d.t >= day * DAY_MINUTES && d.t < (day + 1) * DAY_MINUTES);

describe("tm-pool snapshot", () => {
  test("[unit] TP-1 the snapshot is the 21 public map rows; usage limit hits and missing weekly percentages are kept as reported", () => {
    expect(ROWS.length).toBe(21);
    expect(CAPTURED_ON).toBe("2026-10-22");
    expect(ROWS.reduce((n, r) => n + r.limitHits, 0)).toBe(191);
    const early = ROWS.find((r) => r.alias === "early-ai");
    expect(early?.codexWeeklyPct).toBeNull();
    expect(ROWS.find((r) => r.alias === "newsletter-curator")?.days).toBe(14);
    expect(() => readSnapshot({ rows: [{ id: "x" }] })).toThrow();
    expect(() => readSnapshot(null)).toThrow();
  });
  test("[unit] TP-2 a row with usage limit hits is a heavy scenario, else lite; active days spread across the week", () => {
    const row = (sessions: number, hits: number, days = 7): MapRow => ({ id: "TM-000000000000", alias: "a", day: "2026-10-22", days, sessions, limitHits: hits, codexWeeklyPct: null });
    expect(kindOf(row(10, 1))).toBe("heavy");
    expect(kindOf(row(10, 0))).toBe("lite");
    expect(activeDays(row(0, 0))).toEqual([]);
    expect(activeDays(row(5, 0))).toEqual([3]);
    expect(activeDays(row(898, 85))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(activeDays(row(30, 0))).toEqual([1, 3, 5]);
    // a 14-day window is scaled to a week before counting
    expect(activeDays(row(40, 0, 14))).toEqual([1, 5]);
  });
});

describe("tm-pool decisions", () => {
  test("[unit] TP-3 task check: YES when the task fits the session allowance left (kept local and run), NO sends that same task to the pool", () => {
    for (const d of ONE.decisions.filter((x) => x.check === "task")) {
      const task = d.task;
      if (!task) throw new Error("a task check always names its task");
      expect({ yes: d.yes, fits: task.size <= d.room }).toEqual({ yes: d.yes, fits: d.yes });
      const ran = ONE.runs.some((r) => r.task.id === task.id && !r.pickedUp && r.start === d.t);
      const pooled = ONE.pooled.some((m) => m.task.id === task.id && m.t === d.t);
      expect({ ran, pooled }).toEqual({ ran: d.yes, pooled: !d.yes });
    }
  });
  test("[unit] TP-4 idle check: YES moves a pooled task that fits the room and the time left into the session; NO leaves the session idle and moves nothing", () => {
    for (const d of ONE.decisions.filter((x) => x.check === "idle")) {
      const moved = ONE.pickups.filter((m) => m.t === d.t && m.instance === d.instance);
      if (d.yes) {
        const task = d.task;
        if (!task) throw new Error("an idle YES names the task it picks up");
        expect(task.size <= d.room && task.size * UNIT_MINUTES <= d.minutesLeft).toBe(true);
        expect(moved.map((m) => m.task.id)).toEqual([task.id]);
        expect(ONE.pooled.some((m) => m.task.id === task.id && m.t <= d.t)).toBe(true);
      } else {
        expect({ task: d.task, moved: moved.length }).toEqual({ task: null, moved: 0 });
      }
    }
  });
  test("[unit] TP-5 the stage story: the heavy session keeps a small task and pools the larger one; the idle lite session picks up that same task, then says chill out", () => {
    const [yes, no] = onDay(ONE, FOCUS.heavy, 1);
    expect([yes?.check, yes?.yes, yes?.task?.title, no?.check, no?.yes, no?.task?.title]).toEqual(["task", true, "Rename the env settings", "task", false, "Review last week’s PRs"]);
    const idle = onDay(ONE, FOCUS.lite, 1).filter((d) => d.check === "idle");
    expect(idle.map((d) => d.yes)).toEqual([true, false]);
    expect(idle[0]?.task?.id).toBe(no?.task?.id ?? "missing");
    // the pool holds it between the two moments: it is counted waiting when sent, and picked up a minute later
    expect(timeline(ONE)(no?.t ?? 0).poolWaiting).toBeGreaterThanOrEqual(1);
    expect((idle[0]?.t ?? 0) - (no?.t ?? 0)).toBe(1);
    // the NO comes with work still waiting in the pool: it stays available
    const at = timeline(ONE);
    expect(at(idle[1]?.t ?? 0).poolWaiting).toBeGreaterThan(0);
    // and again on Friday, with the slip the existing show names
    const fri = onDay(ONE, FOCUS.lite, 4).filter((d) => d.check === "idle");
    expect(fri.map((d) => [d.yes, d.task?.title ?? null])).toEqual([[true, "Write tests for the login page"], [false, null]]);
    expect(fri[0]?.task?.origin).toBe(FOCUS.heavy);
  });
  test("[unit] TP-6 the lite session picks up a pooled task on exactly the days the existing show draws a +1 job slip", () => {
    const days = ONE.pickups.filter((m) => m.instance === FOCUS.lite).map((m) => Math.floor(m.t / DAY_MINUTES));
    expect(days).toEqual(SCENARIOS.under.extra.flatMap((x, i) => (x > 0 ? [i] : [])));
    // the titled slips in the existing show match the tasks the engine moves
    for (const [i, job] of SCENARIOS.under.jobs.entries()) if (job) expect(ONE.pickups.find((m) => m.instance === FOCUS.lite && Math.floor(m.t / DAY_MINUTES) === i)?.task.title).toBe(job);
  });
});

describe("tm-pool scale", () => {
  test("[unit] TP-7 1x is the 21 captured maps; 100x is 2,100 replicas with replica ids, the source count unchanged", () => {
    expect([ONE.scale, ONE.sources, ONE.instances]).toEqual([1, 21, 21]);
    expect([HUNDRED.scale, HUNDRED.sources, HUNDRED.instances]).toEqual([100, 21, 2100]);
    const ids = new Set(planSessions(ROWS, 100).map((s) => s.instance));
    expect(ids.size).toBe(2100 - ROWS.filter((r) => activeDays(r).length === 0).length * 100);
    for (const id of ids) expect(id).toMatch(/^TM-[0-9A-F]{12}-r\d{3}$/);
  });
  test("[unit] TP-8 scaling preserves every per-instance value: allowance, length, task sizes and titles; only the start is staggered", () => {
    const one = planSessions(ROWS, 1), many = planSessions(ROWS, 100);
    const shape = (s: (typeof one)[number]): string => JSON.stringify([s.source, s.kind, s.day, s.allowance, s.end - s.start, s.tasks.map((t) => [t.title, t.size])]);
    const base = new Map(one.map((s) => [`${s.source}/${s.day}`, shape(s)]));
    for (const s of many) expect(shape(s)).toBe(base.get(`${s.source}/${s.day}`) ?? "missing");
    expect(new Set(many.map((s) => s.start % DAY_MINUTES)).size).toBeGreaterThan(50);
    expect(HEAVY_SESSION.allowance).toBe(8);
    expect(LITE_SESSION.allowance).toBe(12);
  });
  test("[unit] TP-9 task checks scale exactly 100 times; idle checks and pool outcomes come from processing the events, not a multiplier", () => {
    const end1 = timeline(ONE)(ONE.end), end100 = timeline(HUNDRED)(HUNDRED.end);
    expect(end100.taskYes).toBe(end1.taskYes * 100);
    expect(end100.taskNo).toBe(end1.taskNo * 100);
    expect(end100.decisions).toBe(HUNDRED.decisions.length);
    expect(end100.decisions).toBe(end100.taskYes + end100.taskNo + end100.idleYes + end100.idleNo);
    expect(end100.pickedUp).toBe(HUNDRED.pickups.length);
    expect(end100.poolWaiting).toBe(HUNDRED.pooled.length - HUNDRED.pickups.length);
    expect(end100.parallelPeak).toBeGreaterThan(end1.parallelPeak);
  });
  test("[unit] TP-10 counts follow the event stream at every story time: pool waiting never negative, completed never above picked up, peak never below now", () => {
    for (const r of [ONE, HUNDRED]) {
      const at = timeline(r);
      let last = at(0);
      for (let t = 0; t <= r.end; t += 37) {
        const c = at(t);
        expect(c.poolWaiting).toBeGreaterThanOrEqual(0);
        expect(c.completed).toBeLessThanOrEqual(c.pickedUp);
        expect(c.parallelPeak).toBeGreaterThanOrEqual(c.parallelNow);
        expect(c.decisions).toBeGreaterThanOrEqual(last.decisions);
        expect(c.parallelPeak).toBeGreaterThanOrEqual(last.parallelPeak);
        last = c;
      }
      // parallel work counts task runs only: brute force over the runs agrees
      for (const t of [DAY_MINUTES + 20 * 60 + 35, 4 * DAY_MINUTES + 21 * 60]) {
        expect(at(t).parallelNow).toBe(r.runs.filter((x) => x.start <= t && t < x.end).length);
      }
    }
  });
  test("[unit] TP-11 a rerun at either scale is identical: toggling 1x, 100x, 1x never double counts", () => {
    const again = simulate(ROWS, 1);
    expect(timeline(again)(again.end)).toEqual(timeline(ONE)(ONE.end));
    expect(ONE.end).toBeGreaterThanOrEqual(WEEK_MINUTES);
    expect(simulate(ROWS, 100).decisions.length).toBe(HUNDRED.decisions.length);
    expect(DAY_TASKS.length).toBe(7);
  });
});

describe("tm-pool sweep #407", () => {
  test("[unit] TP-12 every session gets an idle check once its own tasks are done, heavy and lite alike, under the same room and time rules", () => {
    for (const r of [ONE, HUNDRED]) {
      const sessions = planSessions(ROWS, r.scale);
      const idled = new Set(r.decisions.filter((d) => d.check === "idle").map((d) => d.session));
      expect(sessions.filter((s) => !idled.has(s.id)).map((s) => s.id)).toEqual([]);
    }
    const heavyIdle = ONE.decisions.filter((d) => d.check === "idle" && d.instance === FOCUS.heavy);
    expect(heavyIdle.length).toBeGreaterThanOrEqual(7);
    for (const d of heavyIdle) {
      // the first idle check of a session has what its kept tasks left; a re-check after a pickup has less
      const kept = ONE.decisions.filter((x) => x.session === d.session && x.check === "task" && x.yes).reduce((n, x) => n + (x.task?.size ?? 0), 0);
      const picked = ONE.decisions.filter((x) => x.session === d.session && x.check === "idle" && x.yes && x.t < d.t).reduce((n, x) => n + (x.task?.size ?? 0), 0);
      expect(d.room).toBe(d.allowance - kept - picked);
      if (d.yes) expect((d.task?.size ?? 99) <= d.room && (d.task?.size ?? 99) * UNIT_MINUTES <= d.minutesLeft).toBe(true);
    }
  });
  test("[unit] TP-13 the story clock names the real day: after Sunday night it reads the next Monday, never Sun", () => {
    expect(storyClock(DAY_MINUTES + 20 * 60 + 30)).toBe("Tue 8:30 PM");
    expect(storyClock(6 * DAY_MINUTES + 23 * 60 + 59)).toBe("Sun 11:59 PM");
    expect(storyClock(WEEK_MINUTES)).toBe("next Mon 12:00 AM");
    expect(storyClock(WEEK_MINUTES + 28)).toBe("next Mon 12:28 AM");
    expect(storyClock(WEEK_MINUTES - 0.4)).toBe("next Mon 12:00 AM");
    expect(storyClock(ONE.end).startsWith("next Mon")).toBe(ONE.end >= WEEK_MINUTES - 0.5);
  });
});
