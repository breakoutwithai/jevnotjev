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
    *"uname -m"*)
        printf '%s\n' arch=x86_64 bun=1.3.0 user=absent port=free unit=absent snippet=absent \
            vhost=present vhost_link=yes include=absent enabled=no active=no \
            ht_tool=htpasswd nginx_group=www-data htpasswd=root:www-data:640:44 htpasswd_dir=root:www-data:750 ;;
    "S='/etc/nginx/snippets/jevnotjev-backstage.conf'"*)
        # The installed snippet: the repo copy (auth), auth switched off, unreadable, or absent.
        case "${FAKE_AUTH:-}" in
            1) cat "${FAKE_REPO}/.deploy/backstage-nginx.conf" ;;
            off) sed 's/auth_basic "Backstage";/auth_basic off;/' "${FAKE_REPO}/.deploy/backstage-nginx.conf" ;;
            readfail) echo 'cat: Permission denied' >&2; exit 1 ;;
            *) exit 10 ;;
        esac ;;
    *"jevnotjev-backstage-current"*)
        s="$(st backstage_served none)"
        if [ "$s" = none ]; then rel=none; else rel="/var/www/jevnotjev-backstage-releases/${s}"; fi
        printf '%s\n' "release=${rel}" "verified=$(st backstage_verified yes)" \
            "service=active, enabled" "setup=$(st backstage_setup yes)" ;;
    *"/var/www/jevnotjev"*)
        s="$(st static_served none)"
        printf '%s\n' "release=/var/www/jevnotjev-releases/20261003T203100Z-${s:0:7}" "marker=${s}" \
            "verified=$(st static_verified yes)" "service=nginx active" setup=yes ;;
    "cat '/etc/nginx/sites-available/jevnotjev.breakoutwithai.com'")
        printf '%s\n' 'server {' '    server_name jevnotjev.breakoutwithai.com;' '    root /var/www/jevnotjev;' \
            '    listen 443 ssl; # managed by Certbot' '}' 'server {' '    listen 80;' '    return 404;' '}' ;;
    *"sites-enabled/*"*) printf '%s\n' 'server { server_name a.example.com; }' ;;
esac
exit 0
EOF
cat > "${FAKEBIN}/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "${FAKE_STATE}/curl.log"
st() { cat "${FAKE_STATE}/$1" 2>/dev/null || printf '%s' "$2"; }
case "$*" in
    *DEPLOYED_SHA*)
        s="$(st static_served none)"
        if [ "$s" = none ]; then echo "curl: (22) 404" >&2; exit 22; fi
        echo "$s" ;;
    *api/backstage/health*)
        s="$(st backstage_served none)"
        if [ "$s" = none ]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi
        # Shape of the real health body: a nested catalog after the top-level release fields.
        printf '{"protocol":"backstage/2","version":"%s","catalogVersion":"2026-10-04.1","catalog":{"version":"NESTED"}}\n' "$s" ;;
    *) printf 200 ;;
esac
EOF
cat > "${FAKEBIN}/gh" <<'EOF'
#!/usr/bin/env bash
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
# git push is logged and never reaches a remote; every other git command is the real git.
if [ "\${1:-}" = push ]; then
    printf 'git %s\n' "\$*" >> "\${FAKE_STATE}/push.log"
    exit "\${STUB_RC_PUSH:-0}"
fi
exec "${REAL_GIT}" "\$@"
EOF
chmod +x "${FAKEBIN}/ssh" "${FAKEBIN}/curl" "${FAKEBIN}/gh" "${FAKEBIN}/git"
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
        mkdir -p site/backstage
        echo index > site/index.html; echo app > site/backstage/app.js; echo readme > README
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
        "${REPO_ROOT}/.deploy/backstage-lib.sh" "${WORK}/.deploy/"
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
case " \$* " in *" --dry-run "*|*" --rollback "*) exit "\$rc" ;; esac
if [ "\$rc" = 0 ] && [ -n "${mod}" ] && [ -z "\${STUB_NO_UPDATE:-}" ]; then
    git -C "\$(dirname "\$0")/.." rev-parse origin/main > "${FAKE_STATE}/${mod}_served"
    echo yes > "${FAKE_STATE}/${mod}_verified"
fi
exit "\$rc"
EOF
    done
    serve static "$C1"; serve backstage "$C1"
}
drop_fixture() { [[ -n "${FIX:-}" && -d "$FIX" ]] && rm -rf "$FIX"; }
serve() { printf '%s\n' "$2" > "${FAKE_STATE}/$1_served"; }
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
[[ $rc -eq 0 ]] && printf '%s\n' "$st" | grep -Eq '^  drift +none$' \
    && ok "--status exits 0 when no module is STALE or UNKNOWN; at main is drift none" \
    || nope "--status none: rc=${rc}; out: ${out}"
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
    && ok "--status names the release tag on the served SHA and reads the top-level version, not a nested one" \
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
out="$(ship 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(tags)" == "v2026.01.01.1 " && -z "$(pushes)" && -z "$(ghcalls)" && "$out" == *"v2026.01.01.1"* ]] \
    && ok "a release tag already on S: no new tag, no push, no gh, prints the existing tag" \
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
out="$(FAKE_AUTH=1 ship --status 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"BACKSTAGE_CURL_CONFIG"* && "$out" != *"401"* ]] \
    && ok "auth snippet + BACKSTAGE_CURL_CONFIG unset -> status fails naming the variable, not a bare 401" \
    || nope "status auth no config: rc=${rc}; out: ${out}"
grep -q 'api/backstage' "${FAKE_STATE}/curl.log" 2>/dev/null \
    && nope "an unauthenticated Backstage probe was still sent" || ok "no Backstage probe is sent without credentials"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
out="$(FAKE_AUTH=1 ship --dry-run 2>&1)"; rc=$?
grep -q 'api/backstage' "${FAKE_STATE}/curl.log" 2>/dev/null \
    && nope "the deploy plan's drift read sent an unauthenticated Backstage probe" \
    || ok "deploy drift reads send no Backstage probe without credentials (backstage drift UNKNOWN)"
drop_fixture

make_fixture
serve static "$C2"; serve backstage "$C2"
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
out="$(ship --status --module backstage 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "no auth snippet on the host -> status needs no curl config" || nope "status open: rc=${rc}; out: ${out}"
out="$(FAKE_AUTH=off ship --status --module backstage 2>&1)"; rc=$?
bs="$(section backstage)"
[[ $rc -eq 0 ]] && printf '%s\n' "$bs" | grep -Eq '^  auth +no$' \
    && ok "a snippet with 'auth_basic off;' reports auth no (the file directive alone is not auth)" \
    || nope "auth off: rc=${rc}; out: ${out}"
out="$(BACKSTAGE_CURL_CONFIG="${CFGDIR}/curl" FAKE_AUTH=readfail ship --status --module backstage 2>&1)"; rc=$?
bs="$(section backstage)"
[[ $rc -ne 0 ]] && printf '%s\n' "$bs" | grep -Eq '^  auth +unknown$' && printf '%s\n' "$bs" | grep -Eq '^  drift +UNKNOWN' \
    && ok "an unreadable snippet reports auth unknown, drift UNKNOWN and fails, never auth no" \
    || nope "read failure: rc=${rc}; out: ${out}"
drop_fixture
rm -rf "$CFGDIR"

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
