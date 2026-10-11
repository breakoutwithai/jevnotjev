# What Backstage stores, and where

Every statement cites the code it comes from, as `file:line` under `src/backstage/` unless a path says otherwise. Line numbers are from the tree this was written against.

## 1. The evidence export

`Run.evidence()` (`run.ts:1612`) builds the JSON the page downloads as `backstage-evidence.json` (`main.ts:1010-1018`). The browser builds it from the run held in page memory; no server call is made to produce it.

| Field | What it holds | Source |
|---|---|---|
| `version` | The protocol version, `backstage/2` | `run.ts:1620`, `contracts.ts:1` |
| `calcVersion` | The version of the verdict calculation, constant `CALC_VERSION` (`"verdict/1"`); it must change whenever the verdict or stats calculation changes | `run.ts:1621`, `contracts.ts:7` |
| `manifest` | Mode, arms, models, catalog version, revision, run id, prompt version, question id, creation time, and the scene (question, choices, definitions, cases) | `run.ts:96-107` |
| `funding` | `"trial"` or `"byok"`; never a key | `run.ts:1623` |
| `attempts` | One record per provider call: ids, requested and returned model, generation parameters, fingerprint, start and finish time, latency, tokens in and out, cost in USD, price version; on success the output and confidence, on failure the error code, message and charge state | `run.ts:1624`, `contracts.ts:60-98` |
| `labels` | Per answer: case id, arm, provider, output, label, label source, who set it and when, whether it was blind and final, whether a suggestion was shown | `run.ts:1625-1640` |
| `suggestionAttempts` | The attempts made for label suggestions | `run.ts:1641` |
| `extraSpend`, `totalSpend` | Cost totals; failed attempts and suggestion calls are counted | `run.ts:1528`, `run.ts:1539` |
| `comparisons` | Per comparison: arm id, run id, file name, the CSV text, attempt ids | `run.ts:1419-1441`, `run.ts:130-136` |
| `comparisonNote` | A fixed sentence: Jev observations are reused across cohorts, so do not sum their costs; verdicts are per pair and uncorrected for multiple comparisons | `run.ts:1645` |
| `verdicts` | Per-pair verdicts from `report()`, only when computed from exactly these records; otherwise `null` | `run.ts:1648` |
| `records` | The full records CSV, one row per answer, columns `EXPORT_COLUMNS` | `run.ts:1649`, `run.ts:27` |

Guards on the export:

- It throws before reveal if any answer exists: "Reveal results (finish judging) before downloading evidence." (`run.ts:1614-1615`).
- It throws if the run is marked unsafe: "Export blocked: this run contains a provider key." (`run.ts:1616-1617`).
- A run becomes unsafe when any key the user supplied appears as a substring anywhere in the scene, attempts, suggestion attempts or answers (`run.ts:1199-1210`, matcher at `run.ts:145-153`). An unsafe run cannot start or continue (`run.ts:1195-1198`).
- A provider response that contains the request's key is rejected as "Unsafe response evidence." (`run.ts:609-610`, `run.ts:1130`, `run.ts:1302-1303`).

Limit of the key check: it matches the key values the user supplied in this session. It does not scan for credential patterns the user never entered.

### Verdicts and the calculation version

- `verdicts` is cached by `report()` (`run.ts:1599-1602`, field at `run.ts:766-769`) and exported only while the cached records equal the current records (`run.ts:1648`). It is `null` when `report()` was not run or the records changed since.
- `CALC_VERSION` is a hand-edited constant (`contracts.ts:2-7`). Nothing bumps it automatically. The only guard is the test that the committed sample equals a fresh export (`export-check.test.ts:43-44`): it fails when a calculation change alters the sample's output, and not when a change leaves that output the same. A change that does not show in the sample still needs a manual bump.

### Reload and inspect

`checkExport(data)` and `checkExportText(json)` (`export-check.ts:198`, `export-check.ts:269`) take a parsed or raw export and return `ok`, counts and a list of problems. `ok` is true only when there are no problems (`export-check.ts:265`).

- **Credentials:** `findCredentials` (`export-check.ts:72-81`) tests every string value and every object key against `CREDENTIAL_PATTERNS` (`export-check.ts:16-25`): `sk-ant-`, `sk-`, `xai-`, `AIza`, `Bearer` tokens, GitHub tokens, `api_`/`api-` keys and `key/secret/password/token = value` assignments. It reports the JSON path and pattern name, never the matched text. Optional `knownKeys` are also searched for exact values (`export-check.ts:78`). Any hit refuses the export before anything else is checked (`export-check.ts:204-211`). This is a pattern list: a credential in a shape it does not list is not caught.
- **Calculation version:** an export with no `calcVersion`, or one different from this build's `CALC_VERSION`, fails (`export-check.ts:213-219`).
- **Structure:** needs `manifest` (mode, promptVersion, questionId, scene), `labels`, a non-empty `comparisons`, `verdicts` and `totalSpend`; a missing piece is a problem (`export-check.ts:221-234`). `verdicts: null` is a problem: there is nothing to reproduce (`export-check.ts:232`).
- **Labels:** each comparison's records are re-labelled from the `labels` list; a label that differs from the records row is a problem (`export-check.ts:167-195`).
- **Verdicts:** for a compare run, each pair's verdict is recomputed with the chain `report()` uses (validate, `cohortMetrics`, `verdict` with `fileSeed`) and compared in full with the exported one; a missing or different verdict is a problem (`export-check.ts:236-263`).

Tools:

- `bun scripts/inspect-export.ts <file>` prints calcVersion, case and label counts, spend, each verdict (recomputed, exported, match or MISMATCH) and the problems; exit 0 when OK, 1 otherwise (`scripts/inspect-export.ts:13-26`).
- `bun scripts/d17-sample-export.ts` drives a real run with a fictional deterministic transport and sample keys, labels every answer, and writes `examples/d17-sample-export/export.json` (`scripts/d17-sample-export.ts:1-7`, `:14-18`, `:118-131`). No provider is called. `--check` exits 1 when the committed file differs from a fresh export (`scripts/d17-sample-export.ts:125-129`).
- `examples/d17-sample-export/export.json` is that sample: `version` `backstage/2`, `calcVersion` `verdict/1` (`examples/d17-sample-export/export.json:2-3`).

## 2. Where data lives while you use Backstage

### In the browser

- **Page memory (the run).** The run object holds the manifest, attempts, answers, labels and costs (`run.ts:745-766`). It is gone when the tab closes. Nothing writes it to `localStorage`; a grep for `localStorage` over `src` and `scripts` (non-test `.ts`) finds no use.
- **`sessionStorage` (the scene draft).** Key `backstage-scene-draft` (`scene-draft.ts:15`) holds only these text fields: question, choice names and definitions, acceptance, exclusions, keywords, cases (`scene-draft.ts:2-12`). The file states no key field is ever listed (`scene-draft.ts:1`). The page reads and writes it through `sessionStorage` only (`main.ts:1161-1166`). It is cleared by the clear action (`main.ts:930`, `main.ts:1158-1160`). Per-tab: it lasts until the tab closes. If storage fails, the page says a reload will lose the scene (`scene-draft.ts:42-43`).
- **Provider key fields.** Password-type inputs with autocomplete off (`main.ts:259-260`), read on demand into a plain object (`main.ts:205-210`). The key is not written to any storage. "Clear keys" blanks every field, drops the active keys and stops the run (`main.ts:902-907`).
- **Downloads.** `records.csv` and `backstage-evidence.json` are created as in-memory Blobs and saved by the browser (`main.ts:824-828`, `main.ts:998-1017`). Backstage keeps no copy.

### On the server (Backstage process)

- **Answer relay.** The page POSTs each request, including the user's key, to `/api/backstage/answer` (`run.ts:687-692`). The server forwards it to the provider (see section 3). Whether the server holds the request body beyond the call: Not determined from the code (the request handler, `server.ts:418` onward, was read only in part).
- **Logs.** One JSON line per event on stdout, for the journal: auth events (email, IP, request id), run events (`run.start`, `run.done`, `run.error` with provider and model only), API requests (route, method, status, token id), ticket events (ids and counts) (`log.ts:3-16`, `log.ts:26-61`). The API log type is documented as "Never a token, a key or a body" (`log.ts:12`).
- **Trial ledger (SQLite, only when `BACKSTAGE_TRIAL_KEY` is set).** Tables `settings`, `allowances`, `reservations`, `counters` (`trial.ts:121-124`; enabled at `server.ts:105`; path from `BACKSTAGE_TRIAL_LEDGER_PATH`, `server.ts:107`). Columns hold ids, a network bucket, state, amounts and days. There is no column for the question, input, key or answer. A reservation left pending at restart is marked `held-unknown` (`trial.ts:126-128`). The browser holds a trial cookie, `HttpOnly`, `SameSite=Strict`, path `/api/backstage/trial`, 90 days (`server.ts:510`, `trial.ts:46`).
- **Ticket office (SQLite).** Table `tickets`: id, time, kind, show, email, website, idea, consent flag, follow-up flag, request key, request hash (`tickets.ts:97-100`). Rows are written only with consent (`tickets.ts:7`). File mode 0600 (`tickets.ts:95`). Location: `BACKSTAGE_TICKETS_PATH`, else `tickets.sqlite` under `STATE_DIRECTORY` (`server.ts:736`). Retention: stated on the page, not in code (`tickets.ts:7` points to `docs/design/ticket-office.md`); Not determined from the code.
- **API tokens (JSON file).** For `/api/v1`. The file holds an id, label, creation time and the SHA-256 of each token, never the token (`api-tokens.ts:2-3`, `api-tokens.ts:22`, `api-tokens.ts:47-49`). Written with mode 0600 in a 0700 directory (`api-tokens.ts:138-153`). Path from `apiTokensPath` (`api-tokens.ts:32`, `server.ts:735`).
- **Sign-in (when enabled).** Operators file `operators.json`, path `BACKSTAGE_OPERATORS_PATH` or under `STATE_DIRECTORY` (`server.ts:739`). Revoked sessions file `revoked-sessions.json`, mode 0600 (`auth.ts:155`, `auth.ts:188`). Session cookie `HttpOnly`, `SameSite=Lax`, `Secure` on non-local origins (`auth.ts:143-146`), 43200 seconds (`server.ts:313`). Google sign-in cookie lasts 600 seconds (`server.ts:343`).
- **Runs, answers, labels, costs.** No server-side file or table for these was found in the files above; the only writes found are the ledger, tickets, tokens and revocation files listed here. A full grep of every server code path was not made, so treat this as: Not found in `trial.ts`, `tickets.ts`, `api-tokens.ts`, `auth.ts`, `log.ts`; not proven for the rest of `server.ts`.

## 3. What leaves the browser

Each answer call goes to the Backstage server (`run.ts:687`), which calls the provider with the user's own key (`providers.ts`):

| Provider | URL | Key sent as | Line |
|---|---|---|---|
| Jev (TypeSafe) | `https://api.typesafe.ai/v1/systemone` | `Authorization: Bearer` | `providers.ts:244-246` |
| Anthropic | `https://api.anthropic.com/v1/messages` | `x-api-key` | `providers.ts:263-267` |
| Google | `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` | Not read for this doc | `providers.ts:284` |
| OpenAI | `https://api.openai.com/v1/responses` | Not read for this doc | `providers.ts:306` |
| xAI | `https://api.x.ai/v1/responses` | Not read for this doc | `providers.ts:307` |

The case text, question and choice definitions go to each provider you select. Google sign-in calls `accounts.google.com` and `oauth2.googleapis.com` when enabled (`server.ts:334`, `server.ts:362-366`).

## 4. Keys

- **Your keys:** typed into the page, held in field values and in an in-page object, sent in the body of each answer request, used for that call. They are not written to `sessionStorage`, `localStorage`, a file or the ledger by any code listed above. They last until you clear them, reload, or close the tab.
- **Never in the export:** the export throws when a supplied key appears in the run (`run.ts:1616-1617`, set at `run.ts:1199-1210`).
- **Server-held keys (operator configuration, never shown to the browser):**
  - Trial funding key `BACKSTAGE_TRIAL_KEY`, from the environment (`server.ts:105-108`); the server inserts it into the request itself (`server.ts:529`).
  - Optional house Jev key for local testing, honoured only on a loopback origin and bind (`server.ts:44-45`, `server.ts:725`).
  - Google client secret and session secret, from the environment (`server.ts:738-741`).

## 5. What is NOT stored

- No provider key in the export, the scene draft, the ledger, the logs or the token file (sections 1, 2 and 4).
- No database or account for your runs: the run exists in page memory until you download it.
- The trial ledger has no column for questions, inputs, or answers (`trial.ts:121-124`).
- API tokens are stored only as hashes (`api-tokens.ts:47-49`).
- Not determined from the code: whether the answer relay keeps any request body in memory after the call returns; the retention period of ticket rows.
