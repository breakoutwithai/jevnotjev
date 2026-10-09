#!/usr/bin/env bash
#
# [T1] ship.sh: one entrypoint for every module. Flag validation, dispatch to the existing
# module scripts, module order and honest exit codes, a read-only --status with drift against
# origin/main, the full-stack default that skips modules already serving main, the partial
# deploy drift refusal, and the tagged release record.
#
# Every ship.sh case runs a COPY of the real ship.sh (plus the real config.sh, lib.sh and
# backstage-lib.sh) inside a throwaway git repository whose `origin` is a local bare repo, next
# to stub module scripts that record their arguments. `ssh`, `curl` and `gh` are fakes first on
# PATH; `git push` is intercepted and logged, every other git command is the real git. The host
# is pointed at TEST-NET (192.0.2.1) as a second guard. The --setup dry-run case runs the REAL
# backstage-setup.sh with the same fakes. Hermetic: no ssh, no network. Bash 3.2 compatible.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
REPO_ROOT="$(pwd)"
SHIP="${REPO_ROOT}/.deploy/ship.sh"
REAL_GIT="$(command -v git)"

pass=0; fail=0
ok()   { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }

export JEVNOTJEV_SERVER_HOST=192.0.2.1
unset BACKSTAGE_CURL_CONFIG
export FAKE_REPO="$REPO_ROOT"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
TODAY="$(date -u +%Y.%m.%d)"

# A remote command mutates when, after its harmless redirections are removed, it writes,
# moves, deletes, creates, or changes a service or nginx state.
is_mutating() {
    local c="$1"
    c="$(printf '%s' "$c" | sed -E 's#[0-9]?>&[0-9]##g; s#[0-9]?>[[:space:]]*/dev/null##g')"
    printf '%s' "$c" | grep -Eq '>|(^|[^a-z-])(mv|cp|rm|rmdir|ln|mkdir|touch|chmod|chown|tee|useradd|groupadd|install|tar)([[:space:]]|$)|systemctl[[:space:]]+(enable|disable|reload|restart|start|stop|daemon-reload)|nginx[[:space:]]+-s'
}

if [[ ! -f "$SHIP" ]]; then
    nope "missing ${SHIP}"
    echo "[T1] passed=${pass} failed=${fail}"; exit 1
fi

# ------------------------------------------------------------------ fakes on PATH
# Built once. Every fake logs to files under $FAKE_STATE, which each fixture points at its own dir.
FAKEBIN="$(mktemp -d)"
cat > "${FAKEBIN}/ssh" <<'EOF'
#!/usr/bin/env bash
# Fake ssh: the remote command is the last argument. Log it, never run it, answer canned text.
cmd="${@: -1}"
printf '%s\n---\n' "$cmd" >> "${FAKE_STATE}/ssh.log"
st() { cat "${FAKE_STATE}/$1" 2>/dev/null || printf '%s' "$2"; }
case "$cmd" in
    "echo ok") echo ok ;;
    "mkdir /var/lock/jevnotjev-ship") [ -z "${FAKE_SHIP_LOCK_HELD:-}" ] || exit 1 ;;
    "rmdir /var/lock/jevnotjev-ship") ;;
    *"uname -m"*)
        printf '%s\n' arch=x86_64 bun=1.3.0 user=absent port=free unit=absent journald=absent snippet=absent \
            vhost=present vhost_link=yes include=absent enabled=no active=no \
            ht_tool=htpasswd nginx_group=www-data htpasswd=root:www-data:640:44 htpasswd_dir=root:www-data:750 \
            auth_request=yes session_check=401 auth_env=root:root:600:64 auth_secret=1 auth_trust_proxy=1 operators=jevnotjev-backstage:jevnotjev-backstage:600:64 ;;
    "S='/etc/nginx/snippets/jevnotjev-backstage.conf'"*)
        # The installed snippet: the repo copy (auth), auth switched off, unreadable, or absent.
        case "${FAKE_AUTH:-}" in
            1) printf '%s\n' 'location ^~ /backstage/ { auth_basic "Backstage"; auth_basic_user_file /tmp/htpasswd; }' 'location ^~ /api/backstage/ { auth_basic "Backstage"; auth_basic_user_file /tmp/htpasswd; }' ;;
            off) printf '%s\n' 'location ^~ /backstage/ { auth_basic off; auth_basic_user_file /tmp/htpasswd; }' 'location ^~ /api/backstage/ { auth_basic off; auth_basic_user_file /tmp/htpasswd; }' ;;
            session) cat "${FAKE_REPO}/.deploy/backstage-nginx.conf" ;;
            readfail) echo 'cat: Permission denied' >&2; exit 1 ;;
            *) exit 10 ;;
        esac ;;
    *"jevnotjev-backstage-current"*)
        s="$(st backstage_served none)"
        if [ "$s" = none ]; then rel=none; else rel="/var/www/jevnotjev-backstage-releases/${s}"; fi
        rel="$(st backstage_release "$rel")"
        printf '%s\n' "release=${rel}" "verified=$(st backstage_verified yes)" \
            "service=active, enabled" "setup=$(st backstage_setup yes)" ;;
    *"/var/www/jevnotjev"*)
        s="$(st static_served none)"
        if [ "$s" = none ]; then rel=none; else rel="/var/www/jevnotjev-releases/20261003T203100Z-${s:0:7}"; fi
        printf '%s\n' "release=${rel}" "marker=$(st static_marker "$s")" \
            "verified=$(st static_verified yes)" "service=nginx active" setup=yes ;;
    "cat '/etc/nginx/sites-available/jevnotjev.breakoutwithai.com'")
        printf '%s\n' 'server {' '    server_name jevnotjev.breakoutwithai.com;' '    root /var/www/jevnotjev;' \
            '    listen 443 ssl; # managed by Certbot' '}' 'server {' '    listen 80;' '    return 404;' '}' ;;
    *"sites-enabled/*"*) printf '%s\n' 'server { server_name a.example.com; }' ;;
esac
exit 0
EOF
cat > "${FAKEBIN}/curl" <<EOF
#!/usr/bin/env bash
# curl answers from fixtures (fixture-curl.sh, #86). A host whose installed snippet carries auth
# (FAKE_AUTH=1, the fixture default) answers from the gated scenario; any other host serves the
# Backstage routes without auth, as recorded live on 2026-10-04 (no-auth scenario).
F="${REPO_ROOT}/.deploy/tests/fixtures/2026-10-04"
if [ "\${FAKE_AUTH:-}" = session ]; then export FIXTURE_DIRS="\${FAKE_SESSION_FIXTURE}:\$F/gated"
elif [ "\${FAKE_AUTH:-}" = 1 ]; then export FIXTURE_DIRS="\$F/gated"; else export FIXTURE_DIRS="\$F/no-auth:\$F/gated"; fi
# FIXTURE_EXTRA names one more scenario searched first (e.g. no-static-release).
[ -z "\${FIXTURE_EXTRA:-}" ] || export FIXTURE_DIRS="\$F/\${FIXTURE_EXTRA}:\${FIXTURE_DIRS}"
# A complete body followed by a transfer error (e.g. Content-Length mismatch).
[ -z "\${FAKE_CURL_PARTIAL:-}" ] || export FAKE_CURL_EXIT=18
exec bash "${REPO_ROOT}/.deploy/tests/fixture-curl.sh" "\$@"
EOF
cat > "${FAKEBIN}/gh" <<'EOF'
#!/usr/bin/env bash
# `gh release view` answers whether the release exists (FAKE_GH_VIEW_RC, default 1 = absent) and,
# when it does, "<tagName> <targetCommitish>" (FAKE_GH_VIEW_TAG / FAKE_GH_VIEW_TARGET).
if [ "${1:-} ${2:-}" = "release view" ]; then
    printf 'gh %s\n' "$*" >> "${FAKE_STATE}/gh-view.log"
    rc="${FAKE_GH_VIEW_RC:-1}"
    [ "$rc" != 0 ] || printf '%s %s\n' "${FAKE_GH_VIEW_TAG:-$3}" "${FAKE_GH_VIEW_TARGET:-main}"
    exit "$rc"
fi
printf 'gh %s\n' "$*" >> "${FAKE_STATE}/gh.log"
prev=""
for a in "$@"; do
    [ "$prev" = "--notes-file" ] && cp "$a" "${FAKE_STATE}/notes.md"
    prev="$a"
done
exit "${STUB_RC_GH:-0}"
EOF
cat > "${FAKEBIN}/git" <<EOF
#!/usr/bin/env bash
# git push is logged and never reaches a remote; every other git command is the real git,
# except the failures a case injects (diff, log, the tag fetch).
case "\${1:-}" in
    push)
        # Logged; a success really pushes to the fixture's local bare origin, so the closing
        # verify can see the release tag there.
        printf 'git %s\n' "\$*" >> "\${FAKE_STATE}/push.log"
        [ "\${STUB_RC_PUSH:-0}" = 0 ] || exit "\${STUB_RC_PUSH}"
        exec "${REAL_GIT}" "\$@" >/dev/null 2>&1 ;;
    diff) [ -z "\${FAKE_GIT_DIFF_FAIL:-}" ] || exit 128 ;;
    log) [ -z "\${FAKE_GIT_LOG_FAIL:-}" ] || exit 128 ;;
    status)
        # FAKE_GIT_STATUS_FAIL_FROM=N: the Nth and later \`git status\` calls exit 128 with no output.
        if [ -n "\${FAKE_GIT_STATUS_FAIL_FROM:-}" ]; then
            n=\$(( \$(cat "\${FAKE_STATE}/git-status.n" 2>/dev/null || echo 0) + 1 ))
            echo "\$n" > "\${FAKE_STATE}/git-status.n"
            [ "\$n" -lt "\${FAKE_GIT_STATUS_FAIL_FROM}" ] || { echo 'fatal: injected git status failure' >&2; exit 128; }
        fi ;;
    fetch) case "\$*" in *refs/tags/*)
        [ -z "\${FAKE_GIT_TAGFETCH_FAIL:-}" ] || exit 1
        # The race: a remote tag created after this fetch is not seen locally.
        [ -z "\${FAKE_GIT_TAGFETCH_NOOP:-}" ] || exit 0 ;; esac ;;
esac
exec "${REAL_GIT}" "\$@"
EOF
REAL_BUN="$(command -v bun)"
cat > "${FAKEBIN}/bun" <<EOF
#!/usr/bin/env bash
# The dependency check and the Jev checklist question are faked here so a test never runs the real
# test gate (which runs this file) or calls Jev. Each logs to bun.log; FAKE_BUN_*_RC fail a step.
# Every other bun command (bun -e, backstage-deps.ts) is the real bun.
log() { printf '%s\n' "\$ORIG" >> "\${FAKE_STATE}/bun.log"; }
# The log keeps the full invocation (e.g. --no-env-file); dispatch ignores that one flag.
ORIG="\$*"
# bun-env.log: per invocation, the deploy's own state variables this bun process inherited.
printf '%s\t%s\n' "\$ORIG" "\$(env | grep -E '^BACKSTAGE_(GATE|SESSION_JAR|CURL_CONFIG)=' | sort | tr '\n' ' ')" >> "\${FAKE_STATE}/bun-env.log"
[ "\${1:-}" != --no-env-file ] || shift
case "\${1:-} \${2:-}" in
    "install --frozen-lockfile") log "\$*"; echo "\${FAKE_BUN_INSTALL_OUT:-installed}"; exit "\${FAKE_BUN_INSTALL_RC:-0}" ;;
    "run typecheck") log "\$*"; exit "\${FAKE_BUN_TYPECHECK_RC:-0}" ;;
    "scripts/gate.ts ")
        log "\$*"
        echo "   7 /    7  .deploy/tests/ship.test.sh"
        echo "\${FAKE_GATE_LINE:-gate: PASS files=3 tests=42}"
        # The checkout changing while the gate runs: a new commit, or a tracked edit.
        if [ -n "\${FAKE_GATE_ADVANCES_HEAD:-}" ]; then
            echo moved >> README && "${REAL_GIT}" commit -qam "moved during the gate" >/dev/null 2>&1
        fi
        [ -z "\${FAKE_GATE_DIRTIES_TREE:-}" ] || echo dirty >> README
        exit "\${FAKE_BUN_GATE_RC:-0}" ;;
    "scripts/deploy-checklist.ts --checklist")
        log "\$*"
        cp "\$3" "\${FAKE_STATE}/checklist.txt"
        echo "Release checklist:"; sed 's/^/  /' "\$3"
        echo "jev: \${FAKE_JEV_ANSWER:-yes} (p(yes)=0.930, jev-1.13.0); key from JEV_API_KEY (process env)"
        exit "\${FAKE_JEV_RC:-0}" ;;
esac
exec "${REAL_BUN}" "\$@"
EOF
chmod +x "${FAKEBIN}/ssh" "${FAKEBIN}/curl" "${FAKEBIN}/gh" "${FAKEBIN}/git" "${FAKEBIN}/bun"
KEY="${FAKEBIN}/key"; : > "$KEY"
export JEVNOTJEV_SSH_KEY="$KEY"

# ------------------------------------------------------------------ repo fixture
# History on main (origin is a local bare repo):
#   C0  site/index.html + site/backstage/app.js + README   "chore: base (#10)"
#   C1  site/label/page.html          "feat: label page (#11)"   (static change)
#   C2  README only                   "docs: readme (#12)"       (no module change) = main
# Default served state: both modules serve C1 -> drift none (sha differs, no module changes),
# so the default deploys both. Stub module scripts record "<name> <args>" in calls.log and, on a
# real (non dry-run) success, make the fake box serve origin/main unless STUB_NO_UPDATE is set.
make_fixture() {
    FIX="$(mktemp -d)"
    FAKE_STATE="${FIX}/state"; mkdir -p "$FAKE_STATE"; export FAKE_STATE
    WORK="${FIX}/work"
    "$REAL_GIT" init -q --bare --initial-branch=main "${FIX}/origin.git"
    "$REAL_GIT" init -q --initial-branch=main "$WORK"
    (
        cd "$WORK" || exit 1
        "$REAL_GIT" config user.name "Fixture Actor"
        "$REAL_GIT" config commit.gpgsign false
        "$REAL_GIT" config tag.gpgsign false
        mkdir -p site/backstage src/backstage src/core
        echo index > site/index.html; echo app > site/backstage/app.js; echo readme > README
        # Backstage sources: main.ts imports src/core/verdict.ts; src/other.ts is outside the build.
        printf '%s\n' 'import { verdict } from "../core/verdict.ts";' 'export const page = verdict;' > src/backstage/main.ts
        printf '%s\n' 'export const server = 1;' > src/backstage/server.ts
        printf '%s\n' 'export const verdict = 1;' > src/core/verdict.ts
        printf '%s\n' 'export const other = 1;' > src/other.ts
        # The real build script, committed: drift reads its entrypoints from the archived revision.
        mkdir -p scripts; cp "${REPO_ROOT}/scripts/backstage-build.ts" scripts/
        "$REAL_GIT" add -A && "$REAL_GIT" commit -qm "chore: base (#10)"
        mkdir -p site/label; echo label > site/label/page.html
        "$REAL_GIT" add -A && "$REAL_GIT" commit -qm "feat: label page (#11)"
        echo readme2 > README
        "$REAL_GIT" add -A && "$REAL_GIT" commit -qm "docs: readme (#12)"
        "$REAL_GIT" remote add origin "${FIX}/origin.git"
        "$REAL_GIT" push -q origin main
        "$REAL_GIT" fetch -q origin
        "$REAL_GIT" branch -q --set-upstream-to=origin/main main
        printf '%s\n' .deploy/ >> .git/info/exclude
    ) >/dev/null 2>&1
    C0="$("$REAL_GIT" -C "$WORK" rev-parse HEAD~2)"
    C1="$("$REAL_GIT" -C "$WORK" rev-parse HEAD~1)"
    C2="$("$REAL_GIT" -C "$WORK" rev-parse HEAD)"
    mkdir -p "${WORK}/.deploy"
    cp "$SHIP" "${REPO_ROOT}/.deploy/config.sh" "${REPO_ROOT}/.deploy/lib.sh" \
        "${REPO_ROOT}/.deploy/backstage-lib.sh" "${REPO_ROOT}/.deploy/backstage-deps.ts" \
        "${REPO_ROOT}/.deploy/verify-lib.sh" "${WORK}/.deploy/"
    # The host behind the Basic Auth gate with the private curl config set: the state the closing
    # verify requires (S2). Cases about an ungated host or a missing config override both.
    export FAKE_AUTH=1 VERIFY_SLEEP=0
    ( umask 077; : > "${FIX}/curl-config" )
    export BACKSTAGE_CURL_CONFIG="${FIX}/curl-config"
    # Release files and every other temp file of this fixture stay inside it.
    export TMPDIR="${FIX}/tmp"; mkdir -p "$TMPDIR"
    CALLS="${FIX}/calls.log"; : > "$CALLS"
    local s var mod
    for s in deploy backstage-deploy provision backstage-setup; do
        var="STUB_RC_$(printf '%s' "$s" | tr 'a-z-' 'A-Z_')"
        mod=""
        [[ "$s" == deploy ]] && mod=static
        [[ "$s" == backstage-deploy ]] && mod=backstage
        cat > "${WORK}/.deploy/${s}.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "${s}.sh \$*" >> "${CALLS}"
rc="\${${var}:-0}"
case " \$* " in *" --dry-run "*) exit "\$rc" ;; esac
case " \$* " in *" --rollback "*)
    # A successful backstage rollback serves the SHA it was given.
    if [ "\$rc" = 0 ] && [ "${mod}" = backstage ] && [ -n "\${2:-}" ] && [ -z "\${STUB_NO_UPDATE:-}" ]; then echo "\$2" > "${FAKE_STATE}/backstage_served"; fi
    exit "\$rc" ;;
esac
if [ "\$rc" = 0 ] && [ -n "${mod}" ] && [ -z "\${STUB_NO_UPDATE:-}" ]; then
    git -C "\$(dirname "\$0")/.." rev-parse origin/main > "${FAKE_STATE}/${mod}_served"
    rm -f "${FAKE_STATE}/${mod}_marker" "${FAKE_STATE}/${mod}_release"
    echo yes > "${FAKE_STATE}/${mod}_verified"
fi
exit "\$rc"
EOF
    done
    serve static "$C1"; serve backstage "$C1"
}
ORIG_TMPDIR="${TMPDIR:-/tmp}"
drop_fixture() { export TMPDIR="$ORIG_TMPDIR"; [[ -n "${FIX:-}" && -d "$FIX" ]] && rm -rf "$FIX"; }
serve() { printf '%s\n' "$2" > "${FAKE_STATE}/$1_served"; }
fake() { printf '%s\n' "$2" > "${FAKE_STATE}/$1"; }
# Commit one file change on main and push it to the bare origin; prints the new SHA.
advance_main() {
    (
        cd "$WORK" || exit 1
        mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"
        "$REAL_GIT" add -A && "$REAL_GIT" commit -qm "$3" && "$REAL_GIT" push -q origin main
    ) >/dev/null 2>&1
    "$REAL_GIT" -C "$WORK" rev-parse HEAD
}
calls() { tr '\n' '|' < "$CALLS"; }
ship() { (cd "$WORK" && PATH="${FAKEBIN}:${PATH}" bash .deploy/ship.sh "$@"); }
tags() { "$REAL_GIT" -C "$WORK" tag -l | tr '\n' ' '; }
pushes() { cat "${FAKE_STATE}/push.log" 2>/dev/null; }
ghcalls() { cat "${FAKE_STATE}/gh.log" 2>/dev/null; }
# Exact field lines per module section: a value that appears elsewhere cannot satisfy them.
section() { printf '%s\n' "$out" | awk -v m="$1" '$0 == m {on=1; next} /^[a-z]/ {on=0} on'; }
# Remote commands from ssh.log that mutate.
mutating_commands() {
    local line buf=""
    [[ -f "${FAKE_STATE}/ssh.log" ]] || return 0
    while IFS= read -r line; do
        if [[ "$line" == "---" ]]; then
            is_mutating "$buf" && printf '%s\n' "$buf"
            buf=""
        else
            buf="${buf}${buf:+ }${line}"
        fi
    done < "${FAKE_STATE}/ssh.log"
}

echo "[T1] ship.sh flag validation"

make_fixture
out="$(ship --module nonsense 2>&1)"; rc=$?
[[ $rc -eq 2 && "$out" == *"Usage:"* && -z "$(calls)" ]] \
    && ok "unknown --module exits 2 with usage and dispatches nothing" \
    || nope "unknown --module: rc=${rc}, calls '$(calls)', out: ${out}"
out="$(ship --module 2>&1)"; rc=$?
[[ $rc -eq 2 && -z "$(calls)" ]] && ok "--module with no value exits 2" || nope "--module without value: rc=${rc}"
out="$(ship --frobnicate 2>&1)"; rc=$?
[[ $rc -eq 2 && "$out" == *"Usage:"* && -z "$(calls)" ]] \
    && ok "an unknown flag exits 2 and never means 'deploy'" || nope "unknown flag: rc=${rc}, calls '$(calls)'"
out="$(ship --status --setup 2>&1)"; rc=$?
[[ $rc -eq 2 && -z "$(calls)" ]] && ok "two actions at once (--status --setup) exit 2" || nope "two actions: rc=${rc}"
out="$(ship --rollback 2>&1)"; rc=$?
[[ $rc -eq 2 && -z "$(calls)" ]] && ok "--rollback with the default --module all exits 2 (rollback is per module)" || nope "--rollback all: rc=${rc}"
out="$(ship --module backstage --rollback 2>&1)"; rc=$?
[[ $rc -eq 2 && -z "$(calls)" ]] && ok "backstage --rollback without a SHA exits 2" || nope "backstage rollback no SHA: rc=${rc}"
out="$(ship --module backstage --rollback abc123 2>&1)"; rc=$?
[[ $rc -eq 2 && -z "$(calls)" ]] && ok "backstage --rollback with a short SHA exits 2" || nope "short SHA: rc=${rc}"
out="$(ship --module static --rollback 0123456789abcdef0123456789abcdef01234567 2>&1)"; rc=$?
[[ $rc -eq 2 && "$out" == *"previous verified release"* && -z "$(calls)" ]] \
    && ok "static --rollback with a SHA exits 2 (static selects the previous verified release)" \
    || nope "static rollback with SHA: rc=${rc}, out: ${out}"

out="$(ship --help 2>&1)"; rc=$?
help_ok=true
for want in "--module static|backstage|all" "--dry-run" "--status" "--setup" "--rollback" "--allow-drift" "--no-release"; do
    [[ "$out" == *"$want"* ]] || help_ok=false
done
[[ $rc -eq 0 && "$help_ok" == true && -z "$(calls)" ]] \
    && ok "--help lists --module, --dry-run, --status, --setup, --rollback, --allow-drift, --no-release" \
    || nope "--help rc=${rc}: ${out}"
drop_fixture

echo
echo "[T1] ship.sh dispatch"

make_fixture
ship --module static --dry-run >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "deploy.sh --dry-run|" ]] \
    && ok "--module static --dry-run calls only deploy.sh --dry-run" \
    || nope "static dry-run: rc=${rc}, calls '$(calls)'"
drop_fixture

make_fixture
ship --module backstage >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "backstage-deploy.sh |" ]] \
    && ok "--module backstage calls only backstage-deploy.sh with no flags (static drift is none)" \
    || nope "backstage: rc=${rc}, calls '$(calls)'"
drop_fixture

make_fixture
ship --no-release >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "deploy.sh |backstage-deploy.sh |" ]] \
    && ok "default (--module all) runs static first, then backstage" \
    || nope "all: rc=${rc}, calls '$(calls)'"
drop_fixture

make_fixture
out="$(STUB_RC_BACKSTAGE_DEPLOY=1 ship --module all 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(calls)" == "deploy.sh |backstage-deploy.sh |" && "$out" == *"static"*"OK"* && "$out" == *"backstage"*"FAILED"* && -z "$(tags)" ]] \
    && ok "--module all: a backstage failure leaves the verified static release alone, exits non-zero, tags nothing" \
    || nope "backstage fail: rc=${rc}, calls '$(calls)', tags '$(tags)', out: ${out}"
drop_fixture

make_fixture
out="$(STUB_RC_DEPLOY=3 ship --module all 2>&1)"; rc=$?
[[ $rc -eq 3 && "$(calls)" == "deploy.sh |" && "$out" == *"backstage"*"SKIPPED"* ]] \
    && ok "--module all: a static failure stops before backstage and exits with the static rc (3)" \
    || nope "static fail: rc=${rc}, calls '$(calls)', out: ${out}"
drop_fixture

make_fixture
STUB_RC_BACKSTAGE_DEPLOY=4 ship --module backstage >/dev/null 2>&1; rc=$?
[[ $rc -eq 4 ]] \
    && ok "the wrapper exits with the module's own status (4), not a later step's" \
    || nope "wrapper rc=${rc}, expected 4"
drop_fixture

make_fixture
ship --module static --rollback --dry-run >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "deploy.sh --rollback --dry-run|" ]] \
    && ok "static --rollback --dry-run dispatches deploy.sh --rollback --dry-run" \
    || nope "static rollback: calls '$(calls)'"
drop_fixture

SHA40=0123456789abcdef0123456789abcdef01234567
make_fixture
ship --module backstage --rollback "$SHA40" >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "backstage-deploy.sh --rollback ${SHA40}|" ]] \
    && ok "backstage --rollback <SHA> dispatches backstage-deploy.sh --rollback <SHA>" \
    || nope "backstage rollback: calls '$(calls)'"
drop_fixture

make_fixture
ship --setup --module backstage >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "backstage-setup.sh |" ]] \
    && ok "--setup --module backstage dispatches backstage-setup.sh only" \
    || nope "setup backstage: calls '$(calls)'"
drop_fixture

make_fixture
ship --setup --module static >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "provision.sh |" ]] \
    && ok "--setup --module static dispatches provision.sh (vhost + TLS)" \
    || nope "setup static: calls '$(calls)'"
drop_fixture

echo
echo "[T1] --dry-run on every mutating action reaches every module script as --dry-run"
all_dry=true
for action in "" "--setup" "--module static --rollback" "--module backstage --rollback ${SHA40}"; do
    make_fixture
    # shellcheck disable=SC2086
    ship $action --dry-run >/dev/null 2>&1 || all_dry=false
    [[ -s "$CALLS" ]] || all_dry=false
    while IFS= read -r line; do
        [[ "$line" == *"--dry-run"* ]] || { all_dry=false; echo "    not dry: ${line} (action '${action}')"; }
    done < "$CALLS"
    drop_fixture
done
$all_dry && ok "deploy, setup and both rollbacks pass --dry-run to every module script they call" \
    || nope "a mutating action reached a module script without --dry-run"

echo
echo "[T1] R3 --status: drift against origin/main, read-only"

make_fixture
serve static "$C0"; serve backstage "$C1"
out="$(ship --status 2>&1)"; rc=$?
n_cmds="$(grep -c '^---$' "${FAKE_STATE}/ssh.log" 2>/dev/null || echo 0)"
mut="$(mutating_commands)"
[[ $rc -eq 3 && "$n_cmds" -gt 0 && -z "$mut" && -z "$(pushes)" && -z "$(ghcalls)" ]] \
    && ok "--status with a STALE module exits 3, issued ${n_cmds} remote command(s), zero mutating" \
    || nope "--status stale: rc=${rc}, ${n_cmds} command(s), mutating: ${mut:-none}; out: ${out}"
st="$(section static)"; bs="$(section backstage)"
printf '%s\n' "$st" | grep -Eq "^  served +${C0}$" \
    && printf '%s\n' "$st" | grep -Eq "^  main +${C2}$" \
    && printf '%s\n' "$st" | grep -Eq '^  drift +STALE \(2 commits behind; changed: site/label/page.html\)$' \
    && printf '%s\n' "$st" | grep -Eq '^  verified +yes$' && printf '%s\n' "$st" | grep -Eq '^  setup +yes$' \
    && ok "--status static: served from curl, main, drift STALE with commit count and changed paths" \
    || nope "--status static section wrong: ${st}"
printf '%s\n' "$bs" | grep -Eq "^  served +${C1}$" \
    && printf '%s\n' "$bs" | grep -Eq '^  drift +none \(sha differs, no module changes\)$' \
    && ok "--status backstage: served != main with no backstage path change is drift none (sha differs)" \
    || nope "--status backstage section wrong: ${bs}"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C1"
out="$(ship --status 2>&1)"; rc=$?
st="$(section static)"
[[ $rc -eq 6 ]] && printf '%s\n' "$st" | grep -Eq '^  drift +none$' \
    && [[ "$out" == *"PASS S1 static /DEPLOYED_SHA ${C2}"* && "$out" == *"FAIL S1 backstage version: expected ${C2}, served ${C1}"* ]] \
    && ok "--status: no module STALE, but backstage serves an older SHA, so the closing verify exits 6 naming it (S1)" \
    || nope "--status none: rc=${rc}; out: ${out}"
"$REAL_GIT" -C "$WORK" tag -a v2026.01.01.1 -m r "$C2" && "$REAL_GIT" -C "$WORK" push -q origin refs/tags/v2026.01.01.1 >/dev/null 2>&1
serve backstage "$C2"
out="$(ship --status 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"verify: 10 passed, 0 failed"* ]] \
    && ok "--status exits 0 only when every module serves origin/main, the gate holds and the release tag is on origin" \
    || nope "--status all green: rc=${rc}; out: ${out}"
drop_fixture

make_fixture
serve static "$C2"; serve backstage none; echo no > "${FAKE_STATE}/backstage_setup"
out="$(ship --status 2>&1)"; rc=$?
bs="$(section backstage)"
[[ $rc -eq 3 ]] && printf '%s\n' "$bs" | grep -Eq '^  served +none$' \
    && printf '%s\n' "$bs" | grep -Eq '^  drift +UNKNOWN' && printf '%s\n' "$bs" | grep -Eq '^  setup +no$' \
    && ok "--status: an unserved backstage reports served none, drift UNKNOWN, setup no, and exits 3" \
    || nope "--status unknown: rc=${rc}; ${bs}"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
"$REAL_GIT" -C "$WORK" tag -a v2026.01.01.1 -m r "$C2"
out="$(ship --status --module backstage 2>&1)"; rc=$?
bs="$(section backstage)"
printf '%s\n' "$bs" | grep -Eq "^  served +${C2}$" \
    && printf '%s\n' "$bs" | grep -Eq '^  release +v2026.01.01.1$' \
    && ok "--status names the release tag on the served SHA (nested versions are dropped at capture: scripts/capture-extract.test.ts)" \
    || nope "--status release tag missing: ${bs}"
drop_fixture

echo
echo "[T1] R4 default deploy skips modules already serving origin/main"

make_fixture
serve static "$C2"; serve backstage "$C2"
out="$(ship --no-release 2>&1)"; rc=$?
[[ $rc -eq 0 && -z "$(calls)" && "$(printf '%s\n' "$out" | grep -c 'up to date')" -ge 2 ]] \
    && ok "both modules at main and verified: both skipped 'up to date', no module script called" \
    || nope "both current: rc=${rc}, calls '$(calls)', out: ${out}"
drop_fixture

make_fixture
serve static "$C0"; serve backstage "$C2"
out="$(ship --no-release 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(calls)" == "deploy.sh |" ]] \
    && ok "static stale + backstage current: only static is deployed" \
    || nope "static stale: rc=${rc}, calls '$(calls)', out: ${out}"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"; echo no > "${FAKE_STATE}/static_verified"
ship --no-release >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "deploy.sh |" ]] \
    && ok "a module serving main but unverified is deployed, not skipped" \
    || nope "unverified: rc=${rc}, calls '$(calls)'"
drop_fixture

make_fixture
out="$(STUB_NO_UPDATE=1 ship 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"not serving origin/main"* && -z "$(tags)" && -z "$(pushes)" ]] \
    && ok "module scripts exit 0 but the box still serves an old SHA: exit non-zero, no release" \
    || nope "post-check: rc=${rc}, tags '$(tags)', out: ${out}"
drop_fixture

echo
echo "[T1] R5 partial deploy refuses to leave another module stale"

make_fixture
serve static "$C0"; serve backstage "$C1"
out="$(ship --module backstage 2>&1)"; rc=$?
[[ $rc -eq 4 && -z "$(calls)" && "$out" == *"static"*"STALE"* && "$out" == *"site/label/page.html"* ]] \
    && ok "--module backstage with static STALE exits 4, names static and its changed paths, deploys nothing" \
    || nope "partial refuse: rc=${rc}, calls '$(calls)', out: ${out}"
drop_fixture

make_fixture
serve static "$C0"; serve backstage "$C1"
out="$(ship --module backstage --allow-drift 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(calls)" == "backstage-deploy.sh |" && -z "$(tags)" ]] \
    && ok "--module backstage --allow-drift deploys backstage only and creates no release" \
    || nope "allow-drift: rc=${rc}, calls '$(calls)', tags '$(tags)', out: ${out}"
drop_fixture

echo
echo "[T1] R6 release record after a verified full-stack deploy"

make_fixture
out="$(ship 2>&1)"; rc=$?
v="v${TODAY}.1"
msg="$("$REAL_GIT" -C "$WORK" for-each-ref --format='%(contents)' "refs/tags/${v}")"
[[ $rc -eq 0 && "$("$REAL_GIT" -C "$WORK" cat-file -t "$v" 2>/dev/null)" == tag \
   && "$("$REAL_GIT" -C "$WORK" rev-parse "${v}^{commit}" 2>/dev/null)" == "$C2" ]] \
    && ok "a full-stack deploy creates annotated tag ${v} on origin/main" \
    || nope "tag: rc=${rc}, tags '$(tags)', out: ${out}"
keys_ok=true
for want in "version: ${v}" "sha: ${C2}" "utc: " "actor: \"Fixture Actor\"" "previous_tag: none" "modules:" \
            "  static:" "    served_sha: ${C2}" "    release_dir: " "  backstage:" "    version: ${C2}" \
            "    protocol: backstage/2" "    catalogVersion: 2026-10-04.1" "prs:" \
            '  - "#12 docs: readme"' '  - "#11 feat: label page"' '  - "#10 chore: base"'; do
    printf '%s\n' "$msg" | grep -qF -- "$want" || { keys_ok=false; echo "    missing in tag message: ${want}"; }
done
$keys_ok && ok "the tag message YAML carries version, sha, utc, actor, both modules, prs and previous_tag" \
    || nope "tag message incomplete: ${msg}"
[[ "$(pushes)" == "git push origin refs/tags/${v}" ]] \
    && ok "only the tag ref is pushed: $(pushes)" || nope "push log: '$(pushes)'"
g="$(ghcalls)"
[[ "$g" == "gh release create ${v} --verify-tag --title ${v} --notes-file "* && "$(grep -c 'served_sha' "${FAKE_STATE}/notes.md" 2>/dev/null)" -ge 1 ]] \
    && ok "gh release create runs with --verify-tag and notes carrying the same metadata" \
    || nope "gh calls: '${g}'"
drop_fixture

make_fixture
"$REAL_GIT" -C "$WORK" tag -a "v${TODAY}.1" -m r "$C0"
out="$(ship 2>&1)"; rc=$?
v="v${TODAY}.2"
msg="$("$REAL_GIT" -C "$WORK" for-each-ref --format='%(contents)' "refs/tags/${v}")"
[[ $rc -eq 0 && "$("$REAL_GIT" -C "$WORK" rev-parse "${v}^{commit}" 2>/dev/null)" == "$C2" \
   && "$msg" == *"previous_tag: v${TODAY}.1"* && "$msg" == *"#12 docs"* && "$msg" == *"#11 feat"* && "$msg" != *"#10 chore"* ]] \
    && ok "a second release on the same UTC date is ${v}; prs cover previous_tag..S only" \
    || nope "increment: rc=${rc}, tags '$(tags)', msg: ${msg}"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
"$REAL_GIT" -C "$WORK" tag -a v2026.01.01.1 -m r "$C2"
"$REAL_GIT" -C "$WORK" push -q origin refs/tags/v2026.01.01.1 >/dev/null 2>&1
out="$(FAKE_GH_VIEW_RC=0 ship 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(tags)" == "v2026.01.01.1 " && -z "$(pushes)" && -z "$(ghcalls)" && "$out" == *"v2026.01.01.1"* ]] \
    && ok "a release tag already on S, on origin and published: no new tag, no push, no gh create" \
    || nope "existing tag: rc=${rc}, tags '$(tags)', push '$(pushes)', out: ${out}"
drop_fixture

make_fixture
out="$(STUB_RC_PUSH=1 ship 2>&1)"; rc=$?
[[ $rc -eq 5 && "$out" == *"git push origin refs/tags/v${TODAY}.1"* && -z "$(ghcalls)" && "$(calls)" != *"--rollback"* ]] \
    && ok "tag push failure after a verified deploy exits 5 with the recovery command and no rollback" \
    || nope "push fail: rc=${rc}, calls '$(calls)', gh '$(ghcalls)', out: ${out}"
drop_fixture

make_fixture
out="$(STUB_RC_GH=1 ship 2>&1)"; rc=$?
[[ $rc -eq 5 && "$out" == *"gh release create v${TODAY}.1 --verify-tag"* && "$(calls)" != *"--rollback"* ]] \
    && ok "gh release failure exits 5 with the recovery command and no rollback" \
    || nope "gh fail: rc=${rc}, out: ${out}"
drop_fixture

make_fixture
ship --no-release >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && -z "$(tags)" && -z "$(pushes)" && -z "$(ghcalls)" ]] \
    && ok "--no-release deploys without tagging, pushing or calling gh" \
    || nope "no-release: rc=${rc}, tags '$(tags)'"
drop_fixture

echo
echo "[T1] R7 --dry-run prints the plan and mutates nothing"

make_fixture
serve static "$C0"; serve backstage "$C2"
out="$(ship --dry-run 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -eq 0 && -z "$mut" && -z "$(pushes)" && -z "$(ghcalls)" && -z "$(tags)" && "$(calls)" == "deploy.sh --dry-run|" ]] \
    && ok "--dry-run: zero mutating remote commands, no push, no gh, no tag; only stale modules dry-run" \
    || nope "dry-run mutated: rc=${rc}, mutating '${mut}', push '$(pushes)', gh '$(ghcalls)', tags '$(tags)', calls '$(calls)'"
[[ "$out" == *"static"*"deploy"*"STALE"* && "$out" == *"backstage"*"up to date"* && "$out" == *"would create tag v${TODAY}.1"* ]] \
    && ok "--dry-run prints per-module plan, drift and the tag it would create" \
    || nope "dry-run plan output: ${out}"
drop_fixture

make_fixture
serve static "$C0"; serve backstage "$C1"
out="$(ship --module backstage --dry-run 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"refuse"* && "$(calls)" == "backstage-deploy.sh --dry-run|" && -z "$(mutating_commands)" ]] \
    && ok "--module backstage --dry-run with static stale warns it would refuse and stays read-only" \
    || nope "partial dry-run: rc=${rc}, calls '$(calls)', out: ${out}"
drop_fixture

echo
echo "[T1] --status and drift reads with the Basic Auth snippet installed"
CFGDIR="$(mktemp -d)"
STATUS_PW="pw-status-NEVER-LOGGED"
( umask 077; printf 'user = "tester:%s"\n' "$STATUS_PW" > "${CFGDIR}/curl" )

make_fixture
serve static "$C2"; serve backstage "$C2"
out="$(BACKSTAGE_CURL_CONFIG= FAKE_AUTH=1 ship --status 2>&1)"; rc=$?
# Hex SHAs are removed first: a random fixture SHA containing "401" is not a 401 status.
[[ $rc -eq 1 && "$out" == *"BACKSTAGE_CURL_CONFIG"* && "$(printf '%s' "$out" | sed -E 's/[0-9a-f]{7,40}//g')" != *"401"* ]] \
    && ok "auth snippet + BACKSTAGE_CURL_CONFIG unset -> status fails naming the variable, not a bare 401" \
    || nope "status auth no config: rc=${rc}; out: ${out}"
grep -q 'api/backstage' "${FAKE_STATE}/curl.log" 2>/dev/null \
    && nope "an unauthenticated Backstage probe was still sent" || ok "no Backstage probe is sent without credentials"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
out="$(BACKSTAGE_CURL_CONFIG= FAKE_AUTH=1 ship --dry-run 2>&1)"; rc=$?
grep -q 'api/backstage' "${FAKE_STATE}/curl.log" 2>/dev/null \
    && nope "the deploy plan's drift read sent an unauthenticated Backstage probe" \
    || ok "deploy drift reads send no Backstage probe without credentials (backstage drift UNKNOWN)"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
"$REAL_GIT" -C "$WORK" tag -a v2026.01.01.1 -m r "$C2" && "$REAL_GIT" -C "$WORK" push -q origin refs/tags/v2026.01.01.1 >/dev/null 2>&1
out="$(BACKSTAGE_CURL_CONFIG="${CFGDIR}/curl" FAKE_AUTH=1 ship --status 2>&1)"; rc=$?
bs="$(section backstage)"
[[ $rc -eq 0 ]] && printf '%s\n' "$bs" | grep -Eq "^  served +${C2}$" && printf '%s\n' "$bs" | grep -Eq '^  drift +none$' \
    && printf '%s\n' "$bs" | grep -Eq '^  auth +yes$' \
    && ok "with the curl config set, status reads the served version, drift none, and reports auth yes" \
    || nope "status auth with config: rc=${rc}; out: ${out}"
grep 'api/backstage/health' "${FAKE_STATE}/curl.log" | grep -qF -- "--config ${CFGDIR}/curl" \
    && ok "the Backstage status probe passes the curl config file" || nope "status probe without --config: $(cat "${FAKE_STATE}/curl.log")"
grep -qF "$STATUS_PW" "${FAKE_STATE}/curl.log" "${FAKE_STATE}/ssh.log" || [[ "$out" == *"$STATUS_PW"* ]] \
    && nope "the password reached a command line or output" || ok "the password is in no curl argument, remote command or output"
grep 'DEPLOYED_SHA' "${FAKE_STATE}/curl.log" | grep -q -- '--config' \
    && nope "a non-Backstage probe carried the curl config" || ok "non-Backstage probes never carry the curl config"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
out="$(FAKE_AUTH= BACKSTAGE_CURL_CONFIG= ship --status --module backstage 2>&1)"; rc=$?
bs="$(section backstage)"
[[ $rc -eq 6 ]] && printf '%s\n' "$bs" | grep -Eq "^  served +${C2}$" && printf '%s\n' "$bs" | grep -Eq '^  auth +no$' \
    && [[ "$out" == *"FAIL S2 gate: expected yes or session, got no"* ]] \
    && ok "no auth snippet on the host -> status reads without a curl config, and the live verify fails S2 (exit 6)" \
    || nope "status open: rc=${rc}; out: ${out}"
out="$(FAKE_AUTH=off ship --status --module backstage 2>&1)"; rc=$?
bs="$(section backstage)"
[[ $rc -eq 6 ]] && printf '%s\n' "$bs" | grep -Eq '^  auth +no$' && [[ "$out" == *"FAIL S2 gate: expected yes or session, got no"* ]] \
    && ok "a snippet with 'auth_basic off;' reports auth no (the file directive alone is not auth); verify fails S2" \
    || nope "auth off: rc=${rc}; out: ${out}"
out="$(BACKSTAGE_CURL_CONFIG="${CFGDIR}/curl" FAKE_AUTH=readfail ship --status --module backstage 2>&1)"; rc=$?
bs="$(section backstage)"
[[ $rc -ne 0 ]] && printf '%s\n' "$bs" | grep -Eq '^  auth +unknown$' && printf '%s\n' "$bs" | grep -Eq '^  drift +UNKNOWN' \
    && ok "an unreadable snippet reports auth unknown, drift UNKNOWN and fails, never auth no" \
    || nope "read failure: rc=${rc}; out: ${out}"
drop_fixture
rm -rf "$CFGDIR"

echo "[T1] session gate state reaches status and closing verify"
closing_no_mint() {
    (
        eval "$(sed -n '/^closing_verify() {/,/^}/p' "$SHIP")"
        backstage_session_mint() { echo MINT_CALLED; return 1; }
        verify_live() { echo VERIFY_CALLED; return 0; }
        closing_verify "" "" no none "$1" yes session
    )
}
for scope in backstage static; do
    out="$(closing_no_mint "$scope" 2>&1)"; rc=$?
    [[ $rc -eq 0 && "$out" == *VERIFY_CALLED* && "$out" != *MINT_CALLED* ]] \
        && ok "closing verify ${scope} scope with no release does not mint" \
        || nope "closing verify ${scope} scope minted or failed: rc=${rc}; out: ${out}"
done
make_fixture
serve static "$C2"; serve backstage "$C2"
"$REAL_GIT" -C "$WORK" tag -a v2026.01.01.1 -m r "$C2" && "$REAL_GIT" -C "$WORK" push -q origin refs/tags/v2026.01.01.1 >/dev/null 2>&1
FAKE_SESSION_FIXTURE="${FIX}/session"; export FAKE_SESSION_FIXTURE; mkdir -p "${FAKE_SESSION_FIXTURE}/http"
session_file() {
    local key="$1" code="$2" body="$3" location="${4:-}" cookie="${5:-}" content_type="${6:-}"
    {
        printf 'source: generated by ship.test.sh\nurl: fixture\nhttp_code: %s\ncurl_exit: 0\n' "$code"
        [[ -z "$location" ]] || printf 'location: %s\n' "$location"
        [[ -z "$cookie" ]] || printf 'set_cookie: %s\n' "$cookie"
        [[ -z "$content_type" ]] || printf 'content_type: %s\n' "$content_type"
        printf '%s\n' '---' "$body"
    } > "${FAKE_SESSION_FIXTURE}/http/jevnotjev.breakoutwithai.com_${key}.txt"
}
session_file 'backstage_' 302 '' '/backstage/sign-in?next=/backstage/'
session_file 'api_backstage_health' 401 '{"code":"unauthenticated"}' '' '' 'application/json'
session_file 'backstage_sign-in' 200 '<form action="/api/auth/password"></form>'
session_file 'backstage_@tampered' 302 '' '/backstage/sign-in?next=/backstage/'
session_file 'api_backstage_health@tampered' 401 '{"code":"unauthenticated"}' '' '' 'application/json'
session_file 'backstage_@forged' 302 '' '/backstage/sign-in?next=/backstage/'
session_file 'api_backstage_health@forged' 401 '{"code":"unauthenticated"}' '' '' 'application/json'
session_file 'api_auth_password@mint' 303 '' '/backstage/' '__Host-backstage_session=fake; Path=/; Secure'
session_file 'backstage_@session' 200 '<main>Backstage</main>'
session_file 'api_backstage_health@session' 200 '{"version":"{{BACKSTAGE_SHA}}"}'
out="$(FAKE_AUTH=session ship --status 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && printf '%s\n' "$out" | grep -Eq '^  auth +session$' && [[ "$out" == *'PASS S2 anon /backstage/ 302 sign-in'* && "$out" == *'PASS S2 auth /api/backstage/health 200'* ]] \
    && ok "status exports session gate to the health read and closing verify" || nope "session status: rc=${rc}; out: ${out}"
mint_calls="$(grep -c 'api/auth/password' "${FAKE_STATE}/curl.log" 2>/dev/null || true)"
[[ "$mint_calls" == 1 ]] && ok "ship status mints one session for its probes" || nope "ship status minted ${mint_calls} times"
drop_fixture

echo
echo "[T1] PR #82 discovery sweep: one case per finding"

# 1 HIGH: Backstage drift follows the build's import graph, not a hand list.
make_fixture
serve static "$C2"; serve backstage "$C2"
NEW="$(advance_main src/core/verdict.ts 'export const verdict = 2;' 'fix: verdict (#13)')"
out="$(ship --status --module backstage 2>&1)"; rc=$?
bs="$(section backstage)"
[[ $rc -eq 3 ]] && printf '%s\n' "$bs" | grep -Eq '^  drift +STALE \(1 commits behind; changed: src/core/verdict.ts\)$' \
    && ok "#1 a change to src/core/verdict.ts (imported by the Backstage build) makes backstage STALE" \
    || nope "#1 verdict change: rc=${rc}; ${bs}"
NEW2="$(advance_main src/other.ts 'export const other = 2;' 'chore: other (#14)')"
serve backstage "$NEW"
out="$(ship --status --module backstage 2>&1)"; rc=$?
bs="$(section backstage)"
[[ $rc -eq 6 ]] && printf '%s\n' "$bs" | grep -Eq '^  drift +none \(sha differs, no module changes\)$' \
    && [[ "$out" == *"FAIL S1 backstage version: expected ${NEW2}, served ${NEW}"* ]] \
    && ok "#1 a change outside the Backstage import graph (src/other.ts) is not backstage drift; the live verify still exits 6 (S1)" \
    || nope "#1 other change: rc=${rc}; ${bs}"
drop_fixture

# Gate P2: entrypoints come from the ARCHIVED origin/main build script, not the local checkout.
# origin/main (pushed from a side branch) adds a third entrypoint src/backstage/extra.ts that
# imports src/core/extra-dep.ts; the local checkout stays at C2 with the two-entrypoint script.
make_fixture
(
    cd "$WORK" || exit 1
    "$REAL_GIT" checkout -q -b side
    awk '{print} /\["src\/backstage\/server.ts", "bun", "", "server.js"\],/ {print "  [\"src/backstage/extra.ts\", \"bun\", \"\", \"extra.js\"],"}' \
        scripts/backstage-build.ts > scripts/b.tmp && mv scripts/b.tmp scripts/backstage-build.ts
    printf '%s\n' 'import { dep } from "../core/extra-dep.ts";' 'export const extra = dep;' > src/backstage/extra.ts
    printf '%s\n' 'export const dep = 1;' > src/core/extra-dep.ts
    "$REAL_GIT" add -A && "$REAL_GIT" commit -qm "feat: third entrypoint (#15)"
    printf '%s\n' 'export const dep = 2;' > src/core/extra-dep.ts
    "$REAL_GIT" add -A && "$REAL_GIT" commit -qm "fix: extra dep (#16)"
    "$REAL_GIT" push -q origin side:main
    "$REAL_GIT" checkout -q main
) >/dev/null 2>&1
A="$("$REAL_GIT" -C "$WORK" rev-parse side~1)"
grep -c 'src/backstage/extra.ts' "${WORK}/scripts/backstage-build.ts" >/dev/null && echo "    (fixture error: local script has the third entrypoint)"
serve static "$A"; serve backstage "$A"
out="$(ship --status --module backstage 2>&1)"; rc=$?
bs="$(section backstage)"
[[ $rc -eq 3 ]] && printf '%s\n' "$bs" | grep -Eq '^  drift +STALE \(1 commits behind; changed: src/core/extra-dep.ts\)$' \
    && ok "P2 a dependency of an entrypoint only origin/main's build script defines makes backstage STALE" \
    || nope "P2 archived entrypoints: rc=${rc}; ${bs}"
drop_fixture

# 2 HIGH: a failed git diff is UNKNOWN, never "no module changes".
make_fixture
out="$(FAKE_GIT_DIFF_FAIL=1 ship --status --module static 2>&1)"; rc=$?
st="$(section static)"
[[ $rc -eq 3 ]] && printf '%s\n' "$st" | grep -Eq '^  drift +UNKNOWN' \
    && ok "#2 git diff failing makes drift UNKNOWN and status exit 3" \
    || nope "#2 diff failure: rc=${rc}; ${st}"
drop_fixture

# 3 HIGH: an existing release tag is reconciled with origin and the GitHub release.
make_fixture
STUB_RC_PUSH=1 ship >/dev/null 2>&1; rc1=$?
out="$(ship 2>&1)"; rc=$?
v="v${TODAY}.1"
[[ $rc1 -eq 5 && $rc -eq 0 && "$(grep -c "git push origin refs/tags/${v}" "${FAKE_STATE}/push.log")" -eq 2 \
   && "$(ghcalls)" == "gh release create ${v} --verify-tag"* && "$(tags)" == "${v} " ]] \
    && ok "#3 after a failed push, a rerun pushes the existing tag and creates the missing release" \
    || nope "#3 rerun: rc1=${rc1} rc=${rc}, push '$(pushes)', gh '$(ghcalls)', tags '$(tags)'; out: ${out}"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
"$REAL_GIT" -C "$WORK" tag -a v2026.01.01.1 -m r "$C2"
"$REAL_GIT" -C "$WORK" push -q origin refs/tags/v2026.01.01.1 >/dev/null 2>&1
out="$(ship 2>&1)"; rc=$?
[[ $rc -eq 0 && -z "$(pushes)" && "$(ghcalls)" == "gh release create v2026.01.01.1 --verify-tag"* ]] \
    && ok "#3 tag already on origin but no GitHub release: creates only the release" \
    || nope "#3 release missing: rc=${rc}, push '$(pushes)', gh '$(ghcalls)'"
drop_fixture

make_fixture
"$REAL_GIT" -C "$WORK" tag v1.0 "$C2"
"$REAL_GIT" -C "$WORK" tag -a v1 -m notcalver "$C2"
"$REAL_GIT" -C "$WORK" tag "v${TODAY}.7" "$C2"
out="$(ship 2>&1)"; rc=$?
[[ $rc -eq 0 && "$("$REAL_GIT" -C "$WORK" cat-file -t "v${TODAY}.1" 2>/dev/null)" == tag ]] \
    && ok "#3 lightweight or non-CalVer v* tags on S are not releases: v${TODAY}.1 is created" \
    || nope "#3 invalid tags: rc=${rc}, tags '$(tags)'; out: ${out}"
drop_fixture

# 4 HIGH: release files live in a private per-run directory, never a predictable path.
make_fixture
printf 'precious\n' > "${FIX}/precious.txt"
ln -s "${FIX}/precious.txt" "${TMPDIR}/jevnotjev-release-v${TODAY}.1"
out="$(ship 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(cat "${FIX}/precious.txt")" == precious && -L "${TMPDIR}/jevnotjev-release-v${TODAY}.1" ]] \
    && ok "#4 a pre-created path at the old predictable location is untouched" \
    || nope "#4 predictable path: rc=${rc}, precious '$(cat "${FIX}/precious.txt")'"
drop_fixture

# 5 HIGH: skip only when release dir, marker and served version all name origin/main.
make_fixture
serve static "$C2"; serve backstage "$C2"
fake backstage_release "/var/www/jevnotjev-backstage-releases/${C1}"
fake static_marker "$C1"
out="$(ship --no-release 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(calls)" == "deploy.sh |backstage-deploy.sh |" ]] \
    && ok "#5 served == main but the current release dir / marker names another SHA: deployed, not skipped" \
    || nope "#5 mismatched release: rc=${rc}, calls '$(calls)'; out: ${out}"
drop_fixture

# 6 HIGH: one host lock for the whole run, refused when held, taken by rollback too.
make_fixture
out="$(ship --no-release 2>&1)"; rc=$?
first_lock="$(grep -n '^mkdir /var/lock/jevnotjev-ship$' "${FAKE_STATE}/ssh.log" | head -1 | cut -d: -f1)"
# Gate panel #1 (c90517a): a lock-free, read-only state read now precedes the lock (it decides
# whether the dependency check runs). The authoritative read is under the lock, and nothing is
# changed on the host before the lock is taken.
first_probe="$(grep -n 'jevnotjev-backstage-current' "${FAKE_STATE}/ssh.log" | awk -F: -v l="${first_lock:-0}" '$1 > l {print $1; exit}')"
last_unlock="$(grep -n '^rmdir /var/lock/jevnotjev-ship$' "${FAKE_STATE}/ssh.log" | tail -1 | cut -d: -f1)"
last_probe="$(grep -n 'jevnotjev-backstage-current' "${FAKE_STATE}/ssh.log" | tail -1 | cut -d: -f1)"
first_change="$(mutating_commands | head -1)"
[[ $rc -eq 0 && -n "$first_lock" && -n "$last_unlock" && -n "$first_probe" && "$last_unlock" -gt "$last_probe" \
   && "$first_change" == "mkdir /var/lock/jevnotjev-ship" ]] \
    && ok "#6 the ship lock is the first host change, a state read runs under it, and it is released after the final verification" \
    || nope "#6 lock order: rc=${rc}, lock ${first_lock:-none}, unlock ${last_unlock:-none}, probes ${first_probe:-?}-${last_probe:-?}, first change '${first_change}'"
drop_fixture

make_fixture
out="$(FAKE_SHIP_LOCK_HELD=1 ship 2>&1)"; rc=$?
[[ $rc -ne 0 && -z "$(calls)" && "$out" == *"/var/lock/jevnotjev-ship"* && -z "$(tags)" ]] \
    && ok "#6 a held ship lock refuses the deploy before any module runs" \
    || nope "#6 lock held: rc=${rc}, calls '$(calls)'; out: ${out}"
drop_fixture

make_fixture
ship --module static --rollback >/dev/null 2>&1; rc=$?
grep -qx 'mkdir /var/lock/jevnotjev-ship' "${FAKE_STATE}/ssh.log" && grep -qx 'rmdir /var/lock/jevnotjev-ship' "${FAKE_STATE}/ssh.log" \
    && [[ $rc -eq 0 ]] \
    && ok "#6 a rollback takes and releases the same ship lock" || nope "#6 rollback lock: rc=${rc}"
out="$(FAKE_SHIP_LOCK_HELD=1 ship --module static --rollback 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(calls)" == "deploy.sh --rollback|" ]] \
    && ok "#6 a rollback refuses while the ship lock is held" || nope "#6 rollback held: rc=${rc}, calls '$(calls)'"
drop_fixture

# 7 MEDIUM: a failed origin/main fetch is UNKNOWN and non-zero, never a cached all-clear.
make_fixture
serve static "$C2"; serve backstage "$C2"
"$REAL_GIT" -C "$WORK" remote set-url origin "${FIX}/missing.git"
out="$(ship --status 2>&1)"; rc=$?
st="$(section static)"
[[ $rc -eq 3 ]] && printf '%s\n' "$st" | grep -Eq '^  drift +UNKNOWN \(origin/main fetch failed' \
    && ok "#7 status after a failed fetch: drift UNKNOWN (with the cached comparison), exit 3" \
    || nope "#7 fetch failure: rc=${rc}; out: ${out}"
drop_fixture

# 8 MEDIUM: release recording refuses when remote tags could not be fetched.
make_fixture
out="$(FAKE_GIT_TAGFETCH_FAIL=1 ship 2>&1)"; rc=$?
[[ $rc -eq 5 && -z "$(tags)" && -z "$(pushes)" && "$(calls)" == "deploy.sh |backstage-deploy.sh |" && "$out" == *"tags"* ]] \
    && ok "#8 tag fetch failed: modules deploy, release recording refuses with exit 5, no tag" \
    || nope "#8 tag fetch: rc=${rc}, tags '$(tags)'; out: ${out}"
drop_fixture

# 9 MEDIUM: metadata generation is checked before tagging.
make_fixture
out="$(FAKE_GIT_LOG_FAIL=1 ship 2>&1)"; rc=$?
[[ $rc -eq 5 && -z "$(tags)" && -z "$(pushes)" && -z "$(ghcalls)" ]] \
    && ok "#9 release metadata generation failing exits 5 before any tag, push or gh call" \
    || nope "#9 metadata: rc=${rc}, tags '$(tags)'; out: ${out}"
drop_fixture

# 10 MEDIUM: recovery commands are shell-quoted.
make_fixture
export TMPDIR="${FIX}/tmp with space"; mkdir -p "$TMPDIR"
out="$(STUB_RC_PUSH=1 ship 2>&1)"; rc=$?
line="$(printf '%s\n' "$out" | grep 'gh release create' | head -1)"
[[ $rc -eq 5 && "$line" == *'tmp\ with\ space'* && "$line" != *'tmp with space'* ]] \
    && ok "#10 the printed recovery command quotes a TMPDIR containing spaces" \
    || nope "#10 quoting: rc=${rc}; line: ${line}"
drop_fixture

# 11 MEDIUM: a dirty tracked tree is refused before planning, even when every module is current.
make_fixture
serve static "$C2"; serve backstage "$C2"
echo dirty >> "${WORK}/README"
out="$(ship 2>&1)"; rc=$?
[[ $rc -eq 1 && -z "$(calls)" && -z "$(tags)" && "$out" == *"ncommitted"* ]] \
    && ok "#11 tracked changes refuse the deploy before planning; no skip, no release" \
    || nope "#11 dirty: rc=${rc}, calls '$(calls)', tags '$(tags)'; out: ${out}"
drop_fixture

# 12 MEDIUM: a failed transfer is never parsed, even with a complete body.
make_fixture
serve static "$C2"; serve backstage "$C2"
out="$(FAKE_CURL_PARTIAL=1 ship --status 2>&1)"; rc=$?
st="$(section static)"; bs="$(section backstage)"
[[ $rc -eq 3 ]] && printf '%s\n' "$st" | grep -Eq '^  served +none$' && printf '%s\n' "$bs" | grep -Eq '^  served +none$' \
    && ok "#12 curl exiting non-zero after a full body: served none for static and backstage, exit 3" \
    || nope "#12 partial transfer: rc=${rc}; out: ${out}"
drop_fixture

# 13 LOW: version-aware ordering of release tags.
make_fixture
serve static "$C2"; serve backstage "$C2"
"$REAL_GIT" -C "$WORK" tag -a v2026.01.01.9 -m r "$C2"
"$REAL_GIT" -C "$WORK" tag -a v2026.01.01.10 -m r "$C2"
out="$(ship --status --module backstage 2>&1)"
bs="$(section backstage)"
printf '%s\n' "$bs" | grep -Eq '^  release +v2026.01.01.10$' \
    && ok "#13 the newest release tag is .10, not .9" || nope "#13 sort: ${bs}"
drop_fixture

# Gate P1: the remote tag and the GitHub release must reference the same tag object and commit.
make_fixture
v="v${TODAY}.1"
# Another run publishes the same name on C0 after this run's tag fetch (FAKE_GIT_TAGFETCH_NOOP).
( cd "$WORK" && "$REAL_GIT" tag -a "$v" -m other "$C0" && "$REAL_GIT" push -q origin "refs/tags/${v}" \
  && "$REAL_GIT" tag -d "$v" ) >/dev/null 2>&1
out="$(FAKE_GIT_TAGFETCH_NOOP=1 ship 2>&1)"; rc=$?
[[ $rc -eq 5 && -z "$(ghcalls)" && ! -s "${FAKE_STATE}/gh-view.log" && -z "$(pushes)" \
   && "$out" == *"$C0"* && "$out" == *"$C2"* ]] \
    && ok "P1 a remote tag of the same name on another commit: exit 5 naming both SHAs, no push, no gh call" \
    || nope "P1 remote mismatch: rc=${rc}, push '$(pushes)', gh '$(ghcalls)'; out: ${out}"
drop_fixture

make_fixture
v="v${TODAY}.1"
( cd "$WORK" && "$REAL_GIT" tag -a "$v" -m other "$C2" && "$REAL_GIT" push -q origin "refs/tags/${v}" \
  && "$REAL_GIT" tag -d "$v" ) >/dev/null 2>&1
out="$(FAKE_GIT_TAGFETCH_NOOP=1 ship 2>&1)"; rc=$?
[[ $rc -eq 5 && -z "$(ghcalls)" && -z "$(pushes)" ]] \
    && ok "P1 a remote tag on S but a different tag object than the local one: exit 5, no gh call" \
    || nope "P1 object mismatch: rc=${rc}, gh '$(ghcalls)'; out: ${out}"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
"$REAL_GIT" -C "$WORK" tag -a v2026.01.01.1 -m r "$C2"
"$REAL_GIT" -C "$WORK" push -q origin refs/tags/v2026.01.01.1 >/dev/null 2>&1
out="$(FAKE_GH_VIEW_RC=0 FAKE_GH_VIEW_TARGET="$C0" ship 2>&1)"; rc=$?
[[ $rc -eq 5 && -z "$(ghcalls)" && "$out" == *"$C0"* ]] \
    && ok "P1 an existing GitHub release targeting another commit: exit 5 naming it, no gh create" \
    || nope "P1 release target mismatch: rc=${rc}, gh '$(ghcalls)'; out: ${out}"
out="$(FAKE_GH_VIEW_RC=0 FAKE_GH_VIEW_TAG=v2026.01.01.2 ship 2>&1)"; rc=$?
[[ $rc -eq 5 && -z "$(ghcalls)" ]] \
    && ok "P1 a GitHub release answering for another tag name: exit 5, no gh create" \
    || nope "P1 release tag mismatch: rc=${rc}; out: ${out}"
out="$(FAKE_GH_VIEW_RC=0 FAKE_GH_VIEW_TARGET="$C2" ship 2>&1)"; rc=$?
[[ $rc -eq 0 && -z "$(ghcalls)" && -z "$(pushes)" ]] \
    && ok "P1 matching remote tag object, peeled commit and release target: proceeds, nothing created" \
    || nope "P1 matching: rc=${rc}, push '$(pushes)', gh '$(ghcalls)'; out: ${out}"
drop_fixture

# 14 LOW: docs describe status exit 0 as no detected module drift.
grep -q 'no detected module drift' docs/DEPLOY.md && grep -q 'no detected module drift' docs/backstage-deploy.md \
    && ! grep -q 'every module serves origin/main; 3' docs/backstage-deploy.md \
    && ok "#14 both deploy docs describe --status exit 0 as no detected module drift" \
    || nope "#14 docs still promise exit 0 = every module at origin/main"

echo
echo "[T1] #85 AC2: every deploy, setup and rollback closes with the live verify"
# Expected values are spec literals: docs/DEPLOY.md "Seams under test" S1 (served SHA, release tag)
# and docs/backstage-deploy.md:53 (401 without credentials). FAKE_AUTH= is a host with no gate.
make_fixture
out="$(ship 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"verify: 9 passed, 0 failed"*"release: tagged v${TODAY}.1"*"PASS S1 release tag v${TODAY}.1 on ${C2}"* ]] \
    && ok "a full-stack deploy verifies S1/S2 (9 assertions) BEFORE tagging, then finds the release tag on origin" \
    || nope "closing verify on success: rc=${rc}; out: ${out}"
drop_fixture
make_fixture
out="$(FAKE_AUTH= ship 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S2 gate: expected yes or session, got no"* && "$(calls)" == "deploy.sh |backstage-deploy.sh |" && "$(calls)" != *"--rollback"* ]] \
    && ok "deploy onto an ungated host: both modules deploy, the closing verify fails S2, exit 6, nothing rolled back" \
    || nope "deploy ungated: rc=${rc}, calls '$(calls)'; out: ${out}"
[[ -z "$(tags)" && -z "$(pushes)" && -z "$(ghcalls)" ]] \
    && ok "sweep #3: an ungated host gets no tag, no push and no GitHub release" \
    || nope "sweep #3 published before verify: tags '$(tags)', push '$(pushes)', gh '$(ghcalls)'"
drop_fixture
make_fixture
serve backstage none
out="$(FIXTURE_EXTRA=backstage-no-release ship --module static --allow-drift 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"PASS S2 auth /api/backstage/health 502 (no release yet)"* && "$out" == *"PASS S2 auth /backstage/ 502 (no release yet)"* ]] \
    && ok "sweep #10: a static-only deploy observes that Backstage has no release; its 502 is the spec answer (docs/backstage-deploy.md:53)" \
    || nope "sweep #10 static-only, no backstage release: rc=${rc}; out: ${out}"
drop_fixture
make_fixture
serve static none
out="$(FIXTURE_EXTRA=no-static-release ship --setup --module static 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"PASS S2 public / 404 (no static release yet)"* && "$out" == *"PASS S2 public /little-shop/ 404 (no static release yet)"* && "$out" == *"verify: 3 passed, 0 failed"* ]] \
    && ok "sweep #8: first-time static setup expects 404 until the first deploy (.deploy/provision.sh:140) and asserts only its own module" \
    || nope "sweep #8 first static setup: rc=${rc}; out: ${out}"
[[ "$(sed -n 140p .deploy/provision.sh)" == *"404 is expected until the first"* ]] \
    && ok ".deploy/provision.sh:140 states the 404-before-first-deploy literal" || nope ".deploy/provision.sh:140 moved"
drop_fixture
make_fixture
out="$(FAKE_AUTH= ship --module backstage 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S2 gate: expected yes or session, got no"* ]] \
    && ok "a partial deploy closes with the same verify and exits 6 on an ungated host" \
    || nope "partial ungated: rc=${rc}; out: ${out}"
drop_fixture
make_fixture
out="$(FAKE_AUTH= ship --setup --module backstage 2>&1)"; rc=$?
[[ $rc -eq 6 && "$(calls)" == "backstage-setup.sh |" && "$out" == *"FAIL S2 gate: expected yes or session, got no"* ]] \
    && ok "setup that leaves Backstage ungated exits 6 naming the route" \
    || nope "setup ungated: rc=${rc}, calls '$(calls)'; out: ${out}"
drop_fixture
make_fixture
out="$(ship --setup --module static 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"static not asserted"* && "$out" == *"PASS S2 public / 200"* && "$out" == *"verify: 3 passed, 0 failed"* ]] \
    && ok "static setup asserts no SHA (it ships no release), only its public paths: 3 passed" \
    || nope "setup gated: rc=${rc}; out: ${out}"
out="$(ship --setup --module backstage 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"PASS S2 anon /backstage/ 401"* && "$out" == *"verify: 4 passed, 0 failed"* ]] \
    && ok "backstage setup asserts its gate: 2 anon 401 + 2 auth 200 passed" \
    || nope "setup backstage gated: rc=${rc}; out: ${out}"
drop_fixture
make_fixture
out="$(FAKE_AUTH= ship --module static --rollback 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"PASS S1 static /DEPLOYED_SHA ${C1}"* && "$out" == *"FAIL S2 gate: expected yes or session, got no"* ]] \
    && ok "static rollback: verify expects the rolled-back release's own marker, and exits 6 on an ungated host" \
    || nope "static rollback ungated: rc=${rc}; out: ${out}"
drop_fixture
make_fixture
out="$(STUB_NO_UPDATE=1 ship --module backstage --rollback "$SHA40" 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S1 backstage version: expected ${SHA40}, served ${C1}"* ]] \
    && ok "backstage rollback that does not take effect: verify names the expected and served SHA, exit 6" \
    || nope "backstage rollback no effect: rc=${rc}; out: ${out}"
out="$(ship --module backstage --rollback "$SHA40" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"PASS S1 backstage version ${SHA40}"* ]] \
    && ok "backstage rollback that serves the given SHA passes the closing verify" \
    || nope "backstage rollback ok: rc=${rc}; out: ${out}"
drop_fixture

echo
echo "[T1] dependency check: lockfile, typecheck and the test gate run before the host lock"
bunlog() { tr '\n' '|' < "${FAKE_STATE}/bun.log" 2>/dev/null; }
host_touched() { [[ -s "${FAKE_STATE}/ssh.log" ]]; }
# Read-only state probes may precede the dependency check; the lock and any change may not.
host_mutated() { [[ -n "$(mutating_commands)" ]]; }

make_fixture
out="$(ship 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(bunlog)" == "install --frozen-lockfile|run typecheck|scripts/gate.ts|--no-env-file scripts/deploy-checklist.ts --checklist "* ]] \
    && ok "a deploy runs bun install --frozen-lockfile, typecheck, the gate, then the Jev checklist, in that order" \
    || nope "deps order: rc=${rc}, bun.log '$(bunlog)'; out: ${out}"
drop_fixture

# Sweep #2: Bun loads .env.local from cwd on its own; the checklist must run with --no-env-file so
# resolveKey alone decides precedence and names the source.
make_fixture
out="$(ship 2>&1)"; rc=$?
grep -qx -- "--no-env-file scripts/deploy-checklist.ts --checklist .*" "${FAKE_STATE}/bun.log" \
    && ok "sweep #2: the Jev checklist runs as bun --no-env-file, so cwd .env.local cannot override the documented key order" \
    || nope "sweep #2: checklist invocation '$(bunlog)'"
drop_fixture

# Sweep #4/#5: a failing git status is never 'clean', and a checklist that cannot be built stops
# the deploy before Jev is asked.
make_fixture
out="$(FAKE_GIT_STATUS_FAIL_FROM=1 ship 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"git status failed"* && -z "$(calls)" && ! -s "${FAKE_STATE}/bun.log" ]] && ! host_touched \
    && ok "sweep #4: git status failing at the preflight refuses the deploy (exit 1), never reads as a clean tree" \
    || nope "sweep #4 preflight: rc=${rc}, bun.log '$(bunlog)', calls '$(calls)'; out: ${out}"
drop_fixture

make_fixture
out="$(FAKE_GIT_STATUS_FAIL_FROM=2 ship 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"git status failed"* && "$out" == *"release checklist could not be built"* \
   && "$out" != *"tracked tree clean: yes"* && "$(bunlog)" != *"deploy-checklist"* && -z "$(calls)" && -z "$(tags)" ]] \
    && grep -qx 'rmdir /var/lock/jevnotjev-ship' "${FAKE_STATE}/ssh.log" \
    && ok "sweep #4/#5: git status failing while the checklist is built: exit 1, Jev not asked, no module script, lock released" \
    || nope "sweep #4/#5 checklist: rc=${rc}, bun.log '$(bunlog)', calls '$(calls)'; out: ${out}"
ls "${TMPDIR}"/jevnotjev-checklist.* >/dev/null 2>&1 \
    && nope "sweep #5: the private checklist directory was left behind" \
    || ok "sweep #5: the private checklist directory is removed when the checklist fails"
drop_fixture

make_fixture
out="$(FAKE_GIT_STATUS_FAIL_FROM=2 ship --dry-run 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"release checklist could not be built"* && "$out" != *"tracked tree clean: yes"* && -z "$(calls)" ]] \
    && ok "sweep #4/#5: --dry-run also refuses a checklist it could not build" \
    || nope "sweep #4/#5 dry-run: rc=${rc}, calls '$(calls)'; out: ${out}"
drop_fixture

# Re-sweep #1: the checks are bound to the revision they ran on. HEAD moving (or the tree changing)
# while the gate runs must stop the deploy before any module script, naming both SHAs.
make_fixture
out="$(FAKE_GATE_ADVANCES_HEAD=1 ship 2>&1)"; rc=$?
moved="$("$REAL_GIT" -C "$WORK" rev-parse HEAD)"
[[ $rc -eq 1 && "$moved" != "$C2" && "$out" == *"checked ${C2}"* && "$out" == *"now ${moved}"* \
   && -z "$(calls)" && -z "$(tags)" && -z "$(pushes)" ]] \
    && grep -qx 'rmdir /var/lock/jevnotjev-ship' "${FAKE_STATE}/ssh.log" \
    && ok "re-sweep #1: HEAD advancing during the gate exits 1 naming both SHAs; no module script, no tag, lock released" \
    || nope "re-sweep #1 HEAD moved: rc=${rc}, calls '$(calls)', moved ${moved}; out: ${out}"
drop_fixture

make_fixture
out="$(FAKE_GATE_DIRTIES_TREE=1 ship 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"tracked tree changed during the checks"* && -z "$(calls)" && -z "$(tags)" ]] \
    && ok "re-sweep #1: a tracked edit during the gate exits 1 before any module script" \
    || nope "re-sweep #1 tree dirtied: rc=${rc}, calls '$(calls)'; out: ${out}"
drop_fixture

for step in INSTALL:"bun install --frozen-lockfile" TYPECHECK:"bun run typecheck" GATE:"bun scripts/gate.ts"; do
    var="FAKE_BUN_${step%%:*}_RC"; name="${step#*:}"
    make_fixture
    out="$(env "${var}=1" bash -c 'cd "$1" && PATH="$2:$PATH" bash .deploy/ship.sh' _ "$WORK" "$FAKEBIN" 2>&1)"; rc=$?
    [[ $rc -eq 1 && "$out" == *"Dependency check failed at '${name}'"* && -z "$(calls)" && -z "$(tags)" ]] && ! host_mutated \
        && ok "${name} failing exits 1 naming the step; no host lock or change, no module script, no tag" \
        || nope "${name} fail: rc=${rc}, calls '$(calls)', ssh '$(cat "${FAKE_STATE}/ssh.log" 2>/dev/null)'; out: ${out}"
    drop_fixture
done

make_fixture
out="$(FAKE_GATE_LINE='gate: PASS files=0 tests=0' ship 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"reported no passing tests"* && -z "$(calls)" ]] && ! host_mutated \
    && ok "a gate that exits 0 with tests=0 is a failure: exit 1 before the host lock" \
    || nope "gate tests=0: rc=${rc}, calls '$(calls)'; out: ${out}"
drop_fixture

make_fixture
"$REAL_GIT" -C "$WORK" checkout -q "$C1" >/dev/null 2>&1
out="$(ship 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"is not origin/main"* && ! -s "${FAKE_STATE}/bun.log" ]] \
    && ok "HEAD != origin/main refuses before the dependency check runs" \
    || nope "preflight order: rc=${rc}, bun.log '$(bunlog)'; out: ${out}"
drop_fixture

make_fixture
out="$(ship --dry-run 2>&1)"; rc=$?
[[ $rc -eq 0 && ! -s "${FAKE_STATE}/bun.log" && "$out" == *"would run, in order: bun install --frozen-lockfile; bun run typecheck; bun scripts/gate.ts"* \
   && "$out" == *"jev: would ask whether the release is ready (dry-run, not asked)"* ]] \
    && ok "--dry-run prints the dependency steps and the Jev question it would run, and runs neither" \
    || nope "dry-run deps: rc=${rc}, bun.log '$(bunlog)'; out: ${out}"
drop_fixture

echo
echo "[T1] Jev release checklist confirmation"

make_fixture
out="$(FAKE_JEV_ANSWER=no FAKE_JEV_RC=1 ship 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"Jev did not confirm the release checklist"* && -z "$(calls)" && -z "$(tags)" && -z "$(pushes)" && -z "$(ghcalls)" ]] \
    && [[ -z "$(mutating_commands | grep -v '^mkdir /var/lock/jevnotjev-ship$' | grep -v '^rmdir /var/lock/jevnotjev-ship$')" ]] \
    && grep -qx 'rmdir /var/lock/jevnotjev-ship' "${FAKE_STATE}/ssh.log" \
    && ok "Jev answering no exits 1: no module script, no tag, no host change beyond the ship lock, which is released" \
    || nope "jev no: rc=${rc}, calls '$(calls)', mutating '$(mutating_commands)'; out: ${out}"
drop_fixture

make_fixture
out="$(ship 2>&1)"; rc=$?
cl="$(cat "${FAKE_STATE}/checklist.txt" 2>/dev/null)"
want_ok=true
for want in "HEAD == origin/main: yes (HEAD ${C2}, origin/main ${C2})" "tracked tree clean: yes" \
            "bun install --frozen-lockfile: pass" "bun run typecheck: pass" \
            "bun scripts/gate.ts: pass (gate: PASS files=3 tests=42)" \
            "setup present: static yes, backstage yes" "backstage curl config: set (private file)" \
            "Release contents: static and backstage will be updated to ${C2:0:7}"; do
    printf '%s\n' "$cl" | grep -qxF -- "$want" || { want_ok=false; echo "    missing checklist line: ${want}"; }
done
$want_ok && [[ $rc -eq 0 ]] && ok "the checklist Jev sees carries HEAD/main, clean tree, deps, typecheck, gate count, setup, curl config and one release-contents line" \
    || nope "checklist: rc=${rc}; ${cl}"
grep -qF "## Release checklist and Jev" "${FAKE_STATE}/notes.md" && grep -qF "jev: yes (p(yes)=0.930, jev-1.13.0)" "${FAKE_STATE}/notes.md" \
    && grep -qF "bun scripts/gate.ts: pass (gate: PASS files=3 tests=42)" "${FAKE_STATE}/notes.md" \
    && grep -qF "static: deploy; serving ${C1}; drift none (sha differs, no module changes)" "${FAKE_STATE}/notes.md" \
    && ok "the GitHub release notes record the checklist, Jev's answer and the full deploy plan" \
    || nope "release notes lack the checklist or plan: $(cat "${FAKE_STATE}/notes.md" 2>/dev/null)"
drop_fixture

# 2026-10-09 live: Jev answered no (p(yes)=0.080) to an all-pass checklist whose plan lines read
# "drift STALE (8 commits behind; changed: ...)". A module behind main is why it deploys, not a
# failed check, so the text Jev sees carries no plan, drift or path wording.
make_fixture
serve static "$C0"
out="$(ship 2>&1)"; rc=$?
cl="$(cat "${FAKE_STATE}/checklist.txt" 2>/dev/null)"
[[ $rc -eq 0 && -n "$cl" ]] && ! printf '%s\n' "$cl" | grep -Eiq 'stale|behind|drift|serving|changed|site/label' \
    && printf '%s\n' "$cl" | grep -qxF "Release contents: static and backstage will be updated to ${C2:0:7}" \
    && [[ "$out" == *"static: deploy; serving ${C0}; drift STALE (2 commits behind; changed: site/label/page.html)"* ]] \
    && grep -qF "drift STALE (2 commits behind" "${FAKE_STATE}/notes.md" \
    && ok "with a STALE module, Jev's text has no STALE/behind/drift/path wording; stdout and release notes keep the full plan" \
    || nope "plan wording reached Jev or left the record: rc=${rc}; sent: ${cl}"
drop_fixture

make_fixture
serve static "$C2"
out="$(ship --no-release 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && grep -qxF "Release contents: backstage will be updated to ${C2:0:7}" "${FAKE_STATE}/checklist.txt" \
    && ok "the release-contents line names only the modules in the plan" \
    || nope "contents line: rc=${rc}; sent: $(cat "${FAKE_STATE}/checklist.txt" 2>/dev/null)"
drop_fixture

make_fixture
out="$(FAKE_JEV_RC=1 ship --no-jev 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"--no-jev: deploying without asking Jev"* && "$(bunlog)" != *"deploy-checklist"* \
   && "$(bunlog)" == *"scripts/gate.ts"* && "$(calls)" == "deploy.sh |backstage-deploy.sh |" ]] \
    && grep -qF "jev: skipped (--no-jev)" "${FAKE_STATE}/notes.md" \
    && ok "--no-jev skips only the question (logged, recorded in the release notes); the dependency check still runs" \
    || nope "--no-jev: rc=${rc}, bun.log '$(bunlog)', calls '$(calls)'; out: ${out}"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
out="$(FAKE_JEV_RC=1 ship --no-release 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"jev: not asked (every module is up to date)"* && "$(bunlog)" != *"deploy-checklist"* ]] \
    && ok "with every module up to date, Jev is not asked and nothing deploys" \
    || nope "all current jev: rc=${rc}, bun.log '$(bunlog)'; out: ${out}"
drop_fixture

make_fixture
out="$(ship --help 2>&1)"
[[ "$out" == *"--no-jev"* ]] && ok "--help lists --no-jev" || nope "--help lacks --no-jev"
drop_fixture

echo
echo "[T1] gate panel on c90517a"

# Panel #1: nothing to deploy -> no install, typecheck or gate (a retry that only needs the release
# record must not wait minutes for, or be blocked by, the test gate).
make_fixture
serve static "$C2"; serve backstage "$C2"
out="$(FAKE_BUN_GATE_RC=1 ship 2>&1)"; rc=$?
[[ $rc -eq 0 && ! -s "${FAKE_STATE}/bun.log" && -z "$(calls)" && "$out" == *"Dependency check: not run (every module is up to date)"* \
   && "$out" == *"jev: not asked (every module is up to date)"* && "$("$REAL_GIT" -C "$WORK" cat-file -t "v${TODAY}.1" 2>/dev/null)" == tag ]] \
    && ok "panel #1: every module current -> no install/typecheck/gate, Jev not asked, release still recorded" \
    || nope "panel #1 all current: rc=${rc}, bun.log '$(bunlog)', calls '$(calls)'; out: ${out}"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
out="$(ship --dry-run 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"Dependency check: not run (every module is up to date)"* && "$out" != *"would run, in order"* ]] \
    && ok "panel #1: --dry-run with nothing to deploy says the dependency check would not run" \
    || nope "panel #1 dry-run all current: rc=${rc}; out: ${out}"
drop_fixture

make_fixture
out="$(ship 2>&1)"; rc=$?
first_lock="$(grep -n '^mkdir /var/lock/jevnotjev-ship$' "${FAKE_STATE}/ssh.log" | head -1 | cut -d: -f1)"
[[ $rc -eq 0 && "$(bunlog)" == "install --frozen-lockfile|run typecheck|scripts/gate.ts|"* && -n "$first_lock" ]] \
    && ok "panel #1: with a module to deploy, the dependency check still runs, and the lock is taken after it" \
    || nope "panel #1 deploy: rc=${rc}, bun.log '$(bunlog)'; out: ${out}"
drop_fixture

# Panel #2: refusals, not checklist items.
make_fixture
echo no > "${FAKE_STATE}/backstage_setup"
out="$(ship 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"Backstage setup is missing"* && -z "$(calls)" && "$(bunlog)" != *"deploy-checklist"* && -z "$(tags)" ]] \
    && grep -qx 'rmdir /var/lock/jevnotjev-ship' "${FAKE_STATE}/ssh.log" \
    && ok "panel #2: backstage in the plan without setup refuses (exit 1) before any module script and before Jev" \
    || nope "panel #2 setup: rc=${rc}, calls '$(calls)', bun.log '$(bunlog)'; out: ${out}"
drop_fixture

make_fixture
serve static "$C0"; serve backstage "$C2"; echo no > "${FAKE_STATE}/backstage_setup"
out="$(ship --no-release 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(calls)" == "deploy.sh |" && "$out" != *"Backstage setup is missing"* ]] \
    && ok "panel #2: the setup refusal applies only when backstage is in the plan (static-only deploy proceeds)" \
    || nope "panel #2 setup scoped: rc=${rc}, calls '$(calls)'; out: ${out}"
drop_fixture

make_fixture
serve static "$C0"; serve backstage "$C2"
chmod 644 "${FIX}/curl-config"
out="$(ship 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"mode 0600"* && -z "$(calls)" && "$(bunlog)" != *"deploy-checklist"* ]] \
    && ok "panel #2: a gated host with a non-private curl config refuses (exit 1) even for a static-only plan" \
    || nope "panel #2 loose config: rc=${rc}, calls '$(calls)', bun.log '$(bunlog)'; out: ${out}"
out="$(ship --dry-run 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"would refuse (exit 1)"* ]] \
    && ok "panel #2: --dry-run reports the refusal it would make and stays exit 0" \
    || nope "panel #2 loose config dry-run: rc=${rc}; out: ${out}"
drop_fixture

make_fixture
out="$(BACKSTAGE_CURL_CONFIG= ship 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"export BACKSTAGE_CURL_CONFIG="* && -z "$(calls)" ]] \
    && ok "panel #2: a gated host with no curl config refuses before any module script" \
    || nope "panel #2 no config: rc=${rc}, calls '$(calls)'; out: ${out}"
drop_fixture

# Panel #3: --no-jev only means something on a deploy.
make_fixture
nj_ok=true
for action in "--status" "--verify" "--setup --module static" "--module static --rollback"; do
    # shellcheck disable=SC2086
    out="$(ship $action --no-jev 2>&1)"; rc=$?
    [[ $rc -eq 2 && "$out" == *"--no-jev"* ]] || { nj_ok=false; echo "    ${action} --no-jev: rc=${rc}"; }
done
$nj_ok && [[ -z "$(calls)" ]] && ok "panel #3: --no-jev with --status, --verify, --setup or --rollback is a usage error (exit 2)" \
    || nope "panel #3 usage: calls '$(calls)'"
drop_fixture

make_fixture
out="$(ship --dry-run --no-jev 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"jev: would be skipped (--no-jev, dry-run)"* && "$out" != *"deploying without asking Jev"* ]] \
    && ok "panel #3: --dry-run --no-jev says the question would be skipped, not that it is deploying" \
    || nope "panel #3 dry-run: rc=${rc}; out: ${out}"
drop_fixture

# Panel #4: a backtick run in the checklist record cannot close the release-notes fence.
make_fixture
out="$(FAKE_JEV_ANSWER='yes ````' ship 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && grep -qx '`````text' "${FAKE_STATE}/notes.md" && grep -qx '`````' "${FAKE_STATE}/notes.md" \
    && ! grep -qx '```text' "${FAKE_STATE}/notes.md" \
    && ok "panel #4: the checklist fence is longer than any backtick run in the record" \
    || nope "panel #4 fence: rc=${rc}; notes: $(cat "${FAKE_STATE}/notes.md" 2>/dev/null)"
drop_fixture

echo
echo "[T1] the dependency check runs without the deploy's own state variables"
# 2026-10-09: the lock-free state read exported BACKSTAGE_GATE=session; the real gate inherited it
# and backstage-setup.test.sh failed 16 cases. The gated fixture sets BACKSTAGE_GATE (state read)
# and BACKSTAGE_CURL_CONFIG; a stale BACKSTAGE_SESSION_JAR comes from the caller's shell.
make_fixture
out="$(BACKSTAGE_SESSION_JAR=/tmp/stale-jar ship 2>&1)"; rc=$?
envlog="${FAKE_STATE}/bun-env.log"
step_env() { awk -F '\t' -v s="$1" 'index($1, s) == 1 {print $2}' "$envlog" 2>/dev/null; }
# Problems in an env log ($1) for the three dependency commands: each must have EXACTLY one row
# (a missing row is a failure, never "clean") and that row must carry none of the variables.
deps_env_problems() {
    local s n env
    for s in "install --frozen-lockfile" "run typecheck" "scripts/gate.ts"; do
        n="$(awk -F '\t' -v s="$s" '$1 == s' "$1" 2>/dev/null | wc -l | tr -d ' ')"
        if [[ "$n" != 1 ]]; then printf ' [%s: %s rows, want 1]' "$s" "$n"; continue; fi
        env="$(awk -F '\t' -v s="$s" '$1 == s {print $2}' "$1")"
        [[ -z "$(printf '%s' "$env" | tr -d ' ')" ]] || printf ' [%s: %s]' "$s" "$env"
    done
}
[[ $rc -eq 0 && "$(step_env "--no-env-file scripts/deploy-checklist.ts")" == *"BACKSTAGE_GATE=yes"* ]] \
    && ok "control: the state read exported BACKSTAGE_GATE=yes (the checklist step after it sees it)" \
    || nope "control: rc=${rc}, checklist env '$(step_env "--no-env-file scripts/deploy-checklist.ts")'; out: ${out}"
problems="$(deps_env_problems "$envlog")"
[[ $rc -eq 0 && -z "$problems" ]] \
    && ok "install, typecheck and the gate each ran once and inherited no BACKSTAGE_GATE, BACKSTAGE_SESSION_JAR or BACKSTAGE_CURL_CONFIG" \
    || nope "dependency check env:${problems}"
# Negative controls on copies of the real log: a dropped row, or a duplicated one, must be reported.
grep -v "^install --frozen-lockfile	" "$envlog" > "${FIX}/env-no-install.log"
awk '{print} /^run typecheck\t/ {print}' "$envlog" > "${FIX}/env-two-typecheck.log"
[[ "$(deps_env_problems "${FIX}/env-no-install.log")" == *"install --frozen-lockfile: 0 rows, want 1"* \
   && "$(deps_env_problems "${FIX}/env-two-typecheck.log")" == *"run typecheck: 2 rows, want 1"* ]] \
    && ok "the env assertion fails when an install row is missing or a typecheck row is duplicated (never vacuous)" \
    || nope "env assertion vacuous: no-install '$(deps_env_problems "${FIX}/env-no-install.log")', two-typecheck '$(deps_env_problems "${FIX}/env-two-typecheck.log")'"
drop_fixture

echo
echo "[T1] BACKSTAGE_CURL_CONFIG defaults to the documented private file"
make_fixture
serve static "$C2"; serve backstage "$C2"
"$REAL_GIT" -C "$WORK" tag -a v2026.01.01.1 -m r "$C2" && "$REAL_GIT" -C "$WORK" push -q origin refs/tags/v2026.01.01.1 >/dev/null 2>&1
FAKE_HOME="${FIX}/home"; mkdir -p "${FAKE_HOME}/.config/jevnotjev"
( umask 077; printf 'user = "tester:x"\n' > "${FAKE_HOME}/.config/jevnotjev/backstage-curl" )
status_home() { (cd "$WORK" && env -u BACKSTAGE_CURL_CONFIG HOME="$FAKE_HOME" PATH="${FAKEBIN}:${PATH}" bash .deploy/ship.sh --status "$@"); }
out="$(status_home 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && grep 'api/backstage/health' "${FAKE_STATE}/curl.log" | grep -qF -- "--config ${FAKE_HOME}/.config/jevnotjev/backstage-curl" \
    && ok "unset variable + the documented file present: status uses \$HOME/.config/jevnotjev/backstage-curl" \
    || nope "default config: rc=${rc}; out: ${out}"
: > "${FAKE_STATE}/curl.log"
out="$(cd "$WORK" && HOME="$FAKE_HOME" BACKSTAGE_CURL_CONFIG="${FIX}/curl-config" PATH="${FAKEBIN}:${PATH}" bash .deploy/ship.sh --status 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && grep 'api/backstage/health' "${FAKE_STATE}/curl.log" | grep -qF -- "--config ${FIX}/curl-config" \
    && ! grep -qF "${FAKE_HOME}" "${FAKE_STATE}/curl.log" \
    && ok "an explicit BACKSTAGE_CURL_CONFIG wins over the default" || nope "explicit config: rc=${rc}; out: ${out}"
chmod 644 "${FAKE_HOME}/.config/jevnotjev/backstage-curl"
out="$(status_home 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"mode 0600"* ]] \
    && ok "a group/world-readable default file is still refused by the private-file check" \
    || nope "loose default: rc=${rc}; out: ${out}"
rm -f "${FAKE_HOME}/.config/jevnotjev/backstage-curl"
out="$(status_home 2>&1)"; rc=$?
[[ $rc -eq 1 && "$out" == *"export BACKSTAGE_CURL_CONFIG="* ]] \
    && ok "unset variable and no documented file: status still fails naming the variable" \
    || nope "no default file: rc=${rc}; out: ${out}"
drop_fixture

echo
echo "[T1] --setup --dry-run through the real scripts is read-only"
FAKE_STATE="$(mktemp -d)"; export FAKE_STATE
out="$(PATH="${FAKEBIN}:${PATH}" bash "$SHIP" --setup --module backstage --dry-run 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -eq 0 && -z "$mut" ]] \
    && ok "--setup --module backstage --dry-run issued zero mutating remote commands" \
    || nope "setup dry-run rc=${rc}, mutating: ${mut:-none}; out: ${out}"
[[ "$out" == *"+"*"include /etc/nginx/snippets/jevnotjev-backstage.conf;"* ]] \
    && ok "--setup --dry-run prints the vhost diff the operator reviews" \
    || nope "no vhost diff in dry-run output: ${out}"
rm -rf "$FAKE_STATE"

rm -rf "$FAKEBIN"

echo
echo "[T1] passed=${pass} failed=${fail}"
[[ $fail -eq 0 ]]
