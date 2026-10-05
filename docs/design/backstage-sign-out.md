# Backstage sign-out (#96)

Status: implemented in the PR that closes #96. Basic Auth stays the tester gate; sign-out is added on top of it with no change to `.deploy/backstage-nginx.conf`.

## Current login mechanism

- nginx Basic Auth, realm `Backstage`, gates both locations: the page at `.deploy/backstage-nginx.conf:4-7` and the API at `.deploy/backstage-nginx.conf:12-14`, reading `/etc/jevnotjev-backstage/htpasswd`.
- The deploy contract requires both, and the gate is the MVP's only tester boundary (`docs/backstage-deploy.md:9`, `docs/backstage-deploy.md:57`). Setup and every deploy verify assert an unauthenticated 401 on `/backstage/` and `/api/backstage/health` (`.deploy/verify-lib.sh:11`).
- The deploy reads the installed snippet's auth state with `backstage_snippet_auth` (`.deploy/backstage-lib.sh:93-139`): auth directives anywhere but the two locations make the state `unknown`, and the deploy refuses.
- The snippet may not carry `add_header`, which would drop the server block's inherited security headers (`.deploy/backstage-package.test.ts:120-124`, test B67).
- The page header holds only the home link and the House Lights theme toggle (`site/backstage/index.html:16-17`, `id="theme"`, handler `src/backstage/main.ts:792`).
- Clear keys (`src/backstage/main.ts:680`) empties `activeKeys`, aborts a starting run, stops the run and blanks every `<provider>-key` field. `clearScene` (`src/backstage/main.ts:716`) drops the run and resets the rooms. A `beforeunload` guard (`src/backstage/main.ts:851`) asks before leaving while a run exists.

## Options from #96

Measured in Chrome 154.0.8037.98 against nginx 1.27.5, responses `Cache-Control: no-store` as production sends them (`src/backstage/server.ts:63`). A first batch run without `no-store` was discarded: the page reload was served from the HTTP cache and never reached the gate. "Prompt" means Chrome raised its login dialog (CDP `Fetch.authRequired`).

| Option | Variant measured | Login dropped on reload | Prompt during sign-out | Cost |
|---|---|---|---|---|
| 1. nginx `location = /backstage/logout` returning 401 | Top-level link to it, challenge sent | yes, 2 of 2 | yes, on the logout page itself | Snippet change: sending the challenge needs `add_header WWW-Authenticate`, which B67 forbids; a `--setup` run on the host before it works. |
| 1, fetched | `fetch`, challenge sent | yes, 3 of 3 | yes | as above |
| 1, fetched, no challenge | `fetch`, 401 without `WWW-Authenticate` | yes, 1 of 1 | no | as above, and a 401 without a challenge breaks RFC 9110 section 15.5.2 |
| 2. Wrong credentials | `XMLHttpRequest` with user and password, to `/api/backstage/health` | yes, 1 of 1 | no | One nginx auth-failure log line per sign-out (see Risks). No nginx or server change. |
| 2, header form | `fetch` with an explicit `Authorization` header | yes, 1 of 1 | yes | as above |
| 3. Session cookie in place of Basic Auth | not tried | - | - | A new security boundary and a deploy-contract change (`docs/backstage-deploy.md` section Basic Auth gate). Out of scope. |
| Negative control | a 200 `fetch`, no sign-out | no, 2 of 2 (login kept) | no | - |

**Choice: option 2**, sent as `XMLHttpRequest.open("GET", "/api/backstage/sign-out", true, "signed-out", <32 random hex characters>)`. It needs no snippet change, keeps B67 and the auth-state parser satisfied, does not need a `--setup` run, and the 401 it receives carries the real `Backstage` challenge that browsers use to identify the protection space. The path does not exist on the Bun server; nginx rejects the request before proxying because the random password matches no htpasswd entry.

## Flow

1. Header button `Sign out` (`id="sign-out"`), next to but separate from House Lights.
2. On click, synchronously: the same clear as Clear keys (keys, active keys, starting run, running calls), then `clearScene` (drops the run, so `beforeunload` does not ask). The button is disabled so a double click sends one request.
3. Send the wrong-credential request (10 s timeout).
4. Status 401, or no status (network error or timeout): `location.replace("/backstage/?signed-out=1")`.
   - Login dropped: the browser asks for credentials. Cancel shows nginx's 401 page; the Backstage page is gone.
   - Login kept: the page loads again with `?signed-out=1`, so the page knows the browser sent a working login without asking. It shows an in-page warning (`id="signed-out"`, `role="alert"`): quit the browser completely to finish signing out, or ignore it if you just signed in again. The parameter is removed from the address with `history.replaceState`.
5. Any other status means no Basic Auth gate answered (local preview): no navigation; the notice says keys and session were cleared and there was no login to sign out of.

No `alert`, `confirm` or `prompt`. Sign-out asks for no confirmation: it does what Clear keys already does without one, and the shared-browser case it exists for is the one where a forgotten confirmation leaves the login open.

## Browser behaviour this relies on

| Behaviour | Status |
|---|---|
| Chrome drops the cached Basic login for the realm after a 401 to a request in its protection space | Measured: Chrome 154.0.8037.98 headless, real nginx 1.27.5 in a throwaway container, CDP `Fetch.authRequired` as the login prompt. Negative control (a 200 request) kept the login 2 of 2. |
| Chrome opens no prompt for an `XMLHttpRequest` that supplied its own credentials | Measured, same setup. |
| Firefox drops or overwrites the cached login | UNVERIFIED. Firefox is not installed here. |
| Safari drops or overwrites the cached login | UNVERIFIED. Safari needs a person at the login dialog; not run. |
| A browser that keeps the login reloads the page silently, so the `?signed-out=1` warning appears | Follows from HTTP; exercised in Chrome only by re-entering credentials at the prompt. |

## Risks

- Each sign-out writes one `user "signed-out" was not found` line to nginx's error log. If the host runs a fail2ban `nginx-http-auth` jail, repeated sign-outs plus mistyped logins from one IP could ban that IP. UNVERIFIED: the host's jails were not inspected (no host access in this change). Operator check: `fail2ban-client status` on the host.
- The username `signed-out` could exist in the htpasswd; the random password still fails.

## Test plan

| Id | Tier | Proves |
|---|---|---|
| SO1 | smoke | `#sign-out` is in the header, is not `#theme`, and is a `type="button"` button; `#signed-out` warning exists, starts hidden, and tells the tester to quit the browser. |
| SO2 | unit | The wrong-credential request: `GET`, `/api/backstage/sign-out`, async, user `signed-out`, a 32-hex password that differs per call, no `Authorization` header, a timeout. Resolves the status; resolves 0 on error and timeout. |
| SO3 | unit | `signOut` clears before it sends, navigates to `/backstage/?signed-out=1` on 401 and on 0, and shows the no-gate notice without navigating on any other status. |
| SO4 | unit | `?signed-out=1` (and only the `signed-out` key) shows the warning. |
| SO5 | smoke | main.ts wires `#sign-out` to the same key clear as `#clear-keys` and to `clearScene`, and uses no native dialog. |
| Gate | - | `.deploy/backstage-nginx.conf` is unchanged, so the existing gated-location tests (backstage-setup A1, B67, the auth-state parser) cover it as before. |
| Real browser | manual / scratch | Throwaway nginx with a generated test-only htpasswd in front of the built page: curl 401 unauthenticated on both locations and 200 with the test credential; Chrome over CDP: log in, fill keys, click Sign out, keys blank, reload asks for credentials. Firefox and Safari recorded NOT RUN. |
