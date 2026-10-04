# Backstage deployment

Backstage is an additional Bun service. The existing static deploy script cannot deploy its API. Its main-stage release and guards remain unchanged. The Backstage browser files and API travel together in one locally built release; both `/backstage/` and `/api/backstage/` proxy to that service, taking priority over the static root. Each process uses its immutable release directory for static files, so the old process cannot serve the new frontend during a symlink swap. A restart briefly interrupts Backstage only. The browser also checks the release version before accepting a run.

Read-only inspection on 2026-10-03 confirmed Linux x86_64, `/usr/local/bin/bun`, the existing domain's Certbot-managed TLS vhost, and no listener on port 3456. `--setup --dry-run` rechecks those facts; they are not permission to change production. No setup or deploy has been executed for this change.

## Basic Auth gate (required)

Both Backstage locations, the page (`/backstage/`) and the API (`/api/backstage/`), carry `auth_basic "Backstage";` and `auth_basic_user_file /etc/jevnotjev-backstage/htpasswd;` in `.deploy/backstage-nginx.conf`. The credentials live only on the host and in one private file on the operator's workstation; no release artifact, repository file, command argument, environment value or log carries them. Operator sequence, in order:

1. Create the htpasswd on the host, as root, in an interactive session (`ssh -t`). The password is typed at the prompt. Replace `tester` with the login name. With apache2-utils installed (`/usr/bin/htpasswd`):

   ```sh
   install -d -o root -g www-data -m 0750 /etc/jevnotjev-backstage && htpasswd -B -c /etc/jevnotjev-backstage/htpasswd tester && chown root:www-data /etc/jevnotjev-backstage/htpasswd && chmod 0640 /etc/jevnotjev-backstage/htpasswd
   ```

   Without apache2-utils, `openssl passwd -apr1` prompts instead; setup prints that variant when it refuses. `-c` replaces any existing file. `www-data` is nginx's worker group on this host; setup reads the `user` directive from the effective config (`nginx -T`, includes resolved) and refuses on a mismatch, or when no single `user` directive is found.

2. Create the local curl config on the workstation, typing the same login and password (`read -s` keeps the password off the screen and out of shell history):

   ```sh
   d="$HOME/.config/jevnotjev"; mkdir -p "$d" && chmod 700 "$d" && t="$(mktemp "$d/.backstage-curl.XXXXXX")" && chmod 600 "$t" && read -r -s -p 'Backstage password: ' BP && echo && printf 'user = "tester:%s"\n' "$BP" > "$t" && mv -f "$t" "$d/backstage-curl"; unset BP
   ```

   The password goes only into a new mode-0600 temporary file, which then atomically replaces `backstage-curl`, so an existing file's looser mode never sees it. Any absolute path outside the repository works. Avoid `"` and `\` in the password: curl config quoting would need escaping.

3. `export BACKSTAGE_CURL_CONFIG="$HOME/.config/jevnotjev/backstage-curl"` (absolute path).

4. `.deploy/ship.sh --setup --module backstage --dry-run`, then `.deploy/ship.sh --setup --module backstage`. Setup installs or updates the gated snippet and then verifies the gate (below).

5. Confirm the gate from outside: `curl -s -o /dev/null -w '%{http_code}\n' https://jevnotjev.breakoutwithai.com/backstage/` and the same for `/api/backstage/health` print `401`.

Setup refuses, before any change, unless `/etc/jevnotjev-backstage/htpasswd` exists, is non-empty, is owned by root with nginx's worker group and mode 0640, and its directory is owned by root with mode 0750 or tighter and traversable by that group. The refusal prints the command above. The directory also holds the optional funded-trial `trial.env`, which stays root-owned mode 0600; nginx's group can traverse the directory but cannot read that file.

With the gate on the host, `ship.sh --status --module backstage` and every Backstage deploy and rollback probe read `BACKSTAGE_CURL_CONFIG`; when it is unset they fail naming the variable instead of reporting a bare 401. Co-tenant probes never use it.

## One-time setup after authorization

Two operator commands, after reading the dry run's plan and vhost diff:

```sh
.deploy/ship.sh --status --module backstage          # read-only: setup present yes/no, auth yes/no
.deploy/ship.sh --setup --module backstage --dry-run # read-only probes, planned commands, vhost and snippet diff
.deploy/ship.sh --setup --module backstage           # apply what is absent or outdated
```

`--setup --module backstage` runs `.deploy/backstage-setup.sh`, which uses `.deploy/config.sh` for the SSH target and key and does, in order:

1. One read-only probe: Linux x86_64, `/usr/local/bin/bun` runs, port 3456 is free (or held by the running `jevnotjev-backstage` service), the vhost is installed and `sites-enabled` links to it, the htpasswd is ready (see Basic Auth gate), and which of the steps below are already done. It refuses, changing nothing, on any mismatch, when an installed unit differs from the repository copy (never overwritten), or, for a real run that changes nginx, when `BACKSTAGE_CURL_CONFIG` is unset or not a private file.
2. Creates the non-login system user/group `jevnotjev-backstage` if absent. Installs `.deploy/backstage.service` as `/etc/systemd/system/jevnotjev-backstage.service` if absent, runs `systemctl daemon-reload` and `systemctl enable jevnotjev-backstage`. It runs as `jevnotjev-backstage`, bound to loopback. `StateDirectory=jevnotjev-backstage` with mode 0700 grants only that service writable state under `/var/lib/jevnotjev-backstage`, compatible with `ProtectSystem=strict`. Enable configures reboot recovery; the service is not started until a release exists.
3. Probes every co-tenant in `/etc/nginx/sites-enabled`, saves a timestamped backup of the installed vhost under `/var/backups/jevnotjev-backstage/`, installs `.deploy/backstage-nginx.conf` as `/etc/nginx/snippets/jevnotjev-backstage.conf` if absent or, when the installed snippet differs, saves it under the same backup directory and replaces it, and inserts exactly `include /etc/nginx/snippets/jevnotjev-backstage.conf;` if absent, inside this domain's only HTTPS server block. Every certificate directive and other location is kept; the vhost is never replaced by the repository HTTP-only template, which would remove Certbot's TLS configuration. No other domain is edited.
4. Runs `nginx -t`. On failure it restores the saved vhost and never reloads. On success it runs `systemctl reload nginx`, never restart, and re-probes all neighbours. A changed neighbour restores the vhost, validates it and reloads again. Either failure exits non-zero.
5. Verifies the gate, pinned to the host: unauthenticated GET of `/backstage/` and `/api/backstage/health` must return 401 (auth runs before the proxy, so 401 even before the first release), and the same requests with `BACKSTAGE_CURL_CONFIG` must reach the upstream: 200 with a running release, 502 only while none runs. 403 or 500 (nginx cannot use the htpasswd) and any failed transfer fail the check. Otherwise it restores the vhost and the previous snippet (or removes a new one), validates and reloads again, and exits non-zero. If a restore copy itself fails, nothing is reloaded and the exact manual step is printed.

Re-running on a configured host changes nothing and exits 0. Then run the guarded deployment below. Before the initial release starts, authenticated requests to the Backstage locations return a gateway error; the main site continues to serve its static release. If setup is abandoned, copy the backup back over the vhost, run `nginx -t` and reload.

The MVP has no account service; the Basic Auth gate above is its private tester boundary. Never put tester BYOK keys into that gate, deployment configuration or shell arguments. The dedicated funded key is the explicit exception: it belongs only in the protected external configuration described below.

## Build and promote

Run the local test/typecheck/build gate before promotion. A production release requires a merged PR linked to #67, a clean checkout at freshly fetched `origin/main`, and separate deploy authorization.

The standard deploy is the whole stack, `.deploy/ship.sh` with no flags:

```sh
.deploy/ship.sh --dry-run   # per-module plan, drift, the release tag it would create
.deploy/ship.sh             # static then Backstage; modules already at origin/main are skipped
.deploy/ship.sh --status    # exit 0 = no detected module drift; 3 = a module is STALE or UNKNOWN
```

`--status` exit 0 means no detected module drift, not that every module serves the exact `origin/main` SHA: a module on an older SHA with no changes under its paths reports `none (sha differs, no module changes)`. Backstage's paths include every source file its build bundles (the import graph of the `scripts/backstage-build.ts` entrypoints), so a change in `src/core/` or `src/format/` makes Backstage STALE.

Backstage runs through `.deploy/backstage-deploy.sh`. ship.sh skips it with `up to date` only when the served API version, the current release directory (`/var/www/jevnotjev-backstage-releases/<SHA>`) and its `.verified` marker all name `origin/main`, because the helper refuses to replace a verified live release. After every module serves `origin/main`, ship.sh tags the stack `vYYYY.MM.DD.N` and publishes a GitHub release whose metadata includes the Backstage `version`, `protocol`, `catalogVersion` and release directory; a tag or release failure exits 5 with the recovery command and never rolls Backstage back. Full contract, drift states and exit codes: `docs/DEPLOY.md`.

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

`BACKSTAGE_CURL_CONFIG` must name an absolute, user-owned mode-0600 curl configuration file containing the tester `user` credential (Basic Auth gate, step 2). Every protected-route deploy, rollback and status probe reads this private file; credentials never appear in process arguments or deploy output. After taking the host lock, the deploy reads the installed snippet and refuses, naming the variable, when both Backstage locations have effective auth (`auth_basic` not `off`, plus `auth_basic_user_file`) and the variable is unset. An unreadable snippet, or one where only one location is gated or the layout is not recognised, also refuses. The config is not used for co-tenant probes. Keep it outside the repository.

Interrupted uploads remain in unique hidden staging directories. Retrying an inactive, unverified SHA quarantines its previous directory without deleting evidence; live or verified releases are never replaced. These directories require a separate reviewed cleanup. Concurrent local builds have distinct outputs; `bun run backstage:start` builds and serves its own immutable pair.


## Funded trial configuration (disabled until provisioned)

M1 BYOK works without funding. M2 must remain behind tester Basic Auth on both page and API; no-provider-key trial does not mean public unauthenticated access. Public exposure requires a separate abuse review and deployment authorization. Support one Bun process only; SQLite accounting does not replace the shared process admission limiter or make replicas supported.

The unit optionally loads `/etc/jevnotjev-backstage/trial.env` via systemd. An operator must provision this external file as root-owned mode 0600 inside the root-owned `/etc/jevnotjev-backstage` directory. That directory is mode 0750 with nginx's worker group so nginx can read the Basic Auth htpasswd; the group can list it but cannot read `trial.env`. Systemd reads it before dropping to the service user. Never place funded credentials/signing secrets in per-release `runtime.env`: the deploy helper deliberately makes release artifacts readable and must never copy or change permissions on the protected file. Deployment does not provision funding.

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

For production nginx, explicitly set `BACKSTAGE_TRUST_PROXY=loopback` in the protected external `/etc/jevnotjev-backstage/trial.env`. Do not place it in per-release `runtime.env`, which deployment rewrites. The API snippet overwrites `X-Backstage-Client-IP` with nginx's `$remote_addr`; the backend honors it only from a loopback socket when that proxy mode is configured. Direct localhost preview uses its socket address and ignores visitor forwarded headers. Network limits currently key the full client address, not an IPv6 /64; rotating IPv6 addresses can bypass the per-address window, while durable global mint and spend caps still bound funding. Public enablement needs a stronger abuse review. Adding an upstream proxy requires separately configuring its trusted addresses; never trust arbitrary forwarding headers or inherit unreviewed real-IP settings.

Before enabling funding, verify dedicated-user state writes, protected-file permissions, tester auth on both routes, trusted address handling, durable quotas after restart, schema compatibility, and the pricing bound. Run the local ledger/server/deployment tests, then a separately authorized funded live smoke. None of the templates or deterministic tests proves provisioned funds or a production inference call.
