# Guest questions

Governing issue: #253. Status: public intake, review CLI, guest tokens, guest HTTP routes, token CLI and guest MCP adapter built on one integration branch (#256) and verified locally; not deployed, no guest token issued. A web admin page and API for operators whose `operators.json` row has `"admin": true` (#278) sits beside the CLI. Spec approved at sha256 `f8e446b7`; base `f825b71` (origin/main, 2026-10-18).

A visitor brings one decision question, gets a receipt, and later reads a person-reviewed response. No account, no provider key, no Jev run. Selected guests do the same from Claude Code or Codex with a scoped token. TokenMax usage sharing is a separate optional journey owned by #242 / #243.

## What exists today (source and consumer map)

| Surface | Source | What it does now | Consumer impact |
|---|---|---|---|
| Lead store | `src/backstage/tickets.ts:97-100` | `tickets` table in SQLite; `kind` CHECK is `show` or `backstage`; idea capped at 280 (`:35`) | A question cannot be a ticket kind without a table rebuild. New tables go beside it. |
| Ticket route | `src/backstage/server.ts:696-728` | `POST /api/tickets`: same-origin, JSON, 4 KB cap, honeypot, per-address limit, request key | Pattern reused; route untouched. |
| Limiter | `src/backstage/tickets.ts:164-183` | 5 per 10 min per address, 10,000 tracked addresses, refuses rather than evicts | Reused per address; no global cap exists (`docs/design/ticket-office.md` Known limits). |
| Client address | `src/backstage/server.ts:144-149` | `X-Backstage-Client-IP` trusted only from loopback with `BACKSTAGE_TRUST_PROXY=loopback` | Reused; no new header trust. |
| Capability pattern | `src/backstage/maps.ts:245-247`, `server.ts:767` | Map rows keep `key_hash`; delete link is `<id>.<request_key>` | Same pattern for the question status capability. |
| Decide API tokens | `src/backstage/api-tokens.ts:15,21-26` | `jnj_` + 43 chars; id, label, sha256, created; no scope, expiry or revocation | Guest tokens must not live here: any valid entry can call `ask` and `run` (`api-v1.ts:198-209`). |
| `/api/v1` routing | `src/backstage/server.ts:682-688`; `.deploy/backstage-nginx.conf:88-99` | nginx forwards all of `^~ /api/v1/` raw, no access log, 64k cap | Guest HTTP routes under `/api/v1/guest/` need no nginx change and leave no access-log line. |
| Decide MCP | `src/mcp/server.ts:1-12,52` | Local stdio, six tools, reads provider keys from process env, can call providers | Not reused for guests. A separate adapter registers only question tools. |
| Sessions | `src/backstage/auth.ts:57`; `docs/backstage-deploy.md:24` | `Operator` has email, displayName, password_hash and, since #278, an optional `admin` set only by the boolean true. `operators.json` holds testers | A signed-in session is not an admin unless its row has `"admin": true`. |
| Public nginx routes | `.deploy/backstage-nginx.conf:43-69` | Exact `location =` per public API route | `/api/questions` needs two new locations: a snippet change, so `.deploy/ship.sh --setup --module backstage` before deploy (`docs/process/pipeline.md:53`). |
| Map receiver | `src/backstage/maps.ts:235-297` | Every stored map is on the public board | No private TokenMax storage exists; S4 builds one or defers private upload. |
| Backstage build | `scripts/backstage-build.ts:8` | Bundles `src/backstage/server.ts` and its imports | New `src/guest-intake/` modules ship inside the Backstage release. |
| Static site | `.deploy/deploy.sh:5-14` | nginx serves `site/` from `/var/www/jevnotjev` | `site/ask/` ships with the static module. |
| Deploy gate | `.deploy/backstage-deploy.sh:38-41` | Requires HEAD == origin/main and a merged PR for HEAD | Unchanged. |
| Postgres migrations | `db/migrations/` | Frozen pending #46 | Not touched: all new state is Backstage SQLite. |

Live, read-only on 2026-10-18: static `/DEPLOYED_SHA` serves `3418769`; `GET /api/tickets` 405, `GET /api/v1/arms` 401 with no token, `GET /api/maps` 200. The served Backstage version needs a session and was not read.

## Journeys

**Public.** `/ask/` has one textarea ("What decision are you trying to make?"), an email field, an unticked service-reply consent, an unticked optional marketing box, and a disclosure: a person reviews it, no Jev run happens, do not send credentials or private client data. Submit returns a reference and a private status code, shown once with a copy button. `/ask/#status` takes the code and shows state and, when answered, the response. It never shows the question or email back.

**Selected guest.** The operator mints one token for a named person. The guest submits and reads their own questions over HTTP or through the guest MCP adapter. Same queue, guest identity set by the server. Guests cannot edit, withdraw or delete; there is no guest edit scope.

**Operator.** A CLI on the host lists the queue, shows one item, moves state with a version check, records a written response, deletes one item, and purges by retention cutoff. An admin operator can also list, read, move state and answer from `/backstage/questions/` (#278); delete and purge stay CLI-only.

## Contract

### Admin model

- Two admin surfaces share one store: the operator CLI `src/guest-intake/admin-cli.ts` (PRs 1 to 3) and, from #278, the web admin `src/guest-intake/admin-routes.ts` with its page `admin-page.ts`. Both ship inside the existing Backstage bundle and call the same `QuestionStore` methods (`list`, `show`, `transition`, `answer`), so they see one state and one version (AQ-9).
- **Delivery path:** the release package admits only `server.js`, `release.json` and `site/` (`.deploy/backstage-package.ts:32-46`), so a separate script would be refused as "Unexpected release file." `server.ts` imports the CLI, and its `import.meta.main` block (`server.ts:805`) checks `process.argv` for `--question-admin` first. When present it runs the CLI and exits before `createHandler` or `Bun.serve`: no port, no trial ledger, no provider key read. The package allowlist and `scripts/backstage-build.ts:8` entrypoints are unchanged.
- **Host use:** `sudo -u jevnotjev-backstage env STATE_DIRECTORY=/var/lib/jevnotjev-backstage /usr/local/bin/bun /var/www/jevnotjev-backstage-current/server.js --question-admin <command>`. The service user owns the state directory (`.deploy/backstage.service:9-12`, `StateDirectoryMode=0700`). The tickets path resolves as the server does (`server.ts:829`).
- Commands: `list`, `show <id>`, `transition <id> <to> --version <n>`, `answer <id> --version <n> --source human_reviewed|template --file <path>`, `delete <id>`, `purge`. `token mint|list|revoke|rotate` use the same dispatch (#256).
- The CLI refuses to start unless the state directory is mode 0700 and `tickets.sqlite` is mode 0600, both owned by the running user. It prints only the requested row.
- **Bundled-mode tests (off-host):** GI-14c builds the release with `scripts/backstage-build.ts`, runs the built `server.js --question-admin` against temporary state, and asserts the command works and no port is bound. The existing `backstage-package.test.ts` still passes with the allowlist unchanged.
- A Backstage session, password or Google, is not an admin by itself. `operators.json` holds testers (`docs/backstage-deploy.md:24`). Only a row with `"admin": true` (the JSON boolean; `"true"` or `1` do not count) opens the admin routes. The row is re-read per request, so adding or removing the flag needs no restart.
- **Web admin (#278):** page `GET /backstage/questions/` (list, newest first) and `GET /backstage/questions/?id=<id>` (one question with its form); API `GET /api/backstage/questions` (id, state, version, scope, created and updated time; no email or text), `GET /api/backstage/questions/<id>` (adds email, text, consents and reply) and `POST /api/backstage/questions/<id>/reply` with `{version, to, text?, source?}`. A stale version is 409 `stale-version` and a forbidden move 409 `bad-transition`, the reasons the CLI prints.
- **Web admin access:** the handlers check the session and the flag themselves, with or without nginx's gate header. No session: 401 `{"code":"unauthenticated"}` on every route (behind nginx an anonymous page request is redirected to sign-in first). A session without the flag: 403 `{"code":"forbidden"}`, no question data. POST requires a same-origin request. The page escapes every stored value and runs only its own inline script, pinned by hash in its CSP. Logs carry event, request id, question id and reason only. Delete, purge and guest tokens stay CLI-only.

### Contact and response rules

- The email is unverified. It authorizes no mail, no identity recovery, no lookup by email and no disclosure of any row to anyone holding the address. No route takes an email as a query.
- A response is generic guidance built only from the submitted question text. It names no other person, row, guest or account, and makes no claim of a Jev run, accuracy or savings.
- Replies are read through the status code or the guest token only.

### State model

- Transitions: `pending_review -> needs_info | approved | declined`; `approved -> answered`; `needs_info -> pending_review`.
- `needs_info -> pending_review` is operator-only, recorded after the operator has received the information independently (a new submission, or a channel outside this system). The submitter cannot trigger it.
- Each transition appends an event: actor, at, from, to, response version. Events hold no question, email or response text.
- `answered` needs a response with `source` of `human_reviewed` or `template`.
- No transition sends mail, publishes, or calls a provider.
- Deletion is not a state. It removes the row (next section).

### Storage

- `src/guest-intake/store.ts` adds three tables to the existing `tickets.sqlite`: `questions`, `question_events`, `question_tombstones`. All created with `CREATE TABLE IF NOT EXISTS`. The `tickets` table, its DDL and its rows are not altered.
- An older release opens the same file with its unchanged `TicketStore` (`tickets.ts:93-101`) and ignores the new tables. GI-7b tests this.
- `questions` columns: id (`Q-` + 12 hex), created_at, scope, email (public only), question, reply_consent, marketing_consent, state, version, response, response_source, key_hash, key_tag, request_hash. `UNIQUE(scope, key_hash)`. The raw request key is never stored.
- `question_tombstones` columns: scope, key_tag, deleted_at, reason (`operator` | `retention`). Primary key `(scope, key_tag)`. No id, email, question, response, timestamp of submission, or key hash.
- Tombstones are kept indefinitely. There is no tombstone expiry or compaction in PRs 1 to 3; compaction waits for an approved anti-replay design.

### Idempotency

- `scope` is set by the server and never read from the body: `public` for the form, `guest:<token id>` for a guest token. A token id never changes for the life of the token.
- `request_hash = sha256` of the canonical JSON `[scope, email, question, reply_consent, marketing_consent]`. Email is trimmed and lowercased; question is trimmed, NFC-normalized, with CRLF and CR turned into LF; consents are booleans with absent read as false.
- `key_hash = sha256(request_key)`. `key_tag = sha256("tombstone\0" + scope + "\0" + request_key)`, a different value. Both are computed at submit and stored on the live row; deletion copies the row's `key_tag` into the tombstone, so delete never needs the raw key and the tombstone holds no capability verifier.
- Lookup order inside one `BEGIN IMMEDIATE` transaction: tombstone for `(scope, key_tag)`, then row for `(scope, key_hash)`, then quota, then insert.
  - Tombstone hit: 410 `deleted`, nothing written.
  - Same scope, same key, same `request_hash`: replay, the original id, status 200, quota not consumed.
  - Same scope, same key, other `request_hash`: 409 `request-key-reused`, nothing written.
  - Another scope with the same key: an unrelated namespace. No replay, no collision, no disclosure that the key exists elsewhere.
- Two concurrent requests with one key: both return the same id when the payload matches, or one 200 and one 409 when it differs. Exactly one row exists.

### Deletion and retention

- `--question-admin delete <id>`: works in every state, `answered` and `declined` included. One transaction reads the row's `scope` and `key_tag`, inserts the tombstone, and deletes the `questions` row and all its `question_events`. Any failure rolls back all three.
- `--question-admin purge --before <ISO date> [--dry-run]`: the same transaction per row, for rows created before the cutoff. `--dry-run` prints ids and a count only.
- `--question-admin purge --retention`: reads `retentionDays` from `intake-policy.json` in the state directory (service-user owned, mode 0600, written by the operator once a period is approved). Missing file, wrong mode, or a value that is not a positive integer: refuse, exit 1, nothing deleted. 30 days is proposed, not approved. No timer runs purge in PRs 1 to 3.
- After deletion: status with the old code is 404 `not-found`, the same answer as a code that never existed; a guest read is 404; a submit replay is 410, for as long as the file exists; the row is absent from live queries (`list`, `show`, status and guest reads) and from logical exports taken afterwards.
- Deletion is logical, not physical erasure. SQLite does not overwrite freed pages by default, the WAL can hold the old page until a checkpoint, and raw copies of `tickets.sqlite` and backups made before (or as raw file copies after) a delete can still contain the row. Those copies need their own retention; no erasure from them is claimed.

### HTTP

| Route | Auth | Body cap |
|---|---|---|
| `POST /api/questions` | same-origin, none | 16 KiB |
| `POST /api/questions/status` | status code in body | 1 KiB |
| `POST /api/v1/guest/questions` | guest bearer | 16 KiB |
| `GET /api/v1/guest/questions` | guest bearer | none |
| `GET /api/v1/guest/questions/<id>` | guest bearer, own only | none |

- Public submit body: `email`, `question` (1 to 4,096 characters), `reply_consent: true`, optional `marketing_consent`, `request_key` (43 base64url characters, client-generated), honeypot `nickname`. Unknown keys are rejected.
- The status code is `<id>.<request_key>`; the server stores only `sha256(request_key)`. Same pattern as `maps.ts:245-247`.
- The code travels in a POST body, never a URL, so it reaches no access log or referrer.
- Errors are a `code` only. Logs record `question.received` / `question.rejected` / `question.deleted` with id and reason, never email, text or code.

### Guest HTTP schema (PR 2)

- **Principal:** the verified token id, set by the server. `scope = guest:<token id>`; the body cannot name a scope, guest, email or id.
- **Submit body** (strict, unknown keys 400): `question` (same rules as public), `reply_consent: true`, optional `marketing_consent`, `request_key` (43 base64url characters, chosen by the client or the MCP adapter). No `email` field: a body carrying one is 400.
- **Idempotency:** the same rules as public, with `email` null in `request_hash`. A guest key never replays a public row or another guest's row.
- **Submit response:** `{ id, state, replay }`. No status code is issued; the token is the read credential.
- **List response:** `{ questions: [{ id, state, created_at, updated_at }] }`, own rows only, newest first, at most 50.
- **Read response:** `{ id, state, updated_at, response, response_source }`, with `response` null until answered. Another guest's id, a public id or a deleted id is 404.
- No route returns question text, email or events to a guest. There is no edit, withdraw or delete route.

Public capability boundary: POST /api/questions/status selects only scope = public. Guest rows always return 404 even when the caller constructs the correct guest id.request_key; test this before and after guest token revocation and expiry. All guest reads require their live guest credential.

### Limits (proposed; exact values recorded in the PR)

| Counter | Counts | Limit |
|---|---|---|
| Attempts per address | every POST, any outcome | 5 per 10 min |
| New public rows | inserted rows only | 100 per 10 min |
| New guest rows | inserted rows per token | 10 per UTC day |
| Retained rows plus tombstones | every state, all tombstones | 25,000 |

- The attempt limiter is the existing `TicketLimiter` (`tickets.ts:164-183`): bounded at 10,000 addresses, refuses rather than evicts.
- Write quotas and the cap are checked after the replay lookup, so a replay never consumes or is refused by them. Over a quota or the cap: 503 `capacity`, nothing written.
- The cap is checked only at admission. Delete and purge turn one row into one tombstone, so they never raise the total and are never refused. At the cap the store fails closed: new submissions stop until the operator approves a compaction design or a higher cap.
- Request read timeout 5 s (existing `boundedText` use).

### Guest tokens (PR 2)

Separate store, never `api-tokens.json`. Prefix `jng_`, which fails the decide token pattern `^jnj_[A-Za-z0-9_-]{43}$` (`api-tokens.ts:15`), so even a rollback to a release without guest support cannot accept one on `ask` or `run`. Record: id, guest label, sha256, created, expires (default 14 days), revoked_at, last_used_at, fixed scopes `questions:submit` and `questions:read-own`. No edit, withdraw or delete scope. `server.js --question-admin token mint|list|revoke|rotate` prints the token once (mint and rotate), ids otherwise. Guest routes are dispatched before `createApiV1`. Revoking a token leaves its rows in place.

### Guest MCP adapter (PR 3)

- `src/guest-intake/mcp.ts`, server name `jevnotjev-guest`, tools `submit_question`, `get_my_question`, `list_my_questions`. Reads `JNJ_GUEST_TOKEN` from env.
- The production entrypoint has one origin, the constant `https://jevnotjev.breakoutwithai.com`, and reads no origin or URL from env, arguments or config.
- Tests pass a loopback origin and a fetch function to `createGuestMcp({ origin, fetch })` by injection. That parameter is not reachable from the CLI entrypoint.
- Every request goes to that origin's `/api/v1/guest/` paths only, with `redirect: "error"`. Any other destination throws before sending.
- Imports nothing from `src/decide/` or `src/backstage/providers.ts`.

### Provider boundary

A provider request is a request to a Jev, OpenAI, Anthropic or other model API host, or a spawned model CLI (`claude`, `codex`). GI-12 asserts zero of either. Requests to the intake origin itself are expected and allowed; GI-12 does not mean zero network.

## Acceptance

PR 1 covers GI-1 to GI-15.

| Id | Criterion | Test |
|---|---|---|
| GI-1 | Valid public submit stores one row; returns id and code | `[integration] GI-1` |
| GI-2 | Bad field or unknown key: 400, nothing stored | `[unit] GI-2` |
| GI-3 | Honeypot answers ok, stores nothing | `[unit] GI-3` |
| GI-4a | Same scope, key, payload: same id, quota untouched | `[unit] GI-4a` |
| GI-4b | Same scope and key, other payload or consent: 409 | `[unit] GI-4b` |
| GI-4c | Same key in another scope: no replay, no collision | `[unit] GI-4c` |
| GI-4d | Concurrent same-key retries leave exactly one row | `[integration] GI-4d` |
| GI-5a | Attempt limiter refuses; memory bounded | `[unit] GI-5a` |
| GI-5b | Write quota counts new rows only | `[unit] GI-5b` |
| GI-5c | Row-plus-tombstone cap refuses admission; delete still works | `[unit] GI-5c` |
| GI-6 | Store failure is 503; page keeps the draft | `[integration] GI-6`, DOM |
| GI-7a | Row, state, response survive a store reopen | `[integration] GI-7a` |
| GI-7b | `TicketStore` reopens the file; tickets DDL and rows unchanged | `[integration] GI-7b` |
| GI-8 | Status hides question and email; bad code 404 | `[integration] GI-8` |
| GI-9a | Out-of-model transition or stale version refused | `[unit] GI-9a` |
| GI-9b | `needs_info -> pending_review` only by operator CLI | `[unit] GI-9b` |
| GI-10a | Delete in any state removes row, events, key hash | `[unit] GI-10a` |
| GI-10b | Delete failure rolls back all three writes | `[unit] GI-10b` |
| GI-10c | After delete: status 404, replay 410, not in list | `[integration] GI-10c` |
| GI-10d | Retention purge refuses without configured cutoff | `[unit] GI-10d` |
| GI-11 | Script or prompt text stays inert text | `[unit] GI-11` |
| GI-12 | Fake keys set: 0 provider requests, 0 model spawns | `[integration] GI-12` |
| GI-13 | `src/guest-intake/` imports no decide or provider code | `[unit] GI-13` |
| GI-14a | Logs hold no email, question or code | `[unit] GI-14a` |
| GI-14b | CLI refuses wider than 0700 dir or 0600 file | `[unit] GI-14b` |
| GI-14c | Built `server.js --question-admin` runs; binds no port | `[integration] GI-14c` |
| GI-15a | Pending text absent from public GETs and `site/` | `[integration] GI-15a` |
| GI-15b | No queue route under Backstage; tester session gets none | `[integration] GI-15b` |
| GI-15c | No route takes or returns rows by email | `[integration] GI-15c` |
| GI-16 | Guest token: bad, expired, revoked 401; guests isolated | PR 2 |
| GI-17 | Guest token on decide routes 401, and the reverse | PR 2 |
| GI-18 | Real stdio MCP: three tools; same row as HTTP; origin fixed | PR 3 |

- GI-12 instruments `globalThis.fetch`, `Bun.spawn`, `Bun.spawnSync` and `node:child_process`; any request to a non-intake host or any model CLI spawn fails the test even when the call would succeed.
- GI-10a also asserts the tombstone's `key_tag` equals the deleted row's stored `key_tag`, and that no column anywhere holds the raw request key.
- `bun scripts/guest-intake/verify.ts --local` is an off-host check of the built release: the built `server.js` on temporary storage, the built `--question-admin` CLI, and the guest MCP adapter as a stdio subprocess driven by the MCP SDK client. It covers GI-7a, GI-8, GI-10c, GI-12, GI-16, GI-17 and GI-18 in 33 named checks and prints a count before `GUEST_INTAKE_PASS`.

## Verification protocol

The full gate runs on the reviewed commit, unchanged, in a disposable Git store, never in a shared worktree:

```
D="$(mktemp -d)"
git clone --no-hardlinks --quiet <repo or bundle> "$D/repo"
git -C "$D/repo" checkout --quiet --detach <reviewed sha>
test "$(git -C "$D/repo" rev-parse HEAD)" = "<reviewed sha>"
cd "$D/repo" && bun install
env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR bun scripts/gate.ts
```

`.deploy/tests/*.test.sh` fixtures are not edited to make the gate pass; #240 owns their isolation.

## Delivery

The pieces were built on separate branches and ship as one user story, so no library ships unused:

| Part | Issue | Ships |
|---|---|---|
| Spec, form, store, status, review CLI (GI-1 to GI-15) | #253 | Backstage, static, nginx |
| `GuestTokenStore` | #255 | Backstage |
| Guest MCP adapter (GI-18), `docs/guest-access.md` | #254 | none (client side) |
| Guest HTTP routes, token CLI, needs_info templates, `verify.ts`, optional usage prompt, `docs/design/guest-agent-boundary.md` | #256 | Backstage, static |

One integration branch carries all four, with floors raised in `.deploy/tests/expected-counts.json`. Run output and screenshots stay outside the repo. #253 stays open for rollout and outside-user acceptance.

## PR 1 contract deltas

Differences from the approved text above, made while building PR 1:

- **needs_info message:** `transition <id> needs_info` requires a message file. The public status returns it as `response` with its `response_source`, so the submitter can see what to send. It is cleared on `needs_info -> pending_review`. `declined` and `approved` carry no message.
- **Status attempts:** the status route has its own per-address attempt limiter, the same 5 per 10 minutes, separate from submit.
- **Body cap edge:** a 4,096-character question written entirely in 4-byte characters exceeds the 16 KiB body cap and is refused as `too-large`.
- **Where limits live:** `QUESTION_LIMITS` in `src/guest-intake/contract.ts` holds the proposed defaults. Tests override them through `ServerOptions.questions`; production has no env override yet.
- **Actor:** events record `operator:cli`.
- **Shipping order:** this change edits `.deploy/backstage-nginx.conf`, so the host's installed snippet no longer has the same sha256 and `.deploy/ship.sh` reads it as `stale` (`ship.sh:252-258`). `preconditions_hold` (`ship.sh:724-735`) then refuses the deploy before any module runs; its only exception is a legacy Basic-auth host moving to the session snippet, which does not apply here. Order: `.deploy/ship.sh --setup --module backstage --dry-run`, review it, `.deploy/ship.sh --setup --module backstage`, then the deploy. The classifier in `.deploy/backstage-lib.sh` accepting the snippet with or without the two question locations lets setup install it; it does not let a deploy skip setup.
- **Public copy:** `/ask/` and the privacy page state that no retention period has been set and that replies are not emailed. The homepage ticket office links to `/ask/`.
- **Deletion contact (#256):** `/ask/` (form and receipt) and the privacy page's question paragraph send deletion requests to jev@breakoutwithai.com, quoting the reference only, never the status code; the operator deletes by hand with the CLI. The ticket office keeps its GitHub-issue route.

## Integration deltas (#256)

- **Id shapes:** a guest scope is `guest:gtk_` + 12 lowercase hex (the `GuestTokenStore` id). Question ids are `Q-` + 12 uppercase hex everywhere, the MCP adapter included.
- **Guest status codes:** unsafe token state or a verify throw is 503 `auth-unavailable`; a bad, expired, revoked or rotated-away token is 401 `unauthenticated` with `WWW-Authenticate: Bearer realm="jevnotjev-guest"`; no tickets store is 503 `questions-unavailable`. Wrong method is 405 with `Allow`.
- **Re-check before write:** the token is verified when the request arrives and again after the body is read, immediately before the insert. A revoke or rotation in between stores nothing.
- **Guest attempts:** guest POSTs share the per-address attempt limiter (5 per 10 minutes), counted before the token is checked. Guest GETs have no attempt limiter.
- **Token store opening:** opened on the first guest request, so an unsafe state directory makes the guest routes 503 rather than stopping the server.
- **needs_info templates:** `transition <id> needs_info --version <n> --template choices|example|outcome|one-decision` stores a fixed note with source `template` (`NEEDS_INFO_TEMPLATES` in `contract.ts`).
- **Public retry:** after a 409 `request-key-reused` the `/ask/` page starts a fresh attempt, so sending again works.

## Optional TokenMax usage (S4)

- `/ask/` has an optional section, separate from the question, with one copyable prompt that wraps the existing `site/tm/map.ts`: the user picks the Claude Code and Codex log folders (or none) and the period, the assistant shows the first lines of the script, runs it with `--claude`, `--codex`, `--days` or `--from`/`--to` and `--out`, explains `share-draft.md` without cost or savings estimates, and stops. A test checks every flag in the prompt against the real `parseArgs`.
- Deferred to #242: private TokenMax storage. Every map the current receiver stores is on the public board (`src/backstage/maps.ts`), and PR #243's hosted preview has no nginx route and no durable private receiver. The page says private sending is not available and that `/maps/` is a separate public step the user takes.
- No Jev option appears in this journey.

## Open operator decisions

Proposals until confirmed: retention cutoff (30 days), every limit and the 25,000 cap, token expiry and quota, who reviews and whether any reply time is stated (default: none), the selected guests and their private token handoff (blocks production minting only). The public page states no retention period until one is approved.

## Gate database isolation

Every full gate run needs its own temporary PostgreSQL cluster and unique socket directory, with JNJ_TEST_ADMIN_DSN explicitly set and pg_isready checked before the gate. Do not depend on the shared default /tmp socket on port 5432, and do not restart or stop another project's server. Existing DB tests create and drop their own jnj_test database inside that owned cluster. Stop only the owned temporary cluster after validation. Keep original failure output; no tests are skipped. This prerequisite follows the observed missing-default-socket failures during this delivery.

## Low-friction deletion contact

The new question journey must not require a GitHub account to request deletion. Reuse the existing private service contact, jev@breakoutwithai.com (docs/uat/tester-handoff.md), for a request quoting the reference only; never invite public posting of question text, email or a status code. Operator verification and deletion remain manual through the private CLI. Apply this to the ask page and its question-specific privacy wording; do not rewrite unrelated historical ticket behavior.
