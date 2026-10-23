/* The tokenmax-map skill block (#skill) on the home page and on /tm/.
 * - Copy the install prompt: the clipboard, then execCommand, then select the prompt with a keyboard hint (the /tm/
 *   prompt's pattern). The button reads "Copied" and a status line says so, for four seconds.
 * - The example report prints row by row once it is in view. Under reduced motion, without IntersectionObserver or
 *   without this script it stays at data-state="done" with every row shown; reduced motion turned on mid-print ends it.
 * Sends nothing and stores nothing. */
(function () {
  "use strict";
  var root = document.getElementById("skill");
  if (!root) return;

  var prompt = document.getElementById("skillPrompt");
  var btn = document.getElementById("skillCopy");
  var msg = document.getElementById("skillCopyMsg");
  if (prompt && btn && msg) {
    var LABEL = btn.textContent;
    var timer = 0;
    var say = function (text, copied) {
      msg.textContent = text;
      btn.textContent = copied ? "Copied" : LABEL;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { msg.textContent = ""; btn.textContent = LABEL; }, 4000);
    };
    var COPIED = "Copied. Paste it into Claude Code or Codex on your computer.";
    var legacy = function () {
      var t = document.createElement("textarea");
      t.value = prompt.textContent || ""; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      t.remove();
      return ok;
    };
    var fallback = function () {
      if (legacy()) { say(COPIED, true); return; }
      var range = document.createRange();
      range.selectNodeContents(prompt);
      var sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
      say("The prompt is selected. Press " + (mac ? "Cmd+C" : "Ctrl+C") + " to copy it.", false);
    };
    btn.addEventListener("click", function () {
      var clip = navigator.clipboard;
      if (clip && typeof clip.writeText === "function") clip.writeText(prompt.textContent || "").then(function () { say(COPIED, true); }, fallback);
      else fallback();
    });
  }

  var out = document.getElementById("skillOut");
  if (!out) return;
  var rows = out.querySelectorAll(".sk-row");
  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  if ((mq && mq.matches) || !("IntersectionObserver" in window) || !rows.length) return;

  var STEP = 380, LEAD = 250, timers = [];
  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) { io.disconnect(); play(); return; }
  }, { threshold: 0.2 });
  function finish() {
    io.disconnect();
    for (var i = 0; i < timers.length; i++) window.clearTimeout(timers[i]);
    for (var j = 0; j < rows.length; j++) rows[j].classList.add("on");
    out.setAttribute("data-state", "done");
  }
  function play() {
    out.setAttribute("data-state", "playing");
    Array.prototype.forEach.call(rows, function (row, i) {
      timers.push(window.setTimeout(function () { row.classList.add("on"); }, LEAD + i * STEP));
    });
    timers.push(window.setTimeout(finish, LEAD + rows.length * STEP + 450));
  }
  out.setAttribute("data-state", "ready");
  io.observe(out);
  if (mq) {
    var onChange = function (e) { if (e.matches) finish(); };
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  }
})();
