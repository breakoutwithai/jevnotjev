# Backstage sign-out (#96)

Superseded by [Backstage sign-in page](backstage-google-sign-in.md). This document records the earlier Basic Auth sign-out design.

Status: implemented in the PR that closes #96. Basic Auth stays the tester gate; sign-out is added on top of it with no change to `.deploy/backstage-nginx.conf`.

## Current login mechanism

- nginx Basic Auth, realm `Backstage`, gates both locations: the page at `.deploy/backstage-nginx.conf:4-7` and the API at `.deploy/backstage-nginx.conf:12-14`, reading `/etc/jevnotjev-backstage/htpasswd`.
- The deploy contract requires both, and the gate is the MVP's only tester boundary (`docs/backstage-deploy.md:9`, `docs/backstage-deploy.md:57`). Setup and every deploy verify assert an unauthenticated 401 on `/backstage/` and `/api/backstage/health` (`.deploy/verify-lib.sh:11`).
- The deploy reads the installed snippet's auth state with `backstage_snippet_auth` (`.deploy/backstage-lib.sh:93-139`): auth directives anywhere but the two locations make the state `unknown`, and the deploy refuses.
- The snippet may not carry `add_header`, which would drop the server block's inherited security headers (`.deploy/backstage-package.test.ts:120-124`, test B67).
- The page header holds only the home link and the House Lights theme toggle (`site/backstage/index.html:16-17`, `id="theme"`, handler `button("theme").onclick` at `src/backstage/main.ts:792`).
- Line references in this section are to `main` at bd08f1c, before this change. Clear keys (the `button("clear-keys")` handler, `src/backstage/main.ts:680`) empties `activeKeys`, aborts a starting run, stops the run and blanks every `<provider>-key` field. `clearScene()` (`src/backstage/main.ts:716`) drops the run and resets the rooms. A `beforeunload` listener (`src/backstage/main.ts:851`) asks before leaving while a run exists.

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

**Choice: option 2**, sent as `XMLHttpRequest.open("GET", "/api/backstage/sign-out", true, "signed-out", <32 random hex characters>)`. It needs no snippet change, keeps B67 and the auth-state parser satisfied, does not need a `--setup` run, and the 401 it receives carries the real `Backstage` challenge that browsers use to identify the protection space. The path does not exist on the Bun server; nginx rejects the request before proxying because the random password matches no htpasswd entry. The options table measured this request against `/api/backstage/health` (1 run); the shipped path `/api/backstage/sign-out` sits in the same gated location and was measured end to end with the built page (Real-browser results below, 3 of 3).

## Flow

1. Header button `Sign out` (`id="sign-out"`), next to but separate from House Lights.
2. On click, synchronously: the same clear as Clear keys (keys, active keys, starting run, running calls), then `clearScene` (drops the run). A `signingOut` flag stops any run from starting, and stops the `beforeunload` guard from asking, while the request is in flight. The button is disabled so a double click sends one request. The notice reads "Signing out. Keys and session cleared."
3. Send the wrong-credential request (10 s timeout).
4. Whatever the status, `location.replace("/backstage/?signed-out=1")`. Behind the gate the random password always gets 401; any other status means the request got past Basic Auth, which is itself a kept login, so the landing page decides.
   - Login dropped: the browser asks for credentials. Cancel shows nginx's 401 page; the Backstage page is gone.
   - Login kept: the page loads again with `?signed-out=1`, so the page knows the browser sent a working login without asking. It shows an in-page warning (`id="signed-out"`, `role="alert"`): quit the browser completely to finish signing out, or ignore it if you just signed in again. The warning is revealed after the first room renders and takes focus. The parameter is removed from the address with `history.replaceState`. Anyone can open `?signed-out=1` and see the warning; that is a message, not a bypass: the value never reaches HTML or a navigation target.

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
| SO2 | unit | The wrong-credential request: `GET`, `/api/backstage/sign-out`, async, user `signed-out`, a 32-hex password (main.ts draws it from `crypto.getRandomValues`), a 10 s timeout. Resolves the status; resolves 0 on error and timeout. |
| SO3 | unit | `signOut` clears before it sends, then navigates to `/backstage/?signed-out=1` on 401, 0, 200, 404, 502 and a rejected request. |
| SO4 | unit | `?signed-out=1` (and only the `signed-out` key) shows the warning. |
| SO5 | smoke | main.ts wires `#sign-out` to the same key clear as `#clear-keys` and to `clearScene`, blocks run starts and the unload guard while signing out, reveals and focuses the warning after the first room renders, and uses no native dialog. Source assertions. |
| SO6 | integration | `src/backstage/main.dom.test.ts` executes the real main.ts against a fake DOM built from index.html: sign-out blanks all five key fields, disables the button and sets the notice synchronously, opens the wrong-credential XHR, navigates only after it ends (401, 0, 200); a pending sign-out blocks Run one, Run all and the funded trial and does not trigger the unload guard; `?signed-out=1` reveals and focuses the warning and resets the address; Clear keys still blanks keys without signing out. Mutation-checked: removing `signingOut = true`, the `signOut` call, the XHR, the key blanking or the warning focus each fails at least one SO6 test. |
| Gate | - | `.deploy/backstage-nginx.conf` is unchanged, so the existing gated-location tests (backstage-setup A1, B67, the auth-state parser) cover it as before. |
| Real browser | manual / scratch | Throwaway nginx with a generated test-only htpasswd in front of the built page: curl 401 unauthenticated on both locations and 200 with the test credential; Chrome over CDP: log in, fill keys, click Sign out, keys blank, reload asks for credentials. Firefox and Safari recorded NOT RUN. |

## Real-browser results (head 91bc704)

Setup: the built page (`bun .agents/scripts/preview`, release 91bc704) behind nginx 1.27.5 in a throwaway local container, running `.deploy/backstage-nginx.conf` with only the `proxy_pass` target changed, and a generated test-only login in a scratch file, deleted after. Chrome driven over CDP; `Fetch.authRequired` stands for the login dialog, answered with the test login or Cancel.

curl, no credentials: `/backstage/` 401, `/api/backstage/health` 401, `/api/backstage/sign-out` 401 with `WWW-Authenticate: Basic realm="Backstage"`. With the test login: 200, 200, 404 (no such route on the server). With the sign-out's wrong credentials: 401, and nginx logged `user "signed-out" was not found`.

| Browser | Scenario | Result |
|---|---|---|
| Chrome 154.0.8037.98 | Log in, fill all 5 key fields, click Sign out, Cancel at the prompt (3 runs) | PASS 3 of 3: key fields 0 of 5 filled right after the click, the sign-out request got 401 with no prompt, the reload to `/backstage/?signed-out=1` asked for the login, a fresh visit to `/backstage/` asked again, no native dialog. |
| Chrome 154.0.8037.98 | Same, but sign in again at the prompt | Warning `#signed-out` shown, address reset to `/backstage/`. |
| Chrome 154.0.8037.98 | Control: no sign-out | Login kept: no prompt on a fresh visit. |
| Firefox | - | NOT RUN: not installed on this machine. |
| Safari | - | NOT RUN: needs a person at the login dialog. |

Not run: the live host, a browser that keeps the login on its own (the warning was exercised only by signing in again), and screen-reader announcement and focus of the warning.
