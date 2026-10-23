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
/** The big header over the posters in the 100x view (the 1x headers are in tm-run.ts). */
export const HEAD_100X = "100x sessions";
/** Story playback at 100x: one story hour per 0.6 s of wall time while work runs, 30 times faster through the quiet night. */
const BUSY_MINUTES_PER_MS = 60 / 600;
const QUIET_SPEEDUP = 30;
const fmt = (n: number): string => n.toLocaleString("en-US");
/** Blank slips drawn for other maps' waiting tasks; the count line carries the exact number. */
const OTHERS_SHOWN = 12;
/** The map alias behind an instance id ("<map id>-r000"), to name the session that sends or picks up a slip. */
const aliasOf = (instance: string): string => ROWS.find((r) => instance.startsWith(`${r.id}-r`))?.alias ?? "another map";

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
  // the card is a fixed box (tm.css): the slip and the answer share one row, and each part keeps its space when empty
  const play = el("div", "jb-play");
  const slot = el("div", "jb-slot");
  const ans = el("p", "jb-ans"); ans.id = "jevA";
  // the session's allowance as a bar under the slip (room left of the allowance)
  const meter = el("div", "jb-meter"); meter.id = "jevMeter";
  const bar = el("span", "jb-bar"); const fill = el("i", ""); bar.append(fill);
  const mlab = el("span", "jb-mlab");
  meter.append(bar, mlab);
  const left = el("div", "jb-left");
  left.append(slot, meter);
  play.append(left, ans);
  const setMeter = (room: number | null, allowance = 1, extra = ""): void => {
    meter.classList.toggle("off", room === null);
    if (room === null) { mlab.textContent = ""; return; }
    fill.style.setProperty("--w", String(Math.max(0, Math.min(1, room / Math.max(1, allowance)))));
    mlab.textContent = `${room} of ${allowance} units left${extra}`;
  };
  beat.append(who, q, play);
  const showAnswer = (yes: boolean, action: string): void => {
    ans.className = `jb-ans ${yes ? "yes" : "no"}`;
    ans.textContent = "";
    ans.append(el("b", "jb-word", yes ? "YES" : "NO"), el("span", "jb-act", action));
  };
  const clearAnswer = (): void => { ans.className = "jb-ans"; ans.textContent = ""; };
  const pool = el("div", "pool"); pool.id = "pool";
  const poolHead = el("p", "pool-head", "Shared pool"); poolHead.id = "poolHead";
  // the named slips are the two sessions the stage follows; blank slips stand for the other maps' waiting tasks, so the
  // box always holds as many slips as the count beside it (up to OTHERS_SHOWN blank ones)
  const poolSlips = el("div", "pool-slips"); poolSlips.id = "poolSlips";
  const poolOthers = el("div", "pool-others"); poolOthers.id = "poolOthers"; poolOthers.setAttribute("aria-hidden", "true");
  // one big labelled number; it flashes when it changes, so the count moves with the slips
  const poolCount = el("p", "pool-count"); poolCount.id = "poolCount";
  const poolN = el("b", "pool-n"); poolN.id = "poolN";
  const poolWord = el("span", "pool-word");
  poolCount.append(poolN, poolWord);
  const setPoolCount = (n: number, sources: number): void => {
    const was = poolN.textContent;
    poolN.textContent = fmt(n);
    poolWord.textContent = ` waiting across all ${sources} maps`;
    if (was !== "" && was !== poolN.textContent && deps.speed() > 0) { poolCount.classList.remove("bump"); void poolCount.offsetWidth; poolCount.classList.add("bump"); }
  };
  pool.append(poolHead, poolCount, poolSlips, poolOthers);
  const syncPool = (): void => {
    const waiting = at(storyT).poolWaiting;
    const live = poolSlips.querySelectorAll(".tslip:not(.taken)").length, others = Math.max(0, waiting - live);
    const shown = Math.min(OTHERS_SHOWN, others);
    while (poolOthers.children.length > shown) poolOthers.lastElementChild?.remove();
    while (poolOthers.children.length < shown) poolOthers.append(el("span", "oslip"));
  };
  row.append(beat, pool);
  deps.floor.insertBefore(row, deps.status);

  /* ---------- the 100x view: a mosaic of miniature sessions inside the same stage ---------- */
  const wide = el("div", "scale-view"); wide.id = "scaleView"; wide.hidden = true;
  const branches = el("div", "branches");
  const pulse = el("span", "jev-pulse", "Jev");
  // each check as a word and two coloured counts: green YES, red NO
  const branch = (label: string): { yes: HTMLElement; no: HTMLElement } => {
    const p = el("p", "branch"); const yes = el("span", "chip yes"), no = el("span", "chip no");
    p.append(el("b", "", label), yes, no); branches.append(p); return { yes, no };
  };
  branches.append(pulse);
  const taskBranch = branch("Task checks"), idleBranch = branch("Idle checks");
  const mosaic = el("canvas", "mosaic"); mosaic.id = "mosaic";
  mosaic.setAttribute("role", "img");
  mosaic.setAttribute("aria-label", "Each square is one simulated instance: gold runs its own task, bright gold runs a pooled task, pale is chilling out, dark has no session now");
  const legend = el("p", "mosaic-key");
  for (const [cls, label] of [["own", "Own task"], ["picked", "Picked up"], ["wait", "Waiting"]]) { const k = el("span", ""); k.append(el("i", `sw ${cls ?? ""}`), label ?? ""); legend.append(k); }
  const focusLine = el("ol", "scale-focus"); focusLine.id = "scaleFocus";
  wide.append(branches, mosaic, legend, focusLine);
  deps.floor.insertBefore(wide, deps.status);

  /* ---------- controls in the existing compare bar ---------- */
  const btn = (id: string, cls: string, text: string): HTMLButtonElement => { const b = el("button", cls, text); b.type = "button"; b.id = id; b.hidden = true; deps.compare.append(b); return b; };
  const pauseBtn = btn("poolPause", "replay pool-pause", "Pause");
  pauseBtn.setAttribute("aria-pressed", "false");
  const upBtn = btn("scaleUp", "skipper stars", "Scale this to the stars");
  const downBtn = btn("scaleDown", "skipper stars", "Back to 1×");

  /* ---------- the panel under the stage: a dashboard of tiles, each one number counted from the run ---------- */
  const panel = el("section", "pool-panel"); panel.id = "poolPanel"; panel.hidden = true;
  panel.setAttribute("aria-label", "Jev task pooling, counted from the run");
  const ph = el("div", "pp-head");
  const ptitle = el("h3", "pp-title", "Jev task pooling");
  ph.append(ptitle);
  const tiles = el("div", "pp-tiles");
  const SVG = "http://www.w3.org/2000/svg";
  const icon = (d: string): SVGSVGElement => {
    const s = doc.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "pp-icon"); s.setAttribute("aria-hidden", "true");
    const p = doc.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    s.append(p);
    return s;
  };
  /** A number the run counts, in its own element: data-metric names it for the tests and for reading aloud. */
  const num = (key: string, cls = "pp-n"): HTMLElement => { const n = el("span", cls); n.dataset.metric = key; return n; };
  const tile = (key: string, label: string, tone: string, path: string): { n: HTMLElement; sub: HTMLElement } => {
    const t = el("div", `pp-tile pp-m ${tone}`);
    const n = num(key);
    const sub = el("span", "pp-tsub");
    t.append(icon(path), n, el("span", "pp-tl", label), sub);
    tiles.append(t);
    return { n, sub };
  };
  /** A smaller count on a tile's second line, after any count already there. */
  const sub = (box: HTMLElement, key: string, label: string): HTMLElement => {
    if (box.childNodes.length > 0) box.append(" · ");
    const n = num(key, "pp-sn");
    box.append(n, ` ${label}`);
    return n;
  };
  const tDecisions = tile("decisions", "Jev decisions", "gold", "M12 2.5 21.5 12 12 21.5 2.5 12z M9 12h6");
  const mTaskChecks = sub(tDecisions.sub, "taskChecks", "task"), mIdleChecks = sub(tDecisions.sub, "idleChecks", "idle");
  // Jev's answers: one YES/NO split bar, then the four counts it is drawn from
  const tAnswers = tile("yes", "YES answers", "yes", "M5 12.5l4.5 4.5L19 7");
  const split = el("span", "pp-split"); split.setAttribute("aria-hidden", "true");
  const segs = ["kept", "pooled", "picked", "chill"].map((k) => { const i = el("i", k); split.append(i); return i; });
  tAnswers.sub.before(split);
  const mNo = sub(tAnswers.sub, "no", "NO");
  const runList = el("dl", "pp-runlist");
  const runRow = (key: string, label: string): HTMLElement => { const n = el("dd", ""); n.dataset.metric = key; runList.append(el("dt", "", label), n); return n; };
  const leg = (key: string, label: string): HTMLElement => runRow(key, label);
  const mTaskYes = leg("taskYes", "Kept local"), mTaskNo = leg("taskNo", "Sent to pool"), mIdleYes = leg("idleYes", "Picked up"), mIdleNo = leg("idleNo", "Nothing fits: wait");
  const tPool = tile("poolWaiting", "Waiting in pool", "no", "M3 7h18 M3 12h18 M3 17h18");
  const mPicked = sub(tPool.sub, "pickedUp", "picked up"), mCompleted = sub(tPool.sub, "completed", "done");
  const tPeak = tile("parallelPeak", "Peak parallel", "gold", "M5 20v-7 M10 20V5 M15 20v-9 M20 20V8");
  const mParallelNow = sub(tPeak.sub, "parallelNow", "now");
  // the run itself (scale, timing, decision time) behind one toggle
  const fine = el("details", "pp-fine"); fine.id = "poolRun";
  const mScale = runRow("scale", "Scale"), mInstances = runRow("instances", "Instances"), mElapsed = runRow("elapsed", "Run time");
  const mLatency = el("p", "pp-scripted"); mLatency.dataset.metric = "latency";
  fine.append(el("summary", "", "Run details"));
  const ribbonHead = el("p", "pp-sub"); ribbonHead.id = "ribbonTake";
  const ribbon = el("canvas", "ribbon"); ribbon.id = "ribbon";
  ribbon.setAttribute("role", "img"); ribbon.setAttribute("aria-label", "Bars: task runs overlapping at each moment of the story week");
  // Jev's decisions this week, as a strip straight under the posters: four cells reserved from the first frame
  const log = el("ol", "jev-log"); log.id = "jevLog"; log.hidden = true;
  log.setAttribute("aria-label", "Jev decisions this week");
  const LOG_CELLS = 4;
  const resetLog = (): void => {
    log.textContent = "";
    for (let k = 0; k < LOG_CELLS; k++) { const li = el("li", "empty"); li.append(el("span", "chip"), el("b", "lg-act"), el("span", "lg-when"), el("span", "lg-what")); log.append(li); }
    for (const p of deps.posters) p.querySelectorAll(".pchip").forEach((c) => c.remove());
  };
  resetLog();
  deps.run.after(log);
  const castBox = el("details", "pp-castbox"); castBox.id = "poolCastBox";
  const castSum = el("summary", "", `Cast: ${ROWS.length} public maps`);
  const source = el("p", "pp-source"); source.id = "poolSource";
  const heavyN = ROWS.filter((r) => kindOf(r) === "heavy").length;
  source.textContent = `Cast: ${ROWS.length} public maps from /maps/, captured ${CAPTURED_ON}, self-reported and not verified. ${heavyN} reported a usage limit hit and play a heavy week; ${ROWS.length - heavyN} play a lite week. Each map keeps its own reported window. At 100× every instance is a numbered replica (map id plus -r000 to -r099), not work the named builders did. Tasks, sizes, allowances and session times are made up for the show; the board has none of them. Nothing here is sent to the board.`;
  const cast = el("ul", "pp-cast"); cast.id = "poolCast";
  for (const r of ROWS) {
    const li = el("li", kindOf(r));
    li.textContent = `${r.alias} · ${kindOf(r)} · ${r.days} days to ${r.day.slice(5)} · Codex week ${r.codexWeeklyPct === null ? "unknown" : `${r.codexWeeklyPct}%`}`;
    cast.append(li);
  }
  castBox.append(castSum, source, cast);
  // the four tiles sit straight under the stage; the breakdown, the chart and the decision list wait behind Run details
  const cols = el("div", "pp-cols"), leftCol = el("div", "pp-col"), rightCol = el("div", "pp-col");
  leftCol.append(runList, mLatency); rightCol.append(ribbonHead, ribbon);
  cols.append(leftCol, rightCol);
  fine.append(cols, castBox);
  fine.addEventListener("toggle", () => { if (fine.open) paint(); });
  panel.append(ph, tiles, fine);
  (deps.floor.parentElement ?? deps.compare).after(panel);

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
    mScale.textContent = `${scale}× · ${result.sources} source maps`;
    mInstances.textContent = `${fmt(result.instances)} simulated instances`;
    tDecisions.n.textContent = fmt(c.decisions);
    mTaskChecks.textContent = fmt(c.taskChecks); mIdleChecks.textContent = fmt(c.idleChecks);
    tAnswers.n.textContent = fmt(c.taskYes + c.idleYes); mNo.textContent = fmt(c.taskNo + c.idleNo);
    mTaskYes.textContent = fmt(c.taskYes); mTaskNo.textContent = fmt(c.taskNo); mIdleYes.textContent = fmt(c.idleYes); mIdleNo.textContent = fmt(c.idleNo);
    const all = Math.max(1, c.decisions);
    [c.taskYes, c.taskNo, c.idleYes, c.idleNo].forEach((v, i) => { segs[i]?.style.setProperty("--w", String(v / all)); });
    tPool.n.textContent = fmt(c.poolWaiting); mPicked.textContent = fmt(c.pickedUp); mCompleted.textContent = fmt(c.completed);
    tPeak.n.textContent = fmt(c.parallelPeak); mParallelNow.textContent = fmt(c.parallelNow);
    mLatency.textContent = "Scripted run, no model calls";
    mElapsed.textContent = `${secs.toFixed(1)} s run, pauses excluded`;
    setPoolCount(c.poolWaiting, result.sources);
    syncPool();
    taskBranch.yes.textContent = `YES ${fmt(c.taskYes)}`; taskBranch.no.textContent = `NO ${fmt(c.taskNo)}`;
    idleBranch.yes.textContent = `YES ${fmt(c.idleYes)}`; idleBranch.no.textContent = `NO ${fmt(c.idleNo)}`;
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
  let ribbonW = 0;
  const ROW_H = 40, ROW_GAP = 8;
  function prepRibbon(): void {
    ribbonW = cssWidth(ribbon);
    // each day is dw pixels wide and starts at its own midnight; the few minutes after Sunday midnight are not drawn
    const dw = Math.max(1, Math.floor(ribbonW / 4)), n = dw * 7;
    ribbonCols = Array.from({ length: n }, (_, i) => at(((i + 0.5) * DAY_MINUTES) / dw).parallelNow);
    ribbonMax = Math.max(1, ...ribbonCols);
    // the takeaway is the run's own peak and the first minute it is reached, from the event stream, not the pixels
    const peak = at(result.end).parallelPeak;
    const first = [...new Set(result.runs.map((x) => x.start))].sort((a, b) => a - b).find((t) => at(t).parallelNow === peak);
    ribbonHead.textContent = peak > 0 && first !== undefined ? `Busiest: ${fmt(peak)} task${peak === 1 ? "" : "s"} at once, ${storyClock(first)}` : "No tasks ran at once";
  }
  function drawRibbon(): void {
    // a resize changes the CSS width: resample so the week spans the new width exactly
    if (cssWidth(ribbon) !== ribbonW) prepRibbon();
    const H = ROW_H * 2 + ROW_GAP, ctx = sizeCanvas(ribbon, H);
    if (!ctx) return;
    const w = ribbonW, dw = Math.max(1, Math.floor(w / 4)), n = ribbonCols.length;
    const place = (i: number): { x: number; y: number } => { const row = i < dw * 4 ? 0 : 1; return { x: i - row * dw * 4, y: row * (ROW_H + ROW_GAP) }; };
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = "#2a1416"; ctx.fillRect(0, 0, dw * 4, ROW_H); ctx.fillRect(0, ROW_H + ROW_GAP, dw * 3, ROW_H);
    ctx.font = "600 12px sans-serif";
    DAYS.forEach((d, k) => { const p = place(k * dw); ctx.fillStyle = "#4a3020"; if (p.x > 0) ctx.fillRect(p.x, p.y, 1, ROW_H); ctx.fillStyle = "#a08a6a"; ctx.fillText(d, p.x + 4, p.y + 13); });
    ctx.fillStyle = "#e0b04e";
    const upto = Math.min(n, Math.floor((storyT * dw) / DAY_MINUTES));
    for (let i = 0; i < upto; i++) { const v = ribbonCols[i] ?? 0; if (v > 0) { const h = Math.max(1, (v / ribbonMax) * (ROW_H - 18)); const p = place(i); ctx.fillRect(p.x, p.y + ROW_H - h, 1, h); } }
    const cur = place(Math.min(n - 1, upto));
    ctx.fillStyle = "#f6dc8e"; ctx.fillRect(cur.x, cur.y, 1, ROW_H);
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
    clearAnswer(); slot.textContent = ""; setMeter(null);
  }
  function logLine(d: Decision): void {
    // one compact row: a YES/NO chip, what it did, when, and the task with the room the session had
    const act = d.check === "task" ? (d.yes ? "kept local" : "to pool") : (d.yes ? "picked up" : "nothing fits");
    const what = d.task ? `“${d.task.title}” (${d.task.size} units)` : "idle";
    const room = d.check === "task" ? `${d.room} of ${d.allowance} units left` : `${d.room} units, ${d.minutesLeft} min left`;
    let li = log.querySelector<HTMLLIElement>("li.empty");
    if (!li) { li = el("li", ""); li.append(el("span", "chip"), el("b", "lg-act"), el("span", "lg-when"), el("span", "lg-what")); log.append(li); }
    li.className = d.yes ? "yes" : "no";
    const [chip, actEl, whenEl, whatEl] = [li.querySelector(".chip"), li.querySelector(".lg-act"), li.querySelector(".lg-when"), li.querySelector(".lg-what")];
    if (chip) { chip.className = `chip ${d.yes ? "yes" : "no"}`; chip.textContent = d.yes ? "YES" : "NO"; }
    if (actEl) actEl.textContent = act;
    if (whenEl) whenEl.textContent = storyClock(d.t);
    if (whatEl) whatEl.textContent = `${what} · ${room}`;
    // the full row on hover, keyboard focus or tap, since the cell truncates the task
    const full = `${d.yes ? "YES" : "NO"}, ${act} · ${storyClock(d.t)} · ${what} · ${room}`;
    li.title = full; li.dataset.full = full; li.tabIndex = 0; li.setAttribute("aria-label", full);
    log.querySelectorAll("li.now").forEach((x) => x.classList.remove("now"));
    if (deps.speed() > 0) li.classList.add("now");
    const day = Math.min(6, Math.floor(d.t / DAY_MINUTES)), p = deps.posters[day];
    if (p) {
      const pc = el("span", `pchip ${d.yes ? "yes" : "no"}`, d.yes ? "YES" : "NO");
      pc.tabIndex = 0;
      pc.dataset.task = d.task ? d.task.title : "idle session";
      pc.setAttribute("aria-label", `${DAYS[day] ?? ""}: ${d.yes ? "YES" : "NO"}, ${act}, ${pc.dataset.task}`);
      pc.style.setProperty("--k", String(p.querySelectorAll(".pchip").length));
      p.append(pc);
    }
  }

  async function taskBeat(d: Decision, i: number, tok: number): Promise<void> {
    const p = deps.posters[i];
    // counts stand just before this check until its slip moves, so the pool count never runs ahead of the box
    storyT = Math.max(storyT, d.t - 1); paint();
    setBeat("arrive", d);
    who.textContent = `${DAYS[i] ?? ""} session · ${storyClock(d.t)}`;
    q.textContent = "A task is ready to start";
    clearAnswer(); setMeter(d.room, d.allowance);
    const s = slipFor(d);
    slot.textContent = ""; slot.append(s);
    p?.classList.add("playing");
    deps.status.textContent = "";
    await hold(500, tok);
    setBeat("ask", d);
    q.textContent = `“${TASK_QUESTION}”`;
    await hold(1100, tok);
    setBeat("answer", d);
    showAnswer(d.yes, d.yes ? "Keep local" : "Pool it");
    logLine(d);
    if (d.yes) { storyT = d.t; paint(); }
    await hold(700, tok);
    if (d.yes && p) {
      s.classList.add("docked");
      try {
        await travel(s, p, tok);
        setMeter(d.room - (d.task?.size ?? 0), d.allowance);
        deps.status.textContent = `${DAYS[i] ?? ""}: kept local, it runs in this session`;
        await hold(500, tok);
      } finally { s.remove(); }
    } else {
      // the slip is in the pool box from the moment it starts to travel there, and the count goes up with it
      const landing = travel(s, poolSlips, tok);
      storyT = d.t; paint();
      await landing;
      deps.status.textContent = `${DAYS[i] ?? ""}: “${d.task?.title ?? ""}” waits in the shared pool for an idle session`;
      await hold(1400, tok);
    }
  }
  /** Heavy view: the pooled slip is picked up by an idle lite session the same evening (switch to Lite to watch it). */
  async function leavePool(d: Decision, tok: number): Promise<void> {
    const id = d.task?.id ?? "";
    const taken = result.pickups.find((m) => m.task.id === id);
    if (!taken) return;
    const s = [...poolSlips.querySelectorAll<HTMLElement>(".tslip")].find((x) => x.dataset.task === id);
    storyT = Math.max(storyT, taken.t + 1);
    if (!s) { paint(); return; }
    // the slip says who took it, then leaves the box
    const by = aliasOf(taken.instance);
    s.classList.add("taken");
    s.append(el("i", "taken-by", `Picked up by ${by}`));
    paint();
    deps.status.textContent = `${storyClock(taken.t)}: ${by}’s idle lite session picks up “${taken.task.title}” from the pool`;
    await hold(1600, tok);
    if (deps.speed() > 0) {
      const out = s.animate([{ opacity: 0.45 }, { opacity: 0, transform: "translateX(28px) rotate(6deg)" }], { duration: 500 * deps.speed(), fill: "forwards" });
      await out.finished.catch(() => undefined);
      if (tok !== deps.token()) throw new Cancel();
    }
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
        deps.status.textContent = `${storyClock(sent.t)}: ${aliasOf(sent.instance)}’s heavy session answers NO and sends “${d.task.title}” to the pool`;
        await hold(1400, tok);
        s.classList.remove("arriving");
      }
    }
    storyT = Math.max(storyT, d.t - 1); paint();
    setBeat("arrive", d);
    who.textContent = `${DAYS[i] ?? ""} session, idle · ${storyClock(d.t)}`;
    q.textContent = "This session has nothing to run";
    clearAnswer(); slot.textContent = ""; setMeter(d.room, d.allowance, ` · ${d.minutesLeft} min`);
    p?.classList.add("playing");
    deps.status.textContent = "";
    await hold(500, tok);
    setBeat("ask", d);
    q.textContent = `“${IDLE_QUESTION}”`;
    await hold(1100, tok);
    setBeat("answer", d);
    showAnswer(d.yes, d.yes ? "Pick up" : "Nothing fits: wait");
    logLine(d);
    const pick = d.yes ? [...poolSlips.querySelectorAll<HTMLElement>(".tslip")].find((x) => x.dataset.task === d.task?.id) ?? null : null;
    if (pick) {
      // the slip says who takes it before it leaves the box
      const by = aliasOf(d.instance);
      pick.append(el("i", "taken-by", `Picked up by ${by}`));
      deps.status.textContent = `${DAYS[i] ?? ""}: ${by}’s session picks up “${d.task?.title ?? ""}” from the pool`;
    }
    await hold(pick ? 1200 : 700, tok);
    if (d.yes && p) {
      const s = pick ?? slipFor(d);
      s.querySelector(".taken-by")?.remove();
      s.classList.add("docked");
      // the count drops as the slip leaves the box
      const leaving = travel(s, p, tok);
      storyT = d.t; paint();
      try { await leaving; } finally { s.remove(); }
      // the same slip becomes the existing +1 JOB slip of this session
      const ex = p.querySelector(".ex-job");
      if (ex) ex.textContent = d.task?.title ?? "";
      p.classList.add("has-extra");
      paint();
      deps.status.textContent = `${DAYS[i] ?? ""}: “${d.task?.title ?? ""}” moves in as +1 job`;
      await hold(800, tok);
    } else {
      storyT = d.t; paint();
      deps.status.textContent = `${DAYS[i] ?? ""}: no pooled task fits, so the session stays idle`;
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
        const verdict = d.check === "task" ? (d.yes ? "YES, kept local" : "NO, to the pool") : (d.yes ? "YES, picked up" : "NO, nothing fits");
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
    row.hidden = true; log.hidden = true; wide.hidden = false; panel.hidden = false;
    upBtn.hidden = true; downBtn.hidden = false;
    deps.act.textContent = HEAD_100X;
    deps.status.textContent = "";
    deps.posters.forEach((p) => { p.classList.remove("gold", "cut", "cancel", "half", "spare", "has-extra"); const lab = p.querySelector(".lab"); if (lab) lab.textContent = ""; });
    // size the grid now, in the same frame the view appears, so its first painted frame is already its final size
    storyT = 0; prepMosaic(); drawMosaic();
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
      row.hidden = true; log.hidden = true; panel.hidden = true; upBtn.hidden = true; showPause(false);
      clearSlips(); resetLog();
    },
    begin(m: Mode, keepClock: boolean): void {
      const resume = keepClock && clockMode === m && wallStart > 0 && wallEnd === null;
      mode = m; active = true; storyT = 0;
      row.hidden = false; log.hidden = false; panel.hidden = false; upBtn.hidden = false;
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
