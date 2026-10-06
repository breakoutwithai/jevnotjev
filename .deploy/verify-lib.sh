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
# VERIFY_BODY and VERIFY_HEADERS. Never --fail: the status is the observation.
verify_get() {
    local who="$1" path="$2" tmp headers out
    tmp="$(mktemp "${TMPDIR:-/tmp}/jevnotjev-verify.XXXXXX")" || { VERIFY_RC=1; VERIFY_CODE=000; VERIFY_BODY=""; return; }
    headers="$(mktemp "${TMPDIR:-/tmp}/jevnotjev-headers.XXXXXX")" || { rm -f "$tmp"; VERIFY_RC=1; VERIFY_CODE=000; VERIFY_BODY=""; return; }
    VERIFY_RC=0
    if [[ "$who" == auth ]]; then
        out="$(backstage_curl -sS -D "$headers" -o "$tmp" -w '%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}${path}" 2>/dev/null)" || VERIFY_RC=$?
    elif [[ "$who" == tampered || "$who" == forged ]]; then
        local cookie='x.y'
        if [[ "$who" == forged ]]; then
            if [[ ! -f "${BACKSTAGE_SESSION_JAR:-}" ]]; then
                VERIFY_RC=1; VERIFY_CODE=000; VERIFY_BODY=""; VERIFY_HEADERS=""; rm -f "$tmp" "$headers"; return
            fi
            cookie="$(awk -F '\t' '$6=="__Host-backstage_session" || $6=="backstage_session" {print $7}' "$BACKSTAGE_SESSION_JAR" | tail -1)"
            if [[ ! "$cookie" =~ ^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$ ]]; then
                VERIFY_RC=1; VERIFY_CODE=000; VERIFY_BODY=""; VERIFY_HEADERS=""; rm -f "$tmp" "$headers"; return
            fi
            local payload="${cookie%.*}" signature="${cookie##*.}" first
            first="${signature:0:1}"
            if [[ "$first" == a ]]; then first=b; else first=a; fi
            cookie="${payload}.${first}${signature:1}"
        fi
        out="$(curl -q -sS -H "Cookie: __Host-backstage_session=${cookie}" -D "$headers" -o "$tmp" -w '%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}${path}" 2>/dev/null)" || VERIFY_RC=$?
    else
        out="$(curl -q -sS -D "$headers" -o "$tmp" -w '%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}${path}" 2>/dev/null)" || VERIFY_RC=$?
    fi
    VERIFY_CODE="${out:-000}"
    VERIFY_BODY="$(cat "$tmp" 2>/dev/null)"
    VERIFY_HEADERS="$(cat "$headers" 2>/dev/null)"
    rm -f "$tmp" "$headers"
}

verify_session_redirect() {
    local who="$1" label="$2" location
    verify_get "$who" /backstage/
    location="$(printf '%s\n' "$VERIFY_HEADERS" | tr -d '\r' | sed -n '/^[Ll]ocation:[[:space:]]*/{s/^[^:]*:[[:space:]]*//;p;}' | tail -1)"
    if [[ "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == 302 && ( "$location" == "${HEALTH_URL}/backstage/sign-in?next=/backstage/" || "$location" == '/backstage/sign-in?next=/backstage/' ) ]] \
        && ! printf '%s\n' "$VERIFY_HEADERS" | grep -Eiq '^WWW-Authenticate:'; then
        verify_pass "S2 ${label} /backstage/ 302 sign-in"
    else
        verify_fail "S2 ${label} /backstage/: expected 302 exact sign-in Location without WWW-Authenticate, $(verify_got)"
    fi
}
verify_session_api_401() {
    local who="$1" label="$2"
    verify_get "$who" /api/backstage/health
    if [[ "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == 401 && "$VERIFY_BODY" == '{"code":"unauthenticated"}' ]] \
        && printf '%s\n' "$VERIFY_HEADERS" | tr -d '\r' | grep -Eiq '^Content-Type:[[:space:]]*application/json([[:space:]]*;|[[:space:]]*$)' \
        && ! printf '%s\n' "$VERIFY_HEADERS" | grep -Eiq '^WWW-Authenticate:'; then
        verify_pass "S2 ${label} /api/backstage/health 401 no WWW-Authenticate"
    else
        verify_fail "S2 ${label} /api/backstage/health: expected JSON 401 with exact unauthenticated body and no WWW-Authenticate, $(verify_got)"
    fi
}
verify_session_sign_in() {
    local release="$1"
    verify_get anon /backstage/sign-in
    if [[ "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == 200 && "$VERIFY_BODY" == *'action="/api/auth/password"'* && "$VERIFY_BODY" != *'id="sign-out"'* ]]; then
        verify_pass "S2 anon /backstage/sign-in 200 password form without app markup"
    elif [[ "$release" != yes && "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == "$VERIFY_NO_RELEASE_CODE" ]]; then
        verify_pass "S2 anon /backstage/sign-in ${VERIFY_NO_RELEASE_CODE} (no release yet)"
    else
        verify_fail "S2 anon /backstage/sign-in: expected 200 password form without app markup$([[ "$release" == yes ]] || printf ' or %s without a release' "$VERIFY_NO_RELEASE_CODE"), $(verify_got)"
    fi
}

# verify_session_auth <expected version or empty> <release yes|none> - the minted-session rows of
# the session gate. Without a release (fresh install) no service can mint a session: n/a, not FAIL.
verify_session_auth() {
    local want="$1" release="$2"
    if [[ "$release" != yes ]]; then
        verify_note "S2 auth: no release is running, so no session can be minted yet"
        [[ -z "$want" ]] || verify_fail "S1 backstage version: expected ${want}, no release is running"
        return
    fi
    if backstage_session_mint; then
        VERIFY_MINTED=yes
        verify_backstage_auth "$want" "$release"
    else
        verify_fail "S2 auth: BACKSTAGE_CURL_CONFIG could not mint a session"
    fi
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


# verify_backstage_auth <expected version or empty> <release yes|none> - both authenticated routes,
# /backstage/ and /api/backstage/health: 200 with a running release, 502 only while none exists
# (docs/backstage-deploy.md:53). While a release exists, a 502 on EITHER route is retried (the service
# may be starting) and BOTH routes are re-read on every attempt: VERIFY_ATTEMPTS x VERIFY_SLEEP s.
verify_backstage_auth() {
    local want="$1" release="$2" attempt=1 attempts="${VERIFY_ATTEMPTS:-5}" version page_code page_rc
    while :; do
        verify_get auth /backstage/
        page_code="$VERIFY_CODE"; page_rc="$VERIFY_RC"
        verify_get auth /api/backstage/health
        if [[ "$release" == yes && "$attempt" -lt "$attempts" ]] \
            && { [[ "$page_rc" -eq 0 && "$page_code" == "$VERIFY_NO_RELEASE_CODE" ]] \
                 || [[ "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == "$VERIFY_NO_RELEASE_CODE" ]]; }; then
            attempt=$((attempt + 1))
            sleep "${VERIFY_SLEEP:-2}"
            continue
        fi
        break
    done

    if [[ "$page_rc" -eq 0 && "$page_code" == "$VERIFY_OK_CODE" ]]; then
        verify_pass "S2 auth /backstage/ ${VERIFY_OK_CODE}"
    elif [[ "$release" != yes && "$page_rc" -eq 0 && "$page_code" == "$VERIFY_NO_RELEASE_CODE" ]]; then
        verify_pass "S2 auth /backstage/ ${VERIFY_NO_RELEASE_CODE} (no release yet)"
    elif [[ "$page_rc" -eq 0 ]]; then
        verify_fail "S2 auth /backstage/: expected ${VERIFY_OK_CODE}, got ${page_code} after ${attempt} attempt(s)"
    else
        verify_fail "S2 auth /backstage/: expected ${VERIFY_OK_CODE}, got ${page_code}, curl exit ${page_rc} after ${attempt} attempt(s)"
    fi

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

# verify_live <expected static SHA|""> <expected backstage SHA|""> <require tag yes|no>
#             [backstage release yes|none] [scope all|static|backstage] [static release yes|none] [gate yes|session]
# An empty expected SHA means that module's SHA is not asserted by this caller. Scope `all` (deploy,
# rollback, --status, --verify) asserts the S2 gate and the public paths; `static` (static setup)
# asserts only the public paths, and `backstage` (Backstage setup) only the gate. The public paths
# answer 200, or 404 while static has no release (.deploy/provision.sh:140). Prints one PASS/FAIL
# line per assertion and a summary; returns 1 when any assertion failed.
verify_live() {
    local want_static="$1" want_backstage="$2" want_tag="$3" release="${4:-yes}" scope="${5:-all}"
    local static_release="${6:-yes}" gate="${7:-yes}" path tag_sha public_code public_note=""
    VERIFY_PASSED=0; VERIFY_FAILED=0
    VERIFY_MINTED=no
    BACKSTAGE_GATE="$gate"; export BACKSTAGE_GATE
    echo "verify (read-only, live, scope ${scope}): static ${want_static:-not asserted}, backstage ${want_backstage:-not asserted}, release tag $([[ "$want_tag" == yes ]] && echo required || echo 'not required')"

    [[ -z "$want_static" ]] || verify_static_sha "$want_static"

    if [[ "$scope" == all || "$scope" == backstage ]]; then
        if [[ "$gate" == session ]]; then
            verify_session_redirect anon anon
            verify_session_api_401 anon anon
            verify_session_sign_in "$release"
            verify_session_redirect tampered tampered
            verify_session_api_401 tampered tampered
        elif [[ "$gate" == yes ]]; then
            for path in "${VERIFY_GATED_PATHS[@]}"; do
                verify_code anon "$path" "$VERIFY_UNAUTH_CODE" "S2 anon ${path}"
            done
        else
            verify_fail "S2 gate: expected yes or session, got ${gate}"
        fi
        if [[ -z "${BACKSTAGE_CURL_CONFIG:-}" ]] || ! backstage_check_curl_config; then
            verify_fail "S2 auth: BACKSTAGE_CURL_CONFIG must name a private (0600, yours) curl config holding the Backstage login (docs/backstage-deploy.md § Sign-in gate)"
            [[ -z "$want_backstage" ]] || verify_fail "S1 backstage version: not read without BACKSTAGE_CURL_CONFIG"
        else
            if [[ "$gate" == session ]]; then
                verify_session_auth "$want_backstage" "$release"
                if [[ "$VERIFY_MINTED" == yes ]]; then
                    verify_session_redirect forged forged
                    verify_session_api_401 forged forged
                fi
            elif [[ "$gate" == yes ]]; then
                verify_backstage_auth "$want_backstage" "$release"
            fi
        fi
    else
        verify_note "S2 gate: Backstage is not the module being set up"
    fi

    if [[ "$scope" == all || "$scope" == static ]]; then
        public_code="$VERIFY_OK_CODE"
        if [[ "$static_release" != yes ]]; then public_code=404; public_note=" (no static release yet)"; fi
        for path in "${VERIFY_PUBLIC_PATHS[@]}"; do
            verify_get anon "$path"
            if [[ "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == "$public_code" ]]; then
                verify_pass "S2 public ${path} ${public_code}${public_note}"
            else
                verify_fail "S2 public ${path}: expected ${public_code}${public_note}, $(verify_got)"
            fi
        done
    else
        verify_note "S2 public paths: static is not the module being set up"
    fi

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

# verify_live_tag <sha> - S1's release-tag assertion alone, run after the release is recorded
# (the deploy verifies S1/S2 first and publishes only when they pass).
verify_live_tag() {
    VERIFY_PASSED=0; VERIFY_FAILED=0
    echo "verify release tag (read-only): ${1}"
    verify_release_tag "$1"
    echo "verify: ${VERIFY_PASSED} passed, ${VERIFY_FAILED} failed"
    [[ "$VERIFY_FAILED" -eq 0 ]]
}
