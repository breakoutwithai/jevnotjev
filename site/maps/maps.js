/* The /maps/ share page and board (tm-share/1).
   #m=<base64url JSON>: decode and check the payload in this browser and show it; nothing is sent until Share.
   #delete=<id>.<key>: one Delete my row button.
   No fragment: read the board.
   Data from the link or the server is written with textContent only. */
(function () {
  "use strict";

  var KEYS = ["v", "skill", "days", "sources", "sessions", "subagent_sessions", "caps", "output_tokens", "opus_share_pct", "codex_weekly_pct"];
  var CAP_KEYS = ["short", "weekly", "unknown"];
  var TOKEN_KEYS = ["claude", "codex"];
  var SOURCES = ["claude", "codex", "claude+codex"];
  var MAX_FRAGMENT = 4096;
  /* tm-share/1 [min, max] per leaf: the same table as src/backstage/maps.ts MAP_BOUNDS and the mapper's RANGES
     (src/backstage/maps.test.ts asserts the three agree, reading this line as JSON). */
  var BOUNDS = {"days":[1,90],"sessions":[0,1000000],"subagent_sessions":[0,1000000],"caps.short":[0,10000],"caps.weekly":[0,10000],"caps.unknown":[0,10000],"output_tokens.claude":[0,1000000000000],"output_tokens.codex":[0,1000000000000],"opus_share_pct":[0,100],"codex_weekly_pct":[0,100]};

  var el = function (id) { return document.getElementById(id); };
  var status = el("mapStatus");
  var alertBox = el("mapAlert");

  function isObj(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
  function int(v, lo, hi) { return typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi; }
  function inRange(v, leaf) { return int(v, BOUNDS[leaf][0], BOUNDS[leaf][1]); }
  function sameKeys(o, keys) {
    var own = Object.keys(o);
    if (own.length !== keys.length) return false;
    for (var i = 0; i < keys.length; i++) if (own.indexOf(keys[i]) < 0) return false;
    return true;
  }

  /* A light copy of the server's tm-share/1 rules: exact keys in order, types and ranges. */
  function checkPayload(p) {
    if (!isObj(p)) return false;
    var own = Object.keys(p);
    if (own.length !== KEYS.length) return false;
    for (var i = 0; i < KEYS.length; i++) if (own[i] !== KEYS[i]) return false;
    if (p.v !== "tm-share/1") return false;
    if (typeof p.skill !== "string" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(p.skill)) return false;
    return checkMeasurements(p);
  }

  function checkMeasurements(p) {
    if (!inRange(p.days, "days")) return false;
    if (SOURCES.indexOf(p.sources) < 0) return false;
    if (!inRange(p.sessions, "sessions") || !inRange(p.subagent_sessions, "subagent_sessions") || p.subagent_sessions > p.sessions) return false;
    if (!isObj(p.caps) || !sameKeys(p.caps, CAP_KEYS)) return false;
    for (var c = 0; c < CAP_KEYS.length; c++) if (!inRange(p.caps[CAP_KEYS[c]], "caps." + CAP_KEYS[c])) return false;
    if (!isObj(p.output_tokens) || !sameKeys(p.output_tokens, TOKEN_KEYS)) return false;
    for (var t = 0; t < TOKEN_KEYS.length; t++) if (!inRange(p.output_tokens[TOKEN_KEYS[t]], "output_tokens." + TOKEN_KEYS[t])) return false;
    if (!inRange(p.opus_share_pct, "opus_share_pct")) return false;
    if (p.codex_weekly_pct !== null && !inRange(p.codex_weekly_pct, "codex_weekly_pct")) return false;
    return true;
  }

  function decode(data) {
    if (!data || data.length > MAX_FRAGMENT || !/^[A-Za-z0-9_-]+$/.test(data) || data.length % 4 === 1) return null;
    try {
      var b64 = data.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return checkPayload(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomAlias() {
    var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var bytes = crypto.getRandomValues(new Uint8Array(4));
    var out = "builder-";
    for (var i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  function fmt(n) { return typeof n === "number" ? n.toLocaleString("en-US") : "none read"; }
  /* 1234567 -> "1.2M", 89012 -> "89K", 999 -> "999". One decimal under 100 of a unit, none above. */
  function compact(n) {
    if (typeof n !== "number") return "none read";
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
  function collected(sources, provider) { return sources === provider || sources === "claude+codex"; }
  function providerValue(p, provider, value, format) { return collected(p.sources, provider) ? format(value) : "not collected"; }
  function pct(n) { return typeof n === "number" ? n + "%" : "none read"; }

  function say(text) { alertBox.textContent = ""; status.textContent = text; }
  function warn(text) { status.textContent = ""; alertBox.textContent = text; }
  function clearMessages() { status.textContent = ""; alertBox.textContent = ""; }

  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function reasonOf(body, httpStatus) {
    if (isObj(body)) {
      if (typeof body.reason === "string" && body.reason) return body.reason;
      if (body.code === "rate-limited") return "too many requests from this network, try again later";
      if (body.code === "request-key-reused") return "this link was already shared with other details; reload the link to start again";
      if (body.code === "maps-unavailable") return "the board is not available right now";
      if (typeof body.code === "string" && body.code) return body.code;
    }
    return "the server answered " + httpStatus;
  }

  function postJson(path, body) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, status: res.status, body: data }; }, function () { return { ok: res.ok, status: res.status, body: null }; });
    });
  }

  /* ---------- Board ---------- */
  /* A stat tile: one big figure (built by fill) and a short plain-words label. */
  function tile(fill, label) {
    var t = node("div", "map-tile");
    var fig = node("p", "map-tile-figure");
    fill(fig);
    t.appendChild(fig);
    t.appendChild(node("p", "map-tile-label", label));
    return t;
  }
  function textFill(text) { return function (fig) { fig.textContent = text; }; }
  function capsText(caps) { return fmt(caps.short) + " / " + fmt(caps.weekly) + " / " + fmt(caps.unknown); }
  function plural(n, one, many) { return n === 1 ? one : many; }

  function validBoard(board) {
    if (!isObj(board) || !Array.isArray(board.rows) || !isObj(board.totals)) return false;
    var totals = board.totals;
    if (!int(totals.builders, 0, Number.MAX_SAFE_INTEGER) || !int(totals.cap_episodes, 0, Number.MAX_SAFE_INTEGER) || !int(totals.with_weekly_cap, 0, totals.builders)) return false;
    if (totals.builders < board.rows.length || (board.rows.length === 0 && (totals.builders !== 0 || totals.cap_episodes !== 0 || totals.with_weekly_cap !== 0))) return false;
    var ids = [];
    for (var i = 0; i < board.rows.length; i++) {
      var r = board.rows[i];
      if (!isObj(r) || typeof r.id !== "string" || !/^TM-[0-9A-F]{12}$/.test(r.id) || ids.indexOf(r.id) >= 0 || typeof r.alias !== "string" || typeof r.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || typeof r.skill !== "string") return false;
      // Validate measurement fields with the same rules as the preview. Display strings remain text-only.
      if (!checkMeasurements(r)) return false;
      ids.push(r.id);
    }
    return true;
  }

  function renderBoard(board, mineId) {
    if (!validBoard(board)) {
      el("mapBoardSection").hidden = true;
      warn("The board is not available right now.");
      return false;
    }
    var section = el("mapBoardSection");
    var list = el("mapBoard");
    list.textContent = "";
    var rows = board.rows;
    var totals = board.totals;
    el("mapEmpty").hidden = rows.length !== 0;
    var builders = totals.builders;
    var episodes = totals.cap_episodes;
    var weekly = totals.with_weekly_cap;
    var head = el("mapTotals");
    head.textContent = "";
    var stats = [
      ["builders", builders, plural(builders, "builder mapped", "builders mapped")],
      ["cap_episodes", episodes, plural(episodes, "cap hit, a time a limit stopped someone", "cap hits, times a limit stopped someone")],
      ["with_weekly_cap", weekly, plural(weekly, "builder hit a weekly cap", "builders hit a weekly cap")]
    ];
    for (var s = 0; s < stats.length; s++) {
      var t = tile(textFill(fmt(stats[s][1])), stats[s][2]);
      t.setAttribute("data-total", stats[s][0]);
      head.appendChild(t);
    }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      // A cast-list line: alias (and a "you" tag on your own row), the day on the right, then the figures.
      var li = node("li", "map-row");
      li.setAttribute("data-map-id", r.id);
      var who = node("p", "map-row-who");
      who.appendChild(node("span", "map-row-alias", String(r.alias)));
      if (mineId && r.id === mineId) {
        li.className += " mine";
        who.appendChild(node("small", "map-row-mine", "you"));
      }
      li.appendChild(who);
      li.appendChild(node("p", "map-row-day", String(r.day) + (typeof r.days === "number" ? ", " + r.days + plural(r.days, " day", " days") : "")));
      var dl = node("dl", "map-row-figures");
      var caps = r.caps;
      var tokens = r.output_tokens;
      var items = [
        ["sessions", fmt(r.sessions), ""],
        ["cap hits short / weekly / unknown", capsText(caps), ""],
        ["Claude output", providerValue(r, "claude", tokens.claude, compact), collected(r.sources, "claude") ? fmt(tokens.claude) + " output tokens" : ""],
        ["Codex output", providerValue(r, "codex", tokens.codex, compact), collected(r.sources, "codex") ? fmt(tokens.codex) + " output tokens" : ""],
        ["Opus share", providerValue(r, "claude", r.opus_share_pct, pct), ""],
        ["Codex weekly used", providerValue(r, "codex", r.codex_weekly_pct, pct), ""]
      ];
      for (var k = 0; k < items.length; k++) {
        var wrap = node("div", "map-fig");
        wrap.appendChild(node("dt", "", items[k][0]));
        var dd = node("dd", "", items[k][1]);
        if (items[k][2]) dd.title = items[k][2];
        wrap.appendChild(dd);
        dl.appendChild(wrap);
      }
      li.appendChild(dl);
      li.appendChild(node("p", "map-row-label", "self-reported by tokenmax-map " + String(r.skill) + ", not verified"));
      list.appendChild(li);
    }
    section.hidden = false;
    return true;
  }

  function loadBoard() {
    fetch("/api/maps", { credentials: "same-origin", cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
      .then(function (board) { renderBoard(board, null); })
      .catch(function () { warn("The board is not available right now."); });
  }

  /* ---------- Share ---------- */
  function showPreview(payload) {
    var body = el("mapFields");
    body.textContent = "";
    // One element per payload leaf: data-field names it, data-value holds exactly what is sent, the text is what a person reads.
    function leafNode(tag, field, value, shown) {
      var n = node(tag, "map-leaf", shown);
      n.setAttribute("data-field", field);
      n.setAttribute("data-value", value === null ? "null" : String(value));
      return n;
    }
    function leafFill(parts) {
      return function (fig) {
        for (var j = 0; j < parts.length; j++) fig.appendChild(typeof parts[j] === "string" ? document.createTextNode(parts[j]) : parts[j]);
      };
    }
    // The share card: one line per field, label left and exact value right, every payload leaf shown.
    var p = payload;
    var list = node("dl", "map-field-list");
    function line(label, parts) {
      list.appendChild(node("dt", "", label));
      var dd = node("dd");
      leafFill(parts)(dd);
      list.appendChild(dd);
    }
    line("Sessions", [leafNode("span", "sessions", p.sessions, fmt(p.sessions))]);
    line("Subagent sessions", [leafNode("span", "subagent_sessions", p.subagent_sessions, fmt(p.subagent_sessions))]);
    line("Cap hits, short / weekly / unknown", [
      leafNode("span", "caps.short", p.caps.short, fmt(p.caps.short)), " / ",
      leafNode("span", "caps.weekly", p.caps.weekly, fmt(p.caps.weekly)), " / ",
      leafNode("span", "caps.unknown", p.caps.unknown, fmt(p.caps.unknown))
    ]);
    line("Claude output tokens", [leafNode("span", "output_tokens.claude", p.output_tokens.claude, providerValue(p, "claude", p.output_tokens.claude, fmt))]);
    line("Codex output tokens", [leafNode("span", "output_tokens.codex", p.output_tokens.codex, providerValue(p, "codex", p.output_tokens.codex, fmt))]);
    line("Opus share", [leafNode("span", "opus_share_pct", p.opus_share_pct, providerValue(p, "claude", p.opus_share_pct, String)), collected(p.sources, "claude") ? "%" : ""]);
    line("Codex week used", !collected(p.sources, "codex")
      ? [leafNode("span", "codex_weekly_pct", p.codex_weekly_pct, "not collected")]
      : p.codex_weekly_pct === null
      ? [leafNode("span", "codex_weekly_pct", null, "none read")]
      : [leafNode("span", "codex_weekly_pct", p.codex_weekly_pct, String(p.codex_weekly_pct)), "%"]);
    line("Days", [leafNode("span", "days", p.days, String(p.days))]);
    line("Logs read", [leafNode("span", "sources", p.sources, p.sources)]);
    line("Mapper version", [leafNode("span", "skill", p.skill, p.skill)]);
    line("Format", [leafNode("span", "v", p.v, p.v)]);
    body.appendChild(list);
    var alias = el("mapAlias");
    alias.value = randomAlias();
    el("mapPreview").hidden = false;

    // One key per opened link: a retry after a network error sends the same key, so the server replays instead of adding a row.
    var requestKey = b64url(crypto.getRandomValues(new Uint8Array(32)));
    var button = el("mapShare");
    var busy = false;
    // After an answer that may mean the row was stored (no answer, or an unreadable one), the retry must repeat the
    // first request exactly, or the server sees the same key with other details (409) and the delete link is lost.
    var sentAlias = null;
    function retry(text, ambiguous, aliasValue) {
      busy = false;
      button.disabled = false;
      if (ambiguous) {
        sentAlias = aliasValue;
        alias.readOnly = true;
        text += " The alias stays as sent until this share goes through.";
      }
      warn(text);
      button.focus();
    }
    button.addEventListener("click", function () {
      if (busy) return;
      if (sentAlias === null && !alias.checkValidity()) { warn("Not shared: the alias must be 3 to 24 lowercase letters, digits or hyphens."); alias.focus(); return; }
      var aliasValue = sentAlias !== null ? sentAlias : alias.value;
      busy = true;
      button.disabled = true;
      clearMessages();
      // From here the request may reach the server, so the "nothing sent" line would no longer be true.
      el("mapNotSent").hidden = true;
      postJson("/api/maps", { payload: payload, alias: aliasValue, request_key: requestKey, nickname: el("mapTrap").value })
        .then(function (res) {
          if (res.ok && isObj(res.body) && typeof res.body.id === "string") {
            el("mapPreview").hidden = true;
            var a = el("mapDeleteLink").querySelector("a");
            var href = typeof res.body["delete"] === "string" ? new URL(res.body["delete"], location.origin).href : "";
            a.href = href;
            a.textContent = href;
            el("mapShared").hidden = false;
            var boardShown = renderBoard(res.body.board, res.body.id);
            history.replaceState(null, "", location.pathname + location.search);
            say(boardShown ? "Shared. Your row is on the board." : "Shared. The board could not be displayed right now. Keep your delete link.");
            a.focus();
            return;
          }
          // Only the server's honeypot answer is {"ok":true} with no id; any other success without an id is unreadable.
          if (res.ok && isObj(res.body) && res.body.ok === true && Object.keys(res.body).length === 1) {
            el("mapPreview").hidden = true;
            say("Received. Nothing was added to the board.");
            status.tabIndex = -1;
            status.focus();
            return;
          }
          if (res.ok) { retry("Not shared: the server's answer could not be read. Press Share to try again.", true, aliasValue); return; }
          retry("Not shared: " + reasonOf(res.body, res.status) + ".", false, aliasValue);
        }, function () {
          retry("Not shared: the request did not reach the server. Press Share to try again.", true, aliasValue);
        });
    });
  }

  /* ---------- Delete ---------- */
  function showDelete(id, key) {
    el("mapDelete").hidden = false;
    var button = el("mapDeleteRow");
    var busy = false;
    button.addEventListener("click", function () {
      if (busy) return;
      busy = true;
      button.disabled = true;
      clearMessages();
      postJson("/api/maps/delete", { id: id, key: key }).then(function (res) {
        if (res.ok && isObj(res.body) && res.body.deleted === true) {
          el("mapDelete").hidden = true;
          history.replaceState(null, "", location.pathname + location.search);
          say("Deleted. Your row is off the board.");
          return;
        }
        busy = false;
        button.disabled = false;
        if (res.status === 404) warn("No row matches this delete link. It may already be deleted.");
        else warn("Not deleted: " + reasonOf(res.body, res.status) + ".");
      }, function () {
        busy = false;
        button.disabled = false;
        warn("Not deleted: the request did not reach the server. Press Delete my row to try again.");
      });
    });
  }

  function start() {
    var hash = location.hash;
    if (hash.indexOf("#m=") === 0) {
      var payload = decode(hash.slice(3));
      if (payload) showPreview(payload);
      else el("mapInvalid").hidden = false;
      return;
    }
    if (hash.indexOf("#delete=") === 0) {
      var m = /^#delete=(TM-[0-9A-F]{12})\.([A-Za-z0-9_-]{22,64})$/.exec(hash);
      if (m) showDelete(m[1], m[2]);
      else warn("This delete link is not valid.");
      return;
    }
    loadBoard();
  }

  // A new fragment typed into the same tab starts the page again from that fragment.
  window.addEventListener("hashchange", function () { location.reload(); });
  start();
})();
