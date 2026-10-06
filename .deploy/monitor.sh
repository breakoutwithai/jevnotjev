#!/usr/bin/env bash
# External, read-only site monitor. Never loads config.sh (its host pin belongs to deploys).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/backstage-lib.sh"
source "$HERE/verify-lib.sh"
source "$HERE/monitor-lib.sh"

MONITOR_DRY_RUN=no
case "${1:-}" in --dry-run) MONITOR_DRY_RUN=yes;; '') ;; *) echo 'usage: monitor.sh [--dry-run]' >&2; exit 2;; esac
[[ "$#" -le 1 ]] || { echo 'usage: monitor.sh [--dry-run]' >&2; exit 2; }
DOMAIN=jevnotjev.breakoutwithai.com
HEALTH_URL="${MONITOR_URL:-https://${DOMAIN}}"
if [[ ! "$HEALTH_URL" =~ ^https://([A-Za-z0-9.-]+)(:([0-9]+))?$ ]]; then echo 'CONFIG: MONITOR_URL must be an HTTPS origin' >&2; exit 2; fi
TLS_HOST="${BASH_REMATCH[1]}"; TLS_PORT="${BASH_REMATCH[3]:-443}"; TLS_CONNECT="${TLS_HOST}:${TLS_PORT}"
CURL_PIN=""
if [[ -n "${MONITOR_RESOLVE:-}" ]]; then
    if [[ "$MONITOR_RESOLVE" != "${TLS_HOST}:${TLS_PORT}:"* ]]; then echo 'CONFIG: MONITOR_RESOLVE must match the monitored host and port' >&2; exit 2; fi
    resolve_addr="${MONITOR_RESOLVE#${TLS_HOST}:${TLS_PORT}:}"
    if [[ ! "$resolve_addr" =~ ^[A-Za-z0-9.:-]+$ ]]; then echo 'CONFIG: MONITOR_RESOLVE must contain one address' >&2; exit 2; fi
    CURL_PIN="--resolve ${MONITOR_RESOLVE}"
    TLS_CONNECT="${resolve_addr}:${TLS_PORT}"
fi
export DOMAIN HEALTH_URL CURL_PIN
[[ "${MONITOR_CMD_TIMEOUT:-20}" =~ ^[1-9][0-9]*$ ]] || { echo 'CONFIG: MONITOR_CMD_TIMEOUT must be positive seconds' >&2; exit 2; }
monitor_config || { echo 'FAIL M6 alert configuration refused' >&2; exit 2; }
monitor_state_init external; init_rc=$?
[[ "$init_rc" -eq 0 ]] || { [[ "$init_rc" -eq 3 ]] && exit 0; exit 2; }
rows="$MONITOR_DIR/checks.$$"; refs_file="$MONITOR_DIR/refs.$$"; tls_file="$MONITOR_DIR/tls.$$"; cert_file="$MONITOR_DIR/cert.$$"
(umask 077; : > "$rows"; : > "$refs_file"; : > "$tls_file"; : > "$cert_file") || exit 2
monitor_external_cleanup() { [[ "${BASH_SUBSHELL:-0}" -eq 0 ]] || return 0; rm -f "$rows" "$refs_file" "$tls_file" "$cert_file"; backstage_session_cleanup; monitor_unlock; }
trap monitor_external_cleanup EXIT

failed=0
{
    if [[ -z "${BACKSTAGE_CURL_CONFIG:-}" ]] || ! monitor_private_file "$BACKSTAGE_CURL_CONFIG"; then
        echo 'FAIL M6 BACKSTAGE_CURL_CONFIG must be a private regular file owned by the runner'
        backstage_ok=no; failed=1
    else
        echo 'PASS M6 private curl configs'; backstage_ok=yes
    fi
    refs=''
    if GIT_TERMINAL_PROMPT=0 monitor_deadline "$refs_file" git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 ls-remote --tags -- "${MONITOR_REPO:-https://github.com/breakoutwithai/jevnotjev.git}"; then
        refs="$(cat "$refs_file")"
    fi
    tag_sha="$(printf '%s\n' "$refs" | awk '$2 ~ /^refs\/tags\/v[0-9][0-9][0-9][0-9]\.[0-9][0-9]\.[0-9][0-9]\.[0-9]+\^\{\}$/ {tag=$2;sub(/^refs\/tags\/v/,"",tag);sub(/\^\{\}$/, "",tag);split(tag,n,".");printf "%04d %02d %02d %010d %s\n",n[1],n[2],n[3],n[4],$1}' | sort | tail -1 | awk '{print $5}')"
    if [[ ! "$tag_sha" =~ ^[a-f0-9]{40}$ ]]; then echo 'FAIL M4 newest annotated release tag unavailable'; failed=1; else echo "PASS M4 newest release tag ${tag_sha}"; fi

    VERIFY_PASSED=0; VERIFY_FAILED=0; VERIFY_MINTED=no
    BACKSTAGE_GATE=session; export BACKSTAGE_GATE
    verify_session_redirect anon anon
    verify_session_api_401 anon anon
    verify_session_sign_in yes
    verify_session_redirect tampered tampered
    verify_session_api_401 tampered tampered
    if [[ "$backstage_ok" == yes ]]; then verify_session_auth "$tag_sha" yes; else echo '  n/a  S2 auth: invalid BACKSTAGE_CURL_CONFIG'; fi
    for path in "${VERIFY_PUBLIC_PATHS[@]}"; do
        verify_get anon "$path"
        if [[ "$VERIFY_RC" -eq 0 && "$VERIFY_CODE" == "$VERIFY_OK_CODE" ]]; then verify_pass "S2 public ${path} ${VERIFY_OK_CODE}"; else verify_fail "S2 public ${path}: expected ${VERIFY_OK_CODE}, $(verify_got)"; fi
    done
    [[ "$VERIFY_FAILED" -eq 0 ]] || failed=1
    echo "verify: ${VERIFY_PASSED} passed, ${VERIFY_FAILED} failed"

    monitor_deadline "$tls_file" openssl s_client -connect "$TLS_CONNECT" -servername "$TLS_HOST" </dev/null || true
    sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' "$tls_file" | sed -n '1,/-----END CERTIFICATE-----/p' > "$cert_file"
    if [[ ! -s "$cert_file" ]] || ! grep -q -- '-----END CERTIFICATE-----' "$cert_file"; then
        echo 'FAIL M5 TLS handshake or certificate read'; failed=1
    else
        expiry="$(openssl x509 -noout -enddate < "$cert_file" 2>/dev/null)"
        if [[ -n "$expiry" ]] && openssl x509 -noout -checkend 1209600 < "$cert_file" >/dev/null 2>&1; then
            echo "PASS M5 TLS certificate ${expiry}"
        else
            echo "FAIL M5 TLS certificate expires within 14 days (${expiry:-unknown expiry})"; failed=1
        fi
    fi
} > "$rows"

if grep -q 'FAIL S2 public' "$rows"; then echo 'FAIL M1 public routes' >> "$rows"; failed=1; else echo 'PASS M1 public routes' >> "$rows"; fi
if grep -Eq 'FAIL S2 anon /backstage/|FAIL S2 anon /backstage/sign-in' "$rows"; then echo 'FAIL M2 sign-in gate' >> "$rows"; failed=1; else echo 'PASS M2 sign-in gate' >> "$rows"; fi
if grep -q 'FAIL S2 anon /api/backstage/health' "$rows"; then echo 'FAIL M3 anonymous health gate' >> "$rows"; failed=1; else echo 'PASS M3 anonymous health gate' >> "$rows"; fi
if grep -Eq 'FAIL S1 backstage version|FAIL S2 auth' "$rows"; then echo 'FAIL M4 authenticated health and version' >> "$rows"; failed=1; elif [[ "$backstage_ok" == yes && "$tag_sha" =~ ^[a-f0-9]{40}$ ]]; then echo 'PASS M4 authenticated health and version' >> "$rows"; fi
if grep -q 'FAIL S2 tampered' "$rows"; then echo 'FAIL M7 forged session rejected' >> "$rows"; failed=1; else echo 'PASS M7 forged session rejected' >> "$rows"; fi
cat "$rows"
if [[ "$failed" -eq 0 ]]; then monitor_transition yes 'jevnotjev external checks recovered' || exit 1; exit 0; fi
details="$(monitor_fail_rows "$rows")"
monitor_transition no "jevnotjev external checks failed
${details}" || exit 1
exit 1
