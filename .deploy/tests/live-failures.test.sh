#!/usr/bin/env bash
#
# [T1] #86 AC3 and seam S3: the three host behaviours seen live on 2026-10-04, replayed from fixtures
# (.deploy/tests/fixtures/2026-10-04/), against the REAL probe and verify functions. curl is the
# fixture-backed double (fixture-curl.sh); nothing here reaches a network. Bash 3.2 compatible.
#
# Seam S3 (docs/DEPLOY.md "Seams under test"): no other server_name on the host changes status across
# a deploy or setup. The spec lines asserted here: docs/DEPLOY.md:164 ("every other server_name in
# /etc/nginx/sites-enabled returns the same status as before") and docs/backstage-deploy.md:52
# (setup "re-probes all neighbours. A changed neighbour restores the vhost").
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
REPO_ROOT="$(pwd)"
FIX="${REPO_ROOT}/.deploy/tests/fixtures/2026-10-04"

pass=0; fail=0
ok()   { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }

export JEVNOTJEV_SERVER_HOST=192.0.2.1
FAKEBIN="$(mktemp -d)"
cp "${REPO_ROOT}/.deploy/tests/fixture-curl.sh" "${FAKEBIN}/curl"
printf '%s\n' '#!/usr/bin/env bash' 'echo "ssh must not run in this suite" >&2; exit 99' > "${FAKEBIN}/ssh"
chmod +x "${FAKEBIN}/curl" "${FAKEBIN}/ssh"
export PATH="${FAKEBIN}:${PATH}"
export FAKE_STATE="${FAKEBIN}/state"; mkdir -p "$FAKE_STATE"
reset_calls() { rm -rf "${FAKE_STATE}/fixture-calls"; : > "${FAKE_STATE}/curl.log"; }

# shellcheck source=/dev/null
source "${REPO_ROOT}/.deploy/config.sh"
# shellcheck source=/dev/null
source "${REPO_ROOT}/.deploy/lib.sh"
# shellcheck source=/dev/null
source "${REPO_ROOT}/.deploy/backstage-lib.sh"
# shellcheck source=/dev/null
source "${REPO_ROOT}/.deploy/verify-lib.sh" 2>/dev/null || nope "missing .deploy/verify-lib.sh"

echo "[T1] citations resolve"
[[ "$(sed -n 164p docs/DEPLOY.md)" == *"server_name"*"returns the same status as before"* ]] \
    && ok "docs/DEPLOY.md:164 states the co-tenant invariant" || nope "docs/DEPLOY.md:164 moved: $(sed -n 164p docs/DEPLOY.md)"
[[ "$(sed -n 52p docs/backstage-deploy.md)" == *"re-probes all neighbours"*"A changed neighbour restores the vhost"* ]] \
    && ok "docs/backstage-deploy.md:52 states the setup co-tenant re-probe" || nope "docs/backstage-deploy.md:52 moved"
[[ "$(sed -n 53p docs/backstage-deploy.md)" == *"200 with a running release, 502 only while none runs"* ]] \
    && ok "docs/backstage-deploy.md:53 states 200 with a release, 502 only with none" || nope "docs/backstage-deploy.md:53 moved"

echo "[T1] fixture provenance"
for f in "${FIX}/cotenants/http/showngrow.groit.global_.txt" \
         "${FIX}/cotenants/http/nfflakelife.breakoutwithai.com_.txt" \
         "${FIX}/health-start/http/jevnotjev.breakoutwithai.com_api_backstage_health@auth.1.txt"; do
    [[ "$(head -1 "$f" 2>/dev/null)" == "source: transcribed-from-live-log 2026-10-04"* ]] \
        && ok "live case $(basename "$f") is marked transcribed-from-live-log 2026-10-04" \
        || nope "live case ${f} missing or not marked as transcribed"
done
unmarked="$(find "$FIX" -name '*.txt' -path '*/http/*' -exec sh -c 'head -1 "$1" | grep -q "^source: " || echo "$1"' _ {} \;)"
[[ -z "$unmarked" ]] && ok "every HTTP fixture names its source on line 1" || nope "fixtures without a source line: ${unmarked}"
[[ -f "${FIX}/MANIFEST.md" ]] && grep -q 'capture-fixtures.sh' "${FIX}/MANIFEST.md" && grep -q '178.62.69.200' "${FIX}/MANIFEST.md" \
    && ok "MANIFEST.md names the capture command and the host" || nope "MANIFEST.md missing the capture command or host"

echo "[T1] live case 1: showngrow.groit.global, curl exit 60 (TLS name mismatch) aborted setup"
export FIXTURE_DIRS="${FIX}/cotenants"
reset_calls
out="$(backstage_probe_neighbours "$SERVER_HOST" showngrow.groit.global 2>&1)"; rc=$?
# Expected literal from the fixture: http_code 000, curl_exit 60 (docs/backstage-deploy.md:52 probes; backstage-lib.sh records <code>/<exit>).
[[ $rc -eq 0 && "$out" == "showngrow.groit.global 000/60" ]] \
    && ok "Backstage probe records showngrow as an observation (000/60), not a local fault" \
    || nope "showngrow probe: rc=${rc}, out '${out}'"
reset_calls
out="$(probe_neighbours "$SERVER_HOST" showngrow.groit.global 2>&1)"
[[ "$out" == "showngrow.groit.global 000" ]] && ok "static deploy probe records showngrow as 000" || nope "static showngrow probe: '${out}'"

echo "[T1] live case 2: nfflakelife.breakoutwithai.com 200 then timeout (exit 28) rolled back setup"
reset_calls
out="$(backstage_probe_neighbours "$SERVER_HOST" nfflakelife.breakoutwithai.com 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == "nfflakelife.breakoutwithai.com 200/28" ]] \
    && ok "Backstage probe records nfflakelife as 200/28" || nope "nfflakelife probe: rc=${rc}, out '${out}'"

echo "[T1] seam S3: an unchanged co-tenant does not fail a deploy or setup (docs/DEPLOY.md:164)"
reset_calls
before="$(backstage_probe_neighbours "$SERVER_HOST" showngrow.groit.global nfflakelife.breakoutwithai.com)"
reset_calls
after="$(backstage_probe_neighbours "$SERVER_HOST" showngrow.groit.global nfflakelife.breakoutwithai.com)"
changed="$(neighbour_status_changes "$before" "$after")"; rc=$?
[[ $rc -eq 0 && -z "$changed" ]] \
    && ok "both live co-tenants replayed before and after: no change reported, setup proceeds" \
    || nope "S3 unchanged: rc=${rc}, changed '${changed}'"
changed="$(neighbour_status_changes "$before" "$(printf '%s\n' 'showngrow.groit.global 000/60' 'nfflakelife.breakoutwithai.com 502/28')")"; rc=$?
[[ $rc -ne 0 && "$changed" == "nfflakelife.breakoutwithai.com 200/28 -> 502/28" ]] \
    && ok "negative control: the same co-tenant answering 502/28 after is named as changed" \
    || nope "S3 negative control: rc=${rc}, changed '${changed}'"
reset_calls
static_before="$(probe_neighbours "$SERVER_HOST" showngrow.groit.global nfflakelife.breakoutwithai.com)"
static_after="$(probe_neighbours "$SERVER_HOST" showngrow.groit.global nfflakelife.breakoutwithai.com)"
neighbour_status_changes "$static_before" "$static_after" >/dev/null \
    && ok "static deploy probe: both live co-tenants unchanged across the deploy" || nope "static S3: '${static_before}' vs '${static_after}'"

echo "[T1] live case 3: /api/backstage/health 502 while the service starts"
export FAKE_STATE
printf '%s\n' 0123456789abcdef0123456789abcdef01234567 > "${FAKE_STATE}/backstage_served"
printf '%s\n' 0123456789abcdef0123456789abcdef01234567 > "${FAKE_STATE}/static_served"
CFG="${FAKEBIN}/curl-config"; : > "$CFG"; chmod 600 "$CFG"
export BACKSTAGE_CURL_CONFIG="$CFG" VERIFY_SLEEP=0
export FIXTURE_DIRS="${FIX}/health-start:${FIX}/gated"
reset_calls
out="$(verify_live "" 0123456789abcdef0123456789abcdef01234567 no yes 2>&1)"; rc=$?
calls="$(grep -c 'api/backstage/health' "${FAKE_STATE}/curl.log" | tr -d ' ')"
[[ $rc -eq 0 && "$out" == *"PASS S2 auth /api/backstage/health 200"* && "$calls" -ge 3 ]] \
    && ok "verify retries a starting service: 502 then 200 passes (docs/backstage-deploy.md:53, 200 with a running release)" \
    || nope "502-then-200: rc=${rc}, health calls ${calls}; out: ${out}"
export FIXTURE_DIRS="${FIX}/page-start:${FIX}/health-start:${FIX}/gated"
reset_calls
out="$(verify_live "" 0123456789abcdef0123456789abcdef01234567 no yes 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"PASS S2 auth /backstage/ 200"* && "$out" == *"PASS S2 auth /api/backstage/health 200"* ]] \
    && ok "sweep #9: page and health both 502 while starting, then 200: both are retried and pass" \
    || nope "page+health start: rc=${rc}; out: ${out}"
PERSIST="$(mktemp -d)"; mkdir -p "${PERSIST}/http"
cp "${FIX}/health-start/http/jevnotjev.breakoutwithai.com_api_backstage_health@auth.1.txt" "${PERSIST}/http/"
export FIXTURE_DIRS="${PERSIST}:${FIX}/gated"
reset_calls
out="$(verify_live "" 0123456789abcdef0123456789abcdef01234567 no yes 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"FAIL S2 auth /api/backstage/health"*"502"* ]] \
    && ok "negative control: a 502 that never clears fails verify and names the route and status" \
    || nope "persistent 502: rc=${rc}; out: ${out}"
reset_calls
out="$(verify_live "" "" no none 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"PASS S2 auth /api/backstage/health 502 (no release yet)"* ]] \
    && ok "with no Backstage release yet, 502 is the spec answer (docs/backstage-deploy.md:53, 502 only while none runs)" \
    || nope "502 with no release: rc=${rc}; out: ${out}"
rm -rf "$PERSIST"

rm -rf "$FAKEBIN"
echo "[T1] passed=${pass} failed=${fail}"
[[ "$fail" -eq 0 ]]
