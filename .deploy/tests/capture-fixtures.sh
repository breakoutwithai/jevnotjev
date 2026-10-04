#!/usr/bin/env bash
#
# capture-fixtures.sh - OPERATOR-RUN, read-only capture of the real host's answers into test fixtures
# (#86). The deploy tests replay these files through fixture-curl.sh instead of hand-written stubs.
#
# Usage: .deploy/tests/capture-fixtures.sh --scan <path to the private public-scan.sh> [--out DIR]
#   --scan  REQUIRED. The private-content scanner (its term list is not in this repo). Every line it
#           flags is replaced by "[REDACTED: public-scan term]"; the capture is published only when a
#           second scan exits 0 with an OK verdict covering every file.
#   --out   default .deploy/tests/fixtures/<UTC date>/live; refused when it exists, even empty.
#   Needs BACKSTAGE_CURL_CONFIG (the private 0600 curl config) for the authenticated Backstage routes.
#
# What it reads, all through the existing wrappers (config.sh `remote` over the configured SSH key,
# curl pinned with CURL_PIN, backstage_curl for the gated routes):
#   remote: `nginx -T` (effective config), `ls -la /etc/nginx/sites-enabled/`, the Backstage snippet,
#           and the sites-enabled server_names (list_neighbours)
#   HTTP:   every co-tenant's https://<name>/ (status and curl exit, no body, never with credentials),
#           and on this domain /, /label/, /little-shop/, /DEPLOYED_SHA, /backstage/,
#           /api/backstage/health without credentials, then /backstage/ and /api/backstage/health with.
# Nothing on the host is written, restarted or reloaded.
#
# Everything is captured into a private staging directory (mode 0700, under TMPDIR) and copied to
# --out only after the scan passes. The destination is claimed with an atomic `mkdir`, so two
# captures can never share it; an interruption or any failed step removes this run's staging and
# its own claimed destination, nothing else. Credentials are redacted at capture: any line naming a
# password, secret, token, API key, cookie, bearer or Authorization value (nginx `set $api_key ...;`
# and header directives included), a curl `user =` line or a password hash is replaced by
# "[REDACTED: credential]"; `auth_basic` and `auth_basic_user_file` (a path) are kept.
# Bash 3.2 compatible.
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"
SCAN=""
OUT=""

usage() { sed -n '4,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
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
mkdir -p "$(dirname "$OUT")" || fail "Cannot create the parent of ${OUT}"
# Atomic claim: plain mkdir fails when the destination exists, so it is never shared or overwritten.
mkdir "$OUT" 2>/dev/null || fail "Output directory exists: ${OUT}. Choose another --out; existing fixtures are never overwritten."
PUBLISHED=false
STAGE=""
cleanup() {
    [[ -z "$STAGE" ]] || rm -rf "$STAGE"
    $PUBLISHED || rm -rf "$OUT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
abort() { log_error "$1"; exit 1; }
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/jevnotjev-capture.XXXXXX")" || abort "Cannot create a private staging directory"
chmod 700 "$STAGE" && mkdir "${STAGE}/http" || abort "Cannot prepare the staging directory"
SOURCE="source: captured ${STAMP} from ${SERVER_HOST} by .deploy/tests/capture-fixtures.sh"

redact_credentials() {
    awk '
    # redact-credentials: replace every line that carries a credential value
    function cred(s) {
        s = tolower(s)
        return (s ~ /(api[_-]?key|secret|token|passw|authoriz|credential|cookie|bearer)/ \
            || s ~ /^[[:space:]]*user[[:space:]]*=/ || s ~ /\$(apr1|2[aby]|1|5|6)\$/)
    }
    {
        # Kept verbatim only when the line is exactly ONE auth_basic / auth_basic_user_file
        # statement, optionally followed by a comment that itself names no credential. The
        # htpasswd path is not a secret; anything else on the line goes through the check.
        if (match($0, /^[[:space:]]*(auth_basic|auth_basic_user_file)[[:space:]]+[^;#]+;[[:space:]]*/)) {
            rest = substr($0, RLENGTH + 1)
            if (rest == "" || (substr(rest, 1, 1) == "#" && !cred(rest))) { print; next }
        }
        if (cred($0)) { print "[REDACTED: credential]"; next }
        print
    }'
}

# capture_remote <file> <command> - one read-only remote command, redacted, into <file>.
capture_remote() {
    local text
    text="$(remote "$2" 2>&1)" || abort "Remote read failed: $2"
    printf '%s\n' "$text" | redact_credentials > "${STAGE}/$1" || abort "Redacting or writing $1 failed"
}

# capture_http <anon|auth|probe> <url> - one GET into http/<key>.txt in fixture-curl.sh format.
capture_http() {
    local who="$1" url="$2" host key code rc=0 body tmp label=""
    host="${url#https://}"; host="${host%%/*}"
    key="${url#https://}"; key="${key//\//_}"
    tmp="$(mktemp "${STAGE}/.body.XXXXXX")" || abort "mktemp failed"
    case "$who" in
        probe) code="$(curl -q -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "${host}:443:${SERVER_HOST}" "$url" 2>/dev/null)" || rc=$? ;;
        anon) code="$(curl -q -sS -o "$tmp" -w '%{http_code}' --max-time 15 ${CURL_PIN} "$url" 2>/dev/null)" || rc=$? ;;
        auth) key="${key}@auth"; label=" (with BACKSTAGE_CURL_CONFIG)"
              code="$(backstage_curl -sS -o "$tmp" -w '%{http_code}' --max-time 15 ${CURL_PIN} "$url" 2>/dev/null)" || rc=$? ;;
    esac
    body="$(head -200 "$tmp" | redact_credentials)" || abort "Redacting the body of ${url} failed"
    rm -f "$tmp" || abort "Removing ${tmp} failed"
    {
        printf '%s\nurl: %s%s\nhttp_code: %s\ncurl_exit: %s\n---\n' "$SOURCE" "$url" "$label" "${code:-000}" "$rc"
        if [[ -n "$body" ]]; then printf '%s\n' "$body"; fi
    } > "${STAGE}/http/${key}.txt" || abort "Writing http/${key}.txt failed"
}

# run_scan <clean|any> - runs the scanner over every staged file and sets SCAN_OUT. The scanner must
# exit 0 with an OK verdict, or (any) exit 1 with a HITS verdict, and the verdict must count every file.
run_scan() {
    local rc=0 verdict state count
    SCAN_OUT="$(bash "$SCAN" "$STAGE" "${files[@]}" 2>/dev/null)" || rc=$?
    verdict="$(printf '%s\n' "$SCAN_OUT" | tail -1)"
    if [[ ! "$verdict" =~ ^VERDICT\ public-scan\ (OK|HITS)\ files=([0-9]+)\ hits=([0-9]+)$ ]]; then
        abort "Public scan printed no valid verdict (exit ${rc}); capture removed"
    fi
    state="${BASH_REMATCH[1]}"; count="${BASH_REMATCH[2]}"
    [[ "$count" -eq "${#files[@]}" ]] || abort "Public scan covered ${count} of ${#files[@]} files; capture removed"
    if [[ "$rc" -eq 0 && "$state" == OK ]]; then return 0; fi
    if [[ "$1" == any && "$rc" -eq 1 && "$state" == HITS ]]; then return 0; fi
    abort "Public scan ${state} with exit ${rc}; capture removed"
}

log_info "Capturing from ${SERVER} into ${OUT} (read-only, staged privately until scanned)"
remote 'echo ok' >/dev/null 2>&1 || abort "Cannot SSH to ${SERVER}. Check user, key and IP, then stop."
capture_remote nginx-T.txt 'nginx -T 2>&1'
capture_remote sites-enabled.txt 'ls -la /etc/nginx/sites-enabled/'
capture_remote backstage-snippet.conf "cat /etc/nginx/snippets/jevnotjev-backstage.conf"

neighbours="$(list_neighbours "$DOMAIN")" || abort "Reading the co-tenant server_names failed"
[[ -n "$neighbours" ]] || abort "No co-tenant server_names read from /etc/nginx/sites-enabled"
printf '%s\n' "$neighbours" > "${STAGE}/neighbours.txt" || abort "Writing neighbours.txt failed"
while IFS= read -r name; do
    [[ -z "$name" ]] || capture_http probe "https://${name}/"
done <<< "$neighbours"
for path in / /label/ /little-shop/ /DEPLOYED_SHA /backstage/ /api/backstage/health; do
    capture_http anon "${HEALTH_URL}${path}"
done
for path in /backstage/ /api/backstage/health; do
    capture_http auth "${HEALTH_URL}${path}"
done

listing="$(cd "$STAGE" && find . -type f | sed 's#^\./##' | sort)" || abort "Listing the staged files failed"
files=()
while IFS= read -r f; do [[ -z "$f" ]] || files+=("$f"); done <<< "$listing"
[[ "${#files[@]}" -gt 0 ]] || abort "Nothing was captured"
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
        if [[ "$f" == http/* ]]; then what="GET $(sed -n 's/^url: //p' "${STAGE}/${f}" | head -1)"; else what="remote read"; fi
        echo "| \`${f}\` | ${what} |"
    done
} > "${STAGE}/MANIFEST.md" || abort "Writing MANIFEST.md failed"
files+=(MANIFEST.md)

# Private terms: the operator's scanner flags lines; each is replaced, then the capture must scan
# clean. The scanner's own output (it echoes the matched text) is never printed.
run_scan any
redacted=0
while IFS= read -r hit; do
    [[ "$hit" =~ ^[^:]+:[0-9]+: ]] || continue
    f="${hit%%:*}"; rest="${hit#*:}"; n="${rest%%:*}"
    [[ -f "${STAGE}/${f}" ]] || abort "Unparseable scan hit; capture removed"
    sed -i.bak "${n}s/.*/[REDACTED: public-scan term]/" "${STAGE}/${f}" && rm -f "${STAGE}/${f}.bak" \
        || abort "Redacting a scan hit in ${f} failed; capture removed"
    redacted=$((redacted + 1))
done <<< "$SCAN_OUT"
run_scan clean
verdict="$(printf '%s\n' "$SCAN_OUT" | tail -1)"

cp -R "${STAGE}/." "${OUT}/" || abort "Publishing the capture to ${OUT} failed"
PUBLISHED=true
log_success "Captured ${#files[@]} files into ${OUT}; ${redacted} line(s) redacted by the public scan. ${verdict}"
