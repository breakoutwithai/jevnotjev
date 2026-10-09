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

The stack is two modules: static (`site/`) and backstage (the Bun service, which also serves the
HTTP API under `/api/v1/`). The MCP server (`src/mcp/server.ts`) is a stdio server that runs on the
caller's machine (`docs/api.md` § MCP); there is nothing on the host to deploy for it.

| Action | Command |
|---|---|
| Live state and drift, read-only | `.deploy/ship.sh --status` |
| Live verify against the spec, read-only | `.deploy/ship.sh --verify` (or `--verify <SHA>`) |
| One-time setup (static: vhost + TLS; backstage: user, unit, nginx include) | `.deploy/ship.sh --setup --module static` or `--module backstage`, each with `--dry-run` first |
| **Deploy the stack (standard)** | `.deploy/ship.sh --dry-run`, then `.deploy/ship.sh` |
| Deploy without asking Jev (logged; the dependency check still runs) | `.deploy/ship.sh --no-jev` |
| Deploy one module (refused while another module is stale) | `.deploy/ship.sh --module static` or `--module backstage` |
| Deploy one module, deliberately leaving another stale | `.deploy/ship.sh --module backstage --allow-drift` |
| Roll back static to the previous verified release | `.deploy/ship.sh --module static --rollback` |
| Roll back backstage to a verified release | `.deploy/ship.sh --module backstage --rollback <full SHA>` |

The default deploy fetches `origin/main` and refuses unless HEAD is that commit and the tracked
tree is clean. It then runs the dependency check (below) and takes one host lock, `/var/lock/jevnotjev-ship`, held across every state
read, module deploy, final check and release record (a rollback takes it too; a held lock
refuses with exit 1). Per module it skips with `up to date` only when every observation names
`origin/main`: the served SHA, a verified current release, and that release's own identity
(static: its `DEPLOYED_SHA` marker; backstage: the release directory named by the SHA).
`backstage-deploy.sh` refuses to replace a verified live release, so the skip is required. The
rest deploy, static first. A static failure stops before backstage; a backstage failure leaves
the verified static release live. After every module succeeds, ship.sh re-reads the box with
the same test, else it exits 1 and records no release. A curl that fails is never parsed, even
when it delivered a complete body first.
`backstage-deploy.sh` also refuses until Backstage setup exists and unless a pull request merged
into main contains HEAD (`.deploy/backstage-merged-pr.ts`; no issue number is required, #91);
plain `ship.sh` then reports backstage FAILED with its exit code.
With the installed session gate, a promotion or rollback target must declare `"gate": "session"`
in `release.json`; the deploy refuses it before activation otherwise. Automatic fallback checks
the previous release the same way and stops the service if it cannot safely activate it. The
nginx snippet sets `X-Backstage-Gate: session` on both gated routes; the service uses that header
to enforce the session. The session probe mints inside the post-restart retry loop, so a stopped
or starting service can be replaced.

### Dependency check and Jev confirmation

Every deploy (not `--status`, `--verify`, `--setup` or `--rollback`) checks the tree it ships, after
the HEAD == `origin/main` preflight and before the host lock, in order:

1. `bun install --frozen-lockfile` (bun.lock agrees with package.json)
2. `bun run typecheck`
3. `bun scripts/gate.ts`, which must print `gate: PASS ... tests=N` with N > 0

A failure exits 1 naming the step, before any ssh to the host. The gate runs every suite, so this
step takes minutes.

After the drift read, ship.sh assembles a checklist of mechanical results (HEAD and `origin/main`
SHAs, clean tree, the three steps above with the gate's test count, each module's plan, served SHA
and drift, whether setup is present, whether the Backstage curl config is a private file) and asks
Jev one noul (yes/no) question: is the release ready to deploy given this checklist
(`scripts/deploy-checklist.ts`, pinned `jev-1.13.0`, answer checked by `src/jev-answer.ts`). Only
"yes" continues; "no", an unreachable API, an invalid answer or a missing key exits 1 before any
module script runs (the ship lock is released). The key is `JEV_API_KEY`, else `TYPESAFE_API_KEY`,
from the environment, else the same names or `JEV_API_KEY_JAYLO` from the primary checkout's
`.env.local`; only the variable name is printed. `--no-jev` skips the question and logs it; Jev is
not asked when every module is already up to date. The checklist and Jev's answer (or the skip)
go into the GitHub release notes. `--dry-run` prints the steps and the checklist and runs neither.

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
and, for backstage, `auth yes|session|no|unknown`. With either gate on the host, every Backstage
read (status and the deploy's drift read) uses `BACKSTAGE_CURL_CONFIG`; the session gate mints one
cookie and sends it on subsequent probes. Without the config no Backstage
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
probed). It then runs the live verify (below) with the selected modules expected at `origin/main`
and exits 6 when that fails, so `none (sha differs, no module changes)` with an older served SHA is
no longer exit 0. `--module X` refuses with exit 4 when any other module is STALE or UNKNOWN, naming it
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
whichever is missing, so a rerun after a failed push or `gh` call finishes the record. A tag
already on origin must be the same tag object as the local one and peel to S, and an existing
GitHub release must answer for that tag (a SHA target must be S); otherwise ship.sh exits 5
naming both SHAs, before any push or `gh` create. Release
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
| 6 | the live verify failed (`--verify`, or the closing check of a deploy, setup, rollback or `--status`) |
| other | the failing module script's own exit code |

Backstage specifics: `docs/backstage-deploy.md`.

## Backstage Basic Auth (staged rollout before the session setup)

Both Backstage locations require Basic Auth. Run these in order (full detail and the openssl
variant in `docs/backstage-deploy.md` § Sign-in gate):

```bash
# On the host as root (ssh -t), password typed at the prompt, tester replaced with the login
install -d -o root -g www-data -m 0750 /etc/jevnotjev-backstage && htpasswd -B -c /etc/jevnotjev-backstage/htpasswd tester && chown root:www-data /etc/jevnotjev-backstage/htpasswd && chmod 0640 /etc/jevnotjev-backstage/htpasswd
# On the workstation: private curl config holding the same login and password
d="$HOME/.config/jevnotjev"; mkdir -p "$d" && chmod 700 "$d" && t="$(mktemp "$d/.backstage-curl.XXXXXX")" && chmod 600 "$t" && read -r -s -p 'Backstage password: ' BP && echo && printf 'user = "tester:%s"\n' "$BP" > "$t" && mv -f "$t" "$d/backstage-curl"; unset BP
# Every .deploy script defaults BACKSTAGE_CURL_CONFIG to that file when the variable is unset
./.deploy/ship.sh --setup --module backstage --dry-run
./.deploy/ship.sh --setup --module backstage
# Both print 401
curl -s -o /dev/null -w '%{http_code}\n' https://jevnotjev.breakoutwithai.com/backstage/
curl -s -o /dev/null -w '%{http_code}\n' https://jevnotjev.breakoutwithai.com/api/backstage/health
```

Setup refuses, changing nothing, until the htpasswd is root:<nginx group> 0640 and non-empty, and
verifies after the reload that both routes answer 401 without credentials and reach the upstream with them,
restoring the previous nginx config otherwise. Backstage deploy, rollback and `--status` fail
naming `BACKSTAGE_CURL_CONFIG` when the host has the gate, the variable is unset and the default
file is absent.

After the sign-in-capable release is deployed and auth files are configured, setup replaces the
Basic snippet with the session snippet and verifies the session row of S2. The curl config then
holds an operators-file email and password. Deploy probes POST it through `--config` to
`/api/auth/password`, keep the returned session in a private temporary cookie jar, and remove
the jar at shell exit. The credential and cookie value never enter command arguments or output.

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

## Seams under test

Agreed on #84 (the operator approved S1-S3 as proposed). Deploy tests sit at these seams, and every
expected value in a seam test is a literal from this list or the spec line it cites, never a value
recomputed from the scripts.

- **S1 Operator command to served state.** After `.deploy/ship.sh` exits 0, every module serves `origin/main`: static `/DEPLOYED_SHA` and Backstage `/api/backstage/health` `version` both equal the `origin/main` SHA, and an annotated release tag `vYYYY.MM.DD.N` on origin points at it.
- **S2 Security invariants.** With gate `yes` (Basic), anonymous `/backstage/` and `/api/backstage/health` return 401; with `BACKSTAGE_CURL_CONFIG` both return 200 (502 only while no Backstage release exists). With gate `session`, anonymous `/backstage/` returns 302 with `Location` exactly `${HEALTH_URL}/backstage/sign-in?next=/backstage/` or `/backstage/sign-in?next=/backstage/`; anonymous `/api/backstage/health` returns 401 with a JSON content type and body exactly `{"code":"unauthenticated"}`, without `WWW-Authenticate`; anonymous `/backstage/sign-in` returns 200 containing `action="/api/auth/password"` and no Backstage app `id="sign-out"` markup; both a garbage cookie and a well-formed cookie with a wrong signature still return 302 and 401 on the gated page and API; a minted session returns 200 on both gated paths (502 only while no Backstage release exists). The public paths `/`, `/label/` and `/little-shop/` return 200.
- **S3 Co-tenant safety.** No other `server_name` on the host changes status across a deploy or setup (`docs/DEPLOY.md:164`, `docs/backstage-deploy.md:52`).

| Seam | Tests |
|---|---|
| S1 | `.deploy/tests/verify.test.sh`; the closing verify cases in `.deploy/tests/ship.test.sh` |
| S2 | `.deploy/tests/verify.test.sh`, `.deploy/tests/live-failures.test.sh` |
| S3 | `.deploy/tests/live-failures.test.sh` (replayed from fixtures), `.deploy/tests/backstage-setup.test.sh` |

## Live verify

`.deploy/ship.sh --verify [SHA]` is read-only (HTTP pinned to the host, a read of the installed
nginx snippet through SSH to determine the gate, plus `git ls-remote`)
and asserts S1 and S2 for the whole stack, one `PASS`/`FAIL` line per assertion, exit 6 on any
failure. SHA defaults to `origin/main` as fetched now: if the fetch fails it exits 6 rather than
verify against a cached ref, so pass the SHA explicitly to verify offline. Passing another SHA checks
a specific release (a wrong SHA is the negative control: it must fail). It needs
`BACKSTAGE_CURL_CONFIG`; without it the authenticated assertions fail by name. While a Backstage
release exists, a 502 on either authenticated route (page or health) is retried and both are re-read
(`VERIFY_ATTEMPTS`, default 5, every `VERIFY_SLEEP` seconds, default 2) because the service may be
starting; with no release, 502 is the spec answer (`docs/backstage-deploy.md:53`).

The same check closes every live action, which exits 6 when it fails:

| Action | Expected SHA | Asserted | Release tag |
|---|---|---|---|
| deploy (default) | every module at `origin/main` | gate and public paths, BEFORE the tag and GitHub release are published | verified on origin after publishing |
| deploy `--module X` or `--no-release` | the deployed module(s) at `origin/main` | gate (Backstage release state as observed) and public paths | not required |
| setup static | none (setup ships no release) | public paths only: 200, or 404 while static has no release (`.deploy/provision.sh:140`) | not required |
| setup backstage | none | the gate only; 502 accepted while no Backstage release exists | not required |
| rollback static | the rolled-back release's own `DEPLOYED_SHA` marker | gate and public paths | not required |
| rollback backstage | the given SHA | gate and public paths | not required |
| `--status` | the selected modules at `origin/main` | gate and public paths | required for the whole stack |

A deploy whose gate or public paths fail is never tagged or released: it exits 6 before
`release_record` runs.

## Fixtures

The deploy tests' curl double, `.deploy/tests/fixture-curl.sh`, answers from files under
`.deploy/tests/fixtures/<date>/`, not from responses written into the tests. The 2026-10-04 set is
transcribed or hand-built (see its `MANIFEST.md`) until the operator records the real host with the
read-only capture:

```bash
export BACKSTAGE_CURL_CONFIG="$HOME/.config/jevnotjev/backstage-curl"
.deploy/tests/capture-fixtures.sh --scan <path to the private public-scan.sh>
```

It writes `.deploy/tests/fixtures/<UTC date>/live/`, claimed with an atomic `mkdir` (an existing
directory, even empty, is refused). It is an ALLOWLIST: no raw `nginx -T`, snippet text or response
body is ever written. `scripts/capture-extract.ts` parses and validates the only facts kept:
`nginx.json` (server_name values and listen ports per server block, the `user` directive, and the
Backstage snippet's auth state and sha256), `neighbours.txt` (co-tenant hostnames), and `http/*.txt`
(status and curl exit per request; the only bodies are the `/DEPLOYED_SHA` value and the health
route reduced to `version`, `protocol`, `catalogVersion` and `trial.available`). Input that does not
parse into those shapes fails the capture; error messages never echo it. Everything is staged in a
private temporary directory and copied to its destination only when the scan exits 0 with an OK
verdict counting every file (a hit fails the capture: there is nothing raw to redact). Any failed
step or an interruption removes the staging directory and the claimed destination.

## Tests

Hermetic (no ssh, no network), bash 3.2 compatible. The gate runs every suite, Bun and shell, and
checks each file against its committed test-count floor:

```bash
bun scripts/gate.ts
```

## Overrides

| Variable | Default |
|---|---|
| `JEVNOTJEV_SSH_KEY` | `~/.ssh/cc-os-vanilla-audit-20260504` |
| `JEVNOTJEV_SERVER_HOST` | `178.62.69.200` |
| `JEVNOTJEV_SERVER_USER` | `root` |
| `DEPLOY_ALLOW_BRANCH` | `main` (the commit must still exist on a remote branch) |
| `CERTBOT_EMAIL` | none, required by `provision.sh` when a certificate is issued |
| `BACKSTAGE_CURL_CONFIG` | `$HOME/.config/jevnotjev/backstage-curl` when unset and that file exists (a set value, even empty, wins; the file must still be yours and mode 0600); required by Backstage setup, deploy, rollback, status and verify while the Basic or session gate is on the host |
| `JEV_API_KEY` / `TYPESAFE_API_KEY` | the deploy's Jev checklist key; else read from the primary checkout's `.env.local` (also `JEV_API_KEY_JAYLO`) |
