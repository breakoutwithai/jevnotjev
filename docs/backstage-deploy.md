# Backstage deployment

Backstage is an additional Bun service. The existing static deploy script cannot deploy its API. Its main-stage release and guards remain unchanged. The Backstage browser files and API travel together in one locally built release; both `/backstage/` and `/api/backstage/` proxy to that service, taking priority over the static root. Each process uses its immutable release directory for static files, so the old process cannot serve the new frontend during a symlink swap. A restart briefly interrupts Backstage only. The browser also checks the release version before accepting a run.

Read-only inspection on 2026-10-03 confirmed Linux x86_64, `/usr/local/bin/bun`, the existing domain's Certbot-managed TLS vhost, and no listener on port 3456. `--setup --dry-run` rechecks those facts; they are not permission to change production. No setup or deploy has been executed for this change.

## Sign-in gate

The repo nginx snippet uses `auth_request` for `/backstage/` and `/api/backstage/`. An anonymous page request redirects to `/backstage/sign-in`; an anonymous API request returns 401 JSON without a Basic challenge. The exact ungated nginx locations are `/backstage/sign-in`, `/api/auth/password`, `/api/auth/sign-out`, `/api/auth/google`, and `/api/auth/google/callback`; `/_backstage_session` is an internal nginx location. The snippet overwrites `X-Backstage-Gate` with `session` on both gated routes, and the Bun service enforces the session when it receives that header. `BACKSTAGE_CURL_CONFIG` remains a private mode-0600 curl config on the workstation, with `user = "email:password"` for one operator in `operators.json`. The deploy mints a temporary session from it for protected probes. Co-tenant probes do not use it.

Roll out in this order so a gate remains active throughout:

1. Merge and deploy the sign-in-capable release while the installed nginx snippet still has Basic Auth (`gate=yes`). The new routes exist; the Basic snippet sends no session gate header, so Basic users are unaffected.
2. Write `auth.env` and `operators.json`, install the changed unit and restart the service. The session check now answers `"signIn":"ready"`; the app still does not enforce a session, and Basic still gates.
3. Run `.deploy/ship.sh --setup --module backstage --dry-run`, then `.deploy/ship.sh --setup --module backstage`. Setup swaps the snippet to the session gate, verifies it, and restores the prior snippet on failure. Basic is gone; nginx enforces the session gate.
4. The in-app gate is already on because the session snippet sends `X-Backstage-Gate: session`. Optional hardening: add `BACKSTAGE_REQUIRE_SESSION=1` to `auth.env` and restart the service so it also refuses requests that reach it without nginx.

If step 3 is rolled back, the previous Basic snippet comes back and sends no session gate header. If the optional switch was added to `auth.env`, remove it and restart before restoring Basic.

Operator steps, with exact values:

1. Confirm the Google Cloud OAuth client's registered origins are `https://jevnotjev.breakoutwithai.com`, `http://localhost:8787`, and `http://127.0.0.1:8787`, with the corresponding callback redirect URIs below. Confirm the consent screen is External for non-Workspace accounts. Whether an External screen in Testing limits users or session length is unverified.
2. In an interactive root session on the host, write `/etc/jevnotjev-backstage/auth.env`, root-owned mode 0600, with `BACKSTAGE_SESSION_SECRET=` followed by 64 hex characters from `openssl rand -hex 32`, `BACKSTAGE_GOOGLE_CLIENT_ID`, `BACKSTAGE_GOOGLE_CLIENT_SECRET`, and `BACKSTAGE_TRUST_PROXY=loopback`. Keep the secret stable; rotation signs everyone out.
3. On the workstation, run `bun scripts/backstage-operator-password.ts <email>` for each password tester (`doorman` and `lutfiya`), give each printed password once, and assemble the rows into one JSON array. A Google-only tester has an `email` row without a password hash. On the host, run `install -o jevnotjev-backstage -g jevnotjev-backstage -m 0600 operators.json /var/lib/jevnotjev-backstage/operators.json`.
4. Update `BACKSTAGE_CURL_CONFIG` so its `user` line has one operators-file email and its new password. Export its absolute path. Keep the password out of shell arguments, repository files, and deploy output.
5. Install the changed unit by hand because setup refuses to overwrite a differing installed unit: `install -m 0644 .deploy/journald@jevnotjev-backstage.conf /etc/systemd/journald@jevnotjev-backstage.conf && install -m 0644 .deploy/backstage.service /etc/systemd/system/jevnotjev-backstage.service && systemctl daemon-reload && systemctl restart jevnotjev-backstage`. Systemd reads `auth.env` only at start.
6. Run `.deploy/ship.sh --setup --module backstage --dry-run`, then without `--dry-run`.
7. Optional: add `BACKSTAGE_REQUIRE_SESSION=1` to `auth.env` and run `systemctl restart jevnotjev-backstage` (rollout step 4).
8. Afterward the htpasswd is unused. Deleting `/etc/jevnotjev-backstage/htpasswd` is optional and separate.

The registered Google redirect URI is `https://jevnotjev.breakoutwithai.com/api/auth/google/callback`; local development also uses `http://localhost:8787/api/auth/google/callback` and `http://127.0.0.1:8787/api/auth/google/callback`. Google origins are the matching site origins.

## One-time setup after authorization

Run the status probe, then read the dry run's plan and vhost diff before applying setup:

```sh
.deploy/ship.sh --status --module backstage          # read-only: setup present yes/no, auth yes/no
.deploy/ship.sh --setup --module backstage --dry-run # read-only probes, planned commands, vhost and snippet diff
.deploy/ship.sh --setup --module backstage           # apply what is absent or outdated
```

`--setup --module backstage` runs `.deploy/backstage-setup.sh`, which uses `.deploy/config.sh` for the SSH target and key and does, in order:

1. One read-only probe: Linux x86_64, `/usr/local/bin/bun` runs, port 3456 is free or held by the running service, and the vhost is installed and enabled. For the session snippet, nginx must have `--with-http_auth_request_module`; `auth.env` must be a regular, non-symlink, root-owned mode-0600 file setting `BACKSTAGE_SESSION_SECRET` to at least 32 characters and `BACKSTAGE_TRUST_PROXY=loopback`; and, when a release is running, `operators.json` must be a non-empty service-owned mode-0600 regular file. On a running release (`systemctl is-active` and the current release symlink), the loopback `/api/auth/session` check must answer 401 with `"signIn":"ready"` within five seconds. The probe checks keys and length without printing secret values. For a Basic snippet, the existing htpasswd precondition applies. Setup refuses before any change if an installed unit differs from the repository copy or the private `BACKSTAGE_CURL_CONFIG` is unusable.
2. Creates the non-login system user/group `jevnotjev-backstage` if absent. Installs `.deploy/journald@jevnotjev-backstage.conf` as `/etc/systemd/journald@jevnotjev-backstage.conf` if absent and runs `systemctl try-restart systemd-journald@jevnotjev-backstage.service` so a running namespace instance reads it. Setup refuses a differing installed conf or an empty journald probe. It installs `.deploy/backstage.service` as `/etc/systemd/system/jevnotjev-backstage.service` if absent, runs `systemctl daemon-reload` and `systemctl enable jevnotjev-backstage`. It runs as `jevnotjev-backstage`, bound to loopback. `StateDirectory=jevnotjev-backstage` with mode 0700 grants only that service writable state under `/var/lib/jevnotjev-backstage`, compatible with `ProtectSystem=strict`. Enable configures reboot recovery; the service is not started until a release exists.
3. Probes every co-tenant in `/etc/nginx/sites-enabled`, saves a timestamped backup of the installed vhost under `/var/backups/jevnotjev-backstage/`, installs `.deploy/backstage-nginx.conf` as `/etc/nginx/snippets/jevnotjev-backstage.conf` if absent or, when the installed snippet differs, saves it under the same backup directory and replaces it, and inserts exactly `include /etc/nginx/snippets/jevnotjev-backstage.conf;` if absent, inside this domain's only HTTPS server block. Every certificate directive and other location is kept; the vhost is never replaced by the repository HTTP-only template, which would remove Certbot's TLS configuration. No other domain is edited.
4. Runs `nginx -t`. On failure it restores the saved vhost and never reloads. On success it runs `systemctl reload nginx`, never restart, and re-probes all neighbours. A changed neighbour restores the vhost, validates it and reloads again. Either failure exits non-zero.
5. Verifies the gate, pinned to the host. For the session snippet, S2 checks the anonymous page redirect, API 401 JSON without a Basic challenge, sign-in form, rejection of a tampered cookie, and access with a minted session. On a fresh install with no running release, setup skips the loopback release check; the installed session gate fails closed, S2 accepts 502 on `/backstage/sign-in` and on authenticated routes, and reports minted-session rows as `n/a` until the first deploy. For a Basic snippet, the previous 401 and authenticated upstream checks remain, with 502 accepted without a release. A failed transfer or assertion restores the vhost and previous snippet, validates and reloads again, and exits non-zero. A failed restore copy stops before reloading and prints the manual step.

Re-running on a configured host changes nothing and exits 0. If setup is abandoned, restore the saved vhost and snippet, run `nginx -t`, and reload. After `backstage-setup.sh` succeeds, `ship.sh --setup --module backstage` closes with a Backstage-scoped live gate verification, without SHA, release tag, or public-path checks; it exits 6 when that fails (`docs/DEPLOY.md` "Live verify").

The sign-in gate is the private tester boundary. Never put tester BYOK keys into deployment configuration or shell arguments. The dedicated funded key belongs only in the protected external configuration described below.

Sign-out clears the in-page session and tester keys, POSTs to `/api/auth/sign-out` to revoke the session cookie, then navigates to `/backstage/sign-in?signed-out=1`. It sends no wrong Basic password and creates no nginx auth failure. The prior behavior is documented in `docs/design/backstage-sign-out.md`.

## Build and promote

Run the local test/typecheck/build gate before promotion. A production release requires a merged PR linked to #67, a clean checkout at freshly fetched `origin/main`, and separate deploy authorization.

The standard deploy is the whole stack, `.deploy/ship.sh` with no flags:

```sh
.deploy/ship.sh --dry-run   # per-module plan, drift, the release tag it would create
.deploy/ship.sh             # static then Backstage; modules already at origin/main are skipped
.deploy/ship.sh --status    # exit 0 = no detected module drift and the live verify passed; 3 = STALE or UNKNOWN; 6 = verify failed
.deploy/ship.sh --verify    # read-only live check against the spec (docs/DEPLOY.md "Live verify")
```

Drift `none` alone does not mean every module serves the exact `origin/main` SHA: a module on an older SHA with no changes under its paths reports `none (sha differs, no module changes)`, and the live verify that closes `--status` then fails S1 and exits 6. Backstage's paths include every source file its build bundles (the import graph of the `scripts/backstage-build.ts` entrypoints), so a change in `src/core/` or `src/format/` makes Backstage STALE.

Backstage runs through `.deploy/backstage-deploy.sh`. ship.sh skips it with `up to date` only when the served API version, the current release directory (`/var/www/jevnotjev-backstage-releases/<SHA>`) and its `.verified` marker all name `origin/main`, because the helper refuses to replace a verified live release. When the installed snippet is the session gate, promotion, rollback and automatic fallback refuse a release whose `release.json` lacks `"gate":"session"`; a pre-sign-in release would fail the session check. After every module serves `origin/main`, ship.sh runs the live verify (S1 served SHAs and the S2 gate and public paths) and exits 6 without tagging or publishing anything when it fails; a Backstage 502 on either authenticated route is retried while a release exists. Only then does it tag the stack `vYYYY.MM.DD.N` and publishes a GitHub release whose metadata includes the Backstage `version`, `protocol`, `catalogVersion` and release directory; a tag or release failure exits 5 with the recovery command and never rolls Backstage back, and the tag is then verified on origin (exit 6 if absent). Full contract, drift states and exit codes: `docs/DEPLOY.md`.

`.deploy/ship.sh --module backstage` deploys Backstage alone and refuses (exit 4) while static is STALE or UNKNOWN against `origin/main`, naming the changed paths. Add `--allow-drift` only when leaving static behind is deliberate; agents use the default.

The helper rebuilds with `bun scripts/backstage-build.ts --committed` on the workstation from a temporary `git archive` snapshot of the approved SHA, so concurrent working-file edits cannot enter the payload. Each build returns a unique `dist/backstage-build-<suffix>` directory containing `site`, `server.js` and `release.json`; `.deploy/backstage-package.ts` rejects wrong version, missing browser/backend files, symlinks and unexpected files. The helper packages and verifies transferred archive bytes, then extracts under `/var/www/jevnotjev-backstage-releases/<SHA>`. Production never builds.

Activation swaps `/var/www/jevnotjev-backstage-current`, restarts only `jevnotjev-backstage`, checks the served API version and protocol against the target release.json (v2 promotion and verified v1 rollback are both supported), exact browser bundle, stylesheet and HTML bytes, page response, service status and co-tenants. Only then is `.verified` written with SHA, UTC time, actor and issue. No nginx reload is needed for subsequent releases. Keep previous releases; this helper does not prune them.

## Rollback

```sh
.deploy/ship.sh --module backstage --rollback FULL_PREVIOUS_SHA --dry-run
.deploy/ship.sh --module backstage --rollback FULL_PREVIOUS_SHA
```

Rollback requires the target's `.verified` marker and restores its complete browser/backend pair. Verification is the same as promotion. A failed promotion restores the previous pair and checks its API version. A failed first release stops only the Backstage service and removes its current symlink only after checking it still names that failed release; restore the setup vhost backup if Backstage should be removed entirely. A failed rollback or unreachable host is reported for inspection, never treated as success.

## Live acceptance

Version and HTTP checks do not prove inference. After deployment, enter tester-owned keys in the browser and run an authorized small comparison. Download sanitized evidence, inspect actual model IDs/usage and apply human labels. This has provider charges and is distinct from the deterministic adapter tests. No live calls were made while preparing this deployment contract.

`BACKSTAGE_CURL_CONFIG` must name an absolute, user-owned mode-0600 curl configuration file with one operator's `user = "email:password"` line. Every protected-route deploy, rollback, and status probe reads this private file; credentials never appear in process arguments or deploy output. The deploy reads the installed snippet's gate state and refuses an unknown layout. With the session gate, it mints a temporary cookie before protected probes. Co-tenant probes do not use this config. Keep it outside the repository.

Interrupted uploads remain in unique hidden staging directories. Retrying an inactive, unverified SHA quarantines its previous directory without deleting evidence; live or verified releases are never replaced. These directories require a separate reviewed cleanup. Concurrent local builds have distinct outputs; `bun run backstage:start` builds and serves its own immutable pair.


## Logs

Who signed in today:

```sh
journalctl --namespace=jevnotjev-backstage -u jevnotjev-backstage --since today -o cat | grep '"event":"signin'
journalctl --namespace=jevnotjev-backstage -u jevnotjev-backstage -o cat | grep '"event":"signin'
```

The second command shows sign-in events across the retained journal. For failures and lockouts, append `| grep -E '"event":"(signin\.password\.fail|signin\.lockout|signin\.google\.denied)"'` to `journalctl --namespace=jevnotjev-backstage -u jevnotjev-backstage -o cat`. For runs, append `| grep '"event":"run\.'`. The [line contract](design/backstage-logging.md#line-contract) lists the fields: auth has `ts`, `event`, `email`, `ip`, `rid`, and sometimes `reason`; runs have `ts`, `event`, `rid`, `provider`, `model`.

Backstage uses its own journal namespace because the host-wide `journald.conf` is shared by 9 co-tenants and is not changed. The systemd 255 manuals state:

- [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html): "Run the unit's processes in the specified journal namespace." It also says, "Note that when this option is used log output of this service does not appear in the regular journalctl(1) output, unless the --namespace= option is used." Backstage does not establish host mount points.
- [journald.conf(5)](https://www.freedesktop.org/software/systemd/man/255/journald.conf.html): "Instances managing other namespaces read /etc/systemd/journald@NAMESPACE.conf and associated drop-ins". `Storage=` "Defaults to "auto" in the default journal namespace, and "persistent" in all others."
- [journald.conf(5)](https://www.freedesktop.org/software/systemd/man/255/journald.conf.html): `MaxRetentionSec=` "This controls whether journal files containing entries older than the specified time span are deleted." Deletion is per file. `MaxFileSec=` rotation defaults to one month, so the Backstage config sets `MaxFileSec=1h` alongside `MaxRetentionSec=1day`.
- [systemd-journald.service(8)](https://www.freedesktop.org/software/systemd/man/255/systemd-journald.service.html): namespace data lives in `/var/log/journal/MACHINE_ID.NAMESPACE`.

Chosen value: 1 day for Backstage only (operator, 2026-10-06).

From a checkout of merged main, run as root on the host:

```sh
install -m 0644 .deploy/journald@jevnotjev-backstage.conf /etc/systemd/journald@jevnotjev-backstage.conf
install -m 0644 .deploy/backstage.service /etc/systemd/system/jevnotjev-backstage.service
systemctl try-restart systemd-journald@jevnotjev-backstage.service
systemctl daemon-reload
systemctl restart jevnotjev-backstage
systemctl show -p LogNamespace jevnotjev-backstage
journalctl --namespace=jevnotjev-backstage -n 5
```

Lines already written to the default journal before this change stay under the host-wide retention; there is no per-unit vacuum. If the conf changes later, `systemctl try-restart systemd-journald@jevnotjev-backstage.service` makes the instance re-read it (checked in an Ubuntu 24.04 container with systemd 255.4, not on the host).

## Funded trial configuration (disabled until provisioned)

M1 BYOK works without funding. M2 remains behind the tester sign-in gate on both page and API; no-provider-key trial does not mean public unauthenticated access. Public exposure requires a separate abuse review and deployment authorization. Support one Bun process only; SQLite accounting does not replace the shared process admission limiter or make replicas supported.

The unit loads optional `/etc/jevnotjev-backstage/auth.env` and `/etc/jevnotjev-backstage/trial.env` via systemd. An operator must provision the trial file as root-owned mode 0600 inside the root-owned `/etc/jevnotjev-backstage` directory. Systemd reads both files before dropping to the service user. Never place funded credentials or signing secrets in per-release `runtime.env`: the deploy helper deliberately makes release artifacts readable and must never copy or change permissions on the protected file. Deployment does not provision funding.

Backend configuration uses these explicit variables; missing/invalid values disable the trial:

- `BACKSTAGE_TRIAL_KEY`: dedicated funded Jev credential; never reuse a tester burner key.
- `BACKSTAGE_TRIAL_SIGNING_SECRET`: at least 32 characters, generated independently. Keep stable across releases; rotation invalidates old cookies.
- `BACKSTAGE_TRIAL_LEDGER_PATH`: `/var/lib/jevnotjev-backstage/trial.sqlite`, outside every release.
- `BACKSTAGE_TRIAL_DAILY_BUDGET_MICRO_USD` and `BACKSTAGE_TRIAL_WORST_COST_MICRO_USD`: positive integer micro-USD, never floating-point dollars. The reservation must cover the independently verified worst request cost for the enabled Jev pin; numeric values alone are not pricing verification.
- `BACKSTAGE_TRIAL_DAILY_MINT_LIMIT`, `BACKSTAGE_TRIAL_DAILY_NETWORK_MINT_LIMIT`, `BACKSTAGE_TRIAL_DAILY_NETWORK_ATTEMPT_LIMIT`: explicit positive integer abuse limits.
- `BACKSTAGE_TRIAL_PRICING_VERSION`: the currently supported, verified catalog pricing version. A future model/rate change requires a fresh bound before enabling funding.

The no-key request is one Jev question (maximum 200 characters), two choices (names 32 and definitions 200 characters each), and one case (1000 characters). It has no competitor dispatch. The ledger reserves the entire worst-case amount before dispatch and consumes the browser allowance atomically with an idempotency entry. A replay never fetches again. Successful known cost settles the integer actual amount. Only an explicitly known local pre-dispatch rejection releases the reservation/allowance. Timeout, interruption and restart hold uncertain spend; 401/403/429 additionally trip a persistent funding hold. A known cost above its bound records the actual amount and trips funding off. Reconciliation is a separate operator action, never automatic rollback/refund.

Budgets and rate windows roll at 00:00 UTC; consumed browser allowances do not refill at midnight. Signed opaque cookies expire after 90 days. Finalized accounting, expired unreferenced allowance identifiers and rate counters older than 90 days are pruned on startup and the first token mint of each UTC day; unresolved uncertain reservations remain held until explicitly reconciled. Ledger metadata includes random allowance/reservation IDs, keyed hashes of network/idempotency identifiers, timestamps, integer costs and allowlisted failure codes. No question, case, answer or provider key is stored. Preserve the ledger across releases and rollback; unsupported schema disables trial access instead of resetting state. Back up before any future forward schema migration.

Use an HttpOnly, SameSite=Strict trial-route cookie, Secure over deployed HTTPS; insecure cookies are only an explicit localhost development exception. The notice must disclose the cookie, network limits, accounting retention and that reloading may lose the response without restoring the allowance. No server response persistence is promised.

For production nginx, explicitly set `BACKSTAGE_TRUST_PROXY=loopback` in the protected external `/etc/jevnotjev-backstage/auth.env`. Do not place it in per-release `runtime.env`, which deployment rewrites. The API snippet overwrites `X-Backstage-Client-IP` with nginx's `$remote_addr`; the backend honors it only from a loopback socket when that proxy mode is configured. Direct localhost preview uses its socket address and ignores visitor forwarded headers. Network limits currently key the full client address, not an IPv6 /64; rotating IPv6 addresses can bypass the per-address window, while durable global mint and spend caps still bound funding. Public enablement needs a stronger abuse review. Adding an upstream proxy requires separately configuring its trusted addresses; never trust arbitrary forwarding headers or inherit unreviewed real-IP settings.

Before enabling funding, verify dedicated-user state writes, protected-file permissions, tester auth on both routes, trusted address handling, durable quotas after restart, schema compatibility, and the pricing bound. Run the local ledger/server/deployment tests, then a separately authorized funded live smoke. None of the templates or deterministic tests proves provisioned funds or a production inference call.
