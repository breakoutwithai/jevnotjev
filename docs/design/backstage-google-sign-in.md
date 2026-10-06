# Backstage sign-in page: password and Google, one session cookie

Refs #67 (Backstage), #76 (tester gate), #77 (Google sign-in), #96 and #97 (sign-out), #99 (fail2ban).

## Operator instructions this design answers

- "add connect with google" (2026-10-06): add a Google path.
- "create a proper login page not this shit popup" (2026-10-06): the browser Basic Auth dialog must never appear on Backstage.
- "why are you hand rolling - we should be applying compound engineering and building on what we know" (2026-10-06): port what already ships in production, write only the gaps.

#77 criterion G6 says the #76 Basic Auth gate is removed in the same change. That happens here, but in two stages (below), so this PR uses `Refs #77`, not `Closes`. #77 recommended oauth2-proxy; it is not used, see "Options".

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
| scrypt password hash `scrypt$<saltHex>$<hashHex>`, 64-byte key, `timingSafeEqual` | groit `apps/booth/server.js:1098-1121` (`verifyPasswordHash`), read at origin/main `bb29d8cc`, last change to the file `116cc6e1` | the format and the verify | an unknown email still runs one scrypt against a fixed dummy hash, so timing does not reveal whether the email exists (groit returns early at `:1128-1130`) |
| operators file (email, displayName, password_hash) | groit `server.js:1060-1094` (`readOperatorRows`), `:1124-1132` (`authenticateOperatorPassword`) | one JSON array; a row without `password_hash` is Google-only; removing a row revokes both paths | read from the service StateDirectory; no env allowlist and no bootstrap fallback |
| hash generator | groit `apps/booth/scripts/make-operator-password.mjs` (`ab3bd6d1`) | random three-word password, scrypt, prints the row once | TypeScript on Bun (`scripts/backstage-operator-password.ts`); refuses a password in argv (reads it from stdin or generates one) |
| session cookie `base64url(payload).sig`, HMAC-SHA256, 12 h TTL | groit `server.js:900` (`SESSION_TTL_MS`), `:1336-1355` (`signSession`, `verifySessionCookie`) | payload `{email, auth, iat, exp}` and the check | adds a random `sid` so sign-out can revoke server-side; the email must still be in the operators file at every check |
| login page: Google button plus password form | groit `server.js:1549` (`renderLoginPage`) | layout and copy shape | Backstage visual style; plain HTML form POST, no script |
| Google OAuth: start, state in a Map plus a cookie, code exchange, tokeninfo, profile checks | groit `server.js:1871-1904` (`/auth/google`), `:1906-1960` (callback), `:1720-1765` (`exchangeGoogleCodeForProfile`), `:1767-1774` (`validateGoogleProfile`), `:1685-1696` (state pruning and cap) | state 24 random bytes, single-use, 10-minute TTL, capped Map; `email_verified`, `aud`, `iss` and allowlist checks; scope `openid email profile`; `prompt=select_account` | the state compare is `timingSafeEqual`; the test-only fake exchange (`:1721-1731`, gated on `IS_TEST`) is NOT ported, tests inject `fetch`; the error body carries no exception detail |
| same-origin CSRF check | clearance-dealmarket-v1 `storefront/src/lib/admin-auth/csrf.ts` (`8a640f4`, origin/main `e2f7cefc`) | `Sec-Fetch-Site` first (`same-origin` or `none` pass), then `Origin` must equal ours, both absent passes | compares against `BACKSTAGE_ORIGIN`, never the request URL; plain `Request`, no Next.js types |
| `next` allowlist after sign-in | breakout-research-v3 `src/lib/auth/dashboard-access.ts:94-111` (`sanitizeDashboardNextPath`, origin/main `d40a5cc4`) | explicit allowlist, default on anything else | allows `/backstage/` and paths below it only; characters `[A-Za-z0-9/._-]`, no `//`, no `..` |
| redirect URI from a configured origin | breakout-research-v3 `src/lib/auth/dashboard-google.ts:104-111` (`getDashboardOrigin`) | the redirect URI is built from a configured origin | `BACKSTAGE_ORIGIN` is required; the `X-Forwarded-Host` fallback (`:66-76`) is not ported |
| test cases | groit `apps/booth/tests/functional/{password-login,login-redirect-no-oauth,operator-logout-reauth,session-auth-method}.test.js`; breakout-research-v3 `tests/auth/dashboard-auth.test.ts` | the case lists | bun:test, `[tier] <id>` titles |

Every ported function carries a header comment naming its source path and commit.

## Gaps written new (each with its own tests)

1. Login rate limit and lockout: per trusted client address and per email, in memory (a restart clears it; stated, not hidden).
2. Sign-out is `POST /api/auth/sign-out` with the CSRF check, replacing groit's `GET /auth/logout`. It clears the cookie and revokes the `sid` until its expiry. The #97 wrong-password request is removed; the visible control and the key clearing stay.
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

Choice: (a). The Bun service also enforces the same session on `/backstage/` and `/api/backstage/` once sign-in is configured, so a missing nginx gate fails closed and local dev (no nginx) exercises the same flow.

## Routes

| Path | Gate | Behaviour |
|---|---|---|
| `GET /backstage/sign-in` | none | the sign-in page; `?next=` sanitised; `?signed-out=1` shows "You are signed out"; `?error=<code>` shows one generic message |
| `POST /api/auth/password` | none, CSRF, rate limit | form fields `email`, `password`, `next`; or, for the deploy probe only, `Authorization: Basic` with no body. Success: 303 to `next` with the session cookie. Failure: 303 to `/backstage/sign-in?error=signin` (one message for unknown email, wrong password and no password row). Locked: 303 to `?error=locked` for every email, existing or not |
| `GET /api/auth/google` | none | 503 when Google is not configured; otherwise state into the Map and a `__Host-backstage_oauth` cookie, 302 to Google with `redirect_uri=${BACKSTAGE_ORIGIN}/api/auth/google/callback` |
| `GET /api/auth/google/callback` | none | state compared in constant time with the cookie and the Map entry, then deleted (single use), code exchanged, tokeninfo checked, profile checked against `aud`, `iss`, `email_verified` and the operators file; 303 to `next` with the session cookie, else 303 to `/backstage/sign-in?error=google` |
| `POST /api/auth/sign-out` | none, CSRF | revokes the `sid`, clears the cookie, 303 to `/backstage/sign-in?signed-out=1` |
| `GET /api/auth/session` | none | 204 when the session is valid, else 401 JSON. nginx's internal `auth_request` target |
| `/backstage/*`, `/api/backstage/*` | session | unauthenticated page: 302 to `/backstage/sign-in?next=<path>`; unauthenticated API: 401 JSON `{"code":"unauthenticated"}`. Never `WWW-Authenticate` |

Registered redirect URIs (operator, fixed): `https://jevnotjev.breakoutwithai.com/api/auth/google/callback`, `http://localhost:8787/api/auth/google/callback`, `http://127.0.0.1:8787/api/auth/google/callback`. Local dev serves on 8787 (`bun run backstage:dev`).

No access token is kept or forwarded (G4): the token response's `id_token` is checked once at Google's tokeninfo endpoint and discarded; the app never receives a Google token. Provider keys stay BYOK.

## Session check (every gated request)

Valid only when all hold: cookie present; HMAC matches (constant time); payload parses; `exp > now`; `sid` not revoked; email still in the operators file (re-read when the file's mtime changes). Anything else is 401. The secret is `BACKSTAGE_SESSION_SECRET`, at least 32 characters; shorter or absent disables sign-in, and every gated request is then refused (fail closed).

## Rate limit and lockout

- Per email: 5 failures in 15 minutes locks the email for 1 minute, doubling per further lockout to 1 hour.
- Per client address (only the trusted address from `X-Backstage-Client-IP` behind loopback, else the socket address): 20 failures in 15 minutes locks the address the same way.
- A locked request does not run scrypt and answers the same `locked` page whether or not the email exists.
- A success clears the email's counter.
- #99: nginx no longer checks passwords, so an nginx `nginx-http-auth` jail sees no Backstage failures and sign-out logs none. The app lockout replaces nginx-side counting. Whether the host runs such a jail is still unrecorded (#99 stays open until that host check).

## CSRF

- `POST /api/auth/password` and `POST /api/auth/sign-out` pass the ported same-origin check against `BACKSTAGE_ORIGIN`.
- The OAuth callback is bound to the start request by the state cookie plus the single-use Map entry (login CSRF).
- `SameSite=Lax` keeps the session cookie off cross-site POSTs.
- The deploy probe's Basic header on `POST /api/auth/password` has neither `Sec-Fetch-Site` nor `Origin`. A browser that still caches an old Basic login and is driven cross-site sends `Sec-Fetch-Site: cross-site` and is refused.

## nginx

```nginx
location = /backstage { return 308 /backstage/; }
location = /backstage/sign-in { proxy_pass http://127.0.0.1:3456; ... }      # ungated
location ^~ /api/auth/ { proxy_set_header X-Backstage-Client-IP $remote_addr; proxy_pass http://127.0.0.1:3456; ... }  # ungated
location = /_backstage_session {
    internal;
    proxy_pass http://127.0.0.1:3456/api/auth/session;
    proxy_pass_request_body off; proxy_set_header Content-Length "";
    proxy_intercept_errors on; error_page 403 404 500 502 503 504 =401 @backstage_deny;
}
location ^~ /backstage/     { auth_request /_backstage_session; error_page 401 = @backstage_sign_in; ... }
location ^~ /api/backstage/ { auth_request /_backstage_session; error_page 401 = @backstage_api_401; ... }
location @backstage_sign_in { return 302 /backstage/sign-in?next=$uri; }
location @backstage_api_401 { default_type application/json; return 401 '{"code":"unauthenticated"}'; }
```

The session check failing (service down, no release, 404 from an old release) is a 401, so the gate fails closed instead of answering 500. `$uri` drops the query; the Bun sanitiser rejects anything outside the allowlist.

`backstage_snippet_auth` gains a state: `yes` (both locations `auth_basic`, as today), `session` (both locations `auth_request /_backstage_session`, no `auth_basic` anywhere), `no`, `unknown` (any mix).

## Deploy contract

Probes: `backstage_curl`, when the gate is `session`, mints a session once per run by `POST /api/auth/password` with the existing `BACKSTAGE_CURL_CONFIG` (its `user = "email:password"` line becomes a Basic header), stores the cookie in a mode-0600 temporary jar removed at exit, and sends it on every later probe. The credential stays in the config file, never in argv or output. The curl config's `user` must be an operators-file email and password.

Verify S2 takes the expected gate from the caller (ship.sh already reads the installed snippet):

| Gate | Assertions |
|---|---|
| `yes` (Basic) | unchanged: anon 401 on both gated paths; authenticated 200 (502 without a release) |
| `session` | anon `/backstage/`: 302, `Location` ends `/backstage/sign-in?next=/backstage/`; anon `/api/backstage/health`: 401 with no `WWW-Authenticate`; anon `/backstage/sign-in`: 200 containing the sign-in form and no Backstage app markup; a tampered cookie: 302 and 401 again; minted session: 200 on both (502 without a release) |

Setup, for the session snippet, refuses before any change unless: the host nginx has `--with-http_auth_request_module` (`nginx -V`); the running release answers the session check on loopback (`http://127.0.0.1:3456/api/auth/session` returns 401 JSON, proving it is a sign-in-capable release with sign-in configured); `/etc/jevnotjev-backstage/auth.env` is root-owned mode 0600; the operators file `/var/lib/jevnotjev-backstage/operators.json` is a regular file owned by `jevnotjev-backstage`, mode 0600. After the reload it verifies the session row above and restores the previous snippet on any failure.

## Staged rollout (no window where neither gate applies)

1. Merge; deploy the release (gate `yes`, Basic still on). The new routes exist but sign-in is not configured, so the app does not yet enforce a session.
2. Operator writes `auth.env` and `operators.json` (steps below), installs the changed unit, restarts the service (EnvironmentFile is read only at start). From here the app enforces the session behind the still-present Basic gate: both gates apply.
3. Operator runs `ship.sh --setup --module backstage` (dry run first). Setup swaps the snippet to `session`, verifies, and restores on failure. Basic is gone; the session gate remains.

Between 2 and 3 a tester passes the Basic dialog and then the sign-in page. Run 3 right after 2.

## Operator steps (exact values)

1. Google Cloud OAuth client: already registered (origins `https://jevnotjev.breakoutwithai.com`, `http://localhost:8787`, `http://127.0.0.1:8787`; redirect URIs above). G5: confirm the consent screen is External, so non-Workspace Google accounts can sign in. UNVERIFIED here: whether an External screen in Testing limits users or session length.
2. Host secret file `/etc/jevnotjev-backstage/auth.env`, root-owned mode 0600, written in an interactive root session:
   - `BACKSTAGE_SESSION_SECRET=` 64 hex characters from `openssl rand -hex 32`; keep stable (rotation signs everyone out)
   - `BACKSTAGE_GOOGLE_CLIENT_ID=` and `BACKSTAGE_GOOGLE_CLIENT_SECRET=` from the Google client
   - `BACKSTAGE_TRUST_PROXY=loopback`, so the per-address limit sees the real client address
3. Operators file: on the workstation, `bun scripts/backstage-operator-password.ts <email>` per password tester (`doorman`'s email, `lutfiya`'s email), give each tester the printed password once, and assemble the rows into one JSON array; a Google-only tester is a row with `email` only. On the host: `install -o jevnotjev-backstage -g jevnotjev-backstage -m 0600 operators.json /var/lib/jevnotjev-backstage/operators.json`.
4. Update `BACKSTAGE_CURL_CONFIG` so its `user` line is one operators-file email and its new password.
5. Unit: `.deploy/backstage.service` gains `EnvironmentFile=-/etc/jevnotjev-backstage/auth.env`. Setup never overwrites a changed unit, so install it by hand: `install -m 0644 .deploy/backstage.service /etc/systemd/system/jevnotjev-backstage.service && systemctl daemon-reload && systemctl restart jevnotjev-backstage`.
6. `.deploy/ship.sh --setup --module backstage --dry-run`, then without `--dry-run`.
7. Afterwards the htpasswd is unused; deleting `/etc/jevnotjev-backstage/htpasswd` is optional and separate.

## Test plan (matrix first)

Session check x state:

| State | `/api/auth/session` | gated page | gated API |
|---|---|---|---|
| no cookie | 401 | 302 sign-in | 401 JSON, no WWW-Authenticate |
| valid | 204 | 200 | 200 |
| expired `exp` | 401 | 302 | 401 |
| bad signature / tampered payload / wrong secret | 401 | 302 | 401 |
| malformed (no dot, bad base64, bad JSON, bad `%` escape) | 401, no throw | 302 | 401 |
| `sid` revoked by sign-out | 401 | 302 | 401 |
| email removed from operators file | 401 | 302 | 401 |
| sign-in not configured (no or short secret) | 401 | 302 | 401 |

Password POST: success (303, cookie flags exact); wrong password; unknown email (same response, and scrypt still runs); row without hash; email case and whitespace; empty fields; `$apr1$` or bcrypt hash in the file (refused, not crashed); cross-site `Sec-Fetch-Site`; foreign `Origin`; no headers (allowed); 5 failures lock the email (6th refused even with the right password); lockout doubles; per-address lock across emails; success clears the counter; unknown-email lockout answers like a real one; Basic header mint (204-equivalent 303 plus cookie).

Google: not configured 503; start sets state Map entry and cookie, redirect URI built from `BACKSTAGE_ORIGIN` and never from Host or `X-Forwarded-Host`; callback with missing state, mismatched state, expired state, replayed state (second use refused), `error=` from Google; token exchange non-200; no `id_token`; tokeninfo non-200; `aud` mismatch; `iss` mismatch; `email_verified` false or `"false"`; email not in operators file; success sets the cookie and clears the state cookie; the state Map cap answers 429.

`next`: `/backstage/`, `/backstage/x/y` allowed; `//evil`, `/\evil`, `https://evil`, `/backstage/../x`, `/other`, encoded and control characters all go to `/backstage/`.

Sign-out: POST clears cookie, revokes `sid`, the old cookie then fails the session check; cross-site POST refused; GET refused. Client: the control clears keys and the in-page session, POSTs, then navigates to `/backstage/sign-in?signed-out=1`; no Basic request is ever sent.

Docker nginx (throwaway, repo snippet with only `proxy_pass` pointed at a local build): every row of the session S2 table, plus Basic never emitted on any gated path in any state, `/api/auth/*` reachable without a session, `/` and the static paths unchanged, the session service stopped gives 302/401 (not 500).

## Not proven here (UNVERIFIED until the operator's deploy)

- The real Google round trip (consent screen, tokeninfo responses for a real account) needs the registered client and a deploy.
- Host facts: the nginx `auth_request` module, systemd behaviour of the new unit line, the fail2ban jails (#99). Setup probes the first; the rest are operator checks.
- Browser behaviour beyond what the Docker nginx and the DOM tests show.
