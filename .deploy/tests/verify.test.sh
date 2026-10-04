#!/usr/bin/env bash
#
# [T1] #85 and seams S1/S2: `.deploy/ship.sh --verify`, the read-only live check, end to end.
#
# A COPY of the real ship.sh (plus config.sh, lib.sh, backstage-lib.sh, verify-lib.sh) runs inside a
# throwaway git repository whose `origin` is a local bare repo. curl is the fixture-backed double
# (fixture-curl.sh) reading .deploy/tests/fixtures/2026-10-04/; ssh refuses to run; git push is
# logged and refused. The host is TEST-NET (192.0.2.1). Hermetic. Bash 3.2 compatible.
#
# Every expected value below is a literal from the spec, never one recomputed from the scripts:
#   S1  docs/DEPLOY.md:SEAM_S1 - every module serves origin/main and a release tag exists on that SHA
#   S2  docs/backstage-deploy.md:53 - unauthenticated GET of /backstage/ and /api/backstage/health
#       returns 401, authenticated 200 with a running release; docs/DEPLOY.md:SEAM_S2 - public paths
#       /, /label/, /little-shop/ return 200
# The "citations resolve" block checks each cited line still says what the test relies on.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
REPO_ROOT="$(pwd)"
FIX="${REPO_ROOT}/.deploy/tests/fixtures/2026-10-04"
REAL_GIT="$(command -v git)"

pass=0; fail=0
ok()   { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }

# Spec line numbers (docs/DEPLOY.md "Seams under test"); checked below.
SEAM_S1_LINE="$(grep -n '^- \*\*S1' docs/DEPLOY.md | head -1 | cut -d: -f1)"
SEAM_S2_LINE="$(grep -n '^- \*\*S2' docs/DEPLOY.md | head -1 | cut -d: -f1)"

echo "[T1] citations resolve"
line53="$(sed -n 53p docs/backstage-deploy.md)"
[[ "$line53" == *"/backstage/"* && "$line53" == *"/api/backstage/health"* && "$line53" == *"401"* && "$line53" == *"200 with a running release"* && "$line53" == *"502 only while none runs"* ]] \
    && ok "docs/backstage-deploy.md:53 states 401 unauthenticated, 200 with a running release, 502 only with none" \
    || nope "docs/backstage-deploy.md:53 no longer states the S2 literals: ${line53}"
s1="$(sed -n "${SEAM_S1_LINE:-0}p" docs/DEPLOY.md 2>/dev/null)"
[[ -n "${SEAM_S1_LINE}" && "$s1" == *"/DEPLOYED_SHA"* && "$s1" == *"version"* && "$s1" == *"release tag"* && "$s1" == *"origin/main"* ]] \
    && ok "docs/DEPLOY.md:${SEAM_S1_LINE} states S1 (DEPLOYED_SHA, health version, release tag, origin/main)" \
    || nope "docs/DEPLOY.md has no S1 seam line with the S1 literals: '${s1}'"
s2="$(sed -n "${SEAM_S2_LINE:-0}p" docs/DEPLOY.md 2>/dev/null)"
[[ -n "${SEAM_S2_LINE}" && "$s2" == *"401"* && "$s2" == *"200"* && "$s2" == *"/label/"* && "$s2" == *"/little-shop/"* ]] \
    && ok "docs/DEPLOY.md:${SEAM_S2_LINE} states S2 (401 / 200, /, /label/, /little-shop/)" \
    || nope "docs/DEPLOY.md has no S2 seam line with the S2 literals: '${s2}'"

# ------------------------------------------------------------------ fakes on PATH
FAKEBIN="$(mktemp -d)"
cp "${REPO_ROOT}/.deploy/tests/fixture-curl.sh" "${FAKEBIN}/curl"
cat > "${FAKEBIN}/ssh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${@: -1}" >> "${FAKE_STATE}/ssh.log"
echo "ssh is not part of --verify" >&2
exit 99
EOF
cat > "${FAKEBIN}/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = push ]; then printf 'git %s\n' "\$*" >> "\${FAKE_STATE}/push.log"; exit 1; fi
exec "${REAL_GIT}" "\$@"
EOF
chmod +x "${FAKEBIN}/curl" "${FAKEBIN}/ssh" "${FAKEBIN}/git"
KEY="${FAKEBIN}/key"; : > "$KEY"
export JEVNOTJEV_SSH_KEY="$KEY" JEVNOTJEV_SERVER_HOST=192.0.2.1
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export VERIFY_SLEEP=0

# ------------------------------------------------------------------ repo fixture
# main: P (previous) then M (main). origin is a local bare repo. TAG=1 pushes an annotated release
# tag v2026.10.04.1 on M to origin; TAG=light pushes a lightweight one (not a release).
make_fixture() {
    FIXD="$(mktemp -d)"
    export FAKE_STATE="${FIXD}/state"; mkdir -p "$FAKE_STATE"
    WORK="${FIXD}/work"
    "$REAL_GIT" init -q --bare --initial-branch=main "${FIXD}/origin.git"
    "$REAL_GIT" init -q --initial-branch=main "$WORK"
    (
        cd "$WORK" || exit 1
        "$REAL_GIT" config commit.gpgsign false; "$REAL_GIT" config tag.gpgsign false
        echo p > README; "$REAL_GIT" add -A; "$REAL_GIT" commit -qm "chore: previous (#1)"
        echo m > README; "$REAL_GIT" add -A; "$REAL_GIT" commit -qm "feat: main (#2)"
        "$REAL_GIT" remote add origin "${FIXD}/origin.git"
        "$REAL_GIT" push -q origin main
        case "${1:-}" in
            1) "$REAL_GIT" tag -a v2026.10.04.1 -m "Release v2026.10.04.1" HEAD; "$REAL_GIT" push -q origin refs/tags/v2026.10.04.1 ;;
            light) "$REAL_GIT" tag v2026.10.04.1 HEAD; "$REAL_GIT" push -q origin refs/tags/v2026.10.04.1 ;;
        esac
        "$REAL_GIT" tag -d v2026.10.04.1
        "$REAL_GIT" fetch -q origin
        printf '%s\n' .deploy/ >> .git/info/exclude
    ) >/dev/null 2>&1
    P="$("$REAL_GIT" -C "$WORK" rev-parse HEAD~1)"
    M="$("$REAL_GIT" -C "$WORK" rev-parse HEAD)"
    mkdir -p "${WORK}/.deploy"
    cp "${REPO_ROOT}/.deploy/ship.sh" "${REPO_ROOT}/.deploy/config.sh" "${REPO_ROOT}/.deploy/lib.sh" \
        "${REPO_ROOT}/.deploy/backstage-lib.sh" "${WORK}/.deploy/"
    cp "${REPO_ROOT}/.deploy/verify-lib.sh" "${WORK}/.deploy/" 2>/dev/null || true
    CFG="${FIXD}/curl-config"; : > "$CFG"; chmod 600 "$CFG"
    export BACKSTAGE_CURL_CONFIG="$CFG"
    export FIXTURE_DIRS="${FIX}/gated"
    serve static "$M"; serve backstage "$M"
}
drop_fixture() { [[ -n "${FIXD:-}" && -d "$FIXD" ]] && rm -rf "$FIXD"; }
serve() { printf '%s\n' "$2" > "${FAKE_STATE}/$1_served"; }
verify() { (cd "$WORK" && PATH="${FAKEBIN}:${PATH}" bash .deploy/ship.sh --verify "$@"); }
no_mutation() {
    [[ ! -s "${FAKE_STATE}/ssh.log" && ! -s "${FAKE_STATE}/push.log" ]] \
        && [[ -z "$("$REAL_GIT" -C "$WORK" tag -l)" || "$("$REAL_GIT" -C "$WORK" tag -l)" == "v2026.10.04.1" ]]
}

echo "[T1] S1 + S2: a host serving origin/main behind the gate, release tag on origin"
make_fixture 1
out="$(verify 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "--verify exits 0 on a healthy gated host at origin/main" || nope "healthy: rc=${rc}; out: ${out}"
for want in \
    "PASS S1 static /DEPLOYED_SHA ${M}" \
    "PASS S1 backstage version ${M}" \
    "PASS S2 anon /backstage/ 401" \
    "PASS S2 anon /api/backstage/health 401" \
    "PASS S2 auth /backstage/ 200" \
    "PASS S2 auth /api/backstage/health 200" \
    "PASS S2 public / 200" \
    "PASS S2 public /label/ 200" \
    "PASS S2 public /little-shop/ 200" \
    "PASS S1 release tag v2026.10.04.1 on ${M}"; do
    [[ "$out" == *"$want"* ]] && ok "names: ${want%% ${M}*}" || nope "missing '${want}'; out: ${out}"
done
[[ "$out" == *"verify: 10 passed, 0 failed"* ]] && ok "10 assertions, all passed" || nope "summary line: ${out}"
no_mutation && ok "--verify sends no ssh, pushes nothing, creates no tag" || nope "--verify mutated: ssh '$(cat "${FAKE_STATE}/ssh.log" 2>/dev/null)', push '$(cat "${FAKE_STATE}/push.log" 2>/dev/null)'"
drop_fixture

echo "[T1] #85 AC4 negative control: a deliberately wrong expected SHA fails"
make_fixture 1
out="$(verify "$P" 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S1 static /DEPLOYED_SHA: expected ${P}, served ${M}"* && "$out" == *"FAIL S1 backstage version: expected ${P}, served ${M}"* ]] \
    && ok "--verify <wrong SHA> exits 6 naming both modules and both SHAs" || nope "wrong SHA: rc=${rc}; out: ${out}"
drop_fixture

echo "[T1] live 2026-10-04: static left stale after a deploy (S1)"
make_fixture 1
serve static "$P"
out="$(verify 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S1 static /DEPLOYED_SHA: expected ${M}, served ${P}"* && "$out" == *"PASS S1 backstage version ${M}"* ]] \
    && ok "a stale static release fails verify, naming static only" || nope "stale static: rc=${rc}; out: ${out}"
drop_fixture

echo "[T1] live 2026-10-04: Backstage served without auth (S2)"
make_fixture 1
export FIXTURE_DIRS="${FIX}/no-auth:${FIX}/gated"
out="$(verify 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S2 anon /backstage/: expected 401, got 200"* && "$out" == *"FAIL S2 anon /api/backstage/health: expected 401, got 200"* ]] \
    && ok "an ungated Backstage fails verify, naming both routes and the 200" || nope "no auth: rc=${rc}; out: ${out}"
drop_fixture

echo "[T1] S1: the release tag must exist on origin as an annotated vYYYY.MM.DD.N tag on the served SHA"
make_fixture none
out="$(verify 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S1 release tag: no vYYYY.MM.DD.N tag on origin points at ${M}"* ]] \
    && ok "no release tag on origin fails verify, naming the SHA" || nope "no tag: rc=${rc}; out: ${out}"
drop_fixture
make_fixture light
out="$(verify 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S1 release tag"* ]] \
    && ok "a lightweight tag is not a release: verify fails" || nope "lightweight tag: rc=${rc}; out: ${out}"
drop_fixture

echo "[T1] S2 needs the private curl config: without it verify fails by name, never passes"
make_fixture 1
out="$(BACKSTAGE_CURL_CONFIG= verify 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S2 auth: BACKSTAGE_CURL_CONFIG"* ]] \
    && ok "unset BACKSTAGE_CURL_CONFIG exits 6 naming the variable" || nope "no config: rc=${rc}; out: ${out}"
chmod 644 "$CFG"
out="$(verify 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S2 auth: BACKSTAGE_CURL_CONFIG"* ]] \
    && ok "a group-readable curl config is refused" || nope "loose config: rc=${rc}; out: ${out}"
drop_fixture

echo "[T1] a failed transfer is a failure, never parsed"
make_fixture 1
out="$(FAKE_CURL_EXIT=18 verify 2>&1)"; rc=$?
[[ $rc -eq 6 && "$out" == *"FAIL S1 static /DEPLOYED_SHA"*"curl exit 18"* ]] \
    && ok "a complete body followed by curl exit 18 fails S1 static" || nope "partial transfer: rc=${rc}; out: ${out}"
drop_fixture

echo "[T1] usage"
make_fixture 1
out="$(verify notasha 2>&1)"; rc=$?
[[ $rc -eq 2 ]] && ok "--verify with a non-SHA argument exits 2" || nope "bad sha: rc=${rc}"
out="$(cd "$WORK" && PATH="${FAKEBIN}:${PATH}" bash .deploy/ship.sh --verify --module static 2>&1)"; rc=$?
[[ $rc -eq 2 ]] && ok "--verify is whole-stack: --module is a usage error" || nope "verify --module: rc=${rc}"
out="$(cd "$WORK" && PATH="${FAKEBIN}:${PATH}" bash .deploy/ship.sh --help 2>&1)"
[[ "$out" == *"--verify"* ]] && ok "--help documents --verify" || nope "--help lacks --verify"
drop_fixture

rm -rf "$FAKEBIN"
echo "[T1] passed=${pass} failed=${fail}"
[[ "$fail" -eq 0 ]]
