/* Little Shop of Horrors: draws the orchestra fan and wires the buttons. Data from window.JNJ_LITTLE_SHOP
 * (shop-data.js, generated from the recorded run), logic from window.JNJSeating (seating.js), the verdict from
 * window.JNJShopVerdict (verdict.js, src/core bundled). Holds no data values of its own and makes no network request. */
(function () {
  "use strict";
  var D = window.JNJ_LITTLE_SHOP, S = window.JNJSeating, V = window.JNJShopVerdict;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function word(v) { return v === "answer" ? "Answer" : "Hand off"; }

  var fan = $("fan"), idle = $("idle"), act = $("act");
  if (!fan || !idle || !act) return;
  if (!S || !D || !Array.isArray(D.messages) || !Array.isArray(D.arms) || D.messages.length !== S.ROWS.length * S.PER_ROW) {
    idle.textContent = "The seating data did not load, so the house stays closed.";
    return;
  }

  var store = (function () { try { return window.localStorage; } catch (e) { return null; } })();
  var ids = D.messages.map(function (m) { return m.id; });
  var byId = {};
  D.messages.forEach(function (m, i) { byId[m.id] = { m: m, code: S.seatCode(i) }; });
  var state = S.withCalls(S.load(store, ids));
  var kept = store !== null;
  var verdictToken = 0;

  /* The fan: five curved rows of eight around the stage lip (760 x 480). On phones the CSS ignores --x and --y and
     stacks the rows. */
  var seatEls = {};
  for (var r = 0; r < S.ROWS.length; r++) {
    var row = document.createElement("div");
    row.className = "row";
    row.innerHTML = '<p class="row-name">Row ' + S.ROWS.charAt(r) + '</p>';
    var seats = document.createElement("div");
    seats.className = "seats";
    for (var i = 0; i < S.PER_ROW; i++) {
      var n = r * S.PER_ROW + i, id = ids[n];
      var R = 170 + r * 62, th = (-52 + i * (104 / 7)) * Math.PI / 180;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "seat";
      b.dataset.id = id;
      b.textContent = byId[id].code;
      b.style.setProperty("--x", Math.round(380 + R * Math.sin(th) - 20) + "px");
      b.style.setProperty("--y", Math.round(30 + R * Math.cos(th) - 20) + "px");
      seats.appendChild(b);
      seatEls[id] = b;
    }
    row.appendChild(seats);
    fan.appendChild(row);
  }

  var rowBtns = $("rowBtns"), seatAll = $("seatAll");
  var rowEls = S.ROWS.split("").map(function (letter, r) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "rowbtn";
    b.dataset.row = String(r);
    rowBtns.insertBefore(b, seatAll);
    return b;
  });
  function rowIds(r) { return ids.slice(r * S.PER_ROW, (r + 1) * S.PER_ROW); }

  /* Merge with what storage holds now, so a call made in another tab is kept. */
  function persist() {
    var stored = S.load(store, ids);
    Object.keys(state.calls).forEach(function (id) { stored[id] = state.calls[id]; });
    state = { calls: stored, cur: state.cur, queue: state.queue };
    kept = S.save(store, state.calls);
  }

  function renderSeats() {
    ids.forEach(function (id) {
      var b = seatEls[id], call = state.calls[id];
      b.className = "seat" + (call ? " " + call : "");
      if (state.cur === id) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
      b.setAttribute("aria-label", "Seat " + byId[id].code + ": " + byId[id].m.text + " " + (call ? "Your call: " + word(call).toLowerCase() + "." : "Empty."));
    });
    rowEls.forEach(function (b, r) {
      var left = rowIds(r).filter(function (id) { return !state.calls[id]; }).length;
      var letter = S.ROWS.charAt(r);
      b.textContent = left ? "Seat row " + letter : "Row " + letter + " full";
      b.disabled = left === 0;
    });
    seatAll.disabled = S.count(state.calls) === ids.length;
    $("taken").textContent = String(S.taken(state.calls, D.arms.length));
    $("saved").textContent = kept ? "" : "This browser is not keeping your calls: they last until you leave the page.";
  }

  function renderStage() {
    var cur = state.cur ? byId[state.cur] : null;
    idle.hidden = !!cur;
    act.hidden = !cur;
    if (!cur) return;
    var call = state.calls[state.cur];
    $("curCode").textContent = cur.code;
    $("queueLeft").textContent = state.queue.length ? " · " + state.queue.length + " more in the queue" : "";
    $("curText").textContent = "“" + cur.m.text + "”";
    $("ask").hidden = !!call;
    var yc = $("yourCall");
    yc.hidden = !call;
    yc.textContent = call ? "Your call: " + word(call) : "";
    $("clerks").innerHTML = D.arms.map(function (a) {
      var out = cur.m.outputs[a.key];
      var mark = !call ? '<span class="mark wait">Waiting for your call</span>'
        : out === call ? '<span class="mark ok">Accepted</span>' : '<span class="mark bad">Rejected</span>';
      return '<li><span><b>' + esc(a.name) + '</b> said ' + esc(word(out)) + '</span>' + mark + '</li>';
    }).join("");
  }

  function renderProgramme() {
    var rows = S.tally(D, state.calls);
    $("arms").innerHTML = rows.map(function (a) {
      var pct = a.calls ? Math.round(a.accepted / a.calls * 100) : 0;
      var per = a.perAccepted !== null ? "about " + S.usd(a.perAccepted) + " per accepted"
        : a.calls === 0 ? "cost per accepted: none yet" : a.accepted === 0 ? "cost per accepted: none accepted yet" : "cost per accepted: n/a";
      return '<li><div class="arm-head"><b>' + esc(a.name) + '</b><span>' + a.accepted + ' of ' + a.calls + ' accepted</span></div>' +
        '<div class="bar" aria-hidden="true"><span style="width:' + pct + '%"></span></div>' +
        '<p class="arm-foot">' + esc(a.model) + ' · ' + D.messages.length + ' answers cost ' + esc(S.usd(a.spend_usd)) + ' · ' + per + '</p></li>';
    }).join("");
    renderVerdict();
  }

  function renderVerdict() {
    var el = $("verdict"), n = S.count(state.calls), token = ++verdictToken;
    if (n < S.VERDICT_AT) {
      el.className = "verdict wait";
      el.textContent = "The verdict is read at " + S.VERDICT_AT + " calls. " + (S.VERDICT_AT - n) + " to go.";
      return;
    }
    if (!V || typeof V.shopVerdict !== "function") { el.className = "verdict"; el.textContent = "The verdict could not be read in this browser."; return; }
    el.className = "verdict wait";
    el.textContent = "Reading the verdict on your " + n + " calls.";
    V.shopVerdict(D.records_csv, state.calls).then(function (v) {
      if (token !== verdictToken) return;
      var rest = v.reason.indexOf(v.verdict + ": ") === 0 ? v.reason.slice(v.verdict.length + 2) : v.reason;
      el.className = "verdict";
      el.innerHTML = "On your " + n + " calls: <b>" + esc(v.verdict) + "</b>. " + esc(rest) + "." +
        '<span class="verdict-src">Read by <a href="https://github.com/breakoutwithai/jevnotjev/blob/main/src/core/verdict.ts">src/core/verdict.ts</a>, the same rules the command line applies, on the run\'s records labelled with your calls.</span>';
    }, function () {
      if (token !== verdictToken) return;
      el.className = "verdict";
      el.textContent = "The verdict could not be read in this browser.";
    });
  }

  function update() { renderSeats(); renderStage(); renderProgramme(); }

  function focusCall() { var b = $("sayAnswer"); if (b && !$("ask").hidden) b.focus(); }

  fan.addEventListener("click", function (e) {
    var t = e.target instanceof Element ? e.target.closest(".seat") : null;
    if (!t) return;
    state = S.pick(state, t.dataset.id);
    update();
    if (!state.calls[state.cur]) focusCall();
  });
  rowBtns.addEventListener("click", function (e) {
    var t = e.target instanceof Element ? e.target.closest(".rowbtn") : null;
    if (!t || t.disabled) return;
    state = S.queueUp(state, rowIds(Number(t.dataset.row)));
    update();
    focusCall();
  });
  seatAll.addEventListener("click", function () { state = S.queueUp(state, ids); update(); focusCall(); });
  $("emptyHouse").addEventListener("click", function () {
    var r = S.emptyHouse(store);
    state = r.state;
    kept = r.cleared;
    update();
    if (store && !r.cleared) $("saved").textContent = "This browser would not let us remove your saved calls; clear this site's data to remove them.";
  });
  /* Another tab changed the calls: read them back so neither tab overwrites the other with a stale copy. */
  window.addEventListener("storage", function (e) {
    if (e.key !== null && e.key !== S.KEY) return;
    state = { calls: S.load(store, ids), cur: state.cur, queue: state.queue };
    update();
  });
  function say(call) {
    state = S.decide(state, call);
    persist();
    update();
    if (!state.calls[state.cur]) focusCall(); else $("onstage").focus();
  }
  $("sayAnswer").addEventListener("click", function () { say("answer"); });
  $("sayHand").addEventListener("click", function () { say("hand_off"); });

  if (D.fact_sheet && Array.isArray(D.fact_sheet.lines)) {
    $("sheetTitle").textContent = D.fact_sheet.title;
    $("sheetLines").innerHTML = D.fact_sheet.lines.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("");
  } else $("sheet").hidden = true;

  update();
})();
