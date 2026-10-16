/* A link to an existing reference anchor opens its native disclosure, including history navigation. */
(function () {
  function revealReference() {
    var id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (_) { return; }
    if (!id) return;
    var target = document.getElementById(id);
    if (!target) return;
    var details = target.closest('details');
    if (!details) return;
    details.open = true;
    target.scrollIntoView({ block: 'start' });
  }
  window.addEventListener('hashchange', revealReference);
  document.addEventListener('click', function (event) {
    var link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (link && link.getAttribute('href') === window.location.hash) revealReference();
  });
  revealReference();
}());
