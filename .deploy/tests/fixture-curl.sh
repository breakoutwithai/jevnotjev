#!/usr/bin/env bash
#
# Fixture-backed curl double (#86). Installed first on PATH as `curl` by the deploy tests. It never
# touches the network: every answer comes from a fixture file written by capture-fixtures.sh (or a
# hand-built/transcribed file in the same format, marked as such in its `source:` line).
#
# Lookup: each directory in $FIXTURE_DIRS (colon-separated, first match wins) is searched for
# http/<key>.<n>.txt (the n-th call to that key; past the last numbered file the last one repeats),
# then http/<key>.txt. key = the URL without its scheme, every '/' replaced by '_', plus '@auth' when
# the request carries --config (the private Backstage curl config).
#
# Fixture file: header lines (`source:`, `url:`, `http_code:`, `curl_exit:`), a line `---`, the body.
# Body tokens {{STATIC_SHA}} / {{BACKSTAGE_SHA}} are replaced by $FAKE_STATE/<module>_served; a token
# whose module serves `none` answers 404, as nginx does with no release behind it.
#
# Honoured flags: -o FILE, -w '%{http_code}', -f/--fail (an HTTP status >= 400 exits 22, no body),
# --config, --resolve, -s/-S/-q, --max-time (ignored). FAKE_CURL_EXIT forces that exit after the body.
# A request with no fixture exits 7 (connection refused) and logs "NO FIXTURE <key>".
# Bash 3.2 compatible.
set -u

printf 'curl %s\n' "$*" >> "${FAKE_STATE}/curl.log"

url="" out="" wfmt="" auth=false failflag=false prev=""
for a in "$@"; do
    case "$prev" in
        -o) out="$a"; prev=""; continue ;;
        -w) wfmt="$a"; prev=""; continue ;;
        --config|--resolve|--max-time) prev=""; continue ;;
    esac
    case "$a" in
        -o|-w) prev="$a" ;;
        --config) auth=true; prev="$a" ;;
        --resolve|--max-time) prev="$a" ;;
        --fail) failflag=true ;;
        https://*|http://*) url="$a" ;;
        --*) ;;
        -*) [[ "$a" != *f* ]] || failflag=true ;;
    esac
done

key="${url#*://}"
key="${key//\//_}"
$auth && key="${key}@auth"

mkdir -p "${FAKE_STATE}/fixture-calls"
counter="${FAKE_STATE}/fixture-calls/${key}"
n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$counter"

file=""
IFS=':' read -r -a dirs <<< "${FIXTURE_DIRS:-}"
for d in ${dirs[@]+"${dirs[@]}"}; do
    [[ -n "$d" ]] || continue
    if [[ -f "${d}/http/${key}.${n}.txt" ]]; then file="${d}/http/${key}.${n}.txt"; break; fi
    last=""
    i=1
    while [[ -f "${d}/http/${key}.${i}.txt" ]]; do last="${d}/http/${key}.${i}.txt"; i=$((i + 1)); done
    if [[ -n "$last" ]]; then file="$last"; break; fi
    if [[ -f "${d}/http/${key}.txt" ]]; then file="${d}/http/${key}.txt"; break; fi
done

if [[ -z "$file" ]]; then
    printf 'NO FIXTURE %s\n' "$key" >> "${FAKE_STATE}/curl.log"
    echo "curl: (7) Failed to connect (no fixture for ${key})" >&2
    [[ "$wfmt" != *http_code* ]] || printf '000'
    exit 7
fi

header() { sed -n "1,/^---\$/s/^$1: //p" "$file" | head -1; }
code="$(header http_code)"
rc="$(header curl_exit)"
body="$(sed '1,/^---$/d' "$file")"

served() { local s; s="$(cat "${FAKE_STATE}/$1_served" 2>/dev/null || echo none)"; printf '%s' "$(printf '%s' "$s" | tr -d '[:space:]')"; }
for pair in STATIC_SHA:static BACKSTAGE_SHA:backstage; do
    token="{{${pair%%:*}}}"
    [[ "$body" == *"$token"* ]] || continue
    s="$(served "${pair#*:}")"
    if [[ "$s" == none ]]; then code=404; body='<html><head><title>404 Not Found</title></head></html>'; break; fi
    body="${body//$token/$s}"
done

if $failflag && [[ "$rc" == 0 && "$code" =~ ^[0-9]+$ && "$code" -ge 400 ]]; then
    echo "curl: (22) The requested URL returned error: ${code}" >&2
    [[ "$wfmt" != *http_code* ]] || printf '%s' "$code"
    exit 22
fi

if [[ -n "$body" ]]; then
    if [[ -n "$out" ]]; then
        [[ "$out" == /dev/null ]] || printf '%s\n' "$body" > "$out"
    else
        printf '%s\n' "$body"
    fi
fi
[[ "$wfmt" != *http_code* ]] || printf '%s' "${wfmt//%\{http_code\}/$code}"
exit "${FAKE_CURL_EXIT:-$rc}"
