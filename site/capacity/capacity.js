/* The /capacity/ aggregate view of the TokenMax board (tm-share/1 maps).
   Reads GET /api/maps on load and every 10 seconds, sums the rows in the browser and writes the result with textContent only.
   No alias, id or row is ever shown, and nothing is sent. A figure the maps do not carry is shown as "not measured". */
(function () {
  "use strict";

  var POLL_MS = 10000;
  var NOT_MEASURED = "not measured";
  /* /tm/ Submit sends skill "0.0.0" for a pasted block: its caps.short and caps.weekly are fixed at 0 and every limit hit is
     counted in caps.unknown (src/browser/tm-submit.ts weekToPayload). Its Short and Weekly figures are therefore not measured. */
  var PASTED_SKILL = "0.0.0";

  function isObj(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
  function capsOf(row) { return isObj(row.caps) ? row.caps : {}; }
  function capTotal(row) { var c = capsOf(row); return num(c.short) + num(c.weekly) + num(c.unknown); }
  function tokens(row, key) { return isObj(row.output_tokens) ? num(row.output_tokens[key]) : 0; }

  /* A map that did not read a provider's logs carries a placeholder 0 for it: count that provider only where it was collected. */
  function collected(row, provider) { return row.sources === provider || row.sources === "claude+codex"; }

  function side(rows) {
    var out = { maps: rows.length, short: 0, weekly: 0, unknown: 0, claude: 0, codex: 0, claudeMaps: 0, codexMaps: 0, readings: 0, usedSum: 0 };
    rows.forEach(function (row) {
      var c = capsOf(row);
      out.short += num(c.short); out.weekly += num(c.weekly); out.unknown += num(c.unknown);
      if (collected(row, "claude")) { out.claudeMaps += 1; out.claude += tokens(row, "claude"); }
      if (collected(row, "codex")) {
        out.codexMaps += 1; out.codex += tokens(row, "codex");
        if (typeof row.codex_weekly_pct === "number" && isFinite(row.codex_weekly_pct)) { out.readings += 1; out.usedSum += row.codex_weekly_pct; }
      }
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
    var pasted = list.filter(function (r) { return r.skill === PASTED_SKILL; });
    var stored = isObj(totals) && typeof totals.builders === "number" ? Math.max(totals.builders, list.length) : list.length;
    return { stored: stored, shown: list.length, all: side(list), free: side(free), hit: side(hit), pasted: side(pasted) };
  }

  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  /* 1234567 -> "1.2M", 89012 -> "89K", 999 -> "999" (the /maps/ board's rule). A summed token figure can reach 100 maps x 10^12,
     so the full number would be 19 characters wide and push a 320 px table past the screen. */
  function compact(n) {
    var units = [[1e3, "K"], [1e6, "M"], [1e9, "B"], [1e12, "T"]];
    for (var i = units.length - 1; i >= 0; i--) {
      if (n < units[i][0]) continue;
      var v = n / units[i][0];
      var r = v < 100 ? Math.round(v * 10) / 10 : Math.round(v);
      if (r >= 1000 && i < units.length - 1) { i += 1; v = n / units[i][0]; r = Math.round(v * 10) / 10; }
      return String(r) + units[i][1];
    }
    return String(n);
  }
  /* Tokens used by the maps that read this provider; none read it: not measured, never a bare 0. */
  function tok(n, coverage) { return coverage === 0 ? NOT_MEASURED : compact(n); }
  function pct(n) { return n === null ? NOT_MEASURED : n + "%"; }
  function plural(n, one, many) { return n === 1 ? one : many; }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function cell(tr, text, cls) {
    var td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    tr.appendChild(td);
  }
  function fill(id, lines) {
    var body = document.getElementById(id);
    clear(body);
    lines.forEach(function (line) {
      var tr = document.createElement("tr");
      line.forEach(function (text, i) { cell(tr, text, i === 0 ? "" : text === NOT_MEASURED ? "cap-num cap-nm" : "cap-num"); });
      body.appendChild(tr);
    });
  }
  /* Only write when the text changed, so a screen reader is not told the same thing every 10 seconds. */
  function setText(id, text) {
    var el = document.getElementById(id);
    if (el.textContent !== text) el.textContent = text;
  }

  /* One sentence: what the numbers say, and that they are self-reports. */
  function reading(s) {
    if (s.shown === 0) return "No maps are shared yet, so there is nothing to count.";
    return s.hit.maps + " of " + s.shown + " " + plural(s.shown, "map", "maps") + " recorded at least one cap episode and " + s.free.maps + " recorded none. These are the builders' own reports, not verified, and spare capacity is not measured beyond Codex's weekly percent.";
  }

  /* Pasted blocks carry no short or weekly split: say so wherever Short and Weekly are shown. */
  function pastedNote(s) {
    var u = s.pasted.unknown;
    if (u === 0) return "";
    return s.pasted.maps + " pasted TokenMax " + plural(s.pasted.maps, "block reports", "blocks report") + " " + fmt(u) + " limit " + plural(u, "hit", "hits") + " without saying which kind. Those are counted as unknown window, so Short and Weekly are at least the figures shown, not measurements.";
  }

  function render(s) {
    var empty = s.shown === 0;
    setText("capReading", reading(s));
    setText("capNote", s.shown < s.stored ? "Sums cover the newest " + s.shown + " of " + s.stored + " shared maps." : "");
    document.getElementById("capFull").hidden = empty;
    if (!empty) {
      var tiles = document.getElementById("capTiles");
      clear(tiles);
      [
        [fmt(s.shown), "maps counted"],
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
      var lower = s.pasted.unknown > 0;
      fill("capWindows", [
        ["Short (session)", fmt(s.all.short) + (lower ? " or more" : "")],
        ["Weekly", fmt(s.all.weekly) + (lower ? " or more" : "")],
        ["Unknown window", fmt(s.all.unknown)],
      ]);
      setText("capPasted", pastedNote(s));
      fill("capSides", [
        ["Maps", fmt(s.free.maps), fmt(s.hit.maps)],
        ["Claude output tokens used", tok(s.free.claude, s.free.claudeMaps), tok(s.hit.claude, s.hit.claudeMaps)],
        ["Codex output tokens used", tok(s.free.codex, s.free.codexMaps), tok(s.hit.codex, s.hit.codexMaps)],
        ["Maps with a Codex weekly reading", fmt(s.free.readings), fmt(s.hit.readings)],
        ["Mean Codex weekly used", pct(s.free.meanUsed), pct(s.hit.meanUsed)],
        ["Mean Codex weekly headroom", pct(s.free.meanHeadroom), pct(s.hit.meanHeadroom)],
      ]);
    }
    var gaps = document.getElementById("capGaps");
    clear(gaps);
    [
      "Plan tier (Lite or other): " + NOT_MEASURED + ". Maps carry no plan field.",
      "Unused tokens: " + NOT_MEASURED + ". Maps carry tokens used, and a used percent for Codex only. Claude headroom is " + NOT_MEASURED + ".",
      "Same-window matching of spare capacity to a capped session: " + NOT_MEASURED + ". Maps carry no timestamps or reset readings, by design.",
      "Jev analysis of each map: not run. No model runs on board data.",
    ].forEach(function (text) {
      var li = document.createElement("li"); li.textContent = text; gaps.appendChild(li);
    });
    document.getElementById("capBody").hidden = false;
  }

  function clock() { return new Date().toTimeString().slice(0, 8); }

  var lastGood = null;      /* clock time of the last read that rendered */
  var lastAnnounced = null; /* what the polite status said last: only a change in the counts is announced */

  function load() {
    return fetch("/api/maps", { credentials: "same-origin", cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error("status " + res.status); return res.json(); })
      .then(function (data) {
        if (!isObj(data) || !Array.isArray(data.rows)) throw new Error("shape");
        var s = summarise(data.rows, data.totals);
        render(s);
        lastGood = clock();
        setText("capStamp", "Updated " + lastGood + ". Reads the board every 10 seconds.");
        setText("capAlert", "");
        var said = s.shown === 0 ? "No maps shared yet." : "Board loaded: " + s.shown + " " + plural(s.shown, "map", "maps") + " counted, " + s.hit.maps + " hit a cap.";
        if (said !== lastAnnounced) { setText("capStatus", lastAnnounced === null ? said : said.replace("Board loaded", "Board updated")); lastAnnounced = said; }
      })
      .catch(function () {
        setText("capAlert", lastGood === null
          ? "The board could not be read. Trying again in 10 seconds."
          : "The board could not be read. The numbers shown are from " + lastGood + ". Trying again in 10 seconds.");
        setText("capStamp", lastGood === null ? "No numbers yet." : "Last good read " + lastGood + ".");
      });
  }

  window.TMCapacity = { summarise: summarise };
  load();
  setInterval(function () { if (!document.hidden) load(); }, POLL_MS);
})();
