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

/* "Ask for a model or provider": a modal dialog that posts to the existing guest-question route, POST /api/questions,
   with topic "provider-request" (email optional for this topic). Server values are written with textContent only. The
   status code stays in this page's memory and on screen: no storage, no URL. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var dialog = $("providerDialog");
  var cta = $("providerAsk");
  if (!dialog || !cta || typeof dialog.showModal !== "function") return;
  var EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,63}$/;
  // The server's question rules (src/guest-intake/contract.ts: QUESTION_LIMITS.maxQuestionChars, normalizeQuestion and
  // CONTROL), applied to the assembled text the same way, so each refusal gets an accurate message.
  var MAX_REQUEST = 4096;
  var CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  var TOO_LONG = "Your request is too long to send. Shorten what you use it for, or the name under Other.";
  var BAD_CHARS = "Your request contains characters we cannot store. Retype it rather than pasting, then send again.";
  var REJECTED = "Your request could not be accepted as written. Shorten it or retype it, then send again.";
  var QUESTION_ID = /^Q-[0-9A-F]{12}$/;
  function normalized(text) { return text.replace(/\r\n?/g, "\n").normalize("NFC").trim(); }
  var UNCONFIRMED = "We could not confirm your request was saved. Press send again: the same request is recognised and not added twice.";
  var ERRORS = {
    "rate-limited": "Too many tries from your network. Wait ten minutes and send again; your draft is kept.",
    "request-key-reused": "That attempt was already used for a different draft. Press send again to send it as a new request.",
    "capacity": "We cannot take new requests right now. Your draft is kept; try again later.",
    "unknown-field": "The page and server disagree. Reload the page and try again."
  };
  var attempt = { draft: "", key: "" };

  function newKey() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var text = "";
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function show(el, on) { el.hidden = !on; }
  function formError(text) { $("providerErr").textContent = text; show($("providerErr"), text !== ""); }

  function focusables() {
    var all = dialog.querySelectorAll("button, select, input, textarea, a[href], [tabindex]");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.disabled || el.tabIndex < 0 || el.getClientRects().length === 0) continue;
      out.push(el);
    }
    return out;
  }

  function open() {
    if (dialog.open) return;
    dialog.showModal();
    var receipt = !$("providerReceipt").hidden;
    (receipt ? $("providerReceipt") : $("providerWant")).focus();
  }

  function toggleOther() {
    var other = $("providerWant").value === "Other";
    show($("providerOtherRow"), other);
    if (!other) show($("providerOtherErr"), false);
  }

  function check() {
    var bad = [];
    var want = $("providerWant").value;
    var other = $("providerOther").value.trim();
    var use = $("providerUse").value.trim();
    var email = $("providerEmail").value.trim();
    var flags = [
      ["providerWant", want === ""],
      ["providerOther", want === "Other" && other === ""],
      ["providerUse", use === ""],
      ["providerEmail", email !== "" && !EMAIL.test(email)],
      ["providerConsent", !$("providerConsent").checked]
    ];
    for (var i = 0; i < flags.length; i++) {
      var id = flags[i][0];
      var isBad = flags[i][1];
      show($(id + "Err"), isBad);
      $(id).setAttribute("aria-invalid", String(isBad));
      if (isBad) bad.push(id);
    }
    return bad;
  }

  async function submit(event) {
    event.preventDefault();
    formError("");
    var bad = check();
    if (bad.length) { $(bad[0]).focus(); return; }
    var want = $("providerWant").value;
    var named = want === "Other" ? "Other: " + $("providerOther").value.trim() : want;
    var body = {
      topic: "provider-request",
      question: "Wanted: " + named + "\nUse: " + $("providerUse").value.trim(),
      reply_consent: true,
      nickname: $("providerNickname").value
    };
    var assembled = normalized(body.question);
    if (CONTROL.test(assembled)) { formError(BAD_CHARS); $("providerUse").focus(); return; }
    if (Array.from(assembled).length > MAX_REQUEST) { formError(TOO_LONG); $("providerUse").focus(); return; }
    var email = $("providerEmail").value.trim();
    if (email !== "") body.email = email;
    var draft = JSON.stringify(body);
    if (draft !== attempt.draft) attempt = { draft: draft, key: newKey() };
    body.request_key = attempt.key;
    $("providerSend").disabled = true;
    try {
      var res = await fetch("/api/questions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && typeof data.id === "string" && QUESTION_ID.test(data.id) && data.status_code === data.id + "." + body.request_key) {
        $("providerRef").textContent = data.id;
        $("providerCode").textContent = data.status_code;
        show($("providerForm"), false);
        show($("providerReceipt"), true);
        $("providerReceipt").focus();
        return;
      }
      // A success with an unreadable body may still have been stored: keep the draft and its key, so sending again
      // replays the same request instead of adding a second one.
      if (res.ok) { formError(UNCONFIRMED); return; }
      var code = typeof data.code === "string" ? data.code : "";
      if (code === "request-key-reused") attempt = { draft: "", key: "" };
      if (code === "bad-email") { show($("providerEmailErr"), true); $("providerEmail").focus(); return; }
      if (code === "bad-question") { formError(REJECTED); $("providerUse").focus(); return; }
      formError(ERRORS[code] || "Could not save your request. Your draft is still here; try again.");
    } catch (error) {
      formError("Could not reach the server. Your draft is still here; try again.");
    } finally {
      $("providerSend").disabled = false;
    }
  }

  // Keep Tab inside the open dialog: past the last control back to the first, and the reverse with Shift.
  dialog.addEventListener("keydown", function (event) {
    if (event.key !== "Tab") return;
    var items = focusables();
    if (items.length === 0) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  // Escape fires "cancel" and the browser closes the modal; every close returns focus to the button that opened it.
  dialog.addEventListener("close", function () { cta.focus(); });
  $("providerClose").addEventListener("click", function () { dialog.close(); });
  cta.addEventListener("click", open);
  $("providerWant").addEventListener("change", toggleOther);
  $("providerForm").addEventListener("submit", submit);
  if (window.location.hash === "#ask-provider") open();
}());
