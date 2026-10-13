# What Backstage stores, and where

Every statement cites the code it comes from, as `file:line` under `src/backstage/` unless a path says otherwise. Line numbers are from the tree this was written against.

## 1. The evidence export

`Run.evidence()` (`run.ts:1511`) builds the JSON the page downloads as `backstage-evidence.json` (`main.ts:1004-1020`). The browser builds it from the run held in page memory; no server call is made to produce it.

| Field | What it holds | Source |
|---|---|---|
| `version` | The protocol version, `backstage/2` | `run.ts:1519`, `contracts.ts:1` |
| `calcVersion` | The version of the verdict calculation, constant `CALC_VERSION` (`"verdict/1"`); it must change whenever the verdict or stats calculation changes | `run.ts:1520`, `contracts.ts:7` |
| `manifest` | Mode, arms, models, catalog version, revision, run id, prompt version, question id, creation time, and the scene (question, choices, definitions, cases) | `run.ts:96-107` |
| `funding` | `"trial"` or `"byok"`; never a key | `run.ts:1522` |
| `attempts` | One record per provider call: ids, requested and returned model, generation parameters, fingerprint, start and finish time, latency, tokens in and out, cost in USD, price version; on success the output and confidence, on failure the error code, message and charge state | `run.ts:1523`, `contracts.ts:69-105` |
| `labels` | Per answer: case id, arm, provider, output, label, label source, who set it and when, whether it was blind and final, whether a suggestion was shown | `run.ts:1524-1530`, `run.ts:1352-1363` |
| `suggestionAttempts` | The attempts made for label suggestions | `run.ts:1531` |
| `extraSpend`, `totalSpend` | Cost totals; failed attempts and suggestion calls are counted | `run.ts:1471`, `run.ts:1475`, `records.ts:117`, `records.ts:128` |
| `comparisons` | Per comparison: arm id, run id, file name, the CSV text, attempt ids | `run.ts:1377-1384`, `records.ts:91-104`, `run.ts:130-136` |
| `comparisonNote` | A fixed sentence: Jev observations are reused across cohorts, so do not sum their costs; verdicts are per pair and uncorrected for multiple comparisons | `run.ts:1535` |
| `verdicts` | Per-pair verdicts from `report()`, only when computed from exactly these records; otherwise `null` | `run.ts:1538` |
| `records` | The full records CSV, one row per answer, columns `EXPORT_COLUMNS` | `run.ts:1539`, `run.ts:27`, `records.ts:10` |

Guards on the export:

- It throws before reveal if any answer exists: "Reveal results (finish judging) before downloading evidence." (`run.ts:1513-1514`).
- It throws if the run is marked unsafe: "Export blocked: this run contains a provider key." (`run.ts:1515-1516`).
- A run becomes unsafe when any key the user supplied appears as a substring anywhere in the scene, attempts, suggestion attempts or answers (`run.ts:1187-1198`, matcher at `run.ts:145-153`). An unsafe run cannot start or continue (`run.ts:1183-1186`).
- A provider response that contains the request's key is rejected as "Unsafe response evidence." (`run.ts:609-610`, `run.ts:1118`, `run.ts:1281-1282`).

Limit of the key check: it matches the key values the user supplied in this session. It does not scan for credential patterns the user never entered.

### Verdicts and the calculation version

- `verdicts` is cached by `report()` (`run.ts:1498-1501`, field at `run.ts:766-769`) and exported only while the cached records equal the current records (`run.ts:1538`). It is `null` when `report()` was not run or the records changed since.
- The page's evidence download awaits `report()` before it calls `evidence()` (`main.ts:1013-1018`), so a download made right after reveal carries the verdicts. A `report()` that fails leaves `verdicts` `null`, the page shows "Verdict not ready; the download has no verdicts.", and the export then does not check ok.
- Every verdict is computed by one function, `cohortVerdict` in `run.ts` (validate, then `cohortMetrics`, then `verdict` with `fileSeed`; a pair with no answers is an empty cohort with no verdict). `report()` and the export checker both call it.
- `CALC_VERSION` is a hand-edited constant (`contracts.ts:2-7`). Nothing bumps it automatically. The only guard is the test "D17 committed sample equals a freshly generated export" in `export-check.test.ts`: it fails when a calculation change alters the sample's output, and not when a change leaves that output the same. A change that does not show in the sample still needs a manual bump.

### Reload and inspect

`checkExport(data)` and `checkExportText(json)` in `src/backstage/export-check.ts` take a parsed or raw export and return `ok`, counts, per-pair verdict checks and a list of problems. `ok` is true only when there are no problems. Neither throws.

What the check means. It is a reproducibility and no-credentials check, not an authenticity check. The export is unsigned, so anyone can rewrite it consistently, and the check cannot tell. `ok` means all of:

1. **No credentials.** `findCredentials` tests every string value and every object key against `CREDENTIAL_PATTERNS`, which match key shapes, not words. Each shape is a prefix and a body, and the body must hold both a letter and a digit:
   - `sk-ant-` then 32 or more of `A-Z a-z 0-9 _ -` (Anthropic);
   - `sk-proj-`, `sk-svcacct-` or `sk-admin-` then 32 or more of `A-Z a-z 0-9 _ -` (OpenAI project keys);
   - `sk-` then 32 or more letters and digits with no separator (OpenAI legacy keys);
   - `xai-` then 32 or more letters and digits (xAI);
   - `AIza` then exactly 35 of `A-Z a-z 0-9 _ -` (Google);
   - `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` then 30 or more letters and digits (GitHub);
   - `Bearer`, any letter case (RFC 7235), then a token of 20 or more characters with no space.

   A key in a shape not listed is not caught. That includes the Jev key and any `key = value` or `password: value` text: there is no pattern for either, because their words also appear in ordinary case text, which is exported verbatim. Ordinary prose such as "token: pending-approval-from-security-2026", "Bump api_version_2026_10_11" or "Bearer authentication broke" is not refused; the prose and key corpora in `export-check.test.ts` pin both sides. The dedicated key fields are never exported whatever their shape: `BackstageRun.evidence()` writes no key field, keys reach a run only through the `KeySource` read by `suppliedKeys()`, and `evidence()` refuses a run once `containsKey()` has found a supplied key value in its scene, attempts or answers. Checks report the JSON path and pattern name, never the matched text, and redact any object key that matched. Optional `knownKeys` are also searched for exact values. Any hit refuses the export before anything else is read.
2. **Same calculation.** `calcVersion` equals this build's `CALC_VERSION`. A missing or different value fails; the problem never quotes the value.
3. **Valid manifest and scene.** The manifest has mode, arms, models, run id, prompt version and question id, and the mode agrees with the arm count. The scene goes through `runScene`, the same validation the `BackstageRun` constructor runs (choice names, case ids and inputs, the rule's choices and keywords), for every export, with answers or without.
4. **Rebuilt, not trusted.** The checker rebuilds every comparison's records from the export's own manifest, attempts and labels with the functions `BackstageRun` exports with (`recordRow`, `comparisonPairs`, `inComparison`, `ruleOutput` in `records.ts`). Each label must belong to a scene case and a selected arm, carry the arm's provider and its successful attempt's output (or the keyword rule's answer), and every successful attempt must be labelled exactly once. The exported comparisons, combined `records` and attempt ids must equal the rebuild, and `totalSpend` and `extraSpend` must equal `totalSpend` and `extraSpend` over the attempts.
5. **Verdicts reproduce.** Each pair's verdict is recomputed from the rebuilt records with `cohortVerdict` and compared in full with the exported one. `verdicts: null` is a problem: there is nothing to reproduce.

Not checked: provider response metadata (returned model, request fingerprints, Jev probabilities, attempt-id uniqueness, which suggestion attempt belongs to which case), and whether the file came from a real run.

Problems name fields and positions (`labels[3]`, `comparisons[0]`), never a string read from the export.

Tools:

- `bun scripts/inspect-export.ts <file>` prints the line "Checks reproducibility and credentials; not proof the file came from a real run.", then calcVersion (the value only when it is this build's), case and label counts, spend, each verdict (recomputed, exported, match or MISMATCH) and the problems; exit 0 when OK, 1 otherwise.
- `bun scripts/d17-sample-export.ts` runs `sampleRun()`: a real `BackstageRun` with a fictional deterministic transport and sample keys, every answer labelled. `sampleExportText()` then awaits `report()` and returns `evidence()`; the script writes it to `examples/d17-sample-export/export.json`. No provider is called. `--check` exits 1 when the committed file differs from a fresh export.
- `examples/d17-sample-export/export.json` is that sample: `version` `backstage/2`, `calcVersion` `verdict/1` (`examples/d17-sample-export/export.json:2-3`).

## 2. Where data lives while you use Backstage

### In the browser

- **Page memory (the run).** The run object holds the manifest, attempts, answers, labels and costs (`run.ts:745-766`). It is gone when the tab closes. Nothing writes it to `localStorage`; a grep for `localStorage` over `src` and `scripts` (non-test `.ts`) finds no use.
- **`sessionStorage` (the scene draft).** Key `backstage-scene-draft` (`scene-draft.ts:15`) holds only these text fields: question, choice names and definitions, acceptance, exclusions, keywords, cases (`scene-draft.ts:2-12`). The file states no key field is ever listed (`scene-draft.ts:1`). The page reads and writes it through `sessionStorage` only (`main.ts:1162-1167`). Signing out calls `removeDraft()` (`main.ts:924-935`, `main.ts:1159-1161`); closing the tab removes its per-tab storage. If storage fails, the page says a reload will lose the scene (`scene-draft.ts:42-43`).
- **Provider key fields.** Password-type inputs with autocomplete off (`main.ts:259-260`), read on demand into a plain object (`main.ts:205-210`). The key is not written to any storage. "Clear keys" blanks every field, drops the active keys and stops the run (`main.ts:902-907`).
- **Downloads.** `records.csv` and `backstage-evidence.json` are created as in-memory Blobs and saved by the browser (`main.ts:824-828`, `main.ts:998-1020`). Backstage keeps no copy.

### On the server (Backstage process)

- **Answer relay.** The page POSTs each request, including the user's key, to `/api/backstage/answer` (`run.ts:687-692`). The server forwards it to the provider (see section 3). Whether the server holds the request body beyond the call: Not determined from the code (the request handler, `server.ts:418` onward, was read only in part).
- **Logs.** One JSON line per event on stdout, for the journal: auth events (email, IP, request id), run events (`run.start`, `run.done`, `run.error` with provider and model only), API requests (route, method, status, token id), ticket events (ids and counts) (`log.ts:3-16`, `log.ts:21-58`). The API log type is documented as "Never a token, a key or a body" (`log.ts:12`).
- **Trial ledger (SQLite, only when `BACKSTAGE_TRIAL_KEY` is set).** Tables `settings`, `allowances`, `reservations`, `counters` (`trial.ts:121-124`; enabled at `server.ts:105`; path from `BACKSTAGE_TRIAL_LEDGER_PATH`, `server.ts:107`). Columns hold ids, a network value that is an HMAC of the full client IP (`trial.ts:243`), state, amounts and days. There is no column for the question, input, key or answer. A reservation left pending at restart is marked `held-unknown` (`trial.ts:126-128`). The browser holds a trial cookie, `HttpOnly`, `SameSite=Strict`, path `/api/backstage/trial`, 90 days (`server.ts:510`, `trial.ts:46`).
- **Ticket office (SQLite).** Table `tickets`: id, time, kind, show, email, website, idea, consent flag, follow-up flag, request key, request hash (`tickets.ts:97-100`). Rows are written only with consent (`tickets.ts:7`). File mode 0600 (`tickets.ts:95`). Location: `BACKSTAGE_TICKETS_PATH`, else `tickets.sqlite` under `STATE_DIRECTORY` (`server.ts:736`). Retention: stated on the page, not in code (`tickets.ts:7` points to `docs/design/ticket-office.md`); Not determined from the code.
- **API tokens (JSON file).** For `/api/v1`. The file holds an id, label, creation time and the SHA-256 of each token, never the token (`api-tokens.ts:2-3`, `api-tokens.ts:22`, `api-tokens.ts:47-49`). Written with mode 0600 in a 0700 directory (`api-tokens.ts:138-153`). Path from `apiTokensPath` (`api-tokens.ts:32`, `server.ts:735`).
- **Sign-in (when enabled).** Operators file `operators.json`, path `BACKSTAGE_OPERATORS_PATH` or under `STATE_DIRECTORY` (`server.ts:739`). Revoked sessions file `revoked-sessions.json`, mode 0600 (`auth.ts:155`, `auth.ts:188`). Session cookie `HttpOnly`, `SameSite=Lax`, `Secure` on non-local origins (`auth.ts:143-146`), 43200 seconds (`server.ts:313`). Google sign-in cookie lasts 600 seconds (`server.ts:343`).
- **Runs, answers, labels, costs.** No server-side file or table for these was found in the files above; the only writes found are the ledger, tickets, tokens and revocation files listed here. A full grep of every server code path was not made, so treat this as: Not found in `trial.ts`, `tickets.ts`, `api-tokens.ts`, `auth.ts`, `log.ts`; not proven for the rest of `server.ts`.

## 3. What leaves the browser

Each answer call goes to the Backstage server (`run.ts:687`), which calls the provider with the user's own key (`providers.ts`):

| Provider | URL | Key sent as | Line |
|---|---|---|---|
| Jev (TypeSafe) | `https://api.typesafe.ai/v1/systemone` | `Authorization: Bearer` | `providers.ts:284-287` |
| Anthropic | `https://api.anthropic.com/v1/messages` | `x-api-key` | `providers.ts:303-309` |
| Google | `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` | `x-goog-api-key` | `providers.ts:324-327` |
| OpenAI | `https://api.openai.com/v1/responses` | `Authorization: Bearer` | `providers.ts:345-350` |
| xAI | `https://api.x.ai/v1/responses` | `Authorization: Bearer` | `providers.ts:345-350` |
| Question coach (Anthropic or OpenAI) | `https://api.anthropic.com/v1/messages` or `https://api.openai.com/v1/responses` | `x-api-key` or `Authorization: Bearer`, using the tester's coach key | `main.ts:1293-1308`, `server.ts:463-480`, `providers.ts:22-36` |

The case text, question and choice definitions go to each answer provider you select. The question coach sends only the typed question and coach key through the Backstage server to the chosen coach provider; it sends no other scene fields. The call uses the tester's key, so any charge goes to the tester's account. The server does not write the coach question, key or reply to its files or databases (`main.ts:1308`, `server.ts:463-480`, `providers.ts:22-36`, `log.ts:8-16`, `log.ts:58-61`). Google sign-in calls `accounts.google.com` and `oauth2.googleapis.com` when enabled (`server.ts:337`, `server.ts:362-369`).

## 4. Keys

- **Your keys:** typed into the page, held in field values and in an in-page object, sent in the body of each answer request, used for that call. They are not written to `sessionStorage`, `localStorage`, a file or the ledger by any code listed above. They last until you clear them, reload, or close the tab.
- **Never in the export:** the export throws when a supplied key appears in the run (`run.ts:1515-1516`, set at `run.ts:1187-1198`).
- **Server-held keys (operator configuration, never shown to the browser):**
  - Trial funding key `BACKSTAGE_TRIAL_KEY`, from the environment (`server.ts:105-108`); the server inserts it into the request itself (`server.ts:529`).
  - Optional house Jev key for local testing, honoured only on a loopback origin and bind (`server.ts:44-45`, `server.ts:725`).
  - Google client secret and session secret, from the environment (`server.ts:738-741`).

## 5. What is NOT stored

- No provider key from the dedicated key fields in the export, the ledger, the logs or the token file (sections 1, 2 and 4). The export refuses a run whose text contains a supplied key (`run.ts:1515-1516`).
- The scene draft is the exception: the dedicated key fields are never stored, but scene text is stored verbatim per tab. `saveSceneDraft()` writes whatever the nine text fields hold to `sessionStorage` (`scene-draft.ts:57-70`), on each edit (`main.ts:1152-1157`), before any run starts and so before the key guard at `run.ts:1187-1198` can see it. A key pasted into a scene text field by mistake is therefore kept in that tab's `sessionStorage` until sign-out removes the draft (`main.ts:924-935`, `main.ts:1159-1161`) or the tab closes.
- No database or account for your runs: the run exists in page memory until you download it.
- The trial ledger has no column for questions, inputs, or answers (`trial.ts:121-124`).
- API tokens are stored only as hashes (`api-tokens.ts:47-49`).
- Not determined from the code: whether the answer relay keeps any request body in memory after the call returns. The ticket form states a plan to delete rows by hand 90 days after the event ends (`site/index.html:229`), with no automatic deletion in the code.
