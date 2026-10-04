# Deploying jevnotjev.breakoutwithai.com

The site is the committed `site/` folder, served as static files by nginx on the shared
`breakout-apps` host (178.62.69.200). Scripts live in `.deploy/`, forked from lakelife's deploy
for the same host.

## One command per action

`.deploy/ship.sh` is the entrypoint for every module. It dispatches to the module scripts below
and adds no release logic of its own.

| Action | Command |
|---|---|
| Live state, read-only | `.deploy/ship.sh --status` |
| One-time setup (static: vhost + TLS; backstage: user, unit, nginx include) | `.deploy/ship.sh --setup --module static` or `--module backstage`, each with `--dry-run` first |
| Deploy every module (static, then backstage) | `.deploy/ship.sh --dry-run`, then `.deploy/ship.sh` |
| Deploy one module | `.deploy/ship.sh --module static` or `.deploy/ship.sh --module backstage` |
| Roll back static to the previous verified release | `.deploy/ship.sh --module static --rollback` |
| Roll back backstage to a verified release | `.deploy/ship.sh --module backstage --rollback <full SHA>` |

`--module all` is the default. A static failure stops before backstage; a backstage failure
leaves the verified static release live. The exit code is the first failing module's own code.
`backstage-deploy.sh` refuses until Backstage setup exists and unless HEAD's merged PR body
references #67, so plain `ship.sh` reports backstage FAILED (non-zero) in either case; use
`--module static` for a static-only release.
`--status` prints, per module, the served SHA, the current release, its verified marker, the
service state and whether setup is present. Backstage specifics: `docs/backstage-deploy.md`.

## Backstage Basic Auth (before `--setup --module backstage`)

Both Backstage locations require Basic Auth. Run these in order (full detail and the openssl
variant in `docs/backstage-deploy.md` § Basic Auth gate):

```bash
# On the host as root (ssh -t), password typed at the prompt, tester replaced with the login
install -d -o root -g www-data -m 0750 /etc/jevnotjev-backstage && htpasswd -B -c /etc/jevnotjev-backstage/htpasswd tester && chown root:www-data /etc/jevnotjev-backstage/htpasswd && chmod 0640 /etc/jevnotjev-backstage/htpasswd
# On the workstation: private curl config holding the same login and password
d="$HOME/.config/jevnotjev"; mkdir -p "$d" && chmod 700 "$d" && t="$(mktemp "$d/.backstage-curl.XXXXXX")" && chmod 600 "$t" && read -r -s -p 'Backstage password: ' BP && echo && printf 'user = "tester:%s"\n' "$BP" > "$t" && mv -f "$t" "$d/backstage-curl"; unset BP
export BACKSTAGE_CURL_CONFIG="$HOME/.config/jevnotjev/backstage-curl"
./.deploy/ship.sh --setup --module backstage --dry-run
./.deploy/ship.sh --setup --module backstage
# Both print 401
curl -s -o /dev/null -w '%{http_code}\n' https://jevnotjev.breakoutwithai.com/backstage/
curl -s -o /dev/null -w '%{http_code}\n' https://jevnotjev.breakoutwithai.com/api/backstage/health
```

Setup refuses, changing nothing, until the htpasswd is root:<nginx group> 0640 and non-empty, and
verifies after the reload that both routes answer 401 without credentials and reach the upstream with them,
restoring the previous nginx config otherwise. Backstage deploy, rollback and `--status` fail
naming `BACKSTAGE_CURL_CONFIG` when the host has the gate and the variable is unset.

## First time only: vhost and certificate

```bash
./.deploy/preflight.sh                                                    # read-only audit
./.deploy/ship.sh --setup --module static --dry-run                       # what provisioning would do
CERTBOT_EMAIL=<acme contact> ./.deploy/ship.sh --setup --module static    # vhost, nginx -t, reload, certbot
```

`--setup --module static` runs `provision.sh`, which installs only `/etc/nginx/sites-available/jevnotjev.breakoutwithai.com` (plus its
`sites-enabled` link), runs `nginx -t` before every reload, never restarts nginx, and issues a
certificate for this one domain. It refuses if DNS does not point at the host, and it refuses
without `CERTBOT_EMAIL` when a certificate is needed.

## Every deploy

Deploy from a clean worktree pinned to `origin/main`:

```bash
git fetch origin main --no-tags
git worktree add --detach <dir> origin/main
<dir>/.deploy/ship.sh --module static --dry-run
<dir>/.deploy/ship.sh --module static
```

`--module static` runs `deploy.sh`.

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
./.deploy/ship.sh --module static --rollback --dry-run
./.deploy/ship.sh --module static --rollback
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
| `BACKSTAGE_CURL_CONFIG` | none, required by Backstage setup, deploy, rollback and status once the Basic Auth gate is on the host |
