#!/usr/bin/env bash
#
# [T1] Release swap, rollback, prune, served-path guard, neighbour probes and manifest.
#
# Drives the REAL lib.sh functions against a FAKE `remote` that executes each command locally
# on a fixture directory (no ssh, no box, no network). The only translation is `mv -T`, which
# is GNU-only: on BSD it is emulated with `ln -sfn`, the same rename(2) replacement.
#
# Ported from lakelife .deploy/tests/rollback.test.sh and release.test.sh, minus PM2/bun/data.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
REPO_ROOT="$(pwd)"
D=".deploy/deploy.sh"
L=".deploy/lib.sh"

pass=0; fail=0
ok()   { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }

HEALTH_URL="https://fixture.invalid"; CURL_PIN=""
log_info()    { echo "[INFO] $1"; }
log_success() { echo "[ OK ] $1"; }
log_warn()    { echo "[WARN] $1"; }
log_error()   { echo "[FAIL] $1" >&2; }
source "$L"

if mv --version 2>/dev/null | grep -q GNU; then
    atomic_replace_symlink() { local t="${2}.swaptmp"; ln -sfn "$1" "$t" && mv -T "$t" "$2" && [[ -L "$2" ]]; }
else
    atomic_replace_symlink() { ln -sfn "$1" "$2" && [[ -L "$2" ]]; }
fi

# The fake box: run the exact command string lib.sh builds, locally.
fake_remote() {
    local cmd="$*"
    if [[ "$cmd" == *"mv -T"* ]]; then
        local src dst
        src="$(printf '%s' "$cmd" | sed -n 's/^ln -sfn \([^ ]*\) \([^ ]*\)\.new && mv -T.*/\1/p')"
        dst="$(printf '%s' "$cmd" | sed -n 's/^ln -sfn \([^ ]*\) \([^ ]*\)\.new && mv -T.*/\2/p')"
        [[ -n "$src" && -n "$dst" ]] || return 99
        atomic_replace_symlink "$src" "$dst"
    else
        bash -c "$cmd"
    fi
}
remote() { fake_remote "$@"; }

setup_box() {
    BOX="$(mktemp -d)"
    DEPLOY_PATH="${BOX}/www/jevnotjev"
    RELEASES_ROOT="${BOX}/www/jevnotjev-releases"
    mkdir -p "${RELEASES_ROOT}/old" "${RELEASES_ROOT}/new"
    echo OLDSHA > "${RELEASES_ROOT}/old/DEPLOYED_SHA"
    echo NEWSHA > "${RELEASES_ROOT}/new/DEPLOYED_SHA"
    ln -sfn "${RELEASES_ROOT}/old" "$DEPLOY_PATH"
}
teardown_box() { [[ -n "${BOX:-}" && -d "$BOX" ]] && rm -rf "$BOX"; }

echo "[T1] swap + rollback through the real lib.sh"

# 1. activate_release swaps atomically and the served path is always a valid symlink.
setup_box
if activate_release "${RELEASES_ROOT}/new" "$DEPLOY_PATH" && [[ -L "$DEPLOY_PATH" ]] \
   && [[ "$(cat "${DEPLOY_PATH}/DEPLOYED_SHA")" == NEWSHA ]]; then
    ok "activate_release swaps the served symlink to the new release"
else
    nope "activate_release did not swap: serving $(readlink "$DEPLOY_PATH" 2>/dev/null)"
fi
[[ "$(live_release "$DEPLOY_PATH")" == "${RELEASES_ROOT}/new" ]] \
    && ok "live_release reads the box's own link" \
    || nope "live_release returned '$(live_release "$DEPLOY_PATH")'"

# 2. rc=1 after activation restores the previous release (and verifies via curl).
curl() { echo OLDSHA; }
out="$(rollback_release 1 "${RELEASES_ROOT}/old" OLDSHA "$DEPLOY_PATH" "${RELEASES_ROOT}/new" 2>&1)"; rc=$?
unset -f curl
if [[ $rc -eq 1 && "$(readlink "$DEPLOY_PATH")" == "${RELEASES_ROOT}/old" && "$out" == *"matches its marker"* ]]; then
    ok "a failed verify restores the previous release, verifies it, and keeps rc=1"
else
    nope "rollback did not restore: rc=${rc}, serving $(readlink "$DEPLOY_PATH"), out: ${out}"
fi
teardown_box

# 3. rc=0 is a no-op.
setup_box
activate_release "${RELEASES_ROOT}/new" "$DEPLOY_PATH"
rollback_release 0 "${RELEASES_ROOT}/old" OLDSHA "$DEPLOY_PATH" "${RELEASES_ROOT}/new" >/dev/null 2>&1
[[ "$(readlink "$DEPLOY_PATH")" == "${RELEASES_ROOT}/new" ]] \
    && ok "a successful deploy (rc=0) is never rolled back" \
    || nope "rc=0 rolled back a good release"
teardown_box

# 4. unreachable box -> loud UNKNOWN, nothing touched.
setup_box
remote() { return 1; }
out="$(rollback_release 1 "${RELEASES_ROOT}/old" OLDSHA "$DEPLOY_PATH" "${RELEASES_ROOT}/new" 2>&1)"
remote() { fake_remote "$@"; }
[[ "$out" == *"BOX STATE UNKNOWN"* ]] \
    && ok "an unreachable box during rollback reports BOX STATE UNKNOWN" \
    || nope "expected BOX STATE UNKNOWN, got: ${out}"
teardown_box

# 5. box not on the release we think we activated -> leave it alone.
setup_box
out="$(rollback_release 1 "${RELEASES_ROOT}/old" OLDSHA "$DEPLOY_PATH" "${RELEASES_ROOT}/new" 2>&1)"
[[ "$(readlink "$DEPLOY_PATH")" == "${RELEASES_ROOT}/old" && "$out" == *"nothing to restore"* ]] \
    && ok "when the box is not on the new release, rollback changes nothing" \
    || nope "rollback acted on a state it did not create: ${out}"
teardown_box

# 6. first deploy: no previous release -> refuse to restore ''.
setup_box
activate_release "${RELEASES_ROOT}/new" "$DEPLOY_PATH"
out="$(rollback_release 1 "" "" "$DEPLOY_PATH" "${RELEASES_ROOT}/new" 2>&1)"
[[ -L "$DEPLOY_PATH" && "$out" == *"NO previous release"* ]] \
    && ok "first deploy with a failed verify says so loudly and never links ''" \
    || nope "first-deploy rollback path wrong: ${out}"
teardown_box

echo
echo "[T1] served-path guard (deploy_path_state)"
setup_box
s="$(deploy_path_state "$DEPLOY_PATH" "$RELEASES_ROOT")"; rc=$?
[[ $rc -eq 0 && "$s" == OURS ]] && ok "symlink into RELEASES_ROOT -> OURS (proceed)" || nope "expected OURS/0, got ${s}/${rc}"
rm -f "$DEPLOY_PATH"
s="$(deploy_path_state "$DEPLOY_PATH" "$RELEASES_ROOT")"; rc=$?
[[ $rc -eq 0 && "$s" == ABSENT ]] && ok "absent -> ABSENT (first deploy proceeds)" || nope "expected ABSENT/0, got ${s}/${rc}"
mkdir -p "$DEPLOY_PATH"
s="$(deploy_path_state "$DEPLOY_PATH" "$RELEASES_ROOT")"; rc=$?
[[ $rc -ne 0 && "$s" == FOREIGN ]] && ok "a real directory -> FOREIGN (refuse)" || nope "expected FOREIGN/1, got ${s}/${rc}"
rmdir "$DEPLOY_PATH"; ln -s "${BOX}" "$DEPLOY_PATH"
s="$(deploy_path_state "$DEPLOY_PATH" "$RELEASES_ROOT")"; rc=$?
[[ $rc -ne 0 && "$s" == FOREIGN_LINK ]] && ok "a symlink elsewhere -> FOREIGN_LINK (refuse)" || nope "expected FOREIGN_LINK/1, got ${s}/${rc}"
remote() { return 255; }
s="$(deploy_path_state "$DEPLOY_PATH" "$RELEASES_ROOT")"; rc=$?
remote() { fake_remote "$@"; }
[[ $rc -ne 0 && "$s" == UNKNOWN ]] && ok "ssh failure -> UNKNOWN (refuse)" || nope "expected UNKNOWN/1, got ${s}/${rc}"
teardown_box

echo
echo "[T1] prune + rollback target"
got="$(prune_release_list 1 r6-active r5-previous r6-active r5-previous r4 r3 r2 r1 | tr '\n' ' ')"
[[ "$got" == "r3 r2 r1 " ]] \
    && ok "prune keeps active + previous + newest 1 other, deletes r3 r2 r1" \
    || nope "prune returned '${got}'"
got="$(prune_release_list 3 a p a p | tr '\n' ' ')"
[[ -z "$got" ]] && ok "prune with only active + previous deletes nothing (bash 3.2 empty array safe)" || nope "got '${got}'"
has_marker_a() { [[ "$1" == with-marker ]]; }
sel="$(select_rollback_target active has_marker_a no-marker with-marker older)"
[[ "$sel" == with-marker ]] && ok "--rollback picks the newest OTHER release that has a marker" || nope "selected '${sel}'"
has_marker_none() { return 1; }
select_rollback_target active has_marker_none x y >/dev/null 2>&1 \
    && nope "selected a target with no marker" || ok "--rollback refuses when no release has a marker"

vroot="$(mktemp -d)"
mkdir -p "$vroot/r3-failed" "$vroot/r2-good"
echo sha3 > "$vroot/r3-failed/DEPLOYED_SHA"
echo sha2 > "$vroot/r2-good/DEPLOYED_SHA"; touch "$vroot/r2-good/.verified"
has_marker_v() { release_is_verified "$vroot/$1"; }
sel="$(select_rollback_target r4-active has_marker_v r3-failed r2-good)"
[[ "$sel" == r2-good ]] && ok "--rollback skips a newer release that never passed verification" || nope "selected '${sel}'"
grep -q 'touch ${RELEASE_DIR}/.verified' "$D" && awk '/co-tenant\(s\) unchanged/{c=NR} /touch \$\{RELEASE_DIR\}\/\.verified/{t=NR} END{exit !(c && t>c)}' "$D" \
    && ok ".verified is written only after the co-tenant check passes" || nope ".verified not written after co-tenant check"
rm -rf "$vroot"

echo
echo "[T1] co-tenant enumeration + comparison"
fixture_conf='
server {
    server_name _;
}
server {
    listen 80;
    server_name a.example.com www.a.example.com;   # trailing comment
    # server_name commented.example.com;
}
server { server_name *.wild.example ~^regex$ .dot.example; }
server { server_name jevnotjev.breakoutwithai.com; }
server {
	server_name b.example.org;
}
server { server_name a.example.com; }
'
got="$(printf '%s' "$fixture_conf" | parse_server_names jevnotjev.breakoutwithai.com | tr '\n' ' ')"
[[ "$got" == "a.example.com b.example.org www.a.example.com " ]] \
    && ok "parse_server_names: concrete names only, deduped, own domain/_/wildcards/regex/comments dropped" \
    || nope "parse_server_names returned '${got}'"

curl() {
    local a host=""
    for a in "$@"; do case "$a" in *:443:*) host="${a%%:*}" ;; esac; done
    case "$host" in up.example) printf 200 ;; auth.example) printf 401 ;; *) printf 000; return 7 ;; esac
}
got="$(probe_neighbours 10.0.0.1 up.example auth.example down.example | tr '\n' '|')"
unset -f curl
[[ "$got" == "up.example 200|auth.example 401|down.example 000|" ]] \
    && ok "probe_neighbours pins each name to the IP and records non-200s as they are" \
    || nope "probe_neighbours returned '${got}'"

before="$(printf 'a 200\nb 401\nc 301\n')"
neighbour_status_changes "$before" "$(printf 'c 301\na 200\nb 401\n')" >/dev/null \
    && ok "identical statuses (any order, 401 included) -> no change" \
    || nope "identical statuses reported as changed"
changed="$(neighbour_status_changes "$before" "$(printf 'a 200\nb 502\nc 301\n')")" \
    && nope "a 401 -> 502 change was not detected" \
    || { [[ "$changed" == "b 401 -> 502" ]] && ok "a status change is detected and named (b 401 -> 502)" || nope "change reported as '${changed}'"; }
neighbour_status_changes "$before" "$(printf 'a 200\nb 401\n')" >/dev/null \
    && nope "a neighbour missing from the after-probe was not flagged" \
    || ok "a neighbour missing from the after-probe fails the comparison"

echo
echo "[T1] manifest: tracked files under site/ only"
tmp="$(mktemp -d)"
(
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    cd "$tmp" && git init -q --initial-branch=main --template= r && cd r
    mkdir -p site/img && echo i > site/index.html && echo d > site/data.js && echo p > site/img/og.png
    echo secret > .env && echo readme > README.md
    git add site README.md && git -c commit.gpgsign=false commit -qm s
    echo stowaway > site/untracked.html
    manifest="$(git ls-files -- site/ | sed 's|^site/||' | LC_ALL=C sort)"
    archive="$(git archive --format=tar HEAD:site | tar -tf - | grep -v '/$' | LC_ALL=C sort)"
    printf 'M=%s\nA=%s\n' "$(echo $manifest)" "$(echo $archive)"
) > "$tmp/out" 2>&1
m="$(sed -n 's/^M=//p' "$tmp/out")"; a="$(sed -n 's/^A=//p' "$tmp/out")"
rm -rf "$tmp"
[[ "$m" == "data.js img/og.png index.html" && "$a" == "$m" ]] \
    && ok "git archive HEAD:site == git ls-files site/ (untracked stowaway, .env, README excluded)" \
    || nope "manifest '${m}' vs archive '${a}'"

# The same extraction deploy.sh uses must hold for THIS repo's committed site/.
m="$(git ls-files -- site/ | sed 's|^site/||' | LC_ALL=C sort | tr '\n' ' ')"
a="$(git archive --format=tar HEAD:site 2>/dev/null | tar -tf - | grep -v '/$' | LC_ALL=C sort | tr '\n' ' ')"
[[ -n "$m" && "$m" == "$a" && "$m" == *"index.html"* ]] \
    && ok "this repo: HEAD:site archive matches git ls-files site/ (${m% })" \
    || nope "this repo: manifest '${m}' vs archive '${a}'"

echo
echo "[T1] deploy.sh wiring"
cap_line="$(grep -n 'PREVIOUS_RELEASE="\$(live_release' "$D" | head -1 | cut -d: -f1)"
act_line="$(grep -n 'ACTIVATED=true' "$D" | head -1 | cut -d: -f1)"
swap_line="$(grep -n "run \"activate_release '\${RELEASE_DIR}'" "$D" | head -1 | cut -d: -f1)"
[[ -n "$cap_line" && -n "$swap_line" && "$cap_line" -lt "$swap_line" ]] \
    && ok "rollback target captured (line ${cap_line}) before the swap (line ${swap_line})" \
    || nope "capture '${cap_line:-none}' does not precede swap '${swap_line:-none}'"
[[ -n "$act_line" && -n "$swap_line" && "$act_line" -lt "$swap_line" ]] \
    && ok "ACTIVATED set (line ${act_line}) before the swap is issued" \
    || nope "ACTIVATED '${act_line:-none}' does not precede swap '${swap_line:-none}'"
grep -q "trap 'rc=\$?;.*deploy_rollback_release \"\$rc\"" "$D" \
    && ok "EXIT trap passes the exit status explicitly to the rollback" \
    || nope "EXIT trap does not pass \$rc to deploy_rollback_release"
unpinned="$(awk '!/^[[:space:]]*#/ && /curl.*HEALTH_URL/ && !/CURL_PIN/ {print NR": "$0}' "$D" "$L")"
[[ -z "$unpinned" ]] && ok "every curl at \${HEALTH_URL} carries \${CURL_PIN}" || nope "unpinned curl(s): ${unpinned}"
prune_line="$(grep -n 'prune_release_list "\$KEEP_RELEASES"' "$D" | head -1 | cut -d: -f1)"
nb_line="$(grep -n 'neighbour_status_changes "\$NEIGHBOURS_BEFORE"' "$D" | head -1 | cut -d: -f1)"
[[ -n "$prune_line" && -n "$nb_line" && "$nb_line" -lt "$prune_line" ]] \
    && ok "prune (line ${prune_line}) runs only after the neighbour check (line ${nb_line})" \
    || nope "prune '${prune_line:-none}' is not after neighbour check '${nb_line:-none}'"
awk '!/^[[:space:]]*#/ && /mapfile|declare -A|\$\{[a-zA-Z_]+,,\}/ {f=1} END {exit !f}' "$D" "$L" .deploy/*.sh \
    && nope "a bash-4-only construct is in the execution path" \
    || ok "no mapfile / associative arrays / \${v,,} (bash 3.2 compatible)"

out="$(/bin/bash "$D" --definitely-not-a-flag 2>&1)"; rc=$?
[[ $rc -eq 2 && "$out" == *usage:* ]] \
    && ok "/bin/bash $(/bin/bash -c 'echo ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}') runs deploy.sh to its arg parser (unknown flag -> rc=2)" \
    || nope "deploy.sh did not refuse an unknown flag: rc=${rc}"

# Lock: hold it, then a second --dry-run must refuse with rc=2.
lockdir="$(mktemp -d)"
lock_probe="${lockdir}/jevnotjev-deploy.lock"
if command -v flock >/dev/null 2>&1; then
    res="$( ( exec 9>"$lock_probe"; flock -n 9; TMPDIR="$lockdir" /bin/bash "$D" --dry-run 2>&1; echo "rc=$?" ) )"
else
    mkdir "${lock_probe}.d"
    res="$(TMPDIR="$lockdir" /bin/bash "$D" --dry-run 2>&1; echo "rc=$?")"
fi
rm -rf "$lockdir"
[[ "$res" == *"another deploy is in progress"* && "$res" == *"rc=2" ]] \
    && ok "a second deploy is refused while the lock is held (rc=2)" \
    || nope "lock not enforced: $(printf '%s' "$res" | tail -2)"

echo
echo "[T1] static verify skips the Backstage module's paths"
source .deploy/config.sh
curl() {
    local url="${*: -1}"
    case "$url" in
        *"/backstage/"*) printf '%s' "${FAKE_BACKSTAGE_CODE:-401}" ;;
        *"/broken.html") printf '%s' "${FAKE_BROKEN_CODE:-200}" ;;
        *) printf '200' ;;
    esac
}
MF="$(printf 'backstage/app.js\nbackstage/backstage.css\nbackstage/index.html\nbroken.html\nindex.html\n')"
paths="$(manifest_served_paths "$MF")"
[[ "$paths" == "/"$'\n'"/broken.html"$'\n'"/index.html" ]] \
    && ok "served paths keep the root and non-backstage files" || nope "served paths: ${paths}"
[[ "$paths" != *backstage* ]] && ok "served paths exclude every backstage/ file" || nope "backstage path still listed: ${paths}"
out="$(verify_served_paths "$MF" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" != *"backstage"* ]] \
    && ok "backstage/* returning 401 does not fail the static verify" || nope "rc=${rc}: ${out}"
out="$(FAKE_BROKEN_CODE=401 verify_served_paths "$MF" 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"/broken.html -> 401"* ]] \
    && ok "a non-backstage path returning 401 still fails the static verify" || nope "rc=${rc}: ${out}"
out="$(verify_served_paths "$(printf 'index.html\nnotbackstage/x.js\n')" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"/notbackstage/x.js -> 200"* ]] \
    && ok "only the backstage/ prefix is skipped (notbackstage/ is verified)" || nope "rc=${rc}: ${out}"
unset -f curl
grep -q 'exclude)\${SITE_DIR}/\${BACKSTAGE_SITE_PREFIX}' .deploy/ship.sh \
    && ok "ship.sh static pathspec uses the shared BACKSTAGE_SITE_PREFIX" || nope "ship.sh does not use the shared constant"

echo
echo "[T1] passed=${pass} failed=${fail}"
[[ $fail -eq 0 ]]
