// docs/LIMITS.md is rendered whole from CLAIMS; any edit to the doc, or to a quoted source, fails here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { parseWeek, readPerDay } from "../browser/tm-week.ts";
import { CHEAPER, MARGIN, MIN_PAIRED, TEST_SET_ONLY } from "../core/verdict.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DOC_PATH = "docs/LIMITS.md";

interface Quote { readonly source: string; readonly text: string }
interface Claim { readonly id: string; readonly section: 1 | 2 | 3 | 4; readonly text: string; readonly quotes: readonly Quote[] }
type Reader = (path: string) => string | null;

const POINTS = Math.round(MARGIN * 100);
const VR = "docs/decision/verdict-rules.md";
const FMT = "format/README.md";
const REL = "docs/RELEASE-v0.1.0.md";
const PRIV = "site/privacy/index.html";
const STORED = "docs/product/what-is-stored.md";
const ASK = "site/ask/index.html";
const GUEST = "docs/guest-access.md";
const TM = "src/browser/tm-week.ts";
const TM_PAGE = "site/tm/index.html";
const TM_RUN = "src/browser/tm-run.ts";
const TM_SUBMIT = "src/browser/tm-submit.ts";
const MAPS_JS = "site/maps/maps.js";

const TITLE = "# Known limits (v0)";
const INTRO = "What a Jev!Jev verdict covers, what it needs, and what is not supported or tested. Each bullet states one limit and links the file it comes from. `src/docs/limits.test.ts` fails if a bullet changes or its source no longer contains the quoted text.";
const HEADINGS = [
  "## 1. What the verdict establishes and what it does not",
  "## 2. Evidence required",
  "## 3. Unsupported or untested",
  "## 4. Data and trust",
];

const CLAIMS: readonly Claim[] = [
  { id: "test-set-only", section: 1, text: TEST_SET_ONLY, quotes: [{ source: VR, text: "The verdict describes the builder's test set, not production." }] },
  { id: "use-jev-accuracy", section: 1, text: `Use Jev means the 95% interval puts Jev's accept rate less than ${POINTS} points below the LLM's; it does not mean Jev is as accurate.`, quotes: [{ source: VR, text: `lower bound of (Jev minus LLM) above -${MARGIN.toFixed(2)}` }, { source: VR, text: "Confidence level | 95%" }] },
  { id: "use-jev-cost", section: 1, text: `Use Jev also needs Jev's cost per accepted answer to be ${CHEAPER} or less of the LLM's, with the 95% upper bound of that ratio below 1.`, quotes: [{ source: VR, text: `cost ratio ${CHEAPER} or less, and its upper bound below 1` }] },
  { id: "use-jev-rule", section: 1, text: `When the rule is compared, a 95% interval that puts the rule's accept rate less than ${POINTS} points below Jev's gives don't use Jev; a free rule that does the job wins.`, quotes: [{ source: VR, text: `lower bound of (rule minus Jev) above -${MARGIN.toFixed(2)}` }, { source: VR, text: "A free rule that does the job wins." }, { source: VR, text: "**Don't use Jev** when any of these holds" }] },
  { id: "simulation", section: 1, text: `In the simulation behind the settings, which assumes an outcome correlation of 0.5 and an LLM accept rate of 0.8 or 0.9, a Jev exactly ${POINTS} points worse than the LLM most often gets not enough evidence at ${MIN_PAIRED} paired cases.`, quotes: [{ source: VR, text: "Outcome correlation between Jev and the LLM 0.5, an assumption." }, { source: VR, text: `When Jev is exactly ${POINTS} points worse, it wrongly reaches "use Jev" in 3% of test sets or fewer at every n. The rule leans towards "not enough evidence"; at ${MIN_PAIRED} cases that is the most common result.` }, { source: VR, text: "low accept rates (p_llm below 0.8)" }] },
  { id: "no-case-count", section: 1, text: `Beyond the ${MIN_PAIRED}-case minimum, the verdict does not say how many more cases would settle it.`, quotes: [{ source: VR, text: `The only count the screen gives is rule 1's: ${MIN_PAIRED} minus the paired cases.` }] },
  { id: "dropped-rows", section: 1, text: "A refused, failed or unsupported answer has no label and drops out of the pairing, so the verdict's accept rates and cost per accepted answer leave it out; the answerer's row count and total cost still include it.", quotes: [{ source: FMT, text: "there is no answer to judge, so it is never counted as right or wrong" }, { source: VR, text: "Unlabelled rows are left out of every count." }, { source: FMT, text: "It still counts in `rows` and in cost" }, { source: VR, text: "For one answerer X on the paired cases" }] },
  { id: "agent-labels", section: 1, text: "An agent label that nobody reviewed is never counted as truth.", quotes: [{ source: FMT, text: "An `agent` label was never reviewed by a person, so it is never counted as truth" }] },
  { id: "labels-as-recorded", section: 1, text: "The results page shows labels and costs as recorded in the file and does not check how they were produced.", quotes: [{ source: "scripts/result-view.ts", text: "Labels and costs are shown as recorded in the file; this page does not check how they were produced." }] },
  { id: "decisions-arm", section: 1, text: "Decisions API answers are recorded, but the verdict reads Jev, the LLM and the rule only.", quotes: [{ source: FMT, text: "The verdict and metrics (`src/core/`) read llm, rule and jev only." }] },
  { id: "tm-jev-rehearsal", section: 1, text: "On the TokenMax page, Jev is shown as an example in rehearsal and has not been run on your usage.", quotes: [{ source: TM_PAGE, text: "in rehearsal, 47 jobs (example), not run yet" }] },

  { id: "labelled-record", section: 2, text: "A labelled test file in the jnj-record format.", quotes: [{ source: VR, text: "labelled test file (`jnj-record/1`" }] },
  { id: "min-paired", section: 2, text: `At least ${MIN_PAIRED} paired labelled Jev and LLM cases; fewer gives not enough evidence.`, quotes: [{ source: VR, text: `fewer than ${MIN_PAIRED} paired labelled cases between Jev and the LLM` }] },
  { id: "cost-required", section: 2, text: "A cost_usd on every paired Jev and LLM row; a missing one gives not enough evidence.", quotes: [{ source: VR, text: "any `cost_usd` missing on a paired Jev or LLM row" }] },
  { id: "rule-skipped", section: 2, text: `With no rule rows or fewer than ${MIN_PAIRED} paired rule cases, the rule comparison is skipped and the verdict comes from Jev against the LLM only.`, quotes: [{ source: VR, text: "The rule comparison is skipped and the screen says so; the verdict comes from Jev against the LLM." }, { source: VR, text: `Skipped when there are fewer than ${MIN_PAIRED} paired rule cases or no rule rows.` }] },

  { id: "sim-untested", section: 3, text: `The simulation does not cover true drops above ${POINTS} points, LLM accept rates below 0.8 or missing labels.`, quotes: [{ source: VR, text: `The sim does not cover true drops above ${MARGIN.toFixed(2)}, low accept rates (p_llm below 0.8), or missing labels.` }] },
  { id: "two-answer-choice", section: 3, text: "Backstage tests only a Choice question with exactly two answers (issue #122).", quotes: [{ source: "src/backstage/contracts.ts", text: "readonly choices: readonly [Choice, Choice];" }] },
  { id: "text-inputs", section: 3, text: "Inputs are text cases.", quotes: [{ source: REL, text: "Version 1 inputs are text cases." }] },
  { id: "release-recorded", section: 3, text: "The release check (`bun scripts/release-check.ts`) uses a recorded Jev response for `run` and makes no paid provider call.", quotes: [{ source: REL, text: "It uses a recorded Jev response for `run` and makes no paid provider call." }] },
  { id: "release-no-http", section: 3, text: "The release check does not exercise the HTTP surface. With `--url` it compares only the static site's `/DEPLOYED_SHA` to the candidate commit and does not check the backend or any other module.", quotes: [{ source: REL, text: "The check does not exercise the HTTP surface" }, { source: "docs/RELEASE-CHECKLIST.md", text: "`served sha` checks the static site's `/DEPLOYED_SHA` only." }, { source: "docs/RELEASE-CHECKLIST.md", text: "It does not check the backend or any other module of the stack." }] },
  { id: "backstage-deferred", section: 3, text: "Google sign-in for Backstage and paid comparisons are deferred beyond v0 (issue #77).", quotes: [{ source: REL, text: "Google sign-in for Backstage and paid comparisons are deferred beyond v0." }] },
  { id: "admin-exercised", section: 3, text: "The admin page, API and MCP connector have been exercised only by the operator and by scripted tests, not by an outside user.", quotes: [{ source: REL, text: "The admin page, the admin API and the admin MCP connector have been exercised only by the operator and by scripted tests, not by an outside user." }] },
  { id: "tm-claude-codex", section: 3, text: "The TokenMax prompt asks your assistant about Claude Code and Codex history only; other assistants are not asked about.", quotes: [{ source: TM_PAGE, text: "Look at my Claude Code and Codex history on this computer for the last 7 days." }] },
  { id: "tm-eight-weeks", section: 3, text: "The TokenMax page reads the last 7 days or the last 8 weeks; over 7 days it shows per-week averages, each self-reported total divided evenly by days / 7, not verified and not a measured week, and a Sessions per day line shows as not recorded unless it has one number per day for a period of 8 to 90 days, or seven numbers otherwise.", quotes: [{ source: TM, text: "exactly `count` whole numbers (seven by default), else null" }, { source: TM, text: "Totals divided evenly by ${w} weeks; not a measured week." }, { source: TM_PAGE, text: "> Last 8 weeks</label>" }, { source: TM_PAGE, text: "each total divided evenly by 8, self-reported, not a measured week" }, { source: MAPS_JS, text: "totals divided evenly by days / 7, not a measured week" }, { source: "site/tm/tm.js", text: "perDay ? \"\" : NOT_RECORDED" }] },
  { id: "connector-bearer", section: 3, text: "The remote admin MCP connector uses a bearer token today; OAuth sign-in is planned and not built yet.", quotes: [{ source: GUEST, text: "Authorization: Bearer jna_..." }, { source: GUEST, text: "There is no OAuth" }, { source: GUEST, text: "### Not built (phase 2)" }] },
  { id: "connector-origin", section: 3, text: "Whether a Claude app sends an Origin header to the remote admin MCP connector is not verified; if it sends its own web origin, every call is refused with 403 until that origin is allowed.", quotes: [{ source: GUEST, text: "Whether Claude's hosted apps send an `Origin` is not verified: if they send their own web origin, every call is 403 (it fails closed) until that origin is allowed." }, { source: "src/guest-intake/admin-mcp-http.ts", text: "if (origin !== null && origin !== opts.origin) return refuse(\"origin-refused\", 403, null);" }] },
  { id: "reply-escapes", section: 3, text: "A reply sent with emoji as JSON surrogate-pair escapes takes twelve bytes a character, so an all-emoji reply within the 8,000-character limit can still be refused with 413 by the 64 KiB request cap; how Claude's client encodes a reply over the remote connector is not verified.", quotes: [{ source: GUEST, text: "A client that sends an all-emoji reply as JSON surrogate-pair escapes (twelve bytes a character) goes over 64 KiB and gets 413 `too-large` from the server, Bun or nginx." }, { source: GUEST, text: "A reply is at most 8,000 characters after trimming" }, { source: GUEST, text: "Over the remote connector the request bytes come from Claude's client, whose encoding is not verified." }, { source: "src/guest-intake/admin-api.ts", text: "sent as surrogate-pair escapes (twelve bytes a character) does not (#285)." }] },
  { id: "guest-connector", section: 3, text: "The remote guest MCP endpoint uses a guest bearer token and has no OAuth; whether Claude's hosted apps send an Origin header to it is not verified.", quotes: [{ source: GUEST, text: "The remote guest endpoint has no OAuth" }, { source: GUEST, text: "Whether Claude's hosted apps send an Origin header to the guest endpoint is not verified" }] },
  { id: "guest-transport", section: 3, text: "The guest MCP adapter runs as a local stdio server (`src/guest-intake/mcp.ts`) and as a remote MCP Streamable HTTP endpoint at /api/v1/guest/mcp for Claude's hosted apps, which cannot run the stdio adapter; the remote endpoint is stateless, answers an authenticated GET or DELETE with 405, and has a 64 KiB request cap, a 256 KiB response cap and a 30-second deadline per request.", quotes: [{ source: GUEST, text: "The adapter is a local stdio MCP server, `src/guest-intake/mcp.ts`" }, { source: GUEST, text: "Claude's hosted apps (Cowork, desktop, web) cannot run the stdio adapter, so the same three tools are also served over MCP Streamable HTTP at `https://jevnotjev.breakoutwithai.com/api/v1/guest/mcp`" }, { source: GUEST, text: "stateless (no `Mcp-Session-Id`), JSON responses" }, { source: GUEST, text: "`GET` and `DELETE` are 405 `Allow: POST`." }, { source: GUEST, text: "request body 64 KiB (nginx's `/api/v1/` cap)" }, { source: GUEST, text: "response 256 KiB, 30 seconds per request counted from when it arrives" }, { source: "src/guest-intake/guest-mcp-http.ts", text: "if (request.method !== \"POST\") return refuse(\"method-not-allowed\", 405, token, { allow: \"POST\" });" }, { source: "src/guest-intake/guest-mcp-http.ts", text: "export const GUEST_MCP_TIMEOUT_MS = 30_000;" }] },
  { id: "no-outside-run", section: 3, text: "No consented outside user's own run from start to verdict is documented yet; the next step is to invite one and document it.", quotes: [{ source: REL, text: "No consented outside user's own run from start to verdict is documented yet; the next step is to invite one and document it." }] },
  { id: "admin-deadline", section: 3, text: "A remote admin MCP request can run past its 30-second deadline by a database lock wait; a call whose client disconnects still runs until it completes or reaches the deadline, and a reply answered 504 may still have been stored.", quotes: [{ source: GUEST, text: "a request can run past it by that wait" }, { source: GUEST, text: "a call whose client disconnects still runs to completion or to the deadline" }, { source: GUEST, text: "A reply answered 504 `timeout` may still have been stored" }] },
  { id: "bearer-scheme", section: 3, text: "The admin token header must spell the scheme `Bearer`; `bearer` or `BEARER` is refused.", quotes: [{ source: GUEST, text: "the header must say `Bearer`; `bearer` or `BEARER` is 401" }] },
  { id: "duplicate-headers", section: 3, text: "Responses under /api/v1/guest/ that nginx forwards from the app carry two X-Content-Type-Options: nosniff headers and two Referrer-Policy headers, no-referrer from the app and strict-origin-when-cross-origin from nginx; issue #369 rates this low severity for a JSON API called with bearer tokens, and it is disclosed here, not fixed.", quotes: [{ source: "src/guest-intake/guest-routes.ts", text: "const HEADERS = { \"cache-control\": \"no-store\", \"x-content-type-options\": \"nosniff\", \"referrer-policy\": \"no-referrer\" };" }, { source: ".deploy/nginx-jevnotjev.conf", text: "add_header X-Content-Type-Options \"nosniff\" always;" }, { source: ".deploy/nginx-jevnotjev.conf", text: "add_header Referrer-Policy \"strict-origin-when-cross-origin\" always;" }] },
  { id: "tm-pasted", section: 3, text: "The TokenMax week map shows only the block you paste back from your own Claude Code or Codex after running its prompt; every number on the page comes from that block.", quotes: [{ source: TM, text: "Reads the TOKENMAX WEEK block a visitor pastes back into /tm/ after running the prompt in Claude Code or Codex" }, { source: TM, text: "derives everything the page shows from it" }, { source: TM_PAGE, text: "get a plain summary of your own week from the Claude Code or Codex you already use" }] },
  { id: "tm-not-recorded", section: 3, text: "On the TokenMax week map, a line your assistant could not fill, or one the page cannot read, is shown as not recorded; nothing is invented in its place.", quotes: [{ source: TM, text: "A line it cannot read, or one that says \"not recorded\", stays null and is shown as" }, { source: TM, text: "nothing is invented: no day, no story, no saving." }] },
  { id: "guide-text-only", section: 3, text: "The /guide/ page's collapsed field guide is headed \"Backstage workspace, deferred beyond v0\" and still describes the Backstage workspace (issue #261).", quotes: [{ source: "site/guide/index.html", text: "Backstage workspace, deferred beyond v0" }, { source: "site/guide/index.html", text: "The workspace is the signed-in page where you run your own test" }] },

  { id: "made-up-cases", section: 4, text: "Use made-up or redacted cases: a case you run goes to each provider you select.", quotes: [{ source: PRIV, text: "Use made-up or redacted cases." }, { source: PRIV, text: "A case you run goes to each provider you select." }] },
  { id: "no-server-save", section: 4, text: "Backstage does not save cases, runs or keys to a file or database on the server.", quotes: [{ source: PRIV, text: "Backstage does not save your cases, runs or keys to a file or database on our server." }] },
  { id: "relay-buffer", section: 4, text: "Requests pass through the server and its web server may hold requests briefly while relaying.", quotes: [{ source: PRIV, text: "its web server may hold them briefly while relaying" }] },
  { id: "draft-in-tab", section: 4, text: "An unfinished scene draft is saved in the browser tab's storage.", quotes: [{ source: PRIV, text: "Your unfinished scene draft, including cases and question text, is saved in this browser tab's storage." }] },
  { id: "server-keeps", section: 4, text: "Among other records, the server keeps ticket-form details including your email, an operators file of sign-in emails and password hashes, and event logs with sign-in email and IP address; the privacy page section What we keep has the rest.", quotes: [{ source: PRIV, text: "What we keep" }, { source: PRIV, text: "the form puts your ticket number, submission time, ticket type, email" }, { source: PRIV, text: "an operators file on our server holds approved email addresses" }, { source: PRIV, text: "They contain sign-in email and IP address" }] },
  { id: "deletion", section: 4, text: "The ticket office has no automatic or self-service deletion: an operator deletes a ticket row on request.", quotes: [{ source: PRIV, text: "An operator must handle the request because the code has no self-service deletion route." }, { source: PRIV, text: "The ticket office has no automatic deletion." }] },
  { id: "scan-shapes", section: 4, text: "The evidence export check matches listed key shapes and exact supplied key values; a key in another shape that was not supplied, such as a Jev key, is not caught.", quotes: [{ source: STORED, text: "A key in a shape not listed is not caught. That includes the Jev key" }, { source: STORED, text: "Optional `knownKeys` are also searched for exact values" }, { source: STORED, text: "`evidence()` refuses a run once `containsKey()` has found a supplied key value" }] },
  { id: "export-check", section: 4, text: "The evidence export check tests reproducibility and looks for leaked credentials; it does not prove an export is authentic.", quotes: [{ source: STORED, text: "It is a reproducibility and no-credentials check, not an authenticity check." }] },
  { id: "provider-retention", section: 4, text: "Retention and deletion policies of model providers and other infrastructure are unknown beyond the application code.", quotes: [{ source: PRIV, text: "We do not know the retention and deletion policies of model providers or other infrastructure beyond the application code." }] },
  { id: "question-human", section: 4, text: "A question sent from the ask page is read and answered by a person; it is never sent to a model provider and no Jev run happens.", quotes: [{ source: PRIV, text: "Your question is never sent to a model provider and no Jev run happens." }, { source: ASK, text: "A person reviews every question. Nothing answers it automatically." }] },
  { id: "question-email", section: 4, text: "Your email is not checked and no reply is emailed to it; the reply appears on the ask page under your status code.", quotes: [{ source: PRIV, text: "Your email is not checked and no reply is emailed to it." }, { source: ASK, text: "The reply appears on this page under your status code." }] },
  { id: "question-retention", section: 4, text: "Questions have no retention period yet and nothing is deleted automatically; a person deletes one by hand on request.", quotes: [{ source: PRIV, text: "no retention period has been set and nothing is deleted automatically" }, { source: PRIV, text: "A person deletes it by hand." }, { source: ASK, text: "no retention period has been set yet" }] },
  { id: "connector-model", section: 4, text: "Operator tools such as a Claude connector may send question text to a model provider when an operator connects one, which differs from the ask page promise that no model provider sees your question, so the connector is not run on visitor rows without the visitor's consent.", quotes: [{ source: GUEST, text: "A connected Claude app may send the question text it reads to a model provider, which differs from the ask page promise that no model provider sees a question. The connector is not run on visitor rows without the visitor's consent." }, { source: ASK, text: "no model provider sees your question" }] },
  { id: "token-audience", section: 4, text: "An operator token is not bound to one endpoint: the same token works on the admin API and the remote admin MCP connector.", quotes: [{ source: GUEST, text: "an operator token is not bound to one endpoint" }, { source: GUEST, text: "The same `jna_` token works on `/api/v1/admin/mcp` and `/api/v1/admin/questions`." }] },
  { id: "admin-rate-limit", section: 4, text: "Admin routes run before the server's concurrency slot and have no per-IP rate limit.", quotes: [{ source: GUEST, text: "admin routes run before the server's concurrency slot and have no per-IP rate limit" }] },
  { id: "visitor-text", section: 4, text: "A question's text is untrusted: it can instruct the operator's agent to copy other visitors' emails or questions into a reply its sender reads, so the operator reads each reply before approving it.", quotes: [{ source: GUEST, text: "A question can instruct the agent to copy other visitors' emails or questions into a reply, and its sender reads that reply on the ask page." }, { source: GUEST, text: "read each `reply_question` before approving it" }] },
  { id: "tm-browser", section: 4, text: "On the TokenMax page, reading a pasted week and Show my week happen in your browser; nothing is sent until you press Submit.", quotes: [{ source: TM_PAGE, text: "Pasting and Show my week stay in your browser. Only Submit sends anything." }, { source: TM_PAGE, text: "Nothing is sent until you press Submit." }, { source: TM_RUN, text: "parsed here and shown as values only; nothing is sent until Submit" }] },
  { id: "tm-submit-sends", section: 4, text: "Submit sends the numbers mapped from your pasted block, a nickname you choose and a generated request key to the public board at /maps/, and the nickname is public.", quotes: [{ source: TM_PAGE, text: "Pressing Submit sends the numbers from your result and your nickname to this site" }, { source: TM_PAGE, text: "and a random request key that lets a repeat press be recognised. They appear on the public board at /maps/" }, { source: TM_PAGE, text: "Nickname for the public board" }, { source: TM_RUN, text: "win.fetch(\"/api/maps\", { method: \"POST\"" }] },
  { id: "tm-self-reported", section: 4, text: "The board shows a submitted TokenMax week as self-reported and not verified; the numbers come from your own assistant's pasted block.", quotes: [{ source: TM_PAGE, text: "shown as self-reported and not verified" }, { source: MAPS_JS, text: "self-reported from a pasted TokenMax block, not verified" }] },
  { id: "tm-submit-refused", section: 4, text: "Submit is refused when a required line is not recorded or a number cannot be held, with a message naming the line.", quotes: [{ source: TM_SUBMIT, text: "a required line that is not recorded, or a number the contract cannot hold, refuses the submit" }] },
  { id: "tm-storage", section: 4, text: "The TokenMax page keeps the delete key and retry key only in its own memory, not in browser storage, and removes an older key an earlier version stored there; the server keeps the submitted row with no automatic deletion date until its delete link is used.", quotes: [{ source: TM_PAGE, text: "This page keeps the delete key and retry key only in its own memory, not in browser storage." }, { source: TM_RUN, text: "Remove it so no delete key stays in browser storage." }, { source: TM_RUN, text: "win.localStorage.removeItem(\"tm-submit/1\")" }, { source: PRIV, text: "Rows have no automatic deletion date." }, { source: PRIV, text: "The delete link shown after sharing or submitting removes your row." }] },
  { id: "tm-key-lost", section: 4, text: "If you reload or close the TokenMax page, it no longer has the key that removes your entry, and pressing Submit again sends a new key and can add a second row.", quotes: [{ source: TM_PAGE, text: "They are gone when the page is closed or reloaded." }, { source: TM_PAGE, text: "after reloading or closing the page, pressing Submit sends a new key and can add a second row." }, { source: TM_RUN, text: "Keep this key to remove your entry." }] },
  { id: "tm-stalled", section: 4, text: "A TokenMax Submit on a stalled or failed connection may or may not have reached the board; pressing Submit again on the same page for the same result and nickname does not add a second row.", quotes: [{ source: TM_RUN, text: "Not confirmed: no answer within 15 seconds, so your entry may already be on the board." }, { source: TM_RUN, text: "for the same result and nickname it never adds a second row." }] },
  { id: "board-counts-maps", section: 4, text: "The board does not detect the same result shared under another nickname, from another page load or by the mapper and the page, so its totals count shared maps, not distinct people, and one nickname can have several rows.", quotes: [{ source: MAPS_JS, text: "maps shared" }, { source: MAPS_JS, text: "map with a weekly cap" }, { source: "src/backstage/maps.test.ts", text: "the same result shared under two request keys and one nickname makes two rows and counts twice" }] },
];

function norm(text: string): string { return text.replace(/\s+/g, " ").trim(); }
// A quote holds only as whole words: "below 1" must not match "below 1.5", and "30 paired" must not match "130 paired".
function holds(source: string, quote: string): boolean {
  const s = norm(source);
  const q = norm(quote);
  for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + 1)) {
    const before = s.slice(Math.max(0, i - 1), i);
    const after = s.slice(i + q.length, i + q.length + 2);
    if (!/\w/.test(before) && !/^(?:\w|\.\d)/.test(after)) return true;
  }
  return false;
}
function unsafe(path: string): boolean {
  return path.length === 0 || isAbsolute(path) || path.startsWith("~") || path.includes("\\") || path.split("/").includes("..");
}

function render(claims: readonly Claim[]): string {
  const lines: string[] = [TITLE, "", INTRO];
  HEADINGS.forEach((heading, i) => {
    lines.push("", heading, "");
    for (const c of claims.filter((x) => x.section === i + 1)) {
      const first = c.quotes[0];
      const link = first === undefined ? "" : posix.relative(posix.dirname(DOC_PATH), first.source);
      lines.push(`- ${c.text} [Source](${link}) <!-- claim: ${c.id} -->`);
    }
  });
  return `${lines.join("\n")}\n`;
}

/** Every problem found; empty means the doc equals the rendered claims and every quote is in its source. */
function check(docText: string, read: Reader, claims: readonly Claim[] = CLAIMS): string[] {
  const problems: string[] = [];
  const want = render(claims).split("\n");
  const got = docText.split("\n");
  if (want.length !== got.length) problems.push("line count differs");
  for (let i = 0; i < Math.min(want.length, got.length); i++) {
    if (want[i] !== got[i]) { problems.push(`line ${i + 1} differs`); break; }
  }
  const seen = new Set<string>();
  for (const c of claims) {
    if (seen.has(c.id)) problems.push(`duplicate id: ${c.id}`);
    seen.add(c.id);
    for (const q of c.quotes) {
      if (unsafe(q.source)) { problems.push(`unsafe path: ${c.id}`); continue; }
      const src = read(q.source);
      if (src === null) { problems.push(`missing source: ${c.id} ${q.source}`); continue; }
      if (!holds(src, q.text)) problems.push(`quote missing: ${c.id}`);
    }
  }
  return problems;
}

function realRead(path: string): string | null {
  if (unsafe(path)) return null;
  try { return readFileSync(join(ROOT, path), "utf8"); } catch { return null; }
}
const doc = readFileSync(join(ROOT, DOC_PATH), "utf8");

/** Replace the first occurrence; the needle must exist so a control cannot pass by changing nothing. */
function edit(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}
function lineNo(text: string, needle: string): number {
  return text.split("\n").findIndex((l) => l.includes(needle)) + 1;
}

describe("known limits (v0)", () => {
  test("[unit] the real doc equals the rendered claims and every quote is in its source", () => {
    expect(check(doc, realRead)).toEqual([]);
  });
  test("[unit] every claim has at least one quote", () => {
    for (const c of CLAIMS) expect(c.quotes.length).toBeGreaterThan(0);
  });
  test("[unit] public hygiene: no session links, challenge talk or dashes in visible text (paths: public-scan before push)", () => {
    const visible = doc.replace(/<!--[\s\S]*?-->/g, "");
    expect(visible).not.toMatch(/claude\.ai|winning|leaderboard|\brank|portal|skool|challenge/i);
    expect(visible.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(visible.includes(String.fromCharCode(0x2013))).toBe(false);
  });

  test("[unit] tm-eight-weeks: seven numbers by default, 56 for an 8-week period, a mismatched count is not recorded", () => {
    expect(readPerDay("1, 2, 3, 4, 5, 6, 7")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(readPerDay(Array.from({ length: 30 }, (_, i) => String(i + 1)).join(", "))).toBeNull();
    expect(readPerDay(Array.from({ length: 56 }, () => "1").join(", "), 56)?.length).toBe(56);
    expect(readPerDay("1, 2, 3, 4, 5, 6, 7", 56)).toBeNull();
    // A period of 7 days or fewer (or over 90) still needs seven numbers: the stage has seven posters.
    expect(parseWeek("Period: 2026-10-01 to 2026-10-03\nSessions per day: 1, 2, 3, 4, 5, 6, 7")?.perDay).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parseWeek("Period: 2026-10-01 to 2026-10-03\nSessions per day: 1, 2, 3")?.perDay).toBeNull();
  });
  test("[unit] control: a removed claim comment is reported", () => {
    const mutated = edit(doc, " <!-- claim: min-paired -->", "");
    expect(check(mutated, realRead)).toContain(`line ${lineNo(doc, "claim: min-paired")} differs`);
  });
  test("[unit] control: an extra uncited bullet is reported", () => {
    const mutated = edit(doc, "## 2. Evidence required\n\n", "## 2. Evidence required\n\n- A new limit with no source.\n");
    const problems = check(mutated, realRead);
    expect(problems).toContain("line count differs");
    expect(problems).toContain(`line ${lineNo(doc, "## 2. Evidence required") + 2} differs`);
  });
  test("[unit] control: a bullet's 30 changed to 20 is reported", () => {
    const n = lineNo(doc, "claim: min-paired");
    const mutated = doc.split("\n").map((l, i) => (i + 1 === n ? l.replace("30", "20") : l)).join("\n");
    expect(mutated).not.toBe(doc);
    expect(check(mutated, realRead)).toContain(`line ${n} differs`);
  });
  test("[unit] control: a word changed in a bullet with no number is reported", () => {
    const n = lineNo(doc, "claim: agent-labels");
    const mutated = edit(doc, "nobody reviewed", "somebody reviewed");
    expect(check(mutated, realRead)).toContain(`line ${n} differs`);
  });
  test("[unit] control: an edited intro is reported", () => {
    const mutated = edit(doc, "what is not supported or tested", "what is supported");
    expect(check(mutated, realRead)).toContain(`line ${lineNo(doc, "What a Jev!Jev verdict covers")} differs`);
  });
  test("[unit] control: an edited heading is reported", () => {
    const mutated = edit(doc, "## 3. Unsupported or untested", "## 3. Unsupported");
    expect(check(mutated, realRead)).toContain(`line ${lineNo(doc, "## 3. ")} differs`);
  });
  test("[unit] control: a changed link target is reported", () => {
    const n = lineNo(doc, "claim: min-paired");
    const mutated = edit(doc, "[Source](decision/verdict-rules.md) <!-- claim: min-paired", "[Source](decision/other.md) <!-- claim: min-paired");
    expect(check(mutated, realRead)).toContain(`line ${n} differs`);
  });
  test("[unit] control: a quote removed from its source is reported", () => {
    const victim = CLAIMS.find((c) => c.id === "cost-required");
    const quote = victim?.quotes[0];
    expect(quote).toBeDefined();
    const fake: Reader = (p) => {
      const real = realRead(p);
      return real === null || p !== quote?.source ? real : norm(real).split(norm(quote.text)).join("");
    };
    expect(check(doc, fake)).toContain("quote missing: cost-required");
  });
  test("[unit] control: a quote that survives only as part of a longer number is reported", () => {
    const fake: Reader = (p) => {
      const real = realRead(p);
      return real === null || p !== VR ? real : real.split("and its upper bound below 1").join("and its upper bound below 1.5");
    };
    expect(check(doc, fake)).toContain("quote missing: use-jev-cost");
  });
  test("[unit] control: a reader returning null for a source is reported", () => {
    const fake: Reader = (p) => (p === STORED ? null : realRead(p));
    expect(check(doc, fake)).toContain(`missing source: export-check ${STORED}`);
  });
  test("[unit] control: a duplicated id is reported", () => {
    const first = CLAIMS[0];
    expect(first).toBeDefined();
    const claims = first === undefined ? CLAIMS : [...CLAIMS, first];
    expect(check(doc, realRead, claims)).toContain(`duplicate id: ${first?.id}`);
  });
  test("[unit] control: an absolute or climbing source path is reported", () => {
    for (const bad of ["/etc/hosts", "../outside.md"]) {
      const claims = CLAIMS.map((c) => (c.id === "cost-required" ? { ...c, quotes: [{ source: bad, text: "x" }] } : c));
      expect(check(doc, realRead, claims)).toContain("unsafe path: cost-required");
    }
  });
});
