/* Stage-door demo UI. Reads only window.UC13_DEMO (shape documented in uc13-demo.js); holds no demo values. */
(function () {
  "use strict";
  var root = document.documentElement;
  var door = document.getElementById("door");
  var box = document.getElementById("doorDemo");
  if (!door || !box) return;
  var timers = [];
  var STEP_MS = 1500;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function word(o) { return o === "hand_off" ? "hand off" : String(o); }
  function usd(v) { var n = Number(v) || 0; return "$" + n.toFixed(n > 0 && n < 0.01 ? 6 : 4); }
  function motion() { return root.classList.contains("motion"); }
  function valid(D) {
    return D && D.schema === "jnj-uc13-demo/1" && D.arms && D.arms.length && D.messages && D.tally && D.fact_sheet;
  }
  var MODE = { sample: "Sample data", pending: "Labels pending", labelled: "Labelled" };
  var VERDICT = { accept: "accept", reject: "reject", pending: "pending: not labelled yet" };

  function messageHtml(D, m) {
    var arms = D.arms.map(function (a) {
      var o = (m.outputs && m.outputs[a.key]) || { output: "", verdict: "pending" };
      var v = VERDICT[o.verdict] ? o.verdict : "pending";
      return '<div class="dd-arm"><span class="who">' + esc(a.name) + '</span><span class="out ' + esc(o.output) + '">' + esc(word(o.output)) + '</span> <span class="dd-v ' + v + '">' + esc(VERDICT[v]) + '</span></div>';
    }).join("");
    var label = m.label ? '<p class="dd-label">Human label: ' + esc(word(m.label)) + '</p>' : "";
    return '<li class="dd-msg"><p class="dd-q"><span class="dd-id">' + esc(m.id) + '</span>' + esc(m.text) + '</p><div class="dd-arms">' + arms + '</div>' + label + '</li>';
  }

  function tallyHtml(D) {
    var labelled = D.arms.some(function (a) { return D.tally[a.key] && D.tally[a.key].accept != null; });
    var rows = D.arms.map(function (a) {
      var t = D.tally[a.key] || {};
      var right = t.accept == null ? '<span class="wait">waits on labels</span>' : esc(t.accept + " of " + t.labelled);
      return '<tr><td>' + esc(a.name) + '</td><td>' + esc(t.answer + " / " + t.hand_off) + '</td><td>' + esc(usd(t.cost_usd)) + '</td><td>' + right + '</td></tr>';
    }).join("");
    var note;
    if (labelled) {
      var unsafe = D.arms.map(function (a) { return a.name + " " + D.tally[a.key].answered_should_hand_off; }).join(", ");
      var careful = D.arms.map(function (a) { return a.name + " " + D.tally[a.key].handed_off_could_answer; }).join(", ");
      note = '<p class="dd-tally-note"><b>Answered when it should have handed off</b> (every unknown-stock and booking miss lands here): ' + esc(unsafe) + '.</p>' +
        '<p class="dd-tally-note"><b>Handed off when it could have answered:</b> ' + esc(careful) + '.</p>';
    } else {
      note = '<p class="dd-tally-note">Accuracy waits on labels: no message has a human answer yet, so no arm has right answers, and unknown-stock and booking misses cannot be counted.</p>';
    }
    var head = '<h3>All ' + esc(D.cases_total) + ' messages</h3>' +
      '<table><thead><tr><th>Arm</th><th>Answer / hand off</th><th>Cost</th><th>Right answers</th></tr></thead>';
    return '<div class="dd-tally" id="ddTally">' + head + '<tbody>' + rows + '</tbody></table>' + note + '</div>';
  }

  function render(D) {
    timers.forEach(clearTimeout);
    timers = [];
    if (!valid(D)) {
      box.innerHTML = '<h2 id="doorTitle" tabindex="-1">Stage door</h2>' +
        '<p class="dd-note">The demo data is loading soon.</p>' +
        '<div class="dd-actions"><button type="button" data-act="close">Close</button></div>';
      return;
    }
    var link = D.label_page ? '<a href="' + esc(D.label_page) + '">Label these ' + esc(D.cases_total) + ' yourself</a>' : "";
    var sheet = D.fact_sheet.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join("");
    var msgs = D.messages.map(function (m) { return messageHtml(D, m); }).join("");
    box.innerHTML =
      '<h2 id="doorTitle" tabindex="-1">Stage door: answer, or hand off to staff?</h2>' +
      '<p class="dd-note"><span class="dd-badge">' + esc(MODE[D.mode] || D.mode) + '</span>' + esc(D.note) + '</p>' +
      '<div class="dd-sheet"><h3>' + esc(D.fact_sheet.title) + '</h3>' +
      '<ul>' + sheet + '</ul></div>' +
      '<ol class="dd-msgs" aria-label="' + esc(D.messages.length + " of " + D.cases_total + " messages") + '">' + msgs + '</ol>' +
      tallyHtml(D) +
      '<div class="dd-actions"><button type="button" data-act="replay">Play again</button><button type="button" data-act="close">Close</button>' + link + '</div>';
    play();
  }

  function play() {
    timers.forEach(clearTimeout);
    timers = [];
    var items = box.querySelectorAll(".dd-msg");
    var tally = box.querySelector(".dd-tally");
    if (!motion()) {
      Array.prototype.forEach.call(items, function (li) { li.classList.add("on"); });
      if (tally) tally.classList.add("on");
      box.dataset.played = "done";
      return;
    }
    Array.prototype.forEach.call(items, function (li) { li.classList.remove("on"); });
    if (tally) tally.classList.remove("on");
    box.dataset.played = "playing";
    Array.prototype.forEach.call(items, function (li, i) {
      timers.push(setTimeout(function () { li.classList.add("on"); }, 200 + i * STEP_MS));
    });
    timers.push(setTimeout(function () {
      if (tally) tally.classList.add("on");
      box.dataset.played = "done";
    }, 200 + items.length * STEP_MS));
  }

  function open() {
    door.setAttribute("aria-expanded", "true");
    box.hidden = false;
    render(window.UC13_DEMO);
    var h = document.getElementById("doorTitle");
    box.scrollIntoView({ behavior: motion() ? "smooth" : "auto", block: "start" });
    if (h) h.focus({ preventScroll: true });
  }
  function close() {
    timers.forEach(clearTimeout);
    timers = [];
    door.setAttribute("aria-expanded", "false");
    box.hidden = true;
    door.focus();
  }

  door.addEventListener("click", function () {
    if (door.getAttribute("aria-expanded") === "true") close();
    else open();
  });
  box.addEventListener("click", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var act = t.getAttribute("data-act");
    if (act === "replay") play();
    else if (act === "close") close();
  });
})();
