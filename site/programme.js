/* The programme scroll under the marquee (index.html #programme, styled in theatre.css).
 *
 * data-state on #programme: "open" (the parchment shows Read the programme and Roll it up), "rolled" (only the Read the
 * programme button), or "waiting" (a first visit whose scroll has not unrolled yet: the curtain is still closed or the
 * scroll is off screen). The markup starts "open", so without this script the scroll is simply there, static.
 * - A first visit unrolls it once, when it is on screen and the curtain (theatre.js, html[data-curtain]) is open; the
 *   visit is remembered at once, so a later visit shows the rolled button.
 *   "On screen" is measured when the curtain opens, not cached: Raise the curtain scrolls straight past the scroll.
 * - Roll it up rolls it into the button and is remembered; focus moves to the button only if it was still inside the
 *   scroll, so a visitor who moved on keeps their place.
 * - Reduced motion: no animation (theatre.css also switches it off live); the scroll is shown open and static.
 * - Storage that throws (private modes, blocked storage) is treated as a first visit; nothing is remembered.
 */
(function () {
  "use strict";
  var box = document.getElementById("programme");
  var sheet = document.getElementById("programmeSheet");
  var closeBtn = document.getElementById("programmeClose");
  var rolledLink = document.getElementById("programmeRolled");
  if (!box || !sheet || !closeBtn || !rolledLink) return;
  var root = document.documentElement;
  var KEY = "jnj-programme";
  var reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  function still() { return !!(reduce && reduce.matches); }
  function read() { try { return window.localStorage.getItem(KEY); } catch (e) { return null; } }
  function remember() { try { window.localStorage.setItem(KEY, "rolled"); } catch (e) { /* not remembered; it unrolls again next time */ } }
  function setState(s) { box.dataset.state = s; }
  // The bottom rod travels the sheet's height; the sheet keeps that height in every state but rolled.
  function measure() { box.style.setProperty("--programme-h", sheet.offsetHeight + "px"); }

  function roll() {
    remember();
    var finish = function () {
      var hadFocus = box.contains(document.activeElement);
      box.classList.remove("rolling", "unroll");
      setState("rolled");
      if (hadFocus) rolledLink.focus();
    };
    if (still() || box.dataset.state !== "open") { finish(); return; }
    var finished = false;
    var once = function () { if (finished) return; finished = true; finish(); };
    measure();
    box.classList.remove("unroll");
    box.classList.add("rolling");
    sheet.addEventListener("animationend", once, { once: true });
    window.setTimeout(once, 1200);
  }
  closeBtn.addEventListener("click", roll);

  if (read() === "rolled") { setState("rolled"); return; }
  if (still() || !("IntersectionObserver" in window)) { setState("open"); remember(); return; }

  // First visit with motion: wait until the curtain is open and the scroll is on screen, then unroll it once.
  setState("waiting");
  measure();
  var started = false;
  function curtainOpen() { return !root.classList.contains("overture-play") || root.dataset.curtain === "open"; }
  // At least a quarter of the scroll is in the viewport now (a sliver at the edge does not count).
  function onScreen() {
    var r = box.getBoundingClientRect();
    var shown = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return r.height > 0 && shown >= r.height / 4;
  }
  function start() {
    if (started || !curtainOpen() || !onScreen()) return;
    started = true;
    io.disconnect();
    mo.disconnect();
    remember();
    measure();
    if (!still()) box.classList.add("unroll");
    setState("open");
  }
  var io = new IntersectionObserver(start, { threshold: [0, 0.25, 0.5, 1] });
  var mo = new MutationObserver(start);
  io.observe(box);
  mo.observe(root, { attributes: true, attributeFilter: ["data-curtain", "class"] });
})();
