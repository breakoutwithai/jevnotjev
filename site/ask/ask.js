// Ask a Jev!Jev question (#253): POST /api/questions, then POST /api/questions/status with the status code.
// Every value from the server is written with textContent, never as HTML. The status code lives only in this page's
// memory and on screen: no storage, no URL.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var MAX_QUESTION = 4096;
  var EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,63}$/;
  var STATES = {
    pending_review: ["pending review", "A person has not reviewed it yet."],
    needs_info: ["needs more information", "Read the note below, then send the details as a new question."],
    approved: ["approved", "A person is writing the reply."],
    declined: ["declined", "This question will not get a reply."],
    answered: ["answered", "The reply is below."]
  };
  var FORM_ERRORS = {
    "rate-limited": "Too many tries from your network. Wait ten minutes and send again; your draft is kept.",
    "request-key-reused": "That attempt was already used for a different draft. Your draft is kept; press send again to send it as a new question.",
    "deleted": "This question was deleted and cannot be sent again. Change it to send a new one.",
    "capacity": "We cannot take new questions right now. Your draft is kept; try again later.",
    "unknown-field": "The page and server disagree. Reload the page and try again."
  };

  // One request key per draft: a retry of the same draft is recognised by the server; an edited draft gets a new key.
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
    var question = $("askQuestion").value.trim();
    var email = $("askEmail").value.trim();
    var bad = [];
    var qBad = question === "" || Array.from(question).length > MAX_QUESTION;
    var eBad = !EMAIL.test(email);
    var rBad = !$("askReply").checked;
    show($("askQuestionErr"), qBad);
    show($("askEmailErr"), eBad);
    show($("askReplyErr"), rBad);
    $("askQuestion").setAttribute("aria-invalid", String(qBad));
    $("askEmail").setAttribute("aria-invalid", String(eBad));
    if (qBad) bad.push("askQuestion");
    if (eBad) bad.push("askEmail");
    if (rBad) bad.push("askReply");
    return bad;
  }

  function formError(text) {
    $("askFormErr").textContent = text;
    show($("askFormErr"), text !== "");
  }

  async function submit(event) {
    event.preventDefault();
    formError("");
    var bad = check();
    if (bad.length) { $(bad[0]).focus(); return; }
    var body = {
      email: $("askEmail").value.trim(),
      question: $("askQuestion").value,
      reply_consent: true,
      marketing_consent: $("askMarketing").checked,
      nickname: $("askNickname").value
    };
    var draft = JSON.stringify(body);
    if (draft !== attempt.draft) attempt = { draft: draft, key: newKey() };
    body.request_key = attempt.key;
    $("askSubmit").disabled = true;
    try {
      var res = await fetch("/api/questions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && typeof data.id === "string" && typeof data.status_code === "string") {
        $("askRef").textContent = data.id;
        $("askCode").textContent = data.status_code;
        $("statusCode").value = data.status_code;
        show($("askForm"), false);
        show($("askReceipt"), true);
        $("askReceipt").focus();
        return;
      }
      if (res.ok) { formError("Thanks. Your question was not stored; reload the page if you meant to send it."); return; }
      var code = typeof data.code === "string" ? data.code : "";
      // The server refused this key for this draft: the next send must be a new attempt, or it is refused again.
      if (code === "request-key-reused") attempt = { draft: "", key: "" };
      if (code === "bad-email") { show($("askEmailErr"), true); $("askEmail").focus(); return; }
      if (code === "bad-question") { show($("askQuestionErr"), true); $("askQuestion").focus(); return; }
      formError(FORM_ERRORS[code] || "Could not save your question. Your draft is still here; try again.");
    } catch (error) {
      formError("Could not reach the server. Your draft is still here; try again.");
    } finally {
      $("askSubmit").disabled = false;
    }
  }

  async function copy() {
    var code = $("askCode").textContent || "";
    try {
      await navigator.clipboard.writeText(code);
      $("askCopied").textContent = "Copied.";
    } catch (error) {
      var range = document.createRange();
      range.selectNodeContents($("askCode"));
      var selection = window.getSelection();
      if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      $("askCopied").textContent = "Selected: copy it with your keyboard.";
    }
  }

  function statusError(text) {
    $("statusErr").textContent = text;
    show($("statusErr"), text !== "");
  }

  async function status(event) {
    event.preventDefault();
    statusError("");
    show($("statusResult"), false);
    var code = $("statusCode").value.trim();
    if (code === "") { statusError("Paste your status code."); $("statusCode").focus(); return; }
    try {
      var res = await fetch("/api/questions/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code }) });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && STATES[data.state]) {
        $("statusState").textContent = STATES[data.state][0];
        $("statusNote").textContent = STATES[data.state][1];
        $("statusWhen").textContent = typeof data.updated_at === "string" ? "Last changed " + new Date(data.updated_at).toUTCString() + "." : "";
        var reply = typeof data.response === "string" ? data.response : "";
        $("statusResponse").textContent = reply;
        show($("statusResponse"), reply !== "");
        show($("statusResult"), true);
        return;
      }
      if (res.status === 404) statusError("No question matches that code. Check that you pasted all of it.");
      else if (res.status === 400) statusError("That is not a status code. It looks like Q-... followed by a dot and 43 characters.");
      else if (res.status === 429) statusError("Too many checks from your network. Wait ten minutes and try again.");
      else statusError("Could not check right now. Try again later.");
    } catch (error) {
      statusError("Could not reach the server. Try again later.");
    }
  }

  $("askForm").addEventListener("submit", submit);
  $("askCopy").addEventListener("click", copy);
  $("statusForm").addEventListener("submit", status);
  if (location.hash === "#status") $("statusCode").focus();
})();
