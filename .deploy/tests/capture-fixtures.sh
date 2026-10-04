#!/usr/bin/env bash
#
# capture-fixtures.sh - OPERATOR-RUN, read-only capture of the real host's answers into test fixtures
# (#86). The deploy tests replay these files through fixture-curl.sh instead of hand-written stubs.
#
# Usage: .deploy/tests/capture-fixtures.sh --scan <path to the private public-scan.sh> [--out DIR]
#   --scan  REQUIRED. The private-content scanner (its term list is not in this repo). The capture is
#           published only when it exits 0 with an OK verdict counting every file; any hit fails it.
#   --out   default .deploy/tests/fixtures/<UTC date>/live; refused when it exists, even empty.
#   Needs BACKSTAGE_CURL_CONFIG (the private 0600 curl config) for the authenticated Backstage routes.
#
# ALLOWLIST: no raw `nginx -T`, snippet text or response body is ever written. The capture writes
# only these facts, each parsed and validated (scripts/capture-extract.ts); input that does not
# parse fails the capture instead of being copied:
#   nginx.json      server_name values and listen ports per server block, the `user` directive, and
#                   for our Backstage snippet only its auth state (backstage_snippet_auth) and sha256
#   neighbours.txt  the co-tenant server_names (hostnames only)
#   http/*.txt      fixture-curl.sh format: http code and curl exit per request. The only bodies are
#                   /DEPLOYED_SHA (a 40-hex SHA) and the authenticated health route, reduced to
#                   version, protocol, catalogVersion and trial.available
# Reads go through the existing wrappers (config.sh `remote`, CURL_PIN, backstage_curl). Nothing on
# the host is written, restarted or reloaded.
#
# Everything is staged in a private directory (mode 0700, under TMPDIR) and copied to --out only
# after the scan passes. The destination is claimed with an atomic `mkdir`; an interruption or any
# failed step removes this run's staging and its own claimed destination, nothing else.
# Bash 3.2 compatible.
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"
EXTRACT="${REPO_ROOT}/scripts/capture-extract.ts"
SCAN=""
OUT=""

usage() { sed -n '4,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
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
HOSTNAME_RE='^[A-Za-z0-9_][A-Za-z0-9_.-]*$'
SHA_RE='^[0-9a-f]{40}$'

# write_http <key> <url> <code> <curl exit> [body] - one fixture-curl.sh file. The body, if any, is
# an already validated allowlisted value.
write_http() {
    [[ "$3" =~ ^[0-9]{3}$ && "$4" =~ ^[0-9]+$ ]] || abort "A request to ${2} returned no 3-digit status; nothing captured"
    {
        printf '%s\nurl: %s\nhttp_code: %s\ncurl_exit: %s\n---\n' "$SOURCE" "$2" "$3" "$4"
        if [[ -n "${5:-}" ]]; then printf '%s\n' "$5"; fi
    } > "${STAGE}/http/${1}.txt" || abort "Writing http/${1}.txt failed"
}

# key_for <url> - the fixture-curl.sh key (scheme dropped, '/' -> '_').
key_for() { local k="${1#https://}"; printf '%s' "${k//\//_}"; }

log_info "Capturing from ${SERVER} into ${OUT} (read-only, allowlisted facts only, staged until scanned)"
remote 'echo ok' >/dev/null 2>&1 || abort "Cannot SSH to ${SERVER}. Check user, key and IP, then stop."

# nginx: parsed facts only. The raw text lives in shell variables, never in a file.
nginx_text="$(remote 'nginx -T 2>/dev/null')" || abort "Remote read failed: nginx -T"
snippet="$(remote "cat /etc/nginx/snippets/jevnotjev-backstage.conf")" || abort "Remote read failed: the Backstage snippet"
snippet_auth="$(printf '%s\n' "$snippet" | backstage_snippet_auth)" || abort "Reading the snippet's auth state failed"
snippet_sha="$(printf '%s\n' "$snippet" | shasum -a 256 | awk '{print $1}')" || abort "Hashing the snippet failed"
unset snippet
printf '%s\n' "$nginx_text" | bun "$EXTRACT" nginx "$snippet_auth" "$snippet_sha" > "${STAGE}/nginx.json" \
    || abort "nginx -T did not parse into the allowlisted facts; nothing captured"
unset nginx_text

neighbours="$(list_neighbours "$DOMAIN")" || abort "Reading the co-tenant server_names failed"
[[ -n "$neighbours" ]] || abort "No co-tenant server_names read from /etc/nginx/sites-enabled"
while IFS= read -r name; do
    [[ "$name" =~ $HOSTNAME_RE ]] || abort "A co-tenant server_name is not a plain hostname; nothing captured"
done <<< "$neighbours"
printf '%s\n' "$neighbours" > "${STAGE}/neighbours.txt" || abort "Writing neighbours.txt failed"

# Co-tenants: status and curl exit only, never with credentials.
while IFS= read -r name; do
    rc=0
    code="$(curl -q -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "${name}:443:${SERVER_HOST}" "https://${name}/" 2>/dev/null)" || rc=$?
    write_http "$(key_for "https://${name}/")" "https://${name}/" "${code:-000}" "$rc"
done <<< "$neighbours"

# This domain without credentials: status only, except the DEPLOYED_SHA value.
for path in / /label/ /little-shop/ /backstage/; do
    rc=0
    code="$(curl -q -sS -o /dev/null -w '%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}${path}" 2>/dev/null)" || rc=$?
    write_http "$(key_for "${HEALTH_URL}${path}")" "${HEALTH_URL}${path}" "${code:-000}" "$rc"
done
rc=0
sha_out="$(curl -q -sS -w '\n%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}/DEPLOYED_SHA" 2>/dev/null)" || rc=$?
code="$(printf '%s\n' "$sha_out" | tail -1)"; served="$(printf '%s\n' "$sha_out" | sed '$d' | tr -d '[:space:]')"
unset sha_out
if [[ "$code" == 200 && "$rc" -eq 0 ]]; then
    [[ "$served" =~ $SHA_RE ]] || abort "/DEPLOYED_SHA answered 200 without a 40-hex SHA; nothing captured"
    write_http "$(key_for "${HEALTH_URL}/DEPLOYED_SHA")" "${HEALTH_URL}/DEPLOYED_SHA" "$code" "$rc" "$served"
else
    write_http "$(key_for "${HEALTH_URL}/DEPLOYED_SHA")" "${HEALTH_URL}/DEPLOYED_SHA" "${code:-000}" "$rc"
fi

# capture_health <anon|auth> - the health route's status; a 200 body is reduced to its four fields.
capture_health() {
    local out code health="" rc=0 key label=""
    key="$(key_for "${HEALTH_URL}/api/backstage/health")"
    if [[ "$1" == auth ]]; then
        key="${key}@auth"; label=" (with BACKSTAGE_CURL_CONFIG)"
        out="$(backstage_curl -sS -w '\n%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}/api/backstage/health" 2>/dev/null)" || rc=$?
    else
        out="$(curl -q -sS -w '\n%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}/api/backstage/health" 2>/dev/null)" || rc=$?
    fi
    code="$(printf '%s\n' "$out" | tail -1)"
    if [[ "$code" == 200 && "$rc" -eq 0 ]]; then
        health="$(printf '%s\n' "$out" | sed '$d' | bun "$EXTRACT" health)" \
            || abort "The health body did not parse into the allowlisted fields; nothing captured"
    fi
    write_http "$key" "${HEALTH_URL}/api/backstage/health${label}" "${code:-000}" "$rc" "$health"
}
capture_health anon

# This domain with credentials: the page's status; the health route reduced to its four fields.
rc=0
code="$(backstage_curl -sS -o /dev/null -w '%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}/backstage/" 2>/dev/null)" || rc=$?
write_http "$(key_for "${HEALTH_URL}/backstage/")@auth" "${HEALTH_URL}/backstage/ (with BACKSTAGE_CURL_CONFIG)" "${code:-000}" "$rc"
capture_health auth

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
    echo "- allowlist only: parsed nginx facts, co-tenant names and statuses, route statuses, the served SHA, four health fields"
    echo
    echo "| File | What |"
    echo "|---|---|"
    for f in "${files[@]}"; do
        case "$f" in
            http/*) what="GET $(sed -n 's/^url: //p' "${STAGE}/${f}" | head -1)" ;;
            nginx.json) what="parsed from nginx -T and the Backstage snippet" ;;
            *) what="co-tenant server_names" ;;
        esac
        echo "| \`${f}\` | ${what} |"
    done
} > "${STAGE}/MANIFEST.md" || abort "Writing MANIFEST.md failed"
files+=(MANIFEST.md)

# The operator's private scan must exit 0 with an OK verdict counting every file. A hit fails the
# capture: there is nothing raw to redact, so a hit means an allowlisted value is itself private.
# The scanner's own output (it echoes the matched text) is never printed.
scan_rc=0
scan_out="$(bash "$SCAN" "$STAGE" "${files[@]}" 2>/dev/null)" || scan_rc=$?
verdict="$(printf '%s\n' "$scan_out" | tail -1)"
unset scan_out
if [[ ! "$verdict" =~ ^VERDICT\ public-scan\ (OK|HITS)\ files=([0-9]+)\ hits=([0-9]+)$ ]]; then
    abort "Public scan printed no valid verdict (exit ${scan_rc}); capture removed"
fi
[[ "${BASH_REMATCH[2]}" -eq "${#files[@]}" ]] || abort "Public scan covered ${BASH_REMATCH[2]} of ${#files[@]} files; capture removed"
[[ "$scan_rc" -eq 0 && "${BASH_REMATCH[1]}" == OK ]] || abort "Public scan ${BASH_REMATCH[1]} with exit ${scan_rc}; capture removed"

cp -R "${STAGE}/." "${OUT}/" || abort "Publishing the capture to ${OUT} failed"
PUBLISHED=true
log_success "Captured ${#files[@]} allowlisted files into ${OUT}. ${verdict}"
