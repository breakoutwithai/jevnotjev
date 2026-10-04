#!/usr/bin/env bash
#
# capture-fixtures.sh - OPERATOR-RUN, read-only capture of the real host's answers into test fixtures
# (#86). The deploy tests replay these files through fixture-curl.sh instead of hand-written stubs.
#
# Usage: .deploy/tests/capture-fixtures.sh --scan <path to the private public-scan.sh> [--out DIR]
#   --scan  REQUIRED. The private-content scanner (its term list is not in this repo). Every line it
#           flags in the capture is replaced by "[REDACTED: public-scan term]"; the capture is kept only
#           when a second scan is clean, otherwise the output directory is removed.
#   --out   default .deploy/tests/fixtures/<UTC date>/live; refused when it exists and is not empty.
#   Needs BACKSTAGE_CURL_CONFIG (the private 0600 curl config) for the authenticated Backstage routes.
#
# What it reads, all through the existing wrappers (config.sh `remote` over the configured SSH key,
# curl pinned with CURL_PIN, backstage_curl for the gated routes):
#   remote: `nginx -T` (effective config), `ls -la /etc/nginx/sites-enabled/`, the Backstage snippet,
#           and the sites-enabled server_names (list_neighbours)
#   HTTP:   every co-tenant's https://<name>/ (status and curl exit, no body, never with credentials),
#           and on this domain /, /label/, /little-shop/, /DEPLOYED_SHA, /backstage/,
#           /api/backstage/health without credentials, then /backstage/ and /api/backstage/health with.
# Nothing on the host is written, restarted or reloaded. Credentials are redacted at capture: any
# line naming a password, secret, token, API key, Authorization header, curl `user =` or a password
# hash is replaced by "[REDACTED: credential]". Bash 3.2 compatible.
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"
SCAN=""
OUT=""

usage() { sed -n '4,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
    case "$1" in
        --scan) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; SCAN="$2"; shift 2 ;;
        --out) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; OUT="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "capture-fixtures.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done
[[ -n "$SCAN" ]] || { echo "capture-fixtures.sh: --scan <public-scan.sh> is required (no capture is kept unscanned)" >&2; exit 2; }
[[ -f "$SCAN" ]] || { echo "capture-fixtures.sh: scan script not found: ${SCAN}" >&2; exit 2; }

# shellcheck source=/dev/null
source "${DEPLOY_DIR}/config.sh"
# shellcheck source=/dev/null
source "${DEPLOY_DIR}/lib.sh"
# shellcheck source=/dev/null
source "${DEPLOY_DIR}/backstage-lib.sh"

[[ -n "${BACKSTAGE_CURL_CONFIG:-}" ]] && backstage_check_curl_config \
    || fail "BACKSTAGE_CURL_CONFIG must name your private 0600 curl config (docs/backstage-deploy.md § Basic Auth gate)."
[[ -f "$SSH_KEY" ]] || fail "SSH key not found: ${SSH_KEY}"

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ -n "$OUT" ]] || OUT="${REPO_ROOT}/.deploy/tests/fixtures/$(date -u +%Y-%m-%d)/live"
if [[ -d "$OUT" && -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
    fail "Output directory is not empty: ${OUT}. Choose another --out; existing fixtures are never overwritten."
fi
mkdir -p "${OUT}/http" || fail "Cannot create ${OUT}"
SOURCE="source: captured ${STAMP} from ${SERVER_HOST} by .deploy/tests/capture-fixtures.sh"
abort() { log_error "$1"; rm -rf "$OUT"; exit 1; }

redact_credentials() {
    sed -E 's/.*([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy])[[:space:]"]*[:=].*/[REDACTED: credential]/
            s/.*[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn].*/[REDACTED: credential]/
            s/^[[:space:]]*user[[:space:]]*=.*/[REDACTED: credential]/
            s/.*\$(apr1|2[aby]|1|5|6)\$.*/[REDACTED: credential]/'
}

# capture_remote <file> <command> - one read-only remote command, redacted, into <file>.
capture_remote() {
    local text
    text="$(remote "$2" 2>&1)" || abort "Remote read failed: $2"
    printf '%s\n' "$text" | redact_credentials > "${OUT}/$1"
}

# capture_http <anon|auth|probe> <url> - one GET into http/<key>.txt in fixture-curl.sh format.
capture_http() {
    local who="$1" url="$2" host key code rc=0 body tmp
    host="${url#https://}"; host="${host%%/*}"
    key="${url#https://}"; key="${key//\//_}"
    tmp="$(mktemp)" || abort "mktemp failed"
    case "$who" in
        probe) code="$(curl -q -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "${host}:443:${SERVER_HOST}" "$url" 2>/dev/null)" || rc=$? ;;
        anon) code="$(curl -q -sS -o "$tmp" -w '%{http_code}' --max-time 15 ${CURL_PIN} "$url" 2>/dev/null)" || rc=$? ;;
        auth) key="${key}@auth"
              code="$(backstage_curl -sS -o "$tmp" -w '%{http_code}' --max-time 15 ${CURL_PIN} "$url" 2>/dev/null)" || rc=$? ;;
    esac
    body="$(head -200 "$tmp" | redact_credentials)"
    rm -f "$tmp"
    {
        printf '%s\nurl: %s%s\nhttp_code: %s\ncurl_exit: %s\n---\n' "$SOURCE" "$url" \
            "$([[ "$who" == auth ]] && echo ' (with BACKSTAGE_CURL_CONFIG)')" "${code:-000}" "$rc"
        [[ -z "$body" ]] || printf '%s\n' "$body"
    } > "${OUT}/http/${key}.txt"
}

log_info "Capturing from ${SERVER} into ${OUT} (read-only)"
remote 'echo ok' >/dev/null 2>&1 || abort "Cannot SSH to ${SERVER}. Check user, key and IP, then stop."
capture_remote nginx-T.txt 'nginx -T 2>&1'
capture_remote sites-enabled.txt 'ls -la /etc/nginx/sites-enabled/'
capture_remote backstage-snippet.conf "cat /etc/nginx/snippets/jevnotjev-backstage.conf"

neighbours="$(list_neighbours "$DOMAIN")" || neighbours=""
[[ -n "$neighbours" ]] || abort "No co-tenant server_names read from /etc/nginx/sites-enabled"
printf '%s\n' "$neighbours" > "${OUT}/neighbours.txt"
while IFS= read -r name; do
    [[ -z "$name" ]] || capture_http probe "https://${name}/"
done <<< "$neighbours"
for path in / /label/ /little-shop/ /DEPLOYED_SHA /backstage/ /api/backstage/health; do
    capture_http anon "${HEALTH_URL}${path}"
done
for path in /backstage/ /api/backstage/health; do
    capture_http auth "${HEALTH_URL}${path}"
done

files=()
while IFS= read -r f; do files+=("${f#"${OUT}"/}"); done < <(find "$OUT" -type f | sort)
{
    echo "# Fixture capture ${STAMP}"
    echo
    echo "- source: captured ${STAMP} from ${SERVER_HOST} (${DOMAIN})"
    echo "- command: \`.deploy/tests/capture-fixtures.sh --scan <private public-scan.sh>\` with BACKSTAGE_CURL_CONFIG set"
    echo "- capture tree: $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "- redacted at capture: credential lines; lines flagged by the operator's public scan"
    echo
    echo "| File | What |"
    echo "|---|---|"
    for f in "${files[@]}"; do
        if [[ "$f" == http/* ]]; then what="GET $(sed -n 's/^url: //p' "${OUT}/${f}" | head -1)"; else what="remote read"; fi
        echo "| \`${f}\` | ${what} |"
    done
} > "${OUT}/MANIFEST.md"
files+=(MANIFEST.md)

# Private terms: the operator's scanner flags lines; each is replaced, then the capture must scan
# clean. The scanner's own output (it echoes the matched text) is never printed.
hits="$(bash "$SCAN" "$OUT" "${files[@]}" 2>/dev/null | grep -E '^[^:]+:[0-9]+:' || true)"
redacted=0
while IFS= read -r hit; do
    [[ -n "$hit" ]] || continue
    f="${hit%%:*}"; rest="${hit#*:}"; n="${rest%%:*}"
    [[ -f "${OUT}/${f}" && "$n" =~ ^[0-9]+$ ]] || abort "Unparseable scan hit; capture removed"
    sed -i.bak "${n}s/.*/[REDACTED: public-scan term]/" "${OUT}/${f}" && rm -f "${OUT}/${f}.bak"
    redacted=$((redacted + 1))
done <<< "$hits"
verdict="$(bash "$SCAN" "$OUT" "${files[@]}" 2>/dev/null | tail -1)"
[[ "$verdict" == "VERDICT public-scan OK"* ]] || abort "Public scan is not clean after redaction (${verdict%% files=*}); capture removed"
log_success "Captured ${#files[@]} files into ${OUT}; ${redacted} line(s) redacted by the public scan. ${verdict}"
