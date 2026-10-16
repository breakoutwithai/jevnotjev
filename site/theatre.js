/* The opening curtain and the house lights for the thin theatre frame.
 *
 * The head script in index.html decides before first paint: html.overture-play (motion on, first page of the tab
 * session) closes the curtain over the page, carrying the October 6 playbill: marquee, ticket, scroll cue, Skip the
 * overture and the Little Shop poster. This script then drives it and records html[data-curtain] (closed, rising or
 * open), the root's --reveal (0 to 1) and html[data-runway] (the scroll distance, in px, over which it parts):
 * - scrolling parts it in step. The curtain is its own scroller (theatre.css): a wheel or a swipe over it scrolls it
 *   through a runway of 0.7 of the screen height. Until it is open the page itself does not scroll (theatre.css locks
 *   it), so the results heading and the result bars hold still and grow in the gap. Every other way of scrolling drives
 *   the same runway: a wheel or a swipe over the sample chip or the page in the gap, and the scroll keys (PageDown,
 *   Space, ArrowDown, End) with focus on the page. A position the page already had when this script ran (a restored
 *   scroll) counts too. Progress never goes back and it never closes again;
 * - Skip the overture opens it at once, scrolls to the result bars and moves focus to their heading; the same happens
 *   when the playbill fades with focus still on it, so focus is never dropped;
 * - the poster is a link to Little Shop; focus on it, on Skip or on House lights leaves the curtain closed (Tab goes
 *   Skip, poster, House lights), while focus anywhere else, focus already elsewhere when this script runs, a #hash on
 *   load or a hash change opens it at once, so nothing is focused or linked to behind it;
 * - once open the overture is display:none, and the page is where it was;
 * - the sample chip is lifted onto the curtain while it is closed and returns to the house bar once it starts to part;
 *   a hidden copy holds its place in the house bar meanwhile, so its return moves nothing;
 * - turning reduced motion on drops it (theatre.css hides it at once; this records the page as open);
 * - the first-screen band (#tmFirst: the promise, Copy, the script link, Watch it run) sits above the curtain, which
 *   starts at its bottom (the root's --tm-first-h, kept in step with the band's height); focus on its controls keeps the
 *   curtain closed, so Tab goes Copy, the script link, Watch it run, Skip, poster, House lights.
 * With no curtain (reduced motion, a later page, missing markup, or the head script's watchdog already opened the page)
 * the page is open and --reveal is 1, so the result bars are full. If this script never runs or stalls, the head
 * script opens the page.
 */
(function () {
  "use strict";
  var root = document.documentElement;
  var RUNWAY = 0.7, FADED = 0.36, KEY_STEP = 0.4, LINE = 40;
  var ov = document.getElementById("overture");
  var skip = document.getElementById("skipOverture");
  var badge = document.getElementById("sampleBadge");
  var brand = document.querySelector(".house .brand");
  var results = document.getElementById("results");
  var heading = document.getElementById("resultsTitle");
  var band = document.getElementById("tmFirst");
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
    if (brand) brand.removeAttribute("tabindex");
  }
  // The first-screen band (#tmFirst) sits above the curtain: the curtain, the lifted sample chip and the valance start
  // at its bottom (theatre.css reads --tm-first-h; 0 when there is no band).
  function bandHeight() {
    root.style.setProperty("--tm-first-h", (band ? band.offsetHeight : 0) + "px");
  }
  function runway() {
    bandHeight();
    distance = Math.max(1, Math.round((window.innerHeight || 1) * RUNWAY));
    root.dataset.runway = String(distance);
    root.style.setProperty("--runway", distance + "px");
  }
  // Open, bring the result bars to the top and put focus on their heading.
  function toResults() {
    open();
    var top = results ? results.getBoundingClientRect().top + window.scrollY : window.innerHeight;
    window.scrollTo({ top: top, behavior: "instant" });
    if (heading) heading.focus({ preventScroll: true });
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
    // While the curtain is closed, Tab goes from the poster to House lights, not to the brand link behind the curtain.
    if (brand) brand.setAttribute("tabindex", "-1");
    // Scroll events already arrive once per frame, before animation frames: updating here opens a curtain that a jump
    // completes before anything else reads the page in that frame.
    var update = function () {
      if (done) return;
      var next = Math.max(progress, Math.min(1, Math.max(ov.scrollTop, window.scrollY) / distance));
      if (next === progress) return;
      // Past the fade (or open in one go) the playbill is hidden; focus on Skip or the poster would fall to the page, so
      // do what Skip does. Without focus on the curtain the page stays where it is.
      if (next >= FADED && ov.contains(document.activeElement)) { toResults(); return; }
      if (next >= 1) { open(); return; }
      setCurtain(next);
    };
    // The band's controls (Copy, the script link, Watch it run) sit above the curtain, so focus there keeps it closed too.
    var onCurtain = function (node) {
      return ov.contains(node) || (badge !== null && badge.contains(node)) || (band !== null && band.contains(node));
    };
    var drive = function (delta) {
      if (!done && delta) ov.scrollTop = Math.max(0, ov.scrollTop + delta);
    };
    var typing = function (node) {
      return node instanceof Element && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));
    };
    skip.addEventListener("click", toResults);
    document.addEventListener("focusin", function (e) {
      if (!done && e.target instanceof Node && !onCurtain(e.target)) open();
    });
    window.addEventListener("hashchange", function () { if (window.location.hash) open(); });
    ov.addEventListener("scroll", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", function () {
      runway();
      if (!done) ov.scrollTop = progress * distance;
      update();
    });
    // The page is locked while the curtain is up, so a wheel or a swipe that starts off the curtain (the sample chip, or
    // the page in the gap) moves the curtain's runway instead. Passive: nothing is cancelled.
    document.addEventListener("wheel", function (e) {
      if (done || (e.target instanceof Node && ov.contains(e.target))) return;
      drive(e.deltaY * (e.deltaMode === 1 ? LINE : e.deltaMode === 2 ? window.innerHeight : 1));
    }, { passive: true });
    var touchY = null;
    document.addEventListener("touchstart", function (e) {
      touchY = !done && e.touches.length === 1 && !(e.target instanceof Node && ov.contains(e.target)) ? e.touches[0].clientY : null;
    }, { passive: true });
    document.addEventListener("touchmove", function (e) {
      if (touchY === null || e.touches.length !== 1) return;
      var y = e.touches[0].clientY;
      drive(touchY - y);
      touchY = y;
    }, { passive: true });
    document.addEventListener("touchend", function () { touchY = null; }, { passive: true });
    // The scroll keys with focus on the page (not on the curtain, where they scroll it natively, and not while typing)
    // move the runway; the reverse keys do nothing, as progress never goes back.
    document.addEventListener("keydown", function (e) {
      var at = document.activeElement;
      if (done || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(at)) return;
      if (at && at !== document.body && at !== root && ov.contains(at)) return;
      var onPage = !at || at === document.body || at === root;
      var step = e.key === "ArrowDown" ? LINE
        : e.key === "PageDown" ? distance * KEY_STEP
        : e.key === " " && !e.shiftKey && onPage ? distance * KEY_STEP
        : e.key === "End" ? distance + 2 : 0;
      if (!step) return;
      e.preventDefault();
      drive(step);
    });
    if (reduce) {
      var calm = function () { if (reduce.matches) open(); };
      if (reduce.addEventListener) reduce.addEventListener("change", calm);
      else if (reduce.addListener) reduce.addListener(calm);
    }
    setCurtain(0);
    runway();
    var focused = document.activeElement;
    if (window.location.hash || (focused && focused !== document.body && focused !== root && !onCurtain(focused))) open();
    else update();
  }
  // The band's height changes with the width and the web fonts arriving; the curtain follows it.
  bandHeight();
  if (band && window.ResizeObserver) new ResizeObserver(bandHeight).observe(band);
  else window.addEventListener("resize", bandHeight);

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
