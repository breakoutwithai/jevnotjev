# Deploying jevnotjev.breakoutwithai.com

The site is the committed `site/` folder, served as static files by nginx on the shared
`breakout-apps` host (178.62.69.200). Scripts live in `.deploy/`, forked from lakelife's deploy
for the same host.

## First time only: vhost and certificate

```bash
./.deploy/preflight.sh                                  # read-only audit, mutates nothing
./.deploy/provision.sh --dry-run                        # what provisioning would do
CERTBOT_EMAIL=<acme contact> ./.deploy/provision.sh     # install vhost, nginx -t, reload, certbot
```

`provision.sh` installs only `/etc/nginx/sites-available/jevnotjev.breakoutwithai.com` (plus its
`sites-enabled` link), runs `nginx -t` before every reload, never restarts nginx, and issues a
certificate for this one domain. It refuses if DNS does not point at the host, and it refuses
without `CERTBOT_EMAIL` when a certificate is needed.

## Every deploy

Deploy from a clean worktree pinned to `origin/main`:

```bash
git fetch origin main --no-tags
git worktree add --detach <dir> origin/main
<dir>/.deploy/deploy.sh --dry-run
<dir>/.deploy/deploy.sh
```

The deploy refuses unless HEAD is `origin/main`, the tracked tree is clean, and
`/var/www/jevnotjev` is absent or a symlink into `/var/www/jevnotjev-releases`. It ships
`git archive HEAD:site` (checked against `git ls-files site/`) into a new release directory,
stamps `DEPLOYED_SHA`, swaps the symlink atomically, then checks:

- `https://jevnotjev.breakoutwithai.com/DEPLOYED_SHA` equals the shipped commit (pinned to the host IP)
- every shipped path returns 200
- every other `server_name` in `/etc/nginx/sites-enabled` returns the same status as before

Any failure after the swap restores the previous release. Three releases are kept, plus the
active and previous ones.

## Rollback

```bash
./.deploy/deploy.sh --rollback --dry-run
./.deploy/deploy.sh --rollback
```

Swaps to the newest other release that has a `DEPLOYED_SHA` marker and verifies the served SHA.

## Tests

Hermetic (no ssh, no network), bash 3.2 compatible:

```bash
for t in .deploy/tests/*.test.sh; do bash "$t" || echo "RED: $t"; done
```

## Overrides

| Variable | Default |
|---|---|
| `JEVNOTJEV_SSH_KEY` | `~/.ssh/cc-os-vanilla-audit-20260504` |
| `JEVNOTJEV_SERVER_HOST` | `178.62.69.200` |
| `JEVNOTJEV_SERVER_USER` | `root` |
| `DEPLOY_ALLOW_BRANCH` | `main` (the commit must still exist on a remote branch) |
| `CERTBOT_EMAIL` | none, required by `provision.sh` when a certificate is issued |
