/* The opening curtain and the house lights for the thin theatre frame. */
(function () {
  "use strict";
  var root = document.documentElement;
  /* The curtains part by CSS animation alone (theatre.css); this only records the end and takes them off the page.
     PART_FALLBACK_MS covers the 1.3s part with margin, for a browser that never fires animationend. The curtain plays
     only when the pre-paint script set html.overture-play (motion on, first page of the tab session). */
  var PART_FALLBACK_MS = 1800;
  var ov = document.getElementById("overture");
  function opened() {
    if (ov) ov.classList.add("gone");
    root.dataset.curtain = "open";
  }
  if (!root.classList.contains("motion") || !root.classList.contains("overture-play") || !ov) opened();
  else {
    root.dataset.curtain = "parting";
    ov.addEventListener("animationend", function (e) { if (e.animationName === "part-r") opened(); });
    setTimeout(opened, PART_FALLBACK_MS);
  }
  var lights = document.getElementById("lights");
  if (!lights) return;
  function darkNow() {
    var theme = root.getAttribute("data-theme");
    return theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function sync() { lights.textContent = darkNow() ? "House lights up" : "House lights down"; }
  lights.addEventListener("click", function () {
    root.setAttribute("data-theme", darkNow() ? "light" : "dark");
    sync();
  });
  sync();
  if (window.JNJ && window.JNJ.meta) document.getElementById("sampleBadge").title = window.JNJ.meta.note;
})();
