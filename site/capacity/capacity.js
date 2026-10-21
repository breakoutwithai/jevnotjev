/* The /capacity/ aggregate view of the TokenMax board (tm-share/1 maps).
   Reads GET /api/maps on load and every 10 seconds, sums the rows in the browser and writes the result with textContent only.
   No alias, id or row is ever shown, and nothing is sent. A figure the maps do not carry is shown as "not measured". */
(function () {
  "use strict";

  var POLL_MS = 10000;
  var NOT_MEASURED = "not measured";

  function isObj(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
  function capsOf(row) { return isObj(row.caps) ? row.caps : {}; }
  function capTotal(row) { var c = capsOf(row); return num(c.short) + num(c.weekly) + num(c.unknown); }
  function tokens(row, key) { return isObj(row.output_tokens) ? num(row.output_tokens[key]) : 0; }

  function side(rows) {
    var out = { maps: rows.length, short: 0, weekly: 0, unknown: 0, claude: 0, codex: 0, readings: 0, usedSum: 0 };
    rows.forEach(function (row) {
      var c = capsOf(row);
      out.short += num(c.short); out.weekly += num(c.weekly); out.unknown += num(c.unknown);
      out.claude += tokens(row, "claude"); out.codex += tokens(row, "codex");
      if (typeof row.codex_weekly_pct === "number" && isFinite(row.codex_weekly_pct)) { out.readings += 1; out.usedSum += row.codex_weekly_pct; }
    });
    out.meanUsed = out.readings ? Math.round(out.usedSum / out.readings) : null;
    out.meanHeadroom = out.readings ? 100 - out.meanUsed : null;
    return out;
  }

  /* rows: board rows, newest first, at most 100. totals: the server's totals over every stored map. */
  function summarise(rows, totals) {
    var list = Array.isArray(rows) ? rows.filter(isObj) : [];
    var free = list.filter(function (r) { return capTotal(r) === 0; });
    var hit = list.filter(function (r) { return capTotal(r) > 0; });
    var all = side(list);
    var stored = isObj(totals) && typeof totals.builders === "number" ? totals.builders : list.length;
    return { stored: stored, shown: list.length, all: all, free: side(free), hit: side(hit) };
  }

  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function pct(n) { return n === null ? NOT_MEASURED : n + "%"; }

  function cell(tr, text, cls) {
    var td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    tr.appendChild(td);
  }
  function fill(id, lines) {
    var body = document.getElementById(id);
    while (body.firstChild) body.removeChild(body.firstChild);
    lines.forEach(function (line) {
      var tr = document.createElement("tr");
      line.forEach(function (text, i) { cell(tr, text, i > 0 && text === NOT_MEASURED ? "cap-nm" : ""); });
      body.appendChild(tr);
    });
  }

  function render(s) {
    var tiles = document.getElementById("capTiles");
    while (tiles.firstChild) tiles.removeChild(tiles.firstChild);
    [
      [fmt(s.stored), "maps shared"],
      [fmt(s.free.maps), "no cap recorded"],
      [fmt(s.hit.maps), "hit a cap"],
      [fmt(s.all.short + s.all.weekly + s.all.unknown), "cap episodes"],
    ].forEach(function (t) {
      var d = document.createElement("div");
      d.className = "cap-tile";
      var b = document.createElement("b"); b.textContent = t[0];
      var sp = document.createElement("span"); sp.textContent = t[1];
      d.appendChild(b); d.appendChild(sp);
      tiles.appendChild(d);
    });
    fill("capWindows", [["Short (session)", fmt(s.all.short)], ["Weekly", fmt(s.all.weekly)], ["Unknown window", fmt(s.all.unknown)]]);
    fill("capSides", [
      ["Maps", fmt(s.free.maps), fmt(s.hit.maps)],
      ["Claude output tokens used", fmt(s.free.claude), fmt(s.hit.claude)],
      ["Codex output tokens used", fmt(s.free.codex), fmt(s.hit.codex)],
      ["Maps with a Codex weekly reading", fmt(s.free.readings), fmt(s.hit.readings)],
      ["Mean Codex weekly used", pct(s.free.meanUsed), pct(s.hit.meanUsed)],
      ["Mean Codex weekly headroom", pct(s.free.meanHeadroom), pct(s.hit.meanHeadroom)],
    ]);
    var gaps = document.getElementById("capGaps");
    while (gaps.firstChild) gaps.removeChild(gaps.firstChild);
    [
      "Plan tier (Lite or other): " + NOT_MEASURED + ". Maps carry no plan field.",
      "Unused tokens: " + NOT_MEASURED + ". Maps carry tokens used, and a used percent for Codex only. Claude headroom is " + NOT_MEASURED + ".",
      "Same-window matching of spare capacity to a capped session: " + NOT_MEASURED + ". Maps carry no timestamps or reset readings, by design.",
      "Jev analysis of each map: not run. No model runs on board data.",
    ].forEach(function (text) {
      var li = document.createElement("li"); li.textContent = text; gaps.appendChild(li);
    });
    if (s.shown < s.stored) {
      document.getElementById("capAlert").textContent = "Sums cover the newest " + s.shown + " of " + s.stored + " maps.";
    } else {
      document.getElementById("capAlert").textContent = "";
    }
    document.getElementById("capBody").hidden = false;
  }

  function stamp() {
    var d = new Date();
    return "Updated " + d.toTimeString().slice(0, 8) + ". Reads the board every 10 seconds.";
  }

  function load() {
    return fetch("/api/maps", { credentials: "same-origin", cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error("status " + res.status); return res.json(); })
      .then(function (data) {
        if (!isObj(data) || !Array.isArray(data.rows)) throw new Error("shape");
        render(summarise(data.rows, data.totals));
        document.getElementById("capStatus").textContent = stamp();
        if (data.rows.length === 0) document.getElementById("capStatus").textContent += " No maps shared yet.";
      })
      .catch(function () {
        document.getElementById("capStatus").textContent = "";
        document.getElementById("capAlert").textContent = "The board could not be read. Showing the last good numbers, if any. Trying again in 10 seconds.";
      });
  }

  window.TMCapacity = { summarise: summarise };
  load();
  setInterval(function () { if (!document.hidden) load(); }, POLL_MS);
})();
