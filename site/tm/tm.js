/* /tm/ scroll story (#238). Ported from the approved v3 prototype: the same timeline (T, shares of the scroll) and
   surtitles (SUR), less the sample board scene, which carried figures that were not real. With reduced motion the
   page never animates: every scene is drawn once in its end state. */
(function () {
  'use strict';
  var motion = document.documentElement.classList.contains('motion');
  var NS = 'http://www.w3.org/2000/svg';
  var $ = function (id) { return document.getElementById(id); };
  var CMD = $('cmd').textContent;

  /* Timeline: every number is a share of the scroll (v3 values; scene D now enters where the board scene did). */
  var T = {
    curtain: [0, .08],
    type: [.085, .175],
    enter: [.178, .2],
    wireLen: .035,
    linkOpen: [.53, .6],
    aOut: [.53, .58],
    bIn: [.53, .6],
    bOut: [.69, .715],
    dIn: [.7, .74],
    jobs: [.74, .9]
  };
  var SUR = [
    [0, 'Scroll to open the show'],
    [.085, 'Paste one line, press Enter'],
    [.2, 'Runs on your machine'],
    [.248, 'Your last 7 days'],
    [.29, 'Nothing sent yet'],
    [.47, 'A link, only if you want'],
    [.53, 'You choose to share'],
    [.7, 'Rules first, Jev for the rest']
  ];

  var clamp = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var span = function (p, r) { return clamp((p - r[0]) / (r[1] - r[0])); };
  var ease = function (t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };

  /* -------- Copy: clipboard, then execCommand, then select the text with a keyboard hint -------- */
  var copyMsg = $('copyMsg'), copyTimer;
  function say(text) {
    copyMsg.textContent = text;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(function () { copyMsg.textContent = ''; }, 4000);
  }
  function legacyCopy() {
    var t = document.createElement('textarea');
    t.value = CMD; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    t.remove();
    return ok;
  }
  function selectCommand() {
    var range = document.createRange();
    range.selectNodeContents($('cmd'));
    var sel = getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    say('The command is selected. Press ' + (mac ? 'Cmd+C' : 'Ctrl+C') + ' to copy it.');
  }
  function fallback() { if (legacyCopy()) say('Copied. Paste it in your terminal.'); else selectCommand(); }
  $('copy').addEventListener('click', function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(CMD).then(function () { say('Copied. Paste it in your terminal.'); }, fallback);
    } else fallback();
  });

  /* -------- Scene A: terminal lines, wires, figures -------- */
  var typed = $('typed'), rest = $('rest'), caret = $('caret'), key = $('key');
  var lines = Array.prototype.slice.call(document.querySelectorAll('#out .ln'));
  var pics = [1, 2, 3].map(function (i) { return { num: $('num' + i), pic: $('pic' + i), at: parseFloat($('pic' + i).dataset.at) }; });
  var COLORS = ['#ff6a58', '#ffeec8', '#e0b04e'];
  var wires = $('wires'), wireEls = [];

  /* Wide: one curve per number, top number to top figure. Narrow: each wire runs right to its own lane, down past
     the terminal, then left to its figure. The top number takes the outer lane, turns lowest and lands on the
     rightmost figure (tm.css orders the figures right to left), so the wires nest and never cross. */
  function buildWires() {
    wires.textContent = ''; wireEls = [];
    var box = wires.getBoundingClientRect();
    var narrow = innerWidth < 760;
    var term = $('term').getBoundingClientRect();
    pics.forEach(function (o, i) {
      var a = o.num.getBoundingClientRect(), b = o.pic.querySelector('svg').getBoundingClientRect();
      var x1 = a.right - box.left + 3, y1 = a.top + a.height / 2 - box.top, d, x2, y2;
      if (narrow) {
        var lane = term.right - box.left - 8 - i * 7;
        var bottom = term.bottom - box.top;
        x2 = b.left + b.width / 2 - box.left; y2 = b.top - box.top - 2;
        var turn = bottom + 6 + (2 - i) * 6;
        var r = 4;
        var dir = x2 < lane ? -1 : 1;
        d = 'M' + x1 + ' ' + y1 + ' H' + (lane - r) + ' Q' + lane + ' ' + y1 + ' ' + lane + ' ' + (y1 + r) +
            ' V' + (turn - r) + ' Q' + lane + ' ' + turn + ' ' + (lane + dir * r) + ' ' + turn +
            ' H' + (x2 - dir * r) + ' Q' + x2 + ' ' + turn + ' ' + x2 + ' ' + (turn + r) + ' V' + y2;
      } else {
        /* straight along the number's own line to the terminal's edge, then one curve across the gap, so a wire
           never lies over a later line of output (the long link prints under these numbers) */
        x2 = b.left - box.left - 8; y2 = b.top + b.height / 2 - box.top;
        var edge = term.right - box.left + 6;
        var dx = (x2 - edge) * .5;
        d = 'M' + x1 + ' ' + y1 + ' H' + edge + ' C' + (edge + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 + ' ' + x2 + ' ' + y2;
      }
      var halo = document.createElementNS(NS, 'path');
      halo.setAttribute('d', d); halo.setAttribute('class', 'halo'); halo.setAttribute('pathLength', '1');
      var line = document.createElementNS(NS, 'path');
      line.setAttribute('d', d); line.setAttribute('class', 'wire'); line.setAttribute('stroke', COLORS[i]); line.setAttribute('pathLength', '1');
      var dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', x2); dot.setAttribute('cy', y2); dot.setAttribute('r', 3.5); dot.setAttribute('fill', COLORS[i]);
      if (motion) [halo, line].forEach(function (p) { p.style.strokeDasharray = '1 1'; });
      wires.appendChild(halo); wires.appendChild(line); wires.appendChild(dot);
      wireEls.push({ halo: halo, line: line, dot: dot });
    });
  }

  /* -------- Scene D: two real jobs walk to their doors (the ruled one first, then the one no rule matches). The walk
     shows the route a rule or Jev would take; #236 has not run, so nothing here is a result. -------- */
  var walks = [$('walk1'), $('walk2')];
  function placeJobs(t) {
    walks.forEach(function (w, i) { w.style.setProperty('--t', ease(clamp((t - i * .35) / .65)).toFixed(3)); });
  }

  /* -------- One frame -------- */
  var sceneA = $('sceneA'), sceneB = $('sceneB'), sceneD = $('sceneD');
  var sur = $('sur'), lastSur = '';
  function show(el, o, dy) {
    el.style.opacity = o;
    el.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
    el.style.visibility = o > .01 ? 'visible' : 'hidden';
  }
  function render(p) {
    /* The curtain only parts sideways, at the start. On a phone it leaves the stage entirely, so no drape edge ever
       sits over a figure; on wide screens a 4% drape frames the stage, well clear of the content column. */
    var c = ease(span(p, T.curtain));
    var drape = innerWidth < 760 ? 101 : 96;
    $('halfL').style.transform = 'translateX(' + (-drape * c) + '%)';
    $('halfR').style.transform = 'translateX(' + (drape * c) + '%)';
    $('marquee').style.opacity = 1 - clamp(c * 1.6);

    var n = Math.round(CMD.length * span(p, T.type));
    typed.textContent = CMD.slice(0, n);
    rest.textContent = CMD.slice(n);
    var e = span(p, T.enter);
    key.classList.toggle('show', p >= T.type[1] - .01 && e < 1);
    key.classList.toggle('down', e > .35 && e < 1);
    caret.classList.toggle('gone', e > .5);
    caret.classList.toggle('blink', n === 0);

    lines.forEach(function (ln) { ln.style.opacity = p >= parseFloat(ln.dataset.at) ? 1 : 0; });
    pics.forEach(function (o, i) {
      var t = clamp((p - o.at) / T.wireLen);
      var w = wireEls[i];
      if (w) {
        w.halo.style.strokeDashoffset = 1 - t;
        w.line.style.strokeDashoffset = 1 - t;
        w.dot.style.opacity = t >= 1 ? 1 : 0;
      }
      /* no figure, not even dimmed, behind the closed curtain */
      o.pic.style.opacity = p < T.curtain[1] ? 0 : .12 + .88 * clamp((p - o.at - T.wireLen * .6) / (T.wireLen * .5));
    });
    $('exitA').style.opacity = p >= pics[0].at + T.wireLen ? 1 : .15;
    $('exitB').style.opacity = p >= pics[0].at + T.wireLen * 1.6 ? 1 : .15;
    $('lnk').classList.toggle('lit', p >= .49 && p < T.linkOpen[1]);

    var aO = 1 - span(p, T.aOut);
    show(sceneA, aO, -24 * (1 - aO));
    var bInP = ease(span(p, T.bIn)), bOutP = span(p, T.bOut);
    show(sceneB, Math.min(bInP > 0 ? 1 : 0, 1 - bOutP), -20 * bOutP);
    var ink = 50 * (1 - bInP);
    $('browser').style.clipPath = 'inset(' + ink + '% 0 ' + ink + '% 0)';
    var dI = ease(span(p, T.dIn));
    show(sceneD, dI, 24 * (1 - dI));

    placeJobs(span(p, T.jobs));

    var label = SUR[0][1];
    SUR.forEach(function (s) { if (p >= s[0]) label = s[1]; });
    if (label !== lastSur) {
      lastSur = label;
      sur.classList.add('swap');
      setTimeout(function () { sur.textContent = label; sur.classList.remove('swap'); }, 120);
    }
  }

  var track = $('track'), ticking = false;
  function progress() {
    var r = track.getBoundingClientRect();
    var max = track.offsetHeight - innerHeight;
    return max > 0 ? clamp(-r.top / max) : 1;
  }
  function frame() { ticking = false; render(progress()); }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }

  function layout() {
    /* the ticket wraps the full command, so its height varies with the width: the stage ends above it */
    document.documentElement.style.setProperty('--ticket-h', ($('ticket').offsetHeight + 10) + 'px');
    if (motion) {
      /* measure scene A at rest so the wires land on the real boxes */
      var keep = [sceneA.style.transform, sceneA.style.visibility];
      sceneA.style.transform = ''; sceneA.style.visibility = 'visible';
      buildWires();
      sceneA.style.transform = keep[0]; sceneA.style.visibility = keep[1];
      render(progress());
    } else {
      typed.textContent = CMD; rest.textContent = ''; caret.classList.add('gone');
      buildWires();
      /* the walks keep their CSS end state (--t: 1): both jobs stand at their doors */
    }
  }

  (document.fonts ? document.fonts.ready : Promise.resolve()).then(layout);
  layout();
  addEventListener('resize', layout);
  if (motion) addEventListener('scroll', onScroll, { passive: true });
})();
