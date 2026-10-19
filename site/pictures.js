/* The picture story's behaviour on the landing page (moved from the retired /explainer, as is pictures.css).
 * - The four kinds of question: each picture can be tapped or keyed (Enter, Space). Under motion they play a short
 *   demonstration once they are in view with the opening curtain open: two steps 1.6 s apart, over by about 4 s.
 *   The motion ends by itself, so there is no Pause button; under reduced motion nothing moves by itself.
 * - Reduced motion turned on while the page is open stops the demonstration at once and lays the scenes out still.
 * - "One question...": under reduced motion (or without IntersectionObserver) all three scenes show,
 *   fully drawn; otherwise each scene draws as it arrives, at every width (nothing is pinned).
 * - One week, two ways (#payoff): the bars fill once it is a third in view; under reduced motion they start full.
 */
(function () {
  var root = document.documentElement;
  var reduce = false, query = null;
  try { query = window.matchMedia('(prefers-reduced-motion: reduce)'); reduce = query.matches; } catch (e) {}
  // Reduced motion turned on later: each part registers how to stop, and all of them run once.
  var calmers = [];
  var onCalm = function (fn) { calmers.push(fn); };
  if (query) {
    var calm = function () { if (!query.matches || reduce) return; reduce = true; calmers.forEach(function (fn) { fn(); }); };
    if (query.addEventListener) query.addEventListener('change', calm);
    else if (query.addListener) query.addListener(calm);
  }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function act(el, fn) {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } });
  }

  /* ---- four types ---- */
  var types = $('#types');
  if (types) {
    var nNeedle = $('#noul-needle'), nRead = $('#noul-read'), nVals = [78, 30], nI = 0;
    var setNoul = function (i) { nI = i; var p = nVals[i]; nNeedle.style.transform = 'rotate(' + ((p - 50) * 1.6) + 'deg)'; nRead.textContent = p + '% yes'; };
    setNoul(0);
    var tks = $$('#choice-tickets .tk'), beams = $$('#beams .beam'), cRead = $('#choice-read'), cNames = ['Small', 'Medium', 'Large'];
    var setChoice = function (i) {
      tks.forEach(function (t, k) {
        t.style.opacity = k === i ? '1' : '.72';
        t.style.transform = k === i ? 'translateY(-14px)' : 'translateY(0)';
        t.setAttribute('aria-pressed', k === i ? 'true' : 'false');
      });
      beams.forEach(function (b, k) { b.style.opacity = k === i ? '1' : '0'; });
      cRead.textContent = cNames[i] + ' is lit';
    };
    setChoice(1);
    var pin = $('#pin'), rungs = $$('#rungs [data-i]');
    var setScore = function (i) {
      pin.style.transform = 'translateY(' + ((i - 1) * -52) + 'px)';
      rungs.forEach(function (r) { r.setAttribute('aria-pressed', String(+r.getAttribute('data-i') === i)); });
    };
    setScore(1);
    var frame4 = $('#box-frame');
    var drawFrame = function () { if (reduce) return; frame4.classList.remove('draw'); void frame4.getBoundingClientRect(); frame4.classList.add('draw'); };
    // A picture the visitor has just used is left alone by the demonstration.
    var touched = {};
    var bind = function (name, el, fn) { act(el, function (e) { touched[name] = true; fn(e); }); };
    bind('n', $('#noul-hit'), function () { setNoul(1 - nI); });
    tks.forEach(function (t) { bind('c', t, function () { setChoice(+t.getAttribute('data-i')); }); });
    rungs.forEach(function (r) { bind('s', r, function () { setScore(+r.getAttribute('data-i')); }); });
    bind('b', $('#box-hit'), drawFrame);

    /* ---- the tiles as controls and the follow-spot (ux-swarm c02) ----
       Lighting a tile (data-lit) gives it the gold ring and moves the spot onto it. Hover and focus light it; the title
       button, or a tap on a touch screen, also opens its one-line example (one at a time). The light stays on the last
       tile touched. Under motion the spot comes on over the marquee once the curtain is at 0.6 and travels to Yes or no
       (900 ms) once it is open; under reduced motion there is no spot and Yes or no is lit from the start. */
    var stage = $('.stage4', types), tiles = $$('article.poster', types), marquee = $('main .marquee');
    var aimed = null, settle = 0, tapped = false;
    var aim = function (el, ms) {
      if (!el) return;
      aimed = el;
      var r = el.getBoundingClientRect();
      types.style.setProperty('--spot-dur', ms + 'ms');
      types.style.setProperty('--spot-x', Math.round(r.left + r.width / 2) + 'px');
      types.style.setProperty('--spot-y', Math.round(r.top + r.height / 2) + 'px');
    };
    // The spot is fixed, so a scroll re-aims it at once (once per frame) to stay on its tile.
    var follow = false;
    window.addEventListener('scroll', function () {
      if (!aimed || follow) return;
      follow = true;
      requestAnimationFrame(function () { follow = false; aim(aimed, 0); });
    }, { passive: true });
    var example = function (tile, show) {
      var ex = $('.p-ex', tile), name = $('.p-name', tile);
      if (ex) ex.hidden = !show;
      if (name) name.setAttribute('aria-expanded', show ? 'true' : 'false');
    };
    var light = function (tile, ms) {
      clearTimeout(settle);
      tiles.forEach(function (t) {
        if (t === tile) t.setAttribute('data-lit', '');
        else { t.removeAttribute('data-lit'); example(t, false); }
      });
      stage.setAttribute('data-has-lit', '');
      aim(tile, ms);
    };
    tiles.forEach(function (tile) {
      tile.addEventListener('pointerenter', function () { if (!tile.hasAttribute('data-lit')) light(tile, 350); });
      tile.addEventListener('focusin', function () { if (!tile.hasAttribute('data-lit')) light(tile, 350); });
      tile.addEventListener('pointerdown', function (e) { tapped = e.pointerType === 'touch'; });
      tile.addEventListener('click', function (e) {
        var name = $('.p-name', tile), ex = $('.p-ex', tile);
        var onName = !!name && e.target instanceof Node && name.contains(e.target);
        if (!onName && !tapped) return;
        if (!tile.hasAttribute('data-lit')) light(tile, 350);
        example(tile, onName ? !!ex && ex.hidden : true);
      });
    });
    if (window.ResizeObserver) new ResizeObserver(function () { if (aimed) aim(aimed, 0); }).observe(stage);
    if (reduce) light(tiles[0], 0);
    else {
      var spotOn = false, spotWatch = null;
      var curtainOpen = function () {
        var c = root.dataset.curtain;
        return c === 'open' || (c === undefined && !root.classList.contains('overture-play'));
      };
      var spotStep = function () {
        if (!spotOn && (curtainOpen() || parseFloat(root.style.getPropertyValue('--reveal')) >= 0.6)) {
          spotOn = true;
          aim(marquee || tiles[0], 0);
          types.setAttribute('data-spot', '');
        }
        if (!spotOn || !curtainOpen()) return;
        if (spotWatch) spotWatch.disconnect();
        // Two frames, so the spot is drawn on the marquee before it travels.
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            if (stage.hasAttribute('data-has-lit')) return;
            aim(tiles[0], 900);
            settle = setTimeout(function () { if (!stage.hasAttribute('data-has-lit')) light(tiles[0], 900); }, 900);
          });
        });
      };
      if (window.MutationObserver) {
        spotWatch = new MutationObserver(spotStep);
        spotWatch.observe(root, { attributes: true, attributeFilter: ['data-curtain', 'style'] });
      }
      spotStep();
      onCalm(function () {
        if (spotWatch) spotWatch.disconnect();
        clearTimeout(settle);
        types.removeAttribute('data-spot');
        if (!stage.hasAttribute('data-has-lit')) light(tiles[0], 0);
      });
    }
    if (!reduce) {
      var STEP = 1600, STEPS = 2, started = false, timer = 0, seen = null;
      onCalm(function () { started = true; clearInterval(timer); if (seen) seen.disconnect(); frame4.classList.remove('draw'); });
      var demo = function () {
        if (started) return;
        started = true;
        drawFrame();
        var step = 0;
        timer = setInterval(function () {
          step++;
          if (!touched.n) setNoul(step % 2);
          if (!touched.c) setChoice((step + 1) % 3);
          if (!touched.s) setScore((step + 1) % 3);
          if (step >= STEPS) clearInterval(timer);
        }, STEP);
      };
      // It plays only once the pictures are in view and the opening curtain (theatre.js, html[data-curtain]) is open or
      // absent, so it never runs out behind a closed curtain.
      var inView = false, curtainWatch = null;
      var tryStart = function () {
        var curtain = root.dataset.curtain;
        if (started || !inView || (curtain !== undefined && curtain !== 'open')) return;
        if (seen) seen.disconnect();
        if (curtainWatch) curtainWatch.disconnect();
        demo();
      };
      if (window.MutationObserver) {
        curtainWatch = new MutationObserver(tryStart);
        curtainWatch.observe(root, { attributes: true, attributeFilter: ['data-curtain'] });
        onCalm(function () { curtainWatch.disconnect(); });
      }
      if ('IntersectionObserver' in window) {
        seen = new IntersectionObserver(function (es) {
          es.forEach(function (e) { inView = e.isIntersecting; });
          tryStart();
        }, { rootMargin: '0px 0px -25% 0px' });
        seen.observe(types);
      } else { inView = true; tryStart(); }
    }
  }

  /* ---- payoff: the bars fill once a third of it is in view; under reduced motion they are full from the start ---- */
  var payoff = $('#payoff');
  if (payoff) {
    if (reduce || !('IntersectionObserver' in window)) payoff.classList.add('seen');
    else {
      var filled = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { payoff.classList.add('seen'); filled.disconnect(); } }); }, { threshold: 0.35 });
      filled.observe(payoff);
      onCalm(function () { filled.disconnect(); payoff.classList.add('seen'); });
    }
  }

  /* ---- story: reduced motion = static layout, final state ---- */
  var frames = $$('#story .frame');
  if (!frames.length) return;
  // Each scene draws one of two pictures (svg.narrow under 900 px, svg.wide from 900 px; the other is display:none).
  // Only the drawn picture's parts carry .lit, so the lit floor and its timing apply to what is on screen (c04).
  var parts = $$('#story .lit'), wideQ = window.matchMedia ? window.matchMedia('(min-width:900px)') : null;
  var syncParts = function () {
    var wide = wideQ ? wideQ.matches : true;
    parts.forEach(function (p) { p.classList.toggle('lit', !!p.closest('svg.wide') === wide); });
  };
  syncParts();
  if (wideQ) {
    if (wideQ.addEventListener) wideQ.addEventListener('change', syncParts);
    else if (wideQ.addListener) wideQ.addListener(syncParts);
  }
  // The scroll lamps (c04): the scene nearest the middle of the screen (inside its middle 30%) is data-lit. Under reduced
  // motion this is a class toggle only.
  if ('IntersectionObserver' in window) {
    var inBand = frames.map(function () { return false; });
    var lamp = function () {
      var mid = window.innerHeight / 2, best = -1, gap = Infinity;
      frames.forEach(function (f, i) {
        if (!inBand[i]) return;
        var r = f.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - mid);
        if (d < gap) { gap = d; best = i; }
      });
      frames.forEach(function (f, i) { if (i === best) f.setAttribute('data-lit', ''); else f.removeAttribute('data-lit'); });
    };
    var lamps = new IntersectionObserver(function (es) {
      es.forEach(function (e) { inBand[frames.indexOf(e.target)] = e.isIntersecting; });
      lamp();
    }, { rootMargin: '-35% 0px -35% 0px' });
    frames.forEach(function (f) { lamps.observe(f); });
  }
  if (reduce || !('IntersectionObserver' in window)) {
    frames.forEach(function (f) { f.classList.add('on'); });
    return;
  }
  root.classList.add('motion');
  // Every width reveals the scenes in flow, each as it arrives (no pinned stage: it added about 2700 px at 1440, #273).
  var watchers = [];
  onCalm(function () {
    watchers.forEach(function (o) { o.disconnect(); });
    frames.forEach(function (f) { f.classList.add('on'); });
  });
  frames.forEach(function (f) {
    var o = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('on'); o.disconnect(); } }); }, { threshold: 0.4 });
    o.observe(f);
    watchers.push(o);
  });
})();
