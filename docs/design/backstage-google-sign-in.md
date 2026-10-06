# Backstage sign-in page: password and Google, one session cookie

Refs #67 (Backstage), #76 (tester gate), #77 (Google sign-in), #96 and #97 (sign-out), #99 (fail2ban).

## Operator instructions this design answers

- "add connect with google" (2026-10-06): add a Google path.
- "create a proper login page not this shit popup" (2026-10-06): the browser Basic Auth dialog must never appear on Backstage.
- "why are you hand rolling - we should be applying compound engineering and building on what we know" (2026-10-06): port what already ships in production, write only the gaps.

#77 criterion G6 says the #76 Basic Auth gate is removed in the same change. Here it is removed in staged steps (below), so this PR uses `Refs #77`, not `Closes`. #77 recommended oauth2-proxy; it is not used, see "Options".

## What exists today (main d73ed18)

- nginx gates `/backstage/` and `/api/backstage/` with `auth_basic` (`.deploy/backstage-nginx.conf:4-25`). Every 401 carries `WWW-Authenticate: Basic`, which opens the browser dialog.
- The deploy reads the installed snippet's gate with `backstage_snippet_auth` (`.deploy/backstage-lib.sh:93-139`) and needs `BACKSTAGE_CURL_CONFIG` (a mode-0600 curl config with `user = "login:password"`) for every authenticated probe (`backstage-lib.sh:73-79`, `:159-175`).
- Live verify S2 asserts anon 401 on `/backstage/` and `/api/backstage/health` (`.deploy/verify-lib.sh:10-13`, `:150-158`).
- Sign-out (#97) sends a wrong Basic password to `/api/backstage/sign-out` so the browser drops its cached login (`src/backstage/signout.ts:1-48`). Each sign-out logs one nginx auth failure (#99).
- The service runs as `jevnotjev-backstage` with `StateDirectory=jevnotjev-backstage` (mode 0700) and loads the optional root-owned `EnvironmentFile=-/etc/jevnotjev-backstage/trial.env` (`.deploy/backstage.service:8-14`). `/etc/jevnotjev-backstage/` is `root:www-data 0750`, so the service user cannot read the htpasswd there.
- The server already has a configured origin, `BACKSTAGE_ORIGIN`, written by the deploy as the public HTTPS origin (`.deploy/backstage-deploy.sh:82`, `src/backstage/server.ts:405`), and a trusted client address path (`X-Backstage-Client-IP` honoured only from a loopback socket with `BACKSTAGE_TRUST_PROXY=loopback`, `server.ts:217-224`).
- No file under `site/` uses `/api/`, so `/api/auth/` shadows no static path (`git grep -n "/api/" -- site` finds only `/api/backstage/`).

## Sources ported (reuse first)

| Piece | Source (repo, path, commit) | What is taken | What changes |
|---|---|---|---|
| scrypt password hash `scrypt$<saltHex>$<hashHex>`, 64-byte key, `timingSafeEqual` | groit `apps/booth/server.js:1098-1121` (`verifyPasswordHash`), read at origin/main `bb29d8cc`, last change to the file `116cc6e1` | the format and the verify | async scrypt; an unknown email still runs one scrypt against a fixed dummy hash, so timing does not reveal whether the email exists (groit returns early at `:1128-1130`) |
| operators file (email, displayName, password_hash) | groit `server.js:1060-1094` (`readOperatorRows`), `:1124-1132` (`authenticateOperatorPassword`) | one JSON array; a row without `password_hash` is Google-only; removing a row revokes both paths | read from the service StateDirectory; no env allowlist and no bootstrap fallback |
| hash generator | groit `apps/booth/scripts/make-operator-password.mjs` (`ab3bd6d1`) | random three-word password, scrypt, prints the row once | TypeScript on Bun (`scripts/backstage-operator-password.ts`); refuses a password in argv (reads it from stdin with `--stdin`, and then does not echo it) |
| session cookie `base64url(payload).sig`, HMAC-SHA256, 12 h TTL | groit `server.js:900` (`SESSION_TTL_MS`), `:1336-1355` (`signSession`, `verifySessionCookie`) | payload `{email, auth, iat, exp}` and the check | adds a random `sid` (sign-out revocation) and `cred`, a fingerprint of the operator row's credential, so changing a password ends that operator's sessions |
| login page: Google button plus password form | groit `server.js:1549` (`renderLoginPage`) | layout and copy shape | Backstage visual style; plain HTML form POST, no script |
| Google OAuth: start, code exchange, tokeninfo, profile checks | groit `server.js:1871-1904` (`/auth/google`), `:1906-1960` (callback), `:1720-1765` (`exchangeGoogleCodeForProfile`), `:1767-1774` (`validateGoogleProfile`) | `email_verified`, `aud`, `iss` and allowlist checks; scope `openid email profile`; `prompt=select_account`; tokeninfo verification | the state is a signed value bound to a cookie instead of groit's server-side Map (`:1685-1696`), so 1,000 anonymous GETs can no longer fill the Map and refuse every tester (review round 1); compares are `timingSafeEqual`; the test-only fake exchange (`:1721-1731`, gated on `IS_TEST`) is NOT ported, tests inject `fetch`; the error body carries no exception detail |
| same-origin CSRF check | clearance-dealmarket-v1 `storefront/src/lib/admin-auth/csrf.ts` (`8a640f4`, origin/main `e2f7cefc`) | `Sec-Fetch-Site` first (`same-origin` or `none` pass), then `Origin` must equal ours, both absent passes | compares against `BACKSTAGE_ORIGIN`, never the request URL; plain `Request`, no Next.js types |
| `next` allowlist after sign-in | breakout-research-v3 `src/lib/auth/dashboard-access.ts:94-111` (`sanitizeDashboardNextPath`, origin/main `d40a5cc4`) | explicit allowlist, default on anything else | allows `/backstage/` and paths below it only; characters `[A-Za-z0-9/._-]`, no `//`, no `..` |
| redirect URI from a configured origin | breakout-research-v3 `src/lib/auth/dashboard-google.ts:104-111` (`getDashboardOrigin`) | the redirect URI is built from a configured origin | `BACKSTAGE_ORIGIN` is required; the `X-Forwarded-Host` fallback (`:66-76`) is not ported |
| test cases | groit `apps/booth/tests/functional/{password-login,login-redirect-no-oauth,operator-logout-reauth,session-auth-method}.test.js`; breakout-research-v3 `tests/auth/dashboard-auth.test.ts` | the case lists | bun:test, `[tier] <id>` titles |

Every ported function carries a header comment naming its source path and commit.

## Gaps written new (each with its own tests)

1. Login rate limit and lockout (below), in memory: a restart clears it.
2. Sign-out is `POST /api/auth/sign-out` with the CSRF check, replacing groit's `GET /auth/logout`. It clears the cookie and revokes the `sid` until its expiry, persisted across restarts. The #97 wrong-password request is removed; the visible control and the key clearing stay. The page says "signed out" only when the server confirmed it.
3. Cookie flags: `__Host-backstage_session`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain` (host-only, G3). Only for an `http://localhost` or `http://127.0.0.1` origin (local dev) is the name `backstage_session` without `Secure`.
4. nginx `auth_request` gate and the deploy contract (below).
5. A non-browser session mint for the deploy probes (below).

## Options

| Option | Holds the criteria? | Cost |
|---|---|---|
| (a) nginx `auth_request` to a Bun session check, sign-in page and auth routes in the Bun service, ported from groit | yes | ported code plus the gaps above; no new process on the shared host |
| (b) oauth2-proxy (#77's recommendation) | Google yes; the password path no: oauth2-proxy's htpasswd support still needs its own form or Basic, and it adds a Go service, unit and secret on a host with nine vhosts | a second auth service to install, patch and monitor |
| (c) app-only checks, nginx proxies without a gate | yes in code, but a proxy misconfiguration exposes the page | no defence in depth |
| (d) keep `auth_basic` with `satisfy any` | no: every 401 from `auth_basic` carries `WWW-Authenticate: Basic`, which is the dialog the operator rejected | - |

Choice: (a). The Bun service also enforces the session itself when the request carries `X-Backstage-Gate: session` or `BACKSTAGE_REQUIRE_SESSION=1` is set. The session snippet sets that header with `proxy_set_header` in both gated locations, so nginx overwrites any visitor value; under the old Basic snippet a visitor who sends it only makes the app stricter for themselves. `bun run backstage:dev` sets the variable, and an operator may add it to `auth.env` after rollout step 3 so the app refuses even if nginx were misconfigured. With enforcement on and no usable secret, every gated request is refused. The switch follows the installed gate, not the presence of a secret, because during the staged rollout the old Basic snippet does not proxy `/api/auth/`, and an app that enforced then would lock everyone out (review round 1). It is not written by the deploy: `ship.sh` skips an already verified SHA, so a deploy-written switch would never reach the release that is live when setup swaps the gate (review round 2).

## Routes

| Path | Gate | Behaviour |
|---|---|---|
| `GET /backstage/sign-in` | none | the sign-in page; `?next=` sanitised; `?signed-out=1` shows "You are signed out"; `?error=<code>` shows one fixed message |
| `POST /api/auth/password` | none, CSRF, rate limit | form fields `email`, `password`, `next`; or, for the deploy probe only, `Authorization: Basic` with no body. Success: 303 to `next` with the session cookie. Failure: 303 to `/backstage/sign-in?error=signin` (one response for unknown email, wrong password and no password row). Locked: 303 to `?error=locked`, the same for every email, existing or not |
| `GET /api/auth/google` | none | 503 when Google is not configured; otherwise a signed state and a `__Host-backstage_oauth` cookie, 302 to Google with `redirect_uri=${BACKSTAGE_ORIGIN}/api/auth/google/callback` |
| `GET /api/auth/google/callback` | none | state signature, expiry and cookie binding checked (constant time), the oauth cookie cleared, code exchanged (Google codes are single use, so a replayed callback fails at the exchange), tokeninfo checked, profile checked against `aud`, `iss`, `email_verified` and the operators file; 303 to `next` with the session cookie, else 303 to `/backstage/sign-in?error=google` |
| `POST /api/auth/sign-out` | none, CSRF | revokes the `sid`, clears the cookie, 303 to `/backstage/sign-in?signed-out=1` |
| `GET /api/auth/session` | none | 204 when the session is valid, else 401 JSON `{"code":"unauthenticated","signIn":"ready"}` (or `"unconfigured"` without a usable secret). nginx's internal `auth_request` target; setup's loopback probe reads `signIn` |
| `/backstage/*`, `/api/backstage/*` | session | unauthenticated page: 302 to `/backstage/sign-in?next=<path>`; unauthenticated API: 401 JSON `{"code":"unauthenticated"}`. Never `WWW-Authenticate` |

The in-app gate decides on the decoded path. A request whose decoded path contains `\`, `//`, or a `.` or `..` segment is 404 before any routing, so `/%62ackstage/`, `//backstage/` and backslash forms cannot reach a static file without the gate (review round 1).

Registered redirect URIs (operator, fixed): `https://jevnotjev.breakoutwithai.com/api/auth/google/callback`, `http://localhost:8787/api/auth/google/callback`, `http://127.0.0.1:8787/api/auth/google/callback`. Local dev serves on 8787 (`bun run backstage:dev`).

No access token is kept or forwarded (G4): the token response's `id_token` is checked once at Google's tokeninfo endpoint and discarded; the app never receives a Google token. Provider keys stay BYOK. Google calls carry a 10-second timeout.

## Session check (every gated request)

Valid only when all hold: cookie present; HMAC matches (constant time); payload parses; `exp > now`; `sid` not revoked; email still in the operators file (re-read when the file's mtime changes); `cred` equals the fingerprint of that row's current credential (`password_hash`, or the literal `google` for a row without one). The secret is `BACKSTAGE_SESSION_SECRET`, at least 32 characters; shorter or absent means no session is ever valid.

Revoked sids are kept until their `exp` in `revoked-sessions.json` next to the operators file (the service StateDirectory), written atomically, pruned on write, and loaded at start, so a deploy restart does not revive a signed-out cookie. Without a writable directory (tests, dev) they stay in memory. A write failure fails the sign-out (500, and the page says sign-out failed) instead of reporting success. An existing file that cannot be read or parsed fails closed: every session issued before that start is refused and the failure is logged. The file holds at most 10,000 unexpired entries; a sign-out beyond that fails the same way (review round 2).

## Rate limit and lockout

- Per (email, client address): 5 failures in 15 minutes locks that pair for 1 minute, doubling per further lockout to 1 hour. The doubling level resets after 24 hours without a failure.
- Per client address: 20 failures in 15 minutes locks the address the same way.
- Per email across all addresses: 100 failures in 15 minutes locks the email for 1 minute, no doubling. This bounds distributed guessing without letting one remote client lock a tester (or the deploy probe's account) out for long.
- The client address is the trusted `X-Backstage-Client-IP` behind loopback with `BACKSTAGE_TRUST_PROXY=loopback`. Without a trusted address (unset proxy mode, loopback socket, or invalid header) the per-address and per-pair limits are skipped and only the per-email ceiling applies, so all testers never share one bucket.
- A locked request does not run scrypt and answers the same `locked` page whether or not the email exists. A success clears that pair.
- Records are pruned when idle past their window and lock; a record with a lock level is kept for its 24-hour decay. The maps are capped at 10,000; eviction drops only unlocked idle records, and when none can be dropped the attempt answers `?error=busy` without running scrypt, so a flood can neither grow memory nor evict a lock (review round 2).
- At most 8 scrypt verifications run at once; beyond that the attempt answers `?error=busy` without counting as a failure.
- Each lock is logged once to the service journal with the address and the first 8 hex of the SHA-256 of the email (never the email or password).
- #99: nginx no longer checks passwords, so an `nginx-http-auth` jail sees no Backstage failures and sign-out logs none. The app lockout replaces nginx-side counting. Whether the host runs such a jail is still unrecorded (#99 stays open until that host check).

## CSRF

- `POST /api/auth/password` and `POST /api/auth/sign-out` pass the ported same-origin check against `BACKSTAGE_ORIGIN`.
- The OAuth callback is bound to the start request by the signed state plus the matching oauth cookie (login CSRF).
- `SameSite=Lax` keeps the session cookie off cross-site POSTs.
- The deploy probe's Basic header on `POST /api/auth/password` has neither `Sec-Fetch-Site` nor `Origin`. A browser that still caches an old Basic login and is driven cross-site sends `Sec-Fetch-Site: cross-site` and is refused.

## nginx

```nginx
location = /backstage { return 308 /backstage/; }
location = /backstage/sign-in          { proxy_pass http://127.0.0.1:3456/backstage/sign-in; ... }          # ungated
location = /api/auth/password          { proxy_pass http://127.0.0.1:3456/api/auth/password; ... }          # ungated
location = /api/auth/sign-out          { proxy_pass http://127.0.0.1:3456/api/auth/sign-out; ... }          # ungated
location = /api/auth/google            { proxy_pass http://127.0.0.1:3456/api/auth/google; ... }            # ungated
location = /api/auth/google/callback   { proxy_pass http://127.0.0.1:3456/api/auth/google/callback; access_log off; ... }  # ungated
location = /_backstage_session {
    internal;
    proxy_pass http://127.0.0.1:3456/api/auth/session;
    proxy_pass_request_body off; proxy_set_header Content-Length "";
    proxy_intercept_errors on; error_page 403 404 500 502 503 504 =401 @backstage_deny;
}
location ^~ /backstage/     { auth_request /_backstage_session; error_page 401 = @backstage_sign_in; proxy_set_header X-Backstage-Gate session; proxy_set_header X-Backstage-Client-IP $remote_addr; ... }
location ^~ /api/backstage/ { auth_request /_backstage_session; error_page 401 = @backstage_api_401; proxy_set_header X-Backstage-Gate session; ... }
location @backstage_sign_in { absolute_redirect off; return 302 /backstage/sign-in?next=$request_uri; }
location @backstage_api_401 { default_type application/json; return 401 '{"code":"unauthenticated"}'; }
```

- The ungated routes are exact `=` locations whose `proxy_pass` carries the URI, so nginx forwards its own normalised path. A prefix `^~ /api/auth/` with a bare `proxy_pass` forwarded the raw target, and `/api/auth/..\..\/backstage/` reached Backstage with no session (review round 1, reproduced in Docker).
- The sign-in redirect uses `$request_uri`, which is never decoded. `$uri` is decoded, and `%0d%0a` in it injected a `Set-Cookie` header into the redirect (review round 1, reproduced in Docker). The Bun sanitiser then rejects anything outside the allowlist.
- The session check failing (service down, no release, 404 from an old release) is a 401, so the gate fails closed instead of answering 500.
- Every ungated location overwrites `X-Backstage-Client-IP` with `$remote_addr`, and so does the page location.

`backstage_snippet_auth` gains a state: `yes` (both locations `auth_basic`, as today), `session`, `no`, `unknown`. `session` is an allowlist, not a denylist (review round 2 found an `if (...) { return 204; }`, a `rewrite`, and an `error_page 401 =204` that a denylist passed): no nested block inside any recognised location; the internal location holds only `internal`, the one `proxy_pass http://127.0.0.1:3456/api/auth/session`, `proxy_set_header`, `proxy_pass_request_body off`, `proxy_connect_timeout`/`proxy_read_timeout`, `proxy_intercept_errors on` and the one `error_page 403 404 500 502 503 504 =401 @backstage_deny`; each gated location holds only directives from the shipped set and must carry `auth_request /_backstage_session` and `proxy_set_header X-Backstage-Gate session`; the three named locations must match their shipped statements exactly; no auth directive anywhere else. Anything else is `unknown`.

## Deploy contract

Probes: `backstage_curl`, when the gate is `session`, mints a session by `POST /api/auth/password` with the existing `BACKSTAGE_CURL_CONFIG` (its `user = "email:password"` line becomes a Basic header), stores the cookie in a mode-0600 temporary jar removed at exit, and sends it on later probes. The credential stays in the config file, never in argv or output. The curl config's `user` must be an operators-file email and password. The deploy mints lazily, after activation and inside the startup retries, so a stopped service or a broken release can still be replaced and a service that is still starting is not mistaken for a failed one. The closing verify mints only when a release is running; static-only verify never mints.

Releases built from this change carry `"gate": "session"` in `release.json`. When the installed snippet is the session gate, the deploy refuses, before activation, a promotion or rollback target without it (a pre-sign-in release answers 404 on the session check, which nginx turns into a refusal for everyone). The automatic fallback to the previous release applies the same check; a previous release without it takes the stop path instead (review round 2).

Verify S2 takes the expected gate from the caller (ship.sh already reads the installed snippet):

| Gate | Assertions |
|---|---|
| `yes` (Basic) | unchanged: anon 401 on both gated paths; authenticated 200 (502 without a release) |
| `session` | anon `/backstage/`: 302 with `Location` exactly `${HEALTH_URL}/backstage/sign-in?next=/backstage/` or `/backstage/sign-in?next=/backstage/`; anon `/api/backstage/health`: 401, JSON content type, body `{"code":"unauthenticated"}`, no `WWW-Authenticate`; anon `/backstage/sign-in`: 200 containing the sign-in form and no Backstage app markup; a garbage cookie and a well-formed cookie with a wrong signature: 302 and 401 again; minted session: 200 on both (502 without a release) |

Setup, for the session snippet, refuses before any change unless: the host nginx has `--with-http_auth_request_module` (`nginx -V`); `/etc/jevnotjev-backstage/auth.env` is root-owned mode 0600 and sets `BACKSTAGE_SESSION_SECRET` (32+ characters) and `BACKSTAGE_TRUST_PROXY=loopback` (checked by key and length only; no value is printed); the operators file `/var/lib/jevnotjev-backstage/operators.json` is a regular file owned by `jevnotjev-backstage`, mode 0600, non-empty. When the service has a running release, setup also requires it to answer the loopback session check with 401 and `"signIn":"ready"` (a sign-in-capable, configured release), so installing the gate cannot lock existing testers out. On a host with no running release (fresh install) that check is skipped: the gate installs fail closed, and the verify accepts 502 on the sign-in page and authenticated routes until the first deploy. After the reload it verifies the session row above and restores the previous snippet on any failure. The loopback probe has a 5-second timeout.

## Staged rollout (no window where neither gate applies, no lockout window)

1. Merge; deploy the release (gate `yes`, Basic still on). The release has the new routes; the Basic snippet sends no `X-Backstage-Gate`, so the app does not enforce a session and Basic users are unaffected.
2. Operator writes `auth.env` and `operators.json` (steps below), installs the changed unit and restarts the service (EnvironmentFile is read only at start). The session check now answers `"signIn":"ready"`; the app still does not enforce, Basic still gates.
3. Operator runs `ship.sh --setup --module backstage` (dry run first). Setup swaps the snippet to `session`, verifies, and restores on failure. Basic is gone; the nginx session gate applies.
4. The in-app gate is already on: the session snippet sends `X-Backstage-Gate: session`. Optional hardening: add `BACKSTAGE_REQUIRE_SESSION=1` to `auth.env` and restart, so the app also refuses requests that reach it without nginx.

Rollback of step 3 (setup's own restore, or by hand): the previous Basic snippet comes back, sends no `X-Backstage-Gate`, and the app stops enforcing, so testers use Basic again. If `BACKSTAGE_REQUIRE_SESSION=1` was added to `auth.env`, remove it and restart first.

## Operator steps (exact values)

1. Google Cloud OAuth client: already registered (origins `https://jevnotjev.breakoutwithai.com`, `http://localhost:8787`, `http://127.0.0.1:8787`; redirect URIs above). G5: confirm the consent screen is External, so non-Workspace Google accounts can sign in. UNVERIFIED here: whether an External screen in Testing limits users or session length.
2. Host secret file `/etc/jevnotjev-backstage/auth.env`, root-owned mode 0600, written in an interactive root session:
   - `BACKSTAGE_SESSION_SECRET=` 64 hex characters from `openssl rand -hex 32`; keep stable (rotation signs everyone out)
   - `BACKSTAGE_GOOGLE_CLIENT_ID=` and `BACKSTAGE_GOOGLE_CLIENT_SECRET=` from the Google client
   - `BACKSTAGE_TRUST_PROXY=loopback`, so the per-address limits see the real client address
3. Operators file: on the workstation, `bun scripts/backstage-operator-password.ts <email>` per password tester (`doorman`'s email, `lutfiya`'s email), give each tester the printed password once, and assemble the rows into one JSON array; a Google-only tester is a row with `email` only. On the host: `install -o jevnotjev-backstage -g jevnotjev-backstage -m 0600 operators.json /var/lib/jevnotjev-backstage/operators.json`.
4. Update `BACKSTAGE_CURL_CONFIG` so its `user` line is one operators-file email and its new password.
5. Unit: `.deploy/backstage.service` gains `EnvironmentFile=-/etc/jevnotjev-backstage/auth.env`. Setup never overwrites a changed unit, so install it by hand: `install -m 0644 .deploy/backstage.service /etc/systemd/system/jevnotjev-backstage.service && systemctl daemon-reload && systemctl restart jevnotjev-backstage`.
6. `.deploy/ship.sh --setup --module backstage --dry-run`, then without `--dry-run`.
7. Optional: add `BACKSTAGE_REQUIRE_SESSION=1` to `auth.env` and `systemctl restart jevnotjev-backstage` (rollout step 4).
8. Afterwards the htpasswd is unused; deleting `/etc/jevnotjev-backstage/htpasswd` is optional and separate.

## Test plan (matrix first)

Session check x state:

| State | `/api/auth/session` | gated page | gated API |
|---|---|---|---|
| no cookie | 401 | 302 sign-in | 401 JSON, no WWW-Authenticate |
| valid | 204 | 200 | 200 |
| expired `exp` | 401 | 302 | 401 |
| bad signature / tampered payload / wrong secret | 401 | 302 | 401 |
| malformed (no dot, bad base64, bad JSON, bad `%` escape) | 401, no throw | 302 | 401 |
| `sid` revoked by sign-out, also after a handler restart | 401 | 302 | 401 |
| email removed from operators file | 401 | 302 | 401 |
| operator's password_hash changed | 401 | 302 | 401 |
| no or short secret with `BACKSTAGE_REQUIRE_SESSION=1` | 401 `unconfigured` | 302 | 401 |
| neither `X-Backstage-Gate: session` nor `BACKSTAGE_REQUIRE_SESSION=1` | 401 | served (nginx gates) | served (nginx gates) |
| path case alias such as `/Backstage/` or `/API/backstage/` | - | 404 | 404 |
| path evasion: `/%62ackstage/`, `//backstage/`, backslash, `.`/`..` segments | - | 404 | 404 |

Password POST: success (303 to `next`, cookie flags exact, and the minted cookie then passes the session check and opens a gated page); wrong password; unknown email (same response, and scrypt still runs: a spy or timing-independent counter proves it); row without hash; email case and whitespace; empty fields; `$apr1$` or bcrypt hash in the file (refused, not crashed); cross-site `Sec-Fetch-Site`; foreign `Origin`; no headers (allowed); 5 failures lock the (email, address) pair and the REAL password of an existing account is then refused; another address can still sign in that account; lockout doubles and the level decays; per-address lock across emails; the 100-failure email ceiling; no trusted address skips the per-address limits; success clears the pair (a later 4 failures do not lock); unknown-email lock answers byte-identically to a real one; maps stay under their cap; more than 8 concurrent attempts answer `busy`; Basic header mint (303 to `/backstage/` plus a cookie that opens a gated page).

Google: not configured 503; start sets a signed state and the cookie; the redirect URI is `${BACKSTAGE_ORIGIN}/api/auth/google/callback` even when the request URL and Host are another origin; callback with no `state` parameter, mismatched cookie, tampered state, expired state, `error=` from Google; token exchange non-200; no `id_token`; tokeninfo non-200; `aud` mismatch; `iss` mismatch; `email_verified` false or `"false"`; email not in operators file; success sets a cookie that opens a gated page and clears the oauth cookie; a flood of starts stores nothing server-side.

`next`: `/backstage/`, `/backstage/x/y` allowed; `//evil`, `/\evil`, `https://evil`, `/backstage/../x`, `/other`, encoded and control characters all go to `/backstage/`.

Sign-out: POST clears cookie, revokes `sid`, the old cookie then fails the session check, also in a new handler on the same state directory; cross-site POST refused; GET refused. Client: the control clears keys and the in-page session, POSTs with a timeout, and navigates to `/backstage/sign-in?signed-out=1` only when the POST answered OK; on failure it says sign-out failed and re-enables the control; no Basic request is ever sent.

Docker nginx (`.deploy/tests/nginx-session-docker.sh`, manual: needs Docker, so it is not in the gate): every row of the session S2 table, Basic never emitted on any gated path in any state, the ungated routes reachable without a session, the backslash and encoded pivots refused, the `%0d%0a` redirect carries no injected header, `/` and the static paths unchanged, the session service stopped gives 302/401 (not 500).

## Review round 1 (fe43847), confirmed and fixed in this PR

Reproduced against the code or in the Docker nginx before fixing: the `/api/auth/` backslash pivot to Backstage with no session; `$uri` CRLF header injection; in-app gate on the encoded path; the app enforcing during rollout step 2 (lockout); setup unable to tell a configured release; per-email lockout of any tester and of the deploy probe; one shared limiter bucket without a trusted address; unbounded limiter maps; the Google state Map flood; sign-out revocation lost on restart; the page claiming "signed out" after a failed sign-out; the deploy refusing to replace a broken release; fresh-install circularity; rollback to a pre-sign-in release; a parser accepting `satisfy any` or a `return 204` session check; verify accepting a non-JSON 401; fixture curl accepting any jar; route tests that passed on failed sign-in.

## Review round 2 (866c237), confirmed and fixed in this PR

The snippet parser was still a denylist (nested `if`/`return`, `rewrite`, `error_page =204` passed): now an allowlist. Revocation persistence failed open on a write error or a corrupt file. The closing verify minted without a release, and the deploy minted before the restarted service listened. A deploy-written enforcement switch could never reach the live release (ship.sh skips a verified SHA): replaced by the nginx-set `X-Backstage-Gate` header. The forged-cookie probe expired in 1970 (seconds read as milliseconds), so it could not detect a missing signature check: it now flips the signature of a freshly minted cookie. Limiter pruning reset the lock level after 15 minutes and cap eviction could drop a locked record. Case aliases bypassed the in-app gate on a case-insensitive filesystem. The page redirect check did not reject `WWW-Authenticate`. The automatic fallback skipped the release gate check.

## Not proven here (UNVERIFIED until the operator's deploy)

- The real Google round trip (consent screen, tokeninfo responses for a real account) needs the registered client and a deploy.
- Host facts: the nginx `auth_request` module, systemd behaviour of the new unit line, the fail2ban jails (#99). Setup probes the first; the rest are operator checks.
- Browser behaviour beyond what the Docker nginx and the DOM tests show.
