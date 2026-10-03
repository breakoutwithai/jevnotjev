/* Little Shop of Horrors: the seating logic. Pure functions on window.JNJSeating; house.js draws the page.
 * A call is the visitor's own judgement on one message: "answer" (the bot answers) or "hand_off" (hand to a person).
 * Calls live only in this browser's localStorage under KEY; every storage read and write is guarded, so the page
 * works with storage blocked. Nothing here makes a network request. */
(function () {
  "use strict";
  var ROWS = "ABCDE", PER_ROW = 8, KEY = "jnj.little-shop.calls.v1";

  function isCall(v) { return v === "answer" || v === "hand_off"; }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function copy(o) { var c = {}; Object.keys(o).forEach(function (k) { c[k] = o[k]; }); return c; }

  function seatCode(i) { return ROWS.charAt(Math.floor(i / PER_ROW)) + String((i % PER_ROW) + 1); }
  function blank() { return { calls: {}, cur: null, queue: [] }; }
  function withCalls(calls) { return { calls: calls, cur: null, queue: [] }; }

  /* Clicking a seat puts its message on stage and drops any queue. */
  function pick(s, id) { return { calls: s.calls, cur: id, queue: [] }; }

  /* The visitor's call on the message on stage; the next queued empty seat takes the stage. With the queue empty
     the message stays on stage so the call and each clerk's result are shown. */
  function decide(s, call) {
    if (!s.cur || !isCall(call)) return s;
    var calls = copy(s.calls);
    calls[s.cur] = call;
    var q = s.queue.filter(function (id) { return !own(calls, id); });
    return { calls: calls, cur: q.length ? q[0] : s.cur, queue: q.slice(1) };
  }

  /* Queue the empty seats among ids, in order. Never makes a call: each queued message waits for the visitor. */
  function queueUp(s, ids) {
    var q = ids.filter(function (id) { return !own(s.calls, id); });
    if (!q.length) return s;
    return { calls: s.calls, cur: q[0], queue: q.slice(1) };
  }

  function count(calls) { return Object.keys(calls).length; }
  function taken(calls, arms) { return count(calls) * arms; }

  function spendOk(v) { return typeof v === "number" && isFinite(v) && v >= 0; }
  /* About what one accepted answer costs on the calls made: the arm's spend over all messages, scaled to the
     number of calls, divided by accepted. Null when nothing is accepted or the spend was not measured. */
  function perAccepted(spend, total, n, accepted) {
    if (!spendOk(spend) || !(total > 0) || !(accepted > 0)) return null;
    return spend / total * n / accepted;
  }
  function usd(v) {
    if (!spendOk(v)) return "n/a";
    if (v === 0) return "$0";
    return "$" + v.toFixed(v < 1 ? 6 : 4);
  }

  function tally(data, calls) {
    var ids = Object.keys(calls);
    var byId = {};
    data.messages.forEach(function (m) { byId[m.id] = m; });
    return data.arms.map(function (a) {
      var accepted = 0;
      ids.forEach(function (id) { if (byId[id] && byId[id].outputs[a.key] === calls[id]) accepted++; });
      return {
        key: a.key, name: a.name, model: a.model, spend_usd: a.spend_usd,
        accepted: accepted, calls: ids.length, perAccepted: perAccepted(a.spend_usd, data.messages.length, ids.length, accepted)
      };
    });
  }

  /* Calls read back from storage: only known ids with a valid call. Anything unreadable reads as no calls. */
  function load(storage, ids) {
    var out = {};
    try {
      if (!storage) return out;
      var raw = JSON.parse(storage.getItem(KEY) || "null");
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
      ids.forEach(function (id) { if (own(raw, id) && isCall(raw[id])) out[id] = raw[id]; });
    } catch (e) { return {}; }
    return out;
  }
  function save(storage, calls) {
    try { if (!storage) return false; storage.setItem(KEY, JSON.stringify(calls)); return true; } catch (e) { return false; }
  }
  function clear(storage) {
    try { if (!storage) return false; storage.removeItem(KEY); return true; } catch (e) { return false; }
  }

  /* Calls changed in another tab: take them, drop queued seats that are now called, and if the seat on stage was
     called there while a queue was running, move on to the next queued seat. */
  function resync(s, calls) {
    var q = s.queue.filter(function (id) { return !own(calls, id); });
    if (s.cur && own(calls, s.cur) && !own(s.calls, s.cur) && q.length) return { calls: calls, cur: q[0], queue: q.slice(1) };
    return { calls: calls, cur: s.cur, queue: q };
  }

  /* Empty the house: the calls are cleared on screen; cleared says whether storage dropped them too. */
  function emptyHouse(storage) { return { state: blank(), cleared: clear(storage) }; }

  window.JNJSeating = {
    ROWS: ROWS, PER_ROW: PER_ROW, KEY: KEY, VERDICT_AT: 30,
    isCall: isCall, seatCode: seatCode, blank: blank, withCalls: withCalls, pick: pick, decide: decide, queueUp: queueUp,
    count: count, taken: taken, perAccepted: perAccepted, usd: usd, tally: tally, load: load, save: save, clear: clear, emptyHouse: emptyHouse, resync: resync
  };
})();
