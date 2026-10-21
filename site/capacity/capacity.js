/* The /capacity/ aggregate view of the TokenMax board (tm-share/1 maps).
   Reads GET /api/maps on load and every 10 seconds, sums the rows in the browser and writes the result with textContent only.
   Every figure is shown as submitted: nothing is discounted, excluded, normalised or rounded except the Codex weekly means (one decimal).
   No alias, id or day is ever shown (each map is "Map N" by board position), and nothing is sent.
   A figure the maps do not carry is shown as "not measured" (totals) or as the /maps/ board words (per map). */
(function () {
  "use strict";

  var POLL_MS = 10000;
  var NOT_MEASURED = "not measured";
  /* /tm/ Submit sends skill "0.0.0" for a pasted block (src/browser/tm-submit.ts weekToPayload). */
  var PASTED_SKILL = "0.0.0";

  function isObj(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function num(v) { return isNum(v) ? v : 0; }
  function capsOf(row) { return isObj(row.caps) ? row.caps : {}; }
  function capTotal(row) { var c = capsOf(row); return num(c.short) + num(c.weekly) + num(c.unknown); }
  function tokens(row, key) { return isObj(row.output_tokens) ? num(row.output_tokens[key]) : 0; }

  /* A map that did not read a provider's logs carries a placeholder 0 for it: count that provider only where it was collected. */
  function collected(row, provider) { return row.sources === provider || row.sources === "claude+codex"; }
  function round1(n) { return Math.round(n * 10) / 10; }

  function side(rows) {
    var out = { maps: rows.length, short: 0, weekly: 0, unknown: 0, claude: 0, codex: 0, claudeMaps: 0, codexMaps: 0, readings: 0, usedSum: 0, days: 0, unknownMaps: 0, unknownOnlyMaps: 0 };
    rows.forEach(function (row) {
      var c = capsOf(row);
      out.short += num(c.short); out.weekly += num(c.weekly); out.unknown += num(c.unknown);
      out.days += num(row.days);
      if (num(c.unknown) > 0) out.unknownMaps += 1;
      if (num(c.unknown) > 0 && num(c.short) === 0 && num(c.weekly) === 0) out.unknownOnlyMaps += 1;
      if (collected(row, "claude")) { out.claudeMaps += 1; out.claude += tokens(row, "claude"); }
      if (collected(row, "codex")) {
        out.codexMaps += 1; out.codex += tokens(row, "codex");
        if (isNum(row.codex_weekly_pct)) { out.readings += 1; out.usedSum += row.codex_weekly_pct; }
      }
    });
    out.meanUsed = out.readings ? round1(out.usedSum / out.readings) : null;
    out.meanHeadroom = out.readings ? round1(100 - out.usedSum / out.readings) : null;
    return out;
  }

  /* The /maps/ board's words (site/maps/maps.js providerValue and pct): a provider the map did not read is "not collected"; one it
     read with no percent recorded is "not in the logs". */
  function provider(row, name, value) { return !collected(row, name) ? "not collected" : isNum(value) ? value + "%" : "not in the logs"; }

  /* One anonymous entry per map, in board order (newest first), each value as submitted. quiet: sessions / days is under 1. */
  function mapLine(row, i) {
    var c = capsOf(row), sessions = num(row.sessions), days = num(row.days);
    return {
      n: i + 1,
      pasted: row.skill === PASTED_SKILL, skill: String(row.skill),
      sessions: sessions, days: days,
      short: num(c.short), weekly: num(c.weekly), unknown: num(c.unknown),
      claude: collected(row, "claude") ? fmt(tokens(row, "claude")) : "not collected",
      codex: collected(row, "codex") ? fmt(tokens(row, "codex")) : "not collected",
      opus: provider(row, "claude", row.opus_share_pct),
      codexUsed: provider(row, "codex", row.codex_weekly_pct),
      quiet: days > 0 && sessions / days < 1,
    };
  }

  /* rows: board rows, newest first, at most 100. totals: the server's totals over every stored map. */
  function summarise(rows, totals) {
    var list = Array.isArray(rows) ? rows.filter(isObj) : [];
    var free = list.filter(function (r) { return capTotal(r) === 0; });
    var hit = list.filter(function (r) { return capTotal(r) > 0; });
    var pasted = list.filter(function (r) { return r.skill === PASTED_SKILL; });
    var stored = isObj(totals) && typeof totals.builders === "number" ? Math.max(totals.builders, list.length) : list.length;
    return { stored: stored, shown: list.length, all: side(list), free: side(free), hit: side(hit), pasted: side(pasted), maps: list.map(mapLine) };
  }

  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function pct(n) { return n === null ? NOT_MEASURED : n + "%"; }
  /* Tokens used by the maps that read this provider; none read it: not measured, never a bare 0. */
  function tok(n, coverage) { return coverage === 0 ? NOT_MEASURED : fmt(n); }
  function plural(n, one, many) { return n === 1 ? one : many; }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  /* labels: the column names, set as data-label so a narrow screen can stack each cell under its name (capacity.css). */
  function fill(id, lines, labels) {
    var body = document.getElementById(id);
    clear(body);
    lines.forEach(function (line) {
      var tr = document.createElement("tr");
      line.forEach(function (text, i) {
        var td = document.createElement("td");
        td.textContent = text;
        if (i > 0) td.className = text === NOT_MEASURED ? "cap-num cap-nm" : "cap-num";
        if (labels && i > 0) td.setAttribute("data-label", labels[i]);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }
  /* Only write when the text changed, so a screen reader is not told the same thing every 10 seconds. */
  function setText(id, text) {
    var el = document.getElementById(id);
    if (el.textContent !== text) el.textContent = text;
  }

  /* One sentence: what the counts say, and that they are self-reports. */
  function reading(s) {
    if (s.shown === 0) return "No maps are shared yet, so there is nothing to count.";
    return s.hit.maps + " of " + s.shown + " " + plural(s.shown, "map", "maps") + " recorded at least one cap episode and " + s.free.maps + " recorded none. Every figure is self-reported and not verified, and spare capacity is not measured beyond Codex's weekly percent.";
  }

  /* What /tm/ Submit sends for the window split (skill "0.0.0", src/browser/tm-submit.ts weekToPayload), stated once; no number is changed. */
  function pastedNote(s) {
    var u = s.pasted.unknownOnlyMaps; /* only pasted maps whose own values are Short 0, Weekly 0, unknown above 0 */
    if (u === 0) return "";
    return u + " pasted TokenMax " + plural(u, "block was", "blocks were") + " submitted with its limit hits as unknown window and Short and Weekly as 0.";
  }

  /* Every map as submitted, under its number. Values the map did not collect read as on the /maps/ board. */
  function fillMaps(maps) {
    var list = document.getElementById("capMaps");
    clear(list);
    maps.forEach(function (m) {
      var li = document.createElement("li");
      li.className = "cap-map";
      var head = document.createElement("p");
      head.className = "cap-map-head";
      head.textContent = "Map " + m.n;
      [m.pasted ? "self-reported from a pasted TokenMax block, not verified" : "self-reported by tokenmax-map " + m.skill + ", not verified", m.quiet ? "Quiet week: under 1 session a day" : ""].forEach(function (t) {
        if (!t) return;
        var sm = document.createElement("small"); sm.className = "cap-flag"; sm.textContent = t; head.appendChild(sm);
      });
      li.appendChild(head);
      var dl = document.createElement("dl");
      dl.className = "cap-fig";
      [
        ["Sessions", fmt(m.sessions)],
        ["Days", fmt(m.days)],
        ["Cap episodes, short", fmt(m.short)],
        ["Cap episodes, weekly", fmt(m.weekly)],
        ["Cap episodes, unknown window", fmt(m.unknown)],
        ["Claude output tokens", m.claude],
        ["Codex output tokens", m.codex],
        ["Opus share", m.opus],
        ["Codex weekly used", m.codexUsed],
      ].forEach(function (p) {
        var wrap = document.createElement("div");
        var dt = document.createElement("dt"); dt.textContent = p[0];
        var dd = document.createElement("dd"); dd.textContent = p[1];
        wrap.appendChild(dt); wrap.appendChild(dd); dl.appendChild(wrap);
      });
      li.appendChild(dl);
      list.appendChild(li);
    });
  }

  function render(s) {
    var empty = s.shown === 0;
    setText("capReading", reading(s));
    setText("capNote", s.shown < s.stored ? "Sums cover the newest " + s.shown + " of " + s.stored + " shared maps." : "");
    document.getElementById("capFull").hidden = empty;
    if (!empty) {
      var tiles = document.getElementById("capTiles");
      clear(tiles);
      var episodes = s.all.short + s.all.weekly + s.all.unknown;
      [
        [fmt(s.shown), plural(s.shown, "map counted", "maps counted")],
        [fmt(s.free.maps), "no cap recorded"],
        [fmt(s.hit.maps), "hit a cap"],
        [fmt(episodes), plural(episodes, "cap episode", "cap episodes")],
      ].forEach(function (t) {
        var d = document.createElement("div");
        d.className = "cap-tile";
        var b = document.createElement("b"); b.textContent = t[0];
        var sp = document.createElement("span"); sp.textContent = t[1];
        d.appendChild(b); d.appendChild(sp);
        tiles.appendChild(d);
      });
      fill("capWindows", [["Short (session)", fmt(s.all.short)], ["Weekly", fmt(s.all.weekly)], ["Unknown window", fmt(s.all.unknown)]]);
      setText("capPasted", pastedNote(s));
      fill("capSides", [
        ["Maps", fmt(s.free.maps), fmt(s.hit.maps)],
        ["Map days covered", fmt(s.free.days), fmt(s.hit.days)],
        ["Claude output tokens used", tok(s.free.claude, s.free.claudeMaps), tok(s.hit.claude, s.hit.claudeMaps)],
        ["Codex output tokens used", tok(s.free.codex, s.free.codexMaps), tok(s.hit.codex, s.hit.codexMaps)],
        ["Maps with a Codex weekly reading", fmt(s.free.readings), fmt(s.hit.readings)],
        ["Mean Codex weekly used", pct(s.free.meanUsed), pct(s.hit.meanUsed)],
        ["Mean Codex weekly headroom", pct(s.free.meanHeadroom), pct(s.hit.meanHeadroom)],
      ], ["Measure", "No cap recorded", "Hit a cap"]);
      fillMaps(s.maps);
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
