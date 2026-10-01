/* Theatre pass: the overture and the Act I scroll beats. No data here: Act I content comes from window.JNJStage
 * (index.html), the stage-door demo from stage-door.js.
 *
 * Beats (html[data-beat]), measured from the top of the page in viewport heights (vh = innerHeight):
 *   0  y = 0           curtains closed, ticket and marquee
 *   1  y >= 0.75 vh    curtains fully open, the ask line empty
 *   2  y >= 0.87 vh    the example writes in (data-act1="typing"), is struck in red ("struck"), the dialogue plays ("dialogue")
 *   3  y >= 1.00 vh    after beat 2 finishes, the stage-door note slides in beside the title
 * "Skip the overture", focus moving into the page, or a deep link jumps straight to the final state.
 */
(function () {
  "use strict";
  var root = document.documentElement;
  var S = window.JNJStage;
  var ov = document.getElementById("overture");
  var runway = document.getElementById("runway");
  var input = document.getElementById("askInput");
  var door = document.getElementById("door");
  var skip = document.getElementById("skipOverture");
  var title = document.getElementById("t1");

  if (!root.classList.contains("motion") || !S || !ov || !runway) {
    root.dataset.beat = "3";
    root.dataset.act1 = "dialogue";
    return;
  }

  /* DIALOGUE_FALLBACK_MS covers the last line's .5s delay plus .6s entrance (index.html .dialogue .line) with margin. */
  var OPEN_AT = 0.75, BEAT2_AT = 0.87, BEAT3_AT = 1.0, TYPE_MS = 38, STRIKE_HOLD_MS = 1500, DIALOGUE_FALLBACK_MS = 1400;
  var dialogue = document.getElementById("dialogue");
  var cues = document.getElementById("cues");
  /* opened: the curtain was opened directly (skip, focus, deep link) and stays open whatever scrollY reads. */
  var beat = 0, act1Done = false, timers = [], ticking = false, opened = false;
  root.dataset.beat = "0";
  root.dataset.curtain = "closed";

  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function setBeat(n) { beat = n; root.dataset.beat = String(n); }
  function runwayH() { return runway.offsetHeight || window.innerHeight; }

  function setCurtain(p) {
    ov.style.setProperty("--p", p.toFixed(4));
    ov.classList.toggle("gone", p >= 1);
    root.dataset.curtain = p >= 1 ? "open" : p > 0 ? "rising" : "closed";
  }

  function toBeat2() {
    setBeat(2);
    root.dataset.act1 = "typing";
    var text = S.openerTail, i = 0;
    (function type() {
      i++;
      input.value = text.slice(0, i);
      if (i < text.length) { later(type, TYPE_MS); return; }
      root.dataset.act1 = "struck";
      input.classList.add("struck");
      later(function () {
        input.classList.remove("struck");
        S.playOpener();
        root.dataset.act1 = "dialogue";
        /* The note waits for the last line's entrance animation; the timer covers a browser that never fires it. */
        var last = dialogue && dialogue.lastElementChild;
        if (last) last.addEventListener("animationend", dialogueDone, { once: true });
        later(dialogueDone, DIALOGUE_FALLBACK_MS);
      }, STRIKE_HOLD_MS);
    })();
  }

  function dialogueDone() {
    if (act1Done) return;
    act1Done = true;
    update();
  }

  /* Choosing an example ends the opener: no pending typing, strike or dialogue timer may overwrite the choice.
     Runs in the capture phase on #cues, before the example button's own handler. */
  function cancelOpener() {
    timers.forEach(clearTimeout);
    timers = [];
    input.classList.remove("struck");
    if (beat < 2) setBeat(2);
    root.dataset.act1 = "dialogue";
    act1Done = true;
    update();
  }

  function toBeat3() {
    setBeat(3);
    door.classList.add("shown");
  }

  function update() {
    ticking = false;
    var h = runwayH(), y = window.scrollY;
    var p = opened ? 1 : Math.max(0, Math.min(1, y / (h * OPEN_AT)));
    setCurtain(p);
    if (beat < 1 && p >= 1) setBeat(1);
    if (beat === 1 && y >= h * BEAT2_AT) toBeat2();
    if (beat === 2 && act1Done && y >= h * BEAT3_AT) toBeat3();
  }

  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }

  /* Jump to the final state: curtains open, example asked and answered, note shown. The curtain opens here,
     not through the scroll position, because html { scroll-behavior: smooth } makes scrollTo slow. */
  function finish(scroll) {
    timers.forEach(clearTimeout);
    timers = [];
    opened = true;
    setCurtain(1);
    if (beat < 1) setBeat(1);
    input.classList.remove("struck");
    S.act1Final();
    act1Done = true;
    root.dataset.act1 = "dialogue";
    toBeat3();
    if (scroll && window.scrollY < runwayH()) window.scrollTo({ top: runwayH(), behavior: "instant" });
    update();
  }

  skip.addEventListener("click", function () {
    finish(true);
    if (title) title.focus({ preventScroll: true });
  });
  /* Never trap focus behind the curtain: tabbing into the page opens it. */
  document.addEventListener("focusin", function (e) {
    if (beat < 3 && e.target instanceof Node && !ov.contains(e.target) && document.querySelector("main").contains(e.target)) finish(true);
  });

  if (cues) cues.addEventListener("click", cancelOpener, true);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  if (location.hash || window.scrollY >= runwayH()) finish(false);
  else update();
})();
