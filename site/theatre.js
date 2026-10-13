/* House lights for the thin theatre frame. */
(function () {
  "use strict";
  var root = document.documentElement;
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
