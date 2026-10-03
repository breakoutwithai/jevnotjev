# Backstage deployment

Backstage is an additional Bun service. The existing static deploy script cannot deploy its API. Its main-stage release and guards remain unchanged. The Backstage browser files and API travel together in one locally built release; both `/backstage/` and `/api/backstage/` proxy to that service, taking priority over the static root. A restart briefly interrupts Backstage only. The browser also checks the release version before accepting a run.

Read-only inspection on 2026-10-03 confirmed Linux x86_64, `/usr/local/bin/bun`, the existing domain's Certbot-managed TLS vhost, and no listener on port 3456. Recheck those facts before setup; they are not permission to change production. No setup or deploy has been executed for this change.

## One-time setup after authorization

Use `.deploy/config.sh` for the SSH target and key. Read the installed `/etc/nginx/sites-available/jevnotjev.breakoutwithai.com` first. Do not replace it with the repository HTTP-only template: that would remove Certbot's TLS configuration.

1. Confirm port 3456 is unused, the installed Bun supports the built server, and `www-data` exists. Capture the existing vhost and all co-tenant status codes using `.deploy/lib.sh` `list_neighbours` and `probe_neighbours`.
2. Install `.deploy/backstage.service` as `/etc/systemd/system/jevnotjev-backstage.service`. It runs as `www-data`, bound to loopback. Run `systemctl daemon-reload`; do not start it until a release exists.
3. Install `.deploy/backstage-nginx.conf` as `/etc/nginx/snippets/jevnotjev-backstage.conf`. Add exactly `include /etc/nginx/snippets/jevnotjev-backstage.conf;` inside this domain's existing HTTPS server block. Keep every certificate directive and other location unchanged. Review the installed diff. Do not edit another domain.
4. Run `nginx -t`. On failure restore the saved vhost before doing anything else. On success use `systemctl reload nginx`, never restart. Re-probe all neighbours. A changed neighbour means restore the vhost, validate it and reload again.
5. Run the guarded deployment below. Before the initial release starts, the new Backstage locations will return a gateway error; the main site continues to serve its static release. If setup is abandoned, restore the original vhost and reload after validation.

The MVP has no account service. For a private tester rollout, add an operator-managed nginx Basic Auth gate to BOTH Backstage locations, with credentials stored outside release artifacts. Do not put provider keys into that gate, server environment, shell arguments or files.

## Build and promote

Run the local test/typecheck/build gate before promotion. A production release requires a merged PR linked to #67, a clean checkout at freshly fetched `origin/main`, and separate deploy authorization.

```sh
.deploy/backstage-deploy.sh --dry-run
.deploy/backstage-deploy.sh
```

The helper rebuilds with `bun scripts/backstage-build.ts` on the workstation. The build produces `dist/backstage/site`, `server.js` and `release.json`; `.deploy/backstage-package.ts` rejects wrong version, missing browser/backend files, symlinks and unexpected files. The helper packages and verifies transferred archive bytes, then extracts under `/var/www/jevnotjev-backstage-releases/<SHA>`. Production never builds.

Activation swaps `/var/www/jevnotjev-backstage-current`, restarts only `jevnotjev-backstage`, checks the served API version, exact browser bundle bytes, page response, service status and co-tenants. Only then is `.verified` written with SHA, UTC time, actor and issue. No nginx reload is needed for subsequent releases. Keep previous releases; this helper does not prune them.

## Rollback

```sh
.deploy/backstage-deploy.sh --rollback FULL_PREVIOUS_SHA --dry-run
.deploy/backstage-deploy.sh --rollback FULL_PREVIOUS_SHA
```

Rollback requires the target's `.verified` marker and restores its complete browser/backend pair. Verification is the same as promotion. A failed promotion restores the previous pair and checks its API version. A failed first release stops only the Backstage service; restore the setup vhost backup if Backstage should be removed entirely. A failed rollback or unreachable host is reported for inspection, never treated as success.

## Live acceptance

Version and HTTP checks do not prove inference. After deployment, enter tester-owned keys in the browser and run an authorized small comparison. Download sanitized evidence, inspect actual model IDs/usage and apply human labels. This has provider charges and is distinct from the deterministic adapter tests. No live calls were made while preparing this deployment contract.
