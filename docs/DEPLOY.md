# Deploying jevnotjev.breakoutwithai.com

The site is the committed `site/` folder, served as static files by nginx on the shared
`breakout-apps` host (178.62.69.200). Scripts live in `.deploy/`, forked from lakelife's deploy
for the same host.

## One command per action

`.deploy/ship.sh` is the entrypoint for every module. It dispatches to the module scripts below
(each keeps its own release, verify and rollback logic) and owns the whole-stack view: drift
against `origin/main`, the skip of modules already current, and the release record.

**The standard deploy is `.deploy/ship.sh` with no flags.** "Deploy" means the whole stack at
`origin/main`; agents use the default and never narrow it to the module named earlier.

| Action | Command |
|---|---|
| Live state and drift, read-only | `.deploy/ship.sh --status` |
| One-time setup (static: vhost + TLS; backstage: user, unit, nginx include) | `.deploy/ship.sh --setup --module static` or `--module backstage`, each with `--dry-run` first |
| **Deploy the stack (standard)** | `.deploy/ship.sh --dry-run`, then `.deploy/ship.sh` |
| Deploy one module (refused while another module is stale) | `.deploy/ship.sh --module static` or `--module backstage` |
| Deploy one module, deliberately leaving another stale | `.deploy/ship.sh --module backstage --allow-drift` |
| Roll back static to the previous verified release | `.deploy/ship.sh --module static --rollback` |
| Roll back backstage to a verified release | `.deploy/ship.sh --module backstage --rollback <full SHA>` |

The default deploy fetches `origin/main` and refuses unless HEAD is that commit and the tracked
tree is clean. It then takes one host lock, `/var/lock/jevnotjev-ship`, held across every state
read, module deploy, final check and release record (a rollback takes it too; a held lock
refuses with exit 1). Per module it skips with `up to date` only when every observation names
`origin/main`: the served SHA, a verified current release, and that release's own identity
(static: its `DEPLOYED_SHA` marker; backstage: the release directory named by the SHA).
`backstage-deploy.sh` refuses to replace a verified live release, so the skip is required. The
rest deploy, static first. A static failure stops before backstage; a backstage failure leaves
the verified static release live. After every module succeeds, ship.sh re-reads the box with
the same test, else it exits 1 and records no release. A curl that fails is never parsed, even
when it delivered a complete body first.
`backstage-deploy.sh` also refuses until Backstage setup exists and unless HEAD's merged PR body
references #67; plain `ship.sh` then reports backstage FAILED with its exit code.

### Drift and `--status`

Module paths are defined once in `ship.sh`. Static is `site/` minus `site/backstage/`. Backstage
is `site/backstage/`, `scripts/backstage-build.ts`, `.deploy/backstage*`, `package.json`,
`bun.lock`, plus every source file the Backstage build bundles: `.deploy/backstage-deps.ts`
walks the import graph of the entrypoints in `scripts/backstage-build.ts` on a `git archive`
of `origin/main` (so `src/core/`, `src/format/` and `src/jev-answer.ts` count). If that graph
cannot be read, backstage drift is UNKNOWN. `.deploy/lib.sh` and `.deploy/config.sh` count for
both. `--status` prints, per module, the
served SHA, `main <sha>`, `drift`, `release <tag>` when a release tag points at the served SHA,
the current release directory, its verified marker, the service state, whether setup is present
and, for backstage, `auth yes|no|unknown`. With the Basic Auth gate on the host, every Backstage
read (status and the deploy's drift read) uses `BACKSTAGE_CURL_CONFIG`; without it no Backstage
probe is sent, backstage drift is UNKNOWN and `--status` fails naming the variable.

| drift | Meaning |
|---|---|
| `none` | serves `origin/main` |
| `none (sha differs, no module changes)` | serves an older SHA, but nothing under the module's paths changed since |
| `STALE (<n> commits behind; changed: <paths, max 10>)` | merged changes to this module are not live |
| `UNKNOWN (...)` | served SHA unreadable or not a known commit, `origin/main` unresolved or its fetch failed (the cached comparison is shown), a failed `git diff`, or an unreadable Backstage import graph |

`--status` exit 0 means no detected module drift: every module is `none`, which includes
`none (sha differs, no module changes)`, so it does not prove every module serves the exact
`origin/main` SHA. It exits 3 when any module is STALE or UNKNOWN (1 when the host cannot be
probed). `--module X` refuses with exit 4 when any other module is STALE or UNKNOWN, naming it
and its changed paths; `--allow-drift` overrides that for a deliberate partial deploy.

### Release tags

After a successful default deploy where every module serves the same SHA S, ship.sh records the
stack release: an annotated tag `vYYYY.MM.DD.N` (UTC date, N = 1 + the tags already on that
date) on S, whose message is a YAML block with `version`, `sha`, `utc`, `actor`,
`modules.static` (`served_sha`, `release_dir`), `modules.backstage` (`version`, `protocol`,
`catalogVersion`, `release_dir`), `prs` (`#N title` from first-parent commits in
`previous_tag..S`, all history for the first release) and `previous_tag`. It pushes only that
tag (`git push origin refs/tags/<v>`) and runs `gh release create <v> --verify-tag` with the same
metadata as notes. Only annotated tags named `vYYYY.MM.DD.N` count as releases (newest by
version order, so `.10` beats `.9`). If one already points at S, ship.sh creates no new tag but
still checks origin (`git ls-remote`) and the GitHub release (`gh release view`) and creates
whichever is missing, so a rerun after a failed push or `gh` call finishes the record. Release
files go to a private `mktemp -d` directory per run. A failed tag fetch, metadata generation or
write refuses before tagging; a tag, push or `gh` failure after a verified deploy exits 5 and
prints the exact, shell-quoted command that finishes the job; the deploy is never rolled back
for it. `--no-release` skips the record for
local testing only. `--dry-run` prints the per-module plan, drift and the tag it would create,
reads the box, and makes no tag, push or `gh` call.

| Exit | Meaning |
|---|---|
| 0 | done (or `--status`: no detected module drift) |
| 1 | preflight failed (HEAD not `origin/main`, tracked changes, fetch failed, ship lock held) or a module is not current at `origin/main` after the deploy |
| 2 | usage |
| 3 | `--status`: a module is STALE or UNKNOWN |
| 4 | `--module X` refused: another module is STALE or UNKNOWN |
| 5 | deploy verified and live, release record failed (recovery command printed) |
| other | the failing module script's own exit code |

Backstage specifics: `docs/backstage-deploy.md`.

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

Deploy the whole stack from a clean worktree pinned to `origin/main`. The worktree may be
detached or on a named branch (as `wt.sh new` creates) as long as HEAD is exactly the freshly
fetched `origin/main`; any other commit is refused:

```bash
git fetch origin main --no-tags
git worktree add --detach <dir> origin/main
<dir>/.deploy/ship.sh --dry-run
<dir>/.deploy/ship.sh
<dir>/.deploy/ship.sh --status    # exit 0: no detected module drift
```

Static runs `deploy.sh`, which refuses unless HEAD is `origin/main`, the tracked tree is clean, and
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
