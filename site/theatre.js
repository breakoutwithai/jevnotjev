/* The opening curtain and the house lights for the thin theatre frame.
 *
 * The head script in index.html decides before first paint: html.overture-play (motion on, first page of the tab
 * session) closes the curtain over the page, carrying the October 6 playbill: marquee, ticket, scroll cue, Skip the
 * overture and the Little Shop poster. This script then drives it and records html[data-curtain] (closed, rising or
 * open), the root's --reveal (0 to 1) and html[data-runway] (the scroll distance, in px, over which it parts):
 * - scrolling parts it in step. The curtain is its own scroller (theatre.css): a wheel or a swipe over it scrolls it
 *   through a runway of 0.7 of the screen height while the page under it stays at its first screen, so the results
 *   heading and the result bars hold still and grow in the gap. A scroll of the page itself (a restored position, or
 *   keys with focus in the page) counts the same way. Progress never goes back and it never closes again;
 * - Skip the overture opens it at once, scrolls to the result bars and moves focus to their heading;
 * - the poster is a link to Little Shop; focus on it, on Skip or on House lights leaves the curtain closed, while focus
 *   anywhere else, a #hash on load or a hash change opens it at once, so nothing is focused or linked to behind it;
 * - once open the overture is display:none, and the page is where it was;
 * - the sample chip is lifted onto the curtain while it is closed and returns to the house bar once it starts to part;
 *   a hidden copy holds its place in the house bar meanwhile, so its return moves nothing;
 * - turning reduced motion on drops it (theatre.css hides it at once; this records the page as open).
 * With no curtain (reduced motion, a later page, missing markup) the page is open and --reveal is 1, so the result bars
 * are full. If this script never runs, the head script opens the page after load.
 */
(function () {
  "use strict";
  var root = document.documentElement;
  var RUNWAY = 0.7, FADED = 0.36;
  var ov = document.getElementById("overture");
  var skip = document.getElementById("skipOverture");
  var badge = document.getElementById("sampleBadge");
  var results = document.getElementById("results");
  var heading = document.getElementById("resultsTitle");
  var reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var progress = 0, done = false, distance = 1, ghost = null;

  function setCurtain(p) {
    progress = p;
    root.style.setProperty("--reveal", p.toFixed(4));
    root.dataset.curtain = p >= 1 ? "open" : p > 0 ? "rising" : "closed";
    if (ov) ov.classList.toggle("faded", p >= FADED);
  }
  function open() {
    if (done) return;
    done = true;
    setCurtain(1);
    if (ov) ov.classList.add("gone");
  }
  function runway() {
    distance = Math.max(1, Math.round((window.innerHeight || 1) * RUNWAY));
    root.dataset.runway = String(distance);
    root.style.setProperty("--runway", distance + "px");
  }

  var playing = root.classList.contains("motion") && root.classList.contains("overture-play") && ov && skip && heading && !(reduce && reduce.matches);
  if (!playing) {
    root.classList.remove("overture-play");
    done = true;
    setCurtain(1);
    if (ov) ov.classList.add("gone");
  } else {
    // The hidden copy of the sample chip that holds its place in the house bar while the chip is on the curtain.
    if (badge) {
      ghost = badge.cloneNode(true);
      ghost.removeAttribute("id");
      ghost.removeAttribute("role");
      ghost.setAttribute("aria-hidden", "true");
      ghost.setAttribute("inert", "");
      ghost.classList.add("sample-ghost");
      var copies = ghost.querySelectorAll("[id]");
      for (var i = 0; i < copies.length; i++) copies[i].removeAttribute("id");
      badge.parentNode.insertBefore(ghost, badge.nextSibling);
    }
    // Scroll events already arrive once per frame, before animation frames: updating here opens a curtain that a jump
    // completes before anything else reads the page in that frame.
    var update = function () {
      if (done) return;
      var next = Math.max(progress, Math.min(1, Math.max(ov.scrollTop, window.scrollY) / distance));
      if (next >= 1) open();
      else if (next !== progress) setCurtain(next);
    };
    var onCurtain = function (node) {
      return ov.contains(node) || (badge !== null && badge.contains(node));
    };
    skip.addEventListener("click", function () {
      open();
      var top = results ? results.getBoundingClientRect().top + window.scrollY : window.innerHeight;
      window.scrollTo({ top: top, behavior: "instant" });
      heading.focus({ preventScroll: true });
    });
    document.addEventListener("focusin", function (e) {
      if (!done && e.target instanceof Node && !onCurtain(e.target)) open();
    });
    window.addEventListener("hashchange", function () { if (window.location.hash) open(); });
    ov.addEventListener("scroll", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", function () { runway(); update(); });
    if (reduce) {
      var calm = function () { if (reduce.matches) open(); };
      if (reduce.addEventListener) reduce.addEventListener("change", calm);
      else if (reduce.addListener) reduce.addListener(calm);
    }
    setCurtain(0);
    runway();
    if (window.location.hash) open();
    else update();
  }

  var lights = document.getElementById("lights");
  if (!lights) return;
  function darkNow() {
    var theme = root.getAttribute("data-theme");
    return theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function sync() {
    lights.textContent = darkNow() ? "House lights up" : "House lights down";
    var copy = ghost ? ghost.querySelector(".house-lights") : null;
    if (copy) copy.textContent = lights.textContent;
  }
  lights.addEventListener("click", function () {
    root.setAttribute("data-theme", darkNow() ? "light" : "dark");
    sync();
  });
  sync();
  if (window.JNJ && window.JNJ.meta) document.getElementById("sampleBadge").title = window.JNJ.meta.note;
})();
