// /tm/ "The Run": the TokenMax show. A visitor picks a situation, the week plays on the stage, the ending lands (the
// curtain drops mid-week, or a ghost light on a half-empty house), "See it with TokenMax" replays the week with
// TokenMax and ends on a curtain call. Every animation can be skipped; reduced motion, Skip and the deep links draw
// end states. Map your real week below the show (#command) is the one next step: a plain prompt to paste into Claude
// Code or Codex. Built into site/tm/tm.js by scripts/build-tm.ts; adapted from The Run prototype (2026-10-21). Every
// number here is illustrative.

import {
  cardHeadline, dayLabels, limitDayIndexes, NOT_A_RESULT, NOT_RECORDED, parseWeek, periodLine, SAMPLE_WEEK, situationOf, stageHeadline, stageSubtitle,
  weekLines, type Week,
} from "./tm-week.ts";
import { ALIAS_MESSAGE, ALIAS_PATTERN, newRequestKey, rawNumberProblem, rejectionMessage, submitBody, weekToPayload } from "./tm-submit.ts";

export type Mode = "burn" | "under";
export type View = "without" | "with";
export type Scenario = {
  readonly without: readonly number[];
  readonly with: readonly number[];
  readonly extra: readonly number[];
  readonly jobs: readonly string[];
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** A full house is roughly one seventh of the week. */
export const NIGHT = 14;
/** The under-use target: the gauge's TARGET mark sits at 15% left. */
export const TARGET_LEFT = 15;
export const DEEP_LINKS = ["burn-before", "burn-after", "under-before", "under-after", "demo-burn", "demo-under", "command"];

export const SCENARIOS: Readonly<Record<Mode, Scenario>> = {
  burn: {
    without: [26, 26, 26, 26, 26, 26, 26],
    with: [13, 13, 13, 13, 13, 13, 13],
    extra: [0, 0, 0, 0, 0, 0, 0],
    jobs: ["", "", "", "", "", "", ""],
  },
  under: {
    // every step in the royal box
    without: [8, 7, 9, 6, 8, 5, 4],
    // the same work in cheaper seats: even more room left over
    with: [4, 3, 5, 3, 4, 3, 2],
    // jobs TokenMax finds to fill that room
    extra: [0, 11, 9, 11, 10, 11, 12],
    jobs: ["", "Review last week’s PRs", "", "", "Write tests for the login page", "", ""],
  },
};

/** Seats filled (of 12) on a night that uses u% of the week. */
export function seatsFor(u: number): number {
  return Math.max(0, Math.min(12, Math.round((u / NIGHT) * 12)));
}

/** The deep link a hash names, or null. */
export function parseHash(hash: string): { readonly kind: "end"; readonly mode: Mode; readonly view: View } | { readonly kind: "demo"; readonly mode: Mode } | { readonly kind: "command" } | null {
  const h = hash.replace(/^#/, "");
  if (h === "command") return { kind: "command" };
  const end = /^(burn|under)-(after|before)$/.exec(h);
  if (end) return { kind: "end", mode: end[1] === "burn" ? "burn" : "under", view: end[2] === "after" ? "with" : "without" };
  const demo = /^demo-(burn|under)$/.exec(h);
  if (demo) return { kind: "demo", mode: demo[1] === "burn" ? "burn" : "under" };
  return null;
}

type Ctor<T> = new (...args: never[]) => T;
function inside<T extends Element>(root: ParentNode, selector: string, kind: Ctor<T>): T {
  const node = root.querySelector(selector);
  if (!(node instanceof kind)) throw new Error(`The Run: ${selector} is missing`);
  return node;
}
function every<T extends Element>(root: ParentNode, selector: string, kind: Ctor<T>): T[] {
  return [...root.querySelectorAll(selector)].filter((node): node is T => node instanceof kind);
}

class Cancel extends Error {}
type Frame = { transform: string; offset?: number; easing?: string };
type Poster = { li: HTMLLIElement; day: HTMLElement; seats: HTMLElement[]; lab: HTMLElement; stamp: HTMLElement; filled: number | null; label: string | null };
type Particle = { x: number; y: number; vx: number; vy: number; r: number; vr: number; s: number; c: string; rose: boolean };

/** Wires The Run on a page that carries its markup (site/tm/index.html). */
export function startTheRun(doc: Document): void {
  const view = doc.defaultView;
  if (!view) return;
  const win: Window = view;
  const root = doc.documentElement;
  const id = <T extends Element>(name: string, kind: Ctor<T>): T => inside(doc, `#${name}`, kind);

  const reduceQuery = win.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = reduceQuery.matches;
  // data: the week on stage is the visitor's (or the sample's) own numbers; example: a scripted With week shown after them.
  const st: { mode: Mode | null; routed: boolean; view: View; token: number; speed: number; busy: boolean; data: Week | null; example: boolean } = {
    mode: null, routed: false, view: "without", token: 0, speed: 1, busy: false, data: null, example: false,
  };
  const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);

  /* ---------- build ---------- */
  const bulbsEl = id("bulbs", HTMLElement);
  const NB = win.innerWidth < 760 ? 20 : 30;
  for (let i = 0; i < NB; i++) { const b = doc.createElement("i"); b.className = "bulb on"; bulbsEl.appendChild(b); }
  const bulbs = every(bulbsEl, "i", HTMLElement);

  const ticks = id("ticks", SVGGElement);
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI - (Math.PI * i) / 10, r1 = 88, r2 = i % 5 === 0 ? 76 : 82;
    const l = doc.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", String(120 + r1 * Math.cos(a))); l.setAttribute("y1", String(120 - r1 * Math.sin(a)));
    l.setAttribute("x2", String(120 + r2 * Math.cos(a))); l.setAttribute("y2", String(120 - r2 * Math.sin(a)));
    l.setAttribute("class", "tick"); ticks.appendChild(l);
  }
  const targetMark = id("targetMark", SVGGElement);
  {
    const a = Math.PI - (Math.PI * TARGET_LEFT) / 100;
    const ln = id("targetLine", SVGLineElement);
    ln.setAttribute("x1", String(120 + 94 * Math.cos(a))); ln.setAttribute("y1", String(120 - 94 * Math.sin(a)));
    ln.setAttribute("x2", String(120 + 114 * Math.cos(a))); ln.setAttribute("y2", String(120 - 114 * Math.sin(a)));
    ln.setAttribute("stroke", "#e0b04e"); ln.setAttribute("stroke-width", "5");
    // the label sits inside the dial, so it is never clipped at the stage edge
    const t = doc.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(120 + 66 * Math.cos(a) - 4)); t.setAttribute("y", String(120 - 66 * Math.sin(a) + 2));
    t.setAttribute("text-anchor", "start"); t.textContent = "TARGET"; targetMark.appendChild(t);
  }

  const MASK = '<svg class="art" viewBox="0 0 40 40" aria-hidden="true"><path d="M6 8c9-4 19-4 28 0 0 14-4 26-14 26S6 22 6 8z" fill="currentColor" opacity=".9"/><path d="M12 15c2-2 5-2 7 0M21 15c2-2 5-2 7 0" stroke="#140a0c" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M13 23c4 5 10 5 14 0" stroke="#140a0c" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>';
  const runEl = id("run", HTMLOListElement);
  const posters: Poster[] = DAYS.map((d, i) => {
    const li = doc.createElement("li");
    li.className = "poster";
    li.innerHTML = `<span class="day">${d}</span><span class="time">8 PM</span>${MASK}<span class="seats">${"<i></i>".repeat(12)}</span><span class="lab">Tonight</span><span class="stamp">CANCELLED</span><span class="extra"><b>+1 job</b><span class="ex-job">${SCENARIOS.under.jobs[i] ?? ""}</span></span>`;
    li.setAttribute("aria-label", LONG[i] ?? d);
    runEl.appendChild(li);
    return { li, day: inside(li, ".day", HTMLElement), seats: every(li, ".seats i", HTMLElement), lab: inside(li, ".lab", HTMLElement), stamp: inside(li, ".stamp", HTMLElement), filled: null, label: null };
  });
  const stubsEl = id("stubs", HTMLOListElement);
  const stubs = DAYS.map((d) => { const li = doc.createElement("li"); li.textContent = d; stubsEl.appendChild(li); return li; });

  const stage = id("stage", HTMLElement), opening = id("opening", HTMLElement), drop = id("drop", HTMLElement), ghost = id("ghost", HTMLElement);
  const dim = id("dim", HTMLElement), gauge = id("gauge", HTMLElement), needle = id("needle", SVGGElement), arc = id("gaugeArc", SVGPathElement);
  const leftPct = id("leftPct", HTMLElement), statusEl = id("status", HTMLElement), actEl = id("act", HTMLElement);
  const gaugeBadge = id("gaugeBadge", HTMLElement), foundEl = id("found", HTMLElement);
  const skipBtn = id("skip", HTMLButtonElement), replayBtn = id("replay", HTMLButtonElement);
  const pick = inside(doc, ".pick", HTMLElement), keepLights = id("keepLights", HTMLElement);
  const dataEnd = id("dataEnd", HTMLElement), dataBig = id("dataBig", HTMLElement), dataSub = id("dataSub", HTMLElement);
  const exampleTag = id("exampleTag", HTMLElement), gaugeName = id("gaugeName", HTMLElement);
  const pickBtns = every(doc, ".pick-btn", HTMLButtonElement), segBtns = every(doc, "#seg button", HTMLButtonElement);
  const seg = id("seg", HTMLElement), compare = id("compare", HTMLElement), command = id("command", HTMLElement);
  const ghostBtn = id("ghostBtn", HTMLButtonElement), dropBtn = id("dropBtn", HTMLButtonElement);

  /* ---------- timing helpers ---------- */
  const live = (tok: number): void => { if (tok !== st.token) throw new Cancel(); };
  const wait = (ms: number, tok: number): Promise<void> => new Promise((res, rej) => {
    const d = ms * st.speed;
    if (d <= 0) { if (tok !== st.token) rej(new Cancel()); else res(); return; }
    win.setTimeout(() => { if (tok !== st.token) rej(new Cancel()); else res(); }, d);
  });
  const tween = (a: number, b: number, ms: number, fn: (v: number, p: number) => void, tok: number): Promise<void> => new Promise((res, rej) => {
    const d = ms * st.speed;
    if (d <= 0) { fn(b, 1); res(); return; }
    const t0 = win.performance.now();
    const step = (now: number): void => {
      if (tok !== st.token) { rej(new Cancel()); return; }
      const p = Math.min(1, (now - t0) / d);
      fn(a + (b - a) * p, p);
      if (p < 1) win.requestAnimationFrame(step); else res();
    };
    win.requestAnimationFrame(step);
  });
  /** Animate transform frames; the end frame is kept as an inline style. A cancelled animation resolves too. */
  const anim = (el: HTMLElement, frames: readonly Frame[], ms: number, easing?: string): Promise<void> => {
    const d = ms * st.speed;
    const end = frames[frames.length - 1]?.transform ?? "";
    if (d <= 0) { el.style.transform = end; return Promise.resolve(); }
    const opts: KeyframeAnimationOptions = { duration: d, fill: "forwards" };
    if (easing !== undefined) opts.easing = easing;
    const a = el.animate(frames.map((f) => ({ ...f })), opts);
    return a.finished.then(() => { el.style.transform = end; a.cancel(); }, () => undefined);
  };
  const ignoreCancel = (e: unknown): void => { if (!(e instanceof Cancel)) throw e; };

  /* ---------- gauge ---------- */
  function setGauge(value: number): void {
    const left = Math.max(0, Math.min(100, value));
    needle.setAttribute("transform", `rotate(${-90 + (180 * left) / 100} 120 120)`);
    arc.setAttribute("stroke-dasharray", `${left} 100`);
    leftPct.textContent = `${Math.round(left)}%`;
    const lit = Math.ceil((left / 100) * NB - 0.001);
    const burnWithout = st.mode === "burn" && st.view === "without";
    bulbs.forEach((b, i) => { b.classList.toggle("on", i < lit); b.classList.toggle("flick", burnWithout && left < 22 && left > 0 && i >= lit - 3 && i < lit); });
    gauge.classList.toggle("low", burnWithout && left < 20);
    gauge.classList.toggle("hit", st.mode === "under" && st.view === "with" && left <= TARGET_LEFT);
    dim.style.opacity = st.mode === "burn" ? (((100 - left) / 100) * (st.view === "without" ? 0.42 : 0.22)).toFixed(3) : "0";
  }

  /* ---------- resets ---------- */
  function clearDrop(): void {
    drop.getAnimations().forEach((a) => a.cancel());
    drop.style.transform = "translateY(-103%)";
    drop.classList.remove("show-copy");
  }
  function fillSeats(p: Poster, n: number): void { p.seats.forEach((s, i) => s.classList.toggle("f", i < n)); }
  function resetWeek(): void {
    posters.forEach((p, i) => { p.li.className = "poster"; p.day.textContent = DAYS[i] ?? ""; p.stamp.textContent = "CANCELLED"; fillSeats(p, 0); p.lab.textContent = "Tonight"; p.filled = null; p.label = null; });
    dataEnd.hidden = true; exampleTag.hidden = true; gaugeName.textContent = "House lights";
    stubs.forEach((s) => { s.className = ""; s.style.removeProperty("--d"); });
    stage.classList.remove("call", "anim", "settled");
    gaugeBadge.textContent = "";
    foundEl.hidden = true;
    ghost.classList.remove("on");
    bulbsEl.classList.remove("chase");
    stopConfetti();
    statusEl.classList.remove("warn");
    setGauge(100);
  }

  /* ---------- the week ---------- */
  function setBusy(b: boolean): void { st.busy = b; skipBtn.hidden = !(b && st.speed > 0); }
  function showFound(n: number): void {
    const alone = Math.round(100 - sum(SCENARIOS.under.with));
    foundEl.hidden = false;
    const main = id("foundMain", HTMLElement), sub = id("foundSub", HTMLElement), ex = id("foundEx", HTMLElement);
    if (!n) {
      main.textContent = `Cheaper seats alone would leave ${alone}% unused`;
      sub.textContent = "So TokenMax looks for more jobs to fill the room.";
      ex.textContent = "";
      return;
    }
    main.textContent = `TokenMax found ${n} more job${n > 1 ? "s" : ""} worth running`;
    sub.textContent = `Cheaper seats alone would leave ${alone}% unused.`;
    ex.textContent = "Like “Review last week’s PRs”";
  }
  async function playWeek(view: View, tok: number): Promise<void> {
    const mode = st.mode;
    if (!mode) return;
    const s = SCENARIOS[mode];
    st.view = view;
    setBusy(true);
    segBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === view)));
    clearDrop(); resetWeek();
    exampleTag.hidden = !(st.example && view === "with");
    gauge.classList.toggle("calm", view === "with");
    const underWith = mode === "under" && view === "with";
    actEl.textContent = view === "without" ? "Without TokenMax · every step in the royal box"
      : underWith ? "With TokenMax · cheaper seats, then more jobs" : "With TokenMax · each step in its seat";
    if (underWith) showFound(0);
    statusEl.textContent = underWith ? "Cheaper seats leave even more room spare…" : "Curtain up. Monday night…";
    await wait(underWith ? 1100 : 350, tok);
    let left = 100, found = 0;
    const DAY = 640;
    for (let i = 0; i < 7; i++) {
      const p = posters[i];
      if (!p) continue;
      const base = (view === "without" ? s.without[i] : s.with[i]) ?? 0;
      const ex = underWith ? s.extra[i] ?? 0 : 0;
      p.li.classList.add("playing");
      if (mode === "burn" && view === "without" && left - base <= 0) {
        const frac = left / base;
        statusEl.textContent = `${LONG[i] ?? ""}. The lights are failing…`; statusEl.classList.add("warn");
        await tween(left, 0, DAY * 1.6 * frac, (g, pr) => { setGauge(g); fillSeats(p, Math.round(pr * 12 * frac)); }, tok);
        await dropCurtain(i, tok);
        if (tok === st.token) { setBusy(false); keepLights.classList.add("shown"); }
        return;
      }
      const baseSeats = mode === "burn" ? 12 : seatsFor(base);
      const from = left;
      await tween(from, from - base, ex ? DAY * 0.55 : DAY, (g, pr) => { setGauge(g); fillSeats(p, Math.round(pr * baseSeats)); }, tok);
      left -= base;
      let seats = baseSeats;
      if (ex) {
        found++;
        p.li.classList.add("has-extra");
        showFound(found);
        const job = s.jobs[i] ?? "";
        statusEl.textContent = job ? `${LONG[i] ?? ""}: TokenMax found “${job}”` : `${LONG[i] ?? ""}: one more job fits`;
        await wait(320, tok);
        seats = seatsFor(base + ex);
        const mid = left;
        await tween(mid, mid - ex, DAY * 0.75, (g, pr) => { setGauge(g); fillSeats(p, baseSeats + Math.round(pr * (seats - baseSeats))); }, tok);
        left -= ex;
      }
      p.li.classList.remove("playing");
      p.filled = seats;
      if (mode === "under" && view === "without") { p.li.classList.add("half"); p.lab.textContent = `${12 - seats} empty`; }
      else if (underWith && !ex) { p.li.classList.add("played", "spare"); p.lab.textContent = "Room spare"; p.label = "Room spare"; }
      else { p.li.classList.add("played"); p.lab.textContent = "Full house"; p.label = underWith ? "Full house" : "Sold out"; }
      if (mode === "burn" && view === "without" && left < 30) { statusEl.textContent = "Lights running low…"; statusEl.classList.add("warn"); }
      else if (i < 6 && !ex) statusEl.textContent = underWith ? `${LONG[i] ?? ""}: cheaper seats leave ${12 - seats} empty` : `${LONG[i] ?? ""}: ${mode === "under" && view === "without" ? "half the seats empty" : "full house"}`;
    }
    if (view === "with") await curtainCall(tok);
    else await ghostLight(left, tok);
    // the tagline fades in once a week has played to its end (Skip, a deep link and reduced motion end here too)
    if (tok === st.token) { setBusy(false); keepLights.classList.add("shown"); }
  }

  function dust(): void {
    if (st.speed <= 0) return;
    const w = opening.clientWidth;
    for (let i = 0; i < 34; i++) {
      const d = doc.createElement("i"); d.className = "dust";
      d.style.left = `${Math.random() * w}px`;
      opening.appendChild(d);
      const dx = (Math.random() - 0.5) * 120, dy = -20 - Math.random() * 60;
      d.animate([{ transform: "translate(0,0) scale(1)", opacity: 0.9 }, { transform: `translate(${dx}px,${dy}px) scale(${1 + Math.random() * 2})`, opacity: 0 }], { duration: 900 + Math.random() * 700, easing: "cubic-bezier(.2,.8,.4,1)" })
        .finished.then(() => d.remove(), () => d.remove());
    }
  }

  async function dropCurtain(i: number, tok: number): Promise<void> {
    const p = posters[i];
    if (!p) return;
    p.li.classList.remove("playing"); p.li.classList.add("cut");
    p.stamp.textContent = "LIMIT HIT";
    p.lab.textContent = "Stopped";
    for (let j = i + 1; j < 7; j++) { const q = posters[j]; if (!q) continue; q.li.classList.add("cancel"); q.stamp.textContent = "CANCELLED"; q.lab.textContent = "Dark"; }
    // blackout
    bulbs.forEach((b) => { b.classList.remove("on"); b.classList.add("flick"); });
    await wait(380, tok);
    bulbs.forEach((b) => b.classList.remove("flick"));
    dim.style.opacity = "0.9";
    await wait(140, tok);
    // slam
    drop.classList.remove("show-copy");
    const slam = anim(drop, [
      { transform: "translateY(-103%)", easing: "cubic-bezier(.6,0,1,.6)" },
      { transform: "translateY(0%)", offset: 0.6, easing: "ease-out" },
      { transform: "translateY(-5%)", offset: 0.74, easing: "ease-in" },
      { transform: "translateY(0%)", offset: 0.86, easing: "ease-out" },
      { transform: "translateY(-1.2%)", offset: 0.93 },
      { transform: "translateY(0%)" },
    ], 1000);
    await wait(600, tok);
    if (st.speed > 0) { stage.classList.remove("shake"); void stage.offsetWidth; stage.classList.add("shake"); }
    dust();
    await slam; live(tok);
    dim.style.opacity = "0.6";
    id("dropBig", HTMLElement).textContent = "Curtain down";
    id("dropSub", HTMLElement).textContent = `Your limit hit ${LONG[i] ?? ""} night`;
    stubs.forEach((s, j) => { if (j === i) s.className = "h"; else if (j > i) { s.className = "x"; s.style.setProperty("--d", `${(0.35 + 0.28 * (j - i)) * st.speed}s`); } });
    drop.classList.add("show-copy");
    statusEl.textContent = `Curtain down ${LONG[i] ?? ""}. ${7 - i - 1} shows cancelled.`;
  }

  async function ghostLight(left: number, tok: number): Promise<void> {
    statusEl.textContent = "Sunday. The run ends with seats to spare.";
    await wait(400, tok);
    id("ghostSub", HTMLElement).textContent = `${Math.round(left)}% of your week paid for, never played`;
    ghost.classList.add("on");
    statusEl.textContent = `${Math.round(left)}% of your week left unused.`;
  }

  async function curtainCall(tok: number): Promise<void> {
    statusEl.textContent = "Sunday. Final show…";
    await wait(250, tok);
    await anim(drop, [{ transform: "translateY(-103%)" }, { transform: "translateY(0%)" }], 750, "cubic-bezier(.5,0,.75,0)"); live(tok);
    await wait(420, tok);
    posters.forEach((p) => { p.li.classList.remove("playing", "played"); p.li.classList.add("gold"); fillSeats(p, p.filled ?? 12); p.lab.textContent = p.label ?? "Sold out"; });
    gaugeBadge.textContent = st.mode === "burn" ? "Lasted to Sunday" : "Target passed";
    dim.style.opacity = "0";
    id("cc", HTMLElement).textContent = st.mode === "burn" ? "Curtain call · lights to Sunday" : "Curtain call · target hit";
    statusEl.textContent = "";
    const rise = anim(drop, [{ transform: "translateY(0%)" }, { transform: "translateY(-103%)" }], 900, "cubic-bezier(.2,.7,.2,1)");
    await wait(200, tok);
    stage.classList.add("call");
    if (st.speed > 0) { stage.classList.add("anim"); bulbsEl.classList.add("chase"); }
    confetti(st.speed <= 0);
    posters.forEach((p, i) => { if (st.speed > 0) win.setTimeout(() => { p.li.classList.remove("bow"); void p.li.offsetWidth; p.li.classList.add("bow"); }, 120 * i); });
    await rise; live(tok);
    await wait(2300, tok);
    stage.classList.add("settled");
    bulbsEl.classList.remove("chase");
    statusEl.textContent = st.mode === "burn" ? "Seven shows. Lights lasted to Sunday." : "6 more jobs run. Weekly target hit.";
  }

  /* ---------- flows ---------- */
  function setMode(m: Mode): void {
    st.mode = m; st.routed = false; st.token++;
    pickBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
    // once a week is picked the boxes stop pulsing and the "Which week is yours?" cue goes
    pick.classList.remove("nudge", "cue-on"); pick.classList.add("picked");
    st.data = null; st.example = false;
    updateCompare();
    targetMark.setAttribute("opacity", m === "under" ? "1" : "0");
  }
  /** The stage from the visitor's (or the sample's) own numbers: only what they support. Seven posters labelled with
   * the real weekday of each date, seats in proportion to the busiest day with the count shown, LIMIT HIT only on
   * recorded dates, the gauge only when the Codex week is recorded, and an ending derived from the numbers. */
  async function playData(week: Week, tok: number, focusReplay: boolean): Promise<void> {
    st.data = week; st.example = false; st.routed = false; st.mode = null;
    pickBtns.forEach((b) => b.setAttribute("aria-pressed", "false"));
    pick.classList.remove("nudge", "cue-on"); pick.classList.add("picked");
    compare.hidden = false; seg.hidden = true;
    targetMark.setAttribute("opacity", "0");
    setBusy(true);
    clearDrop(); resetWeek();
    gauge.classList.add("calm");
    const labels = dayLabels(week), hits = new Set(limitDayIndexes(week));
    const perDay = week.perDay, max = perDay ? Math.max(1, ...perDay) : 1;
    posters.forEach((p, i) => { p.day.textContent = labels[i] ?? ""; p.lab.textContent = perDay ? "" : NOT_RECORDED; });
    const codex = week.codexWindow;
    gaugeName.textContent = codex === null ? "No weekly figure recorded" : "Codex week left";
    if (codex === null) leftPct.textContent = "";
    // The sample's per-day split is constructed, so the stage never presents it as the visitor's own numbers.
    actEl.textContent = week === SAMPLE_WEEK ? "Sample week · per-day split illustrative, not your numbers" : "Your week · from your numbers";
    statusEl.textContent = "";
    await wait(250, tok);
    for (let i = 0; i < 7; i++) {
      const p = posters[i];
      if (!p) continue;
      const n = perDay?.[i];
      p.li.classList.add("playing");
      const seats = n === undefined ? 0 : Math.round((n / max) * 12);
      const from = codex === null ? 100 : 100 - (codex * i) / 7, to = codex === null ? 100 : 100 - (codex * (i + 1)) / 7;
      await tween(0, 1, 420, (_, pr) => { fillSeats(p, Math.round(pr * seats)); if (codex !== null) setGauge(from + (to - from) * pr); }, tok);
      if (codex === null) leftPct.textContent = "";
      p.li.classList.remove("playing");
      if (n !== undefined) { p.li.classList.add("played"); p.lab.textContent = n.toLocaleString("en-US"); }
      if (hits.has(i)) { p.li.classList.add("cut"); p.stamp.textContent = "LIMIT HIT"; }
    }
    dataBig.textContent = stageHeadline(week);
    dataSub.textContent = stageSubtitle(week);
    dataEnd.hidden = false;
    if (tok === st.token) {
      setBusy(false);
      keepLights.classList.add("shown");
      if (focusReplay) replayBtn.focus();
    }
  }
  function updateCompare(): void { compare.hidden = !st.mode; seg.hidden = !st.routed; }
  async function runWithout(): Promise<void> {
    const tok = st.token;
    try { await playWeek("without", tok); } catch (e) { ignoreCancel(e); }
  }
  /** "See it with TokenMax": the curtain rises and the same week replays with TokenMax; the Without / With flip appears. */
  async function playWith(): Promise<void> {
    if (!st.mode) setMode("burn");
    const tok = ++st.token;
    // the With view starts now, so a Skip pressed while the curtain rises ends on the With week
    st.routed = true; st.view = "with";
    updateCompare(); setBusy(true);
    segBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === "with")));
    try {
      ghost.classList.remove("on");
      if (drop.classList.contains("show-copy") || drop.style.transform === "translateY(0%)") {
        drop.classList.remove("show-copy");
        await anim(drop, [{ transform: "translateY(0%)" }, { transform: "translateY(-103%)" }], 600, "ease-in"); live(tok);
      }
      await playWeek("with", tok);
    } catch (e) { ignoreCancel(e); }
  }
  async function instant(fn: () => Promise<void>): Promise<void> {
    st.speed = 0; root.classList.add("instant");
    try { await fn(); } finally { st.speed = reduced ? 0 : 1; }
  }
  async function skipToEnd(): Promise<void> {
    const hadFocus = doc.activeElement === skipBtn;
    const view = st.view;
    const data = st.data;
    try { await instant(() => data ? playData(data, ++st.token, false) : playWeek(view, ++st.token)); } catch (e) { ignoreCancel(e); }
    if (hadFocus) replayBtn.focus();
  }

  /* ---------- confetti ---------- */
  const cv = id("confetti", HTMLCanvasElement), cx = cv.getContext("2d");
  let parts: Particle[] = [], raf = 0;
  function rng(start: number): () => number {
    let seed = start;
    return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function stopConfetti(): void { win.cancelAnimationFrame(raf); parts = []; cx?.clearRect(0, 0, cv.width, cv.height); }
  function confetti(frozen: boolean): void {
    stopConfetti();
    const ctx = cx;
    if (!ctx) return;
    const W = (cv.width = opening.clientWidth), H = (cv.height = opening.clientHeight);
    const R = rng(7);
    const cols = ["#e0b04e", "#f6dc8e", "#efe2c4", "#c0262f", "#fff3c4"];
    const n = Math.round(Math.min(1, W / 1000) * 110);
    for (let i = 0; i < n; i++) parts.push({ x: R() * W, y: -R() * H * 0.6, vx: (R() - 0.5) * 1.5, vy: R() * 2, r: R() * 6, vr: (R() - 0.5) * 0.3, s: 5 + R() * 6, c: cols[i % 5] ?? "#e0b04e", rose: i % 6 === 0 });
    for (const [x0, dir] of [[0, 1], [W, -1]] satisfies [number, number][]) {
      for (let i = 0; i < Math.round(n * 0.4); i++) parts.push({ x: x0, y: H, vx: dir * (3 + R() * 8), vy: -(7 + R() * 9), r: R() * 6, vr: (R() - 0.5) * 0.4, s: 5 + R() * 6, c: cols[i % 5] ?? "#e0b04e", rose: i % 5 === 0 });
    }
    const stepP = (): void => parts.forEach((p) => { p.vy += 0.22; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr; });
    const draw = (): void => {
      ctx.clearRect(0, 0, W, H);
      parts.forEach((p) => {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        if (p.rose) {
          ctx.fillStyle = "#b81d2b"; ctx.beginPath(); ctx.arc(0, 0, p.s * 0.8, 0, 7); ctx.fill();
          ctx.fillStyle = "#7a1420"; ctx.beginPath(); ctx.arc(1, -1, p.s * 0.4, 0, 7); ctx.fill();
          ctx.strokeStyle = "#3d6b2a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, p.s * 0.7); ctx.lineTo(0, p.s * 2.2); ctx.stroke();
        } else { ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); }
        ctx.restore();
      });
    };
    // Still frame (skip, deep link, reduced motion): keep the confetti along the top and right edge so it never sits on the copy.
    if (frozen) { for (let i = 0; i < 34; i++) stepP(); parts = parts.filter((p) => p.y < H * 0.15 || p.x > W * 0.94); draw(); return; }
    const t0 = win.performance.now();
    const loop = (now: number): void => { stepP(); draw(); if (now - t0 < 6500) raf = win.requestAnimationFrame(loop); else ctx.clearRect(0, 0, W, H); };
    raf = win.requestAnimationFrame(loop);
  }

  /* ---------- Map your real week: Copy the prompt, then execCommand, then select the text with a keyboard hint ---------- */
  const promptEl = id("sharePrompt", HTMLElement), copyMsg = id("copyMsg", HTMLElement);
  const PROMPT = promptEl.textContent ?? "";
  const COPIED = "Copied. Paste it into Claude Code or Codex.";
  let copyTimer = 0;
  function say(text: string): void {
    copyMsg.textContent = text;
    win.clearTimeout(copyTimer);
    copyTimer = win.setTimeout(() => { copyMsg.textContent = ""; }, 4000);
  }
  function legacyCopy(): boolean {
    const t = doc.createElement("textarea");
    t.value = PROMPT; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    doc.body.appendChild(t); t.select();
    let ok = false;
    try { ok = doc.execCommand("copy"); } catch { ok = false; }
    t.remove();
    return ok;
  }
  function selectCommand(): void {
    const range = doc.createRange();
    range.selectNodeContents(promptEl);
    const sel = win.getSelection();
    sel?.removeAllRanges(); sel?.addRange(range);
    const mac = /Mac|iPhone|iPad/.test(win.navigator.platform || win.navigator.userAgent);
    say(`The prompt is selected. Press ${mac ? "Cmd+C" : "Ctrl+C"} to copy it.`);
  }
  function fallback(): void { if (legacyCopy()) say(COPIED); else selectCommand(); }
  id("copy", HTMLButtonElement).addEventListener("click", () => {
    const clip = win.navigator.clipboard;
    if (clip && typeof clip.writeText === "function") clip.writeText(PROMPT).then(() => say(COPIED), fallback);
    else fallback();
  });
  /** Skip to the command and #command move focus to the prompt section, unless focus is already inside it: a late
   * fonts.ready or a hashchange must never pull focus out of the paste box (the Cmd+V bug, 2026-10-21). */
  function focusCommand(): void { if (!command.contains(doc.activeElement)) command.focus(); }

  /* ---------- Paste the result back: parsed here and shown as values only; nothing is sent until Submit ---------- */
  const pasteBox = id("pasteBox", HTMLTextAreaElement), pasteError = id("pasteError", HTMLElement);
  const yourWeek = id("yourWeek", HTMLElement), yourFields = id("yourFields", HTMLElement), yourLine = id("yourLine", HTMLElement);
  const sampleTag = id("sampleTag", HTMLElement), localTag = id("localTag", HTMLElement);
  const yourTitle = id("hYour", HTMLElement), yourPeriod = id("yourPeriod", HTMLElement);
  let mine: Week | null = null;
  /** Fill the card in place from values only (textContent): no pasted text is ever shown. It does not move focus or
   * the page; it only scrolls the card into view if it would be off screen. */
  function showCard(week: Week, sample: boolean): void {
    yourTitle.textContent = sample ? "Sample week" : "Your week";
    yourPeriod.textContent = periodLine(week);
    yourLine.textContent = cardHeadline(week);
    yourFields.textContent = "";
    for (const { label, value } of weekLines(week)) {
      const dt = doc.createElement("dt"); dt.textContent = label;
      const dd = doc.createElement("dd"); dd.textContent = value;
      yourFields.append(dt, dd);
    }
    mine = week;
    sampleTag.hidden = !sample; localTag.hidden = sample;
    yourWeek.hidden = false;
    yourWeek.scrollIntoView({ block: "nearest" });
  }
  /** Play my week: the stage comes into view (only on this click) and plays the shown numbers; focus ends on Replay. */
  function playMine(): void {
    const week = mine;
    if (!week) return;
    stage.scrollIntoView({ block: "start" });
    playData(week, ++st.token, true).catch(ignoreCancel);
  }
  function showMyWeek(): void {
    const week = parseWeek(pasteBox.value);
    if (!week) { yourWeek.hidden = true; pasteError.textContent = NOT_A_RESULT; pasteError.hidden = false; return; }
    pasteError.hidden = true; pasteError.textContent = "";
    showCard(week, false);
  }
  id("showWeek", HTMLButtonElement).addEventListener("click", showMyWeek);
  // A paste shows the week by itself once the text has landed; the default paste is never blocked.
  pasteBox.addEventListener("paste", () => { win.setTimeout(showMyWeek, 0); });
  id("showSample", HTMLButtonElement).addEventListener("click", () => {
    pasteError.hidden = true; pasteError.textContent = "";
    showCard(SAMPLE_WEEK, true);
  });
  id("playMine", HTMLButtonElement).addEventListener("click", playMine);

  /* ---------- Submit: the one thing on this page that sends. Pressing it is the visitor's consent (copy beside it). ---------- */
  const aliasBox = id("aliasBox", HTMLInputElement), aliasError = id("aliasError", HTMLElement);
  const submitBtn = id("submitWeek", HTMLButtonElement), submitStatus = id("submitStatus", HTMLElement);
  const submitted = id("submitted", HTMLElement), receipts = id("receipts", HTMLOListElement);
  const TIMEOUT_MS = 15_000;
  // Request keys are delete secrets. Keep each draft's key for this page lifetime only.
  const keys = new Map<string, string>();
  function keyFor(draft: string): string {
    const existing = keys.get(draft);
    if (existing !== undefined) return existing;
    const key = newRequestKey((bytes) => win.crypto.getRandomValues(bytes));
    keys.set(draft, key);
    return key;
  }
  // The previous build stored {id, key, alias} here and nothing ever read it. Remove it so no delete key stays in browser storage.
  try { win.localStorage.removeItem("tm-submit/1"); } catch { /* storage unavailable */ }
  let sending = false;
  function clearSubmitMessages(): void {
    aliasError.hidden = true; aliasError.textContent = ""; aliasBox.removeAttribute("aria-invalid");
    pasteError.hidden = true; pasteError.textContent = "";
    submitStatus.hidden = true; submitStatus.textContent = "";
  }
  function refuse(message: string): void { pasteError.textContent = message; pasteError.hidden = false; }
  function idOf(data: unknown): string | null {
    return typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" && /^TM-[0-9A-F]{12}$/.test(data.id) ? data.id : null;
  }
  function showSubmitted(mapId: string, key: string, alias: string): void {
    for (const old of every(receipts, "li", HTMLLIElement)) if (old.dataset.mapId === mapId) {
      submitStatus.textContent = `Already submitted: your entry is on the board as ${alias}.`;
      submitStatus.hidden = false;
      old.focus();
      return;
    }
    const li = doc.createElement("li");
    li.className = "receipt"; li.tabIndex = -1; li.dataset.mapId = mapId;
    const line = (value: string, className = ""): void => { const p = doc.createElement("p"); p.className = className; p.textContent = value; li.append(p); };
    const link = (label: string, href: string): void => { const p = doc.createElement("p"); const a = doc.createElement("a"); a.href = href; a.textContent = label; p.append(a); li.append(p); };
    const code = (label: string, value: string): void => { const p = doc.createElement("p"); const c = doc.createElement("code"); c.textContent = value; p.append(`${label} `, c); li.append(p); };
    line(`Submitted. Your entry is on the public board as ${alias}.`, "submitted-head");
    link("Board: /maps/", "/maps/");
    code("Your map id:", mapId);
    code("Your key:", key);
    line("Keep this key to remove your entry.");
    link("remove my entry", `/maps/#delete=${mapId}.${key}`);
    receipts.prepend(li);
    submitStatus.textContent = "Submitted. Your entry is on the public board.";
    submitStatus.hidden = false;
    submitted.hidden = false;
    li.focus();
  }
  async function send(payload: Parameters<typeof submitBody>[0], alias: string, key: string, draft: string): Promise<void> {
    const control = new AbortController();
    const timer = win.setTimeout(() => control.abort(), TIMEOUT_MS);
    try {
      const response = await win.fetch("/api/maps", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(submitBody(payload, alias, key)), signal: control.signal });
      let data: unknown = null;
      try { data = await response.json(); } catch (error) { if (control.signal.aborted) throw error; }
      const mapId = response.ok ? idOf(data) : null;
      submitStatus.hidden = true; submitStatus.textContent = "";
      if (mapId) { showSubmitted(mapId, key, alias); return; }
      if (response.status === 409 && typeof data === "object" && data !== null && "code" in data && data.code === "request-key-reused") keys.delete(draft);
      refuse(response.ok ? "Not confirmed: the server's answer could not be read, so your entry may already be on the board. Press Submit again on this page to get your receipt and key; for the same result and nickname it never adds a second row." : rejectionMessage(response.status, data));
    } catch {
      submitStatus.hidden = true; submitStatus.textContent = "";
      refuse(control.signal.aborted
        ? "Not confirmed: no answer within 15 seconds, so your entry may already be on the board. Press Submit again on this page to get your receipt and key; for the same result and nickname it never adds a second row."
        : "Not confirmed: the request did not complete, so your entry may already be on the board. Check your connection and press Submit again on this page to get your receipt and key; for the same result and nickname it never adds a second row.");
    } finally {
      win.clearTimeout(timer);
      sending = false; submitBtn.disabled = false;
    }
  }
  function submitWeek(): void {
    if (sending) return;
    clearSubmitMessages();
    const week = parseWeek(pasteBox.value);
    if (!week) { yourWeek.hidden = true; refuse(NOT_A_RESULT); pasteBox.focus(); return; }
    const rawProblem = rawNumberProblem(pasteBox.value);
    if (rawProblem) { showCard(week, false); refuse(rawProblem); return; }
    const mapped = weekToPayload(week);
    if (!mapped.ok) { showCard(week, false); refuse(mapped.message); return; }
    const alias = aliasBox.value.trim().toLowerCase();
    aliasBox.value = alias;
    if (!ALIAS_PATTERN.test(alias)) {
      aliasBox.setAttribute("aria-invalid", "true");
      aliasError.textContent = alias === "" ? `Enter a nickname to submit. ${ALIAS_MESSAGE}` : ALIAS_MESSAGE;
      aliasError.hidden = false;
      aliasBox.focus();
      return;
    }
    showCard(week, false);
    const draft = JSON.stringify([alias, mapped.payload]);
    const key = keyFor(draft);
    sending = true; submitBtn.disabled = true;
    submitStatus.textContent = "Submitting..."; submitStatus.hidden = false;
    void send(mapped.payload, alias, key, draft);
  }
  submitBtn.addEventListener("click", submitWeek);

  /* ---------- wiring ---------- */
  pickBtns.forEach((b) => b.addEventListener("click", () => { const m = b.dataset.mode; if (m === "burn" || m === "under") { setMode(m); void runWithout(); } }));
  [ghostBtn, dropBtn].forEach((b) => b.addEventListener("click", () => { void playWith(); }));
  segBtns.forEach((b) => b.addEventListener("click", () => {
    const tok = ++st.token;
    playWeek(b.dataset.v === "with" ? "with" : "without", tok).catch(ignoreCancel);
  }));
  skipBtn.addEventListener("click", () => { void skipToEnd(); });
  replayBtn.addEventListener("click", () => {
    const tok = ++st.token;
    const data = st.data;
    (data ? playData(data, tok, false) : playWeek(st.view, tok)).catch(ignoreCancel);
  });
  // After a week from the visitor's numbers: the scripted With week, tagged as an example so nothing implies their saving.
  id("dataWith", HTMLButtonElement).addEventListener("click", () => {
    const week = st.data;
    setMode(week && situationOf(week) === "running out" ? "burn" : "under");
    st.example = true;
    void playWith();
  });
  every(doc, 'a[href="#command"]', HTMLAnchorElement).forEach((a) => a.addEventListener("click", () => win.setTimeout(focusCommand, 0)));

  /* ---------- start and deep links ---------- */
  setGauge(100);
  let demoTimer = 0;
  async function fromHash(): Promise<void> {
    const link = parseHash(win.location.hash);
    // a pending demo Try never lands on a later deep link
    win.clearTimeout(demoTimer);
    if (link?.kind === "command") { focusCommand(); return; }
    if (link?.kind === "demo") {
      // test hook: plays the whole journey by itself
      pickBtns.find((b) => b.dataset.mode === link.mode)?.click();
      demoTimer = win.setTimeout(() => { void playWith(); }, 5200);
      return;
    }
    if (!link) { if (!st.mode) pick.classList.add("nudge"); return; }
    setMode(link.mode);
    try {
      if (link.view === "without") { await instant(() => playWeek("without", st.token)); return; }
      await instant(playWith);
    } catch (e) { ignoreCancel(e); }
  }
  if (reduced) { st.speed = 0; root.classList.add("instant"); }
  // Reduced motion turned on mid-show: whatever is playing jumps to its end state.
  reduceQuery.addEventListener("change", (e) => {
    reduced = e.matches;
    if (!reduced) { st.speed = 1; return; }
    root.classList.add("instant");
    if (st.busy) void skipToEnd();
    st.speed = 0;
  });
  doc.fonts.ready.then(() => fromHash(), () => fromHash());
  win.addEventListener("hashchange", () => { void fromHash(); });
  // "Which week is yours?" over the seam: after about 1.5 s, at once under reduced motion, never once a week is picked.
  win.setTimeout(() => { if (!st.mode) pick.classList.add("cue-on"); }, reduced ? 0 : 1500);
  const motionBack = (): void => { if (!reduced) root.classList.remove("instant"); };
  doc.addEventListener("pointerdown", motionBack, true);
  doc.addEventListener("keydown", motionBack, true);
}
