// Send Jev!Jev feedback: POST /api/questions with kind "feedback". Stored in the same reviewed store as /ask/
// questions, so it reaches the operator's admin view. Server values are written with textContent, never as HTML.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var MAX_MESSAGE = 4096;
  var EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,63}$/;
  var PAGE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  var BACK = { home: "/", guide: "/guide/", tm: "/tm/" };
  var FORM_ERRORS = {
    "rate-limited": "Too many tries from your network. Wait ten minutes and send again; your draft is kept.",
    "request-key-reused": "That attempt was already used for a different draft. Your draft is kept; press send again.",
    "capacity": "We cannot take new messages right now. Your draft is kept; try again later.",
    "unknown-field": "The page and server disagree. Reload the page and try again."
  };

  // Prefill the page from ?from=, and point Back at it when it is one we know.
  var from = new URLSearchParams(location.search).get("from") || "";
  if (PAGE.test(from)) {
    $("feedbackPage").value = from;
    if (Object.prototype.hasOwnProperty.call(BACK, from)) $("feedbackBack").setAttribute("href", BACK[from]);
  }

  var attempt = { draft: "", key: "" };
  function newKey() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var text = "";
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function show(el, on) { el.hidden = !on; }

  function check() {
    var message = $("feedbackMessage").value.trim();
    var email = $("feedbackEmail").value.trim();
    var page = $("feedbackPage").value.trim().toLowerCase();
    var mBad = message === "" || Array.from(message).length > MAX_MESSAGE;
    var eBad = email !== "" && !EMAIL.test(email);
    var pBad = page !== "" && !PAGE.test(page);
    show($("feedbackMessageErr"), mBad);
    show($("feedbackEmailErr"), eBad);
    show($("feedbackPageErr"), pBad);
    $("feedbackMessage").setAttribute("aria-invalid", String(mBad));
    $("feedbackEmail").setAttribute("aria-invalid", String(eBad));
    $("feedbackPage").setAttribute("aria-invalid", String(pBad));
    var bad = [];
    if (mBad) bad.push("feedbackMessage");
    if (eBad) bad.push("feedbackEmail");
    if (pBad) bad.push("feedbackPage");
    return bad;
  }

  function formError(text) {
    $("feedbackFormErr").textContent = text;
    show($("feedbackFormErr"), text !== "");
  }

  async function submit(event) {
    event.preventDefault();
    formError("");
    var bad = check();
    if (bad.length) { $(bad[0]).focus(); return; }
    var body = { kind: "feedback", message: $("feedbackMessage").value, nickname: $("feedbackNickname").value };
    var email = $("feedbackEmail").value.trim();
    var page = $("feedbackPage").value.trim().toLowerCase();
    if (email !== "") body.email = email;
    if (page !== "") body.page = page;
    var draft = JSON.stringify(body);
    if (draft !== attempt.draft) attempt = { draft: draft, key: newKey() };
    body.request_key = attempt.key;
    $("feedbackSubmit").disabled = true;
    try {
      var res = await fetch("/api/questions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && typeof data.id === "string") {
        $("feedbackRef").textContent = data.id;
        show($("feedbackForm"), false);
        show($("feedbackReceipt"), true);
        $("feedbackReceipt").focus();
        return;
      }
      if (res.ok) { formError("Thanks. Your message was not stored; reload the page if you meant to send it."); return; }
      var code = typeof data.code === "string" ? data.code : "";
      if (code === "request-key-reused") attempt = { draft: "", key: "" };
      if (code === "bad-email") { show($("feedbackEmailErr"), true); $("feedbackEmail").focus(); return; }
      if (code === "bad-question") { show($("feedbackMessageErr"), true); $("feedbackMessage").focus(); return; }
      if (code === "bad-page") { show($("feedbackPageErr"), true); $("feedbackPage").focus(); return; }
      formError(FORM_ERRORS[code] || "Could not save your feedback. Your draft is still here; try again.");
    } catch (error) {
      formError("Could not reach the server. Your draft is still here; try again.");
    } finally {
      $("feedbackSubmit").disabled = false;
    }
  }

  // Send starts disabled in the HTML, so without this script the form cannot be submitted at all.
  $("feedbackSubmit").disabled = false;
  $("feedbackForm").addEventListener("submit", submit);
})();
