# Backstage auth and run logging

Refs #105.

## Problem

After #104, `journalctl -u jevnotjev-backstage --since "-30 min"` returned `-- No entries --` on 2026-10-06 16:31Z, just after a sign-in. nginx showed only `POST /api/auth/password 303` for both success and failure. `.deploy/backstage-nginx.conf` sets `access_log off` on `/api/backstage/`.

## Reuse

| Source | Ported | Not ported |
|---|---|---|
| groit `apps/booth/lib/api/email-audit.js:71-100` at `bb29d8cc` | `appendSendAudit` uses a fixed object literal, `new Date().toISOString()`, and `JSON.stringify(entry) + "\n"`. The sink writes one JSON line and swallows write errors. | `redactSecrets` is a regex denylist, unnecessary without free-text fields. The file sink is replaced by journald. groit's auth routes in `apps/booth/server.js:1779-1950` log nothing, so auth-event logging is new in the estate. |
| clearance-dealmarket-v1 `backend/src/modules/buyers/lib/login-outcome.ts` at `e2f7cefc` | Closed `LoginOutcome` string-literal union for event names and reasons. | Other buyer login behavior. |
| clearance-dealmarket-v1 `backend/src/modules/buyers/lib/domain-events.ts` at `e2f7cefc` | Typed builders carry no raw email or secret. | Buyer domain event persistence. |
| clearance-dealmarket-v1 `backend/src/api/admin/buyers/__tests__/route.unit.spec.ts:1027` at `e2f7cefc` | `expect(JSON.stringify(logger.info.mock.calls)).not.toContain(token)` becomes an absence check across all captured stdout and stderr. | Its test harness. |
| breakout-research-v3 at `d40a5cc4` | Nothing. | There is no logger or auth audit under `src/lib/auth`, `src/app/auth/google`, or `src/middleware.ts`. |
| cpr-vnext `cpr_vnext/api.py:519-527` at `f49df6d4` | The `unknown` address fallback. | Its first `X-Forwarded-For` entry, then socket extraction. Backstage's `clientAddress` in `src/backstage/server.ts` already reads only `X-Backstage-Client-IP` set by nginx and trusted from a loopback socket. `record_audit_event` in `cpr_vnext/auth.py:177-198` persists free-form metadata to a DB and is not ported. |

None of these four repos has a request id. Backstage creates one with `crypto.randomUUID()` per request.

## Line contract

Auth line keys, in order: `ts`, `event`, `email`, `ip`, `rid`, then `reason` only for `signin.google.denied` and `session.rejected`. `email` is the normalised address only for a configured operator. Otherwise it is `unknown`, so a password typed into the email field is never recorded.

Run line keys, in order: `ts`, `event`, `rid`, `provider`, `model`. `model` is the catalog model id.

Reasons for `signin.google.denied`: `not-allowlisted | unverified-email | bad-state | provider-error | invalid-token`. Reasons for `session.rejected`: `expired | revoked | bad-signature`.

These lines use illustrative values:

```jsonl
{"ts":"2026-10-06T16:31:00.000Z","event":"signin.password.ok","email":"operator@example.com","ip":"203.0.113.7","rid":"7a7c74c0-130d-4fd7-b9b4-69a78a3811b0"}
{"ts":"2026-10-06T16:31:01.000Z","event":"signin.google.denied","email":"unknown","ip":"203.0.113.7","rid":"be4d8c63-4654-4e1c-9d8c-8527d00e5a1f","reason":"not-allowlisted"}
{"ts":"2026-10-06T16:32:00.000Z","event":"run.done","rid":"f1050461-7ac4-4e72-b771-cd062ea5b6c4","provider":"jev","model":"catalog-model-id"}
```

## Event matrix

| Path | Condition | Event |
|---|---|---|
| `POST /api/auth/password` | correct password | `signin.password.ok` |
| `POST /api/auth/password` | wrong password or unknown email | `signin.password.fail` |
| `POST /api/auth/password` | already locked | `signin.lockout` |
| `POST /api/auth/password` | failure trips the lock | `signin.password.fail`, `signin.lockout` |
| `GET /api/auth/google/callback` | bad state, provider error, invalid token, unverified email, or not allowlisted | `signin.google.denied` with the matching reason |
| `GET /api/auth/google/callback` | accepted operator | `signin.google.ok` |
| `POST /api/auth/sign-out` | with or without a session | `signout` |
| `GET /api/auth/session` or gated request | expired, revoked, or bad signature | `session.rejected` with the matching reason, at most once per request |
| Run endpoint | after validation, before dispatch | `run.start` |
| Run endpoint | completed run | `run.done` |
| Run endpoint | failed run after validation | `run.error` |
| Rejected request | 403, 405, or 415 | no event |

Never log passwords, session cookies, OAuth codes, state, nonce, tokens, the Google client secret, the session secret, provider API keys, the trial key, or question and case text. The fixed fields have no free-text slot. `src/backstage/log.test.ts` drives every path with marker values and asserts that none appears in captured stdout or stderr.

## nginx and retention

Add `proxy_set_header X-Backstage-Client-IP $remote_addr;` in `location = /_backstage_session`. The visitor cannot set the address on `session.rejected`. This takes effect on the host after `.deploy/backstage-setup.sh` updates the snippet; setup backs up and replaces a differing snippet.

The [deploy log instructions](../backstage-deploy.md#logs) cover journald retention and queries.
