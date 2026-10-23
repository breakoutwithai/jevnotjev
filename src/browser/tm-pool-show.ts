// /tm/ Jev task pooling: the With TokenMax week gains Jev's two questions, a shared pool on the stage, a metrics panel
// under it and "Scale this to the stars" (21 public maps to 2,100 simulated instances). Everything moving here comes
// from the event stream in tm-pool.ts; tasks, sizes, allowances and session times are illustrative and every YES/NO is
// scripted. Nothing is sent anywhere: the cast is the board snapshot bundled into tm.js.

import snapshot from "./tm-maps-20261022.json";
import {
  CAPTURED_ON, DAY_MINUTES, focusPair, IDLE_QUESTION, kindOf, readSnapshot, simulate, storyClock, TASK_QUESTION, timeline,
  type Counts, type Decision, type Result,
} from "./tm-pool.ts";

/** Thrown into an animation whose run was replaced (a new pick, Replay, Skip, a scale change). */
export class Cancel extends Error {}

export type Mode = "burn" | "under";
export type PoolingDeps = {
  readonly doc: Document; readonly win: Window;
  readonly stage: HTMLElement; readonly floor: HTMLElement; readonly run: HTMLElement; readonly compare: HTMLElement;
  readonly act: HTMLElement; readonly status: HTMLElement; readonly posters: readonly HTMLLIElement[];
  /** 0 draws end states at once (Skip, deep links, reduced motion). */
  speed(): number;
  token(): number;
  takeToken(): number;
  setBusy(busy: boolean): void;
  setGauge(left: number, name: string): void;
  /** Lift the curtain and clear the curtain call, so the 100x view starts on an open stage. */
  clearStage(): void;
  /** Back to 1x: replay the With week. */
  replayWith(): void;
};
export type Pooling = {
  /** Hide everything pooling adds (Without view, a visitor's own week). */
  reset(): void;
  /** The With week starts: a 1x run of the stream, the beat card, the pool and the panel. keepClock: Skip redraws the
   * same run, so its wall clock keeps counting from the start. */
  begin(mode: Mode, keepClock: boolean): void;
  /** Jev's checks for this day of the focus session, before the day plays. */
  day(mode: Mode, i: number, tok: number): Promise<void>;
  dayDone(i: number): void;
  finish(): void;
  scaled(): boolean;
  /** The pause-aware playback clock in ms: it stands still while Pause is pressed. Every timer, tween and travel of the
   * show reads it, so Pause holds the ordinary day playback as well as Jev's beats. */
  clock(): number;
  replayScale(): void;
  skipScale(): void;
};

export const ROWS = readSnapshot(snapshot);
export const FOCUS = focusPair(ROWS);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** The weekdays the stage stops for Jev: Tuesday and Friday, so each question is asked twice. */
export const BEAT_DAYS: readonly number[] = [1, 4];
export const LABEL_1X = "Illustrative tasks and limits · scripted Jev decisions · cast from 21 public maps";
export const LABEL_100X = "100× simulation · scripted Jev decisions · based on 21 public maps";
/** Story playback at 100x: one story hour per 0.6 s of wall time while work runs, 30 times faster through the quiet night. */
const BUSY_MINUTES_PER_MS = 60 / 600;
const QUIET_SPEEDUP = 30;
const fmt = (n: number): string => n.toLocaleString("en-US");

export function createPooling(deps: PoolingDeps): Pooling {
  const { doc, win } = deps;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  /* ---------- the run being shown ---------- */
  let scale = 1, result: Result = simulate(ROWS, 1), at = timeline(result), storyT = 0, mode: Mode = "burn", active = false;
  const results = new Map<number, Result>([[1, result]]);
  const runAt = (n: number): Result => { const hit = results.get(n); if (hit) return hit; const r = simulate(ROWS, n); results.set(n, r); return r; };
  // wall clock of the current run, pauses excluded; pauseAccum is every pause ever, for the playback clock
  let wallStart = 0, wallEnd: number | null = null, pausedAt: number | null = null, pausedTotal = 0, pauseAccum = 0, clockMode: Mode | null = null;
  const now = (): number => win.performance.now();
  const playNow = (): number => now() - pauseAccum - (pausedAt === null ? 0 : now() - pausedAt);
  const elapsedMs = (): number => Math.max(0, (wallEnd ?? (pausedAt ?? now())) - wallStart - pausedTotal);
  const startClock = (): void => { setPaused(false); wallStart = now(); wallEnd = null; pausedTotal = 0; };
  // end the pause first, so the stretch already paused is subtracted once, then freeze the clock
  const stopClock = (): void => { setPaused(false); if (wallEnd === null) wallEnd = now(); };

  /* ---------- stage pieces: the beat card and the shared pool, under the day cards ---------- */
  const row = el("div", "jev-row"); row.id = "jevRow"; row.hidden = true;
  const beat = el("div", "jev-beat"); beat.id = "jevBeat";
  const who = el("p", "jb-who"); who.id = "jevWho";
  const q = el("p", "jb-q"); q.id = "jevQ";
  const slot = el("div", "jb-slot");
  const room = el("p", "jb-room"); room.id = "jevRoom";
  const ans = el("p", "jb-ans"); ans.id = "jevA";
  const tag = el("p", "jb-tag"); tag.id = "jevTag";
  beat.append(who, q, slot, room, ans, tag);
  const pool = el("div", "pool"); pool.id = "pool";
  const poolHead = el("p", "pool-head", "Shared pool"); poolHead.id = "poolHead";
  // the slips are the two sessions the stage follows; the count under them is every map's pool
  const poolFocus = el("p", "pool-focus"); poolFocus.id = "poolFocus";
  const poolSlips = el("div", "pool-slips"); poolSlips.id = "poolSlips";
  const poolCount = el("p", "pool-count"); poolCount.id = "poolCount";
  pool.append(poolHead, poolFocus, poolSlips, poolCount);
  const syncPool = (): void => {
    poolFocus.textContent = poolSlips.querySelector(".tslip") ? "Slips: tasks from the two sessions on stage" : "No slips from the two sessions on stage right now";
  };
  row.append(beat, pool);
  deps.floor.insertBefore(row, deps.status);

  /* ---------- the 100x view: a mosaic of miniature sessions inside the same stage ---------- */
  const wide = el("div", "scale-view"); wide.id = "scaleView"; wide.hidden = true;
  const branches = el("div", "branches");
  const pulse = el("span", "jev-pulse", "Jev");
  const taskBranch = el("p", "branch"), idleBranch = el("p", "branch");
  branches.append(pulse, taskBranch, idleBranch);
  const mosaic = el("canvas", "mosaic"); mosaic.id = "mosaic";
  mosaic.setAttribute("role", "img");
  mosaic.setAttribute("aria-label", "Each square is one simulated instance: gold runs its own task, bright gold runs a pooled task, pale is chilling out, dark has no session now");
  const legend = el("p", "mosaic-key", "Each square is one simulated instance · gold: own task · bright: picked-up task · pale: chill out");
  const focusLine = el("ol", "scale-focus"); focusLine.id = "scaleFocus";
  wide.append(branches, mosaic, legend, focusLine);
  deps.floor.insertBefore(wide, deps.status);

  /* ---------- controls in the existing compare bar ---------- */
  const btn = (id: string, cls: string, text: string): HTMLButtonElement => { const b = el("button", cls, text); b.type = "button"; b.id = id; b.hidden = true; deps.compare.append(b); return b; };
  const pauseBtn = btn("poolPause", "replay pool-pause", "Pause");
  pauseBtn.setAttribute("aria-pressed", "false");
  const upBtn = btn("scaleUp", "skipper stars", "Scale this to the stars");
  const downBtn = btn("scaleDown", "skipper stars", "Back to 1×");

  /* ---------- the panel beside the stage ---------- */
  const panel = el("section", "pool-panel"); panel.id = "poolPanel"; panel.hidden = true;
  panel.setAttribute("aria-label", "Jev task pooling, counted from the run");
  const ph = el("div", "pp-head");
  const ptitle = el("h3", "pp-title", "Jev task pooling");
  const plabel = el("p", "pp-label"); plabel.id = "poolLabel";
  ph.append(ptitle, plabel);
  const metrics = el("dl", "pp-metrics");
  const metric = (key: string, label: string): HTMLElement => {
    const wrap = el("div", "pp-m"); const dt = el("dt", "", label); const dd = el("dd", ""); dd.dataset.metric = key;
    wrap.append(dt, dd); metrics.append(wrap); return dd;
  };
  const mScale = metric("scale", "Scale · source maps · simulated instances");
  const mDecisions = metric("decisions", "Jev decisions");
  const mTask = metric("task", "Task checks: YES keep local · NO send to pool");
  const mIdle = metric("idle", "Idle checks: YES pick up · NO chill out");
  const mRate = metric("rate", "Decisions per second");
  const mLatency = metric("latency", "Jev decision time");
  const mElapsed = metric("elapsed", "Elapsed run time");
  const mStory = metric("story", "Story time");
  const mParallel = metric("parallel", "Parallel work now · peak");
  const mPool = metric("pool", "Pool waiting · picked up · completed");
  const ribbonHead = el("p", "pp-sub", "Parallel work over story time: task runs at once, Monday to Sunday");
  const ribbon = el("canvas", "ribbon"); ribbon.id = "ribbon";
  ribbon.setAttribute("role", "img"); ribbon.setAttribute("aria-label", "Bars: task runs overlapping at each moment of the story week");
  const logHead = el("p", "pp-sub", "Jev on stage this week");
  const log = el("ol", "jev-log"); log.id = "jevLog";
  const source = el("p", "pp-source"); source.id = "poolSource";
  const heavyN = ROWS.filter((r) => kindOf(r) === "heavy").length;
  source.textContent = `Cast: ${ROWS.length} public maps from /maps/, captured ${CAPTURED_ON}, self-reported and not verified. ${heavyN} reported a usage limit hit and play a heavy week; ${ROWS.length - heavyN} play a lite week. Each map keeps its own reported window. At 100× every instance is a numbered replica (map id plus -r000 to -r099), not work the named builders did. Tasks, sizes, allowances and session times are made up for the show; the board has none of them. Nothing here is sent to the board.`;
  const cast = el("ul", "pp-cast"); cast.id = "poolCast";
  for (const r of ROWS) {
    const li = el("li", kindOf(r));
    li.textContent = `${r.alias} · ${kindOf(r)} · ${r.days} days to ${r.day.slice(5)} · Codex week ${r.codexWeeklyPct === null ? "unknown" : `${r.codexWeeklyPct}%`}`;
    cast.append(li);
  }
  panel.append(ph, metrics, ribbonHead, ribbon, logHead, log, source, cast);
  deps.compare.after(panel);

  /* ---------- pause: holds the whole playback (day tweens, Jev's beats, slips in flight, the 100x run); elapsed time excludes it ---------- */
  let paused = false, held: Animation[] = [];
  function setPaused(p: boolean): void {
    if (p === paused) return;
    paused = p;
    if (p) pausedAt = now(); else if (pausedAt !== null) { const d = now() - pausedAt; pausedTotal += d; pauseAccum += d; pausedAt = null; }
    if (p) { held = deps.stage.getAnimations({ subtree: true }).filter((a) => a.playState === "running"); held.forEach((a) => a.pause()); }
    else { held.forEach((a) => { if (a.playState === "paused") a.play(); }); held = []; }
    pauseBtn.textContent = p ? "Resume" : "Pause";
    pauseBtn.setAttribute("aria-pressed", String(p));
    deps.stage.classList.toggle("paused", p);
    if (!panel.hidden) paint();
  }
  pauseBtn.addEventListener("click", () => setPaused(!paused));
  const showPause = (on: boolean): void => { pauseBtn.hidden = !on || deps.speed() <= 0; if (pauseBtn.hidden) setPaused(false); };

  const hold = (ms: number, tok: number): Promise<void> => new Promise((res, rej) => {
    if (tok !== deps.token()) { rej(new Cancel()); return; }
    if (deps.speed() <= 0) { res(); return; }
    const due = playNow() + ms * deps.speed();
    const tick = (): void => {
      if (tok !== deps.token()) { rej(new Cancel()); return; }
      if (playNow() >= due) res(); else win.setTimeout(tick, 30);
    };
    win.setTimeout(tick, 30);
  });
  /** Move a slip into its new place; with motion it travels there from where it was. */
  async function travel(slip: HTMLElement, dest: HTMLElement, tok: number): Promise<void> {
    const a = slip.isConnected ? slip.getBoundingClientRect() : null;
    dest.append(slip);
    if (deps.speed() <= 0 || !a) return;
    const b = slip.getBoundingClientRect();
    const move = slip.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) rotate(-10deg) scale(1.08)` }, { transform: "none" }], { duration: 700 * deps.speed(), easing: "cubic-bezier(.3,.7,.2,1)" });
    await move.finished.catch(() => undefined);
    if (tok !== deps.token()) throw new Cancel();
  }

  /* ---------- painting the counts ---------- */
  function paint(): void {
    const c: Counts = at(storyT);
    const secs = elapsedMs() / 1000;
    mScale.textContent = `${scale}× · ${result.sources} source maps · ${fmt(result.instances)} simulated instances`;
    mDecisions.textContent = `${fmt(c.decisions)} (task checks ${fmt(c.taskChecks)} · idle checks ${fmt(c.idleChecks)})`;
    mTask.textContent = `YES ${fmt(c.taskYes)} · NO ${fmt(c.taskNo)}`;
    mIdle.textContent = `YES ${fmt(c.idleYes)} · NO ${fmt(c.idleNo)}`;
    mRate.textContent = secs >= 0.05 ? `${(c.decisions / secs).toFixed(1)} simulated decision events per second (scripted mode)` : "drawn at once (Skip, a link or reduced motion): no playback to time";
    mLatency.textContent = "Scripted decisions: no model call, so no latency to measure";
    mElapsed.textContent = `${secs.toFixed(1)} s wall clock, pauses excluded`;
    const perHour = storyT > 0 && secs >= 0.05 ? secs / (storyT / 60) : 0;
    mStory.textContent = `${storyClock(Math.min(storyT, result.end))} · playback ${perHour > 0 ? `${perHour.toFixed(2)} s of wall time per story hour` : "not timed"}`;
    mParallel.textContent = `${fmt(c.parallelNow)} · ${fmt(c.parallelPeak)} task runs`;
    mPool.textContent = `${fmt(c.poolWaiting)} · ${fmt(c.pickedUp)} · ${fmt(c.completed)}`;
    poolCount.textContent = `All ${result.sources} maps: ${fmt(c.poolWaiting)} task${c.poolWaiting === 1 ? "" : "s"} waiting`;
    syncPool();
    taskBranch.textContent = `Task checks: YES ${fmt(c.taskYes)} keep local · NO ${fmt(c.taskNo)} to the pool`;
    idleBranch.textContent = `Idle checks: YES ${fmt(c.idleYes)} pick up · NO ${fmt(c.idleNo)} chill out`;
    drawRibbon();
  }
  // Ribbon samples, one per canvas column, from the same timeline.
  let ribbonCols: number[] = [], ribbonMax = 1;
  const cssWidth = (cv: HTMLCanvasElement): number => Math.max(10, Math.floor(cv.clientWidth || cv.parentElement?.clientWidth || 300));
  function sizeCanvas(cv: HTMLCanvasElement, height: number): CanvasRenderingContext2D | null {
    const w = cssWidth(cv);
    const dpr = win.devicePixelRatio || 1;
    // width and height each follow their own target: a canvas whose default width already matches keeps no default height
    const bw = Math.round(w * dpr), bh = Math.round(height * dpr);
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    const ctx = cv.getContext("2d");
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  function prepRibbon(): void {
    const w = cssWidth(ribbon);
    ribbonCols = Array.from({ length: w }, (_, i) => at((result.end * (i + 0.5)) / w).parallelNow);
    ribbonMax = Math.max(1, ...ribbonCols);
  }
  function drawRibbon(): void {
    // a resize changes the CSS width: resample so the week spans the new width exactly
    if (cssWidth(ribbon) !== ribbonCols.length) prepRibbon();
    const H = 56, ctx = sizeCanvas(ribbon, H);
    if (!ctx) return;
    const w = ribbonCols.length;
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = "#2a1416"; ctx.fillRect(0, 0, w, H);
    ctx.fillStyle = "#4a3020";
    for (let d = 1; d < 7; d++) ctx.fillRect(Math.round((w * d * DAY_MINUTES) / result.end), 0, 1, H);
    ctx.fillStyle = "#e0b04e";
    const upto = Math.floor((w * storyT) / result.end);
    for (let i = 0; i < Math.min(w, upto); i++) { const v = ribbonCols[i] ?? 0; if (v > 0) { const h = Math.max(1, (v / ribbonMax) * (H - 6)); ctx.fillRect(i, H - h, 1, h); } }
    ctx.fillStyle = "#f6dc8e"; ctx.fillRect(Math.min(w - 1, upto), 0, 1, H);
  }

  win.addEventListener("resize", () => {
    if (panel.hidden) return;
    if (deps.stage.classList.contains("scaled")) drawMosaic();
    paint();
  });

  /* ---------- the 1x stage: slips, beats and the pool ---------- */
  /** Every 1x slip, wherever it is (beat card, pool, a poster), with its travel cancelled: the run that owned it is over. */
  function clearSlips(): void {
    const all = [...row.querySelectorAll(".tslip"), ...deps.posters.flatMap((p) => [...p.querySelectorAll(".tslip")])];
    for (const s of all) { s.getAnimations().forEach((a) => a.cancel()); s.remove(); }
    syncPool();
  }
  const slipFor = (d: Decision): HTMLElement => {
    const s = el("div", "tslip");
    s.dataset.task = d.task?.id ?? "";
    s.append(el("b", "", d.task?.title ?? ""), el("span", "", `${d.task?.size ?? 0} units`));
    return s;
  };
  const focusOf = (m: Mode): string => (m === "burn" ? FOCUS.heavy : FOCUS.lite);
  const beatsOn = (m: Mode, i: number): Decision[] => result.decisions.filter((d) => d.instance === focusOf(m) && d.check === (m === "burn" ? "task" : "idle") && d.t >= i * DAY_MINUTES && d.t < (i + 1) * DAY_MINUTES);
  function setBeat(phase: string, d: Decision | null): void {
    beat.dataset.phase = phase;
    beat.dataset.check = d?.check ?? "";
    beat.dataset.answer = phase === "answer" && d ? (d.yes ? "yes" : "no") : "";
  }
  function idleCard(): void {
    setBeat("rest", null);
    who.textContent = "Jev";
    q.textContent = mode === "burn" ? "Checks every task before the session starts it" : "Checks every idle session for pooled work";
    room.textContent = ""; ans.textContent = ""; ans.className = "jb-ans";
    slot.textContent = "";
  }
  function logLine(d: Decision): void {
    const li = el("li", d.yes ? "yes" : "no");
    const title = d.task ? `“${d.task.title}” (${d.task.size} units)` : "";
    li.textContent = d.check === "task"
      ? `${storyClock(d.t)} · ${title}, ${d.room} of ${d.allowance} units left: ${d.yes ? "YES, kept local" : "NO, sent to the pool"}`
      : `${storyClock(d.t)} · idle, ${d.room} units and ${d.minutesLeft} min left: ${d.yes ? `YES, picked up ${title}` : "NO, chill out"}`;
    log.append(li);
  }

  async function taskBeat(d: Decision, i: number, tok: number): Promise<void> {
    const p = deps.posters[i];
    storyT = d.t; paint();
    setBeat("arrive", d);
    who.textContent = `${DAYS[i] ?? ""} session · ${storyClock(d.t)}`;
    q.textContent = "A task is ready to start";
    room.textContent = `Session allowance left: ${d.room} of ${d.allowance} units`;
    ans.textContent = ""; ans.className = "jb-ans";
    const s = slipFor(d);
    slot.textContent = ""; slot.append(s);
    p?.classList.add("playing");
    deps.status.textContent = `${DAYS[i] ?? ""}: “${d.task?.title ?? ""}” arrives in the session`;
    await hold(500, tok);
    setBeat("ask", d);
    q.textContent = `“${TASK_QUESTION}”`;
    await hold(1100, tok);
    setBeat("answer", d);
    ans.textContent = d.yes ? "YES · Keep it local" : "NO · Pool it";
    ans.className = `jb-ans ${d.yes ? "yes" : "no"}`;
    logLine(d);
    await hold(700, tok);
    if (d.yes && p) {
      s.classList.add("docked");
      try {
        await travel(s, p, tok);
        room.textContent = `Session allowance left: ${d.room - (d.task?.size ?? 0)} of ${d.allowance} units`;
        deps.status.textContent = `${DAYS[i] ?? ""}: kept local, it runs in this session`;
        await hold(500, tok);
      } finally { s.remove(); }
    } else {
      await travel(s, poolSlips, tok);
      storyT = d.t; paint();
      deps.status.textContent = `${DAYS[i] ?? ""}: sent to the shared pool, where an idle session can pick it up`;
      await hold(900, tok);
    }
  }
  /** Heavy view: the pooled slip is picked up by an idle lite session the same evening (switch to Lite to watch it). */
  async function leavePool(d: Decision, tok: number): Promise<void> {
    const id = d.task?.id ?? "";
    const taken = result.pickups.find((m) => m.task.id === id);
    if (!taken) return;
    const s = [...poolSlips.querySelectorAll<HTMLElement>(".tslip")].find((x) => x.dataset.task === id);
    storyT = Math.max(storyT, taken.t + 1); paint();
    if (!s) return;
    s.classList.add("taken");
    deps.status.textContent = `${storyClock(taken.t)}: an idle lite session picks it up from the pool`;
    await hold(900, tok);
    s.remove(); syncPool();
  }
  async function idleBeat(d: Decision, i: number, tok: number): Promise<void> {
    const p = deps.posters[i];
    // the pooled task arrives first: the heavy session that sent it, at that minute
    if (d.yes && d.task) {
      const sent = result.pooled.find((m) => m.task.id === d.task?.id);
      if (sent && ![...poolSlips.children].some((x) => x instanceof HTMLElement && x.dataset.task === d.task?.id)) {
        storyT = sent.t; paint();
        const s = slipFor(d);
        s.classList.add("arriving");
        poolSlips.append(s); syncPool();
        deps.status.textContent = `${storyClock(sent.t)}: a heavy session sends “${d.task.title}” to the pool`;
        await hold(900, tok);
        s.classList.remove("arriving");
      }
    }
    storyT = d.t; paint();
    setBeat("arrive", d);
    who.textContent = `${DAYS[i] ?? ""} session, idle · ${storyClock(d.t)}`;
    q.textContent = "This session has nothing to run";
    room.textContent = `Room left: ${d.room} of ${d.allowance} units · ${d.minutesLeft} min to session end`;
    ans.textContent = ""; ans.className = "jb-ans"; slot.textContent = "";
    p?.classList.add("playing");
    deps.status.textContent = `${DAYS[i] ?? ""}: the session is idle`;
    await hold(500, tok);
    setBeat("ask", d);
    q.textContent = `“${IDLE_QUESTION}”`;
    await hold(1100, tok);
    setBeat("answer", d);
    ans.textContent = d.yes ? "YES · Pick up a task" : "NO · Chill out";
    ans.className = `jb-ans ${d.yes ? "yes" : "no"}`;
    logLine(d);
    await hold(700, tok);
    if (d.yes && p) {
      const s = [...poolSlips.querySelectorAll<HTMLElement>(".tslip")].find((x) => x.dataset.task === d.task?.id) ?? slipFor(d);
      s.classList.add("docked");
      try { await travel(s, p, tok); } finally { s.remove(); }
      // the same slip becomes the existing +1 JOB slip of this session
      const ex = p.querySelector(".ex-job");
      if (ex) ex.textContent = d.task?.title ?? "";
      p.classList.add("has-extra");
      paint();
      deps.status.textContent = `${DAYS[i] ?? ""}: “${d.task?.title ?? ""}” moves in as +1 job`;
      await hold(800, tok);
    } else {
      paint();
      deps.status.textContent = `${DAYS[i] ?? ""}: no pooled task fits ${d.room} units in ${d.minutesLeft} min, so the session stays idle and the pool keeps its work`;
      await hold(1100, tok);
    }
  }

  /* ---------- 100x ---------- */
  let raf = 0, instances: { id: string; spans: { s: number; e: number; k: number }[] }[] = [], lastDecisions = -1, focusKey = "";
  function prepMosaic(): void {
    const by = new Map<string, { s: number; e: number; k: number }[]>();
    const add = (id: string, span: { s: number; e: number; k: number }): void => { const l = by.get(id); if (l) l.push(span); else by.set(id, [span]); };
    for (const x of result.runs) add(x.instance, { s: x.start, e: x.end, k: x.pickedUp ? 2 : 1 });
    for (const d of result.decisions) if (d.check === "idle" && !d.yes) add(d.instance, { s: d.t, e: d.t + d.minutesLeft, k: 3 });
    instances = [];
    ROWS.forEach((r) => { for (let i = 0; i < scale; i++) { const id = `${r.id}-r${String(i).padStart(3, "0")}`; instances.push({ id, spans: by.get(id) ?? [] }); } });
  }
  function drawMosaic(): void {
    const n = instances.length, w = Math.max(10, Math.floor(mosaic.clientWidth || 300));
    const cols = Math.max(10, Math.floor(w / (w < 500 ? 7 : 9))), cell = w / cols, rows = Math.ceil(n / cols);
    const ctx = sizeCanvas(mosaic, Math.ceil(rows * cell));
    if (!ctx) return;
    const colours = ["#2a1416", "#c98f2a", "#fff1bf", "#6f6a7e"];
    ctx.clearRect(0, 0, w, rows * cell);
    instances.forEach((inst, i) => {
      let k = 0;
      for (const sp of inst.spans) if (sp.s <= storyT && storyT < sp.e) { k = Math.max(k, sp.k === 3 ? (k === 0 ? 3 : k) : sp.k); }
      ctx.fillStyle = colours[k] ?? "#2a1416";
      ctx.fillRect((i % cols) * cell + 0.5, Math.floor(i / cols) * cell + 0.5, cell - 1.5, cell - 1.5);
    });
  }
  function paintScale(): void {
    const c = at(storyT);
    if (c.decisions !== lastDecisions) { lastDecisions = c.decisions; if (deps.speed() > 0) { pulse.classList.remove("on"); void pulse.offsetWidth; pulse.classList.add("on"); } }
    drawMosaic();
    const day = Math.min(6, Math.floor(storyT / DAY_MINUTES));
    deps.posters.forEach((p, i) => { p.classList.toggle("playing", i === day && storyT < result.end); p.classList.toggle("played", i < day || storyT >= result.end); });
    deps.setGauge(100 - (100 * Math.min(storyT, result.end)) / result.end, "Week left");
    // foreground: the latest three decisions of the two sessions the 1x stage follows, as readable slips
    const mine = result.decisions.filter((d) => (d.instance === FOCUS.heavy || d.instance === FOCUS.lite) && d.t <= storyT).slice(-3);
    const key = mine.map((d) => `${d.t}${d.check}${d.task?.id ?? ""}`).join("|");
    if (key !== focusKey) {
      focusKey = key;
      focusLine.textContent = "";
      for (const d of mine) {
        const li = el("li", `tslip ${d.yes ? "yes" : "no"}`);
        const verdict = d.check === "task" ? (d.yes ? "YES, kept local" : "NO, to the pool") : (d.yes ? "YES, picked up" : "NO, chill out");
        li.append(el("b", "", d.task?.title ?? "Idle session"), el("span", "", `${storyClock(d.t)} · ${d.instance === FOCUS.heavy ? "heavy" : "lite"} replica r000 · ${verdict}`));
        focusLine.append(li);
      }
    }
    paint();
  }
  function enterScale(n: number): void {
    deps.takeToken();
    win.cancelAnimationFrame(raf);
    scale = n; result = runAt(n); at = timeline(result);
    clearSlips(); idleCard();
    deps.clearStage();
    deps.stage.classList.add("scaled");
    row.hidden = true; wide.hidden = false; panel.hidden = false;
    upBtn.hidden = true; downBtn.hidden = false;
    deps.act.textContent = LABEL_100X;
    plabel.textContent = LABEL_100X;
    deps.status.textContent = "";
    deps.posters.forEach((p) => { p.classList.remove("gold", "cut", "cancel", "half", "spare", "has-extra"); const lab = p.querySelector(".lab"); if (lab) lab.textContent = ""; });
    prepMosaic();
    playScale();
  }
  function playScale(): void {
    win.cancelAnimationFrame(raf);
    storyT = 0; lastDecisions = -1; focusKey = "";
    startClock();
    prepRibbon();
    if (deps.speed() <= 0) { finishScale(); return; }
    deps.setBusy(true); showPause(true);
    let last = now();
    const step = (t: number): void => {
      if (!paused) storyT = Math.min(result.end, storyT + (t - last) * BUSY_MINUTES_PER_MS * (at(storyT).parallelNow > 0 ? 1 : QUIET_SPEEDUP));
      last = t;
      paintScale();
      if (storyT >= result.end) { finishScale(); return; }
      raf = win.requestAnimationFrame(step);
    };
    raf = win.requestAnimationFrame((t) => { last = t; step(t); });
  }
  function finishScale(): void {
    win.cancelAnimationFrame(raf);
    storyT = result.end;
    stopClock();
    paintScale();
    deps.setBusy(false); showPause(false);
    deps.status.textContent = "";
  }
  function leaveScale(): void {
    win.cancelAnimationFrame(raf);
    deps.stage.classList.remove("scaled");
    wide.hidden = true; downBtn.hidden = true;
    scale = 1; result = runAt(1); at = timeline(result);
  }
  upBtn.addEventListener("click", () => enterScale(100));
  downBtn.addEventListener("click", () => { leaveScale(); deps.replayWith(); });

  return {
    reset(): void {
      leaveScale();
      active = false; storyT = 0;
      row.hidden = true; panel.hidden = true; upBtn.hidden = true; showPause(false);
      clearSlips(); log.textContent = "";
    },
    begin(m: Mode, keepClock: boolean): void {
      const resume = keepClock && clockMode === m && wallStart > 0 && wallEnd === null;
      mode = m; active = true; storyT = 0;
      row.hidden = false; panel.hidden = false; upBtn.hidden = false;
      tag.textContent = LABEL_1X; plabel.textContent = LABEL_1X;
      idleCard();
      if (!resume) { startClock(); clockMode = m; }
      prepRibbon(); paint();
      showPause(true);
    },
    async day(m: Mode, i: number, tok: number): Promise<void> {
      if (!active || !BEAT_DAYS.includes(i)) return;
      const ds = beatsOn(m, i);
      for (const d of ds) { if (m === "burn") await taskBeat(d, i, tok); else await idleBeat(d, i, tok); }
      if (m === "burn") for (const d of ds) if (!d.yes) await leavePool(d, tok);
    },
    dayDone(i: number): void {
      if (!active) return;
      storyT = i >= 6 ? result.end : (i + 1) * DAY_MINUTES;
      paint();
    },
    finish(): void {
      if (!active) return;
      storyT = result.end; stopClock(); paint(); showPause(false);
      // a Skip or a deep link drew the beats at once: the card keeps the last decision on show
    },
    scaled: () => deps.stage.classList.contains("scaled"),
    clock: playNow,
    replayScale: () => { deps.takeToken(); prepMosaic(); playScale(); },
    skipScale: () => { deps.takeToken(); finishScale(); },
  };
}
