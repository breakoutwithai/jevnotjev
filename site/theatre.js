/* The opening curtain and the house lights for the thin theatre frame.
 *
 * The head script in index.html decides before first paint: html.overture-play (motion on, first page of the tab
 * session) closes the curtain over the page, carrying the playbill: marquee, the Mad TokenMax poster with its ticket
 * (one link to tm/), the Little Shop poster, the product line and Raise the curtain (#248 removed Skip; c01 made the old scroll cue a button that opens it). This script then drives it and
 * records html[data-curtain] (closed, rising or open), the root's --reveal (0 to 1) and html[data-runway] (the scroll distance, in px, over which it parts):
 * - scrolling parts it in step. The curtain is its own scroller (theatre.css): a wheel or a swipe over it scrolls it
 *   through a runway of 0.7 of the screen height. Until it is open the page itself does not scroll (theatre.css locks
 *   it), so the four pictures under it hold still in the gap. Every other way of scrolling drives
 *   the same runway: a wheel or a swipe over the House lights chip or the page in the gap, and the scroll keys (PageDown,
 *   Space, ArrowDown, End) with focus on the page; with focus on a curtain link they scroll the curtain natively. A position the page already had when this script ran (a restored
 *   scroll) counts too. Scrolling back down the runway lowers the progress again, and once the page is open and has
 *   been scrolled away from its top, coming back to the top closes the curtain again (it swings shut), on the first
 *   page of a session and on a later one alike, so the curtain follows the scroll both ways;
 * - when the playbill fades with focus still on it, the curtain opens at once, scrolls to the four pictures (#types) and moves
 *   focus to them, so focus is never dropped;
 * - the two posters are links (Mad TokenMax, Little Shop); focus on them or on House lights leaves the curtain closed
 *   (Tab goes Mad TokenMax, Little Shop, House lights, and the next Tab opens it), while focus anywhere else, focus already elsewhere when this script runs, a #hash on
 *   load or a hash change opens it at once, so nothing is focused or linked to behind it;
 * - once open the overture is display:none, and the page is where it was;
 * - the House lights chip is lifted onto the curtain while it is closed and returns to the house bar once it starts to part;
 *   a hidden copy holds its place in the house bar meanwhile, so its return moves nothing;
 * - turning reduced motion on drops it (theatre.css hides it at once; this records the page as open);
 * - the first-screen band (#tmFirst: the promise, Copy, the script link, Watch it run) sits above the curtain, which
 *   starts at its bottom (the root's --tm-first-h, kept in step with the band's height); focus on its controls keeps the
 *   curtain closed, so Tab goes Copy, the script link, Watch it run, the two posters, House lights.
 * With no curtain at load (reduced motion, a later page, missing markup, or the head script's watchdog already opened the
 * page) the page is open and --reveal is 1. If this script never runs or stalls, the head
 * script opens the page.
 * The light scroll cues (theatre.css, html.cues): one IntersectionObserver marks the acts (their stage holds the verdict
 * word), the cast, the samples and the stage door .in as they scroll into view and the CSS animates them (transform and opacity only). Without motion, or
 * with this script missing, nothing is hidden.
 */
(function () {
  "use strict";
  var root = document.documentElement;
  var RUNWAY = 0.7, FADED = 0.36, KEY_STEP = 0.4, LINE = 40;
  var ov = document.getElementById("overture");
  // The curtain's first control (the Mad TokenMax poster): the curtain needs one to play.
  var first = ov ? ov.querySelector("a[href]") : null;
  var badge = document.getElementById("sampleBadge");
  var brand = document.querySelector(".house .brand");
  // The curtain opens onto the four kinds of question (#types, focusable with tabindex=-1).
  var results = document.getElementById("types");
  var heading = results;
  var band = document.getElementById("tmFirst");
  var lights = document.getElementById("lights");
  // Raise the curtain (the old scroll cue made a button): opens it onto the four pictures, as a scroll past the fade does.
  var raise = document.getElementById("raise");
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
    away = false;
    setCurtain(1);
    if (ov) ov.classList.add("gone");
    if (brand) brand.removeAttribute("tabindex");
  }
  // The first-screen band (#tmFirst) sits above the curtain: the curtain, the lifted House lights chip and the valance start
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
  // Open, bring the four pictures to the top and put focus on them.
  function toResults() {
    open();
    var top = results ? results.getBoundingClientRect().top + window.scrollY : window.innerHeight;
    window.scrollTo({ top: top, behavior: "instant" });
    if (heading) heading.focus({ preventScroll: true });
  }

  // Motion is on when the head script chose it and reduced motion is not on now; the curtain needs its own markup too.
  function motionOn() {
    return root.classList.contains("motion") && !!ov && !!first && !!heading && !(reduce && reduce.matches);
  }
  var playing = motionOn() && root.classList.contains("overture-play");
  var away = false, closing = 0;
  function keyboardOnPage() {
    var at = document.activeElement;
    return !!at && at !== document.body && at !== root && !onCurtain(at) && at.matches(":focus-visible");
  }

  // The hidden copy of the House lights chip that holds its place in the house bar while the chip is on the curtain.
  function liftChip() {
    if (ghost || !badge) return;
    ghost = badge.cloneNode(true);
    ghost.removeAttribute("id");
    ghost.removeAttribute("role");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    ghost.classList.add("sample-ghost");
    var copies = ghost.querySelectorAll("[id]");
    for (var i = 0; i < copies.length; i++) copies[i].removeAttribute("id");
    badge.parentNode.insertBefore(ghost, badge.nextSibling);
    var copy = ghost.querySelector(".house-lights");
    if (copy && lights) copy.textContent = lights.textContent;
  }
  // The page was scrolled away from its top and is back: close the curtain again, with a short swing (theatre.css
  // html[data-closing]). Focus left on the page is dropped, as nothing behind the curtain is reachable.
  function close() {
    if (!done || !motionOn()) return;
    done = false;
    away = false;
    liftChip();
    if (brand) brand.setAttribute("tabindex", "-1");
    var at = document.activeElement;
    var onPage = at && at !== document.body && at !== root && !onCurtain(at);
    if (window.scrollY) window.scrollTo({ top: 0, behavior: "instant" });
    root.classList.add("overture-play");
    ov.classList.remove("gone");
    runway();
    ov.scrollTop = 0;
    root.dataset.closing = "1";
    window.clearTimeout(closing);
    closing = window.setTimeout(function () { delete root.dataset.closing; }, 900);
    setCurtain(0);
    // Focus left on the page would sit behind the curtain: move it to the curtain's first shown control (a very short
    // phone curtain shows no posters), else House lights on the curtain.
    if (onPage) {
      var shown = null, links = ov.querySelectorAll("a[href]");
      for (var i = 0; i < links.length && !shown; i++) if (links[i].getClientRects().length) shown = links[i];
      (shown || lights || first).focus({ preventScroll: true });
    }
  }
  // Scroll events already arrive once per frame, before animation frames: updating here opens a curtain that a jump
  // completes before anything else reads the page in that frame.
  function update() {
    if (done) {
      var y = window.scrollY;
      if (y > 1) away = true;
      // Keyboard focus on a page control (Shift+Tab to the header link scrolls to the top) is the focusin contract: the
      // visitor is working the page, so it stays open. A clicked control does not count; scrolling up closes over it.
      else if (away && !keyboardOnPage()) close();
      return;
    }
    var next = Math.min(1, Math.max(ov.scrollTop, window.scrollY) / distance);
    if (next === progress) return;
    if (root.dataset.closing) { window.clearTimeout(closing); delete root.dataset.closing; }
    // Past the fade (or open in one go) the playbill is hidden; focus on a poster would fall to the page, so open onto
    // the four pictures and focus them. Without focus on the curtain the page stays where it is.
    if (next >= FADED && ov.contains(document.activeElement)) { toResults(); return; }
    if (next >= 1) { open(); return; }
    setCurtain(next);
  }
  // The band's controls (Copy, the script link, Watch it run) sit above the curtain, so focus there keeps it closed too.
  function onCurtain(node) {
    return ov.contains(node) || (badge !== null && badge.contains(node)) || (band !== null && band.contains(node));
  }
  if (!playing) {
    root.classList.remove("overture-play");
    done = true;
    setCurtain(1);
    if (ov) ov.classList.add("gone");
  } else {
    liftChip();
    // While the curtain is closed, Tab goes from the poster to House lights, not to the brand link behind the curtain.
    if (brand) brand.setAttribute("tabindex", "-1");
    setCurtain(0);
    runway();
    var focused = document.activeElement;
    if (window.location.hash || (focused && focused !== document.body && focused !== root && !onCurtain(focused))) open();
    else update();
  }
  if (motionOn()) {
    var drive = function (delta) {
      if (!done && delta) ov.scrollTop = Math.max(0, ov.scrollTop + delta);
    };
    var typing = function (node) {
      return node instanceof Element && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));
    };
    document.addEventListener("focusin", function (e) {
      if (!done && e.target instanceof Node && !onCurtain(e.target)) open();
    });
    window.addEventListener("hashchange", function () { if (window.location.hash) open(); });
    if (raise) raise.addEventListener("click", function () { if (!done) toResults(); });
    ov.addEventListener("scroll", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", function () {
      if (done) return;
      runway();
      ov.scrollTop = progress * distance;
      update();
    });
    // The page is locked while the curtain is closed, so a wheel or a swipe that starts off the curtain (the House lights chip,
    // or the page in the gap) moves the curtain's runway instead. Passive: nothing is cancelled.
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
    // move the runway; the reverse keys (ArrowUp, PageUp, Shift+Space, Home) scroll it back (both ways).
    document.addEventListener("keydown", function (e) {
      var at = document.activeElement;
      if (done || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(at)) return;
      if (at && at !== document.body && at !== root && ov.contains(at)) return;
      var onPage = !at || at === document.body || at === root;
      var step = e.key === "ArrowDown" ? LINE
        : e.key === "PageDown" ? distance * KEY_STEP
        : e.key === " " && !e.shiftKey && onPage ? distance * KEY_STEP
        : e.key === "End" ? distance + 2
        : e.key === "ArrowUp" ? -LINE
        : e.key === "PageUp" ? -distance * KEY_STEP
        : e.key === " " && e.shiftKey && onPage ? -distance * KEY_STEP
        : e.key === "Home" ? -(distance + 2) : 0;
      if (!step) return;
      e.preventDefault();
      drive(step);
    });
    if (reduce) {
      var calm = function () { if (reduce.matches) open(); };
      if (reduce.addEventListener) reduce.addEventListener("change", calm);
      else if (reduce.addListener) reduce.addListener(calm);
    }
  }
  // The band's height changes with the width and the web fonts arriving; the curtain follows it.
  bandHeight();
  if (band && window.ResizeObserver) new ResizeObserver(bandHeight).observe(band);
  else window.addEventListener("resize", bandHeight);

  // The light scroll cues. html.cues is what lets theatre.css hide an element until it is seen, so a page without this
  // script (or without IntersectionObserver, or under reduced motion) never has anything hidden; theatre.css also gates
  // them on the live reduced-motion query. Each element is marked .in once, as it comes into view.
  if (root.classList.contains("motion") && !(reduce && reduce.matches) && "IntersectionObserver" in window) {
    var cueNodes = document.querySelectorAll(".act > .stage, .samples, .cast, .door-area .door");
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add("in");
        seen.unobserve(en.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.01 });
    root.classList.add("cues");
    for (var c = 0; c < cueNodes.length; c++) seen.observe(cueNodes[c]);
  }

  if (!lights) return;
  // Dark is the default whatever the OS prefers; data-theme="light" (House lights) is the only other state.
  function darkNow() {
    return root.getAttribute("data-theme") !== "light";
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
})();
