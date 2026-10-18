# Guest questions

Governing issue: #253. Status: specified, not built. Base: `f825b71` (origin/main, 2026-10-18).

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
| Sessions | `src/backstage/auth.ts:57`; `docs/backstage-deploy.md:24` | `Operator` has email, displayName, password_hash; no role. `operators.json` holds testers | A signed-in session is not an admin. No web admin in the first PR. |
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

**Operator.** A CLI on the host lists the queue, shows one item, moves state with a version check, records a written response, deletes one item, and purges by retention cutoff.

## Contract

### Admin model

- The only admin surface in PRs 1 to 3 is `scripts/guest-intake/review.ts`, run on the host as the service user against the private state directory.
- The CLI refuses to start unless the state directory is mode 0700 and `tickets.sqlite` is mode 0600, both owned by the running user. It never widens or prints a path's contents beyond the requested row.
- A Backstage session, password or Google, is not an admin. `operators.json` holds testers (`docs/backstage-deploy.md:24`). PR 1 adds no queue route under `/api/backstage/` or `/backstage/`; a test asserts none exists.

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
- `questions` columns: id (`Q-` + 12 hex), created_at, scope, email (public only), question, reply_consent, marketing_consent, state, version, response, response_source, key_hash, request_hash. `UNIQUE(scope, key_hash)`.
- `question_tombstones` columns: scope, key_tag, deleted_at, reason (`operator` | `retention`). Primary key `(scope, key_tag)`. No id, email, question, response, timestamp of submission, or capability hash.

### Idempotency

- `scope` is set by the server and never read from the body: `public` for the form, `guest:<token id>` for a guest token. A token id never changes for the life of the token.
- `request_hash = sha256` of the canonical JSON `[scope, email, question, reply_consent, marketing_consent]`. Email is trimmed and lowercased; question is trimmed, NFC-normalized, with CRLF and CR turned into LF; consents are booleans with absent read as false.
- `key_hash = sha256(request_key)`. `key_tag = sha256("tombstone\0" + scope + "\0" + request_key)`, a different value, so a tombstone holds no capability verifier.
- Lookup order inside one `BEGIN IMMEDIATE` transaction: tombstone for `(scope, key_tag)`, then row for `(scope, key_hash)`, then quota, then insert.
  - Tombstone hit: 410 `deleted`, nothing written.
  - Same scope, same key, same `request_hash`: replay, the original id, status 200, quota not consumed.
  - Same scope, same key, other `request_hash`: 409 `request-key-reused`, nothing written.
  - Another scope with the same key: an unrelated namespace. No replay, no collision, no disclosure that the key exists elsewhere.
- Two concurrent requests with one key: both return the same id when the payload matches, or one 200 and one 409 when it differs. Exactly one row exists.

### Deletion and retention

- `review.ts delete <id>`: works in every state, `answered` and `declined` included. One transaction deletes the `questions` row and all its `question_events`, and inserts the tombstone. Any failure rolls back all three.
- `review.ts purge --before <ISO date> [--dry-run]`: the same transaction per row, for rows created before the cutoff. `--dry-run` prints ids and a count only.
- `review.ts purge --retention`: reads `GUEST_INTAKE_RETENTION_DAYS` from the service environment. Unset or not a positive integer: refuse, exit 1, nothing deleted. 30 days is proposed, not approved. No timer runs purge in PRs 1 to 3.
- After deletion: status with the old code is 404 `not-found`, the same answer as a code that never existed; a guest read is 404; a submit replay is 410; the row is absent from `list`, exports and backups taken afterwards.
- Tombstones are kept until a separate cutoff (`--tombstones-before`), proposed 180 days. After that cutoff a replay with the old key and payload stores a new row.

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

### Limits (proposed; exact values recorded in the PR)

| Counter | Counts | Limit |
|---|---|---|
| Attempts per address | every POST, any outcome | 5 per 10 min |
| New public rows | inserted rows only | 100 per 10 min |
| New guest rows | inserted rows per token | 10 per UTC day |
| Retained rows | all rows, every state | 5,000 |
| Tombstones | all tombstones | 20,000 |

- The attempt limiter is the existing `TicketLimiter` (`tickets.ts:164-183`): bounded at 10,000 addresses, refuses rather than evicts.
- Write quotas are checked after the replay lookup, so a replay never consumes or is refused by a write quota. Over a write quota or a cap: 503 `capacity`, nothing written.
- Request read timeout 5 s (existing `boundedText` use).

### Guest tokens (PR 2)

Separate store, never `api-tokens.json`. Prefix `jng_`, which fails the decide token pattern `^jnj_[A-Za-z0-9_-]{43}$` (`api-tokens.ts:15`), so even a rollback to a release without guest support cannot accept one on `ask` or `run`. Record: id, guest label, sha256, created, expires (default 14 days), revoked_at, last_used_at, fixed scopes `questions:submit` and `questions:read-own`. No edit, withdraw or delete scope. `scripts/guest-intake/token.ts mint|list|revoke` prints the token once, ids otherwise. Guest routes are dispatched before `createApiV1`. Revoking a token leaves its rows in place.

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
| GI-5c | Retained-row and tombstone caps refuse with 503 | `[unit] GI-5c` |
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
| GI-15a | Pending text absent from public GETs and `site/` | `[integration] GI-15a` |
| GI-15b | No queue route under Backstage; tester session gets none | `[integration] GI-15b` |
| GI-15c | No route takes or returns rows by email | `[integration] GI-15c` |
| GI-16 | Guest token: bad, expired, revoked 401; guests isolated | PR 2 |
| GI-17 | Guest token on decide routes 401, and the reverse | PR 2 |
| GI-18 | Real stdio MCP: three tools; same row as HTTP; origin fixed | PR 3 |

- GI-12 instruments `globalThis.fetch`, `Bun.spawn`, `Bun.spawnSync` and `node:child_process`; any request to a non-intake host or any model CLI spawn fails the test even when the call would succeed.
- `bun scripts/guest-intake/verify.ts --local` (PR 2 onward) starts the real server and adapter on temporary storage, runs GI-7a, GI-10c, GI-12 and GI-16 to GI-18, and prints each named check and a count before `GUEST_INTAKE_PASS`.

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

| PR | Story | Ships |
|---|---|---|
| 1 | Form, store, status, review CLI (GI-1 to GI-15) | Backstage, static, nginx |
| 2 | Guest tokens and HTTP (GI-16, GI-17), `verify.ts` | Backstage |
| 3 | Guest MCP adapter (GI-18), `docs/guest-access.md` | none (client side) |
| 4 | Optional TokenMax link, after #243 | static |
| 5 | `docs/design/guest-agent-boundary.md` | docs |

Each PR raises floors in `.deploy/tests/expected-counts.json`. Run output and screenshots stay outside the repo.

## Open operator decisions

Proposals until confirmed: retention cutoff (30 days), tombstone cutoff (180 days), token expiry and quota, who reviews and whether any reply time is stated (default: none), the selected guests and their private token handoff (blocks production minting only). The public page states no retention period until one is approved.
