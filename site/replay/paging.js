/* Replay paging: a long run plays its first `by` cases one at a time, then `by` cases per step (1 to 10, then 11-20,
 * 21-30, ... up to the last case). Positions are 0-based indexes of the LAST case revealed by a step. A run with no
 * `by` plays one case per step, as before. Pure functions; nothing here touches the page. */
(function (root) {
  "use strict";
  function last(total) { return Math.max(0, total - 1); }
  function head(by, total) { return by ? by : total; }

  /** The position a step ends on when it covers `pos`: the case itself in the head, else the end of its page. */
  function blockEnd(pos, by, total) {
    var h = head(by, total);
    var p = Math.max(0, Math.min(last(total), pos));
    if (p < h) return p;
    return Math.min(last(total), h - 1 + Math.ceil((p - h + 1) / by) * by);
  }
  /** First position of the step that ends at `pos`. */
  function blockStart(pos, by, total) {
    var h = head(by, total);
    var p = Math.max(0, Math.min(last(total), pos));
    if (p < h) return p;
    return h + (Math.ceil((p - h + 1) / by) - 1) * by;
  }
  function next(pos, by, total) {
    var h = head(by, total);
    if (pos < h - 1) return Math.min(last(total), pos + 1);
    return blockEnd(pos + 1, by, total);
  }
  function prev(pos, by, total) {
    var h = head(by, total);
    if (pos <= h - 1) return Math.max(0, pos - 1);
    return blockStart(pos, by, total) - 1;
  }
  /** The cases a step shows: a head step is one case, a page step is `by` cases (fewer on the last page). */
  function range(pos, by, total) {
    var end = blockEnd(pos, by, total);
    return { from: blockStart(end, by, total), to: end };
  }
  /** Every step in order, as the position it ends on. */
  function steps(by, total) {
    var out = [], p = 0;
    if (total <= 0) return out;
    out.push(p);
    while (p < last(total)) { p = next(p, by, total); out.push(p); }
    return out;
  }
  /** The strip: one square per head case, then one chip per page. `end` is the position a click jumps to. */
  function groups(by, total) {
    return steps(by, total).map(function (end) { var r = range(end, by, total); return { from: r.from, to: r.to, end: end, single: r.from === r.to && end < head(by, total) }; });
  }

  var api = { blockEnd: blockEnd, blockStart: blockStart, next: next, prev: prev, range: range, steps: steps, groups: groups };
  root.JNJ_PAGING = api;
}(typeof window !== "undefined" ? window : this));
