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

**Selected guest.** The operator mints one token for a named person. The guest submits and reads their own questions over HTTP or through the guest MCP adapter. Same queue, guest identity set by the server.

**Operator.** A CLI on the host lists the queue, shows one item, moves state with a version check, and records a written response.

## Contract

### State model

`pending_review -> needs_info | approved | declined`, `needs_info -> pending_review`, `approved -> answered`, any non-terminal `-> withdrawn`. Each transition appends an event: actor, at, from, to, response version. `answered` needs a response with `source` of `human_reviewed` or `template`. No transition sends mail, publishes, or calls a provider.

### Storage

`src/guest-intake/store.ts`, tables `questions` and `question_events` in the existing `tickets.sqlite` (one lead file, one deletion surface). Opened with `CREATE TABLE IF NOT EXISTS`; an older release ignores the tables, so rollback leaves tickets intact. Columns: id (`Q-` + 12 hex), created_at, source (`public` | `guest:<token id>`), email (public only), question, reply_consent, marketing_consent, state, version, response, response_source, key_hash UNIQUE, request_hash.

### HTTP

| Route | Auth | Body cap |
|---|---|---|
| `POST /api/questions` | same-origin, none | 16 KiB |
| `POST /api/questions/status` | status code in body | 1 KiB |
| `POST /api/v1/guest/questions` | guest bearer | 16 KiB |
| `GET /api/v1/guest/questions` | guest bearer | none |
| `GET /api/v1/guest/questions/<id>` | guest bearer, own only | none |

- Public submit body: `email`, `question` (1 to 4,096 characters), `reply_consent: true`, optional `marketing_consent`, `request_key` (43 base64url characters, client-generated), honeypot `nickname`. Unknown keys are rejected.
- The status code is `<id>.<request_key>`; the server stores only `sha256(request_key)`. A retry with the same key and details returns the same id; the same key with different details is 409. Same rule as `maps.ts`.
- The code travels in a POST body, never a URL, so it reaches no access log or referrer.
- Errors are a `code` only. Logs record `question.received` / `question.rejected` with id and reason, never email or text.

### Limits (proposed; exact values recorded in the PR)

- Per address: 5 new questions per 10 minutes, the existing `TicketLimiter`.
- Global: 100 new public questions per 10 minutes, and 503 once 5,000 rows are `pending_review`.
- Per guest token: 10 new questions per UTC day.
- Request read timeout 5 s (existing `boundedText` use).

### Guest tokens (PR 2)

Separate store, never `api-tokens.json`. Prefix `jng_`, which fails the decide token pattern `^jnj_[A-Za-z0-9_-]{43}$` (`api-tokens.ts:15`), so even a rollback to a release without guest support cannot accept one on `ask` or `run`. Record: id, guest label, sha256, created, expires (default 14 days), revoked_at, last_used_at, fixed scopes `questions:submit` and `questions:read-own`. `scripts/guest-intake/token.ts mint|list|revoke` prints the token once, ids otherwise. Guest routes are dispatched before `createApiV1`.

### Guest MCP adapter (PR 3)

`src/guest-intake/mcp.ts`, server name `jevnotjev-guest`, tools `submit_question`, `get_my_question`, `list_my_questions`. Reads `JNJ_GUEST_TOKEN` from env. Origin fixed to `https://jevnotjev.breakoutwithai.com`; an override is accepted only for `http://127.0.0.1:<port>` (tests). `fetch` uses `redirect: "error"`. Imports nothing from `src/decide/` or `src/backstage/providers.ts`.

## Acceptance

| Id | Criterion | Test |
|---|---|---|
| GI-1 | Valid public submit stores one row and returns id and status code | `[integration] GI-1` |
| GI-2 | Bad email, empty or oversize question, missing consent, unknown key: 400 with code, nothing stored | `[unit] GI-2` |
| GI-3 | Honeypot answers ok and stores nothing | `[unit] GI-3` |
| GI-4 | Same key and details replays; same key, other details is 409 | `[unit] GI-4` |
| GI-5 | Per-address and global limits refuse; limiter memory stays bounded | `[unit] GI-5` |
| GI-6 | Store failure is 503 and the page keeps the draft | `[integration] GI-6`, DOM test |
| GI-7 | Row, state and response survive a store reopen | `[integration] GI-7` |
| GI-8 | Status shows state and response, never question or email; a wrong code is 404 | `[integration] GI-8` |
| GI-9 | Transitions outside the model are refused; a stale version is refused | `[unit] GI-9` |
| GI-10 | Withdrawn rows never return to the queue or an export | `[unit] GI-10` |
| GI-11 | Script or prompt text in a question is stored and shown as text | `[unit] GI-11` |
| GI-12 | With fake `JEV_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` set, every new path makes 0 outbound requests | `[integration] GI-12` (fetch recorder) |
| GI-13 | `src/guest-intake/` imports nothing from `src/decide/` or `providers.ts` | `[unit] GI-13` |
| GI-14 | Logs hold no email, question or status code | `[unit] GI-14` |
| GI-15 | Pending text is absent from every public GET route and `site/` | `[integration] GI-15` |
| GI-16 | Guest token: missing, malformed, expired, revoked each 401; two guests cannot list or fetch each other's rows | PR 2 |
| GI-17 | A guest token on every `/api/v1` decide route is 401; a decide token on guest routes is 401 | PR 2 |
| GI-18 | A real stdio MCP connection lists exactly three tools and reads the same row as HTTP | PR 3 |

`bun scripts/guest-intake/verify.ts --local` (PR 2 onward) starts the real server and adapter on temporary storage, runs GI-7, GI-12 and GI-16 to GI-18, and prints each named check and a count before `GUEST_INTAKE_PASS`.

## Delivery

| PR | Story | Ships |
|---|---|---|
| 1 | Public form, store, status, review CLI (GI-1 to GI-15) | Backstage, static, nginx snippet |
| 2 | Guest tokens and guest HTTP (GI-16, GI-17), `verify.ts` | Backstage |
| 3 | Guest MCP adapter (GI-18), `docs/guest-access.md` | none (client side) |
| 4 | Optional TokenMax link from the receipt page, after #243 | static |
| 5 | `docs/design/guest-agent-boundary.md` | docs |

Each PR raises floors in `.deploy/tests/expected-counts.json`. Run output and screenshots stay outside the repo.

## Open operator decisions

Defaults above are proposals until confirmed: token expiry and quota, 30-day retention for pending and private rows, who reviews and whether any reply time is stated (default: none), the selected guests and their private token handoff (blocks production minting only).
