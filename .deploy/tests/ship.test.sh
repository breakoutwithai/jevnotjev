#!/usr/bin/env bash
#
# [T1] ship.sh: one entrypoint for every module. Flag validation, dispatch to the existing
# module scripts, module order and honest exit codes, and a read-only --status.
#
# Dispatch cases run a COPY of the real ship.sh next to stub module scripts that record their
# arguments, so no module script and no host is ever reached. Status and the setup dry-run run
# the REAL ship.sh with a fake `ssh` and `curl` first on PATH that log every remote command and
# return canned output. The host is pointed at TEST-NET (192.0.2.1) as a second guard.
# Hermetic: no ssh, no network. Bash 3.2 compatible.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
REPO_ROOT="$(pwd)"
SHIP="${REPO_ROOT}/.deploy/ship.sh"

pass=0; fail=0
ok()   { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }

export JEVNOTJEV_SERVER_HOST=192.0.2.1

# A remote command mutates when, after its harmless redirections are removed, it writes,
# moves, deletes, creates, or changes a service or nginx state.
is_mutating() {
    local c="$1"
    c="$(printf '%s' "$c" | sed -E 's#[0-9]?>&[0-9]##g; s#[0-9]?>[[:space:]]*/dev/null##g')"
    printf '%s' "$c" | grep -Eq '>|(^|[^a-z-])(mv|cp|rm|rmdir|ln|mkdir|touch|chmod|chown|tee|useradd|groupadd|install|tar)([[:space:]]|$)|systemctl[[:space:]]+(enable|disable|reload|restart|start|stop|daemon-reload)|nginx[[:space:]]+-s'
}

# ------------------------------------------------------------------ dispatch fixture
# A throwaway .deploy/ holding the real ship.sh and stub module scripts. Each stub appends
# "<name> <args>" to CALLS and exits with STUB_RC_<NAME> (default 0).
make_fixture() {
    FIX="$(mktemp -d)"
    mkdir -p "${FIX}/.deploy"
    cp "$SHIP" "${FIX}/.deploy/ship.sh"
    CALLS="${FIX}/calls.log"; : > "$CALLS"
    local s var
    for s in deploy backstage-deploy provision backstage-setup; do
        var="STUB_RC_$(printf '%s' "$s" | tr 'a-z-' 'A-Z_')"
        cat > "${FIX}/.deploy/${s}.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "${s}.sh \$*" >> "${CALLS}"
exit "\${${var}:-0}"
EOF
    done
}
drop_fixture() { [[ -n "${FIX:-}" && -d "$FIX" ]] && rm -rf "$FIX"; }
calls() { tr '\n' '|' < "$CALLS"; }

echo "[T1] ship.sh flag validation"

if [[ ! -f "$SHIP" ]]; then
    nope "missing ${SHIP}"
    echo "[T1] passed=${pass} failed=${fail}"; exit 1
fi

make_fixture
out="$(bash "${FIX}/.deploy/ship.sh" --module nonsense 2>&1)"; rc=$?
[[ $rc -eq 2 && "$out" == *"Usage:"* && -z "$(calls)" ]] \
    && ok "unknown --module exits 2 with usage and dispatches nothing" \
    || nope "unknown --module: rc=${rc}, calls '$(calls)', out: ${out}"
out="$(bash "${FIX}/.deploy/ship.sh" --module 2>&1)"; rc=$?
[[ $rc -eq 2 && -z "$(calls)" ]] && ok "--module with no value exits 2" || nope "--module without value: rc=${rc}"
out="$(bash "${FIX}/.deploy/ship.sh" --frobnicate 2>&1)"; rc=$?
[[ $rc -eq 2 && "$out" == *"Usage:"* && -z "$(calls)" ]] \
    && ok "an unknown flag exits 2 and never means 'deploy'" || nope "unknown flag: rc=${rc}, calls '$(calls)'"
out="$(bash "${FIX}/.deploy/ship.sh" --status --setup 2>&1)"; rc=$?
[[ $rc -eq 2 && -z "$(calls)" ]] && ok "two actions at once (--status --setup) exit 2" || nope "two actions: rc=${rc}"
out="$(bash "${FIX}/.deploy/ship.sh" --rollback 2>&1)"; rc=$?
[[ $rc -eq 2 && -z "$(calls)" ]] && ok "--rollback with the default --module all exits 2 (rollback is per module)" || nope "--rollback all: rc=${rc}"
out="$(bash "${FIX}/.deploy/ship.sh" --module backstage --rollback 2>&1)"; rc=$?
[[ $rc -eq 2 && -z "$(calls)" ]] && ok "backstage --rollback without a SHA exits 2" || nope "backstage rollback no SHA: rc=${rc}"
out="$(bash "${FIX}/.deploy/ship.sh" --module backstage --rollback abc123 2>&1)"; rc=$?
[[ $rc -eq 2 && -z "$(calls)" ]] && ok "backstage --rollback with a short SHA exits 2" || nope "short SHA: rc=${rc}"
out="$(bash "${FIX}/.deploy/ship.sh" --module static --rollback 0123456789abcdef0123456789abcdef01234567 2>&1)"; rc=$?
[[ $rc -eq 2 && "$out" == *"previous verified release"* && -z "$(calls)" ]] \
    && ok "static --rollback with a SHA exits 2 (static selects the previous verified release)" \
    || nope "static rollback with SHA: rc=${rc}, out: ${out}"

out="$(bash "${FIX}/.deploy/ship.sh" --help 2>&1)"; rc=$?
help_ok=true
for want in "--module static|backstage|all" "--dry-run" "--status" "--setup" "--rollback"; do
    [[ "$out" == *"$want"* ]] || help_ok=false
done
[[ $rc -eq 0 && "$help_ok" == true && -z "$(calls)" ]] \
    && ok "--help lists --module static|backstage|all, --dry-run, --status, --setup, --rollback" \
    || nope "--help rc=${rc}: ${out}"
drop_fixture

echo
echo "[T1] ship.sh dispatch"

make_fixture
bash "${FIX}/.deploy/ship.sh" --module static --dry-run >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "deploy.sh --dry-run|" ]] \
    && ok "--module static --dry-run calls only deploy.sh --dry-run" \
    || nope "static dry-run: rc=${rc}, calls '$(calls)'"
drop_fixture

make_fixture
bash "${FIX}/.deploy/ship.sh" --module backstage >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "backstage-deploy.sh |" ]] \
    && ok "--module backstage calls only backstage-deploy.sh with no flags" \
    || nope "backstage: rc=${rc}, calls '$(calls)'"
drop_fixture

make_fixture
bash "${FIX}/.deploy/ship.sh" >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "deploy.sh |backstage-deploy.sh |" ]] \
    && ok "default (--module all) runs static first, then backstage" \
    || nope "all: rc=${rc}, calls '$(calls)'"
drop_fixture

make_fixture
out="$(STUB_RC_BACKSTAGE_DEPLOY=1 bash "${FIX}/.deploy/ship.sh" --module all 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(calls)" == "deploy.sh |backstage-deploy.sh |" && "$out" == *"static"*"OK"* && "$out" == *"backstage"*"FAILED"* ]] \
    && ok "--module all: a backstage failure leaves the verified static release alone and exits non-zero" \
    || nope "backstage fail: rc=${rc}, calls '$(calls)', out: ${out}"
drop_fixture

make_fixture
out="$(STUB_RC_DEPLOY=3 bash "${FIX}/.deploy/ship.sh" --module all 2>&1)"; rc=$?
[[ $rc -eq 3 && "$(calls)" == "deploy.sh |" && "$out" == *"backstage"*"SKIPPED"* ]] \
    && ok "--module all: a static failure stops before backstage and exits with the static rc (3)" \
    || nope "static fail: rc=${rc}, calls '$(calls)', out: ${out}"
drop_fixture

make_fixture
STUB_RC_BACKSTAGE_DEPLOY=4 bash "${FIX}/.deploy/ship.sh" --module backstage >/dev/null 2>&1; rc=$?
[[ $rc -eq 4 ]] \
    && ok "the wrapper exits with the module's own status (4), not a later step's" \
    || nope "wrapper rc=${rc}, expected 4"
drop_fixture

make_fixture
bash "${FIX}/.deploy/ship.sh" --module static --rollback --dry-run >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "deploy.sh --rollback --dry-run|" ]] \
    && ok "static --rollback --dry-run dispatches deploy.sh --rollback --dry-run" \
    || nope "static rollback: calls '$(calls)'"
drop_fixture

SHA40=0123456789abcdef0123456789abcdef01234567
make_fixture
bash "${FIX}/.deploy/ship.sh" --module backstage --rollback "$SHA40" >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "backstage-deploy.sh --rollback ${SHA40}|" ]] \
    && ok "backstage --rollback <SHA> dispatches backstage-deploy.sh --rollback <SHA>" \
    || nope "backstage rollback: calls '$(calls)'"
drop_fixture

make_fixture
bash "${FIX}/.deploy/ship.sh" --setup --module backstage >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 && "$(calls)" == "backstage-setup.sh |" ]] \
    && ok "--setup --module backstage dispatches backstage-setup.sh only" \
    || nope "setup backstage: calls '$(calls)'"
drop_fixture

make_fixture
bash "${FIX}/.deploy/ship.sh" --setup --module static >/dev/null 2>&1; rc=$?
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
    bash "${FIX}/.deploy/ship.sh" $action --dry-run >/dev/null 2>&1 || all_dry=false
    [[ -s "$CALLS" ]] || all_dry=false
    while IFS= read -r line; do
        [[ "$line" == *"--dry-run"* ]] || { all_dry=false; echo "    not dry: ${line} (action '${action}')"; }
    done < "$CALLS"
    drop_fixture
done
$all_dry && ok "deploy, setup and both rollbacks pass --dry-run to every module script they call" \
    || nope "a mutating action reached a module script without --dry-run"

# ---------------------------------------------------------- fake ssh + curl (real ship.sh)
FAKEBIN="$(mktemp -d)"
SSHLOG="${FAKEBIN}/ssh.log"
KEY="${FAKEBIN}/key"; : > "$KEY"
export JEVNOTJEV_SSH_KEY="$KEY"
cat > "${FAKEBIN}/ssh" <<'EOF'
#!/usr/bin/env bash
# Fake ssh: the remote command is the last argument. Log it, never run it, answer canned text.
cmd="${@: -1}"
printf '%s\n---\n' "$cmd" >> "${FAKE_SSH_LOG}"
case "$cmd" in
    "echo ok") echo ok ;;
    *"uname -m"*)
        printf '%s\n' arch=x86_64 bun=1.3.0 user=absent port=free unit=absent snippet=absent \
            vhost=present vhost_link=yes include=absent enabled=no active=no ;;
    *"jevnotjev-backstage-current"*)
        printf '%s\n' release=none verified=no service=inactive enabled=no setup=no ;;
    *"/var/www/jevnotjev"*)
        printf '%s\n' release=/var/www/jevnotjev-releases/20261003T203100Z-80cf0a1 marker=80cf0a1full \
            verified=yes service=active setup=yes ;;
    "cat '/etc/nginx/sites-available/jevnotjev.breakoutwithai.com'")
        printf '%s\n' 'server {' '    server_name jevnotjev.breakoutwithai.com;' '    root /var/www/jevnotjev;' \
            '    listen 443 ssl; # managed by Certbot' '}' 'server {' '    listen 80;' '    return 404;' '}' ;;
    *"sites-enabled/*"*) printf '%s\n' 'server { server_name a.example.com; }' ;;
esac
exit 0
EOF
cat > "${FAKEBIN}/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "${FAKE_SSH_LOG}.curl"
case "$*" in
    *DEPLOYED_SHA*) echo SERVED_FROM_CURL ;;
    *api/backstage/health*) echo "curl: (22) The requested URL returned error: 404" >&2; exit 22 ;;
    *) printf 200 ;;
esac
EOF
chmod +x "${FAKEBIN}/ssh" "${FAKEBIN}/curl"
export FAKE_SSH_LOG="$SSHLOG"

# Split the log into commands and report the mutating ones.
mutating_commands() {
    local line buf=""
    while IFS= read -r line; do
        if [[ "$line" == "---" ]]; then
            is_mutating "$buf" && printf '%s\n' "$buf"
            buf=""
        else
            buf="${buf}${buf:+ }${line}"
        fi
    done < "$SSHLOG"
}

echo
echo "[T1] --status is read-only"
: > "$SSHLOG"
out="$(PATH="${FAKEBIN}:${PATH}" bash "$SHIP" --status 2>&1)"; rc=$?
n_cmds="$(grep -c '^---$' "$SSHLOG")"
mut="$(mutating_commands)"
[[ $rc -eq 0 && "$n_cmds" -gt 0 && -z "$mut" ]] \
    && ok "--status issued ${n_cmds} remote command(s), zero mutating" \
    || nope "--status rc=${rc}, ${n_cmds} command(s), mutating: ${mut:-none}; out: ${out}"
# Exact field lines per module section: a value that appears elsewhere cannot satisfy them.
section() { printf '%s\n' "$out" | awk -v m="$1" '$0 == m {on=1; next} /^[a-z]/ {on=0} on'; }
st="$(section static)"; bs="$(section backstage)"
printf '%s\n' "$st" | grep -Eq '^  served +SERVED_FROM_CURL$' \
    && printf '%s\n' "$st" | grep -Eq '^  verified +yes$' && printf '%s\n' "$st" | grep -Eq '^  setup +yes$' \
    && ok "--status static: served SHA comes from the pinned curl, plus verified and setup fields" \
    || nope "--status static section wrong: ${st}"
printf '%s\n' "$bs" | grep -Eq '^  served +none$' && printf '%s\n' "$bs" | grep -Eq '^  setup +no$' \
    && ok "--status backstage: an unserved backstage reports served none and setup no" \
    || nope "--status backstage section wrong: ${bs}"

echo
echo "[T1] --setup --dry-run through the real scripts is read-only"
: > "$SSHLOG"
out="$(PATH="${FAKEBIN}:${PATH}" bash "$SHIP" --setup --module backstage --dry-run 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -eq 0 && -z "$mut" ]] \
    && ok "--setup --module backstage --dry-run issued zero mutating remote commands" \
    || nope "setup dry-run rc=${rc}, mutating: ${mut:-none}; out: ${out}"
[[ "$out" == *"+"*"include /etc/nginx/snippets/jevnotjev-backstage.conf;"* ]] \
    && ok "--setup --dry-run prints the vhost diff the operator reviews" \
    || nope "no vhost diff in dry-run output: ${out}"

: > "$SSHLOG"
out="$(PATH="${FAKEBIN}:${PATH}" bash "$SHIP" --module backstage --dry-run 2>&1)"; rc=$?
[[ $rc -eq 0 && ! -s "$SSHLOG" ]] \
    && ok "--module backstage --dry-run contacts no host" \
    || nope "backstage dry-run rc=${rc}, ssh log: $(cat "$SSHLOG")"

rm -rf "$FAKEBIN"

echo
echo "[T1] passed=${pass} failed=${fail}"
[[ $fail -eq 0 ]]
