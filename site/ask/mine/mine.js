// My questions (#307): visitor sign-in state and questions from /api/v1/visitor/*.
// Every value from the server is written with textContent, never as HTML. The cookie is HttpOnly and never read here.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var API = "/api/v1/visitor";
  var MAX_QUESTION = 4096;
  var STATES = {
    pending_review: ["pending review", "A person has not reviewed it yet."],
    needs_info: ["needs more information", "Read the note below."],
    approved: ["approved", "A person is writing the reply."],
    declined: ["declined", "This question will not get a reply."],
    answered: ["answered", "The reply is below."]
  };
  var REASONS = {
    "one-question": "You have already used your free question. Your question and its reply are on this page.",
    "free-slots-used": "The free places are taken. You are on the waitlist."
  };
  var FORM_ERRORS = {
    "rate-limited": "Too many tries from your network. Wait ten minutes and send again; your draft is kept.",
    "request-key-reused": "That attempt was already used for a different draft. Your draft is kept; press send again to send it as a new question.",
    "deleted": "This question was deleted and cannot be sent again. Change it to send a new one.",
    "capacity": "We cannot take new questions right now. Your draft is kept; try again later.",
    "cross-origin": "The page and server disagree. Reload the page and try again.",
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

  // The refusal text, plus the waitlist place when the server sent a whole number of 1 or more.
  function reasonText(code, apiMessage, position) {
    var text = typeof apiMessage === "string" && apiMessage !== "" ? apiMessage : (REASONS[code] || "");
    var place = typeof position === "number" && isFinite(position) && position >= 1 && Math.floor(position) === position;
    return code === "free-slots-used" && place ? text + " Your place on the waitlist: " + position + "." : text;
  }

  function show(el, on) { el.hidden = !on; }
  function setText(el, text) { el.textContent = text; show(el, text !== ""); }

  function view(name) {
    show($("mineLoading"), name === "loading");
    show($("mineSignedOut"), name === "out");
    show($("mineSignedIn"), name === "in");
  }

  function when(value) {
    var d = new Date(value);
    return isNaN(d.getTime()) ? "" : d.toUTCString();
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // A failed or malformed list is not an empty list: show a retryable error and no list.
  function listFailed() {
    $("mineList").replaceChildren();
    show($("mineEmpty"), false);
    show($("mineListErr"), true);
  }

  function renderQuestions(questions) {
    var list = $("mineList");
    list.replaceChildren();
    show($("mineListErr"), false);
    show($("mineEmpty"), questions.length === 0);
    questions.forEach(function (q) {
      var info = STATES[q.state] || [String(q.state), ""];
      var box = el("article", "receipt");
      box.appendChild(el("h3", "", String(q.id)));
      box.appendChild(el("p", "", "State: " + info[0] + ". " + info[1]));
      var changed = when(q.updated_at);
      if (changed !== "") box.appendChild(el("p", "hint", "Last changed " + changed + "."));
      box.appendChild(el("p", "hint", "Your question"));
      box.appendChild(el("pre", "", typeof q.question === "string" ? q.question : ""));
      if (typeof q.response === "string" && q.response !== "") {
        box.appendChild(el("p", "hint", "Reply"));
        box.appendChild(el("pre", "", q.response));
        box.appendChild(el("p", "hint", "Replies are reviewed by a person. No model has assessed your question, its accuracy or any savings."));
      }
      list.appendChild(box);
    });
  }

  async function getJson(path) {
    var res = await fetch(API + path, { credentials: "same-origin", headers: { accept: "application/json" } });
    var data = await res.json().catch(function () { return {}; });
    return { status: res.status, ok: res.ok, data: data };
  }

  async function load() {
    setText($("mineError"), "");
    view("loading");
    try {
      var me = await getJson("/me");
      if (me.status === 401) { view("out"); return; }
      if (!me.ok || typeof me.data.email !== "string") { view("out"); setText($("mineError"), "Could not check your sign-in right now. Try again later."); return; }
      var qs = await getJson("/questions");
      if (qs.status === 401) { view("out"); return; }
      $("mineEmail").textContent = me.data.email;
      var reason = typeof me.data.reason === "string" ? me.data.reason : "";
      setText($("mineMessage"), reason !== "" && REASONS[reason] ? reasonText(reason, "", me.data.waitlist_position) : "");
      show($("mineForm"), me.data.can_ask === true);
      setText($("mineSignOutErr"), "");
      if (qs.ok && Array.isArray(qs.data.questions)) renderQuestions(qs.data.questions);
      else listFailed();
      view("in");
    } catch (error) {
      view("out");
      setText($("mineError"), "Could not reach the server. Try again later.");
    }
  }

  function formError(text) { setText($("mineFormErr"), text); }

  async function submit(event) {
    event.preventDefault();
    formError("");
    var question = $("mineQuestion").value.trim();
    var qBad = question === "" || Array.from(question).length > MAX_QUESTION;
    var rBad = !$("mineReply").checked;
    show($("mineQuestionErr"), qBad);
    show($("mineReplyErr"), rBad);
    $("mineQuestion").setAttribute("aria-invalid", String(qBad));
    if (qBad) { $("mineQuestion").focus(); return; }
    if (rBad) { $("mineReply").focus(); return; }
    var body = { question: $("mineQuestion").value, reply_consent: true, marketing_consent: $("mineMarketing").checked };
    var draft = JSON.stringify(body);
    if (draft !== attempt.draft) attempt = { draft: draft, key: newKey() };
    body.request_key = attempt.key;
    $("mineSubmit").disabled = true;
    try {
      var res = await fetch(API + "/questions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && typeof data.id === "string") {
        $("mineQuestion").value = "";
        $("mineReply").checked = false;
        $("mineMarketing").checked = false;
        attempt = { draft: "", key: "" };
        await load();
        return;
      }
      var code = typeof data.code === "string" ? data.code : "";
      if (res.status === 401) { view("out"); return; }
      if (code === "request-key-reused") attempt = { draft: "", key: "" };
      if (code === "one-question" || code === "free-slots-used") {
        setText($("mineMessage"), reasonText(code, data.message, data.waitlist_position));
        show($("mineForm"), false);
        return;
      }
      formError(FORM_ERRORS[code] || "Could not save your question. Your draft is still here; try again.");
    } catch (error) {
      formError("Could not reach the server. Your draft is still here; try again.");
    } finally {
      $("mineSubmit").disabled = false;
    }
  }

  async function signOut() {
    $("mineSignOut").disabled = true;
    setText($("mineSignOutErr"), "");
    var done = false;
    try {
      var res = await fetch(API + "/sign-out", { method: "POST", credentials: "same-origin" });
      done = res.status === 204;
    } catch (error) {
      done = false;
    } finally {
      $("mineSignOut").disabled = false;
    }
    if (!done) {
      setText($("mineSignOutErr"), "Could not confirm that you signed out. You may still be signed in; try again.");
      return;
    }
    // Confirmed: drop everything of the signed-in visitor from the page and the script state.
    $("mineEmail").textContent = "";
    $("mineList").replaceChildren();
    setText($("mineMessage"), "");
    show($("mineEmpty"), false);
    show($("mineListErr"), false);
    show($("mineForm"), false);
    $("mineQuestion").value = "";
    $("mineReply").checked = false;
    $("mineMarketing").checked = false;
    formError("");
    attempt = { draft: "", key: "" };
    await load();
  }

  $("mineForm").addEventListener("submit", submit);
  $("mineSignOut").addEventListener("click", signOut);
  $("mineRetry").addEventListener("click", load);
  load();
})();
