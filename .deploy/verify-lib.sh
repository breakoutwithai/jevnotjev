#!/usr/bin/env bash
#
# verify-lib.sh - the read-only live check behind `ship.sh --verify` (#85) and the closing check of
# every deploy, setup, rollback and --status. Sourced after config.sh and backstage-lib.sh.
#
# The expected values are the spec's literals (docs/DEPLOY.md "Seams under test", S1 and S2), never
# values derived from the deploy scripts. HTTP and `git ls-remote` only: no ssh, no write anywhere.
# Bash 3.2 compatible.

# S2 literals: docs/backstage-deploy.md:53 (gated routes) and docs/DEPLOY.md "Seams under test".
VERIFY_GATED_PATHS=(/backstage/ /api/backstage/health)
VERIFY_PUBLIC_PATHS=(/ /label/ /little-shop/)
VERIFY_UNAUTH_CODE=401
VERIFY_OK_CODE=200
VERIFY_NO_RELEASE_CODE=502

VERIFY_PASSED=0
VERIFY_FAILED=0
verify_pass() { echo "  PASS $1"; VERIFY_PASSED=$((VERIFY_PASSED + 1)); }
verify_fail() { echo "  FAIL $1"; VERIFY_FAILED=$((VERIFY_FAILED + 1)); }
verify_note() { echo "  n/a  $1"; }

# verify_get <anon|auth> <path> - one GET pinned to the host. Sets VERIFY_CODE, VERIFY_RC and
# VERIFY_BODY. Never --fail: the status is the observation; a non-zero curl exit is reported.
verify_get() {
    local who="$1" path="$2" tmp out
    tmp="$(mktemp "${TMPDIR:-/tmp}/jevnotjev-verify.XXXXXX")" || { VERIFY_RC=1; VERIFY_CODE=000; VERIFY_BODY=""; return; }
    VERIFY_RC=0
    if [[ "$who" == auth ]]; then
        out="$(backstage_curl -sS -o "$tmp" -w '%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}${path}" 2>/dev/null)" || VERIFY_RC=$?
    else
        out="$(curl -q -sS -o "$tmp" -w '%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}${path}" 2>/dev/null)" || VERIFY_RC=$?
    fi
    VERIFY_CODE="${out:-000}"
    VERIFY_BODY="$(cat "$tmp" 2>/dev/null)"
    rm -f "$tmp"
}

# "got <code>" plus the curl exit when the transfer failed.
verify_got() {
    if [[ "$VERIFY_RC" -eq 0 ]]; then printf 'got %s' "$VERIFY_CODE"; else printf 'got %s, curl exit %s' "$VERIFY_CODE" "$VERIFY_RC"; fi
}

# verify_code <anon|auth> <path> <want> <label> - one route, one literal status, curl exit 0.
verify_code() {
    verify_get "$1" "$2"
    if [[ "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == "$3" ]]; then
        verify_pass "$4 $3"
    else
        verify_fail "$4: expected $3, $(verify_got)"
    fi
}

# verify_static_sha <expected> - S1: /DEPLOYED_SHA names the expected commit.
verify_static_sha() {
    local want="$1" served
    verify_get anon /DEPLOYED_SHA
    served="$(printf '%s' "$VERIFY_BODY" | tr -d '[:space:]')"
    if [[ "$VERIFY_RC" -ne 0 || "$VERIFY_CODE" != 200 ]]; then
        verify_fail "S1 static /DEPLOYED_SHA: expected ${want}, $(verify_got)"
    elif [[ "$served" != "$want" ]]; then
        verify_fail "S1 static /DEPLOYED_SHA: expected ${want}, served ${served:-nothing}"
    else
        verify_pass "S1 static /DEPLOYED_SHA ${want}"
    fi
}

# verify_backstage_health <expected version or empty> <release yes|none> - the authenticated health
# route: 200 with a running release (502 accepted only when no release exists, docs/backstage-deploy.md:53).
# A 502 while a release exists is retried (the service may be starting): VERIFY_ATTEMPTS x VERIFY_SLEEP s.
verify_backstage_health() {
    local want="$1" release="$2" attempt=1 attempts="${VERIFY_ATTEMPTS:-5}" version
    while :; do
        verify_get auth /api/backstage/health
        [[ "$release" == yes && "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == "$VERIFY_NO_RELEASE_CODE" && "$attempt" -lt "$attempts" ]] || break
        attempt=$((attempt + 1))
        sleep "${VERIFY_SLEEP:-2}"
    done
    if [[ "$release" != yes && "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == "$VERIFY_NO_RELEASE_CODE" ]]; then
        verify_pass "S2 auth /api/backstage/health ${VERIFY_NO_RELEASE_CODE} (no release yet)"
        [[ -z "$want" ]] || verify_fail "S1 backstage version: expected ${want}, no release is running"
        return
    fi
    if [[ "$VERIFY_RC" -ne 0 || "$VERIFY_CODE" != "$VERIFY_OK_CODE" ]]; then
        verify_fail "S2 auth /api/backstage/health: expected ${VERIFY_OK_CODE}, $(verify_got) after ${attempt} attempt(s)"
        [[ -z "$want" ]] || verify_fail "S1 backstage version: expected ${want}, health did not answer ${VERIFY_OK_CODE}"
        return
    fi
    verify_pass "S2 auth /api/backstage/health ${VERIFY_OK_CODE}"
    [[ -n "$want" ]] || return 0
    # Top-level `version` only; the body also nests a catalog version that is not the release.
    version="$(printf '%s' "$VERIFY_BODY" | bun -e 'const r=await Bun.stdin.json();const v=r?.version;if(typeof v==="string"&&!/[\r\n]/.test(v))console.log(v)' 2>/dev/null || true)"
    if [[ "$version" == "$want" ]]; then
        verify_pass "S1 backstage version ${want}"
    else
        verify_fail "S1 backstage version: expected ${want}, served ${version:-nothing}"
    fi
}

# verify_release_tag <sha> - S1: an annotated vYYYY.MM.DD.N tag on origin peels to the SHA.
verify_release_tag() {
    local sha="$1" refs tag
    if ! refs="$(git ls-remote --tags origin 2>/dev/null)"; then
        verify_fail "S1 release tag: cannot list tags on origin"
        return
    fi
    tag="$(printf '%s\n' "$refs" | awk -v s="$sha" '$1 == s && $2 ~ /^refs\/tags\/v[0-9][0-9][0-9][0-9]\.[0-9][0-9]\.[0-9][0-9]\.[0-9]+\^\{\}$/ { t = $2; sub(/^refs\/tags\//, "", t); sub(/\^\{\}$/, "", t); print t }' | sort -t. -k4,4n | tail -1)"
    if [[ -n "$tag" ]]; then
        verify_pass "S1 release tag ${tag} on ${sha}"
    else
        verify_fail "S1 release tag: no vYYYY.MM.DD.N tag on origin points at ${sha}"
    fi
}

# verify_live <expected static SHA|""> <expected backstage SHA|""> <require tag yes|no> <backstage release yes|none>
# An empty expected SHA means that module's SHA is not asserted by this caller (a partial deploy or
# setup); the S2 gate and public paths are always asserted. Prints one PASS/FAIL line per assertion
# and a summary; returns 1 when any assertion failed.
verify_live() {
    local want_static="$1" want_backstage="$2" want_tag="$3" release="${4:-yes}" path tag_sha
    VERIFY_PASSED=0; VERIFY_FAILED=0
    echo "verify (read-only, live): static ${want_static:-not asserted}, backstage ${want_backstage:-not asserted}, release tag $([[ "$want_tag" == yes ]] && echo required || echo 'not required')"

    [[ -z "$want_static" ]] || verify_static_sha "$want_static"

    for path in "${VERIFY_GATED_PATHS[@]}"; do
        verify_code anon "$path" "$VERIFY_UNAUTH_CODE" "S2 anon ${path}"
    done

    if [[ -z "${BACKSTAGE_CURL_CONFIG:-}" ]] || ! backstage_check_curl_config; then
        verify_fail "S2 auth: BACKSTAGE_CURL_CONFIG must name a private (0600, yours) curl config holding the Backstage login (docs/backstage-deploy.md § Basic Auth gate)"
        [[ -z "$want_backstage" ]] || verify_fail "S1 backstage version: not read without BACKSTAGE_CURL_CONFIG"
    else
        verify_get auth /backstage/
        if [[ "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == "$VERIFY_OK_CODE" ]]; then
            verify_pass "S2 auth /backstage/ ${VERIFY_OK_CODE}"
        elif [[ "$release" != yes && "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == "$VERIFY_NO_RELEASE_CODE" ]]; then
            verify_pass "S2 auth /backstage/ ${VERIFY_NO_RELEASE_CODE} (no release yet)"
        else
            verify_fail "S2 auth /backstage/: expected ${VERIFY_OK_CODE}, $(verify_got)"
        fi
        verify_backstage_health "$want_backstage" "$release"
    fi

    for path in "${VERIFY_PUBLIC_PATHS[@]}"; do
        verify_code anon "$path" "$VERIFY_OK_CODE" "S2 public ${path}"
    done

    if [[ "$want_tag" == yes ]]; then
        tag_sha="${want_static:-$want_backstage}"
        if [[ -n "$want_static" && -n "$want_backstage" && "$want_static" != "$want_backstage" ]]; then
            verify_fail "S1 release tag: the modules are expected at different SHAs (${want_static} vs ${want_backstage})"
        else
            verify_release_tag "$tag_sha"
        fi
    fi

    echo "verify: ${VERIFY_PASSED} passed, ${VERIFY_FAILED} failed"
    [[ "$VERIFY_FAILED" -eq 0 ]]
}
