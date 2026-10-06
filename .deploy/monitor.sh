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
if [[ -z "${BACKSTAGE_CURL_CONFIG:-}" ]] || ! monitor_private_file "$BACKSTAGE_CURL_CONFIG"; then
    echo 'FAIL M6 BACKSTAGE_CURL_CONFIG must be a private regular file owned by the runner' >&2; exit 2
fi
monitor_config || { echo 'FAIL M6 alert configuration refused' >&2; exit 2; }
echo 'PASS M6 private curl configs'
monitor_state_init external; init_rc=$?
[[ "$init_rc" -eq 0 ]] || { [[ "$init_rc" -eq 3 ]] && exit 0; exit 2; }

failed=0
refs="$(git ls-remote --tags "${MONITOR_REPO:-https://github.com/breakoutwithai/jevnotjev.git}" 2>/dev/null)" || refs=""
tag_sha="$(printf '%s\n' "$refs" | awk '$2 ~ /^refs\/tags\/v[0-9][0-9][0-9][0-9]\.[0-9][0-9]\.[0-9][0-9]\.[0-9]+\^\{\}$/ {tag=$2;sub(/^refs\/tags\/v/,"",tag);sub(/\^\{\}$/, "",tag);split(tag,n,".");printf "%04d %02d %02d %010d %s\n",n[1],n[2],n[3],n[4],$1}' | sort | tail -1 | awk '{print $5}')"
if [[ ! "$tag_sha" =~ ^[a-f0-9]{40}$ ]]; then
    echo 'FAIL M4 newest annotated release tag unavailable'; failed=1
else
    echo "PASS M4 newest release tag ${tag_sha}"
fi
verify_out="$(verify_live "" "$tag_sha" no yes all yes session)" || failed=1
printf '%s\n' "$verify_out"
if [[ "$verify_out" == *'FAIL S2 public'* ]]; then echo 'FAIL M1 public routes'; else echo 'PASS M1 public routes'; fi
if [[ "$verify_out" == *'FAIL S2 anon /backstage/'* || "$verify_out" == *'FAIL S2 anon /backstage/sign-in'* ]]; then echo 'FAIL M2 sign-in gate'; else echo 'PASS M2 sign-in gate'; fi
if [[ "$verify_out" == *'FAIL S2 anon /api/backstage/health'* ]]; then echo 'FAIL M3 anonymous health gate'; else echo 'PASS M3 anonymous health gate'; fi
if [[ "$verify_out" == *'FAIL S1 backstage version'* || "$verify_out" == *'FAIL S2 auth'* ]]; then echo 'FAIL M4 authenticated health and version'; else [[ -z "$tag_sha" ]] || echo 'PASS M4 authenticated health and version'; fi

cert="$(openssl s_client -connect "$TLS_CONNECT" -servername "$TLS_HOST" </dev/null 2>/dev/null)"; tls_rc=$?
if [[ "$tls_rc" -ne 0 || "$cert" != *'-----BEGIN CERTIFICATE-----'* ]]; then
    echo 'FAIL M5 TLS handshake or certificate read'; failed=1
else
    expiry="$(printf '%s\n' "$cert" | openssl x509 -noout -enddate 2>/dev/null)"
    if printf '%s\n' "$cert" | openssl x509 -noout -checkend 1209600 >/dev/null 2>&1; then
        echo "PASS M5 TLS certificate ${expiry}"
    else
        echo "FAIL M5 TLS certificate expires within 14 days (${expiry:-unknown expiry})"; failed=1
    fi
fi
if [[ "$failed" -eq 0 ]]; then
    monitor_transition yes 'jevnotjev external checks recovered' || exit 1
    exit 0
fi
monitor_transition no 'jevnotjev external checks failed' || exit 1
exit 1
