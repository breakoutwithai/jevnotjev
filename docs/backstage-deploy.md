# Backstage deployment

Backstage is an additional Bun service. The existing static deploy script cannot deploy its API. Its main-stage release and guards remain unchanged. The Backstage browser files and API travel together in one locally built release; both `/backstage/` and `/api/backstage/` proxy to that service, taking priority over the static root. Each process uses its immutable release directory for static files, so the old process cannot serve the new frontend during a symlink swap. A restart briefly interrupts Backstage only. The browser also checks the release version before accepting a run.

Read-only inspection on 2026-10-03 confirmed Linux x86_64, `/usr/local/bin/bun`, the existing domain's Certbot-managed TLS vhost, and no listener on port 3456. Recheck those facts before setup; they are not permission to change production. No setup or deploy has been executed for this change.

## One-time setup after authorization

Use `.deploy/config.sh` for the SSH target and key. Read the installed `/etc/nginx/sites-available/jevnotjev.breakoutwithai.com` first. Do not replace it with the repository HTTP-only template: that would remove Certbot's TLS configuration.

1. Confirm port 3456 is unused, the installed Bun supports the built server, and a dedicated non-login `jevnotjev-backstage` user/group exists (create it only during authorized setup). Capture the existing vhost and all co-tenant status codes using `.deploy/lib.sh` `list_neighbours` and `probe_neighbours`.
2. Install `.deploy/backstage.service` as `/etc/systemd/system/jevnotjev-backstage.service`. It runs as `jevnotjev-backstage`, bound to loopback. `StateDirectory=jevnotjev-backstage` with mode 0700 grants only that service writable state under `/var/lib/jevnotjev-backstage`, compatible with `ProtectSystem=strict`. Run `systemctl daemon-reload` and `systemctl enable jevnotjev-backstage`; verify with `systemctl is-enabled jevnotjev-backstage`. Enable configures reboot recovery; do not start it until a release exists.
3. Install `.deploy/backstage-nginx.conf` as `/etc/nginx/snippets/jevnotjev-backstage.conf`. Add exactly `include /etc/nginx/snippets/jevnotjev-backstage.conf;` inside this domain's existing HTTPS server block. Keep every certificate directive and other location unchanged. Review the installed diff. Do not edit another domain.
4. Run `nginx -t`. On failure restore the saved vhost before doing anything else. On success use `systemctl reload nginx`, never restart. Re-probe all neighbours. A changed neighbour means restore the vhost, validate it and reload again.
5. Run the guarded deployment below. Before the initial release starts, the new Backstage locations will return a gateway error; the main site continues to serve its static release. If setup is abandoned, restore the original vhost and reload after validation.

The MVP has no account service. For a private tester rollout, add an operator-managed nginx Basic Auth gate to BOTH Backstage locations, with credentials stored outside release artifacts. Never put tester BYOK keys into that gate, deployment configuration or shell arguments. The dedicated funded key is the explicit exception: it belongs only in the protected external configuration described below.

## Build and promote

Run the local test/typecheck/build gate before promotion. A production release requires a merged PR linked to #67, a clean checkout at freshly fetched `origin/main`, and separate deploy authorization.

```sh
.deploy/backstage-deploy.sh --dry-run
.deploy/backstage-deploy.sh
```

The helper rebuilds with `bun scripts/backstage-build.ts --committed` on the workstation from a temporary `git archive` snapshot of the approved SHA, so concurrent working-file edits cannot enter the payload. Each build returns a unique `dist/backstage-build-<suffix>` directory containing `site`, `server.js` and `release.json`; `.deploy/backstage-package.ts` rejects wrong version, missing browser/backend files, symlinks and unexpected files. The helper packages and verifies transferred archive bytes, then extracts under `/var/www/jevnotjev-backstage-releases/<SHA>`. Production never builds.

Activation swaps `/var/www/jevnotjev-backstage-current`, restarts only `jevnotjev-backstage`, checks the served API version and protocol against the target release.json (v2 promotion and verified v1 rollback are both supported), exact browser bundle, stylesheet and HTML bytes, page response, service status and co-tenants. Only then is `.verified` written with SHA, UTC time, actor and issue. No nginx reload is needed for subsequent releases. Keep previous releases; this helper does not prune them.

## Rollback

```sh
.deploy/backstage-deploy.sh --rollback FULL_PREVIOUS_SHA --dry-run
.deploy/backstage-deploy.sh --rollback FULL_PREVIOUS_SHA
```

Rollback requires the target's `.verified` marker and restores its complete browser/backend pair. Verification is the same as promotion. A failed promotion restores the previous pair and checks its API version. A failed first release stops only the Backstage service and removes its current symlink only after checking it still names that failed release; restore the setup vhost backup if Backstage should be removed entirely. A failed rollback or unreachable host is reported for inspection, never treated as success.

## Live acceptance

Version and HTTP checks do not prove inference. After deployment, enter tester-owned keys in the browser and run an authorized small comparison. Download sanitized evidence, inspect actual model IDs/usage and apply human labels. This has provider charges and is distinct from the deterministic adapter tests. No live calls were made while preparing this deployment contract.

For Basic Auth rollout, set `BACKSTAGE_CURL_CONFIG` to an absolute, user-owned mode-0600 curl configuration file containing the tester `user` credential. Every protected-route deploy and rollback probe reads this private file; credentials never appear in process arguments or deploy output. The config is not used for co-tenant probes. Keep it outside the repository.

Interrupted uploads remain in unique hidden staging directories. Retrying an inactive, unverified SHA quarantines its previous directory without deleting evidence; live or verified releases are never replaced. These directories require a separate reviewed cleanup. Concurrent local builds have distinct outputs; `bun run backstage:start` builds and serves its own immutable pair.


## Funded trial configuration (disabled until provisioned)

M1 BYOK works without funding. M2 must remain behind tester Basic Auth on both page and API; no-provider-key trial does not mean public unauthenticated access. Public exposure requires a separate abuse review and deployment authorization. Support one Bun process only; SQLite accounting does not replace the shared process admission limiter or make replicas supported.

The unit optionally loads `/etc/jevnotjev-backstage/trial.env` via systemd. An operator must provision this external file as root-owned mode 0600 inside a root-owned mode-0700 directory. Systemd reads it before dropping to the service user. Never place funded credentials/signing secrets in per-release `runtime.env`: the deploy helper deliberately makes release artifacts readable and must never copy or change permissions on the protected file. Deployment does not provision funding.

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
