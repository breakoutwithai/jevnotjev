/* The picture story's behaviour on the landing page (moved from the retired /explainer, as is pictures.css).
 * - The four kinds of question: each picture can be tapped or keyed (Enter, Space). Under motion they play a short
 *   demonstration once they first come into view: two steps 1.6 s apart, all movement over by about 4 s, then still.
 *   The motion ends by itself, so there is no Pause button; under reduced motion nothing moves by itself.
 * - Reduced motion turned on while the page is open stops the demonstration at once and lays the scenes out still.
 * - "One question, start to finish": under reduced motion (or without IntersectionObserver) all three scenes show,
 *   fully drawn; otherwise each scene draws as it arrives on a phone, and from 900 px one stage is pinned and the
 *   scenes change with the scroll.
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
      if ('IntersectionObserver' in window) {
        seen = new IntersectionObserver(function (es) {
          es.forEach(function (e) { if (e.isIntersecting) { seen.disconnect(); demo(); } });
        }, { rootMargin: '0px 0px -25% 0px' });
        seen.observe(types);
      } else demo();
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
  if (reduce || !('IntersectionObserver' in window)) {
    frames.forEach(function (f) { f.classList.add('on'); });
    return;
  }
  root.classList.add('motion');
  var watchers = [];
  onCalm(function () {
    watchers.forEach(function (o) { o.disconnect(); });
    root.classList.remove('pinned');
    var marks = $('#sents');
    if (marks) { marks.textContent = ''; marks.removeAttribute('style'); }
    frames.forEach(function (f) { f.classList.add('on'); });
  });
  var obs = function (el, cb, opts) { var o = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) cb(e.target, o); }); }, opts); o.observe(el); watchers.push(o); return o; };
  if (window.matchMedia('(min-width: 900px)').matches) {
    root.classList.add('pinned');
    var j = $('#journey'), sents = $('#sents');
    j.style.setProperty('--n', frames.length);
    sents.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    var show = function (i) { frames.forEach(function (f, k) { f.classList.toggle('on', k === i); }); };
    frames.forEach(function (_, k) {
      var s = document.createElement('div'); s.dataset.i = k;
      s.style.cssText = 'position:absolute;left:0;right:0;height:100svh;top:' + (k * 100) + 'svh';
      sents.appendChild(s);
    });
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) show(+e.target.dataset.i); }); }, { rootMargin: '-50% 0px -50% 0px' });
    watchers.push(io);
    $$('#sents > div').forEach(function (s) { io.observe(s); });
    show(0);
  } else {
    frames.forEach(function (f) { obs(f, function (t, o) { t.classList.add('on'); o.disconnect(); }, { threshold: 0.4 }); });
  }
})();
